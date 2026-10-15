---
id: 17
type: gotcha
status: active
date: 2026-06-06
tags: [mysql, sqlx]
related: [15]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #17: MySQL BLOB vs TEXT is decided by content, not the type name

The server sometimes flags genuine text columns as `BINARY` at the protocol level, so `mysql_value` reads raw bytes via `try_get::<Vec<u8>>` and validates UTF-8 itself. Using `try_get::<String>` first would reject a `BINARY`-flagged `LONGTEXT` before ever inspecting the bytes, collapsing it to hex.

**Trap:** sqlx names a column LONGBLOB vs LONGTEXT from the protocol BINARY flag, which MySQL sometimes sets on real text columns, and try_get::<String> rejects such columns before looking at the bytes.

## Detail

**MySQL `BLOB`/`TEXT` are disambiguated by content, not just the type name (`mysql_value`, gotcha #15's neighbour).** sqlx derives the column type name (`LONGTEXT` vs `LONGBLOB`, `TEXT` vs `BLOB`, …) purely from the protocol-level `ColumnFlags::BINARY` bit, which the MySQL server *sometimes* sets on genuine text columns depending on charset/collation — so a real `LONGTEXT` arrives named `LONGBLOB` and used to render as a hex dump. The flag isn't reachable through sqlx's public API. The `contains("BLOB") || contains("BINARY")` branch therefore reads the **raw bytes** via `try_get::<Vec<u8>>` and runs `String::from_utf8` itself: valid UTF-8 → text, otherwise hex. **Crucially it must NOT use `try_get::<String>` first** — `try_get` runs sqlx's *type-compatibility* gate before decoding, and `String` is incompatible with a `BINARY`-flagged column, so it returns `Err` *without ever inspecting the bytes*; a pristine UTF-8 `LONGTEXT` (e.g. a big JSON document) then always collapsed to hex (the 1.0.10 bug). `Vec<u8>` is compatible with BLOB, so reading bytes + validating ourselves decides text-vs-binary by content. Tradeoff: a true binary blob that happens to be valid UTF-8 renders as text (same as HeidiSQL). Don't revert to `try_get::<String>` or to unconditional hex.
