---
id: 43
type: adr
status: accepted
date: 2026-08-21
tags: [sqlx, schema-tree]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #43: Catalog SQL lives in db/<driver>/schema.rs; DTOs stay with the command

`commands/schema.rs` is now dispatch-only with no `unreachable!()` arms; DTOs stay next to the commands that serialize them as the IPC contract, and `strip_view_header` lives in `db/view_ddl.rs` since that's the module that builds view headers in the first place.

**Decision:** Catalog SQL lives in db/<driver>/schema.rs, commands/schema.rs is dispatch-only, DTOs stay next to the commands that serialise them, and strip_view_header lives in db/view_ddl.rs.

**Alternatives rejected:**

- Inline per-driver SQL inside commands/schema.rs's *_inner functions with unreachable!() arms: replaced.
- Moving the DTOs into driver modules: they are the IPC contract.
- Putting strip_view_header in the SQLite module: view_ddl.rs builds such headers and is the honest owner.

## Detail

**Catalog SQL lives with its driver, in `db/<driver>/schema.rs` — the DTOs stay with the command that serialises them.** `commands/schema.rs` used to hold 40–60 lines of inline SQL per driver inside each of its seven `*_inner` functions, plus 17 `unreachable!()` arms, while `db/mssql/schema.rs` and `db/mongo/schema.rs` already did it the other way round. It is now ~250 lines of dispatch and none of those arms. The DTOs (`TableInfo`, `ColumnInfo`, …) deliberately did **not** move: they are the IPC contract, so they belong next to the commands that serialise them, and each driver module mirrors their shape exactly. `db::sqlite::schema::list_databases` is sync and returns a single `"main"`; SQLite's `list_columns`/`list_indexes` take a documented `_schema` they ignore. The same move later took the view-definition reads out of `commands/view.rs`'s own `match` into `db::<driver>::schema::view_definition` — with one exception that is not a violation: `strip_view_header` went to **`db/view_ddl.rs`**, not into the SQLite module, because SQLite and SQL Server both store the whole `CREATE VIEW … AS …` statement and the module that knows how such a header is *built* is the honest owner of taking one apart.
