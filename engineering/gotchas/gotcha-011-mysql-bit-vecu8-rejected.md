---
id: 11
type: gotcha
status: superseded
date: 2026-05-30
tags: [sqlx, mysql]
related: [15]
supersedes: []
superseded_by: 15
amends: []
---

# Gotcha #11: sqlx rejects Vec<u8> reads on a MySQL BIT column

Its blob-compatibility check only accepts BLOB/STRING/VARBINARY. See gotcha #15 for the full, current MySQL integer/BIT decode-and-write story, which supersedes this note.

> **Superseded by gotcha #15** — [gotcha-015-mysql-integer-bit-decoding.md](gotcha-015-mysql-integer-bit-decoding.md).

**Trap:** sqlx rejects try_get::<Vec<u8>> on a MySQL BIT column because its blob compatibility check accepts only BLOB/STRING/VARBINARY.

## Detail

**`sqlx` rejects `try_get::<Vec<u8>>` on a MySQL `BIT` column** (its blob compatibility check accepts only BLOB/STRING/VARBINARY). See gotcha #15 for the full, current MySQL integer/`BIT` decode + write story — it supersedes this note.
