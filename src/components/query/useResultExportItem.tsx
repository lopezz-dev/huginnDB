/**
 * The query results' "Export data ▾" toolbar entry (ADR #135): CSV, JSON and —
 * when the result reads one table — SQL INSERT, of every row the grid holds
 * (a query is not paged; the toolbar's client-side search does not narrow the
 * file).
 *
 * **A cut result says so here too** (ADR #137). When the query returned more
 * than the row cap, the grid holds only the first 50 000, and exporting it
 * used to write those without a word. The formats then sit under "The rows
 * shown (N)", which is what they write, and a second group, "Everything,
 * from the server…", runs the statement again on the server and streams every
 * row to the file (`export_query_rows`), with no row cap and the same bytes.
 *
 * The server group is offered only where it means something: a cut result
 * (the backend cuts only what its classifier read as a read, so this is a
 * read by `db::classify`'s own decision, not a second one here), with its
 * statement known (one of several sets has none: re-running could not say
 * which set), and not on MongoDB, which the command does not export. The
 * backend checks all of it again, and the policy, before the save dialog
 * opens (ADR #96).
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import type { GridToolbarItem } from "@/components/grid/DataGrid";
import { notify } from "@/lib/notify";
import { api } from "@/lib/tauri";
import { runExport } from "@/lib/grid/exportTable";
import { reasonOf, type GridSource } from "@/lib/grid/gridSource";
import { cutBy } from "@/lib/query/resultCap";
import {
  exportFormats,
  exportResult,
  type ResultExportFormat,
} from "@/lib/query/exportResult";
import type { Driver, QueryResult, ServerSqlTarget } from "@/types";

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
  /** The statement behind `result`; `undefined` when it cannot be re-run. */
  sql: string | undefined,
): GridToolbarItem[] {
  const { t } = useTranslation();
  const { sqlTarget } = source;
  const lock = reasonOf(source.export);
  const offered = source.export.state !== "unsupported";
  const formats = useMemo(() => exportFormats(sqlTarget), [sqlTarget]);
  const cut = cutBy(result) !== null;
  const shown = result.rows.length;
  const fromServer = cut && !!sql && driver !== "mongodb";

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

  /** "Everything, from the server…": the statement again, every row. */
  const runFromServer = useCallback(
    (format: ResultExportFormat) => {
      if (!sql) return;
      // A function cannot cross IPC: the target travels with `columnOf`
      // evaluated for each result column, in result order.
      const target: ServerSqlTarget | undefined =
        format === "sql" && sqlTarget
          ? {
              table: sqlTarget.table,
              columns: result.columns.map((c) => sqlTarget.columnOf(c.name)),
            }
          : undefined;
      void runExport(
        () => api.exportQueryRows(connectionId, sql, format, target),
        (path) => notify.file(t("notifications.fileSaved.rows"), { path }),
        (message) => notify.error(message),
      );
    },
    [connectionId, sql, sqlTarget, result.columns, t],
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
      ...(fromServer
        ? [
            <DropdownMenuSeparator key="server-sep" />,
            <DropdownMenuLabel key="server" className="text-2xs">
              {t("query.export.fromServer")}
            </DropdownMenuLabel>,
            ...formats.map((f) => (
              <DropdownMenuItem
                key={`server-${f}`}
                className={className}
                title={t("query.export.fromServerHint")}
                onSelect={() => runFromServer(f)}
              >
                {formatLabel(f, t)}…
              </DropdownMenuItem>
            )),
          ]
        : []),
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
  }, [offered, formats, run, runFromServer, fromServer, lock, t, cut, shown]);
}
