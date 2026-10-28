---
id: 121
type: adr
status: accepted
date: 2026-10-28
tags: [mcp, security]
triggered_by_external_trap: false
related: [54, 58, 76, 93, 94, 112]
supersedes: []
superseded_by: null
amends: []
---

# ADR #121: a script runs on one session that is closed after it, and a temporary table is still DDL

The MCP connector's `run_script` runs a whole SQL script — inline or from a local `.sql` file — on one pinned session, in order, inside one transaction unless asked not to, and closes that session instead of returning it to the pool. Temporary tables, `SET`s and variables therefore last exactly as long as the script and never reach another caller. The write tier is read from the statements as they are, so `CREATE TEMPORARY TABLE` needs `full` like any other DDL.

**Decision:** one new tool and one bridge request (`BridgeRequest::RunScript`, protocol 5) executed by `commands::script::execute_script_inner` through `bridge::exec::execute`; the session lives for one call; the tier is the union of every statement's verbs (`verbs_of_script`), with no exception for temporary objects.

**Alternatives rejected:**

- **A session handle that survives across calls** (`open_session` → id → later calls) — rejected: it holds a pooled connection, and on a tunnelled server a slot (ADRs #104, #105), for as long as a model takes to think, needs an idle timeout and a story for a sidecar that dies holding it, and buys little over sending the script in one call. A migration is a script; the script is the unit.
- **Returning the pinned session to the pool** — rejected: a temp table, a `USE` or an open transaction the script left behind would surface in the next grid page somebody opens on that pool. Closing it costs one connect per script.
- **Lowering session-scoped DDL (`CREATE TEMP TABLE`, `#temp`, `DROP TEMPORARY TABLE`) to the `data` tier** — rejected by the maintainer. It is harmless to the persistent schema, but recognising it needs a second, name-tracking reading of the script (a later `CREATE INDEX ON staging` is only temporary if `staging` was), and a `data` connection should keep meaning "rows only" on a plain reading of each statement. A migration that stages through temp tables runs on a `full` connection.
- **Looping `RunStatement` on the sidecar side** — rejected for the reason ADR #112 gives for `RunWriteBatch`: each request takes whichever pooled session is free.
- **Reusing the editor's `execute_batch_inner`** — it runs on one acquired connection too, but returns it to the pool, opens no transaction and reports every statement; the MCP shape needed the opposite on all three.
- **Refusing MySQL executable comments**, as `run_writes` does — rejected because every `mysqldump` file is full of them. Each statement is classified and checked as written *and* with `/*! … */` unwrapped, and needs the union.
- **The app reading `path`** — rejected: the sidecar reads the file and sends text, so the desktop app never opens a file because a bridge client named one. Only absolute `.sql` paths, so the argument is not a general file reader; the contents are executed, not returned, though a failure message quotes the start of the statement it names.

## Context

A colleague migrating many tables ran `.sql` files with credentials in a `.yaml` — exactly what the connector exists to avoid. Pointed at HuginnDB, his assistant answered that it would rewrite the logic "using CTEs in single statements, since it does not support temporary tables or batches". It was right about the surface it had: `run_write`/`run_query` each take a free pooled session, so a temporary table made by one call was not there for the next and a verification `SELECT` could never see it; `run_writes` refuses DDL and puts reads after the commit, on another session; and `run_writes` caps a list at 50 entries.

## Consequences

- **Transaction mode refuses transaction control** in the script (`BEGIN`, `COMMIT`, `SAVEPOINT`, `SET autocommit`…), and on **MySQL** a persistent DDL statement or `LOCK TABLES`, which commit implicitly. `transaction: false` runs the script as written; whatever it leaves open dies with the session.
- **Reads inside a script do not get the read-only transaction (ADR #93)** — they must run on the script's session to see its temp tables. That is why a script that only reads is refused and sent to `run_queries`; a script always carries a write, so its tier is at least `data`.
- **Splitting** is the shared `split_statements` lexer plus T-SQL `GO` lines; `DELIMITER` (a `mysql` client command) is refused. A T-SQL batch without `;` between statements is still classified by its first keyword per piece — the same limit `run_write` has today.
- **Bounds:** 10 000 statements and 16 MB per call; reads share the sidecar's `--max-rows`, passed in the request and applied where rows are fetched. The bridge client waits five minutes for an answer, so a longer script must be split.
- **Managed policy** sees the script as `Need::FreeSql(verbs_of_script)`, so a scoped rule refuses it as it refuses `run_write`. The AI panel never gets the tool.
- **`PooledClient::close_on_drop`** (SQL Server) mirrors sqlx's `PoolConnection::close_on_drop`; a new caller that leaves session state behind should use them rather than hand the session back.
- **MongoDB is refused**: no session objects to pin; `run_writes` covers an ordered list of MongoDB writes.
