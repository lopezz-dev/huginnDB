/**
 * What a block pasted into the grid will write (ADR #114) — worked out before
 * anything is sent, so the confirmation can say it and the backend is handed
 * only writes it can apply.
 *
 * The block lands with its top-left cell on the anchor (the active or selected
 * cell) and spreads right across the columns in the order they are shown and
 * down across the rows in the order they are shown. Rows of the block below
 * the last row on screen become new rows. A cell that cannot be written is
 * left out and counted, with its reason: a primary key (rewriting it would
 * move the row out from under its own address), a column the policy locks
 * (ADR #113), a database-generated key on a new row. A value equal to what the
 * cell already holds is not sent at all.
 *
 * Pure: the grid's rows and columns, the catalogue and the locks go in; a
 * plan comes out. `TableDataTab` asks for it and `PasteCellsDialog` shows it.
 */

import { isAutoPkColumn, normalizeBitValue } from "@/lib/grid/columnKinds";
import { formatValue } from "@/lib/grid/formatValue";
import type { CellValue, ColumnInfo, ColumnMeta, RowValue } from "@/types";

export interface PastePlanInput {
  block: string[][];
  /** The rows on screen from the anchor's row down, as the grid holds them
   *  (values in backend column order). */
  rows: CellValue[][];
  /** The columns on screen from the anchor's column rightwards, in the order
   *  they are shown. */
  columns: ColumnMeta[];
  /** Backend index of each column in a row's values. */
  columnIndexByName: ReadonlyMap<string, number>;
  /** The table's full primary key. */
  pkColumns: string[];
  /** Catalogue facts per column (nullability, key, type), when known. */
  columnInfo: ReadonlyMap<string, ColumnInfo>;
  /** MySQL `BIT` columns, whose text the backend expects as `0`/`1`. */
  bitColumns: ReadonlySet<string>;
  /** Whether existing rows may be changed at all, and new ones added. */
  canUpdate: boolean;
  canInsert: boolean;
  /** Why the policy will not let a column be changed, or given a value on a
   *  new row (ADR #113) — `null` when it may. */
  updateLock?: (column: string) => string | null;
  insertLock?: (column: string) => string | null;
}

/** Why a pasted cell is left out. */
export type SkipReason = "key" | "policy" | "generated" | "noUpdate" | "noInsert";

export interface PasteCellWrite {
  pkValues: CellValue[];
  column: string;
  value: string | null;
  columnType?: string;
}

/** One cell of the preview, as the dialog draws it. */
export interface PreviewCell {
  text: string;
  state: "write" | "same" | "skip" | "new";
}

export interface PastePlan {
  updates: PasteCellWrite[];
  inserts: RowValue[][];
  /** The cells left out, per column and reason. */
  skipped: { column: string; reason: SkipReason; count: number }[];
  /** Cells whose pasted value is the one already there. */
  unchanged: number;
  /** Existing rows that get at least one write. */
  rowsChanged: number;
  /** Block columns past the grid's last column, which have nowhere to go. */
  droppedColumns: number;
  /** NOT NULL columns, neither generated nor in the block, that the new rows
   *  leave empty: those rows fail unless the column has a default. */
  missingOnInsert: string[];
  /** How many rows the block has; the preview shows the first few. */
  blockRows: number;
  /** The first rows of the block, cell by cell, for the confirmation. */
  preview: PreviewCell[][];
  previewColumns: string[];
}

/** How many of the block's rows the confirmation shows. */
export const PREVIEW_ROWS = 5;

export function planPaste(input: PastePlanInput): PastePlan {
  const {
    block,
    rows,
    columns,
    columnIndexByName,
    pkColumns,
    columnInfo,
    bitColumns,
    canUpdate,
    canInsert,
    updateLock,
    insertLock,
  } = input;
  const width = Math.max(0, ...block.map((r) => r.length));
  const targets = columns.slice(0, width);
  const pkSet = new Set(pkColumns);
  const skipped = new Map<string, { column: string; reason: SkipReason; count: number }>();
  const skip = (column: string, reason: SkipReason) => {
    const key = `${column}\u0000${reason}`;
    const entry = skipped.get(key) ?? { column, reason, count: 0 };
    entry.count += 1;
    skipped.set(key, entry);
  };
  const typeOf = (column: string) =>
    columnInfo.get(column)?.data_type ?? columns.find((c) => c.name === column)?.data_type;
  // The text a pasted cell becomes: an empty cell is NULL where NULL is
  // allowed (or unknown), and an empty string where it is not; a BIT takes
  // the backend's `0`/`1`.
  const valueOf = (column: string, text: string): string | null => {
    if (bitColumns.has(column)) {
      const bit = normalizeBitValue(text);
      return bit === "" ? null : bit;
    }
    if (text === "") return columnInfo.get(column)?.nullable === false ? "" : null;
    return text;
  };

  const updates: PasteCellWrite[] = [];
  const inserts: RowValue[][] = [];
  const preview: PreviewCell[][] = [];
  let unchanged = 0;
  let rowsChanged = 0;

  block.forEach((cells, r) => {
    const existing = rows[r];
    const previewRow: PreviewCell[] = [];
    if (existing) {
      let changed = false;
      targets.forEach((col, c) => {
        if (c >= cells.length) return;
        const text = cells[c];
        let state: PreviewCell["state"] = "write";
        if (pkSet.has(col.name)) {
          skip(col.name, "key");
          state = "skip";
        } else if (!canUpdate) {
          skip(col.name, "noUpdate");
          state = "skip";
        } else if (updateLock?.(col.name)) {
          skip(col.name, "policy");
          state = "skip";
        } else {
          const value = valueOf(col.name, text);
          const cur = existing[columnIndexByName.get(col.name) ?? -1];
          const before = cur === null || cur === undefined ? null : formatValue(cur);
          if (value === before) {
            unchanged += 1;
            state = "same";
          } else {
            updates.push({
              pkValues: pkColumns.map((k) => existing[columnIndexByName.get(k) ?? -1] ?? null),
              column: col.name,
              value,
              columnType: typeOf(col.name),
            });
            changed = true;
          }
        }
        previewRow.push({ text, state });
      });
      if (changed) rowsChanged += 1;
    } else {
      const values: RowValue[] = [];
      targets.forEach((col, c) => {
        if (c >= cells.length) return;
        const text = cells[c];
        let state: PreviewCell["state"] = "new";
        if (!canInsert) {
          skip(col.name, "noInsert");
          state = "skip";
        } else if (isAutoPkColumn(columnInfo.get(col.name))) {
          skip(col.name, "generated");
          state = "skip";
        } else if (insertLock?.(col.name)) {
          skip(col.name, "policy");
          state = "skip";
        } else if (text !== "") {
          // An empty cell on a new row is left out: the column takes its
          // default, as an untouched cell of the draft row does.
          values.push({ column: col.name, value: valueOf(col.name, text), columnType: typeOf(col.name) });
        }
        previewRow.push({ text, state });
      });
      if (values.length > 0) inserts.push(values);
    }
    if (r < PREVIEW_ROWS) preview.push(previewRow);
  });

  // What new rows leave empty that the table will not accept empty.
  const given = new Set(inserts.flatMap((row) => row.map((v) => v.column)));
  const missingOnInsert =
    inserts.length === 0
      ? []
      : [...columnInfo.values()]
          .filter((info) => !info.nullable && !isAutoPkColumn(info) && !given.has(info.name))
          .map((info) => info.name);

  return {
    updates,
    inserts,
    skipped: [...skipped.values()],
    unchanged,
    rowsChanged,
    droppedColumns: Math.max(0, width - columns.length),
    missingOnInsert,
    blockRows: block.length,
    preview,
    previewColumns: targets.map((c) => c.name),
  };
}
