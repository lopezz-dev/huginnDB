/**
 * Split a SQL document into individual statements.
 *
 * Used by the editor's per-statement "run" CodeLens so each `;`-delimited
 * statement gets its own gutter icon. The parser is intentionally
 * pragmatic — it understands the four lexical contexts that would cause
 * naïve splitting to break:
 *
 *  - single-quoted strings (`'…'`) with `''` escapes,
 *  - double-quoted identifiers (`"…"`),
 *  - backtick-quoted identifiers (`` `…` ``) — MySQL,
 *  - line comments (`-- …` to end of line),
 *  - block comments (`/* … *​/` — non-nested, ANSI behaviour),
 *  - Postgres dollar-quoted strings (`$tag$ … $tag$`, including the
 *    empty tag `$$ … $$`).
 *
 * Everything outside those contexts is a candidate for a `;` boundary.
 * Empty statements (e.g. a stray trailing semicolon) are skipped.
 *
 * The output positions use Monaco's convention: line and column are
 * **1-based**, so a CodeLens can be anchored straight on them without
 * a coordinate shim.
 *
 * ## Dialects
 *
 * MongoDB's query tab runs the same `;`-splitting over `mongosh` source, and
 * its lexical contexts are *not* SQL's: the line comment is `//` (which is
 * also what Ctrl+/ inserts there), `--` means
 * nothing, backticks are not identifier quotes, `\` escapes inside a string
 * rather than a doubled quote, and `$` opens an operator name on nearly every
 * line rather than a dollar-quoted body. Passing `"mongo"` swaps exactly
 * those five rules. Everything else — the `;` boundary, the position
 * bookkeeping, the empty-statement filter — is shared, because it is the same
 * problem.
 *
 * One rule is added rather than swapped: mongosh makes the semicolon optional,
 * so `"mongo"` also ends a statement at a line break, when no bracket is open,
 * the line does not end in `.` or `,`, and the next thing is not a leading-dot
 * `.modifier(`. Without it a script of one call per line was one statement, the
 * tab took the single-statement path and only the first call ever ran (#220).
 *
 * This stays a **lexer**, not a parser (ADR #33): it recognises the spans
 * a `;` may not be read inside, and nothing about what the statements mean.
 */

export interface SqlStatement {
  /** 1-based line where the statement starts. */
  startLine: number;
  /** 1-based column where the statement starts. */
  startColumn: number;
  /** 1-based line where the statement ends (inclusive). */
  endLine: number;
  /** 1-based column right after the last character of the statement. */
  endColumn: number;
  /** The statement's text, with leading whitespace / comments trimmed
   *  off the front so an empty `";"` between statements is filtered out. */
  text: string;
}

/** Which lexical rules apply. See the "Dialects" note above. */
export type SqlDialect = "sql" | "mongo";

interface DialectRules {
  /** Two-character line-comment opener. */
  lineComment: string;
  /** `` ` `` opens a quoted identifier (MySQL). */
  backtickIdentifiers: boolean;
  /** `$tag$ … $tag$` bodies (Postgres). */
  dollarQuoting: boolean;
  /** `''` inside a string is an escaped quote rather than a terminator. */
  doubledQuoteEscape: boolean;
  /** `\` escapes the next character inside a string. */
  backslashEscape: boolean;
  /**
   * A statement may end at a line break instead of a `;`. mongosh makes the
   * semicolon optional, so a script of one call per line is a script of
   * several statements — see the newline rule in `splitSql`.
   */
  implicitBoundaries: boolean;
}

const DIALECTS: Record<SqlDialect, DialectRules> = {
  sql: {
    lineComment: "--",
    backtickIdentifiers: true,
    dollarQuoting: true,
    doubledQuoteEscape: true,
    backslashEscape: false,
    implicitBoundaries: false,
  },
  mongo: {
    lineComment: "//",
    backtickIdentifiers: false,
    dollarQuoting: false,
    doubledQuoteEscape: false,
    backslashEscape: true,
    implicitBoundaries: true,
  },
};

type Mode =
  | "default"
  | "single-string"
  | "double-string"
  | "back-string"
  | "line-comment"
  | "block-comment"
  | "dollar-string";

/**
 * Detect a dollar-quoted opening at `pos` and return the full tag
 * (including the leading and trailing `$`). Returns `null` if `pos`
 * doesn't start a valid dollar-quote.
 *
 * The Postgres grammar allows an identifier-like body between the
 * dollars: `$$`, `$body$`, `$_my_tag$`. We restrict to that minimum
 * because any tighter rules would reject syntactically valid input.
 */
function readDollarTag(source: string, pos: number): string | null {
  if (source[pos] !== "$") return null;
  let end = pos + 1;
  while (end < source.length) {
    const ch = source[end];
    if (ch === "$") return source.slice(pos, end + 1);
    if (!/[A-Za-z0-9_]/.test(ch)) return null;
    end++;
  }
  return null;
}

/**
 * Index of the first character at or after `from` that is neither whitespace
 * nor a comment, or `-1` when only trivia is left.
 */
function nextSignificant(
  source: string,
  from: number,
  lineComment: string,
): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
    } else if (source.startsWith(lineComment, i)) {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 2;
    } else {
      return i;
    }
  }
  return -1;
}

export function splitSql(
  source: string,
  dialect: SqlDialect = "sql",
): SqlStatement[] {
  const out: SqlStatement[] = [];
  if (!source) return out;
  const rules = DIALECTS[dialect];

  // Cursor state. We track line / column alongside the absolute index
  // so we can build Monaco-friendly positions without a second pass.
  let line = 1;
  let column = 1;
  let mode: Mode = "default";
  /** Active dollar-quote tag (e.g. `"$body$"`) while inside one. */
  let dollarTag = "";

  /** Index of the first non-whitespace, non-comment character of the
   *  current statement; -1 when nothing has been seen yet. */
  let stmtStart = -1;
  let stmtStartLine = 1;
  let stmtStartColumn = 1;

  /** Open `(` `[` `{` of the current statement (`implicitBoundaries` only). */
  let depth = 0;
  /** Last significant character seen in default mode, for the same rule. */
  let lastSignificant = "";

  /**
   * The line break at `i` ends the statement when nothing is left open, the
   * line does not end mid-expression, and the next thing is not a chained
   * `.modifier(`. `db.users.find({})` and `.sort({a: 1})` on the next line stay
   * one statement; `db.a.count()` and `db.b.count()` do not.
   *
   * Called from two places because a line break is read in two modes: in
   * default mode, and as the end of a `// …` comment — `db.a.count() // note`
   * is the common shape, and its break never reaches the default branch.
   */
  function endStatementAtLineBreak(i: number) {
    if (
      !rules.implicitBoundaries ||
      stmtStart < 0 ||
      depth !== 0 ||
      lastSignificant === "." ||
      lastSignificant === ","
    ) {
      return;
    }
    const nx = nextSignificant(source, i + 1, rules.lineComment);
    if (nx >= 0 && source[nx] !== ".") commit(i, line, column);
  }

  function commit(endIdx: number, endLineV: number, endColumnV: number) {
    if (stmtStart < 0) return;
    const raw = source.slice(stmtStart, endIdx);
    // Drop empty statements: pure whitespace, or a stray ";" on its own. The
    // semicolon is not whitespace, so `trim()` alone left `;;SELECT 1;` looking
    // like three statements, two of which the CodeLens offered to run.
    if (!raw.trim() || raw.trim() === ";") {
      stmtStart = -1;
      return;
    }
    out.push({
      startLine: stmtStartLine,
      startColumn: stmtStartColumn,
      endLine: endLineV,
      endColumn: endColumnV,
      text: raw,
    });
    stmtStart = -1;
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    // Mode-specific scanning. We deal with exit conditions here and
    // fall through to the default-mode branch otherwise.
    if (mode === "single-string") {
      // A doubled quote escapes in SQL; a backslash escapes in Mongo.
      if (rules.backslashEscape && ch === "\\") {
        i++;
        column += 2;
        continue;
      }
      if (rules.doubledQuoteEscape && ch === "'" && next === "'") {
        i++;
        column += 2;
        continue;
      }
      if (ch === "'") {
        mode = "default";
        column++;
        continue;
      }
    } else if (mode === "double-string") {
      if (rules.backslashEscape && ch === "\\") {
        i++;
        column += 2;
        continue;
      }
      if (rules.doubledQuoteEscape && ch === '"' && next === '"') {
        i++;
        column += 2;
        continue;
      }
      if (ch === '"') {
        mode = "default";
        column++;
        continue;
      }
    } else if (mode === "back-string") {
      if (ch === "`" && next === "`") {
        i++;
        column += 2;
        continue;
      }
      if (ch === "`") {
        mode = "default";
        column++;
        continue;
      }
    } else if (mode === "line-comment") {
      if (ch === "\n") {
        endStatementAtLineBreak(i);
        mode = "default";
        line++;
        column = 1;
        continue;
      }
    } else if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "default";
        i++;
        column += 2;
        continue;
      }
      if (ch === "\n") {
        line++;
        column = 1;
        continue;
      }
    } else if (mode === "dollar-string") {
      if (ch === "$" && source.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        column += dollarTag.length;
        mode = "default";
        dollarTag = "";
        continue;
      }
      if (ch === "\n") {
        line++;
        column = 1;
        continue;
      }
    }

    if (mode === "default") {
      // Skip leading whitespace + comments when picking the statement
      // start. A `--` that begins a statement, or a `/* */` block, is
      // not "where the statement starts".
      const isWs = ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
      const isLineCommentOpen =
        ch === rules.lineComment[0] && next === rules.lineComment[1];
      const isBlockCommentOpen = ch === "/" && next === "*";

      if (stmtStart < 0 && !isWs && !isLineCommentOpen && !isBlockCommentOpen) {
        stmtStart = i;
        stmtStartLine = line;
        stmtStartColumn = column;
      }

      if (rules.implicitBoundaries) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}")
          depth = Math.max(0, depth - 1);
        if (!isWs && !isLineCommentOpen && !isBlockCommentOpen) {
          lastSignificant = ch;
        }
        if (ch === "\n") endStatementAtLineBreak(i);
      }

      if (ch === ";") {
        depth = 0;
        // `i + 1` is one past the `;`; column has not yet advanced for
        // the semicolon, so the end column is `column + 1`.
        commit(i + 1, line, column + 1);
      } else if (isLineCommentOpen) {
        mode = "line-comment";
        i++;
        column += 2;
        continue;
      } else if (isBlockCommentOpen) {
        mode = "block-comment";
        i++;
        column += 2;
        continue;
      } else if (ch === "'") {
        mode = "single-string";
      } else if (ch === '"') {
        mode = "double-string";
      } else if (rules.backtickIdentifiers && ch === "`") {
        mode = "back-string";
      } else if (rules.dollarQuoting && ch === "$") {
        const tag = readDollarTag(source, i);
        if (tag) {
          mode = "dollar-string";
          dollarTag = tag;
          i += tag.length - 1;
          column += tag.length;
          continue;
        }
      }
    }

    // Common bookkeeping: advance line/column for every character we
    // didn't already `continue` past above.
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  // Trailing statement without a terminating `;`.
  if (stmtStart >= 0) {
    commit(source.length, line, column);
  }

  return out;
}

/**
 * The statement containing `line` (1-based), or `null`.
 *
 * What "the current statement" means to every editor affordance that acts on
 * one: the ▶ Run lens already has the statement handed to it, but a *menu*
 * action only knows where the caret is. Falls back to the last statement when
 * the caret sits past the final one — a caret on the trailing blank line after
 * a query is still, to a user, "in" that query.
 */
export function statementAt(
  source: string,
  line: number,
  dialect: SqlDialect = "sql",
): SqlStatement | null {
  const statements = splitSql(source, dialect);
  if (statements.length === 0) return null;
  const hit = statements.find((s) => s.startLine <= line && line <= s.endLine);
  if (hit) return hit;
  return line > statements[statements.length - 1].endLine
    ? statements[statements.length - 1]
    : null;
}
