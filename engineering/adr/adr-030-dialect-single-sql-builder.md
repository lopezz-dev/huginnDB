---
id: 30
type: adr
status: accepted
date: 2026-08-05
tags: [sqlx, mssql]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #30: All per-engine SQL text goes through db::sql::Dialect

`Dialect::try_of` is the single conversion point and MongoDB is refused as `UnsupportedDriver`; a `_ =>` arm in any dialect match is a smell — new engines have silently inherited Postgres's behavior through exactly that pattern before.

**Decision:** All per-engine generated SQL goes through db::sql::Dialect (Postgres|Mysql|Sqlite|MsSql) with Dialect::try_of as the single conversion point, refusing MongoDB as UnsupportedDriver, and matches list every variant instead of using `_ =>` arms.

**Alternatives rejected:**

- A pg_or_sqlite bool: removed.
- A second driver enum (db::ddl::Driver with its own quote()) and per-command driver_of() helpers: removed.
- `_ =>` fallback arms in dialect or narrowed-set matches: let new engines/FilterOps silently inherit Postgres or wrong behaviour; replaced by exhaustive arms with explicit unreachable!.

## Detail

**Every place the generated SQL differs per engine goes through `db::sql::Dialect` — there is no `pg_or_sqlite` bool any more, and no second driver enum.** `Dialect` (`Postgres | Mysql | Sqlite | MsSql`) owns `quote_ident`, `placeholder`, `cast_to_text`, `like_kw`, `not_like_needs_lower`, `like_escape_clause`, `paginate`, `truncate_stmt`, `qualify` and `qualify_defaulted`; `Dialect::try_of(&DbPool)` is the single conversion point and returns `UnsupportedDriver` for MongoDB (not a SQL dialect — it is dispatched to `db::mongo` before any SQL is built). `db::ddl::Driver` used to be a *second*, 3-variant enum with its own `quote()`, and `commands::structure`/`commands::view` each had their own `driver_of()`; all of that is gone. Two `qualify` flavours exist on purpose: the browse path uses `qualify_defaulted` (pins Postgres's `public` / SQL Server's `dbo` so an unqualified name can't resolve through `search_path`), the DDL path uses `qualify`. When adding a dialect, the compiler finds the exhaustive matches — but **audit for `_ =>` arms**, which is how a new engine silently takes Postgres's path (`db::ddl`'s `build_alter` / `drop_index_stmt` / FK-drop were exactly that). `commands::schema`'s `TRUNCATE` was claimed here as fixed while it was still a `_ =>` arm — it now lives on `Dialect::truncate_stmt`, spelled out per dialect and unit-tested without a pool, which is the shape to copy. The same audit applies one level down to matches over *narrowed* sets: `commands::query`'s filter builder had `_ =>` arms inside its comparison and `LIKE` arms, so a new `FilterOp` compiled clean and silently behaved as `<=` / `EndsWith`; those now list every variant, with the impossible ones grouped into an explicit `unreachable!` so adding one is a build error.
