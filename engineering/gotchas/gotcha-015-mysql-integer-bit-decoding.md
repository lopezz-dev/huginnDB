---
id: 15
type: gotcha
status: active
date: 2026-06-01
tags: [mysql, sqlx]
related: [11]
supersedes: [11]
superseded_by: null
amends: []
---

# Gotcha #15: MySQL integer and BIT decoding is width- and type-specific

`mysql_value` tries signed-then-unsigned integer widths before falling back to NULL, must route sqlx's `"BOOLEAN"`-named `TINYINT(1)` columns into the integer branch explicitly, and writing a `BIT` cell needs `CAST(? AS UNSIGNED)` since a plain textual `"1"` would otherwise store the ASCII byte.

**Trap:** sqlx rejects mismatched integer widths, reports TINYINT(1) as "BOOLEAN" (which does not contain "INT"), and a textual "1" written to a BIT column is stored as ASCII 0x31, so naive decode/write shows NULLs or wrong bits.

## Detail

**MySQL integer/`BIT` decoding is width- and type-specific (`mysql_value` in `src-tauri/src/db/values.rs`).** sqlx maps each MySQL integer width to one Rust type and rejects a mismatched `try_get`: `TINYINT`→`i8`, `… UNSIGNED`→`u8`/`u16`/`u32`/`u64`, etc. The `contains("INT")` branch therefore tries signed widest-first then unsigned, falling back across widths before surrendering to `Value::Null` — without this, bare `TINYINT`/`SMALLINT` and any unsigned column rendered as "NULL". `BIT` is decoded via `try_get::<u64>` (sqlx special-cases `ColumnType::Bit`; `Vec<u8>` is rejected). **A MySQL `TINYINT(1)`/`BOOL`/`BOOLEAN` column is reported by sqlx as the type name `"BOOLEAN"`** (see `ColumnType::name`: `Tiny` with display width 1 → `"BOOLEAN"`; a plain `TINYINT` stays `"TINYINT"`, and the width is never in the name — so `"TINYINT(1)"` is a name sqlx never emits). Since `"BOOLEAN"` does **not** contain `"INT"`, it must be routed into the integer branch explicitly (`contains("INT") || name == "BOOLEAN"`); the old `name == "BOOL" || name == "TINYINT(1)"` guard never matched, so booleans fell through to the `String` fallback and rendered as "NULL" (issue #68, fixed 1.9.0). We decode it as the underlying integer (0/1), not a Rust `bool`, because a `TINYINT(1)` can hold any small int (2, -1, …) and forcing `bool` would lose that. On the *write* side, editing a MySQL `BIT` cell needs `SET col = CAST(? AS UNSIGNED)` — a plain textual literal `"1"` is stored as the ASCII byte `0x31`, not the integer 1; `update_cell` takes an optional `column_type` from the frontend to detect this (a `BOOLEAN`/`TINYINT` needs no such cast — a textual `"1"` casts to the integer 1 fine).
