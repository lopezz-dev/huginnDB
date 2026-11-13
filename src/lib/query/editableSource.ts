/**
 * Can the rows a hand-typed `SELECT` returned be written back to the table they
 * came from? And if so, which result column is which table column?
 *
 * The query tab's grid used to be view-only, full stop: a result set carries
 * no provenance, so there was nothing to address an `UPDATE` or a `DELETE` to.
 * Yet the commonest thing typed into the editor is exactly the shape the table
 * browser already writes to — `SELECT … FROM one_table WHERE …` — and having
 * to reopen that table and refilter it just to fix a cell or remove a dozen
 * rows was the friction a user called in about.
 *
 * So this answers the question in two halves, both pure:
 *
 * 1. {@link parseSingleTableSelect} reads the statement text. It accepts one
 *    `SELECT` over **one** relation and nothing that could make a result row
 *    stop being one table row: no `JOIN`, no comma join, no subquery or CTE in
 *    `FROM`, no `GROUP BY`/`HAVING`/`DISTINCT`, no set operator, no aggregate
 *    in the projection, no `SELECT … INTO`. Anything it does not understand
 *    makes it answer `null` — the grid stays read-only, which is what it was.
 *    It is a recogniser, not a parser: a false "no" costs a user the shortcut,
 *    a false "yes" would write to the wrong row, so every doubt resolves to no.
 * 2. {@link mapResultColumns} lines the projection up against the catalog
 *    columns and the result set's own column list, position by position, and
 *    only answers when every position agrees. `*` expands to the catalog's
 *    columns in order; `col` and `col AS alias` map to `col`; any expression
 *    occupies its slot but is not writable. The primary key must come back
 *    unchanged — every column of it — or nothing is writable, the same rule
 *    `TableDataTab` applies to a projected browse.
 *
 * The backend still decides: `update_cell` / `delete_rows` run the managed
 * policy's relation and column guards whatever this module concluded.
 */

import type { CellValue, ColumnInfo, ColumnMeta, Driver } from "@/types";

/** One item of the projection list, as far as writing back cares. */
export type ProjectionItem =
  /** `*` or `t.*` — every column of the relation, in catalog order. */
  | { kind: "star" }
  /** A bare or qualified column reference, possibly renamed. */
  | { kind: "column"; column: string; alias: string | null }
  /** Anything else: occupies one result column, never writable. */
  | { kind: "expression" };

/** What {@link parseSingleTableSelect} recognised. */
export interface SingleTableSelect {
  /** Schema (or database, on MySQL) when the statement qualified the table. */
  schema: string | undefined;
  table: string;
  items: ProjectionItem[];
}

/** What {@link mapResultColumns} resolved: enough to write a row back. */
export interface EditableSource {
  schema: string | undefined;
  table: string;
  /** The table's primary key, catalog names, catalog order. */
  pkColumns: string[];
  /** Index in the result row of each {@link pkColumns} entry. */
  pkIndices: number[];
  /** The result columns' names for the key, for the grid's key icon. */
  pkResultNames: string[];
  /**
   * Result column name → table column it writes to. A name absent from the
   * map is not writable (an expression, or a name two result columns share
   * with different meanings).
   */
  writable: Map<string, ColumnInfo>;
}

type Token =
  | { t: "word"; v: string; upper: string }
  | { t: "quoted"; v: string }
  | { t: "punct"; v: string }
  | { t: "literal" };

/**
 * Words that end the relation reference in `FROM` — the alias slot must not
 * swallow them — together with the clauses that are allowed to follow it.
 */
const ALLOWED_AFTER_FROM = new Set([
  "WHERE",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "OPTION",
]);

/** Anywhere at depth 0 after the `FROM`, any of these means "not one table row". */
const FORBIDDEN_AFTER_FROM = new Set([
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "OUTER",
  "APPLY",
  "STRAIGHT_JOIN",
  "GROUP",
  "HAVING",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "MINUS",
  "INTO",
  "PIVOT",
  "UNPIVOT",
  "TABLESAMPLE",
  "WINDOW",
  "QUALIFY",
  "CONNECT",
  "START",
]);

/** `SELECT` modifiers that do not change which rows come back. */
const HARMLESS_MODIFIERS = new Set([
  "ALL",
  "HIGH_PRIORITY",
  "SQL_CACHE",
  "SQL_NO_CACHE",
  "SQL_CALC_FOUND_ROWS",
  "SQL_SMALL_RESULT",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
]);

/**
 * Functions that fold several rows into one. One in the projection, even
 * without a `GROUP BY` (MySQL allows it), means a result row is no longer a
 * table row.
 */
const AGGREGATES = new Set([
  "COUNT",
  "COUNT_BIG",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
  "STRING_AGG",
  "ARRAY_AGG",
  "JSON_AGG",
  "JSONB_AGG",
  "JSON_ARRAYAGG",
  "JSON_OBJECTAGG",
  "JSON_OBJECT_AGG",
  "BIT_AND",
  "BIT_OR",
  "BIT_XOR",
  "BOOL_AND",
  "BOOL_OR",
  "EVERY",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "STDEV",
  "STDEVP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
  "VAR",
  "VARP",
  "LISTAGG",
  "CHECKSUM_AGG",
  "GROUPING",
]);

/**
 * Split SQL into the tokens this module needs. Strings and numbers collapse to
 * an opaque literal; comments vanish. Returns `null` on anything unterminated —
 * a statement we cannot read is a statement we will not write through.
 */
function tokenize(sql: string, driver: Driver | undefined): Token[] | null {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Comments.
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "#" && driver === "mysql") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    // String literals, with doubled-quote escapes (and backslash on MySQL).
    // On MySQL a double quote opens a string too, not an identifier: reading
    // `SELECT "name" FROM t` as the column would offer to write the real
    // column from a cell that shows a constant.
    if (c === "'" || (c === '"' && driver === "mysql")) {
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === "\\" && driver === "mysql") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ t: "literal" });
      i = j + 1;
      continue;
    }
    // Postgres dollar quoting: $$…$$ or $tag$…$tag$.
    if (c === "$" && driver === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) return null;
        out.push({ t: "literal" });
        i = end + m[0].length;
        continue;
      }
    }
    // Quoted identifiers.
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= n) return null;
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            v += close;
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j];
        j++;
      }
      out.push({ t: "quoted", v });
      i = j + 1;
      continue;
    }
    // Numbers (including `1.5`, `.5`, `1e3`).
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^(?:[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|0x[0-9A-Fa-f]+)/.exec(
        sql.slice(i),
      );
      i += m ? m[0].length : 1;
      out.push({ t: "literal" });
      continue;
    }
    // Words: identifiers and keywords. `@`/`#` lead T-SQL variables and temp
    // tables, `$` continues Postgres/MySQL identifiers.
    if (/[\p{L}_@#]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$@#]/u.test(sql[j])) j++;
      const v = sql.slice(i, j);
      out.push({ t: "word", v, upper: v.toUpperCase() });
      i = j;
      continue;
    }
    out.push({ t: "punct", v: c });
    i++;
  }
  return out;
}

const isWord = (tok: Token | undefined, upper: string) =>
  tok?.t === "word" && tok.upper === upper;
const isPunct = (tok: Token | undefined, v: string) =>
  tok?.t === "punct" && tok.v === v;
/** A token that can name something: a bare word or a quoted identifier. */
const identOf = (tok: Token | undefined): string | null =>
  tok?.t === "word" ? tok.v : tok?.t === "quoted" ? tok.v : null;

/** Split `tokens` on depth-0 commas. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const tok of tokens) {
    if (isPunct(tok, "(")) depth++;
    else if (isPunct(tok, ")")) depth--;
    if (depth === 0 && isPunct(tok, ",")) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(tok);
  }
  return parts;
}

/**
 * Read one projection item. `qualifiers` are the names a column may be
 * prefixed with — the table, its alias, `schema.table` — compared without case.
 */
function readItem(item: Token[], qualifiers: Set<string>): ProjectionItem | null {
  if (item.length === 0) return null;
  // Aggregates and `INTO` disqualify the whole statement.
  for (let k = 0; k < item.length; k++) {
    const tok = item[k];
    if (tok.t === "word" && AGGREGATES.has(tok.upper) && isPunct(item[k + 1], "("))
      return null;
    if (isWord(tok, "INTO")) return null;
  }
  // Peel an optional trailing alias: `… AS name` or `… name`.
  let body = item;
  let alias: string | null = null;
  const last = item[item.length - 1];
  const beforeLast = item[item.length - 2];
  if (item.length >= 3 && isWord(beforeLast, "AS") && identOf(last) !== null) {
    alias = identOf(last);
    body = item.slice(0, -2);
  } else if (
    item.length >= 2 &&
    identOf(last) !== null &&
    !isPunct(beforeLast, ".") &&
    // `name name` is an alias; `name(` … `)` `name` too — anything ending in a
    // closing paren or an identifier, followed by another identifier.
    (identOf(beforeLast) !== null || isPunct(beforeLast, ")") || beforeLast?.t === "literal")
  ) {
    alias = identOf(last);
    body = item.slice(0, -1);
  }

  // `*` or `q.*` (any qualifier chain that names this relation).
  if (body.length === 1 && isPunct(body[0], "*")) {
    return alias === null ? { kind: "star" } : null;
  }
  if (body.length >= 3 && isPunct(body[body.length - 1], "*") && isPunct(body[body.length - 2], ".")) {
    const q = qualifierOf(body.slice(0, -2));
    if (q === null || !qualifiers.has(q.toLowerCase())) return null;
    return alias === null ? { kind: "star" } : null;
  }
  // `col`, `q.col`, `s.t.col`.
  const col = identOf(body[body.length - 1]);
  if (col !== null && !(body[body.length - 1].t === "word" && isReservedValue(body[body.length - 1]))) {
    if (body.length === 1) return { kind: "column", column: col, alias };
    if (isPunct(body[body.length - 2], ".")) {
      const q = qualifierOf(body.slice(0, -2));
      if (q !== null) {
        if (!qualifiers.has(q.toLowerCase())) return null;
        return { kind: "column", column: col, alias };
      }
    }
  }
  return { kind: "expression" };
}

/** `NULL`, `TRUE`… read as words but are values, not columns. */
function isReservedValue(tok: Token): boolean {
  return (
    tok.t === "word" &&
    ["NULL", "TRUE", "FALSE", "DEFAULT", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"].includes(
      tok.upper,
    )
  );
}

/** `a` or `a.b` (dot-joined identifiers) → `"a"` / `"a.b"`; anything else → null. */
function qualifierOf(tokens: Token[]): string | null {
  const parts: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (k % 2 === 0) {
      const id = identOf(tokens[k]);
      if (id === null) return null;
      parts.push(id);
    } else if (!isPunct(tokens[k], ".")) return null;
  }
  return tokens.length % 2 === 1 ? parts.join(".") : null;
}

/**
 * Recognise `SELECT <projection> FROM <one relation> [alias] [WHERE …]
 * [ORDER BY …] [LIMIT …]`. `null` for anything else — see the module comment.
 */
export function parseSingleTableSelect(
  sql: string,
  driver: Driver | undefined,
): SingleTableSelect | null {
  if (driver === undefined || driver === "mongodb") return null;
  const tokens = tokenize(sql, driver);
  if (!tokens) return null;
  // One statement: a trailing `;` (or several) is fine, an inner one is not.
  while (tokens.length > 0 && isPunct(tokens[tokens.length - 1], ";")) tokens.pop();
  if (tokens.some((tok) => isPunct(tok, ";"))) return null;

  let i = 0;
  if (!isWord(tokens[i], "SELECT")) return null;
  i++;
  // Modifiers.
  for (;;) {
    const tok = tokens[i];
    if (tok?.t !== "word") break;
    if (tok.upper === "DISTINCT" || tok.upper === "DISTINCTROW" || tok.upper === "UNIQUE")
      return null;
    if (HARMLESS_MODIFIERS.has(tok.upper)) {
      i++;
      continue;
    }
    if (tok.upper === "TOP") {
      i++;
      if (isPunct(tokens[i], "(")) {
        let depth = 0;
        do {
          if (isPunct(tokens[i], "(")) depth++;
          else if (isPunct(tokens[i], ")")) depth--;
          i++;
        } while (i < tokens.length && depth > 0);
      } else if (tokens[i]?.t === "literal") i++;
      else return null;
      if (isWord(tokens[i], "PERCENT")) i++;
      if (isWord(tokens[i], "WITH") && isWord(tokens[i + 1], "TIES")) i += 2;
      continue;
    }
    break;
  }

  // Projection: up to the depth-0 FROM.
  const projStart = i;
  let depth = 0;
  for (; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) depth++;
    else if (isPunct(tokens[i], ")")) depth--;
    else if (depth === 0 && isWord(tokens[i], "FROM")) break;
  }
  if (i >= tokens.length) return null;
  const projection = tokens.slice(projStart, i);
  i++; // FROM

  // The relation: `name`, `schema.name` or `db.schema.name`.
  if (isWord(tokens[i], "ONLY") || isWord(tokens[i], "LATERAL")) return null;
  const nameParts: string[] = [];
  for (;;) {
    const tok = tokens[i];
    const id = identOf(tok);
    if (id === null) return null;
    if (
      tok.t === "word" &&
      (FORBIDDEN_AFTER_FROM.has(tok.upper) || ALLOWED_AFTER_FROM.has(tok.upper))
    )
      return null;
    nameParts.push(id);
    i++;
    if (isPunct(tokens[i], ".")) {
      i++;
      continue;
    }
    break;
  }
  if (nameParts.length > 3) return null;
  // A table-valued function call, `FROM f(…)`.
  if (isPunct(tokens[i], "(")) return null;
  // Three-part names (`db.schema.table`) are SQL Server's cross-database form;
  // the write commands take one qualifier, so leave those read-only.
  if (nameParts.length === 3) return null;
  const table = nameParts[nameParts.length - 1];
  const schema = nameParts.length === 2 ? nameParts[0] : undefined;

  // Optional alias.
  let alias: string | null = null;
  if (isWord(tokens[i], "AS")) {
    alias = identOf(tokens[i + 1]);
    if (alias === null) return null;
    i += 2;
  } else {
    const tok = tokens[i];
    if (tok?.t === "quoted") {
      alias = tok.v;
      i++;
    } else if (
      tok?.t === "word" &&
      !ALLOWED_AFTER_FROM.has(tok.upper) &&
      !FORBIDDEN_AFTER_FROM.has(tok.upper) &&
      tok.upper !== "WITH"
    ) {
      alias = tok.v;
      i++;
    }
  }
  // SQL Server table hints: `WITH (NOLOCK)`.
  if (isWord(tokens[i], "WITH") && isPunct(tokens[i + 1], "(")) {
    i++;
    let d = 0;
    do {
      if (isPunct(tokens[i], "(")) d++;
      else if (isPunct(tokens[i], ")")) d--;
      i++;
    } while (i < tokens.length && d > 0);
  }

  // What follows must be one of the row-preserving clauses, and nothing at
  // depth 0 anywhere after may join, group or combine.
  if (i < tokens.length) {
    const tok = tokens[i];
    if (tok.t !== "word" || !ALLOWED_AFTER_FROM.has(tok.upper)) return null;
  }
  depth = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (isPunct(tok, "(")) depth++;
    else if (isPunct(tok, ")")) depth--;
    else if (depth === 0) {
      if (isPunct(tok, ",") && !inLimitTail(tokens, i)) return null;
      if (tok.t === "word" && FORBIDDEN_AFTER_FROM.has(tok.upper)) return null;
    }
  }

  const qualifiers = new Set<string>([table.toLowerCase()]);
  if (schema) qualifiers.add(`${schema}.${table}`.toLowerCase());
  if (alias) {
    // With an alias, SQL makes the bare table name unusable as a qualifier on
    // most engines; accepting it anyway would only widen what we recognise.
    qualifiers.clear();
    qualifiers.add(alias.toLowerCase());
  }

  const items: ProjectionItem[] = [];
  for (const part of splitTopLevel(projection)) {
    const item = readItem(part, qualifiers);
    if (item === null) return null;
    items.push(item);
  }
  return { schema, table, items };
}

/** MySQL's `LIMIT 10, 20` is the one depth-0 comma allowed after `FROM`. */
function inLimitTail(tokens: Token[], at: number): boolean {
  for (let k = at - 1; k >= 0; k--) {
    const tok = tokens[k];
    if (tok.t === "word") return tok.upper === "LIMIT";
    if (tok.t !== "literal") return false;
  }
  return false;
}

/** Case-insensitive catalog lookup, preferring an exact match. */
function findColumn(columns: ColumnInfo[], name: string): ColumnInfo | undefined {
  return (
    columns.find((c) => c.name === name) ??
    columns.find((c) => c.name.toLowerCase() === name.toLowerCase())
  );
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The columns of a single-table result, lined up with the table's catalog.
 * Unlike {@link EditableSource} it needs no primary key: it says which table
 * column each result name stands for, which is all a read-only gesture (FK
 * navigation) needs.
 */
export interface ResultColumns {
  schema: string | undefined;
  table: string;
  /**
   * Result column name → the table column it is. A name absent from the map
   * is no column of the table (an expression, or a name two result columns
   * share with different meanings).
   */
  byName: Map<string, ColumnInfo>;
}

/** An alignment, with the table column (or `null`, an expression) at each
 *  result position — what finding the key needs. */
type Aligned = ResultColumns & { sources: (ColumnInfo | null)[] };

/**
 * Line the recognised projection up with the catalog and the result. `null`
 * when the two do not agree position by position.
 */
function align(
  select: SingleTableSelect,
  tableColumns: ColumnInfo[],
  resultColumns: ColumnMeta[],
): Aligned | null {
  // Per result position: the table column it is, or null for an expression.
  const sources: (ColumnInfo | null)[] = [];
  for (const item of select.items) {
    if (item.kind === "star") {
      for (const c of tableColumns) {
        const pos = sources.length;
        const rc = resultColumns[pos];
        if (!rc || !sameName(rc.name, c.name)) return null;
        sources.push(c);
      }
    } else if (item.kind === "column") {
      const c = findColumn(tableColumns, item.column);
      if (!c) return null;
      const rc = resultColumns[sources.length];
      if (!rc || !sameName(rc.name, item.alias ?? item.column)) return null;
      sources.push(c);
    } else {
      if (!resultColumns[sources.length]) return null;
      sources.push(null);
    }
  }
  if (sources.length !== resultColumns.length) return null;

  // A result name maps to one table column, unambiguously.
  const seen = new Map<string, ColumnInfo | null>();
  resultColumns.forEach((rc, ix) => {
    const src = sources[ix];
    if (!seen.has(rc.name)) seen.set(rc.name, src);
    else if (seen.get(rc.name)?.name !== src?.name) seen.set(rc.name, null);
  });
  const byName = new Map<string, ColumnInfo>();
  for (const [name, src] of seen) if (src) byName.set(name, src);

  return { schema: select.schema, table: select.table, byName, sources };
}

/** The writable view of an alignment: `null` without the whole key. */
function withKey(
  aligned: Aligned,
  tableColumns: ColumnInfo[],
  resultColumns: ColumnMeta[],
): EditableSource | null {
  // The key: every PK column, first position it appears at.
  const pk = tableColumns.filter((c) => c.is_primary_key);
  if (pk.length === 0) return null;
  const pkIndices = pk.map((k) =>
    aligned.sources.findIndex((s) => s?.name === k.name),
  );
  if (pkIndices.some((ix) => ix < 0)) return null;
  return {
    schema: aligned.schema,
    table: aligned.table,
    pkColumns: pk.map((c) => c.name),
    pkIndices,
    pkResultNames: pkIndices.map((ix) => resultColumns[ix].name),
    writable: aligned.byName,
  };
}

/**
 * What a single-table result is, in both senses a grid needs: its `columns`
 * lined up with the table (enough to read through them — FK navigation), and
 * `editable` when the whole primary key came back too (enough to write).
 * `null` when the columns do not line up at all.
 */
export function resolveResultColumns(
  select: SingleTableSelect,
  tableColumns: ColumnInfo[],
  resultColumns: ColumnMeta[],
): { columns: ResultColumns; editable: EditableSource | null } | null {
  const aligned = align(select, tableColumns, resultColumns);
  if (!aligned) return null;
  const { sources: _positions, ...columns } = aligned;
  return { columns, editable: withKey(aligned, tableColumns, resultColumns) };
}

/** {@link resolveResultColumns}' writable half — `null` unless the columns
 *  line up and the whole key came back. */
export function mapResultColumns(
  select: SingleTableSelect,
  tableColumns: ColumnInfo[],
  resultColumns: ColumnMeta[],
): EditableSource | null {
  return resolveResultColumns(select, tableColumns, resultColumns)?.editable ?? null;
}

/** The key tuple of one result row, in {@link EditableSource.pkColumns} order. */
export function pkValuesOf(source: EditableSource, row: CellValue[]): CellValue[] {
  return source.pkIndices.map((ix) => row[ix]);
}
