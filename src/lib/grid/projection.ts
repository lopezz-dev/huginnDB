/**
 * The query panel's projection, between what the user chose and what goes on
 * the wire.
 *
 * The two differ by the key. The grid addresses every edit by the row's
 * primary key (a document by its `_id` — ADR #7), so a browse that dropped
 * it would render rows nobody could write to, and would do it silently. The
 * user's choice is stored as they made it; the key columns are added here, at
 * the last moment, so the panel can show them as locked instead of pretending
 * they were picked.
 *
 * - **SQL** sends an inclusion list, the table's key columns first. An
 *   exclusion is meaningless there (no dialect has `SELECT * EXCEPT`) and the
 *   backend rejects one, so a stray one is dropped rather than sent.
 * - **MongoDB** includes `_id` by default in an inclusion, so an inclusion goes
 *   as chosen; an exclusion never names `_id`.
 */

import type { Projection } from "@/types";

/** The key MongoDB always addresses a document by. */
export const DOCUMENT_ID = "_id";

/** True when `p` narrows anything — the one test for "is a projection on". */
export function isNarrowing(p: Projection | undefined): p is Projection {
  return !!p && p.fields.length > 0;
}

/**
 * What the browse (and the export) sends for the user's projection `p`, or
 * `undefined` for every field.
 */
export function wireProjection(
  p: Projection | undefined,
  opts: { document: boolean; keyColumns: readonly string[] },
): Projection | undefined {
  if (!isNarrowing(p)) return undefined;
  const fields = Array.from(new Set(p.fields));
  if (opts.document) {
    if (p.exclude) {
      const kept = fields.filter((f) => f !== DOCUMENT_ID);
      return kept.length ? { fields: kept, exclude: true } : undefined;
    }
    return { fields, exclude: false };
  }
  if (p.exclude) return undefined;
  const keys = opts.keyColumns.filter((k) => !fields.includes(k));
  return { fields: [...keys, ...fields], exclude: false };
}

/** Whether `field` is locked in the panel: always returned, never removable. */
export function isLockedField(
  field: string,
  opts: { document: boolean; keyColumns: readonly string[]; exclude: boolean },
): boolean {
  if (opts.document) return field === DOCUMENT_ID;
  return !opts.exclude && opts.keyColumns.includes(field);
}
