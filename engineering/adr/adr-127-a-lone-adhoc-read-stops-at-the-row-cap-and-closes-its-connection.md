---
id: 127
type: adr
status: accepted
date: 2026-10-30
tags: [query, performance, mssql]
triggered_by_external_trap: false
related: [42, 54]
supersedes: []
superseded_by: null
amends: []
---

# ADR #127: A lone ad-hoc read stops at the row cap and closes its connection instead of draining it

When an ad-hoc read overflows `MAX_ADHOC_QUERY_ROWS`, the app stops reading at the first row past the cap. If nothing else needs that connection, it closes it rather than reading and discarding the rest. A `SELECT * FROM big_table` typed into the editor used to stream the whole table before the grid showed its first 50 000 rows. Now it costs the 50 000 rows it shows. A batch or script still has the rest drained, because its later statements need the session.

**Decision:** `fetch_capped` stops at the first row past the cap. `fetch_capped_alone` (Postgres, MySQL) and `MsSqlPool::query_sets_capped` (`Overflow::Close`) run the single-statement read on a connection of their own, and when the result overflows they close that connection instead of draining it. The batch runner and the script runner keep draining (`Overflow::Drain` on SQL Server; sqlx's own drain before the next statement on the others).

**Alternatives rejected:**

- **Keep draining everywhere** (the behaviour before this ADR). It is correct, but the cost scales with the table, not with what the grid shows. Nothing can cancel it either, because the Run button's clock never cancels the driver call. Draining existed only to leave the connection clean for the pool, and that reason does not apply to a connection nobody will use again.
- **Close on overflow everywhere, batches included.** A batch or script carries session state into its next statement: an open transaction, `#temp` tables, `SET` options, `@variables`. Closing mid-batch would make every later statement fail or run against the wrong state.
- **Server-side cancel** (`pg_cancel_backend`, `KILL QUERY`, a TDS attention). This would need a second connection, a per-driver protocol and a race against the statement finishing. Closing the socket reaches the same result with nothing to coordinate, because the server aborts a statement whose client is gone.
- **Add a `LIMIT` to what the user typed.** That means rewriting user SQL, and the text is arbitrary: a CTE, a `UNION`, a T-SQL batch, a statement that already has a limit. The app runs what was typed (ADR #42), and the cap is enforced on the stream instead.

## Context

`MAX_ADHOC_QUERY_ROWS` exists to keep a non-selective query from taking the app down with an out-of-memory error. Rows past the cap were never *kept*, but they were all *read*:

- `fetch_capped` looped to the end of the stream.
- On SQL Server, `simple_query_sets_capped` did the same so that `PooledClient::classify` would find the TDS stream at a clean boundary.

The comment on the constant gave the reason: leave the pooled connection at a clean protocol boundary rather than mid-response.

That reason holds for a connection that is going back to the pool, or on to another statement. For a single ad-hoc read it costs the whole table to protect a connection that can just be closed and replaced.

## Consequences

- **Where the rest is drained (sqlx).** `fetch_capped` itself no longer drains. sqlx drains a Postgres or MySQL connection whose stream was dropped early before that connection's next statement, so a batch or script session stays correct and pays what it paid before. SQLite has nothing on the wire: dropping its iterator resets the statement, so no read lock is left open.
- **How a connection is closed.**
  - sqlx: `PoolConnection::detach` plus `drop`. That drops the socket with no protocol exchange and keeps the pool's size accounting honest. `close_on_drop` is not used, because closing through the pool could drain first.
  - SQL Server: the `PooledClient` is marked `close_on_drop` before `classify`, which would otherwise judge the `Ok` result healthy and return a session still mid-response to the pool.
- **The read-only transaction** (`execute_read_with_state`'s `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`) is now opened by hand on the dedicated connection rather than through `Pool::begin_with`, because a `Transaction` cannot be detached.
  - When the connection is kept, it is rolled back explicitly. If that rollback fails, the connection is closed rather than returned to the pool inside a transaction.
  - When the connection is closed, the server rolls the transaction back itself.
- **Side effects can be aborted.** A "read" with side effects that returns more than the cap — for example `SELECT nextval('s') FROM generate_series(1, 100000)` — used to run to completion. Now the server aborts it when the socket closes, and in autocommit its effects roll back with it. Writes are classified away from this path (ADR #54), so only a side effect hidden inside a `SELECT` is affected. The result the grid shows is the same either way.
- **SQL Server result sets.** On the single-read path, result sets after the one that overflowed are not read. That path only ever shows the first non-empty result set.
- **What must stay true.**
  - `fetch_capped`'s callers that keep their connection must not close it.
  - A new caller on a dedicated connection should close on overflow rather than drain.
  - `Overflow::Drain` is the only correct choice for any SQL Server session that runs another statement afterwards.
- **Tests** in `commands::query::read_barrier_tests` (SQLite, in memory):
  - the stop at the cap, with a cap of zero (a spent batch budget) and a result of exactly the cap;
  - a write on the same connection after an early stop;
  - an overflowing lone read giving its slot back on a one-connection pool.
- **Not covered by tests.** The network drivers' behaviour on close is not exercised; it needs a live server.
