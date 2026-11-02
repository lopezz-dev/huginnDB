---
id: 131
type: adr
status: accepted
date: 2026-11-02
tags: [mcp, mssql, security]
triggered_by_external_trap: false
related: [76, 112, 126, 128]
supersedes: []
superseded_by: null
amends: [121]
---

# ADR #131: on SQL Server, run_script runs each GO batch whole and still checks every statement

On SQL Server, `run_script` sends each `GO` batch to the server whole, as SSMS and `sqlcmd` do, instead of cutting it at every `;`. The policy, the transaction-control refusal and the limits are still decided per statement. The verbs of a statement now include every keyword in its code, not only its head, because T-SQL needs no `;` between statements and nests them in control flow.

**Decision:** on SQL Server, the unit of execution in `commands::script::execute_script_inner` is the `GO` batch (`units`), and the unit of checking stays the statement (`split_script` → `check_script`, `verbs_of_script` via `statement_verbs`). Transaction mode on SQL Server opens with `SET XACT_ABORT ON`.

**Alternatives rejected:**

- **Keep splitting on `;` and wrap each batch with variables in `EXEC sp_executesql N'…'`** (what MigracionBcCloud's `Invoke-Motor.ps1` does today) — rejected: the work-around belongs in every caller, and a `#temp` table created inside `sp_executesql` dies with the call (gotcha #128), so it cannot cover a batch that stages through one.
- **Check per batch as well as run per batch** — rejected: a batch is a list of statements to the policy, and checking it as one text would read only its first keyword. The checks stay per statement, and a batch needs the union.
- **Make the keyword scan driver-aware** — rejected for now: `verbs_of_script` is called by the bridge server and the managed policy without the driver, and threading it through costs three call sites for no loosening. The scan only ever adds verbs, so on Postgres, MySQL and SQLite it is stricter, never looser. Every word it looks for is reserved in T-SQL.
- **Run without `XACT_ABORT`** — rejected: after most errors SQL Server goes on with the rest of the batch, so a statement after the failing one would still run inside the transaction until the rollback. With `XACT_ABORT ON` an error dooms the transaction and ends the batch. The cost: a script that catches an error and carries on inside the transaction must pass `transaction: false`.
- **Count rows per statement inside a batch** — not possible: a plain T-SQL batch does not return its `DONE` counts through `tiberius`, only `sp_executesql` does (gotcha #128). A batch of more than one statement is counted in `uncounted_batches` and left out of `total_affected`. A batch of one statement keeps the exact `@@ROWCOUNT`.

## Context

The tool's description promised that variables persist from one statement to the next. On SQL Server that was false: `split_script` cut every batch at `;` and sent each piece as its own batch, so a `DECLARE`d variable was gone by the next statement, and an `IF` / `WHILE` / `BEGIN … END` / `BEGIN TRY … END CATCH` holding a `;` reached the server in pieces it refused. MigracionBcCloud wraps each such batch in `sp_executesql` to work around it.

ADR #121 recorded a related limit: a T-SQL batch without `;` was classified by its first keyword per piece. With batches sent whole, that limit is more visible, so it is closed here too: `SELECT 1 EXEC dbo.p`, `INSERT … DROP TABLE x` and `IF @x = 1 DROP TABLE t` need `full`.

## Consequences

- **What persists:**
  - variables live for their batch and do not cross a `GO`;
  - `#temp` tables, `SET`s and the transaction cross batches, because the session does;
  - a `MERGE` keeps its closing `;`, because a batch is sent from its first statement to its end.
- **Transaction control:** `is_transaction_control` tracks T-SQL block depth (`block_depth_after`):
  - a block `BEGIN`, `BEGIN TRY` and an `END` that closes a block are not transaction control;
  - in transaction mode, a `COMMIT`, `ROLLBACK`, `BEGIN TRAN` or `SAVE TRAN` inside `IF` / `WHILE` / `ELSE` / a block is refused, as a bare one is.
- **Keyword scan:** `verbs_in_code`, over `db::sql::code_words`, ignores literals, quoted and bracketed names and `@variables` / `#temp` names. A leading `sp_` / `xp_` name, or `ENABLE` / `DISABLE`, is a bare procedure call or a trigger toggle, and is DDL.
- **Errors:** a failure names the batch and the line SQL Server reports, translated into the script's own line numbers (`server_line`).
- **Still open:** `run_query`, `run_write` and `run_writes` classify through `db::classify::verbs_of`, which still reads only the head of each `;` piece. On SQL Server they have the limit this ADR closes for `run_script`.
- **Tests:**
  - unit tests in `commands/script.rs`;
  - live tests against a real server in `commands/mssql_live_tests.rs`, `#[ignore]`d, gated by `HUGINNDB_TEST_MSSQL_HOST`.
