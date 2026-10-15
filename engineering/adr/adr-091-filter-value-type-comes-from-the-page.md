---
id: 91
type: adr
status: accepted
date: 2026-09-22
tags: [mongodb, grid]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #91: A filter's value type must come from the same sample the grid header shows — and on a schemaless store the user gets the last word

The grid header types a MongoDB column from the page on screen; the advanced filter typed the same column from the catalog's 100-document sample. When a collection's stored type changed at some point those two disagree, and the filter loses silently: a `value` shown as `STRING` was coerced to an `Int32`, `$ne` excluded nothing, and no error was raised anywhere. The default now comes from the page, and a per-condition type control exists because no sample can settle a schemaless field.

**Decision:** filterFieldsFor prefers the page's inferred type over the catalog's 100-document sample (unless the page says mixed/null), and FilterConditionDraft gains a valueType control expressed as Extended JSON in the payload.

**Alternatives rejected:**

- Offering separate int/double types — rejected because MongoDB compares numeric types against each other.
- Quoting filter values in chips on SQL drivers — rejected; gated to MongoDB because SQL binds values coerced against the column.
- Having build_filter parse numeric-looking strings — explicitly guarded against by a test.

## Detail

**The report.** A filter of `IOTDEVICEIO = 900` AND `value <> 5682380` left every excluded row on screen. The app's own console showed why, and showed it in one line:

```
db.iotData.find({"$and":[{"IOTDEVICEIO":"900"},{"value":{"$ne":{"$numberInt":"5682380"}}}]})
```

Two string-typed fields in one filter, one of them sent as a string and the other as an `Int32` — while the grid header above it labelled both `STRING`. Checked against the server: `value` was a `string` in 100 % of the 3000 most recent documents for that device.

- **Two samples, two panels, one field.** A MongoDB column's `data_type` is inferred twice from two different populations. `docs_to_result`/`infer_column_type` types the columns of the *result page*, which is what `useGridColumns` prints in the header. `db::mongo::schema::infer_columns` samples 100 documents of the *collection*, which is what the schema store holds and what `filterFieldsFor` was handing `coerceFilterValue`. Both are honest about their own population; neither is wrong. What was wrong is that the panel showing one answer coerced with the other, so the screen could not explain the behaviour even in principle.
- **The direction of the failure is what makes it expensive.** `isNumericType("double")` is true, `Number("5682380")` is finite, `json_to_bson` narrows an integral JSON number to `Bson::Int32`, and BSON equality is exact by type. Every step is correct in isolation and the result is a predicate that matches nothing it was meant to match. There is no error to report and no row to point at — the user sees the rows they asked to exclude and concludes the filter is broken, which it is, for a reason that lives four files away.
- **The page wins, but only when it has an answer.** `collectNestedFieldPaths` now records the top-level columns too, merging their type across the page the way it already merged a nested path's. `filterFieldsFor` prefers that over `ColumnInfo.data_type` — unless the page said `"mixed"` or `"null"`, which are the page admitting it cannot decide, and there the catalog still answers. A field absent from the loaded rows is therefore no worse off than before. SQL is untouched: its callers pass no page paths at all, and its catalog type is authoritative rather than sampled.
- **A better default is still a default, which is why there is a control.** Mongo permits one field to hold a `long` in some documents and a `string` in others; there is no answer to infer. `FilterConditionDraft.valueType` defaults to `"auto"` (the historical, type-driven path) and offers string / number / long / boolean / date / ObjectId. This is the same admission `coerceFilterValue`'s own docstring had been carrying as known debt — "fixing the edit case properly needs a per-value type picker of the kind `DocumentListView` gets from `row_types`" — and this is that picker, one surface smaller.
- **It needed no backend change, because three of the types are Extended JSON the backend already decodes.** `long` emits `{"$numberLong": …}`, `date` `{"$date": …}`, `objectId` `{"$oid": …}`, all of which `db::mongo::values::object_to_bson` has always intercepted. `ColumnFilter` is unchanged, so persisted tab state needs no migration and the chosen type survives a reload because it is expressed *in the payload* rather than beside it. The read-back (`valueTypeOf`) is what closes that loop: reopening the dialog recovers the type from the value it finds.
- **No `int` / `double` split is offered, and that is not laziness.** MongoDB compares the numeric types against each other — `{$eq: 900}` matches an `Int32`, an `Int64` and a `Double` alike — so three numeric entries would be three spellings of one question. `long` is there for a different reason entirely: it keeps the digits as text, which is the only way past 2^53, where `Number()` silently rounds. `objectId` earns its place on a second count: `build_filter` special-cases `_id` only, so an ObjectId stored in any other field had no way to be filtered at all.
- **Changing only the type is an edit.** `filterFromDraft` returns the seed payload by reference when a row's *textual* projection is unchanged, which is what stops a round trip through the dialog from degrading a `Long` into an `Int`. The value type had to join that comparison: flipping the control with the text untouched would otherwise hit the pass-through and be discarded — the one operation the control exists for, silently doing nothing.
- **The chip was the last place the fact could have surfaced, and it rendered both spellings identically.** `formatValue` is `String(v)`, so `value <> 5682380` and `value <> "5682380"` — different questions with different answers — printed the same six characters. Chips now quote a string and render the wrappers as `ObjectId("…")` / `ISODate("…")` / `NumberLong("…")`, the shell's own spellings and the ones the console already logs. Gated to MongoDB (`typedFilterValues`): on the SQL drivers the value is a bound parameter coerced against its column, so quoting it would advertise a distinction the driver does not make.
- **A guard sits on the Rust side too, where it can never be reached from the UI.** `a_filter_value_keeps_the_json_type_it_arrived_with` pins that `build_filter` passes a JSON string through as a `Bson::String`. Nothing there caused this bug; the test is there so nothing there ever "helpfully" parses a numeric-looking string, which would reinstate the same silent failure one layer below where any value-type control can reach it.
