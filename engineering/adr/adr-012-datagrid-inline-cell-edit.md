---
id: 12
type: adr
status: accepted
date: 2026-05-30
tags: [grid, ux]
triggered_by_external_trap: false
related: [7]
supersedes: []
superseded_by: null
amends: []
---

# ADR #12: Double-click on a grid cell edits inline, not in a modal

`DataGrid.openCellEdit` routes by column type — a single-column FK opens `FkCombobox`, an editable cell opens inline `CellInput`, a read-only query result opens the modal as a viewer — tracked by the row's values-array identity rather than a display index.

**Decision:** Double-click edits inline: DataGrid.openCellEdit routes a single-column FK to FkCombobox, an editable cell to inline CellInput, and a read-only query result to the modal as a viewer.

**Alternatives rejected:**

- Routing double-click straight to the modal: explicitly not to be reintroduced.

## Detail

**Double-click on a data-grid cell edits inline, not in a modal.** `DataGrid.openCellEdit` routes by column: single-column FK → `FkCombobox`; editable cell → inline `CellInput` (the shared input also used by the insert draft row, with an *expand* button that escalates to the Monaco `CellEditor`); read-only query result → the modal as a viewer. `inlineEdit` is tracked by the row's *values array* identity (ADR #7), not a display index. The inline commit no-ops when the value is unchanged, which is what makes the blur fired during *expand* harmless. Don't route double-click straight to the modal again.
