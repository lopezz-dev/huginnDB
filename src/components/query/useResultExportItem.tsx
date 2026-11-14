/**
 * The query results' "Export data ▾" toolbar entry (ADR #135): CSV, JSON and —
 * when the result reads one table — SQL INSERT, of every row the query
 * returned (a query is not paged, so the grid holds them all; the toolbar's
 * client-side search does not narrow the file).
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
    const items = (className?: string) =>
      formats.map((f) => (
        <DropdownMenuItem key={f} className={className} onSelect={() => run(f)}>
          {formatLabel(f, t)}
        </DropdownMenuItem>
      ));
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
  }, [offered, formats, run, lock, t]);
}
