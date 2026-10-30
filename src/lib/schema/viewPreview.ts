import type { Driver } from "@/types";

/** Rows the view editor's live preview fetches. */
export const VIEW_PREVIEW_ROWS = 100;

const PREVIEW_ALIAS = "__huginn_view_preview";

/**
 * Wrap a draft view body so the live preview can run it without parsing or
 * rewriting the user's SQL: no limit-clause juggling around an existing
 * `ORDER BY`, a subquery or a `UNION`.
 *
 * The row cap is per dialect. T-SQL has no `LIMIT`, and appending one made
 * every SQL Server preview fail with "Incorrect syntax near 'LIMIT'". `TOP n`
 * is the spelling every supported version (2012+) accepts on a derived table,
 * the same choice `selectSnippet` makes for the same reason.
 */
export function viewPreviewSql(query: string, driver: Driver | undefined): string {
  const body = query.trim().replace(/;\s*$/, "");
  if (driver === "sqlserver") {
    return `SELECT TOP ${VIEW_PREVIEW_ROWS} * FROM (${body}) AS ${PREVIEW_ALIAS}`;
  }
  return `SELECT * FROM (${body}) AS ${PREVIEW_ALIAS} LIMIT ${VIEW_PREVIEW_ROWS}`;
}
