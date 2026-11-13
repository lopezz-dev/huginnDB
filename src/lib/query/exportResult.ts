/**
 * Serialise a query's result set for "Export results" (ADR #135).
 *
 * A query the person runs returns every row — it is not paged — so what the
 * grid holds *is* the result, and the file is built from it here; the backend
 * only checks the policy and writes it (`export_query_result`). The formats
 * reuse the clipboard serialisers, so a file and a copy of the same rows read
 * the same:
 *
 * - **CSV** and **JSON** carry the columns as the result names them — aliases
 *   and expressions included, since that is what the query asked for.
 * - **SQL INSERT** addresses the table the result reads, through its
 *   `SqlTarget` (aliases become table columns, expressions are left out), and
 *   is offered only when there is one: a result over several tables has no
 *   table to insert into.
 */

import { api } from "@/lib/tauri";
import { toBulk, toCsv, type SqlTarget } from "@/lib/grid/copyFormats";
import type { CellValue, ColumnMeta, Driver } from "@/types";

export type ResultExportFormat = "csv" | "json" | "sql";

export interface ResultExportInput {
  rows: CellValue[][];
  columns: ColumnMeta[];
  driver: Driver | undefined;
  target: SqlTarget | undefined;
}

/** The formats a result can be exported as: SQL only with a table to name. */
export function exportFormats(target: SqlTarget | undefined): ResultExportFormat[] {
  return target ? ["csv", "json", "sql"] : ["csv", "json"];
}

export function serializeResult(
  format: ResultExportFormat,
  { rows, columns, driver, target }: ResultExportInput,
): string {
  switch (format) {
    case "csv":
      return toCsv(rows, columns);
    case "json":
      return toBulk(rows, "json", { columns, driver });
    case "sql":
      if (!target) throw new Error("A result over several tables has no table to insert into");
      return `${toBulk(rows, "insert", { columns, driver, target })}\n`;
  }
}

/** The file name the save dialog suggests, without its extension. */
export function suggestedName(target: SqlTarget | undefined): string {
  return target ? `${target.table}_results` : "query_results";
}

/**
 * Serialise the result and hand it to the backend, which checks the policy,
 * asks where to save it and writes it. Resolves to the written path; rejects
 * when the policy refuses or the person cancels the dialog.
 */
export function exportResult(
  connectionId: string,
  format: ResultExportFormat,
  input: ResultExportInput,
): Promise<string> {
  return api.exportQueryResult(
    connectionId,
    suggestedName(input.target),
    format,
    serializeResult(format, input),
  );
}
