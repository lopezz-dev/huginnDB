/**
 * Pick a `.sql` file and split it into statement texts — the frontend half of
 * the import flow.
 *
 * Execution (and the target-database choice for a multi-DB connection) happens
 * in `ImportSqlDialog`, which the caller opens with the returned list. `null`
 * when the user cancels the picker or the file holds no statements.
 *
 * `t` is passed in rather than imported: this runs from a component's event
 * handler, so the caller already has the live `t` from `useTranslation` and
 * reaching for the module-level `i18n` instance instead would ignore a language
 * change made in this session.
 */

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { splitSql } from "@/lib/sql/sqlSplit";
import { splitGoBatches } from "@/lib/sql/tsqlBatches";
import { api } from "@/lib/tauri";
import type { Driver } from "@/types";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Statement texts for `driver`. A SQL Server script with `GO` lines runs as
 *  its batches (a procedure body must not be cut at its semicolons); anything
 *  else is split on `;`. */
export function splitForImport(text: string, driver: Driver | undefined): string[] {
  const batches = driver === "sqlserver" ? splitGoBatches(text) : null;
  return batches ?? splitSql(text).map((s) => s.text);
}

export async function pickAndSplitSqlFile(
  t: Translate,
  driver: Driver | undefined,
): Promise<string[] | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: t("schema.importSql.pickTitle"),
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  if (typeof picked !== "string" || !picked) return null;
  const text = await api.readTextFile(picked);
  const statements = splitForImport(text, driver);
  return statements.length > 0 ? statements : null;
}
