---
id: 141
type: adr
status: accepted
date: 2026-11-19
tags: [mcp, bridge, query]
triggered_by_external_trap: false
related: [93, 104, 105, 130, 134, 140]
supersedes: []
superseded_by: null
amends: []
---

# ADR #141: The bridge carries one connection per call in flight, and the app gates AI reads per connection

A sidecar talked to the app over one loopback connection behind a mutex. The mutex was held from the request until its reply, on the belief, written next to it, that "MCP dispatches tools serially". That belief was wrong. rmcp 2.2 runs every request in a task of its own (`spawn_service_task`), so a model's parallel tool calls reach the sidecar at the same time and then queued behind that mutex. Three things followed:

- **Reads queued behind unrelated reads.** A slow read against database A held up a quick one against database B.
- **No stop could be sent while a read ran.** A future `cancel_query` would wait behind the very read it was meant to stop.
- **How many reads a database took was decided by accident.** One per sidecar. That is too few for one client (a cheap lookup waits for a five-minute scan), and it bounds nothing across clients: two MCP clients and the AI panel still loaded the same server at once.

**Decision:**

- **The sidecar transports.** `bridge::client::BridgeClient` keeps a list of idle connections, each already through its handshake. A call leases one, or dials a new one when none is idle, and gives it back only once its reply has been read in full (`Lease::release`). A lease dropped any other way closes its connection: a reply that never came, or a call the MCP client cancelled. That close is how the app learns to stop a read, as before (ADR #134). A semaphore bounds the calls in flight, and so the sockets held, to `MAX_CALLS_IN_FLIGHT` (8) per sidecar. The wire protocol does not change: each connection still carries one request at a time.
- **The app decides.** `commands::query::ReadGates` keeps one semaphore per profile, sized by the new `ConnectionProfile::mcp_concurrent_reads` (2 by default, 1..=16, through `state::mcp_concurrent_reads`).
  - `execute_read_bounded` waits for a slot inside the read's own deadline. A read that does not get one in time is never sent: it comes back `not_started` (ADR #140), saying how many slots the connection has. A read that waited reports `queued_ms`, which the sidecar adds to its own wait.
  - The gate is resolved in `bridge::exec`, with the timeout, from one fresh read of `profiles.json`, so a change in Settings → MCP applies to the next read.
- **The setting is local.** `mcp_concurrent_reads` is edited in Settings → MCP (`set_mcp_concurrent_reads`, classified `none` in `guard::HUMAN_POLICY`) and preserved across a shared-origin sync, like `mcp_timeout_secs`: how hard this machine's AI may load a server is this machine's decision.

**Alternatives rejected:**

- **Multiplex calls over one connection with request ids.** That would mean less churn of connections, but it breaks the one signal the app relies on to stop an abandoned read: EOF on that read's connection. With several calls on one socket, a dropped call has no socket of its own to close.
- **A second connection only for control (`cancel_query`, `running_queries`).** This is smaller, but it keeps reads serialised per sidecar: database A still blocks database B, and the limit still means nothing across clients. Alex chose the pool.
- **Gate reads in the sidecar.** The sidecar sees only its own client. The app is the one place every AI read passes through (ADR #94's choke point).
- **Gate per pool rather than per profile.** MongoDB's per-database views are separate pools against one server. The load they put on that server is the profile's, as is its connection budget.
- **A gate for writes too.** A write that was sent must run and be answered (ADR #130). Queueing it behind a slow read would only move its timeout.

## Consequences

- A model's parallel reads against different connections run side by side. Against one connection, two run and the rest wait, visibly.
- **A sidecar may hold up to eight loopback sockets** to the app instead of one. They are cheap, and idle ones are kept for reuse rather than re-dialled.
- **A limit that changes gets a new gate.** Reads holding a slot of the old one finish on it, so for that moment the connection may carry both limits at once.
- **SQLite's `still_running` read frees its slot when it returns,** though the statement goes on in the background (ADR #134). The slot measures what the app is waiting on, not what the file is doing.
- **The AI panel's reads take the same gate.** That is the point: they load the same server.
- **Tests:**
  - `bridge::client`: parallel calls run side by side and their connections are reused; one slot makes a call wait and builds it only on its turn; a declined build sends nothing and keeps its connection.
  - `commands::query::gates`: limit and queue, gates per connection, a changed limit.
  - `commands::query::bounded`: a read waits for its gate within its time, `not_started` when no slot comes free, `queued_ms`, and a non-read refused without taking a slot.
  - `commands::origins`: the setting survives a sync.
