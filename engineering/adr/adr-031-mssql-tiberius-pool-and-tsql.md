---
id: 31
type: adr
status: accepted
date: 2026-08-05
tags: [mssql, sqlx]
triggered_by_external_trap: true
related: [15]
supersedes: []
superseded_by: null
amends: []
---

# ADR #31: SQL Server needs its own pool (tiberius) and four T-SQL divergences

`MsSqlPool` wraps a semaphore-guarded stack of `tiberius` clients that only return to the pool on a `Server`-classified error; pagination needs an injected `ORDER BY`, inserts prefer `OUTPUT INSERTED` with a `SCOPE_IDENTITY()` fallback for triggers, and binary writes need an explicit `CONVERT` — DDL editing, renames and `.sql` export/import stay deliberately deferred.

**External trap behind it:** sqlx has no MSSQL driver, tiberius has no pool and Client::query takes &mut self, OFFSET/FETCH requires ORDER BY, OUTPUT is refused on tables with triggers (error 334), and implicit nvarchar->varbinary conversion stores the characters' bytes.

**Decision:** SQL Server rides Dialect::MsSql over our own semaphore-guarded tiberius pool that returns a session only after a Server-classified error, with ORDER BY (SELECT NULL) pagination, OUTPUT INSERTED with a SCOPE_IDENTITY() fallback on error 334, CONVERT for binary writes, and DDL editing/rename/view DDL/.sql dump deferred.

**Alternatives rejected:**

- Reusing a session after a non-Server (I/O, protocol, TLS) error: would corrupt the next caller's TDS stream.
- SCOPE_IDENTITY() as the only key-recovery path: does not recover uniqueidentifier/sequence defaults; 'don't simplify this to one path'.
- ROW_NUMBER() pagination for SQL Server 2008: not done, so 2012 is the floor.
- native-tls instead of rustls: would drag OpenSSL onto the Linux leg.
- Tunnelling a named instance: refused because SQL Browser is a separate UDP service.
- Inline `driver !== "sqlserver"` checks: use the capability gates in lib/db/driver.ts instead.

## Detail

**SQL Server is a *SQL* driver with a *non-sqlx* client — the hard parts are the pool and four T-SQL divergences.** `sqlx` dropped MSSQL after 0.6, so `db/mssql/` wraps `tiberius`. Unlike MongoDB it does **not** opt out of the SQL path; it rides `Dialect::MsSql` (brackets, `@P1`, `NVARCHAR(MAX)`, `OFFSET/FETCH`). Things that will bite:
    - **`tiberius` has no pool and `Client::query` takes `&mut self`**, so `MsSqlPool` is ours: a `Semaphore` sized from the endpoint budget the pool was granted (`PoolLimits::max_connections`, *not* a constant of the driver's own — `DEFAULT_MAX_SESSIONS = 4` is only the fallback when that doesn't convert) + a stack of idle clients + a `PooledClient` guard that returns its session on `Drop`. The load-bearing rule is in `PooledClient::classify`: a session goes back to the pool **only** when the error was `tiberius::error::Error::Server` (the server rejecting a statement). Anything else (I/O, protocol, TLS) means we don't know where we are in the TDS stream, so the session is dropped — reusing it would corrupt the *next* caller's query, not this one. That's why the command layer never touches a raw `Client`: it gets `query_rows` / `execute` / `simple_query_sets` / `scalar_i64` and the decision lives in one place.
    - **`OFFSET … ROWS FETCH NEXT … ROWS ONLY` requires an `ORDER BY`.** `Dialect::paginate` injects `ORDER BY (SELECT NULL)` when the user hasn't sorted. This is why the driver's floor is **SQL Server 2012**; 2008 would need a `ROW_NUMBER()` window.
    - **Generated keys use `OUTPUT INSERTED.<pk>`**, not `SCOPE_IDENTITY()` — it also recovers a `uniqueidentifier`/sequence default, not just IDENTITY. But SQL Server refuses `OUTPUT` on a table with triggers (**error 334**), so `insert_row` detects that code (`db::mssql::is_output_clause_conflict`) and retries with `SCOPE_IDENTITY()`. Don't "simplify" this to one path.
    - **Binary columns need `CONVERT(varbinary(max), @P1, 1)`** (`db::mssql::binary_convert`). This is gotcha #15's trap again: values travel as text, and T-SQL's implicit nvarchar → varbinary conversion reinterprets the *characters*, so saving the `0x4A2B` the grid shows would store the ASCII of that string. Driven off the frontend's `RowValue.columnType` hint. `bit`, dates, numbers and even `uniqueidentifier` coerce correctly and need nothing.
    - `bit` is decoded as the **number 0/1**, not a JSON bool, so the grid's BIT display preference and `BitInput` keep working (same call as MySQL's `TINYINT(1)`); `decimal`/`numeric`/`money` decode as **strings** to avoid `f64` rounding.
    - `update_cell`'s multi-row guard is a real transaction, but via `BEGIN`/`COMMIT`/`ROLLBACK` *statements* on one held session — `tiberius` has no transaction handle.
    - **Deferred on purpose**: the structure editor's DDL, table/view rename (`sp_rename`), *creating or redefining* a view, and `.sql` export/import. `db::ddl::reject_unsupported` and `db::view_ddl::build_view_ddl` refuse `MsSql` up front, which is what makes the `unreachable!` arms below them genuinely unreachable. Note `build_view_ddl` lives in **`db/view_ddl.rs`**, a sibling of `db/ddl.rs`, not inside it. *Reading* a view's definition is NOT deferred — `db::mssql::schema::view_definition` reads `sys.sql_modules`, since the missing piece was only ever the T-SQL DDL builder; nor is dropping one. The frontend hides those affordances through the capability gates in `src/lib/db/driver.ts` (`supportsDdlEditing` / `supportsSqlDump` / `supportsCreateDatabase`) — add to those rather than writing `driver !== "sqlserver"` inline.
    - **A named instance can't be tunnelled**: the SQL Browser is a separate UDP service, so `db::mssql::open_pool` refuses the combination instead of silently connecting to the wrong port.
    - `AuthMethod::Windows` (NTLM) is `cfg(windows)`-gated *inside tiberius*, so the arm is `#[cfg(windows)]` and the CI's Linux leg compiles SQL-login-only. The connection dialog hides the mode off Windows.
    - Its `rustls` feature pins `tokio-rustls 0.24` → **rustls 0.21 alongside the tree's 0.23**. Accepted knowingly (the alternative, `native-tls`, drags OpenSSL onto the Linux leg); revisit on any `cargo update` that lets tiberius move up.
