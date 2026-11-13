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
 * - **A view never takes rows from the grid**: insert and duplicate are
 *   unsupported there — not offered, rather than disabled with a reason
 *   (ADR #136) — and a paste's overflow rows are left out saying why.
 * - **A duplicate under a projection would drop the hidden columns**, so it is
 *   blocked with that reason.
 *
 * What the policy allows arrives resolved (`policy`, from
 * `useRelationPolicy`): this producer turns it into capabilities, it does not
 * read it.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { isFkColumn, openReferencedRow } from "@/lib/grid/fkNavigation";
import {
  insertAvailability,
  insertBlockReason,
} from "@/lib/grid/insertAvailability";
import { isBitType } from "@/lib/grid/columnKinds";
import { parsePasteBlock } from "@/lib/grid/pasteBlock";
import { planPaste, type PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";
import type { TrimmedRows } from "@/lib/grid/trimmedCells";
import type { RelationPolicy } from "@/lib/policy/useRelationPolicy";
import {
  AVAILABLE,
  available,
  blocked,
  pending,
  unsupported,
  type Availability,
  type Capability,
  type DraftCommitOps,
  type GridSource,
} from "@/lib/grid/gridSource";
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
  /** What the managed policy allows on this table. */
  policy: RelationPolicy;
  trimmedRows: TrimmedRows;
  /** Reload the page on screen. */
  fetchData: () => Promise<void>;
  /** Reload the page and the total. */
  reloadAll: () => Promise<void>;
}

/**
 * Every column that participates in the table's PRIMARY KEY, in catalog
 * order, plus their names. Composite keys surface every entry; a table with no
 * key yields an empty list (its rows are then read-only).
 *
 * A separate hook because the browse needs the key names before the page
 * exists — the projection it sends carries them. Using `find` instead of
 * `filter` here once silently corrupted data on composite-key tables. Memoised
 * on `cols` so the names keep their identity: `DataGrid` reads them as
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

const sameColumn = (name: string) => name;

/** The first reason that applies, as a capability; available when none does. */
function gate<Ops>(
  reasons: (string | null)[],
  ops: () => Ops,
): Capability<Ops> {
  const reason = reasons.find((r): r is string => r !== null);
  return reason !== undefined ? blocked(reason) : available(ops());
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
  policy,
  trimmedRows,
  fetchData,
  reloadAll,
}: TableSourceInput): GridSource {
  const { t } = useTranslation();
  const isMongo = driver === "mongodb";

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
   *
   * Its identity reaches the grid as `onCellSave`, which keys the column memo
   * (`useGridColumns`): the list below is exactly what it closes over.
   */
  const saveField = useCallback(
    async (
      rowValues: CellValue[],
      path: string[],
      value: string | null,
      typeHint?: string,
    ) => {
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
    [pkColumnNames, keyOf, cols, result, connectionId, schema, table, isMongo],
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
      await api.deleteRows({
        connectionId,
        schema,
        table,
        pkColumns: pkColumnNames,
        pkValueRows,
      });
    },
    [pkColumnNames, connectionId, schema, table],
  );

  const planTablePaste = useCallback(
    (paste: GridPaste, rows: CellValue[][]): PastePlan => {
      const columns = result?.columns ?? [];
      return planPaste({
        block: parsePasteBlock(paste.text),
        rows,
        columns: paste.columns,
        columnIndexByName: new Map(columns.map((c, i) => [c.name, i])),
        // A table's result names are its column names: no `columnOf`.
        keyOf,
        pkColumns: pkColumnNames,
        columnInfo: new Map((cols ?? []).map((c) => [c.name, c])),
        bitColumns: new Set(
          columns.filter((c) => isBitType(c.data_type)).map((c) => c.name),
        ),
        // The plan respects the locks itself: it skips what they refuse.
        canUpdate: !policy.update,
        newRows: isView ? "view" : policy.insert ? "policy" : "allowed",
        updateLock: policy.updateColumnLock,
        insertLock: policy.insertColumnLock,
      });
    },
    [result, keyOf, pkColumnNames, cols, policy, isView],
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

  /** The table's single-column FK columns — a table's result names are its
   *  column names. Memoised: the grid keys its header and row memos on it. */
  const fkColumns = useMemo(
    () => (cols ?? []).filter(isFkColumn),
    [cols],
  );
  const fkColumnNames = useMemo(() => fkColumns.map((c) => c.name), [fkColumns]);

  /** Where an FK cell's new value must exist: the editor picks from there.
   *  The referenced schema defaults to this table's, as the grid always did. */
  const fkRefOf = useCallback(
    (columnName: string) => {
      const col = fkColumns.find((c) => c.name === columnName);
      return col
        ? {
            connectionId,
            schema: col.referenced_schema ?? schema ?? undefined,
            table: col.referenced_table,
            column: col.referenced_column,
            nullable: col.nullable,
          }
        : undefined;
    },
    [fkColumns, connectionId, schema],
  );

  /** "Go to referenced row" (`lib/grid/fkNavigation.ts`). */
  const navigateFk = useCallback(
    (columnName: string, value: CellValue) => {
      const col = fkColumns.find((c) => c.name === columnName);
      if (col) openReferencedRow(connectionId, col, value);
    },
    [fkColumns, connectionId],
  );

  /** "Copy as SQL": a table's result names are its column names. Memoised:
   *  every visible row's memo keys on it. */
  const sqlTarget = useMemo(
    () => ({ table, columnOf: sameColumn, pkColumns: pkColumnNames }),
    [table, pkColumnNames],
  );

  // Why the rows cannot be written at all, when they cannot.
  const keyMissing = hasPk
    ? null
    : t(
        pkColumns.length === 0
          ? "dataGrid.writeBlocked.noPk"
          : "dataGrid.writeBlocked.pkHidden",
      );

  return useMemo((): GridSource => {
    const commit: DraftCommitOps = {
      columnType,
      insertRow,
      columnLock: policy.insertColumnLock,
    };
    // Whether an insert can begin, and if not why (#267). A view never can,
    // so it is not offered (ADR #136); otherwise pending until the columns
    // load, so a table never flashes "no primary key" while its key is still
    // on the way.
    const insertBlock = cols
      ? insertAvailability({
          pkColumnCount: pkColumns.length,
          pkInResult: hasPk,
          policyLock: policy.insert,
        })
      : null;
    const insert: GridSource["insert"] = isView
      ? unsupported
      : !cols
      ? pending
      : insertBlock
        ? blocked(insertBlockReason(insertBlock, t))
        : available({
            ...commit,
            newDraft: () => emptyDraft(cols.map((c) => c.name)),
          });
    const bulkUpdate: Availability = gate([keyMissing, policy.update], () => ({}));
    return {
      addressable: hasPk,
      pkResultNames: pkColumnNames,
      documentMode: isMongo,
      sqlTarget,
      keyOf,
      getRowKey,
      hydrate: trimmedRows.hydrate,
      refreshPage: fetchData,
      refreshAll: reloadAll,
      update: gate([keyMissing, policy.update], () => ({
        saveField,
        columnLock: policy.updateColumnLock,
        fkRefOf,
      })),
      delete: gate([keyMissing, policy.delete], () => ({
        target: { connectionId, schema, table, pkColumns: pkColumnNames },
        deleteRows,
      })),
      insert,
      // A duplicate is an insert, so a view does not offer it either. Under a
      // projection it would silently drop every hidden column's value.
      duplicate: isView ? unsupported : gate(
        [
          keyMissing,
          projected ? t("dataGrid.writeBlocked.projected") : null,
          policy.insert,
        ],
        () => ({
          ...commit,
          duplicateDraft: (row: CellValue[]) =>
            copyDraft(
              (result?.columns ?? []).map((c) => c.name),
              row,
              pkColumns[0],
              policy.insertColumnLock,
            ),
        }),
      ),
      // The plan skips what the update/insert locks refuse, so a paste needs
      // only addressable rows.
      paste: gate([keyMissing], () => ({
        relationLabel: `${schema ? `${schema}.` : ""}${table}`,
        planPaste: planTablePaste,
        applyPaste,
      })),
      fieldUnset: gate(
        [isMongo ? null : t("dataGrid.writeBlocked.documentsOnly")],
        () => ({ unsetField }),
      ),
      fkNavigate: fkColumnNames.length
        ? available({ columns: fkColumnNames, navigateFk })
        : unsupported,
      bulkUpdate,
      export: policy.export ? blocked(policy.export) : AVAILABLE,
    };
  }, [
    cols,
    isView,
    pkColumns,
    hasPk,
    keyMissing,
    projected,
    policy,
    t,
    connectionId,
    schema,
    table,
    pkColumnNames,
    isMongo,
    keyOf,
    getRowKey,
    trimmedRows.hydrate,
    fetchData,
    reloadAll,
    saveField,
    deleteRows,
    columnType,
    insertRow,
    result,
    planTablePaste,
    applyPaste,
    unsetField,
    navigateFk,
    fkColumnNames,
    sqlTarget,
    fkRefOf,
  ]);
}
