---
id: 135
type: adr
status: accepted
date: 2026-11-12
tags: [grid, policy, ux]
triggered_by_external_trap: false
related: [7, 29, 113, 114, 133]
supersedes: []
superseded_by: null
amends: []
---

# ADR #135: a grid is driven by a source that states what it can write, and one controller acts on it

Every place that shows rows — a table or view browse, a query's result sets, and later anything else — hands `DataGrid` a **`GridSource`**: where the rows come from, which result column is which table column, what may be done to them (each capability with the reason it is unavailable), and the operations that do it. **One controller** consumes a source and owns everything that acts on rows: saving cells, the delete / paste / bulk-update dialogs, export, FK navigation, refresh and selection reporting. `DataGrid` stays presentational. The reason: the write side of the grid lives in `TableDataTab` alone, so every other consumer either gets none of it (the query tab, until 1.39.1) or copies a slice of it (the query tab, since 1.39.1), and each copy drifts from the rules that took years of bugs to get right.

**Decision:** introduce a `GridSource` contract with two producers, `useTableSource` (table/view browse) and `useQuerySource` (a query result set, built on `lib/query/editableSource.ts`), and one controller that renders the same grid, the same context menu and the same dialogs for both. The managed policy and anything else that limits a source is expressed as a capability's lock reason, so a gesture that is not allowed is shown disabled with its reason rather than missing. Implemented in 1.40, in two steps: first the extraction with no visible change, then the query editor's redesign on top of it.

**Alternatives rejected:**

- **Keep growing `QueryResultGrid` beside `TableDataTab`.** It is how 1.39.1 shipped edit and multi-delete for query results, and it already duplicates the delete flow, the row key and the policy reads. Paste, bulk update, export and FK navigation would each be a third copy of logic that `TableDataTab` already gets wrong only in ways we have since fixed (ADR #7 row identity, ADR #113 column limits, ADR #114 paste plans, ADR #133 trimmed rows).
- **Make `TableDataTab` itself accept a query result.** It is ~2000 lines whose state is a table browse — paging, server filters, sort, projection, the query panel, the count. A result set has none of that; threading "is this a query?" through each of them would turn one coherent component into two interleaved ones.
- **Push the write logic down into `DataGrid`.** `DataGrid` is the reusable, policy-agnostic presentation layer (columns, virtualisation, selection, editors, menu). Teaching it to call `update_cell` would tie it to Tauri commands and to one notion of "table", and its tests would need the backend.
- **Hide unavailable gestures instead of disabling them.** That is what the query tab did by omission, and it is why a user called it "view-only" rather than asking why a gesture was off. #267 already chose "disabled with the reason" for Insert; the contract generalises that choice.

## Context

`DataGrid` was always shared: the query tab and the table tab render the same component, with the same context menu, copy, selection, filter and cell editors. What was not shared is the layer above it. `TableDataTab` is where a row becomes writable: it resolves the primary key from the catalog, refuses when the key is not in the result (projection), saves cells with the catalog type (MySQL `BIT`, gotcha #15; MongoDB's real BSON type, ADR #29), confirms and runs deletes, plans and applies pastes (ADR #114), runs bulk updates, exports, navigates FKs, and reads the managed policy's relation and column locks (ADR #113). None of that was reachable from a query, so the query tab's grid could only look.

1.39.1 answered a user's request — edit and delete rows straight from a `SELECT`'s results — with `lib/query/editableSource.ts`, which recognises a single-table `SELECT` and maps its result columns onto the table, and `components/query/QueryResultGrid.tsx`, which wires cell save, single and multi-row delete onto `DataGrid`. It works, it was tried in the running app, and it is exactly the duplication this ADR exists to stop: the delete flow, `getRowKey` and the policy reads are now in two places, and the next request ("paste into the results", "export what I selected") would add a third.

## Consequences

- **The contract** (names indicative; the extraction PR settles them):
  - *identity* — connection (or database view) id, `schema`/`table` when the rows map onto one relation, the key columns and their positions in the row, and per result column the table column it writes to (or none: an expression, an ambiguous name);
  - *capabilities* — `update`, `delete`, `insert`, `duplicate`, `paste`, `bulkUpdate`, `export`, `fkNavigate`, `fieldUnset` (MongoDB), each `null` when available or the text that says why not, plus a per-column lock (policy column limits, computed columns, the key);
  - *operations* — save a field, delete rows by key, apply a paste plan, run a bulk update, export, refresh.
- **Producers decide, the controller does not.** `useTableSource` carries today's `TableDataTab` rules unchanged (PK present in the result, view → no insert, policy). `useQuerySource` is `editableSource` plus the policy; for a query, `insert` and `duplicate` are unavailable by design — a new row need not match the hand-typed `WHERE` it would appear under — and say so. MongoDB enters through `useQuerySource` once the ad-hoc query path carries `row_types`, never by guessing types from JSON (ADR #29).
- **The policy stays where it is enforced.** Capabilities only shape the interface; `update_cell`, `delete_rows`, `apply_paste` and the bulk update keep running their relation and column guards whatever a source claims (ADRs #95–#96, #113). The extraction adds no command, so `guard::HUMAN_POLICY` does not change.
- **Row identity stays data-derived** (ADR #7): the controller keys rows by the source's key tuple, and a source with no usable key falls back to the full values array for read-only selection only, as `TableDataTab` does today.
- **Step 1 — extraction, no visible change.** Characterization tests for `TableDataTab`'s write paths go in first (save with type hint, delete confirmation and `ui.confirmDestructive`, paste plan, projection without the key, view, policy locks, trimmed rows); then the logic moves behind `useTableSource` and the controller; then `QueryResultGrid` is rebuilt on `useQuerySource` and its duplicated code is deleted. The two must render the same grid and menu.
- **Step 2 — the query editor's redesign** (layout of the editor toolbar, result tabs, batch summary, and what the results area offers) builds on step 1 and gets its own design pass with Alex; it is not part of the extraction PR.
- **Undoing this** — putting write logic back in a single consumer, or adding a grid consumer that wires `update_cell`/`delete_rows` itself — needs a new ADR that supersedes this one.
