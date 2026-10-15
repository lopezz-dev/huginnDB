---
id: 4
type: convention
status: active
date: 2026-05-13
tags: [security, sqlx]
related: [16]
supersedes: []
superseded_by: null
amends: []
---

# Convention #4: quote_ident is for catalog identifiers, not user input

User input always goes through bound parameters (`$1` / `?`), never `quote_ident`, except for the one sanctioned, validation-mediated exception in the DDL builder documented separately (ADR #16).



## Detail

**`quote_ident` is for catalog-sourced identifiers, not arbitrary user input.**
   Documented in `src-tauri/src/db/sql.rs` and in `SECURITY.md`. User input always goes through bound parameters (`$1` / `?`).
