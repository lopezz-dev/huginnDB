---
id: 140
type: adr
status: accepted
date: 2026-11-18
tags: [mcp, query, bridge]
triggered_by_external_trap: true
related: [93, 127, 130, 132, 137]
supersedes: []
superseded_by: null
amends: [134]
---

# ADR #140: An AI read's time belongs to the MCP call, is asked for by the sidecar, and its timeout says how it ended

ADR #134 gave every AI read the connection's MCP timeout, 300 s at most, and stopped it on the server when that ran out. Two gaps remained. The MCP client is the one waiting, and some clients give up before 300 s without cancelling. And `run_queries` gave the full limit to **each** statement, so a list of four slow reads could hold the client four times longer than it would ever wait.

Now the sidecar asks for each read's time, the whole call shares one budget, and a timeout comes back as a structured error that names the read and says whether it is still running.

**External trap behind it:** an MCP client that abandons a tool call at its own limit (240 s in the case below) without sending `notifications/cancelled`. Nothing reaches the sidecar, so ADR #134's "a client that gives up stops the read" does not fire, and the read loads the server until the app's own deadline.

**Decision:**

- **The sidecar asks, the app caps.** `BridgeRequest::RunStatement` gains `timeout_secs` and `query_id` (protocol `8`). The sidecar sends what is left of its call's budget. The app keeps resolving that through `state::mcp_timeout`, so the connection's ceiling still wins. Only the sidecar knows its client, so only the sidecar can fit the client's wait. The model still gets no knob: the value comes from `--read-timeout-secs` on the server's command line, 180 s by default, and it can never exceed 300 s.
- **One budget per call.** `mcp::ReadBudget` starts when the call arrives. `read_many` (`run_queries`, `run_writes`' `verify`) gives each statement what the ones before it left. Once less than half a second is left, the rest come back as `{"skipped": …}` and are never sent.
- **A short reply slack for reads.** `bridge::client::reply_wait` waits for what the read asked for plus 30 s (`READ_REPLY_SLACK`), not plus 120 s. The app's stop takes at most 10 s past the deadline, and a read has no rollback to wait for.
- **The id is minted before the read is sent.** The sidecar mints it, so the id is known even when no reply comes back. The app mints one for the AI panel's reads, which send none.
- **A structured timeout.** `AppError::ReadTimedOut(ReadTimeout)` carries `query_id`, `connection_id`, `sql_head` (200 characters), `elapsed_ms`, `limit_secs`, `state` and `verdict`. The message stays the sentence it was, now led by the state.
  - The state comes from each driver's executor, the only place that knows whether its stop was answered (`commands::query::bounded`): `not_started` (no session came free), `cancelled` (the kill answered, `maxTimeMS` fired, or SQL Server's session was closed — gotcha #132), `still_running` (SQLite), or `unknown` (the kill failed or MongoDB did not answer).
  - `AppError::detail()` exposes it. `BridgeResponse::err_detail` carries it through the bridge, `AppError::Bridged` and `BridgeError::Remote` keep it, and `mcp::to_err` hands it to the client as the error's `data`. In `run_queries` it goes in the slot's `timeout`.
- **Successful reads are named too.** `run_query` and each `run_queries` slot carry `query_id` (`mcp::Identified`), so a later `running_queries` or `cancel_query` can refer to it.

**Alternatives rejected:**

- **Lower `DEFAULT_MCP_TIMEOUT_SECS` in the app.** It also bounds `run_script` / `run_writes` and the AI panel's reads, which have no outside client to fit. And the right value depends on the client, which the app cannot see.
- **Let the app split `run_queries`' budget.** The app sees one `RunStatement` at a time and does not know when the MCP call started or how many statements are left.
- **Read the client's limit from the MCP `initialize` handshake.** Clients do not declare it, so the result would be a guess keyed on the client's name.
- **Give `run_query` a `timeout_seconds`.** ADR #134 rejected that, and the reason still holds: a read that needs longer needs a better plan, and a knob would make it cheaper for a model to retry the same bad query.
- **Report the timeout's state only in the sentence.** The model would have to parse it, and the one fact it must act on — "do not run this again yet, it is still loading the server" — would sit in prose.

## Context

TILES BC13 (NAV 2018 on SQL Server 2016), 2026-11-18. A skill that reads NAV's object code decompresses `[Object Metadata]` blobs in SQL. Searches took 6 to 101 s each. Four heavy reads were sent as parallel `run_query` calls. Three came back from the client as "No result received from client-side tool execution after waiting 4 minutes", and a retry of one did the same. The connection had no ceiling of its own, so each read ran to the app's 300 s with nobody waiting for the last minute. The model could not tell whether a read was still running, so it retried on top of it.

## Consequences

- **Protocol `8`.** A `7` app and an `8` sidecar refuse each other at the handshake. That is deliberate: against a `7` app, the sidecar would stop waiting at 210 s while the read ran on to 300 s.
- **`execute_read_bounded` takes a `query_id`.** Every caller names its read.
- **SQLite reports `still_running`, not `cancelled`.** That is the truth: the statement goes on waiting on its lock, on a connection taken out of the pool.
- **What this does not do yet:** stop a read on request (`cancel_query`), list the reads in flight (`running_queries`), or limit how many reads run at once against one connection. Those come next, on top of the id introduced here.
- **Tests:**
  - `commands::query::bounded::tests`: the state, id, head and elapsed time of a timeout; `not_started` when the pool's only session is held; cutting the head at a character boundary.
  - `mcp::tests`: one budget across `run_queries`, a spent budget skips the rest, a timeout's detail in its slot end to end through the local path, and the `--read-timeout-secs` parse and clamp.
  - `bridge::client`: the reply wait of a read.
  - `commands::read_cancel_live_tests` now also asserts `state: cancelled` against each live server.
