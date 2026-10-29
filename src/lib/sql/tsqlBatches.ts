/**
 * Split a T-SQL script on its `GO` lines.
 *
 * `GO` is not T-SQL. It is the batch separator SSMS and `sqlcmd` understand,
 * and for a SQL Server script it is the right unit to run, not the `;`
 * statement. A `CREATE PROCEDURE`, `TRIGGER` or `FUNCTION` body is full of
 * semicolons and has to reach the server as one batch, and `splitSql` would cut
 * it apart. HuginnDB's own SQL Server export writes a `GO` after every
 * statement for the same reason (`commands::dump::export_mssql`).
 *
 * Returns `null` when the text has no `GO` line, so the caller falls back to
 * `splitSql`. A file a person wrote with plain `;` statements keeps working.
 *
 * Like `splitSql`, this is a lexer and not a parser (ADR #33). A `GO` line
 * counts only outside strings, quoted identifiers and comments: a line
 * reading `GO` inside a multi-line string literal is text. `GO <n>` (run the
 * batch n times) is not supported: the line is left in the batch, so the
 * server refuses it and names it, rather than the batch quietly running
 * once.
 */
export function splitGoBatches(source: string): string[] | null {
  const batches: string[] = [];
  let found = false;
  let start = 0;
  let i = 0;
  let lineStart = 0;
  type Mode = "code" | "string" | "bracket" | "quoted" | "line" | "block";
  let mode: Mode = "code";

  const atGoLine = (from: number): number | null => {
    // A whole line: optional spaces, GO, optional spaces, end of line (or a
    // trailing `--` comment). Returns the index just past the line break.
    const m = /^[ \t]*go[ \t]*(?:--[^\n]*)?(\r?\n|$)/i.exec(source.slice(from));
    return m ? from + m[0].length : null;
  };

  while (i <= source.length) {
    if (mode === "code" && i === lineStart) {
      const next = atGoLine(i);
      if (next !== null) {
        found = true;
        batches.push(source.slice(start, i));
        start = next;
        i = next;
        lineStart = next;
        if (i >= source.length) break;
        continue;
      }
    }
    if (i >= source.length) break;
    const ch = source[i];
    const nx = source[i + 1];
    switch (mode) {
      case "code":
        if (ch === "'") mode = "string";
        else if (ch === "[") mode = "bracket";
        else if (ch === '"') mode = "quoted";
        else if (ch === "-" && nx === "-") mode = "line";
        else if (ch === "/" && nx === "*") {
          mode = "block";
          i++;
        }
        break;
      case "string":
        // `''` is an escaped quote: skip both and stay inside.
        if (ch === "'") {
          if (nx === "'") i++;
          else mode = "code";
        }
        break;
      case "bracket":
        if (ch === "]") {
          if (nx === "]") i++;
          else mode = "code";
        }
        break;
      case "quoted":
        if (ch === '"') {
          if (nx === '"') i++;
          else mode = "code";
        }
        break;
      case "line":
        if (ch === "\n") mode = "code";
        break;
      case "block":
        if (ch === "*" && nx === "/") {
          mode = "code";
          i++;
        }
        break;
    }
    if (source[i] === "\n") lineStart = i + 1;
    i++;
  }
  if (!found) return null;
  batches.push(source.slice(start));
  return batches.map((b) => b.trim()).filter((b) => b.length > 0);
}
