/** SQL column-type classification helpers, shared by the data grid. */

import type { ColumnInfo } from "@/types";

/**
 * Return `true` if the SQL data-type string represents a numeric type.
 *
 * Matches the normalised type names produced by all three drivers:
 * - Postgres: `integer`, `bigint`, `numeric`, `real`, `double precision`, etc.
 * - MySQL: `int(11)`, `float`, `decimal(10,2)`, etc.
 * - SQLite: `INT`, `REAL`, `NUMERIC`, etc. (case-insensitive affinity names).
 * - MongoDB: `int`, `long` (int64), `double`, `decimal128` (see
 *   `bson_type_name`).
 *
 * @param dataType - The `data_type` string from `ColumnMeta`.
 */
export function isNumericType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return (
    // "point"/"multipoint" (MySQL spatial types) contain the substring
    // "int" by accident — exclude them so those columns don't lose
    // text-match operators to a false numeric classification.
    (t.includes("int") && !t.includes("point")) ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("money") ||
    t.includes("serial") ||
    t === "long" ||
    t === "number"
  );
}

/**
 * True for MySQL `BIT` / `BIT(n)` columns. The backend ships BIT values as
 * numbers (see `mysql_value`), so the grid needs the column type to decide
 * whether to apply the user's BIT rendering preference.
 */
export function isBitType(dataType: string): boolean {
  return /^bit\b/i.test(dataType.trim());
}

/**
 * True for a boolean-ish column type: Postgres/MongoDB `boolean`/`bool`, or
 * MySQL's `BOOLEAN` display name for `TINYINT(1)` (see the MySQL boolean
 * decode note in `CLAUDE.md`).
 */
export function isBooleanType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return t === "bool" || t === "boolean";
}

/**
 * A predictable initial column width (px), based on the SQL type alone.
 * Boolean, numeric, date/time and UUID columns render a bounded range of
 * characters, so they can be sized up front instead of starting at the
 * grid's generic default — which exists for free-text columns, where the
 * content length genuinely isn't predictable from the type. Returns `null`
 * for anything else (text/varchar/char, json, blob, …), so the caller falls
 * back to its own default for those.
 */
export function defaultColumnWidth(dataType: string): number | null {
  const t = dataType.toLowerCase();
  if (isBitType(dataType) || isBooleanType(dataType)) return 70;
  if (t === "uuid" || t === "uniqueidentifier" || t === "objectid") return 260;
  // Check the combined forms before the plain "date"/"time" substrings they
  // both contain, or e.g. "timestamptz" would be misclassified as "date".
  if (t.includes("timestamp") || t.includes("datetime")) return 170;
  if (t === "date") return 130;
  if (t === "time" || t.includes("time")) return 110;
  if (t === "year") return 70;
  if (isNumericType(dataType)) return 100;
  return null;
}

/**
 * Render a numeric BIT value per the grid's `bitDisplay` preference.
 * In `true_false` mode, 0/1 become `false`/`true`; any wider BIT(n) value
 * falls back to its integer form. `zero_one` always shows the raw number.
 */
export function formatBitValue(
  value: number,
  mode: "true_false" | "zero_one",
): string {
  if (mode === "true_false") {
    if (value === 0) return "false";
    if (value === 1) return "true";
  }
  return String(value);
}

/**
 * Normalise any accepted representation of a BIT value to `"0"` / `"1"` /
 * `""` (empty means null). Shared by `BitInput` (its `<select>`'s own
 * mount-time reconciliation) and the grid's Ctrl+V paste handler, which has
 * no `<select>` to defer to and must decide the committed value itself.
 * Trimmed so pasted clipboard text with trailing whitespace/newlines still
 * matches.
 */
export function normalizeBitValue(value: string | null | undefined): "0" | "1" | "" {
  if (value === null || value === undefined) return "";
  const v = value.trim();
  if (v === "1" || v.toLowerCase() === "true") return "1";
  if (v === "0" || v.toLowerCase() === "false") return "0";
  return v === "" ? "" : "1";
}

/**
 * Whether the database generates this column's value on insert, so the draft
 * shows an "auto" placeholder instead of a control, and a pasted block leaves
 * it alone.
 *
 * Deliberately conservative: only an integer-ish primary key. A `uuid` or
 * `varchar` PK may well have no default, and hiding its input would make the
 * row impossible to insert.
 */
export function isAutoPkColumn(info?: ColumnInfo): boolean {
  return !!info?.is_primary_key && /int|serial|rowid/i.test(info.data_type);
}
