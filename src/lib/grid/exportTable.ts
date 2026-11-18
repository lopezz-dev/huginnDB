/**
 * Running a table/collection export and reporting the outcome.
 *
 * One rule is worth owning here rather than repeating per call site: the user
 * dismissing the save dialog comes back from Rust as an ordinary `Err`
 * (`error::EXPORT_CANCELLED`, matched by `isExportCancelled`), not as a distinct
 * result. Announcing that as a failure would tell someone who *just cancelled*
 * that the export broke, so it is swallowed — while every other error is a real
 * one and must surface.
 *
 * `save` resolves to the path written; `announce`/`fail` keep i18n and the toast
 * surface at the call site, which is what makes this testable.
 */

import { isExportCancelled } from "@/lib/db/driver";
import type { RowsExported } from "@/types";

export async function runExport<R>(
  save: () => Promise<R>,
  announce: (written: R) => void,
  fail: (message: string) => void,
): Promise<void> {
  try {
    announce(await save());
  } catch (e) {
    const message = String(e);
    if (!isExportCancelled(message)) fail(message);
  }
}

/**
 * The notification a rows export ends with (ADR #138), shared by the table's
 * export and both of the query results' — so a cut Excel cell is reported the
 * same way wherever the file came from. Pure: the caller hands it to
 * `notify.file`.
 *
 * The cells cut to fit Excel's limit are the one thing the file itself does
 * not announce loudly (each ends in `[…]`), so the count is the description.
 */
export function rowsExportedNotice(
  written: RowsExported,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { title: string; path: string; description?: string } {
  return {
    title: t("notifications.fileSaved.rows"),
    path: written.path,
    description:
      written.truncatedCells > 0
        ? t("notifications.fileSaved.truncatedCells", { count: written.truncatedCells })
        : undefined,
  };
}
