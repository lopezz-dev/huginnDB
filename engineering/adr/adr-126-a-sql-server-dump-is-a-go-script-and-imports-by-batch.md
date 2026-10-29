---
id: 126
type: adr
status: accepted
date: 2026-10-29
tags: [mssql, export, import]
triggered_by_external_trap: false
related: [123, 124, 125]
supersedes: []
superseded_by: null
amends: []
---

# ADR #126: A SQL Server dump is a `GO`-separated T-SQL script, and a SQL Server import runs by `GO` batch

`commands::dump::export_mssql` writes a `GO` line after every statement, the batch separator SSMS and `sqlcmd` understand. The frontend's importer splits a SQL Server file on those lines (`lib/sql/tsqlBatches.ts`) and only falls back to the `;` splitter when there are none. `SET IDENTITY_INSERT … ON`, the `INSERT` and `… OFF` travel as **one** batch with no `;` between them.

**Decision:** for SQL Server, the unit of import and export is the `GO` batch, not the `;` statement. Session state an `INSERT` depends on goes in the same batch as the `INSERT`.

**Alternatives rejected:**

- **`;`-terminated statements only, like the other engines** — HuginnDB's own export would load, but no real T-SQL script would. A `CREATE PROCEDURE`, `TRIGGER` or `FUNCTION` body is full of semicolons, `splitSql` cuts it apart, and the server receives fragments. A file without `GO` would also not run in SSMS unchanged (`CREATE VIEW` must start its batch, for one).
- **`SET IDENTITY_INSERT` as separate statements around the inserts** — the importer runs each statement as its own call (`execute_batch` → `sp_executesql` per statement), and a `SET` made inside one call does not outlive it, so the `INSERT` would see `IDENTITY_INSERT OFF`. Pinning the import to one session would not help either: the scope is the call, not the connection.
- **Reseeding the identity after loading** (`DBCC CHECKIDENT`, the analogue of Postgres's `setval`) — unnecessary. SQL Server raises the current identity to the highest value an `IDENTITY_INSERT` wrote, and the end-to-end run shows `IDENT_CURRENT` matching the source.
- **Teaching `splitSql` T-SQL** (brackets, `GO`) — it drives the query editor's per-statement CodeLens too, where a `GO`-aware split would change what "run this statement" means for every SQL Server tab. The import is the one place that must not cut a batch, so that is where the batch splitter lives.

## Context

Part 3 of SQL Server's DDL surface, after table DDL (ADR #123) and views (ADR #124). The literal encoder is `db::dump::mssql_literal`:
- dates are written as ISO 8601 with a `T` and a fraction width per type, because the space-separated form is read through the session's `DATEFORMAT` for `datetime`;
- `datetimeoffset` is read as `DateTime<FixedOffset>`, so the stored offset survives;
- text is written as `N'…'`;
- binary is written as `0x…`.

`rowversion` columns are left out of every `INSERT`, because the server refuses an explicit value.

## Consequences

- Verified end to end against SQL Server 2016 (canary build driven by Playwright/CDP; checked with `sqlcmd`). A database with `IDENTITY`, defaults, `rowversion`, every temporal type, `xml`, `varbinary`, `uniqueidentifier` and Unicode text was:
  1. exported;
  2. imported through the app's own importer into an empty database;
  3. compared row by row, `IDENT_CURRENT` included: identical;
  4. loaded by `sqlcmd -i` as well.
- `splitGoBatches` is a lexer, like `splitSql` (ADR #33). A `GO` line inside a string, a bracketed name or a comment is text. `GO <n>` is left in the batch, so the server refuses it by name rather than running the batch once.
- Known losses, from `TableStructure` rather than the dump:
  - computed columns are recreated as plain columns holding their values;
  - an `IDENTITY` column's seed and increment become `(1,1)`; the loaded rows keep their values and the counter continues from the highest;
  - `CHECK` constraints are lost, as on every engine.
