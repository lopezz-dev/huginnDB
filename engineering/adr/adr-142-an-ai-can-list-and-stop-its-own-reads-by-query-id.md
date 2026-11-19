---
id: 142
type: adr
status: accepted
date: 2026-11-19
tags: [mcp, query, bridge]
triggered_by_external_trap: false
related: [93, 94, 130, 134, 137, 140, 141]
supersedes: []
superseded_by: null
amends: []
---

# ADR #142: An AI can list and stop its own reads, by query id, and nothing else

ADRs #140 and #141 named every AI read, put the names in its replies and errors, and let several reads run at once. What a model still could not do was act on what a timeout told it. A read reported `still_running` or `unknown` kept loading the server, and the only answers on offer were to wait or to send more work on top. Stopping a running read was a person's tool only (the query tab's Stop, ADR #137).

**Decision:**

- **One registry for both.** `runs::RunRegistry` already "records and signals" a person's runs by id. Each entry now says whose it is: an AI read carries `AiRead` (its profile, the head of its SQL, when it started, and whether it is past its gate), and a person's run carries nothing. `execute_read_bounded` registers the read under its `query_id` (`AiReadOrder::profile_id`) before it waits for its slot, marks it running once it has one, and leaves the registry when it ends, however it ends.
- **A stop is a drop.** The read races its `StopSignal`. When the signal fires, the read's future is dropped. That is the stop ADR #134 already proved on every driver: `InFlight` closes the session and sends `pg_cancel_backend` / `KILL QUERY`, SQL Server's closed session aborts its request, SQLite's read is detached, and MongoDB's operation ends at its `maxTimeMS`.
  - The call that sent the read ends with `AppError::Stopped` (not applied: it was a read). The message says what became of the read on the server, or that it was still queued and never sent.
  - No second per-driver stop was written.
- **Two bridge requests, each carrying its `connection_id`.** `ListReads` and `CancelRead` (protocol 9) behind two MCP tools, `running_queries` and `cancel_query`. Because each request carries its connection, the bridge's exposure check and the managed policy (`Need::Endpoint`) apply as to any request, with no code of their own.
  - `RunRegistry::stop_ai_read` matches only an AI read registered under that same profile. A person's run, or another connection's read, answers `not_found`. So `cancel_query` can never reach a session it could not have started, and it is safe on read-only connections (`read_only_hint`).
  - Both requests travel on a connection of their own from the pool of ADR #141, so they are not queued behind the read they are about.
- **The timeout error and `run_query`'s description point at both tools,** at the moment a model needs them.

**Alternatives rejected:**

- **A second registry for AI reads.** Two maps of "statements in flight that may be asked to stop" would drift apart, and the app lock's `stop_all` would have to know about both.
- **A per-driver stop of its own for `cancel_query`,** as `commands::query::stop` does for a person's run. Dropping the read already stops it on the server, and that path is tested on every driver (ADR #134). A person's stop waits for the server's answer because a write must say whether it applied. A read has nothing to apply.
- **Kill by server session id** (`KILL <spid>`, `pg_terminate_backend`). It would let a model reach other sessions, which is what the request ruled out ("never other people's sessions"), and it needs server privileges a read-only login does not have.
- **Show the AI's reads inside `pulse_sessions`.** Pulse does not cover SQL Server or PostgreSQL. Mixing what the server reports with what the app knows would make one list answer two questions. Alex chose a tool of its own.
- **Let a `cancel_query` find a read by id alone.** The id is unguessable, but the request would then carry no connection, so no exposure or policy check would apply to it.

## Consequences

- A model can see whether a read it gave up on is still running (`running_queries`) and stop it (`cancel_query`). The reply is `stopped`, or `not_found` when the read had already ended.
- The AI panel's reads are listed too, on the connections a client may see. The panel stops its own reads by stopping its turn, which drops them, so it is not offered either tool.
- A `query_id` already in flight cannot be reused. A second read under the same id is refused before it runs.
- **Tests:**
  - `runs`: an AI read is listed and stopped only on its own connection, and never a person's run.
  - `query::bounded`: a running read stops at once, leaves the registry, and gives back no session; a queued read stops without ever being sent.
  - `mcp`: the whole loop through `bridge::exec` on the local path (list, cancel, the read's own slot saying it was stopped, then `not_found`).
  - `mcp`: the `.mcpb` manifest lists both tools.
