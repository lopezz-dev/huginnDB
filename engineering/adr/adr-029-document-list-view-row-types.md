---
id: 29
type: adr
status: accepted
date: 2026-08-12
tags: [mongodb, grid]
triggered_by_external_trap: false
related: [7, 15, 17]
supersedes: []
superseded_by: null
amends: []
---

# ADR #29: The Mongo list view edits using row_types, not the display JSON's types

`bson_to_json` is lossy on purpose, so `docs_to_result` ships a parallel `row_types` array that every write sends back as `update_cell`'s `column_type`. Fields are addressed by dotted path, and opaque types (`Binary`, `MinKey`, …) are not inline-editable.

**Decision:** docs_to_result ships a cell-aligned row_types (bson_type_tree per cell) that every list-view write sends back as update_cell's column_type; fields are addressed by dotted path and opaque types are not inline-editable.

**Alternatives rejected:**

- Inferring the BSON type from the displayed JSON value: would silently rewrite a Long as an Int (e.g. 301353073 fits Int32).
- Populating row_types for SQL drivers: their hint must stay the catalog type so MySQL BIT keeps its CAST and the catalog fallback is not suppressed.
- Addressing fields by display index instead of path.
- Inline-editing opaque types (Binary, DbPointer, MinKey, MaxKey): would store the display string literally.

## Detail

**The list view edits with the *server's* types, not the display JSON's — `QueryResult.row_types` exists for that and must stay aligned with `rows`.** `bson_to_json` is lossy on purpose (gotcha #17's philosophy): `Int32`/`Int64`/`Double` all reach the frontend as a JSON number and `ObjectId`/`Date`/`Decimal128` all as a string. That was harmless while the list view (`components/grid/DocumentListView.tsx`) was read-only; the moment it started writing, inferring a type from the value would have rewritten a `Long` as an `Int` the first time someone fixed a typo in it — and `301353073` fits in an `Int32`, so the bug is invisible in testing and permanent in the data. `docs_to_result` therefore ships a parallel `row_types` (one `bson_type_tree` per cell: a scalar is its type name, a document/array is an object/array of the same shape), and every write sends that type back as `update_cell`'s `column_type`. Keep the two arrays cell-aligned, and leave `row_types` `None` for the SQL drivers — **their** hint has to stay the catalog type, because `update_cell` reads it to decide whether a MySQL `BIT` needs its `CAST` (gotcha #15); handing it the list view's `"string"` would both miss the cast and suppress the backend's catalog fallback. Two more rules the same fidelity concern imposes: a field is addressed by its **path** (`customData.format`, `tags.2` — dotted, so `$set`/`$unset` take it as-is), never by a display index (ADR #7, one level down); and types whose display form can't be parsed back (`Binary`, `DbPointer`, `MinKey`, `MaxKey` — see `OPAQUE_TYPES` in `lib/grid/documentTree.ts`) are **not** editable inline, because committing the text `Binary(Generic, 12 bytes)` would store exactly that string. The type picker is their escape hatch, and it is MongoDB-only: `onFieldDelete`'s presence is what switches the component into document mode (add/delete/retype), since a SQL row's column set belongs to the table, not the row.
