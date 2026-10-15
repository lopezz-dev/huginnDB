/**
 * Render an ordered statement list as the text a DDL preview shows.
 *
 * Semicolon-and-newline separated, with a trailing semicolon so the last
 * statement reads like the others — and nothing at all for an empty list, so an
 * unchanged table previews as blank rather than as a lone `;`.
 *
 * The structure and view editors had this expression written out identically.
 * It is presentation only: the statements themselves come from the Rust builder
 * that also runs them (ADR #16), and this text is never executed.
 */
export function joinStatements(statements: string[]): string {
  return statements.join(";\n") + (statements.length ? ";" : "");
}
