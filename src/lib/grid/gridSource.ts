/**
 * `GridSource` — what a grid's rows are and what may be written through them
 * (ADR #135).
 *
 * Every place that shows rows hands the grid a source: the table browse
 * (`useTableSource`) today, a query's result set (`useQuerySource`) next. A
 * source *decides* — which relation the rows belong to, which columns may be
 * written, what the policy allows, how a value is typed on its way to the
 * server — and one controller (`components/grid/useGridController.tsx`)
 * *acts*: it owns the dialogs, the draft row, the refresh after a write and
 * the selection report, the same way for every source.
 *
 * Two rules the shape encodes:
 *
 * - **A capability is `null` when available, or the sentence that says why
 *   not.** The interface shows an unavailable gesture disabled with that
 *   reason rather than missing (the #267 choice for Insert, generalised).
 *   Some gestures are still *omitted* by the grid when unavailable — that is
 *   the grid's presentation, unchanged by this contract.
 * - **Capabilities only shape the interface.** The backend's guards run on
 *   every write whatever a source claims (ADRs #95–#96, #113), so a source
 *   that got a lock wrong produces a refused write, never an allowed one.
 *
 * Operations do not refresh: the controller decides what to reload after
 * each one, through {@link GridSource.refreshPage} or
 * {@link GridSource.refreshAll}.
 */

import type { CellValue, DraftRow, RowValue } from "@/types";
import type { PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";

/**
 * `null` = available; a string = the reason it is not. The empty string is
 * "not available, and nothing worth saying yet" — the table's Insert while its
 * columns are still loading, which must neither be offered nor flash a reason
 * that the columns are about to contradict.
 */
export type Unavailable = string | null;

/** The relation a source's rows belong to — present only when every row
 *  carries its full key, so an UPDATE/DELETE can address it unambiguously. */
export interface GridSourceIdentity {
  connectionId: string;
  schema: string | undefined;
  table: string;
  /** The relation's primary key, catalog names, catalog order. */
  pkColumns: string[];
}

export interface GridSourceCapabilities {
  /** Saving a cell or a list-view field. */
  update: Unavailable;
  delete: Unavailable;
  /** Starting a new row in the grid. */
  insert: Unavailable;
  /** Starting a new row from an existing one. */
  duplicate: Unavailable;
  /** Pasting a block that writes cells (and may add rows). */
  paste: Unavailable;
  bulkUpdate: Unavailable;
  export: Unavailable;
  /** Removing a field from one document (MongoDB `$unset`). */
  fieldUnset: Unavailable;
  /**
   * Per result column, why a cell cannot be saved even though `update` is
   * available (a policy column limit, an expression); `undefined` when no
   * column is limited, so the grid's per-cell path stays untouched.
   */
  updateColumnLock: ((column: string) => string | null) | undefined;
  /** The same for the columns of a new row. */
  insertColumnLock: ((column: string) => string | null) | undefined;
}

export interface GridSource {
  /** `null` when the rows cannot be written back at all. */
  identity: GridSourceIdentity | null;
  can: GridSourceCapabilities;
  /** The key column names as the grid's header shows them. */
  pkResultNames: string[] | undefined;
  /** Rows are documents (MongoDB): the paste dialog words itself that way. */
  documentMode: boolean;

  /** The row's full key tuple, parallel to `identity.pkColumns`. Throws when
   *  the row cannot be addressed. */
  keyOf(row: CellValue[]): CellValue[];
  /**
   * Stable identity for selection (ADR #7). The key tuple when the rows are
   * addressable; otherwise whatever read-only identity the source can offer
   * (`null` for none, which switches selection off).
   */
  getRowKey(row: CellValue[]): string | null;
  /** The row with every value the page left on the server loaded back
   *  (ADR #133); the row itself when nothing was left out. */
  hydrate(row: CellValue[]): Promise<CellValue[]>;

  saveField(
    row: CellValue[],
    path: string[],
    value: string | null,
    typeHint?: string,
  ): Promise<void>;
  unsetField(row: CellValue[], path: string[]): Promise<void>;
  deleteRows(pkValueRows: CellValue[][]): Promise<void>;
  /** Work out what a pasted block writes, against hydrated rows (ADR #114). */
  planPaste(paste: GridPaste, hydratedRows: CellValue[][]): PastePlan;
  applyPaste(plan: PastePlan): Promise<{ updated: number; inserted: number }>;
  /** An empty draft, or `null` when the columns are not known yet. */
  newDraft(): DraftRow | null;
  /** A draft prefilled from a hydrated row. */
  duplicateDraft(hydratedRow: CellValue[]): DraftRow | null;
  /** The type to send with a draft cell that carries none of its own. */
  columnType(column: string): string | undefined;
  insertRow(values: RowValue[]): Promise<void>;
  /** Reload the rows on screen — after a write that cannot change how many
   *  there are. Kept apart from `refreshAll` so a cell save's identity (and
   *  the grid's column memo keyed on it) moves only when the page's does. */
  refreshPage(): Promise<void>;
  /** Reload the rows and everything derived from the whole set (a total). */
  refreshAll(): Promise<void>;
  /** Single-column FK navigation; a no-op for any other column. */
  navigateFk(column: string, value: CellValue): void;
}
