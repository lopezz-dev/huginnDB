---
id: 128
type: gotcha
status: active
date: 2026-10-30
tags: [mssql, tiberius]
related: [31, 123, 125, 126]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #128: tiberius's `execute` is an `sp_executesql` call, and SQL Server scopes what runs inside it

`tiberius::Client::execute` (our `PooledClient::execute` / `simple_execute`) always sends the text as an `sp_executesql` RPC, even with no parameters. It is the only tiberius call that reports rows affected, which is why it is tempting for any non-read. But SQL Server treats the RPC as a scope. A transaction may not be opened or closed inside it, and `#temp` tables, `SET` options and variables created inside it disappear when it returns.

**Trap:** `BEGIN TRANSACTION` sent through `execute` fails with error 266 *after* opening the transaction, so the caller sees a failure while the session is left inside a live transaction.

## Detail

- **Symptom:** `Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements. Previous count = 0, current count = 1.` (error 266, class 16) on `BEGIN TRANSACTION`, and the same with the counts reversed on `COMMIT` / `ROLLBACK`. Because the transaction really is open, every later statement on that session runs inside it and holds its locks. In 1.37.0 this was how editing a cell, pasting and inserting rows failed on SQL Server, leaving the session pooled mid-transaction. The `run_writes` / `run_script` / editor-batch paths failed the same way.
  A `#temp` table created through `execute` is gone by the next statement, and a `SET` such as `IDENTITY_INSERT` reverts — the failure ADR #126 had already designed around.
- **Cause:** SQL Server checks that a stored-procedure call, `sp_executesql` included, leaves `@@TRANCOUNT` as it found it. Objects and settings created inside a procedure are scoped to it. A plain SQL batch (TDS `SQLBatch`, tiberius's `simple_query`) has neither restriction.
- **What to do:**
  - Transaction control goes through `PooledClient::{begin_tran, commit_tran, rollback_tran}`, which send plain batches and keep the guard closed rather than pooled while a transaction is open. The parameterised statements in between can stay on `execute`: an RPC that does not change `@@TRANCOUNT` is fine inside a transaction opened outside it.
  - Statements whose effect has to outlive the call (user batches, scripts) need a plain batch. To get rows affected there, read `@@ROWCOUNT` in a following batch on the same session; it survives from one batch to the next, as checked on NAVDEMO.
  - `db::exec::execute_all` already ran its DDL as plain batches for these reasons (ADR #123).
- **Retire when:** tiberius exposes the `DONE` row counts of a `simple_query` stream. Then plain batches could report rows affected themselves.
