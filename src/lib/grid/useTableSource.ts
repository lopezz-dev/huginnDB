/**
 * The table browse's {@link GridSource} (ADR #135): the rows of one table or
 * view, written back by their primary key.
 *
 * Every rule here is the one `TableDataTab` carried inline before the
 * extraction, moved rather than rewritten, and pinned by
 * `components/grid/TableDataTab.test.tsx`:
 *
 * - **The key is the whole primary key, read off the row's own values**
 *   (ADR #7). A composite key sends every column — sending only the first
 *   once made `WHERE first_pk_col = ?` match every row sharing that value —
 *   and a result that lost one of them (a projection) addresses nothing, so
 *   UPDATE/DELETE never run with an incomplete key.
 * - **The type sent with a value is the catalog's on SQL** and the field's own
 *   BSON type on MongoDB (gotcha #15, ADR #29); see `saveField`.
 * - **The policy is a lock reason per verb, plus per-column limits**
 *   (ADR #113); the backend enforces both regardless.
 * - **A view takes no inserts, and a duplicate under a projection would drop
 *   the hidden columns**, so both say why instead.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { tableTabTitle } from "@/lib/connectionLabel";
import { useTabs } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { usePolicyColumns, usePolicyLocker } from "@/lib/policy/access";
import {
  insertAvailability,
  insertBlockReason,
} from "@/lib/grid/insertAvailability";
import { isBitType } from "@/lib/grid/columnKinds";
import { parsePasteBlock } from "@/lib/grid/pasteBlock";
import { planPaste, type PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";
import type { TrimmedRows } from "@/lib/grid/trimmedCells";
import type { GridSource } from "@/lib/grid/gridSource";
import type {
  CellValue,
  ColumnInfo,
  DraftCell,
  DraftRow,
  Driver,
  QueryResult,
  RowValue,
} from "@/types";

export interface TableSourceInput {
  connectionId: string;
  schema: string | undefined;
  table: string;
  driver: Driver | undefined;
  /** The catalog columns, `undefined` while they load. */
  cols: ColumnInfo[] | undefined;
  /** The table's primary key from {@link usePrimaryKey}. */
  pkColumns: ColumnInfo[];
  /** The page on screen, `null` before the first one arrives. */
  result: QueryResult | null;
  isView: boolean;
  /** The browse sends a projection (the key columns ride along with it). */
  projected: boolean;
  trimmedRows: TrimmedRows;
  /** Reload the page on screen. */
  fetchData: () => Promise<void>;
  /** Reload the page and the total. */
  reloadAll: () => Promise<void>;
}

/** What the table tab needs beyond the source itself: the policy state its
 *  own chrome (the verb notice, the export menu) renders from. */
export interface TableSource {
  source: GridSource;
  /** The rows carry the whole key, so they can be written back. */
  hasPk: boolean;
  locks: {
    insert: string | null;
    update: string | null;
    delete: string | null;
    export: string | null;
  };
  /** Column limits per verb, as `usePolicyColumns` reports them. */
  policyColumns: ReturnType<typeof usePolicyColumns>;
}

/**
 * Every column that participates in the table's PRIMARY KEY, in catalog
 * order, plus their names. Composite keys surface every entry; a table with no
 * key yields an empty list (its rows are then read-only).
 *
 * Using `find` instead of `filter` here once silently corrupted data on
 * composite-key tables — always operate on the full list. Memoised on `cols`
 * so the names array keeps its identity: `DataGrid` reads it as
 * `pkColumnNames`, and a new array each render would defeat `GridRow`'s memo.
 */
export function usePrimaryKey(cols: ColumnInfo[] | undefined): {
  pkColumns: ColumnInfo[];
  pkColumnNames: string[];
} {
  const pkColumns = useMemo(
    () => cols?.filter((c) => c.is_primary_key) ?? [],
    [cols],
  );
  const pkColumnNames = useMemo(() => pkColumns.map((c) => c.name), [pkColumns]);
  return { pkColumns, pkColumnNames };
}

/** An empty draft: every cell untouched (NULL / the column's default). */
function emptyDraft(columnNames: string[]): DraftRow {
  const cells: Record<string, DraftCell> = {};
  for (const c of columnNames) cells[c] = { value: null, touched: false };
  return { cells, error: null, saving: false };
}

/**
 * A draft prefilled from an existing row. An auto key (a key column whose type
 * contains int/serial/rowid) is left untouched so the database picks the next
 * value, and so is a column the policy will not let the person fill — the copy
 * takes the database's default there (ADR #113).
 */
function copyDraft(
  resultColumns: string[],
  values: CellValue[],
  pkColumn: ColumnInfo | undefined,
  insertLock?: (column: string) => string | null,
): DraftRow {
  const cells: Record<string, DraftCell> = {};
  const pkIsAuto =
    pkColumn &&
    pkColumn.is_primary_key &&
    /int|serial|rowid/i.test(pkColumn.data_type);
  for (let i = 0; i < resultColumns.length; i++) {
    const name = resultColumns[i];
    if ((pkIsAuto && pkColumn?.name === name) || insertLock?.(name)) {
      cells[name] = { value: null, touched: false };
      continue;
    }
    const v = values[i];
    if (v === null || v === undefined) {
      cells[name] = { value: null, touched: true };
    } else {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      cells[name] = { value: s, touched: true };
    }
  }
  return { cells, error: null, saving: false };
}

export function useTableSource({
  connectionId,
  schema,
  table,
  driver,
  cols,
  pkColumns,
  result,
  isView,
  projected,
  trimmedRows,
  fetchData,
  reloadAll,
}: TableSourceInput): TableSource {
  const { t } = useTranslation();
  const isMongo = driver === "mongodb";

  // What the managed policy lets the person do on this relation. The browse
  // itself is gated one level up (`PolicyGate`), so everything here is about
  // the verbs of a table they may read.
  const lock = usePolicyLocker(connectionId, { schema, name: table });
  const insertLock = lock("insert");
  const updateLock = lock("update");
  const deleteLock = lock("delete");
  const exportLock = lock("export");
  // Which columns the role may write, when it limits them (ADR #113). Each
  // lock is `undefined` when the verb is not limited, so the grid's paths stay
  // exactly as they were for everyone else.
  const policyColumns = usePolicyColumns(
    connectionId,
    { schema, name: table },
    isMongo,
  );
  const updateColumnLock = useMemo(
    () =>
      policyColumns.update
        ? (column: string) => policyColumns.lock("update", column)
        : undefined,
    [policyColumns],
  );
  const insertColumnLock = useMemo(
    () =>
      policyColumns.insert
        ? (column: string) => policyColumns.lock("insert", column)
        : undefined,
    [policyColumns],
  );

  const pkColumnNames = useMemo(() => pkColumns.map((c) => c.name), [pkColumns]);

  /**
   * Index of every key column inside `result.columns`, memoised so cell
   * mutations don't re-scan the array on every keystroke. A negative entry
   * means that key column was left out of the result — the rows are then not
   * addressable.
   */
  const pkColumnIndices = useMemo(() => {
    if (!result || pkColumns.length === 0) return [];
    return pkColumns.map((c) =>
      result.columns.findIndex((rc) => rc.name === c.name),
    );
  }, [result, pkColumns]);

  // Addressable iff the table has a key AND every key column is in the page.
  // Before the first page (`result === null`) the key is taken on trust, as
  // the tab always did, so nothing flickers while the page is on its way.
  const hasPk =
    pkColumns.length > 0 &&
    (result === null || pkColumnIndices.every((i) => i >= 0));

  /**
   * The row's full key, straight from its payload. `row.original` rather than
   * a row index sidesteps the client-side filter / sort reshuffle (ADR #7).
   */
  const keyOf = useCallback(
    (rowValues: CellValue[]): CellValue[] => {
      if (pkColumns.length === 0) throw new Error("Table has no primary key");
      if (pkColumnIndices.some((i) => i < 0))
        throw new Error("Primary-key columns missing from the result set");
      return pkColumnIndices.map((i) => rowValues[i]);
    },
    [pkColumns, pkColumnIndices],
  );

  /**
   * Stable identity for a grid row (ADR #7). The key tuple when the rows are
   * addressable; otherwise the full values array, so a no-key table still has
   * a selection (#113's third strand). Two byte-identical rows then share a
   * key and select together — acceptable because every gesture that fallback
   * unlocks is read-only (copy, the `IN` filter), while every write stays
   * gated on `hasPk` and never sees it.
   *
   * Its identity matters: `DataGrid` keys a memo over every visible row on it.
   */
  const getRowKey = useCallback(
    (rowValues: CellValue[]): string | null => {
      try {
        return JSON.stringify(hasPk ? keyOf(rowValues) : rowValues);
      } catch {
        return null;
      }
    },
    [hasPk, keyOf],
  );

  /**
   * Commit one field of one row, addressed by **path** — a table cell is the
   * single-segment case of a list-view field.
   *
   * The type sent is **not** uniform:
   *
   * - On MongoDB, the field's real BSON type as `QueryResult.row_types`
   *   reported it (`typeHint`), never a guess at the display JSON: `Int32`,
   *   `Int64` and `Double` all arrive as a JSON number, so inferring would
   *   rewrite a `Long` as an `Int` the first time someone fixed a typo in it
   *   (ADR #29). A dotted path is what `$set` takes natively.
   * - On SQL the hint is deliberately IGNORED and the catalog type wins.
   *   `update_cell` reads `columnType` to decide whether a MySQL `BIT` needs
   *   its `CAST(? AS UNSIGNED)` (gotcha #15); the list view's inferred
   *   `"string"` would both miss the cast and suppress the backend's catalog
   *   fallback.
   *
   * The catalog side prefers the schema store (`cols`) over the result set,
   * because a MongoDB result reports a generic `"bson"` per column while the
   * store carries the inferred per-field type.
   */
  const saveField = useCallback(
    async (
      rowValues: CellValue[],
      path: string[],
      value: string | null,
      typeHint?: string,
    ) => {
      if (pkColumns.length === 0) {
        throw new Error("Cannot update: table has no primary key");
      }
      const pkValues = keyOf(rowValues);
      const column = path.join(".");
      const catalogType =
        cols?.find((c) => c.name === column)?.data_type ??
        result?.columns.find((c) => c.name === column)?.data_type;
      await api.updateCell({
        connectionId,
        schema,
        table,
        pkColumns: pkColumnNames,
        pkValues,
        column,
        value,
        columnType: isMongo ? (typeHint ?? catalogType) : catalogType,
      });
    },
    [
      pkColumns,
      pkColumnNames,
      keyOf,
      cols,
      result,
      connectionId,
      schema,
      table,
      isMongo,
    ],
  );

  /** MongoDB `$unset` on the document addressed by its `_id`. */
  const unsetField = useCallback(
    async (rowValues: CellValue[], path: string[]) => {
      const idValue = keyOf(rowValues)[0] ?? null;
      await api.unsetField({
        connectionId,
        collection: table,
        idValue,
        field: path.join("."),
      });
    },
    [keyOf, connectionId, table],
  );

  const deleteRows = useCallback(
    async (pkValueRows: CellValue[][]) => {
      if (pkColumns.length === 0) return;
      await api.deleteRows({
        connectionId,
        schema,
        table,
        pkColumns: pkColumnNames,
        pkValueRows,
      });
    },
    [pkColumns, pkColumnNames, connectionId, schema, table],
  );

  const planTablePaste = useCallback(
    (paste: GridPaste, rows: CellValue[][]): PastePlan => {
      const columns = result?.columns ?? [];
      return planPaste({
        block: parsePasteBlock(paste.text),
        rows,
        columns: paste.columns,
        columnIndexByName: new Map(columns.map((c, i) => [c.name, i])),
        pkColumns: pkColumnNames,
        columnInfo: new Map((cols ?? []).map((c) => [c.name, c])),
        bitColumns: new Set(
          columns.filter((c) => isBitType(c.data_type)).map((c) => c.name),
        ),
        canUpdate: !updateLock,
        canInsert: !insertLock,
        updateLock: updateColumnLock,
        insertLock: insertColumnLock,
      });
    },
    [
      result,
      pkColumnNames,
      cols,
      updateLock,
      insertLock,
      updateColumnLock,
      insertColumnLock,
    ],
  );

  const applyPaste = useCallback(
    (plan: PastePlan) =>
      api.applyPaste({
        connectionId,
        schema,
        table,
        pkColumns: pkColumnNames,
        updates: plan.updates,
        inserts: plan.inserts,
      }),
    [connectionId, schema, table, pkColumnNames],
  );

  const newDraft = useCallback(
    () => (cols ? emptyDraft(cols.map((c) => c.name)) : null),
    [cols],
  );

  const duplicateDraft = useCallback(
    (rowValues: CellValue[]) =>
      result && cols
        ? copyDraft(
            result.columns.map((c) => c.name),
            rowValues,
            pkColumns[0],
            insertColumnLock,
          )
        : null,
    [result, cols, pkColumns, insertColumnLock],
  );

  const columnType = useCallback(
    (column: string) =>
      cols?.find((c) => c.name === column)?.data_type ??
      result?.columns.find((c) => c.name === column)?.data_type,
    [cols, result],
  );

  const insertRow = useCallback(
    async (values: RowValue[]) => {
      await api.insertRow({
        connectionId,
        schema,
        table,
        // The (legacy) `RETURNING <pk>` hint: the first key column only. Never
        // use this for an UPDATE/DELETE predicate — that needs every column.
        pkColumn: pkColumns[0]?.name,
        values,
      });
    },
    [connectionId, schema, table, pkColumns],
  );

  /**
   * "Go to referenced row": open (or focus) the table the FK column points
   * at, pre-filtered to the clicked value. The referenced table lives in the
   * same connection/database. No-op for a column that is not a single-column
   * FK.
   */
  const navigateFk = useCallback(
    (columnName: string, value: CellValue) => {
      const col = cols?.find((c) => c.name === columnName);
      if (!col?.referenced_table || !col.referenced_column) return;
      // Both reads are `getState()` snapshots, not subscriptions.
      useTabs.getState().open({
        kind: "table",
        title: tableTabTitle(
          useConnections.getState().profiles,
          connectionId,
          col.referenced_table,
        ),
        connectionId,
        schema: col.referenced_schema ?? undefined,
        table: col.referenced_table,
        initialFilters: [{ column: col.referenced_column, op: "eq", value }],
      });
    },
    [cols, connectionId],
  );

  // Why the rows cannot be written at all, when they cannot.
  const keyMissing = hasPk
    ? null
    : t(
        pkColumns.length === 0
          ? "dataGrid.writeBlocked.noPk"
          : "dataGrid.writeBlocked.pkHidden",
      );
  // Whether an insert can begin, and if not why (#267). Undecided (`null`)
  // until the columns load, so a table never flashes "no primary key" while
  // its key is still on the way — the grid then shows no Insert at all.
  const insertBlock = cols
    ? insertAvailability({
        isView,
        pkColumnCount: pkColumns.length,
        pkInResult: hasPk,
        policyLock: insertLock,
      })
    : null;
  const insert = !cols
    ? ""
    : insertBlock
      ? insertBlockReason(insertBlock, t)
      : null;

  const can = useMemo(
    () => ({
      update: keyMissing ?? updateLock,
      delete: keyMissing ?? deleteLock,
      insert,
      // A duplicate copies the row as the page holds it, so under a projection
      // it would silently drop every hidden column's value.
      duplicate:
        keyMissing ??
        (projected ? t("dataGrid.writeBlocked.projected") : null) ??
        insertLock,
      // The plan itself respects the update/insert locks (it skips what they
      // refuse), so a paste needs only addressable rows.
      paste: keyMissing,
      bulkUpdate: keyMissing ?? updateLock,
      export: exportLock,
      fieldUnset: isMongo ? null : t("dataGrid.writeBlocked.documentsOnly"),
      updateColumnLock,
      insertColumnLock,
    }),
    [
      keyMissing,
      updateLock,
      deleteLock,
      insert,
      projected,
      insertLock,
      exportLock,
      isMongo,
      updateColumnLock,
      insertColumnLock,
      t,
    ],
  );

  const identity = useMemo(
    () =>
      hasPk
        ? { connectionId, schema, table, pkColumns: pkColumnNames }
        : null,
    [hasPk, connectionId, schema, table, pkColumnNames],
  );

  const source: GridSource = useMemo(
    () => ({
      identity,
      can,
      pkResultNames: pkColumnNames,
      documentMode: isMongo,
      keyOf,
      getRowKey,
      hydrate: trimmedRows.hydrate,
      saveField,
      unsetField,
      deleteRows,
      planPaste: planTablePaste,
      applyPaste,
      newDraft,
      duplicateDraft,
      columnType,
      insertRow,
      refreshPage: fetchData,
      refreshAll: reloadAll,
      navigateFk,
    }),
    [
      identity,
      can,
      pkColumnNames,
      isMongo,
      keyOf,
      getRowKey,
      trimmedRows.hydrate,
      saveField,
      unsetField,
      deleteRows,
      planTablePaste,
      applyPaste,
      newDraft,
      duplicateDraft,
      columnType,
      insertRow,
      fetchData,
      reloadAll,
      navigateFk,
    ],
  );

  return {
    source,
    hasPk,
    locks: {
      insert: insertLock,
      update: updateLock,
      delete: deleteLock,
      export: exportLock,
    },
    policyColumns,
  };
}
