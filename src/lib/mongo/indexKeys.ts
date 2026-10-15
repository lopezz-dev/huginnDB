/**
 * Index-key helpers for the MongoDB index manager.
 *
 * These render and assemble a `key` document's *source text* — they do not
 * parse BSON. That distinction is the same one `lib/mongo/pipeline.ts` draws
 * for stage bodies (ADR #33): Rust owns the only grammar, and anything
 * here that looked like a parser would eventually disagree with it in
 * silence. What this module does is narrower and safe: recognise the handful
 * of key values MongoDB actually accepts (`1`, `-1`, and the type strings)
 * so the dialog can offer a picker, and bail out to raw text for anything
 * else.
 */

/** The key values the structured editor can round-trip through a picker. */
export const KEY_VALUES = [
  "1",
  "-1",
  '"text"',
  '"2dsphere"',
  '"2d"',
  '"hashed"',
] as const;

export type KeyValue = (typeof KEY_VALUES)[number];

export interface KeyRow {
  field: string;
  value: string;
}

/** Whether a key value is one the picker can represent. */
export function isPickableValue(value: string): value is KeyValue {
  return (KEY_VALUES as readonly string[]).includes(value.trim());
}

/**
 * Build the `key` document's source text from the structured rows.
 *
 * Field names are emitted quoted because a Mongo field path is frequently not
 * a bare identifier (`customData.format`, `$**`, a name with a space), and the
 * relaxed parser on the Rust side accepts a quoted key everywhere it accepts a
 * bare one. Blank rows are dropped so a half-filled trailing row — the state
 * the form is in for most of its life — never reaches the server.
 */
export function keyRowsToSource(rows: KeyRow[]): string {
  const entries = rows
    .filter((r) => r.field.trim() !== "")
    .map((r) => `${JSON.stringify(r.field.trim())}: ${r.value.trim()}`);
  return `{ ${entries.join(", ")} }`;
}

/**
 * Try to express an index's stored keys as structured rows.
 *
 * Returns `null` when any value is one the picker can't offer (a `2dsphere`
 * version tuple, a future key type, a number that isn't ±1). The dialog then
 * opens in raw mode with `keysSource` verbatim, which is the whole reason
 * `keysSource` crosses the boundary alongside the parsed `keys`: an index we
 * can't render as a form is still one the user must be able to read and
 * recreate without it being silently rewritten.
 */
export function keysToRows(
  keys: { field: string; value: string }[],
): KeyRow[] | null {
  if (keys.length === 0) return null;
  const rows: KeyRow[] = [];
  for (const key of keys) {
    const value = key.value.trim();
    if (!isPickableValue(value)) return null;
    rows.push({ field: key.field, value });
  }
  return rows;
}
