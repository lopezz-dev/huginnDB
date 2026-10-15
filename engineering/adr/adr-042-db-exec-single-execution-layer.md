---
id: 42
type: adr
status: accepted
date: 2026-08-21
tags: [sqlx]
triggered_by_external_trap: false
related: [30]
supersedes: []
superseded_by: null
amends: []
---

# ADR #42: db::exec is the one place SQL actually runs, not scattered pool matches

`db::exec` exposes `execute`/`execute_params`/`scalar_i64`/`query_rows`/`execute_all`/`in_tx_expect_at_most_one` over bind-loop macros, replacing duplicated `match`-over-`DbPool` dispatch that used to live independently in several `commands/` files.

**Decision:** db::exec is the single execution layer (execute, execute_params, scalar_i64, query_rows, execute_all, in_tx_expect_at_most_one) over bind-loop macros, refusing MongoDB as UnsupportedDriver.

**Alternatives rejected:**

- `match pool { ... }` dispatch in commands/: produced byte-identical duplicates and re-inlined decoders.
- A generic function for bind loops: cannot satisfy sqlx's per-driver ColumnIndex/Encode bounds across three drivers, hence macros.

## Detail

**`db::sql::Dialect` builds the SQL; `db::exec` runs it. A `match pool { … }` in `commands/` is a smell.** `Dialect` (ADR #30) owned the per-engine *text* while every command that needed to execute anything wrote its own dispatch over `DbPool`, which is how `query.rs:2368` and `bulk.rs:236` ended up byte-identical, how one Postgres arm re-inlined a decoder that already existed 200 lines above it, and how the same "one DDL statement, no parameters" match appeared seven times. `db/exec.rs` exposes `execute`, `execute_params`, `scalar_i64`, `query_rows`, `execute_all` and `in_tx_expect_at_most_one`; `MsSqlPool` already had that surface, so its arm is one line, and MongoDB is refused with `UnsupportedDriver` (it is dispatched to `db::mongo` long before any SQL is built). Two notes for anyone extending it: the bind loops are **macros** (`bind_all!`, `bind_all_scalar!`) because a generic function cannot satisfy sqlx's per-driver `ColumnIndex`/`Encode` bounds across three drivers; and `query_rows` returns the untyped `(Vec<(String, String)>, Vec<Vec<Value>>)` shape that `db::values`'s `columns_fn!`/`result_fn!` macros generate, so a caller shapes it into whatever DTO it serialises.
