/**
 * Pure helpers behind the data grid's **list view** (`DocumentListView`), the
 * MongoDB-Compass-style rendering where a row is a document and every field is
 * one `key : value` line that can be folded, edited and typed individually.
 *
 * Everything here is deliberately free of React and of Tauri: given a row's
 * values, the (optional) BSON type trees the backend shipped alongside them
 * (`QueryResult.row_types`) and the set of expanded paths, it returns the flat
 * list of visible field rows the component renders. That keeps the component
 * about interaction and this module about the data model — and lets the
 * type/validation rules below be read (and tested) in one place.
 *
 * Two invariants worth keeping:
 *
 * 1. **Types come from the backend when they exist.** MongoDB's display JSON is
 *    lossy (`Int32`/`Int64`/`Double` are all JSON numbers; `ObjectId`/`Date`/
 *    `Decimal128` are all strings), so guessing a type from the value would
 *    make an unrelated edit rewrite a `Long` as an `Int`. `row_types` carries
 *    the real ones; [`inferType`] is only the fallback for the SQL drivers and
 *    for values the backend never typed.
 * 2. **A field is addressed by its path, never by a display index.** The path
 *    doubles as the MongoDB update path (`customData.format`, `tags.2`), which
 *    is exactly what `update_cell` / `unset_field` want — same reasoning as
 *    ADR #7 one level down.
 */

import type { BsonTypeTree, CellValue } from "@/types";

/**
 * BSON type vocabulary, using the backend's own lowercase names (see
 * `bson_type_name` in `src-tauri/src/db/mongo/values.rs`) so a value read off
 * `row_types` can be sent straight back as `update_cell`'s `columnType` hint —
 * `string_to_bson` matches on these exact spellings, lowercased.
 *
 * `uuid` never arrives from the backend (a UUID is a `binary` with subtype 4 on
 * the wire); it exists because the type picker can *write* one.
 */
export const BSON_TYPES = [
  "string",
  "array",
  "binary",
  "bool",
  "javascript",
  "date",
  "decimal128",
  "double",
  "int",
  "long",
  "maxKey",
  "minKey",
  "null",
  "object",
  "objectId",
  "regex",
  "symbol",
  "timestamp",
  "undefined",
  "uuid",
] as const;

export type BsonType = (typeof BSON_TYPES)[number];

/** Human labels, matching the names MongoDB Compass uses in its type picker. */
export const BSON_TYPE_LABELS: Record<BsonType, string> = {
  string: "String",
  array: "Array",
  binary: "Binary",
  bool: "Boolean",
  javascript: "Code",
  date: "Date",
  decimal128: "Decimal128",
  double: "Double",
  int: "Int32",
  long: "Int64",
  maxKey: "MaxKey",
  minKey: "MinKey",
  null: "Null",
  object: "Object",
  objectId: "ObjectId",
  regex: "BSONRegExp",
  symbol: "BSONSymbol",
  timestamp: "Timestamp",
  undefined: "Undefined",
  uuid: "UUID",
};

/** Label for a type name, including ones outside the picker (`dbPointer`,
 *  `mixed`, or anything a future backend adds) — shown verbatim rather than
 *  swallowed, so an unknown type is visible instead of mislabelled. */
export function typeLabel(type: string): string {
  return BSON_TYPE_LABELS[type as BsonType] ?? type;
}

/**
 * Types whose *display* form (what `bson_to_json` produced) cannot be parsed
 * back into the same value, so editing that text would silently corrupt the
 * field. `Binary` renders as `Binary(Generic, 12 bytes)` and `DbPointer` as
 * `DbPointer`; neither says anything about the bytes behind it. `minKey` /
 * `maxKey` have no value at all — they *are* their type.
 *
 * The list view refuses inline editing for these (the type picker still works:
 * changing the type is how you replace such a field on purpose). `timestamp`
 * and `regex` are NOT here — their display forms (`Timestamp(t, i)`,
 * `/pattern/flags`) round-trip through `string_to_bson`'s shorthand parsers.
 */
const OPAQUE_TYPES = new Set<string>([
  "binary",
  "dbPointer",
  "minKey",
  "maxKey",
]);

export function isOpaqueType(type: string): boolean {
  return OPAQUE_TYPES.has(type);
}

/** Largest / smallest value a BSON `Int32` can hold. */
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

/**
 * Best-effort type for a value the backend didn't type for us: the SQL drivers
 * (which have no `row_types`) and any cell whose type tree is missing. Numbers
 * are split `int`/`long`/`double` the same way `json_to_bson` narrows them on
 * the way back in, so a round-trip through the grid is stable.
 */
export function inferType(value: CellValue): BsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      if (!Number.isInteger(value)) return "double";
      return value >= INT32_MIN && value <= INT32_MAX ? "int" : "long";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/** Resolve a node's type from its slice of the backend type tree, falling back
 *  to [`inferType`]. `document` is the backend's name for what the picker (and
 *  Compass) calls an Object. */
export function resolveType(
  value: CellValue,
  tree: BsonTypeTree | undefined,
): string {
  if (typeof tree === "string") return tree === "document" ? "object" : tree;
  if (Array.isArray(tree)) return "array";
  if (tree && typeof tree === "object") return "object";
  return inferType(value);
}

/**
 * Descend one level into a type tree, mirroring the descent into the value.
 *
 * Exported because the list view is no longer the only consumer of a document's
 * type tree: `fieldPaths.ts` walks the same trees to collect the nested field
 * *paths* the advanced filter offers, and a second private copy of this descent
 * is exactly the kind of drift that would let the two disagree about what a
 * field's type is.
 */
export function childTypeTree(
  tree: BsonTypeTree | undefined,
  key: string,
): BsonTypeTree | undefined {
  if (Array.isArray(tree)) return tree[Number(key)];
  if (tree && typeof tree === "object")
    return (tree as Record<string, BsonTypeTree>)[key];
  return undefined;
}

/** One rendered line of a document: a scalar field, or a container header. */
export interface DocField {
  /** Field path from the document root. Doubles as the MongoDB update path. */
  path: string[];
  /** Last path segment — the key (or the index, inside an array). */
  key: string;
  value: CellValue;
  /** Resolved BSON type name (see {@link BSON_TYPES}). */
  type: string;
  /** Nesting level; 0 for a top-level field. */
  depth: number;
  /** `"object"` / `"array"` when this line can be folded, `null` otherwise. */
  container: "object" | "array" | null;
  /** Number of children, for the collapsed summary. */
  childCount: number;
  expanded: boolean;
  /** Whether the container this field lives in is an array (its key is an
   *  index, so it can't be renamed and a new sibling is appended, not named). */
  inArray: boolean;
  /** False when the value's display form isn't round-trippable — see
   *  {@link isOpaqueType}. */
  editable: boolean;
}

/** Stable key for a field row inside one document: its path, joined. */
export function pathKey(path: string[]): string {
  return path.join(".");
}

function containerOf(
  value: CellValue,
  type: string,
): "object" | "array" | null {
  if (type === "array" || Array.isArray(value)) return "array";
  if (type === "object" && value !== null && typeof value === "object")
    return "object";
  return null;
}

/**
 * Flatten one document into the ordered list of visible field lines.
 *
 * Top-level fields come from `columns` (so the column order the backend chose —
 * `_id` first — is preserved even for documents missing some of them); nested
 * fields come from the value itself. A container contributes its own line
 * always, and its children only while `isExpanded` says so.
 *
 * `isExpanded` is a predicate rather than a set because "expanded" is not a
 * plain flag: the caller answers it against the `listExpandNested` preference,
 * with the user's own folds as a *diff* from whatever that preference says.
 */
export function flattenDocument(
  columns: { name: string }[],
  values: CellValue[],
  types: BsonTypeTree[] | undefined,
  isExpanded: (pathKey: string) => boolean,
): DocField[] {
  const out: DocField[] = [];

  const walk = (
    path: string[],
    value: CellValue,
    tree: BsonTypeTree | undefined,
    depth: number,
    inArray: boolean,
  ) => {
    const type = resolveType(value, tree);
    const container = containerOf(value, type);
    // `childCount` only needs the child *count* — a collapsed 10,000-element
    // array used to pay for materialising 10,000 `[String(i), v]` tuples (via
    // `.map`) or `Object.entries` pairs just to read `.length` off the
    // result, on every render of the memo this feeds (DocumentCard, gotcha
    // #55's Array.isArray branch below is the same distinction). Reading the
    // count directly, and only walking children `if (container && open)`,
    // makes a collapsed container O(1) instead of O(children).
    const childCount =
      container === null
        ? 0
        : Array.isArray(value)
          ? value.length
          : Object.keys(value as Record<string, CellValue>).length;
    const open = container !== null && isExpanded(pathKey(path));
    out.push({
      path,
      key: path[path.length - 1] ?? "",
      value,
      type,
      depth,
      container,
      childCount,
      expanded: open,
      inArray,
      editable: !isOpaqueType(type),
    });
    if (container && open) {
      if (Array.isArray(value)) {
        // Array keys are the `$set`/`$unset` path segment (ADR #29), so
        // they stay `String(i)` — an indexed loop just skips building the
        // `[key, value]` tuple array `.map` would allocate.
        for (let i = 0; i < value.length; i++) {
          walk([...path, String(i)], value[i] as CellValue, childTypeTree(tree, String(i)), depth + 1, true);
        }
      } else {
        const obj = value as Record<string, CellValue>;
        // `Object.keys` enumerates the same own, enumerable, insertion-order
        // keys `Object.entries` did — only the pair-array allocation is gone.
        for (const k of Object.keys(obj)) {
          walk([...path, k], obj[k], childTypeTree(tree, k), depth + 1, false);
        }
      }
    }
  };

  columns.forEach((col, i) => {
    walk([col.name], values[i] ?? null, types?.[i], 0, false);
  });
  return out;
}

/**
 * The text an inline editor starts with. Strings edit as themselves (the
 * surrounding quotes are decoration, not content); containers edit as
 * pretty-printed JSON in the heavyweight editor; everything else edits as the
 * text it displays as.
 */
export function editText(value: CellValue, type: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  if (type === "date" && typeof value === "string") return value;
  return String(value);
}

/**
 * The value as displayed, Compass-style: strings quoted, `null` left to the
 * caller's NULL placeholder, containers summarised by their child count (the
 * children themselves are separate lines once expanded).
 */
export function displayValue(field: DocField, nullDisplay: string): string {
  const { value, type, container, childCount } = field;
  if (container === "array") return `Array (${childCount})`;
  if (container === "object") return `Object`;
  if (value === null || value === undefined) {
    return type === "undefined" ? "undefined" : nullDisplay;
  }
  if (typeof value === "string" && type !== "objectId" && type !== "date") {
    return `"${value}"`;
  }
  return String(value);
}

/**
 * The type label shown in a field row's right gutter. A SQL top-level field
 * shows its real catalog type (`varchar(255)`, `jsonb`) rather than the JSON
 * shape it arrived as; a nested value inside a JSON column, and every
 * MongoDB field, shows the BSON-style label instead.
 *
 * Resolved by column *name*, via a caller-supplied lookup map, rather than
 * by the flattened display index — the index stops matching the column list
 * the instant anything is expanded. The map is the caller's job to memoize
 * (once per column list, not per field): a `columns.find()` per field here
 * would be O(fields × columns) on every render — ~160,000 string
 * comparisons on a page of 100 rows × 40 columns.
 */
export function typeTextFor(
  field: DocField,
  documentMode: boolean,
  columnTypeByName: ReadonlyMap<string, string>,
): string {
  if (documentMode || field.depth > 0) return typeLabel(field.type);
  return columnTypeByName.get(field.path[0]) ?? typeLabel(field.type);
}

/**
 * Whether `text` is a plausible value for `type`, checked before it goes to the
 * backend.
 *
 * `string_to_bson` falls back to storing a plain string whenever its own parse
 * fails, which is a fine default for a shell paste but a silent type change
 * when it happens under an inline editor — the user picked `Int32`, typed a
 * typo, and would get a string field back with no way to notice. Validating
 * here lets the list view refuse the commit and say why instead.
 *
 * Types with no meaningful text form (`null`, `minKey`, …) accept anything:
 * their value is discarded by the backend anyway.
 */
/**
 * The type the picker should show as selected for a column's `data_type`.
 *
 * `document` is BSON's own name; the picker calls it `object` because that is
 * what the user types. Absent means a column the backend could not type — a
 * freshly added field — which starts as a string.
 */
export function draftTypeFor(dataType?: string): string {
  if (!dataType) return "string";
  if (dataType === "document") return "object";
  return dataType;
}

/**
 * The picker only knows the types it can *write*.
 *
 * Anything else — a `dbPointer`, a `mixed` column — shows its own label through
 * [`typeLabel`] but maps onto `string` here so the Radix trigger has a valid
 * value. Those are the same types [`isOpaqueType`] refuses to edit inline
 * (ADR #29): committing the text `Binary(Generic, 12 bytes)` would store
 * exactly that string.
 */
export function typeValue(type: string): string {
  return (BSON_TYPES as readonly string[]).includes(type) ? type : "string";
}

/**
 * A neutral value for a type the current text cannot be reinterpreted as.
 *
 * Retyping a field to something incompatible has to leave *something* valid in
 * the editor — an empty numeric field would fail to parse on the next commit.
 */
export function defaultText(type: BsonType): string {
  switch (type) {
    case "int":
    case "long":
    case "double":
    case "decimal128":
      return "0";
    case "bool":
      return "false";
    case "object":
      return "{}";
    case "array":
      return "[]";
    case "date":
      return new Date().toISOString();
    default:
      return "";
  }
}

/**
 * The index a new element appends at, for "add item" inside an array.
 *
 * Read from the container's own `childCount` rather than by counting the
 * flattened rows: a collapsed array contributes no rows, and appending to one
 * must not land on index 0 and overwrite its first element.
 */
export function nextArrayIndex(fields: DocField[], parent: string[]): number {
  const container = fields.find((f) => pathKey(f.path) === pathKey(parent));
  return container?.childCount ?? 0;
}

export function isValidForType(type: string, text: string): boolean {
  const s = text.trim();
  switch (type) {
    case "int": {
      if (!/^-?\d+$/.test(s)) return false;
      const n = Number(s);
      return n >= INT32_MIN && n <= INT32_MAX;
    }
    case "long":
      if (!/^-?\d+$/.test(s)) return false;
      try {
        const n = BigInt(s);
        return n >= -(2n ** 63n) && n <= 2n ** 63n - 1n;
      } catch {
        return false;
      }
    case "double":
      return s !== "" && Number.isFinite(Number(s));
    case "decimal128":
      return /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s);
    case "bool":
      return ["true", "false", "1", "0"].includes(s.toLowerCase());
    case "date":
      // `DateTime::parse_rfc3339_str` on the backend: an ISO-8601 instant.
      return /^\d{4}-\d{2}-\d{2}[T ]/.test(s) && !Number.isNaN(Date.parse(s));
    case "objectId":
      return /^[0-9a-fA-F]{24}$/.test(s);
    case "uuid":
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        s,
      );
    case "binary":
      return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
    case "regex":
      return /^\/.*\/[a-z]*$/.test(s) || isExtJson(s);
    case "timestamp":
      return (
        /^(Timestamp\s*\()?\s*\d+\s*(,\s*\d+\s*)?\)?$/.test(s) || isExtJson(s)
      );
    case "object":
      return isJsonOf(s, "object");
    case "array":
      return isJsonOf(s, "array");
    default:
      return true;
  }
}

function isExtJson(s: string): boolean {
  try {
    const v: unknown = JSON.parse(s);
    return (
      typeof v === "object" &&
      v !== null &&
      Object.keys(v as object).some((k) => k.startsWith("$"))
    );
  } catch {
    return false;
  }
}

function isJsonOf(s: string, kind: "object" | "array"): boolean {
  try {
    const v: unknown = JSON.parse(s);
    if (kind === "array") return Array.isArray(v);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}
