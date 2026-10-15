/**
 * The `db.<collection>.<method>(…)` vocabulary the query tab offers for a
 * MongoDB connection.
 *
 * **Kept in sync with `src-tauri/src/db/mongo/shell.rs`** — the same
 * convention (and the same obligation) as `monacoMongo.ts`'s constructor
 * list, which now reads its copy from here. There is exactly one parser for
 * this grammar and it is in Rust (ADR #33); everything below is a *mirror*
 * of what that parser accepts, kept here so the editor can suggest it:
 *
 * - {@link SHELL_METHODS} mirrors `build_op`'s match arms (its `other =>`
 *   error message enumerates them) plus the `count` alias.
 * - {@link CURSOR_MODIFIERS} mirrors `finish`'s chained-modifier loop, which
 *   accepts exactly `sort`, `limit`, `skip` and `projection`/`project` and
 *   errors on anything else.
 * - {@link BSON_CONSTRUCTORS} mirrors `parse_keyword_or_ctor`.
 * - {@link QUERY_OPERATORS} / {@link UPDATE_OPERATORS} are *not* mirrored from
 *   the parser — the parser passes any `$`-key straight through to the server
 *   — so they are a curated, deliberately non-exhaustive list of the ones
 *   worth suggesting, same editorial call as `EXPRESSION_OPERATORS` in
 *   `monacoMongo.ts`.
 *
 * A snippet's `$` needs escaping as `\$` wherever it is a literal character
 * (`$set` in an update document), never a tabstop — the same Monaco snippet
 * rule `stages.ts` documents at length.
 */

/** One entry in the method / modifier catalogue. */
export interface ShellMethodSpec {
  /** Method name, as written after the dot. */
  name: string;
  /** Human-readable signature, shown as the completion item's `detail`.
   *  Taken from the argument handling in `build_op` / `finish`. */
  signature: string;
  /** Monaco snippet body inserted on accept — the method name included, so
   *  the whole `find({})` lands in one go rather than a bare `find`. */
  insertSnippet: string;
  /** `true` when the method mutates data or schema. Purely informational (it
   *  tints the item's detail): the *authoritative* write decision is
   *  `MongoOp::is_read()` in Rust, and nothing here gates execution. */
  write?: boolean;
  /** Set when the name is an accepted alias of another entry, so the popup
   *  can say so instead of showing two identical-looking items. */
  aliasOf?: string;
}

/**
 * Collection methods `build_op` accepts. Order is the order they are offered
 * in: reads first (what an editor session mostly is), then writes, then the
 * index and collection-level operations.
 */
export const SHELL_METHODS: ReadonlyArray<ShellMethodSpec> = [
  {
    name: "find",
    signature: "(filter?, projection?)",
    insertSnippet: "find({$1})",
  },
  {
    name: "findOne",
    signature: "(filter?, projection?)",
    insertSnippet: "findOne({$1})",
  },
  {
    name: "aggregate",
    signature: "([{ … }, …])",
    insertSnippet: "aggregate([{$1}])",
  },
  {
    name: "countDocuments",
    signature: "(filter?)",
    insertSnippet: "countDocuments({$1})",
  },
  {
    name: "count",
    signature: "(filter?)",
    insertSnippet: "count({$1})",
    aliasOf: "countDocuments",
  },
  {
    name: "distinct",
    signature: '("field", filter?)',
    insertSnippet: 'distinct("$1")',
  },
  {
    name: "insertOne",
    signature: "(doc)",
    insertSnippet: "insertOne({$1})",
    write: true,
  },
  {
    name: "insertMany",
    signature: "([{ … }, …])",
    insertSnippet: "insertMany([{$1}])",
    write: true,
  },
  {
    name: "updateOne",
    signature: "(filter, update)",
    insertSnippet: "updateOne({$1}, { \\$set: {$2} })",
    write: true,
  },
  {
    name: "updateMany",
    signature: "(filter, update)",
    insertSnippet: "updateMany({$1}, { \\$set: {$2} })",
    write: true,
  },
  {
    name: "replaceOne",
    signature: "(filter, replacement)",
    insertSnippet: "replaceOne({$1}, {$2})",
    write: true,
  },
  {
    name: "deleteOne",
    signature: "(filter)",
    insertSnippet: "deleteOne({$1})",
    write: true,
  },
  {
    name: "deleteMany",
    signature: "(filter)",
    insertSnippet: "deleteMany({$1})",
    write: true,
  },
  {
    name: "createIndex",
    signature: "(keys, options?)",
    insertSnippet: "createIndex({${1:field}: 1})",
    write: true,
  },
  {
    name: "dropIndex",
    signature: "(name)",
    insertSnippet: 'dropIndex("$1")',
    write: true,
  },
  {
    name: "hideIndex",
    signature: "(name)",
    insertSnippet: 'hideIndex("$1")',
    write: true,
  },
  {
    name: "unhideIndex",
    signature: "(name)",
    insertSnippet: 'unhideIndex("$1")',
    write: true,
  },
  {
    name: "drop",
    signature: "()",
    insertSnippet: "drop()",
    write: true,
  },
  {
    name: "renameCollection",
    signature: "(to)",
    insertSnippet: 'renameCollection("$1")',
    write: true,
  },
];

/**
 * The four chainable cursor modifiers `finish` accepts after the primary
 * call. Anything else is a hard parse error naming the allowed set, so this
 * list is closed — unlike {@link QUERY_OPERATORS}, offering something absent
 * here would be offering a guaranteed failure.
 */
export const CURSOR_MODIFIERS: ReadonlyArray<ShellMethodSpec> = [
  { name: "sort", signature: "({ field: 1 | -1 })", insertSnippet: "sort({${1:field}: ${2:1}})" },
  { name: "limit", signature: "(n)", insertSnippet: "limit(${1:100})" },
  { name: "skip", signature: "(n)", insertSnippet: "skip(${1:0})" },
  {
    name: "projection",
    signature: "({ field: 1 | 0 })",
    insertSnippet: "projection({${1:field}: 1})",
  },
  {
    name: "project",
    signature: "({ field: 1 | 0 })",
    insertSnippet: "project({${1:field}: 1})",
    aliasOf: "projection",
  },
];

/** BSON constructors the Rust parser accepts — kept in sync with
 *  `parse_keyword_or_ctor` in `db/mongo/shell.rs`. `Date` is the `new Date(…)`
 *  form the parser also takes. */
export const BSON_CONSTRUCTORS: ReadonlyArray<string> = [
  "ObjectId",
  "ISODate",
  "Date",
  "NumberLong",
  "NumberInt",
  "NumberDecimal",
  "NumberDouble",
];

/** Query operators worth suggesting inside a filter document. Curated, not
 *  exhaustive — the server owns the real list and the parser forwards any
 *  `$`-key unchanged. */
export const QUERY_OPERATORS: ReadonlyArray<string> = [
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte",
  "$in", "$nin", "$and", "$or", "$nor", "$not",
  "$exists", "$type", "$regex", "$options", "$expr",
  "$all", "$elemMatch", "$size", "$mod", "$text",
];

/** Update operators worth suggesting inside an update document. Same
 *  editorial rule as {@link QUERY_OPERATORS}. */
export const UPDATE_OPERATORS: ReadonlyArray<string> = [
  "$set", "$unset", "$setOnInsert", "$inc", "$mul", "$min", "$max",
  "$rename", "$currentDate",
  "$push", "$pull", "$pullAll", "$pop", "$addToSet", "$each",
];

/** Names of every method that takes an update document as its second
 *  argument — the only place {@link UPDATE_OPERATORS} belong. */
export const UPDATE_METHODS: ReadonlySet<string> = new Set([
  "updateOne",
  "updateMany",
]);
