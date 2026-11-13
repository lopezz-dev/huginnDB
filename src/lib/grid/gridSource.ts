/**
 * `GridSource` — what a grid's rows are and what may be written through them
 * (ADR #135).
 *
 * Every place that shows rows hands the grid a source: the table browse
 * (`useTableSource`) today, a query's result set (`useQuerySource`) next. A
 * source *decides* — which relation the rows belong to, which columns may be
 * written, how a value is typed on its way to the server — and one controller
 * (`components/grid/useGridController.tsx`) *acts*: it owns the dialogs, the
 * draft row, the reload after a write and the selection report, the same way
 * for every source. What the managed policy allows reaches a producer already
 * resolved (`lib/policy/useRelationPolicy.ts`); no producer reads it itself.
 *
 * Each gesture is a {@link Capability}: **available, with the operations that
 * perform it**, blocked with the sentence that says why, pending, or
 * unsupported. The
 * operations live inside the available branch, so a source cannot claim a
 * gesture it has no way to perform, and a source that never offers one (a
 * query result never inserts) states why instead of stubbing it.
 *
 * Capabilities only shape the interface. The backend's guards run on every
 * write whatever a source claims (ADRs #95–#96, #113): a source that got a
 * lock wrong produces a refused write, never an allowed one.
 *
 * Operations do not reload: the controller decides what to reload after each
 * one, through {@link GridSource.refreshPage} or {@link GridSource.refreshAll}.
 */

import type { CellValue, DraftRow, RowValue } from "@/types";
import type { PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";

/**
 * A gesture's state.
 *
 * - `blocked` — this person cannot do it here *now* (a policy lock, a key the
 *   projection hid): shown disabled with the reason, because the reason is
 *   something they can act on or need to know (ADR #96, #267).
 * - `unsupported` — the relation can never do it, for anyone (a view takes no
 *   rows from the grid): not offered at all, since a disabled control would
 *   only advertise something that does not exist (ADR #136).
 * - `pending` — not decidable yet (the table's Insert while its columns
 *   load): neither offered nor explained, so no reason flashes that the
 *   columns are about to contradict.
 */
export type Capability<Ops> =
  | { state: "available"; ops: Ops }
  | { state: "blocked"; reason: string }
  | { state: "unsupported" }
  | { state: "pending" };

/** A gesture the controller does not perform itself (the caller's chrome
 *  does), so it carries no operations — only whether, and if not why. */
export type Availability = Capability<Record<string, never>>;

export const available = <Ops>(ops: Ops): Capability<Ops> => ({
  state: "available",
  ops,
});
export const blocked = (reason: string): { state: "blocked"; reason: string } => ({
  state: "blocked",
  reason,
});
export const pending: { state: "pending" } = { state: "pending" };
export const unsupported: { state: "unsupported" } = { state: "unsupported" };
/** The availability of a gesture with no operations of its own. */
export const AVAILABLE: Availability = { state: "available", ops: {} };

/** The operations of a capability, or `undefined` when it is not available. */
export function opsOf<Ops>(c: Capability<Ops>): Ops | undefined {
  return c.state === "available" ? c.ops : undefined;
}

/** Why a capability is unavailable — `null` when it is available, pending or
 *  unsupported (the last two are not explained, they are not offered). */
export function reasonOf(c: Capability<unknown>): string | null {
  return c.state === "blocked" ? c.reason : null;
}

/** Why a cell of `column` cannot be written even though the gesture is
 *  available (a policy column limit, an expression), or `null`. */
export type ColumnLock = (column: string) => string | null;

/** The relation rows are deleted from, by their full key. */
export interface DeleteTarget {
  connectionId: string;
  schema: string | undefined;
  table: string;
  /** The relation's primary key, catalog names, catalog order. */
  pkColumns: string[];
}

export interface UpdateOps {
  saveField(
    row: CellValue[],
    path: string[],
    value: string | null,
    typeHint?: string,
  ): Promise<void>;
  /** Omitted when no column is limited, so the grid's per-cell path stays
   *  exactly as it is for everyone else. */
  columnLock?: ColumnLock;
}

export interface DeleteOps {
  /** Where the rows go from — the confirmation names it and checks what
   *  still references them. Carried here, not beside the capability, so a
   *  delete cannot be offered without somewhere to delete from. */
  target: DeleteTarget;
  deleteRows(pkValueRows: CellValue[][]): Promise<void>;
}

/** What commits a draft row, whichever gesture started it. */
export interface DraftCommitOps {
  /** The type to send with a draft cell that carries none of its own. */
  columnType(column: string): string | undefined;
  insertRow(values: RowValue[]): Promise<void>;
  /** Columns of a new row the person may not fill (ADR #113). */
  columnLock?: ColumnLock;
}

export interface InsertOps extends DraftCommitOps {
  newDraft(): DraftRow;
}

export interface DuplicateOps extends DraftCommitOps {
  /** A draft prefilled from a row already hydrated (ADR #133). */
  duplicateDraft(hydratedRow: CellValue[]): DraftRow;
}

export interface PasteOps {
  /** The relation as the confirmation names it (`schema.table`). */
  relationLabel: string;
  /** Work out what a pasted block writes, against hydrated rows (ADR #114). */
  planPaste(paste: GridPaste, hydratedRows: CellValue[][]): PastePlan;
  applyPaste(plan: PastePlan): Promise<{ updated: number; inserted: number }>;
}

export interface FieldUnsetOps {
  /** Remove a field from one document (MongoDB `$unset`). */
  unsetField(row: CellValue[], path: string[]): Promise<void>;
}

export interface FkNavigateOps {
  /** Single-column FK navigation; a no-op for any other column. */
  navigateFk(column: string, value: CellValue): void;
}

export interface GridSource {
  /** Every row carries the relation's full key, so it can be written back
   *  at all — whether the policy then allows it is each capability's say. */
  addressable: boolean;
  /** The key column names as the grid's header shows them. */
  pkResultNames: string[] | undefined;
  /** Rows are documents (MongoDB): the paste dialog words itself that way. */
  documentMode: boolean;

  /** The row's full key tuple, in the relation's key order. Throws when
   *  the row cannot be addressed. */
  keyOf(row: CellValue[]): CellValue[];
  /**
   * Stable identity for selection (ADR #7): the key tuple when the rows are
   * addressable, otherwise whatever read-only identity the source can offer
   * (the table falls back to the whole row). `undefined` when the rows have
   * no identity at all — a query over several tables — which switches the
   * grid's selection off; a function returning `null` for a row only leaves
   * that row out of it.
   */
  getRowKey: ((row: CellValue[]) => string | null) | undefined;
  /** The row with every value the page left on the server loaded back
   *  (ADR #133); the row itself when nothing was left out. */
  hydrate(row: CellValue[]): Promise<CellValue[]>;

  /** Reload the rows on screen — after a write that cannot change how many
   *  there are. Kept apart from `refreshAll` so a cell save's identity (and
   *  the grid's column memo keyed on it) moves only when the page's does. */
  refreshPage(): Promise<void>;
  /** Reload the rows and everything derived from the whole set (a total). */
  refreshAll(): Promise<void>;

  update: Capability<UpdateOps>;
  delete: Capability<DeleteOps>;
  insert: Capability<InsertOps>;
  duplicate: Capability<DuplicateOps>;
  paste: Capability<PasteOps>;
  fieldUnset: Capability<FieldUnsetOps>;
  fkNavigate: Capability<FkNavigateOps>;
  /** Performed by the caller's own chrome (its dialog needs the browse's
   *  filters), so the contract carries only whether it is allowed. */
  bulkUpdate: Availability;
  /** Likewise: the export menu belongs to the caller. */
  export: Availability;
}
