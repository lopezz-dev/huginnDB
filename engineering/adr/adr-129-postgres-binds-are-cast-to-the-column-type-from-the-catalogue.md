---
id: 129
type: adr
status: accepted
date: 2026-11-02
tags: [sqlx, postgres, grid]
triggered_by_external_trap: true
related: [30]
supersedes: []
superseded_by: null
amends: [5]
---

# ADR #129: On Postgres, every bound value is cast to its column's type, read from the catalogue

Values still cross as `Option<String>` (ADR #5), but on Postgres the statement now casts each one to the type of the column it is compared with or assigned to: `"id" = CAST($1 AS smallint)`. The type comes from the server's own catalogue (`format_type(atttypid, -1)`), read once per write or filtered browse. ADR #5's premise, that "drivers cast textual literals server-side", was never true for Postgres. Editing, filtering, deleting or inserting on any non-text column failed with `operator does not exist: smallint = text` (GitHub #268).

**External trap behind it:** `sqlx-postgres` 0.8 declares every `String` / `&str` bind as `text` (OID 25, `types/str.rs`) and always sends parameters in the *binary* format (`connection/executor.rs`, `formats: &[PgValueFormat::Binary]`). Postgres has no implicit cast from `text` to integer, numeric, boolean, uuid, date/time, enum, jsonb, bytea or array types.

**Decision:** `Dialect::typed_placeholder(index, ty)` renders `CAST($n AS ty)` on Postgres and the bare placeholder everywhere else. The `ty` comes from `BindTypes`, filled only by `db::exec::bind_types`, which reads `pg_attribute` for the relation exactly as the statement names it (`to_regclass`). Every path that binds a value against a column goes through it: the filter builder (grid, query panel, *Result*/*Explain*, count, export, bulk update's `WHERE`), `update_cell`, `delete_rows`, `insert_row`, `insert_rows`, `apply_paste` and `apply_bulk_update`'s `SET`.

**Alternatives rejected:**

- **Bind as `unknown` (OID 705), so Postgres infers the type from context like a typed-in literal.** It would have been one change in `db::exec` and no catalogue read. It cannot work with `sqlx`: parameters go in binary format, so once Postgres infers `smallint` it reads the UTF-8 bytes of `"1"` with `int2recv` and fails with `insufficient data left in message`. Text columns work because `textrecv` takes the raw bytes as they are, which is exactly the case that never failed. `commands::pg_live_tests::pg_live_unknown_oid_cannot_carry_a_text_value` keeps this as evidence and will flag a future `sqlx` that changes it.
- **Cast with the frontend's type hint (`RowValue::column_type`, `ColumnMeta`).** It would save the round trip. But the type name is spliced into the SQL text, so it would have to be validated, and a stale schema cache would cast to the wrong type. The hint is also absent on some paths (bulk JSON insert, MCP). The catalogue is right by construction and is not something a caller can choose.
- **Cast with the type modifier (`format_type(atttypid, atttypmod)`).** An explicit cast to `varchar(4)`, `char(3)` or `bit(3)` *silently truncates*. A value too long for the column would be cut instead of refused. With `-1` the cast goes to `character varying`, `bpchar` or `"bit"`, and the column enforces its modifier on assignment, exactly as for a hand-written literal.
- **Compare the column cast to text (`CAST(col AS TEXT) = $1`).** It changes semantics (`1.0` vs `1`, timestamp formatting) and defeats every index on the column.

## Context

GitHub #268 (Zoynels): on a Postgres table with a `smallint` primary key, editing any cell, deleting a row, filtering on the key and inserting a row all failed. The cause was the same in each case. A `psql` repro with `text`-typed prepared parameters gave the same errors, and so did the builders run against a real server through `sqlx` (`pg_live_typed_binds`: 33 of its cases failed before this change). MySQL, SQLite and SQL Server coerce a text parameter to the column type on their own, which is why ADR #5 held there and why nobody noticed on Postgres until a non-text key came along.

## Consequences

- **One catalogue round trip** per cell edit, delete, insert, paste and bulk update on Postgres, and per browse, count or export whose filters compare a value (`TableFilter::compares_values`). An unfiltered or pattern-only browse pays nothing. The other engines never make the call: `bind_types` returns an empty map without touching the pool.
- **The other dialects' SQL is byte-for-byte unchanged.** `typed_placeholder` ignores `ty` off Postgres, and `bind_type_tests` / `insert::tests` assert it even when they are handed a type map.
- **Pattern matches are not cast.** `CAST(col AS TEXT) ILIKE $1` and `lower(…) NOT LIKE lower($1)` compare text with text, as does the search box.
- **A column the catalogue does not know** (a name that does not resolve, a mismatch in case) keeps its bare placeholder. It runs exactly as before, with the server's own error if any.
- **`apply_bulk_update`'s preview degrades instead of failing** when the catalogue read fails, like its MySQL `BIT` fallback. Every other path propagates the error, since the statement that follows would hit the same server.
- **New write or filter paths on Postgres must take a `BindTypes`.** A bare `dialect.placeholder(n)` for a value compared with a column is the bug this ADR fixes. The pure builders (`build_filter_clause_at`, `update_cell_statement`, `delete_rows_statement`, `build_insert_statement`) take it as an argument, so a new caller cannot forget it without the compiler noticing.
- `src-tauri/src/commands/pg_live_tests.rs` runs all of this against a real server when `HUGINNDB_TEST_PG_URL` is set (`cargo test pg_live -- --ignored`). It is `#[ignore]`d by default, because CI has no Postgres yet.
