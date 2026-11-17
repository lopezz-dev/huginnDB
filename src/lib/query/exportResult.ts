/**
 * Export a query's result set: "Export data ▾" on the query results (ADR #135).
 *
 * A query the person runs returns every row up to the cap — it is not paged —
 * so what the grid holds *is* the result, and those rows are sent to the
 * backend as they are. **The file is written in Rust** (`export_query_result`,
 * `db::result_export::RowWriter`), the one writer every exported file goes
 * through (ADR #138): the rows shown, "Everything, from the server…" and a
 * table's rows write the same bytes for the same values, and Excel — a binary
 * format nothing here can build — is just one more format. The clipboard's
 * serialisers (`lib/grid/copyFormats`) write those same bytes for the text
 * formats; a golden test shared by both languages keeps them so.
 *
 * - **CSV**, **JSON** and **Excel** carry the columns as the result names them
 *   — aliases and expressions included, since that is what the query asked
 *   for. CSV comes in two flavours the person picks when exporting:
 *   comma-separated, and semicolon-separated for an Excel whose locale uses the
 *   comma as its decimal separator. Who exports knows where the file is going;
 *   nothing here guesses it from the interface language.
 * - **SQL INSERT** addresses the table the result reads, through its
 *   `SqlTarget` (aliases become table columns, expressions are left out), and
 *   is offered only when there is one: a result over several tables has no
 *   table to insert into.
 */

import { api } from "@/lib/tauri";
import type { SqlTarget } from "@/lib/grid/copyFormats";
import type { CellValue, ColumnMeta, ResultExportFormat, ServerSqlTarget } from "@/types";

export type { ResultExportFormat } from "@/types";

/** The formats every result can be exported as, in menu order. */
const ALWAYS: readonly ResultExportFormat[] = ["csv", "csvSemicolon", "xlsx", "json"];

/** Every format, in menu order: what a table's rows can be exported as,
 *  since a table always has a table to insert into. */
export const EXPORT_FORMATS: readonly ResultExportFormat[] = [...ALWAYS, "sql"];

/** The formats a result can be exported as: SQL only with a table to name. */
export function exportFormats(target: SqlTarget | undefined): ResultExportFormat[] {
  return target ? [...EXPORT_FORMATS] : [...ALWAYS];
}

/**
 * The table a SQL export inserts into, as the backend takes it. A function
 * cannot cross IPC, so `columnOf` is evaluated for each result column, in
 * result order. `undefined` for every other format, and without a table.
 */
export function serverTarget(
  format: ResultExportFormat,
  target: SqlTarget | undefined,
  columns: ColumnMeta[],
): ServerSqlTarget | undefined {
  if (format !== "sql" || !target) return undefined;
  return { table: target.table, columns: columns.map((c) => target.columnOf(c.name)) };
}

export interface ResultExportInput {
  rows: CellValue[][];
  columns: ColumnMeta[];
  target: SqlTarget | undefined;
}

/**
 * Send the rows the grid holds to the backend, which checks the policy, asks
 * where to save them and writes them in `format`. Resolves to the written
 * path; rejects when the policy refuses, the person cancels the dialog, or a
 * SQL export has no table to insert into.
 */
export function exportResult(
  connectionId: string,
  format: ResultExportFormat,
  { rows, columns, target }: ResultExportInput,
): Promise<string> {
  return api.exportQueryResult(
    connectionId,
    format,
    columns.map((c) => c.name),
    rows,
    serverTarget(format, target, columns),
  );
}
