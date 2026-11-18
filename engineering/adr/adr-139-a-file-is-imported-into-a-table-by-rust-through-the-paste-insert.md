---
id: 139
type: adr
status: accepted
date: 2026-11-17
tags: [import, grid, policy]
triggered_by_external_trap: false
related: [4, 5, 33, 95, 96, 113, 118, 138]
supersedes: []
superseded_by: null
amends: []
---

# ADR #139: a CSV, JSON or Excel file is imported into a SQL table by Rust, through the paste's multi-row insert, all or nothing

A person can import a `.csv`, `.json` or `.xlsx` file into an existing SQL table from the table grid's Insert menu or the table's node in the schema tree. **Rust reads the file**: the frontend only passes its path, as it does for a `.sql` import. The file's columns are matched to the table's **by name, ignoring case**, and the person can change that mapping in the dialog. The rows go into the table through the same chunked multi-row `INSERT` that pasting JSON rows uses (`commands::insert`), **in one transaction**. If any row fails, nothing is written, and the error names the row. Values cross as text, and the server casts them to each column's type (ADR #5).

**Decision:** two commands. `import::preview_import_file` reads the file and touches no database (policy `none`). `import::import_table_file` reads the file again, applies the mapping, and inserts (policy `insert`, guarded per relation and per mapped column in the wrapper). Both are built on a pure reader, `db::import_file`, and on the insert core extracted from `insert_rows_inner`. Alex settled the scope on 2026-11-17: CSV + JSON + Excel, a mapping by name that the person can edit, all or nothing, insert only, and entry points in both the grid and the tree.

**Alternatives rejected:**

- **Parse in the frontend** (papaparse / SheetJS) and send the rows to `insert_rows`. It adds two JS dependencies, one of them with a licence and distribution history Alex would not want in the tree. It also sends the whole file across IPC. And it still has to defer every question that matters to the catalogue (which column a header is, whether `true` is `1`), which is the reason ADR #33 keeps parsing in Rust.
- **Turn the file into JSON text and call `insert_rows` unchanged.** That command has a 10 000-row cap sized for a paste, takes no mapping, and orders keys alphabetically. Bending it to fit would have made the paste worse.
- **Keep the parsed file in backend state between the preview and the import**, keyed by a token. The parse would stay in memory while the dialog sits open, the cached copy goes stale if the file changes, and it adds an eviction rule. Reading the file twice costs one more parse of something the person just picked.
- **Row by row with a report of the failures.** Alex chose all or nothing: a half-imported file is the hardest state to recover from, and the person's fix is to correct the file and import it again.
- **Reuse `ResultFormat` from the export (ADR #138).** Import formats are not export formats. There is no SQL import here, and a CSV's delimiter is a reader option rather than a format. Sharing the enum would add arms that each side has to refuse.

## Context

A user asked to export and import in formats other tools read. The export half is ADR #138 (PR #357). Before this ADR, a SQL table could take rows from a pasted JSON array (`insert_rows`, up to 10 000) or from a whole-connection `.sql` script. MongoDB already had an additive JSON import into a collection (#65). Neither of these covers "the spreadsheet a colleague sent", which is CSV or `.xlsx`, often saved by a Spanish Excel: `;` as the delimiter, Windows-1252 as the encoding, and a decimal comma.

## Consequences

- **`db::import_file`** is pure: bytes in, `Sheet { columns, rows: Vec<Vec<Value>> }` out. The cells are JSON values, so `insert::coerce_value` handles them as it handles a paste.
  - **CSV**: RFC 4180 with a hand-written parser (no `csv` crate). UTF-8 with the BOM stripped, falling back to Windows-1252 through `encoding_rs`, which was already in the tree. The delimiter is `,`, `;` or tab, detected from the header line unless the dialog names one.
  - **JSON**: an array of objects or one object. The columns are the union of the keys, in alphabetical order (serde_json is built without `preserve_order`). A key missing from a row is `NULL`.
  - **Excel**: the first sheet or the one the dialog names, read by **`calamine`, the one new crate**. A whole number is written as `3`, not `3.0`. A date becomes ISO 8601 text.
- **Coercion on import**, on top of the paste's:
  - an empty CSV/Excel cell is `NULL` when "empty is NULL" is on (the default, since that is how the export writes `NULL`);
  - text `true`/`false` going into a boolean column is `1`/`0` (the CSV export writes booleans as words);
  - `3,14` going into a numeric column is `3.14`, but only when the text has exactly one comma and no dot. A numeric column could not take the value as written anyway, so this cannot change a value that would otherwise import.
- **What HuginnDB exports imports back.** CSV `,`/`;` with BOM, the JSON array, and `.xlsx` with integers as numbers all round-trip. The one exception is an Excel cell the export cut at 32 767 characters with ` […]`, which comes back cut. The export already warned about it.
- **Limits**: 200 000 rows per file (`MAX_IMPORT_ROWS`), held in memory. The insert is chunked by the engine's bind ceiling, as the paste is. There is no progress bar or cancel. A bigger file is refused with that number in the message, not half-read.
- **Policy** (ADR #95): `import_table_file` is `insert` in `guard::HUMAN_POLICY`. Its wrapper asks `guard::relation(INSERT)`, then `guard::columns(INSERT, mapped columns)`. `preview_import_file` reads only the file the person picked, like `dump::read_text_file`, and is `none`. Neither is in `app_lock::OPEN_WHILE_LOCKED` (ADR #118). The dialog's locks are advisory (ADR #96): a column the policy withholds starts unmapped and is marked, but the backend is what refuses it.
- **Not offered** on MongoDB (it has `import_collection`) or on a view (ADR #136).
- **Upsert** stays out of scope. If it is added later, it is an `InsertClauses` arm and an `update` verb in the guard, not a second import path.
