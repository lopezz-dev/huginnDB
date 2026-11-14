/**
 * The query results' "Export data ▾" toolbar entry (ADR #135): CSV, JSON and —
 * when the result reads one table — SQL INSERT, of every row the grid holds
 * (a query is not paged; the toolbar's client-side search does not narrow the
 * file).
 *
 * **A cut result says so here too** (ADR #137). When the query returned more
 * than the row cap, the grid holds only the first 50 000, and exporting it
 * used to write those without a word. The formats then sit under "The rows
 * shown (N)", which is what they write; "Everything, from the server…" — a
 * second group that runs the statement again and streams every row — joins
 * them with the server-side export command.
 *
 * Chrome only: the source says whether exporting is allowed (`export`, the
 * policy's lock as its reason) and which table an INSERT names (`sqlTarget`);
 * `lib/query/exportResult.ts` builds the file; the backend checks the policy
 * again and writes it (`export_query_result`). Shown disabled with its reason
 * when the policy refuses it, like the table's own Export menu (ADR #96).
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Download, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import type { GridToolbarItem } from "@/components/grid/DataGrid";
import { notify } from "@/lib/notify";
import { runExport } from "@/lib/grid/exportTable";
import { reasonOf, type GridSource } from "@/lib/grid/gridSource";
import { cutBy } from "@/lib/query/resultCap";
import {
  exportFormats,
  exportResult,
  type ResultExportFormat,
} from "@/lib/query/exportResult";
import type { Driver, QueryResult } from "@/types";

/** Each format's menu label: the two CSVs say which delimiter they use. */
function formatLabel(
  format: ResultExportFormat,
  t: (key: string) => string,
): string {
  switch (format) {
    case "csv":
      return t("query.export.csvComma");
    case "csvSemicolon":
      return t("query.export.csvSemicolon");
    case "json":
      return "JSON";
    case "sql":
      return "SQL INSERT";
  }
}

export function useResultExportItem(
  source: GridSource,
  connectionId: string,
  driver: Driver | undefined,
  result: QueryResult,
): GridToolbarItem[] {
  const { t } = useTranslation();
  const { sqlTarget } = source;
  const lock = reasonOf(source.export);
  const offered = source.export.state !== "unsupported";
  const formats = useMemo(() => exportFormats(sqlTarget), [sqlTarget]);
  const cut = cutBy(result) !== null;
  const shown = result.rows.length;

  const run = useCallback(
    (format: ResultExportFormat) =>
      void runExport(
        () =>
          exportResult(connectionId, format, {
            rows: result.rows,
            columns: result.columns,
            driver,
            target: sqlTarget,
          }),
        (path) => notify.file(t("notifications.fileSaved.rows"), { path }),
        (message) => notify.error(message),
      ),
    [connectionId, sqlTarget, result, driver, t],
  );

  return useMemo(() => {
    if (!offered) return [];
    const items = (className?: string) => [
      ...(cut
        ? [
            <DropdownMenuLabel key="shown" className="text-2xs">
              {t("query.export.rowsShown", { count: shown.toLocaleString() })}
            </DropdownMenuLabel>,
          ]
        : []),
      ...formats.map((f) => (
        <DropdownMenuItem key={f} className={className} onSelect={() => run(f)}>
          {formatLabel(f, t)}
        </DropdownMenuItem>
      )),
    ];
    return [
      {
        id: "export-results",
        bar: (
          <DropdownMenu>
            <PolicyLockHint reason={lock}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!!lock}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("tableData.exportData.label")}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </PolicyLockHint>
            <DropdownMenuContent align="start">{items()}</DropdownMenuContent>
          </DropdownMenu>
        ),
        // A dropdown collapses into a submenu in the overflow menu, never a
        // nested dropdown (see `DropdownMenuSubTrigger`).
        menu: (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-xs" disabled={!!lock}>
              <Download className="mr-2 h-3.5 w-3.5" />
              {t("tableData.exportData.label")}
              {lock && <Lock className="ml-2 h-3 w-3 opacity-70" />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{items("text-xs")}</DropdownMenuSubContent>
          </DropdownMenuSub>
        ),
      },
    ];
  }, [offered, formats, run, lock, t, cut, shown]);
}
