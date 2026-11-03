---
id: 133
type: adr
status: accepted
date: 2026-11-03
tags: [mongodb, grid, performance]
triggered_by_external_trap: false
related: [7, 29, 81, 129]
supersedes: []
superseded_by: null
amends: []
---

# ADR #133: a MongoDB browse leaves oversized fields on the server until their row is used

The grid's MongoDB collection browse no longer sends a top-level field larger than `GridPrefs::trim_large_values_kb` (64 KB by default; 0 turns this off). The server swaps such a field for `null` and reports its type and size, and the grid shows it as `Array · 1.4 MB`. Before anything edits, copies, duplicates or filters by that row, the grid loads the whole document by `_id`. The reason: one page of a collection holding LLM transcripts was 6.9 MB, and moving it through an SSH tunnel took 0.4–2.8 s, against 35 ms of server work.

**Decision:** when `TableQuery::trim_above` is set, `db::mongo::query::fetch_collection_data` runs the browse as the equivalent `aggregate`: the find's own `$match`/`$sort`/`$skip`/`$limit`, then the projection as `$project`, then two stages from `trim_stages` that cut by `$bsonSize`. It reports what was cut in `QueryResult::trimmed`. Only the grid sets `trim_above`. In the frontend, `TrimmedRows` (`lib/grid/trimmedCells.ts`, built in `TableDataTab`) is the one way a row becomes whole, and every value-reading action reaches it.

**Alternatives rejected:**

- **Fix the rendering and keep sending everything.** That was measured first (Muninn 1c17956c). Rendering cost ~150 ms and the IPC ~100 ms of a 1.5–3 s open; the rest was the transfer. A faster grid would not have been noticed.
- **Wire compression alone (#303).** It is on now and helps every read, but a 1.5 MB prompt still compresses to hundreds of KB per row, and binary blobs do not compress. It shortens the transfer; it does not avoid it.
- **A `find` with an expression projection.** `find` accepts aggregation expressions in its projection, but it cannot rebuild a document with an unknown set of keys (`$replaceWith`), so it could only cut fields named in advance.
- **A marker value inside the document** (e.g. `{ $trimmed: … }` in place of the field). It would reach every consumer that does not know about it: the document list would expand it as a sub-document, and a nested edit would `$set` a path inside the marker. Instead the server wraps each result as `{ d, t }`, the cell is a plain `null`, and the cut list travels beside the rows, where only code that asks for it sees it.
- **Disable every action on a cut row until the user clicks "Load".** Considered with Alex and rejected in favour of loading on use. Disabling would put a guard on each of about twenty entry points, and any one of them missed would silently write the stand-in `null`.

## Context

`QueryResult.rows` is what every grid action reads: inline edit, the heavy and side editors, the cell preview's save, the list view's field edits, copy as JSON/INSERT/UPDATE, duplicate, paste and filter-by-value. A survey of the frontend found about twenty such paths, and `update_cell` keeps no before-value. So a placeholder that reached any of them would be written back. That is why the design cuts fewer cells than it could, and spends its effort on making sure nothing acts on a cut row.

## Consequences

- **What is cut:** only top-level fields, and never `_id`. Every write and every reload addresses the document through `_id`. Aggregation expressions cannot recurse, so a nested value is cut as part of its top-level field.
- **Result line and Explain:** they still describe the `find` (`describe_find_shell`). The pipeline's first stages are that find, and the server plans them the same way. The two trim stages run on at most one page, after every decision about *which* documents and in what order. Changing the browse so that the cut changes *which* documents come back would break this. That would need its own ADR.
- **Fallback:** any command error from the pipeline falls back to the plain `find`. That covers servers older than 4.4 (no `$bsonSize`) and keys `$arrayToObject` refuses. A fault in the user's own filter fails the `find` the same way and surfaces from there.
- **Scope:** only the grid sets `trim_above`. The MCP connector, the AI panel, export (`commands::mongo::export_collection`, its own `find`) and ad-hoc queries all get whole documents.
- **Loading a row:** `TrimmedRows.hydrate` reuses `fetch_table_data` with an `_id` equality filter, so it needs no new command and no new entry in `guard::HUMAN_POLICY`. `mergeLoadedRow` lays the document out on the page's columns and replaces only that row's array. Per ADR #7, that new identity is what the selection, the preview and the editors follow; every other row keeps its own. If the document has gone, the user is told and nothing proceeds.
- **Where loading happens:**
  - `useCellEditing`: every opener (inline, modal, side panel, list-view field) re-reads the value from the loaded row and ignores what the caller passed.
  - `DataGrid`'s `withFullRow`: copies, the Ctrl+C chord and bulk "copy N rows".
  - `TableDataTab`: duplicate, and the targets of a paste.
  - `DocumentListView`: field copy, document copy, and a double-click on a cut field.
  - Filter-by-value is disabled on a cut cell. *Set NULL* stays enabled, because it does not read the value.
- **Cost:** with nothing to cut, the pipeline cost ~5–15 ms more than the `find` over the measured tunnel. A collection of 10 file blobs went from 2.3 s to 66 ms.
