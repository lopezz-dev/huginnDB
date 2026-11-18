---
id: 138
type: adr
status: accepted
date: 2026-11-17
tags: [grid, query, export]
triggered_by_external_trap: false
related: [93, 96, 135, 137]
supersedes: []
superseded_by: null
amends: [135, 137]
---

# ADR #138: every exported file of rows is written by one Rust writer, in the same formats from both grids

A grid's rows are exported in the same formats whichever grid shows them — a query's result or a table's rows through its query panel: CSV (`,` or `;`), Excel (`.xlsx`), JSON and SQL `INSERT`. Every one of those files is written by **one writer**, `db::result_export::RowWriter`, fed row by row. The frontend no longer serialises a file: the query tab's "rows shown" send their values to `export_query_result`, which writes them with the same writer as "Everything, from the server…" (`export_query_rows`) and as a table's rows (`export_table_rows`). The one exception is a table's SQL dump, which keeps its own writer because it is a dump of a table, not a description of a result.

**Decision:** one writer for every exported file of rows, in Rust, and one menu of formats (`ExportFormatItems`) rendered by both grids. Alex took it on 2026-11-17, with Excel in scope and MongoDB's collection export left as it is.

**Alternatives rejected:**

- **Keep serialising the rows shown in the frontend, and send only Excel's rows to Rust.** Two writers for one menu: a result's CSV would come from JavaScript and its Excel from Rust, and the next format would have to be written twice or pick a side. The golden test already made both sides produce the same text bytes, so moving the file to Rust costs nothing in what the file says.
- **Build Excel in the frontend** (SheetJS or similar). A second large dependency, and only for the rows the grid holds: a table's rows and a cut result's server export are streamed by the backend and never reach the webview whole, so the backend needs the writer anyway.
- **A command per format for the table** (`export_table_csv`, …). Each would repeat the query panel's filter, the policy checks and the save dialog that `export_table_rows` already owns. A `format` argument on the existing command keeps one place for all three.
- **A table's SQL through `RowWriter` too.** Its `INSERT`s are one per row and name a result's columns; the table dump batches, sets `IDENTITY_INSERT` and leaves `rowversion` out on SQL Server, which is what inserting back into a table needs. Different jobs, kept apart.

## Context

A user asked to export data in a format other tools read (CSV or similar). The query tab already offered CSV, JSON and SQL (ADR #135, #137); a table's "Export data" offered only `.sql`. Doing it for the table alone would have left the formats, their labels and their bytes defined twice, and Excel — which the user's request implied and Alex asked for — cannot be built where the query tab's export was built, in JavaScript.

## Consequences

- `db::result_export::RowWriter` is the only place an exported file's bytes are decided. A new format is a `ResultFormat` variant there, a value in `ResultExportFormat` (`src/types.ts`), a label in `ExportFormatItems` and its place in `EXPORT_FORMATS` (`lib/query/exportResult.ts`) — both grids get it.
- `RowWriter::new` takes an `InsertInto` (dialect **and** table) only for SQL, so a result with no dialect — MongoDB's — exports as CSV, JSON or Excel without inventing one.
- A table's rows in a non-SQL format are streamed by `commands::query::stream_read_only`, the barrier and stream of ADR #137, now taking bound parameters: the query panel's values are bound, and its hand-written expression runs inside the read-only barrier of ADR #93. SQL Server streams a parameterised statement through `Conn::query_each`.
- Excel: cells are typed from the JSON value (number, boolean, text; NULL empty); a string stays text (no guessing of `DECIMAL`s or dates from text); a whole number is formatted `0` and every column starts at least 15 characters wide, so a millisecond timestamp reads whole instead of `1,79E+12` or `########`; an integer longer than the 15 digits Excel shows exactly is written as text; past 1 048 575 rows a sheet continues on the next with its header. `rust_xlsxwriter`'s constant-memory mode keeps a row at a time in memory plus the compressed workbook.
- **A text over Excel's 32 767 characters is cut, not refused.** The first version refused the whole export, naming the row and column. Tried on Dev | Tencer's `logRecord` (11 667 rows, stack traces in `message`), that made Excel unusable for any table with a log or JSON column — 434 cells over the limit — and CSV is no escape in Excel, which splits such a cell into new rows when it opens the file. Alex chose on 2026-11-17 to cut the cell, end it in `[…]` (language-neutral: the backend does not know the interface's language) and report the count: `RowsExported { path, truncatedCells }` is what the three rows exports resolve to, and `rowsExportedNotice` turns it into the one notification all three show. CSV and JSON keep every character.
- The JavaScript serialisers in `lib/grid/copyFormats` remain for the clipboard only; `exportResult.golden.test.ts` and `the_golden_files_match` keep them byte-identical to the files.
- Out of scope, by decision: a collection's export stays its JSON (CSV would need a rule for flattening documents).
