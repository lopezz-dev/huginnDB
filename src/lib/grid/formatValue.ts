/**
 * A cell value's plain-string projection.
 *
 * The one place a `CellValue` becomes text for anything that is not a typed
 * write: rendering it in the grid, matching it against the client-side search,
 * and serialising it into a clipboard payload that has no JSON of its own.
 * `null`/`undefined` collapse to the empty string rather than the word "null",
 * because the grid renders its own NULL affordance and a search for "null"
 * should not match every empty cell.
 *
 * It existed twice, byte for byte: as `DataGrid`'s `formatValue` ("for display
 * and search") and as `copyFormats`'s `plain` ("for serialising to
 * JSON-incompatible payloads"). Two framings of one function, which is why the
 * doc above covers both.
 */

import type { CellValue, GridPrefs } from "@/types";
import { formatBitValue } from "@/lib/grid/columnKinds";

export function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The text a grid cell shows for `v`, before the length cap.
 *
 * The BIT branch is the whole reason this exists as a function: a MySQL `BIT`
 * arrives as a number and renders through the user's `bitDisplay` preference,
 * and the rule was written out twice — once in the `cell` renderer and once in
 * the auto-fit measurement that has to reproduce it exactly. A column measured
 * as `1` and painted as `true` is fitted two characters too narrow.
 *
 * `null` is the caller's business: the renderer paints its own italic NULL
 * affordance, so it never asks; the measurement passes `nullDisplay` in.
 */
export function rawCellText(
  v: CellValue,
  isBit: boolean,
  bitDisplay: GridPrefs["bitDisplay"],
): string {
  return isBit && typeof v === "number"
    ? formatBitValue(v, bitDisplay)
    : formatValue(v);
}

/**
 * Apply the grid's `truncateLongTextAt` cap, which keeps a multi-megabyte cell
 * from bloating the DOM (the full value stays reachable through the preview
 * panel and the editor). `<= 0` disables the cap.
 */
export function truncateForDisplay(text: string, at: number): string {
  return at > 0 && text.length > at ? `${text.slice(0, at)}…` : text;
}

/**
 * What a grid cell paints for `v`: `truncateForDisplay(rawCellText(…), at)`,
 * character for character, without building the whole text first.
 *
 * The composition it replaces serialised the entire value and then kept 200
 * characters of it, on every render of every visible cell. A MongoDB document
 * holding a 1.5 MB prompt inside an array made that 1.5 MB of `JSON.stringify`
 * per paint, for text nobody would see. Here an object stops being serialised
 * one character past the cap, which is all `truncateForDisplay` needs to decide
 * whether to add the ellipsis.
 */
export function cellDisplayText(
  v: CellValue,
  isBit: boolean,
  bitDisplay: GridPrefs["bitDisplay"],
  at: number,
): string {
  if (at <= 0 || typeof v !== "object" || v === null) {
    return truncateForDisplay(rawCellText(v, isBit, bitDisplay), at);
  }
  return truncateForDisplay(jsonPrefix(v, at + 1), at);
}

/** Signals that the prefix is full; never escapes `jsonPrefix`. */
const FULL = Symbol("full");

/**
 * The first `limit` characters of `JSON.stringify(value)`, or all of it when
 * it is shorter. `value` is what `fetch_table_data` sends: plain JSON (no
 * `toJSON`, no cycles), so `JSON.stringify`'s rules are followed only as far
 * as plain JSON reaches them.
 */
export function jsonPrefix(value: object, limit: number): string {
  let out = "";
  const push = (s: string) => {
    out += s;
    if (out.length >= limit) throw FULL;
  };
  const write = (x: unknown): void => {
    if (typeof x === "string") {
      // Escaping only ever lengthens a string, so `limit - out.length + 1`
      // source characters produce at least as many output characters as the
      // prefix still needs. A cut between the two halves of a surrogate pair
      // would serialise the lone half as an escape the whole string never
      // contains, so the cut steps back over it.
      const room = limit - out.length + 1;
      if (x.length <= room) return push(JSON.stringify(x));
      let cut = x.slice(0, room);
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
      return push(JSON.stringify(cut).slice(0, -1));
    }
    if (x === null || typeof x !== "object") {
      // Numbers (NaN and Infinity become `null`), booleans, null.
      return push(JSON.stringify(x) ?? "null");
    }
    if (Array.isArray(x)) {
      push("[");
      x.forEach((item, i) => {
        if (i > 0) push(",");
        // An array keeps a slot for `undefined`; an object drops the key.
        write(item === undefined ? null : item);
      });
      return push("]");
    }
    push("{");
    let first = true;
    for (const key of Object.keys(x)) {
      const item = (x as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (!first) push(",");
      first = false;
      push(`${JSON.stringify(key)}:`);
      write(item);
    }
    push("}");
  };
  try {
    write(value);
  } catch (e) {
    if (e !== FULL) throw e;
  }
  return out.slice(0, limit);
}
