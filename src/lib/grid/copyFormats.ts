/**
 * Clipboard-friendly serialisers for grid rows.
 *
 * The data grid's right-click menu offers a "Copy as ▸" submenu that
 * uses these helpers to render the currently-selected row in different
 * shapes — JSON, a SQL `INSERT`, or a SQL `UPDATE`. The output is
 * **never** executed by the app; it's purely for the user to paste
 * elsewhere. Best-effort escaping is therefore acceptable: we quote
 * strings safely enough for a paste-and-tweak workflow, but a malicious
 * value would not bypass anything because nothing in the app evaluates
 * the result.
 *
 * Driver awareness comes in only at the identifier-quoting layer: MySQL
 * uses backticks (`` ` ``), Postgres / SQLite use double quotes (`"`).
 * Reusing this distinction keeps the snippets paste-ready against the
 * source database without manual edits.
 *
 * Table references are deliberately unqualified — no schema/database
 * prefix. The query editor's connection dropdown already says which
 * database a pasted snippet runs against, so a prefix was redundant noise
 * on every copy-paste (see `qualifiedTable`).
 */

import type { CellValue, ColumnMeta, Driver } from "@/types";

/**
 * Quote an identifier (table or column name) for the target driver.
 *
 * Doubles any embedded quote character, which is the standard escape in
 * SQL identifier syntax for every supported driver. We don't try to
 * detect "already-quoted" inputs — callers pass raw catalog names.
 *
 * The twin of `Dialect::quote_ident` in `src-tauri/src/db/sql.rs`, which is the
 * authoritative one: it quotes identifiers for SQL the app actually *executes*,
 * so its rules are load-bearing (and it enforces SECURITY.md's "only
 * catalog-sourced names reach `quote_ident`"). This copy exists only to build
 * snippets the user copies to their clipboard, and duplicating it beats routing
 * a clipboard format through an IPC round-trip. Keep the two in sync — the Rust
 * side carries the per-dialect rationale.
 */
export function quoteIdent(driver: Driver | undefined, name: string): string {
  if (driver === "mysql") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  // SQL Server accepts ANSI double quotes only when QUOTED_IDENTIFIER is ON;
  // brackets are unconditional and idiomatic in T-SQL.
  if (driver === "sqlserver") {
    return "[" + name.replace(/]/g, "]]") + "]";
  }
  // Postgres + SQLite both accept ANSI double-quoted identifiers.
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Quote a scalar value as a SQL literal. Numbers and booleans inline
 * as-is, strings get single-quoted with `''` escapes, NULL stays NULL.
 *
 * JSON / object values are stringified first; this is intentional —
 * Postgres accepts a JSON literal as a quoted string thanks to implicit
 * casts in most contexts. The user can refine if needed.
 *
 * MySQL treats `\` as a string-literal escape character by default (its
 * `NO_BACKSLASH_ESCAPES` sql_mode is off unless the server opts in), so an
 * un-escaped backslash — e.g. a `DOMAIN\user` value — silently loses the
 * backslash when the snippet is pasted back and run. Postgres, SQLite and
 * SQL Server don't give `\` any meaning in a plain quoted literal, so only
 * MySQL needs this; the twin fix already exists in the dump path
 * (`src-tauri/src/db/dump.rs`).
 */
export function sqlLiteral(v: CellValue, driver?: Driver): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (driver === "mysql") s = s.replace(/\\/g, "\\\\");
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * JSON object keyed by column name. Pretty-printed (2-space indent)
 * because the typical destination is a doc / chat message where
 * readability matters more than transport size. `null` columns are
 * preserved; we do not drop them (would change shape and lose intent).
 */
export function toJson(
  rowValues: CellValue[],
  columns: ColumnMeta[],
): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i].name] = jsonSafe(rowValues[i]);
  }
  return JSON.stringify(obj, null, 2);
}

/**
 * Normalise a cell value into something `JSON.stringify` can represent
 * without throwing. We currently only worry about `BigInt` (rare but
 * possible if the backend ever switches to bigint-native serialisation);
 * everything else passes through unchanged.
 */
function jsonSafe(v: CellValue): unknown {
  if (typeof v === "bigint") return (v as bigint).toString();
  return v;
}

/**
 * The table a "Copy as SQL" snippet addresses, and how the grid's columns map
 * onto it. A grid shows **result** names — on a query, an alias (`price AS p`)
 * or an expression (`price * 2`) — while a statement has to name **table**
 * columns, so the snippet is built through this rather than from the names on
 * screen. On a table's own grid `columnOf` is the identity.
 *
 * Absent (a result over several tables, a preview with no relation), a snippet
 * keeps the result's names and a `<table>` placeholder for the user to fill.
 */
export interface SqlTarget {
  table: string;
  /** The table column a result column is, or `null` for an expression. */
  columnOf: (resultColumn: string) => string | null;
  /** The table's primary key, by table column name. */
  pkColumns: string[];
}

/** The columns a snippet writes: each result position that is a table
 *  column, with the name the statement must use. */
function sqlColumns(
  columns: ColumnMeta[],
  target: SqlTarget | undefined,
): { index: number; name: string }[] {
  return columns.flatMap((c, index) => {
    const name = target ? target.columnOf(c.name) : c.name;
    return name === null ? [] : [{ index, name }];
  });
}

/**
 * A SQL `INSERT INTO … (cols) VALUES (lits);` snippet for the row: the table
 * columns the result carries, by their table names; an expression is left
 * out, since it is no column to insert into.
 */
export function toSqlInsert(
  rowValues: CellValue[],
  columns: ColumnMeta[],
  driver: Driver | undefined,
  target: SqlTarget | undefined,
): string {
  const tbl = qualifiedTable(driver, target?.table);
  const cols = sqlColumns(columns, target);
  const names = cols.map((c) => quoteIdent(driver, c.name)).join(", ");
  const vals = cols.map((c) => sqlLiteral(rowValues[c.index], driver)).join(", ");
  return `INSERT INTO ${tbl} (${names}) VALUES (${vals});`;
}

/**
 * A SQL `UPDATE … SET … WHERE pk = lit;` snippet for the row.
 *
 * Every key column is excluded from the `SET` clause (updating a row's key
 * from a copy-paste is almost never the intent) and AND-joined in the `WHERE`
 * clause so the snippet stays safe on composite keys. The `WHERE` needs the
 * **whole** key: with part of it — a result that left a key column out — the
 * statement would fan out across every row sharing the part it has, which is
 * the corruption the cell-save path once suffered. Without the whole key the
 * snippet falls back to `WHERE <pk> = <value>` for the user to fix before
 * running it.
 */
export function toSqlUpdate(
  rowValues: CellValue[],
  columns: ColumnMeta[],
  driver: Driver | undefined,
  target: SqlTarget | undefined,
  /** The key by the names on screen, for a grid with no target (a table's
   *  own names are its result names). */
  pkColumnNames?: string[],
): string {
  const tbl = qualifiedTable(driver, target?.table);
  const cols = sqlColumns(columns, target);
  const pk = target?.pkColumns ?? pkColumnNames ?? [];
  const pkSet = new Set(pk);
  const literal = (c: { index: number; name: string }) =>
    `${quoteIdent(driver, c.name)} = ${sqlLiteral(rowValues[c.index], driver)}`;

  const setPairs = cols
    .filter((c) => !pkSet.has(c.name))
    .map(literal)
    .join(", ");

  const keyCols = pk.map((k) => cols.find((c) => c.name === k));
  const whereClause =
    pk.length > 0 && keyCols.every((c) => c !== undefined)
      ? keyCols.map((c) => literal(c!)).join(" AND ")
      : "<pk> = <value>";
  return `UPDATE ${tbl} SET ${setPairs} WHERE ${whereClause};`;
}

/**
 * Build the table reference for the snippet: the quoted table name, or
 * `<table>` as a paste-ready placeholder when it isn't known.
 *
 * Deliberately unqualified — no schema/database prefix. The query editor's
 * own connection dropdown already says which database a pasted snippet runs
 * against, so a prefix here was redundant noise on every copy-paste.
 */
function qualifiedTable(
  driver: Driver | undefined,
  table: string | undefined,
): string {
  if (!table) return "<table>";
  return quoteIdent(driver, table);
}

/**
 * The "Copy SELECT" snippet for a relation: a `SELECT *` for the SQL drivers
 * and a `find()` for MongoDB, which has no SQL.
 *
 * This lives here rather than in the schema tree because per-driver identifier
 * quoting is a serialisation rule, and this module already owns every other
 * one. The tree used to assemble the string inline with its own copy of the
 * quoting triple, and that copy did not double embedded delimiters — so a
 * table named `a"b` produced a snippet that would not parse. Building it from
 * `qualifiedTable` means there is one escaping rule to get right.
 *
 * Note this is a clipboard snippet, not DDL: nothing here is ever executed by
 * the app, which is why assembling SQL text in the frontend is fine here and
 * not in the structure editor (whose statements are built in Rust).
 *
 * Deliberately unqualified, same as `toSqlInsert`/`toSqlUpdate` — see
 * `qualifiedTable`'s comment.
 *
 * **`limit` is what the schema tree's "Query this table…" passes**, and it is
 * the one caller whose text is going to be *run* rather than pasted — an
 * unbounded `SELECT *` over a large table is exactly what the grid pages to
 * avoid. It stays optional because "Copy SELECT statement" wants the bare
 * statement to tweak, which is what it has always produced. The MongoDB branch
 * always had its `.limit(100)`; the parameter is what lets the SQL branch stop
 * being the asymmetric one.
 */
/**
 * Row cap the schema tree's "Query this table…" seeds its `SELECT` with.
 *
 * It lives next to `selectSnippet` rather than in the tree because it is the
 * same number MongoDB's branch has always hard-coded, and having one of the two
 * drift would put the app's two "show me this relation" snippets on different
 * bounds.
 */
export const QUERY_HERE_LIMIT = 100;

export function selectSnippet(
  driver: Driver | undefined,
  table: string,
  limit?: number,
): string {
  if (driver === "mongodb") {
    return `db.${table}.find({}).limit(${limit ?? 100})`;
  }
  const qt = qualifiedTable(driver, table);
  if (limit === undefined) return `SELECT * FROM ${qt};`;
  // T-SQL has no `LIMIT`. `TOP n` is the portable spelling across every
  // SQL Server version this app supports (2012+); `OFFSET … FETCH NEXT`, which
  // `Dialect::paginate` uses on the executed path, additionally requires an
  // `ORDER BY` and there is none to supply here.
  if (driver === "sqlserver") return `SELECT TOP ${limit} * FROM ${qt};`;
  return `SELECT * FROM ${qt} LIMIT ${limit};`;
}

/**
 * Rows as CSV (RFC 4180): a header of the column names as shown, then one line
 * per row, CRLF-separated. A field is quoted when it holds a comma, a quote or
 * a line break, with inner quotes doubled; NULL is an empty field and a JSON
 * value its compact JSON. Prefixed with a UTF-8 byte-order mark, which is what
 * makes Excel read accented text as UTF-8 rather than the system code page.
 */
export function toCsv(rows: CellValue[][], columns: ColumnMeta[]): string {
  const field = (v: CellValue): string => {
    if (v === null || v === undefined) return "";
    const text =
      typeof v === "object" ? JSON.stringify(jsonSafe(v)) : String(jsonSafe(v));
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    columns.map((c) => field(c.name)).join(","),
    ...rows.map((r) => columns.map((_, i) => field(r[i])).join(",")),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * Serialise several rows for the bulk "Copy N rows as ▸" menu, reusing the same
 * per-row formatters as the single-row submenu. JSON yields one array;
 * INSERT/UPDATE yield newline-joined statements.
 *
 * The JSON branch goes through `jsonSafe`, exactly as `toJson` does. `DataGrid`
 * had its own copy of this that cast values straight into the object instead, so
 * a `BigInt` cell that copied fine as a single row threw
 * "Do not know how to serialize a BigInt" the moment two rows were selected.
 */
export function toBulk(
  rows: CellValue[][],
  fmt: "json" | "insert" | "update",
  ctx: {
    columns: ColumnMeta[];
    driver: Driver | undefined;
    target?: SqlTarget;
    pkColumnNames?: string[];
  },
): string {
  const { columns, driver, target, pkColumnNames } = ctx;
  if (fmt === "json") {
    const arr = rows.map((r) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        obj[c.name] = jsonSafe(r[i]);
      });
      return obj;
    });
    return JSON.stringify(arr, null, 2);
  }
  if (fmt === "insert") {
    return rows.map((r) => toSqlInsert(r, columns, driver, target)).join("\n");
  }
  return rows
    .map((r) => toSqlUpdate(r, columns, driver, target, pkColumnNames))
    .join("\n");
}
