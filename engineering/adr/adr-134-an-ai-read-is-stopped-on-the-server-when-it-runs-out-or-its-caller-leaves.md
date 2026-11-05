---
id: 134
type: adr
status: accepted
date: 2026-11-05
tags: [mcp, query, mssql]
triggered_by_external_trap: true
related: [93, 127, 130, 132]
supersedes: []
superseded_by: null
amends: [127, 130]
---

# ADR #134: An AI's read is stopped on the server when it runs out of time or its caller goes away

`run_query` and `run_queries` had no limit in the app. When the MCP client gave up, nothing told the app, and the statement went on loading the server. Now an AI's read runs with the connection's MCP timeout (300 s at most). When the deadline passes, or when the future running it is dropped, the read is stopped where it runs. The bridge drops it when the sidecar hangs up, and the sidecar drops it when the MCP client cancels the call. Its session is never handed back to the pool.

**External trap behind it:** PostgreSQL and MySQL notice that a client has gone only when they next write to it. A `GROUP BY` writes nothing until it has finished, so closing the socket does not stop it. ADR #127 assumed it did. On top of that, rmcp 2.2 turns an MCP `notifications/cancelled` into a cancellation token, and the handler keeps running unless it watches that token.

**Decision:** `commands::query::execute_read_bounded` is the AI's read. It applies the read-only barrier of ADR #93 and the row cap of ADR #127, adds a deadline, and stops the statement on the server:

- **PostgreSQL:** `pg_cancel_backend(pid)` is sent from a second connection. The pid is learnt in the same round trip as `BEGIN READ ONLY`.
- **MySQL:** `KILL QUERY id` is sent from a second connection. The id comes from `CONNECTION_ID()`.
- **SQL Server:** the session is closed, and SQL Server aborts the request of a client that disconnects (gotcha #132). An Attention is tried first when the deadline fires.
- **MongoDB:** the operation carries a `maxTimeMS`.
- **SQLite:** the read cannot be stopped. Its connection is detached from the pool and the read finishes in the background.

`bridge::server` drops a read when its client's socket yields anything while the read is in flight. `bridge::client` drops its write half when a call is dropped mid-flight. `mcp::until_cancelled` drops a read tool's body when the request's token is cancelled.

**Alternatives rejected:**

- **Rely on the socket closing, as ADR #127 did.** That holds for SQL Server and for a read that is streaming rows. It does not hold for the read that actually hurts: an aggregation on a bad plan, which streams nothing.
- **Set a server-side statement timeout** (`SET LOCAL statement_timeout`, `max_execution_time` / `max_statement_time`). That covers the deadline but not a caller that goes away. MySQL and MariaDB also spell it differently, and a session variable outlives the read on a pooled connection.
- **Let `run_query` take `timeout_seconds` like `run_script`.** A read that needs more than five minutes needs a better plan, not a longer wait. A bigger knob would only make it cheaper for a model to retry the same bad query. The connection's ceiling can still lower the limit.
- **Drop any request whose client goes away, writes included.** A write that was sent must finish and be answered, because ADR #130 promises that its outcome is known. Only a `RunStatement` classified as a read is dropped.
- **Drop the metadata reads too.** They already have the connection's operation timeout. Dropping `EnsureConnected` halfway through opening a pool buys nothing and risks a lot.

## Context

DECOCER, ticket 26TK11132, on 2026-11-04, against the client's production SQL Server 2019. A `run_query` with a `GROUP BY` over a view that joined two other views got a nested-loops plan. Claude Desktop reported `Request timed out` (its own 60-second limit), but `sys.dm_exec_requests` still showed `program_name = 'HuginnDB'` running at 88 s, with 65 s of CPU and 19.8 M logical reads. It took a `KILL` from SSMS to stop it, twice. While it ran, a view that normally takes 0.8 s took 51 s, with Power BI connected to the same server.

The app ran `RunStatement` with no deadline. `serve_connection` awaited it without reading the socket. The sidecar waited 300 s for the reply. Nothing in the sidecar watched rmcp's cancellation token.

## Consequences

- **The limit is `bridge::exec::timeout_for(state, policy_id, None)`**, so `state::mcp_timeout` decides it, as it does for scripts. Without `timeout_seconds` a read gets `min(300, ceiling)`. `bridge::client::reply_wait` gives a `RunStatement` 300 s + `REPLY_SLACK`, so the app's error, which says what happened, arrives first.
- **`execute_read_with_state` is gone.** Its only caller was `bridge::exec`. So is `execute_adhoc`'s `read_only` flag and `fetch_sqlite_query_only`. A person's read from the editor (`execute_with_state`) stays unbounded: the person is watching it.
- **The AI panel's reads** go through `bridge::exec` too, so they get the same deadline, and stopping a turn stops its read on the server.
- **Each read costs one more round trip** on PostgreSQL and MySQL (two on MySQL, which avoids multi-statements), to learn the id it may need to cancel.
- **The cancel may not be permitted.** `pg_cancel_backend` and `KILL QUERY` on your own session need no privilege, but if a pool hands out connections under another role the cancel fails. The error then says so, and the session is closed anyway.
- **The timeout error tells the model not to retry** and to look at the plan first. That is the lesson of DECOCER, where a skill had to forbid the retry by hand.
- **Tests:** `commands::query::bounded::tests` (SQLite: the deadline and the drop each leave a fresh, writable connection on a one-connection pool, and both fail when `detach` is removed), `bridge::client` (a dropped call shuts the write half), and `bridge::server` (`abandonable`). `commands::read_cancel_live_tests` checks each server's activity view: the probe is seen running, then gone after the deadline or the drop. It ran against SQL Server 2016 (NAVDEMO) on 2026-11-05. PostgreSQL and MySQL have not been run live yet.
- Do not bring back a read path for the AI that skips this executor, and do not drop writes on disconnect, without revisiting this ADR.
