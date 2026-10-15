---
id: 5
type: adr
status: accepted
date: 2026-05-13
tags: [sqlx, postgres, grid]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #5: update_cell's value is Option<String> end-to-end

The cell editor only ever emits text and drivers cast textual literals server-side, so `serde_json::Value` can't be pushed through `update_cell` — sqlx postgres won't encode `Value` to arbitrary column types.

**External trap behind it:** sqlx's postgres driver will not encode a serde_json::Value to arbitrary column types.

**Decision:** The update_cell value is Option<String> end-to-end; the cell editor emits text and drivers cast textual literals server-side.

**Alternatives rejected:**

- Pushing serde_json::Value through update_cell: sqlx postgres won't encode Value to arbitrary column types.

## Detail

**`update_cell` value is `Option<String>` end-to-end.**
   The cell editor only emits text; drivers cast textual literals server-side. Don't try to push `serde_json::Value` through it — `sqlx` postgres won't encode `Value` to arbitrary column types.
