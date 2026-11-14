/**
 * Which catalog facts a grid reads by column name (ADR #135): its source's
 * (`GridSource.columnCatalog`, which maps a query's aliases onto their table
 * columns) when it has one; otherwise the draft row's columns, which on a
 * table carry the same names. A grid with neither — a preview with no
 * relation — has no facts to show.
 */

import type { ColumnInfo } from "@/types";

export function resolveColumnCatalog(
  catalog: ReadonlyMap<string, ColumnInfo> | undefined,
  draftColumns: readonly ColumnInfo[] | undefined,
): ReadonlyMap<string, ColumnInfo> {
  if (catalog) return catalog;
  return new Map((draftColumns ?? []).map((c) => [c.name, c]));
}
