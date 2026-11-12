/**
 * The query tab's result grid — `DataGrid` plus, when the statement allows it,
 * the table browser's write gestures: edit a cell, delete a row, delete the
 * whole selection.
 *
 * Whether it allows it is `lib/query/editableSource.ts`'s call: one `SELECT`
 * over one table, with the table's whole primary key in the result. Anything
 * else — a join, an aggregate, a key left out — renders exactly the read-only
 * grid this used to be. Inserting and duplicating are deliberately absent: a
 * result set is a view the user filtered by hand, and a new row may not even
 * match its `WHERE`, so they stay where the rows are the table's own
 * (`TableDataTab`).
 *
 * After a write the statement is run again rather than the row patched in
 * place, so what the grid shows is what the server now holds — defaults,
 * triggers, a `BIT` cast — and a deleted row that the `WHERE` would still
 * match cannot linger.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataGrid } from "@/components/grid/DataGrid";
import { DeleteRowsDialog } from "@/components/grid/dialogs/DeleteRowsDialog";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { usePolicyColumns, usePolicyLocker } from "@/lib/policy/access";
import {
  mapResultColumns,
  parseSingleTableSelect,
  pkValuesOf,
} from "@/lib/query/editableSource";
import { usePreferences } from "@/stores/preferences/preferences";
import { useGridSelection } from "@/stores/grid/gridSelection";
import type { CellValue, ColumnInfo, Driver, QueryResult } from "@/types";

interface Props {
  tabId: string;
  /** The connection (or database view) the statement ran on. */
  connectionId: string;
  driver: Driver | undefined;
  result: QueryResult;
  /** The statement that produced `result`; absent → read-only. */
  sql: string | undefined;
  globalFilter: string;
  onGlobalFilterChange: (v: string) => void;
  /** Run `sql` again and replace this panel's result. */
  onRefresh: () => Promise<void>;
}

export function QueryResultGrid({
  tabId,
  connectionId,
  driver,
  result,
  sql,
  globalFilter,
  onGlobalFilterChange,
  onRefresh,
}: Props) {
  const { t } = useTranslation();

  const select = useMemo(
    () => (sql ? parseSingleTableSelect(sql, driver) : null),
    [sql, driver],
  );

  // The catalog columns of the table the statement read — for its primary
  // key and the types `update_cell` casts by. Fetched straight from the
  // backend rather than through the schema store: the tab may be scoped to a
  // database view the explorer never opened a slice for.
  const [tableColumns, setTableColumns] = useState<ColumnInfo[] | null>(null);
  const schema = select?.schema;
  const table = select?.table;
  useEffect(() => {
    setTableColumns(null);
    if (!table) return;
    let live = true;
    api
      .listColumns(connectionId, schema, table)
      .then((cols) => live && setTableColumns(cols))
      // No columns → no key → read-only, which is the answer anyway.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId, schema, table]);

  const source = useMemo(
    () =>
      select && tableColumns && tableColumns.length > 0
        ? mapResultColumns(select, tableColumns, result.columns)
        : null,
    [select, tableColumns, result.columns],
  );

  const relation = source ? { schema: source.schema, name: source.table } : null;
  const lock = usePolicyLocker(connectionId, relation);
  const updateLock = source ? lock("update") : null;
  const deleteLock = source ? lock("delete") : null;
  const policyColumns = usePolicyColumns(connectionId, relation);

  const qualified = source
    ? `${source.schema ? `${source.schema}.` : ""}${source.table}`
    : "";

  /** Read-only reason per result column, or `null` where a cell can be saved. */
  const columnLock = useCallback(
    (column: string): string | null => {
      if (!source) return null;
      const target = source.writable.get(column);
      if (!target) return t("query.notWritable", { table: qualified });
      return policyColumns.update ? policyColumns.lock("update", target.name) : null;
    },
    [source, qualified, policyColumns, t],
  );

  const onCellSave = useCallback(
    async (rowValues: CellValue[], columnName: string, value: string | null) => {
      if (!source) throw new Error("This result cannot be written back");
      const target = source.writable.get(columnName);
      if (!target) throw new Error(t("query.notWritable", { table: qualified }));
      await api.updateCell({
        connectionId,
        schema: source.schema,
        table: source.table,
        pkColumns: source.pkColumns,
        pkValues: pkValuesOf(source, rowValues),
        column: target.name,
        value,
        columnType: target.data_type,
      });
      await onRefresh();
    },
    [source, connectionId, qualified, onRefresh, t],
  );

  const getRowKey = useCallback(
    (rowValues: CellValue[]): string | null => {
      if (!source) return null;
      try {
        return JSON.stringify(pkValuesOf(source, rowValues));
      } catch {
        return null;
      }
    },
    [source],
  );

  // Selection count in the status bar, as the table browser reports it.
  const reportSelection = useGridSelection((s) => s.report);
  const clearSelection = useGridSelection((s) => s.clear);
  const onSelectionChange = useCallback(
    (count: number, total: number) => reportSelection(tabId, count, total),
    [reportSelection, tabId],
  );
  useEffect(() => () => clearSelection(tabId), [tabId, clearSelection]);

  const [pendingDelete, setPendingDelete] = useState<CellValue[][] | null>(null);

  const runDelete = useCallback(
    async (pkValueRows: CellValue[][]) => {
      if (!source) return;
      await api.deleteRows({
        connectionId,
        schema: source.schema,
        table: source.table,
        pkColumns: source.pkColumns,
        pkValueRows,
      });
      setPendingDelete(null);
      await onRefresh();
    },
    [source, connectionId, onRefresh],
  );

  /** Same rule as the table browser: confirm unless the user turned it off. */
  const requestDelete = useCallback(
    (rows: CellValue[][]) => {
      if (!source || rows.length === 0) return;
      const pkValueRows = rows.map((r) => pkValuesOf(source, r));
      if (usePreferences.getState().prefs.ui.confirmDestructive) {
        setPendingDelete(pkValueRows);
      } else {
        void runDelete(pkValueRows).catch((e: unknown) =>
          notify.error(t("tableData.deleteFailedTitle"), {
            description: String(e),
          }),
        );
      }
    },
    [source, runDelete, t],
  );
  const onDeleteRow = useCallback(
    (row: CellValue[]) => requestDelete([row]),
    [requestDelete],
  );

  const canUpdate = !!source && !updateLock;
  const canDelete = !!source && !deleteLock;

  // `DataGrid` sizes itself with `h-full`, so it needs a box with a definite
  // height: a flex share of the results column, `overflow-hidden` so it may
  // shrink to it (contract K in `uiContracts.test.ts`).
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <DataGrid
        result={result}
        tabId={tabId}
        driver={driver}
        globalFilter={globalFilter}
        onGlobalFilterChange={onGlobalFilterChange}
        editable={canUpdate}
        columnLock={canUpdate ? columnLock : undefined}
        onCellSave={canUpdate ? onCellSave : undefined}
        pkColumnNames={source?.pkResultNames}
        onDeleteRow={canDelete ? onDeleteRow : undefined}
        onBulkDelete={canDelete ? requestDelete : undefined}
        getRowKey={source ? getRowKey : undefined}
        onSelectionChange={source ? onSelectionChange : undefined}
      />
      {pendingDelete && source && (
        <DeleteRowsDialog
          connectionId={connectionId}
          schema={source.schema}
          table={source.table}
          pkColumns={source.pkColumns}
          pkValueRows={pendingDelete}
          onDelete={() => runDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
