---
id: 114
type: adr
status: accepted
date: 2026-10-25
tags: [grid, ux]
triggered_by_external_trap: false
related: [84, 95, 112, 113]
supersedes: []
superseded_by: null
amends: []
---

# ADR #114: a pasted block is planned in the grid, confirmed, and written by the backend in one transaction

Ctrl+V in the grid used to paste the clipboard into one cell as text, so a block copied from a spreadsheet arrived as one long string. A block now lands with its top-left cell on the active cell, spreads right across the columns in the order they are shown and down across the rows in the order they are shown, and its overflow below the last row becomes new rows. The grid works out the whole plan — what it changes, what it adds, what it leaves out and why — shows it, and only then sends it. The backend writes the plan in one transaction, so a paste lands whole or not at all.

**Decision:** `lib/grid/pasteBlock.ts` reads the clipboard as spreadsheet TSV (quoted cells, `""`, one trailing line break). A text with no tab and no second line keeps the one-cell paste exactly as it was. `lib/grid/pastePlan.ts::planPaste` turns block + visible rows + visible columns + catalogue + locks into cell writes addressed by each row's full key, new rows, and the cells left out, per column and reason: a primary-key column, a column the policy locks (ADR #113), a generated key on a new row. A value equal to the cell's own is not sent. An empty cell is NULL where the column allows it, and is left out of a new row. `PasteCellsDialog` confirms. `commands::paste::apply_paste` guards per verb and per column in the wrapper (ADR #95), rebuilds each statement with the single-write builders (`update_cell_statement`, `build_insert_statement`), and runs them through `db::exec::execute_params_in_tx_at_most_one`, which rolls the list back if any statement touches more than one row. On MongoDB the writes run in a session transaction where the deployment has them (replica set, `mongos`, detected with `hello`), and in order with a stop at the first failure where it does not — which the dialog says before the paste is applied.

**Alternatives rejected:**

- **Cell by cell through `update_cell`** — rejected because a failure halfway (a type the server refuses, a constraint) leaves a paste half-applied, a table state nobody typed. The plan is checked by the backend in one transaction instead.
- **Refusing the whole paste when one cell cannot be written** — rejected because the common case is a block pasted over a key column or a column the role may not change, where the person still wants the rest. The dialog names what is left out and asks.
- **Applying the allowed part without asking** — rejected: a block can touch hundreds of cells, and the cells left out are exactly what someone needs to know before the write, not after.
- **Rewriting a primary key from the block** — rejected because each write addresses its row by that key; changing it within the same paste would move a row out from under the address of the next write to it.
- **Overflow refused or truncated** — the person asked for new rows (a block taller than the rows below the anchor is how a list from a spreadsheet gets added). New rows use the same insert the draft row uses, leave empty cells and generated keys to the database, and are guarded by `columns.insert`.
- **Exposing it to the AI** — rejected, like `insert_rows` (ADR #84): it answers a person's clipboard, and the MCP connector already has `run_writes` (ADR #112).

## Context

The policy's column limits (ADR #113) were designed with a mockup in which a paste over locked columns offered "paste only the allowed cells". The grid had no multi-cell paste at all, so it was built as its own change, stacked on the column limits.

## Consequences

- **`update_cell_statement` is shared.** `update_cell` and the paste build the same `UPDATE` (quoting, placeholder numbering, MySQL `BIT` cast, SQL Server binary `CONVERT`). A change to how one cell is written changes both, which is the point.
- **`execute_params_in_tx` now goes through `execute_params_in_tx_checked`.** The at-most-one-row check lives there; `insert_rows` keeps its unchecked behaviour.
- **One paste carries at most `MAX_PASTE_WRITES` (5 000) writes.** That guards against a clipboard far bigger than anyone meant to paste; a transaction that size holds its locks for as long as it runs.
- **The anchor and the columns are what is on screen.** Hidden columns are skipped, and the visible order decides where each pasted column goes. A projection or a sort changes where a block lands, as it changes what the person sees.
- **MongoDB's promise depends on the server.** `PasteSummary.atomic` reports what happened, and the dialog warns in advance on a MongoDB tab. It does not ask the server, because the warning has to be true before any write.
