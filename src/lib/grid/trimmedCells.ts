/**
 * Cells a MongoDB browse left on the server (ADR #133).
 *
 * With `trimLargeValuesKb` set, `fetch_table_data` sends `null` in place of
 * every top-level field larger than the threshold and lists those cells in
 * `QueryResult.trimmed`. Such a row is *incomplete*: shown as it is, a cut
 * cell reads as NULL, and anything that edits, copies or duplicates the row
 * would carry that NULL somewhere it was never true. So the grid shows a cut
 * cell as its type and size, and loads the whole document before any of those
 * actions — `TrimmedRows.hydrate`.
 *
 * This module is the pure half: indexing the cut cells by row and folding a
 * loaded document back into the page.
 */

import { formatBytes } from "@/lib/utils";
import {
  draftTypeFor,
  isOpaqueType,
  typeLabel,
} from "@/lib/grid/documentTree";
import type { BsonTypeTree, CellValue, QueryResult } from "@/types";

/** One cut cell, as the grid needs it. */
export interface TrimmedInfo {
  /** BSON size on the server, in bytes. */
  bytes: number;
  /** BSON type name, as `row_types` labels it (`"array"`, `"document"`, …). */
  type: string;
}

/** The cut cells of one row, by column name. */
export type RowCuts = ReadonlyMap<string, TrimmedInfo>;

/** What the grid is handed when its page may hold cut cells. */
export interface TrimmedRows {
  /** The cut cells of `row`, or `undefined` when the row is whole. */
  of(row: CellValue[]): RowCuts | undefined;
  /**
   * `row` with every cut cell loaded: a new array that has replaced `row` in
   * the page, or `row` itself when nothing in it was cut. Rejects (after
   * telling the user) when the document cannot be read back — deleted since
   * the page loaded, or the server gone.
   */
  hydrate(row: CellValue[]): Promise<CellValue[]>;
  /**
   * When `column` of `row` is a cut value that loading would not reveal — a
   * `Binary` reaches the grid only as `Binary(Generic, N bytes)`, the same
   * thing its label already says — tell the user so and return `true`. The
   * caller then opens nothing: downloading megabytes to show a summary the
   * page already has is the cost this whole mechanism exists to avoid.
   */
  explainUnloadable(row: CellValue[], column: string): boolean;
}

/** Whether loading `info`'s value would show nothing its label does not. */
export function isUnloadable(info: TrimmedInfo): boolean {
  return isOpaqueType(info.type);
}

/**
 * Index `result.trimmed` by row array. Keyed by the arrays themselves (ADR #7)
 * so a lookup survives the grid's client-side reordering; a `WeakMap` so a
 * page that is replaced takes its index with it.
 */
export function indexTrimmed(
  result: QueryResult | null,
): WeakMap<CellValue[], RowCuts> {
  const index = new WeakMap<CellValue[], RowCuts>();
  if (!result?.trimmed) return index;
  const byRow = new Map<number, Map<string, TrimmedInfo>>();
  for (const cut of result.trimmed) {
    const column = result.columns[cut.column]?.name;
    if (column === undefined) continue;
    const type = result.row_types?.[cut.row]?.[cut.column];
    const cuts = byRow.get(cut.row) ?? new Map<string, TrimmedInfo>();
    cuts.set(column, {
      bytes: cut.bytes,
      type: typeof type === "string" ? type : "mixed",
    });
    byRow.set(cut.row, cuts);
  }
  for (const [row, cuts] of byRow) {
    const values = result.rows[row];
    if (values) index.set(values, cuts);
  }
  return index;
}

/**
 * `page` with row `index` replaced by the document in `loaded` (a one-row
 * `fetch_table_data` result, read without trimming).
 *
 * The loaded row is laid out on the page's columns, by name: a field the
 * document no longer has becomes `null`, as a missing field is anywhere else
 * on the page, and a field the page has no column for is left out. The row's
 * cut cells are dropped from `trimmed`; every other row keeps its arrays, so
 * nothing else re-renders or loses its identity.
 */
export function mergeLoadedRow(
  page: QueryResult,
  index: number,
  loaded: QueryResult,
): QueryResult {
  const source = new Map(loaded.columns.map((c, i) => [c.name, i]));
  const values = loaded.rows[0] ?? [];
  const types = loaded.row_types?.[0];
  const row: CellValue[] = page.columns.map((c) => {
    const i = source.get(c.name);
    return i === undefined ? null : (values[i] ?? null);
  });
  const rowTypes: BsonTypeTree[] = page.columns.map((c) => {
    const i = source.get(c.name);
    return i === undefined || !types ? "null" : (types[i] ?? "null");
  });
  const rows = page.rows.slice();
  rows[index] = row;
  let row_types = page.row_types;
  if (row_types) {
    row_types = row_types.slice();
    row_types[index] = rowTypes;
  }
  const trimmed = page.trimmed?.filter((c) => c.row !== index);
  return {
    ...page,
    rows,
    row_types,
    trimmed: trimmed && trimmed.length > 0 ? trimmed : undefined,
  };
}

/** How a cut cell reads in the grid: `Array · 1.4 MB`. */
export function describeTrimmed(info: TrimmedInfo): string {
  return `${typeLabel(draftTypeFor(info.type))} · ${formatBytes(info.bytes)}`;
}
