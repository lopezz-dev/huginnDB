---
id: 123
type: adr
status: accepted
date: 2026-10-29
tags: [mssql, ddl, schema]
triggered_by_external_trap: false
related: [30, 39]
supersedes: []
superseded_by: null
amends: []
---

# ADR #123: The T-SQL structure builder looks up constraint names at run time, and refuses an IDENTITY change instead of rebuilding the table

SQL Server binds every column default and every primary key as a *named constraint*, usually with a server-generated name (`DF__orders__statu__3B75D760`). It refuses to drop or retype a column while a default is bound to it. `TableStructure` carries no constraint names. Rather than widening it, `db::ddl::build_alter_mssql` emits a `DECLARE … FROM sys.default_constraints / sys.key_constraints` + `EXEC(… QUOTENAME(@name))` batch that finds the name and drops the constraint when the statement runs. A change of `IDENTITY` on an existing column is refused with the reason, not implemented.

**Decision:** constraint names are resolved by the statement, in the database, when it runs. `IDENTITY` on an existing column is refused. The whole list runs in one transaction on a pinned session, as plain SQL batches.

**Alternatives rejected:**

- **Carry the constraint names in `TableStructure`** — it is the structure editor's round-trip DTO, mirrored in `src/types.ts` and sent back as `desired`. A field added for one engine rides through every engine's payload (the `WorkingColumn` failure ADR #39 records). A name read at introspection can also be stale by apply time; the lookup cannot.
- **Rebuild the table for an `IDENTITY` change**, as SSMS's designer does (new table, `IDENTITY_INSERT` copy, drop, `sp_rename`, recreate indexes, keys and triggers). That moves every row and has to recreate everything that references the table, behind a checkbox. It is the kind of operation that should be a deliberate script, not a side effect of the structure editor.
- **Run through `sp_executesql`** (`PooledClient::simple_execute`, i.e. tiberius's `Client::execute`) — several statements `DECLARE` a variable, which is batch-scoped, and opening or closing a transaction inside an RPC call risks SQL Server's "transaction count after EXECUTE" check. `simple_query_sets` sends each statement as its own batch.

## Context

The structure editor was read-only on SQL Server since 1.13.0, because `db::ddl` refused `Dialect::MsSql`. The catalog introspection (`db::mssql::schema::table_structure`) was already complete.

## Consequences

- `build_alter_mssql` orders its output by dependency, not by column: renames (`sp_rename`), then removed foreign keys, indexes and the primary key, then removed columns (each after its default), changed columns (default off → `ALTER COLUMN` → default back on), new columns, and last the new primary key, indexes and foreign keys. Reordering these breaks real servers in ways the unit tests (which only compare strings) will not catch.
- Names go into T-SQL *strings* through `db::sql::mssql_nstring` (single quotes doubled), because `validate_ident` lets `'` through: it is legal inside a bracketed name.
- `db::exec::execute_all` wraps SQL Server in `SET XACT_ABORT ON; BEGIN TRANSACTION`, and closes the session afterwards rather than returning it to the pool.
- `Dialect::rename_stmt` renames a SQL Server *table* through `sp_rename`, but still refuses a *view*: `sp_rename` leaves the old name in `sys.sql_modules`, so renaming a view belongs with the T-SQL view builder.
- The frontend's `supportsDdlEditing` became two predicates, `supportsStructureEditing` and `supportsViewEditing`, because SQL Server is now the one engine whose answer differs between them.
