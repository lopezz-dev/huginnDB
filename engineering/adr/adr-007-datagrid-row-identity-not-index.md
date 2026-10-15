---
id: 7
type: adr
status: accepted
date: 2026-05-20
tags: [tanstack, grid]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #7: DataGrid mutation callbacks use row values, not a row index

TanStack's `row.index` is the filtered display index while parents used to resolve the PK from the unfiltered backend page, so the two diverge as soon as a client filter is active. Anything needing identity must read `row.original`, the values array passed to the callback.

**External trap behind it:** TanStack Table's row.index is the filtered display index, so it diverges from the unfiltered backend page as soon as a client filter is active.

**Decision:** DataGrid cell-mutation callbacks pass row.original (the full values array) and anything needing identity (PK lookup, delete, duplicate, FK overlay anchor) reads from it.

**Alternatives rejected:**

- Index-based callback contract resolving the PK from result.rows[index]: corrupted data when globalFilter was active, because row.index is the filtered display index.

## Detail

**DataGrid cell-mutation callbacks pass `row.original` (the full values array), NOT a row index.** The previous index-based contract corrupted data when the user had `globalFilter` active: TanStack's `row.index` is the *filtered display* index, while parents resolved the PK from `result.rows[index]` (the unfiltered backend page). The two diverge as soon as the client filter is non-trivial. Anything that needs identity (PK lookup, delete, duplicate, FK overlay anchor) reads from the values array passed to the callback. See `DataGrid.tsx` props + `TableDataTab.pkValueFromRow`.
