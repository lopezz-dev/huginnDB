/**
 * The import dialog's column mapping (ADR #139), kept pure so the rule that
 * decides it is tested apart from the dialog.
 *
 * A mapping is, per table column, the index of the file column that fills it
 * or `null` for "not imported" — an unmapped column is left out of the
 * `INSERT` and takes its default. The backend re-checks every part of it
 * against the catalogue and the file (`commands::import::resolve_mapping`);
 * this only proposes and carries what the person chose.
 */

import { columnAllowed } from "@/lib/policy/glob";
import type { ImportColumnSource } from "@/types";

/** Table column name → file column index, or `null` for not imported. */
export type ImportMapping = Record<string, number | null>;

/**
 * The mapping the dialog opens with: each table column takes the first file
 * column of the same name, ignoring case and surrounding blanks — the rule
 * the paste uses for JSON keys. A column the policy does not let this person
 * insert into (`insertLimit`, ADR #113) starts unmapped, so the default never
 * proposes an import the backend would refuse; the person can still map it
 * and hear the refusal, since the dialog's locks are advisory (ADR #96).
 */
export function defaultMapping(
  tableColumns: readonly string[],
  fileColumns: readonly string[],
  insertLimit: string[] | null = null,
): ImportMapping {
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, number>();
  fileColumns.forEach((name, i) => {
    const key = norm(name);
    if (!byName.has(key)) byName.set(key, i);
  });
  const out: ImportMapping = {};
  for (const column of tableColumns) {
    const hit = byName.get(norm(column));
    out[column] =
      hit !== undefined && columnAllowed(insertLimit, column) ? hit : null;
  }
  return out;
}

/** The mapped columns as the command takes them, in table order. */
export function toColumnSources(
  tableColumns: readonly string[],
  mapping: ImportMapping,
): ImportColumnSource[] {
  return tableColumns.flatMap((column) => {
    const source = mapping[column];
    return source === null || source === undefined ? [] : [{ column, source }];
  });
}

/**
 * Keep what the person chose when the file is read again (another delimiter,
 * sheet or header setting): a choice still in range survives, one past the
 * new column count falls back to the default for that column.
 */
export function carryMapping(
  previous: ImportMapping | null,
  fresh: ImportMapping,
  fileColumnCount: number,
): ImportMapping {
  if (!previous) return fresh;
  const out: ImportMapping = {};
  for (const column of Object.keys(fresh)) {
    const was = previous[column];
    out[column] =
      was === undefined || (was !== null && was >= fileColumnCount)
        ? fresh[column]
        : was;
  }
  return out;
}

/** One preview cell as text: `NULL` for a null, JSON for an object. */
export function previewCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
