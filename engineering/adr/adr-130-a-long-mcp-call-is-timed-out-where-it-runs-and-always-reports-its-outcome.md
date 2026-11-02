---
id: 130
type: adr
status: accepted
date: 2026-11-02
tags: [mcp, mssql, transactions]
triggered_by_external_trap: true
related: [121, 127, 128]
supersedes: []
superseded_by: null
amends: []
---

# ADR #130: A long MCP call is timed out where it runs, and always reports what became of its work

`run_script` and `run_writes` used to have no timeout of their own. The only limit was the bridge's 300-second wait for a reply, on the sidecar side. When it fired, the app went on running the script and committed it, the AI was told only "did not answer in time", and the reply later landed on the bridge connection, where the next call could read it as its own answer. Now the executor itself bounds the statements: the call's `timeout_seconds` (300 by default), never past a per-connection ceiling the user sets in Settings → MCP. When the deadline fires, the executor cancels the statement on the server, rolls back, and returns an error that says whether anything was committed.

**External trap behind it:** dropping a `tiberius` future does not tell SQL Server anything (the batch keeps running and holding its locks), and a TDS Attention, which does stop it, ends the batch but **not** an explicit transaction.

**Decision:** the deadline lives in `execute_script_inner` / `execute_write_batch_inner`, through `Session::exec_by` / `fetch_by`. It covers the statements and never the `COMMIT`. The value is resolved by `state::mcp_timeout` on both sides of the bridge. On expiry, SQL Server gets an Attention (`PooledClient::cancel`), then `IF @@TRANCOUNT > 0 ROLLBACK` and a check that `@@TRANCOUNT` is 0. The `sqlx` drivers get their session closed.

**Alternatives rejected:**

- **Just make `CALL_TIMEOUT` configurable.** Raising it lengthens the wait, but a timeout that fires still leaves an orphaned run that commits behind the AI's back, and the desynchronised connection is still there. The limit has to be enforced where the statement runs, not where the reply is awaited.
- **One knob: the call's parameter, or the connection's setting.** With only the parameter, any AI call can hold a production session for a day. With only the setting, raising it for one migration lengthens every call on that connection. Requiring both means the user decides which connection may run long, and the call decides that this one does.
- **Bound the `COMMIT` too.** A timeout that fires between "COMMIT sent" and "reply read" is the one point where the outcome really is unknown. Leaving the `COMMIT` unbounded means a timeout always lands before it, so the answer is always "nothing was committed" in transaction mode.
- **Close the socket on SQL Server too, as ADR #127 does for reads.** The server does abort and roll back, but the client never hears that it did. The Attention is acknowledged on the same session, which can then run the rollback and confirm `@@TRANCOUNT = 0`. That is the confirmation the migration's state table needs.
- **`pg_cancel_backend` / `KILL QUERY` for Postgres and MySQL now.** Both need a second connection and a race against the statement finishing. In transaction mode, closing the session already gives a certain answer, because `COMMIT` was never sent. Only `transaction: false` on those drivers stays honest-but-uncertain ("may still complete"). That case is left for later.
- **An asynchronous mode (start the call, return an id, poll for status).** This is the portable answer to client-side limits. But it needs a job registry that outlives the call, and a status tool. Neither is needed to make the synchronous path safe, so it was deferred (see `docs/MCP.md`).

## Context

MigracionBcCloud runs `INSERT … SELECT`s of millions of rows through `run_script` against SQL Server 2022. One of them, Item Ledger Entry, ran for 64 minutes. Past the bridge's 300 s, its state table recorded `EN_CURSO` and someone had to check by hand whether the load had committed. Reading the code showed three more problems:

- the app never learned that the sidecar had given up;
- on the local path (no bridge) there was no limit at all;
- rmcp 2.2 turns an MCP `notifications/cancelled` into a token that nothing in HuginnDB observes.

## Consequences

- **`state::mcp_timeout`** is the one place the value is decided. The sidecar runs it so it can tell the AI what the call got. The app runs it again against `profiles.json` (`bridge::exec::timeout_for`), for the reason it re-checks the write policy.
- **`ConnectionProfile::mcp_timeout_secs`** is local. `merge_into` preserves it across a shared-origin sync, like `mcp_write` and `mcp_max_rows`.
- **The bridge client** (`bridge::client::reply_wait`) waits twice the timeout plus 120 s for these two requests. A rollback can take about as long as the work it undoes, and the app's answer is the certain one. When the client still gives up, it shuts the connection's write half, so the next call reconnects instead of reading a stale reply. The protocol moved to version 6, so that a sidecar and an app that disagree about who times out fall back instead of racing.
- **The audit log** gets a `-- timeout N s (…)` line at the start of every script or batch, and a `CANCEL (…)` line with the verdict when one is cut off. The sidecar's bridged audit line carries `timeout=Ns`.
- **Not covered:** MongoDB writes in `run_writes`, which are single operations with no session to cancel. A client's own patience is also not covered: Claude Desktop gives up long before 300 s. Claude Code applies a per-server `timeout` and a 30-minute idle limit on stdio. Neither of these can be fixed from the server side without progress notifications or the async mode.
- Do not move the deadline back out of the executor, and do not bound `COMMIT`, without revisiting this ADR.
