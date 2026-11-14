---
id: 137
type: adr
status: accepted
date: 2026-11-14
tags: [query, ux, keybindings]
triggered_by_external_trap: false
related: [53, 93, 96, 127, 134, 136]
supersedes: []
superseded_by: null
amends: [135]
---

# ADR #137: a query tab shows one tab per statement, runs what the cursor names, and can be stopped on the server

This is step 2 of ADR #135: the query editor's layout. The results area shows **one tab per statement the run executed**: reads, writes and the one that failed. In a batch, a **Summary** tab comes first. Each tab's body is the shared result grid, a write card or an error card. The summary and the result strip used to be two lists of the same statements, tied together only by `#n`. `Ctrl+Enter` runs **the selection, or the statement under the cursor**, and running the whole buffer gets its own binding. A run can be **stopped**, and stopping it stops the statement on the server, as ADR #134 already does for the AI's reads. A result cut at the row cap says so where it is shown and again where it is exported. Exporting it can either write the rows on screen or run the statement again on the server and stream every row to the file.

**Decision:** keep the editor toolbar above the editor and put a statement strip above each result body (layout A in the design review of 2026-11-14), with the decisions below. Alex took each one on 2026-11-14.

**Alternatives rejected:**

- **One bar at the editor/results seam** (run controls and the statement tabs share a row). This is the most compact layout. It loses because the run controls and the tabs compete for one row's width, which conflicts with keeping every toolbar action visible as an icon. In a split pane the tabs are squeezed out first, and their previews shrink to `SELECT…`.
- **A statement rail to the left of the results.** It scales to a 30-statement script, and the rail doubles as the summary. It loses because it takes ~210 px from the grid, and width is what wide tables lack. A single statement, the commonest run, would carry a one-row rail. The table grid has nothing to its left, so a rail breaks ADR #135's aim that both grids feel the same.
- **Stacked result grids, notebook-style.** `gridSelection` and the docked cell editor are keyed by the tab id (one mounted grid per tab). Stacking would mean re-keying both, for a layout that buries a write's outcome between two grids.
- **Keep the summary and add a collapse.** It keeps two lists of the same statements, and a write or a failure still has no place of its own to be selected.
- **`Ctrl+Enter` keeps running the whole buffer** (as before), or runs the selection and otherwise the whole buffer. A scratch buffer of twenty queries runs all twenty. The AI actions in the same editor already use "selection, else the statement under the cursor" (`statementAt`), so the tab had two rules for one gesture.
- **Stop only in the interface** (stop waiting and ignore the result). That is the failure DECOCER showed (ADR #134): the statement keeps loading the server while the person believes it stopped.
- **Always export a query from the server.** The file would not match the grid it was exported from (rows change, `nextval` advances), and every export would cost the query twice. The server path is offered only where the grid cannot be exported whole: when the result was cut.

## Context

`QueryEditorTab.tsx` grew to ~1 235 lines. The editor, the toolbar, both run paths, the database selector, the history sidebar, the info bar, the result strip, the batch summary, the timer and the DML card all live in one component, which has no tests. ADR #135's step 1 (#329–#340) gave the result grid the table's menu, gestures and locks. Step 2 is the rest of the tab. The inventory taken for this review (session of 2026-11-14) also found defects that a redesign would otherwise carry over:

- re-running a batch from the history sent the `;\n`-joined text down the single-statement path, which Postgres and MySQL refuse;
- "Clear history" cleared every connection's history behind a list that shows one;
- the info bar always said `Ctrl + Enter`, whatever the binding;
- a batch was recorded with `elapsedMs: 0`;
- several strings were not translated;
- a cut result's tooltip blamed the batch budget even for a lone statement's cap;
- exporting a cut result wrote 50 000 rows without a word.

## Consequences

**Layout**

- **Toolbar** (`QueryEditorToolbar`): Run/Stop with a ▾ (statement, selection, all), the timer, Format, Save, History, Explain (AI) and the database selector, all visible as icons. It collapses into a "⋯" menu by width through `lib/grid/toolbarDensity` (its second consumer). The AI action keeps ADR #136's rule: it is not offered on a connection where AI is off.
- **Info bar**: database, `Ln, Col`, the statement count and the driver, with the binding read from the catalogue. "sql · utf-8" is dropped.
- **Split**: 60/40 by default, under a new `autoSaveId`, so a size the person drags is still remembered.

**Results**

- **A pure model** (`lib/query/statementTabs.ts`, replacing `resultPanels.ts`) turns a single result or a `BatchResult` into tabs. Each tab is one of `rows | write | error | summary`, a discriminated union, so a rows tab without a result cannot be built. Each tab carries its statement's line range from `splitSql`, which is what "Go to statement" selects. A statement that returned several sets (SQL Server) gets one tab per set, as before.
- **Initial focus**: the failed statement; else the first rows tab; else Summary.
- **A new run replaces every tab.** Pinning a tab is out of scope.
- **Error card**: the driver's message, the failed statement, *Go to statement* and *Copy error*, with no AI action. An error that is not the query's (switching database, refreshing after a grid write) is a `notify`, not the results area.
- **Batch timing**: `StmtOutcome` gains `elapsed_ms`. The Summary tab shows it per statement, and the history records the batch's total.

**Keybindings** (catalogue, ADR #53, all rebindable, category `query`, scope `editor`)

| Action | Default | What it runs |
| --- | --- | --- |
| `runQuery` | `Mod+Enter` | the selection, else `statementAt` the cursor |
| `runAll` | `Mod+Shift+Enter` | the whole buffer, batched when it holds more than one statement |
| `stopQuery` | `Mod+.` | stops the run in flight |
| `formatQuery` | `Shift+Alt+F` | formats the selection or the buffer, through `sql-formatter` (already a dependency; `lib/grid/formatSql.ts` moves to `lib/sql/`). SQL only: a Mongo tab does not offer it, per ADR #136. |

`Escape` is not used to stop a run: Monaco owns it for suggestions and find. `docs/SHORTCUTS(.es).md` lists all four.

**History**

- The history becomes a dock panel beside Saved queries, filtered by the focused tab's connection (`focusFollowsTab`), with a switch to show every connection.
- Clearing clears what the panel shows, after a confirmation (`confirmIrreversible`). The store gains `clearFor(connectionId)`.
- Running an entry opens it in a query tab that runs it through its own runner (`openQueryTab(…, { run: true })`), so a batch goes down the batch path. Nothing outside the tab calls a run path.

**Stopping** (new command, crosses the layer)

- `execute_query` and `execute_batch` take a `run_id`. A registry in `AppState` maps it to the run's abort handle, and `cancel_query(run_id)` drops the run.
- The statement is stopped where it runs, reusing `commands::query::bounded`'s per-driver stop: `pg_cancel_backend`, `KILL QUERY`, or closing the SQL Server session.
- The session is never returned to the pool. A batch's open transaction is therefore rolled back by the server, and the result says so.
- Writes are stopped too. A person pressing Stop wants the statement to stop, and autocommit rolls it back. Where the outcome cannot be known (the cancel raced the commit), the write card says so rather than claiming either.
- **SQLite** cannot interrupt a statement (ADR #134). Stop frees the tab and the statement finishes on a detached connection, and the card says it may still apply.
- **MongoDB** drops the operation and its cursor, and its server-side stop (`killOp`) is left for the MongoDB card. Nothing in the contract is SQL-specific.
- `guard::HUMAN_POLICY` classifies `cancel_query` (it touches no data). It stays closed behind the app lock like every new command (ADR #119).

**Cut results**

- The rows tab carries the amber mark and a strip: "First 50 000 rows; the query returns more". The toolbar badge stays.
- The export menu splits in two:
  - **The rows shown (N)**: today's `export_query_result`, unchanged.
  - **Everything, from the server…**: a new `export_query_rows(connection_id, sql, format, target?)`. It is offered only for a statement that `db::classify` reads as a read, runs inside the read-only barrier of ADR #93, and streams to the file without the row cap. It applies `guard::export` across the relations, like #337, and `guard::free_sql`.
- The server path needs CSV and JSON writers in Rust (`dump.rs` has only `INSERT`). To stop them drifting from `lib/grid/copyFormats`, one fixture is serialised by both languages in a golden test, which must produce identical bytes.

**MongoDB**

The redesign prepares the place and does no MongoDB work. The statement tabs, the cards, Stop and both exports keep to `QueryResult`, never to SQL text, and a Mongo fixture runs through the model's tests. Editing Mongo results (`row_types` on the ad-hoc path, ADR #29) stays its own card.

**Order of work**

1. Characterization tests for `QueryEditorTab`.
2. The extraction, with no visible change.
3. Each visible change, one PR at a time.

If the 1.40 window tightens, the server export moves first, then Stop.

Undoing any of this needs a new ADR that supersedes this one: one list of statements, the cursor rule, a server-side stop, or the cut result being stated wherever it is exported.
