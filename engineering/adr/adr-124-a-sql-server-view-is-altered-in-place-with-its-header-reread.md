---
id: 124
type: adr
status: accepted
date: 2026-10-29
tags: [mssql, ddl, views]
triggered_by_external_trap: false
related: [123]
supersedes: []
superseded_by: null
amends: [123]
---

# ADR #124: A SQL Server view is changed in place with ALTER VIEW, its header options re-read from the catalog, and renamed with sp_rename plus ALTER VIEW

The view editor, MCP's `save_view` and "Rename view" all build SQL Server's statements in `db::view_ddl::build_view_ddl`:
- a new view is `CREATE VIEW`;
- a changed body is `ALTER VIEW`;
- a rename is `EXEC sp_rename` followed by `ALTER VIEW` under the new name.

The `WITH` options in the view's header (`SCHEMABINDING`, `VIEW_METADATA`) are read from the catalog by the command layer and emitted again, because `ViewDefinition` holds only the body.

**Decision:** alter in place, never drop and recreate. Re-read the header options at build time rather than carrying them in the DTO. Follow every rename with an `ALTER VIEW`.

**Alternatives rejected:**

- **`CREATE OR ALTER VIEW`** — needs SQL Server 2016 SP1, and the app supports 2012. `ALTER VIEW` exists on every version and is what this needs, since whether the view exists is already known from `original`.
- **`DROP VIEW` + `CREATE VIEW`** — loses every `GRANT` on the view, and anything that depends on it fails in between. SQLite takes this path only because it has no other.
- **A bare `sp_rename`** — it leaves the *old* name inside `sys.sql_modules.definition`, so `OBJECT_DEFINITION`, SSMS's "Script as" and HuginnDB's own view editor would show (and a script would recreate) a view under a name it no longer has. The following `ALTER VIEW` rewrites the text and keeps permissions. On SQL Server it runs in the same transaction (`db::exec::execute_all`).
- **Add the header options to `ViewDefinition`** — that DTO is round-tripped through the frontend and through `save_view`, whose doc explains why a caller must not be able to synthesise the original. An option a client could drop by omitting a field is the failure this avoids. Reading them from the catalog (`db::mssql::schema::view_options`) puts the "what was there" answer in the database.

## Context

ADR #123 gave SQL Server table DDL. Views were left refused (`db::view_ddl` returned `UnsupportedDriver`). `Dialect::rename_stmt` still refuses a SQL Server view on purpose, and `commands::view::rename_view` sends SQL Server through the view builder instead.

## Consequences

- `strip_view_header` still drops the header when a definition is read, and `ALTER VIEW` replaces the header along with the body. Anything new that rebuilds a SQL Server view from a `ViewDefinition` must go through `build_view_ddl` with `view_options`, or it will silently unbind a schema-bound view.
- `ENCRYPTION` is not handled: an encrypted view has no readable definition, so it is reported as absent and cannot be opened in the editor.
- A move to another schema is refused on SQL Server, as it effectively is everywhere (`save_any_view_inner` never asks for one).
- **Amends ADR #123:** its last consequence ("SQL Server is now the one engine whose answer differs" between `supportsStructureEditing` and `supportsViewEditing`) no longer holds. Both predicates now answer "everything but MongoDB". They stay separate because they ask about different builders.
