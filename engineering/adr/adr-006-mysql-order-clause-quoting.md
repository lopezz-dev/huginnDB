---
id: 6
type: adr
status: accepted
date: 2026-05-13
tags: [mysql, grid]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #6: MySQL order_clause no longer string-rewrites identifiers

`fetch_table_data` computes `pg_or_sqlite` once and passes the right boolean straight to `quote_ident`, replacing the old brittle `"col"` → `` `col` `` string-rewriting hack. Don't reintroduce it.

**Decision:** fetch_table_data computes pg_or_sqlite once and passes the right boolean to quote_ident from the start when building the ORDER clause.

**Alternatives rejected:**

- String-rewriting "col" into `col` in the MySQL order_clause: brittle; do not reintroduce.

## Detail

**The MySQL `order_clause` previously had a brittle string-rewriting hack** to convert `"col"` → `` `col` ``. Now `fetch_table_data` computes `pg_or_sqlite` once and passes the right boolean to `quote_ident` from the start. Don't reintroduce the hack.
