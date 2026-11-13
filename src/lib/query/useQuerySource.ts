/**
 * A query result set as a {@link GridSource} (ADR #135): the rows of one
 * `SELECT`, written back to the table they came from by its primary key.
 *
 * Two hooks, because they answer two questions and only the first needs the
 * network:
 *
 * - {@link useQueryRelation} — *which relation do these rows belong to?* It
 *   recognises a single-table `SELECT` (`editableSource.ts`), reads that
 *   table's catalog, and lines the result's columns up with it. `null` for
 *   anything else: a join, an aggregate, a key left out, a catalog that
 *   cannot be read.
 * - {@link useQuerySource} — *what may be done with them?* Given that mapping
 *   and the managed policy already resolved for the relation
 *   (`useRelationPolicy`, injected rather than read here), it states each
 *   capability and the operations that perform it.
 *
 * What a result set never offers, and why:
 *
 * - **Insert and duplicate** — a result is a view the user filtered by hand;
 *   a new row need not match the `WHERE` it would appear under, so new rows
 *   belong to the table's own tab (ADR #135).
 * - **Paste, FK navigation, export, bulk update** — not offered by this
 *   source *yet*: each needs result columns translated to table columns
 *   beyond a single cell save (an alias is not a column of the table), and
 *   each lands in its own change. `unsupported` here means "this source does
 *   not offer it", which hides it, as it was hidden before the migration.
 *
 * After a write the statement runs again (`onRefresh`) rather than the row
 * being patched, so the grid shows what the server now holds — defaults,
 * triggers, a `BIT` cast — and a deleted row the `WHERE` still matches cannot
 * linger.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import {
  mapResultColumns,
  parseSingleTableSelect,
  pkValuesOf,
  type EditableSource,
} from "@/lib/query/editableSource";
import {
  available,
  blocked,
  unsupported,
  type GridSource,
} from "@/lib/grid/gridSource";
import type { RelationPolicy } from "@/lib/policy/useRelationPolicy";
import type { CellValue, ColumnInfo, ColumnMeta, Driver } from "@/types";

/**
 * The relation a result set writes to, or `null` when it writes to none.
 *
 * The catalog is fetched straight from the backend rather than through the
 * schema store: the tab may be scoped to a database view the explorer never
 * opened a slice for. A failed read leaves no key, so the rows stay read-only,
 * which is the right answer anyway.
 */
export function useQueryRelation(
  connectionId: string,
  driver: Driver | undefined,
  sql: string | undefined,
  resultColumns: ColumnMeta[],
): EditableSource | null {
  const select = useMemo(
    () => (sql ? parseSingleTableSelect(sql, driver) : null),
    [sql, driver],
  );
  const schema = select?.schema;
  const table = select?.table;

  const [tableColumns, setTableColumns] = useState<ColumnInfo[] | null>(null);
  useEffect(() => {
    setTableColumns(null);
    if (!table) return;
    let live = true;
    api
      .listColumns(connectionId, schema, table)
      .then((cols) => live && setTableColumns(cols))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId, schema, table]);

  return useMemo(
    () =>
      select && tableColumns && tableColumns.length > 0
        ? mapResultColumns(select, tableColumns, resultColumns)
        : null,
    [select, tableColumns, resultColumns],
  );
}

export interface QuerySourceInput {
  connectionId: string;
  /** From {@link useQueryRelation}; `null` → nothing is writable. */
  relation: EditableSource | null;
  /** The managed policy, resolved for `relation`. */
  policy: RelationPolicy;
  /** Run the statement again and replace this result. */
  onRefresh: () => Promise<void>;
}

const unaddressable = (): CellValue[] => {
  throw new Error("This result cannot be written back");
};
const asIs = (row: CellValue[]) => Promise.resolve(row);

export function useQuerySource({
  connectionId,
  relation,
  policy,
  onRefresh,
}: QuerySourceInput): GridSource {
  const { t } = useTranslation();

  const qualified = relation
    ? `${relation.schema ? `${relation.schema}.` : ""}${relation.table}`
    : "";

  const keyOf = useCallback(
    (row: CellValue[]) =>
      relation ? pkValuesOf(relation, row) : unaddressable(),
    [relation],
  );

  /** Keyed by the table's key tuple; no identity — no selection — without one. */
  const getRowKey = useCallback(
    (row: CellValue[]): string | null => {
      if (!relation) return null;
      try {
        return JSON.stringify(pkValuesOf(relation, row));
      } catch {
        return null;
      }
    },
    [relation],
  );

  /**
   * Save one cell: the result column names the table column it stands for (an
   * alias is not a column of the table), and the catalog type travels with
   * the value so `update_cell` casts as the table browse does (gotcha #15).
   * A list-view path has one segment here; a result set has no documents.
   */
  const saveField = useCallback(
    async (row: CellValue[], path: string[], value: string | null) => {
      if (!relation) throw new Error("This result cannot be written back");
      const target = relation.writable.get(path[0]);
      if (!target) throw new Error(t("query.notWritable", { table: qualified }));
      await api.updateCell({
        connectionId,
        schema: relation.schema,
        table: relation.table,
        pkColumns: relation.pkColumns,
        pkValues: pkValuesOf(relation, row),
        column: target.name,
        value,
        columnType: target.data_type,
      });
    },
    [relation, connectionId, qualified, t],
  );

  /**
   * Why a result column cannot be saved: an expression is not a column of the
   * table; a policy column limit is judged on the table column it stands for.
   */
  const updatePolicyLock = policy.updateColumnLock;
  const columnLock = useCallback(
    (column: string): string | null => {
      if (!relation) return null;
      const target = relation.writable.get(column);
      if (!target) return t("query.notWritable", { table: qualified });
      return updatePolicyLock ? updatePolicyLock(target.name) : null;
    },
    [relation, qualified, updatePolicyLock, t],
  );

  const deleteRows = useCallback(
    async (pkValueRows: CellValue[][]) => {
      if (!relation) return;
      await api.deleteRows({
        connectionId,
        schema: relation.schema,
        table: relation.table,
        pkColumns: relation.pkColumns,
        pkValueRows,
      });
    },
    [relation, connectionId],
  );

  return useMemo((): GridSource => {
    const shared = {
      pkResultNames: relation?.pkResultNames,
      documentMode: false,
      keyOf,
      hydrate: asIs,
      refreshPage: onRefresh,
      refreshAll: onRefresh,
      insert: unsupported,
      duplicate: unsupported,
      paste: unsupported,
      fieldUnset: unsupported,
      fkNavigate: unsupported,
      bulkUpdate: unsupported,
      export: unsupported,
    } as const;
    if (!relation) {
      // Not one table with its key: the plain read-only grid, with no row
      // identity and therefore no selection.
      return {
        ...shared,
        addressable: false,
        getRowKey: undefined,
        update: unsupported,
        delete: unsupported,
      };
    }
    return {
      ...shared,
      addressable: true,
      getRowKey,
      update: policy.update
        ? blocked(policy.update)
        : available({ saveField, columnLock }),
      delete: policy.delete
        ? blocked(policy.delete)
        : available({
            target: {
              connectionId,
              schema: relation.schema,
              table: relation.table,
              pkColumns: relation.pkColumns,
            },
            deleteRows,
          }),
    };
  }, [
    relation,
    policy.update,
    policy.delete,
    keyOf,
    getRowKey,
    onRefresh,
    saveField,
    columnLock,
    connectionId,
    deleteRows,
  ]);
}
