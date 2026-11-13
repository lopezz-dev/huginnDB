/**
 * A query result set as a {@link GridSource} (ADR #135): the rows of one
 * `SELECT`, written back to the table they came from by its primary key.
 *
 * Two hooks, because they answer two questions and only the first needs the
 * network:
 *
 * - {@link useQueryRelation} — *which relation do these rows belong to?* It
 *   recognises a single-table `SELECT` (`editableSource.ts`), reads that
 *   table's catalog, and lines the result's columns up with it: `columns`
 *   when they line up (enough to read through them), `editable` when the
 *   whole key came back too (enough to write). `null` for anything else: a
 *   join, an aggregate, a catalog that cannot be read.
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
 * - **Bulk update** — not offered by this
 *   source *yet*: each needs result columns translated to table columns
 *   beyond a single cell save (an alias is not a column of the table), and
 *   each lands in its own change. `unsupported` here means "this source does
 *   not offer it", which hides it, as it was hidden before the migration.
 *
 * FK navigation needs only `columns`, not the key: it reads, so a `SELECT`
 * that left the key out can still follow its foreign keys.
 *
 * A paste writes the cells of existing rows, each to the table column its
 * result column stands for; an expression's cells are left out, and so are
 * the block's rows below the last result row, which a result does not add
 * (`pastePlan.ts`, ADR #114).
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
  parseSingleTableSelect,
  pkValuesOf,
  resolveResultColumns,
  type EditableSource,
  type ResultColumns,
} from "@/lib/query/editableSource";
import { isFkColumn, openReferencedRow } from "@/lib/grid/fkNavigation";
import { isBitType } from "@/lib/grid/columnKinds";
import { parsePasteBlock } from "@/lib/grid/pasteBlock";
import { planPaste, type PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";
import {
  AVAILABLE,
  available,
  blocked,
  unsupported,
  type GridSource,
} from "@/lib/grid/gridSource";
import type { RelationPolicy } from "@/lib/policy/useRelationPolicy";
import type { CellValue, ColumnInfo, ColumnMeta, Driver } from "@/types";

/** What a result set is, relative to the one table it reads. */
export interface QueryRelation {
  /** Its columns lined up with the table's. */
  columns: ResultColumns;
  /** The writable view, when the whole key came back; `null` otherwise. */
  editable: EditableSource | null;
}

/**
 * The relation a result set reads, or `null` when it is not one table.
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
): QueryRelation | null {
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
        ? resolveResultColumns(select, tableColumns, resultColumns)
        : null,
    [select, tableColumns, resultColumns],
  );
}

export interface QuerySourceInput {
  connectionId: string;
  /** From {@link useQueryRelation}; `null` → read-only, no FK navigation. */
  resolved: QueryRelation | null;
  /** The result's columns, in row order — what a pasted block lands on. */
  resultColumns: ColumnMeta[];
  /** The managed policy, resolved for the relation. */
  policy: RelationPolicy;
  /** Run the statement again and replace this result. */
  onRefresh: () => Promise<void>;
}

const unaddressable = (): CellValue[] => {
  throw new Error("This result cannot be written back");
};
const asIs = (row: CellValue[]) => Promise.resolve(row);
const asFk = (c: ColumnInfo) => (isFkColumn(c) ? c : null);

export function useQuerySource({
  connectionId,
  resolved,
  resultColumns,
  policy,
  onRefresh,
}: QuerySourceInput): GridSource {
  const { t } = useTranslation();
  const relation = resolved?.editable ?? null;
  const columns = resolved?.columns ?? null;

  /**
   * The result columns a single-column FK makes navigable, by the name the
   * grid shows — an alias navigates as the table column it stands for.
   * Memoised: the grid keys its header and row memos on the list.
   */
  const fkByName = useMemo(() => {
    const m = new Map<string, ReturnType<typeof asFk>>();
    for (const [name, col] of columns?.byName ?? []) {
      const fk = asFk(col);
      if (fk) m.set(name, fk);
    }
    return m;
  }, [columns]);
  const fkColumnNames = useMemo(() => [...fkByName.keys()], [fkByName]);

  /**
   * "Copy as SQL" addresses the table the result reads, by its column names:
   * an alias becomes its column, an expression is left out. Needs only the
   * alignment, not the key — an `UPDATE` without the whole key in the result
   * falls back to a `<pk>` placeholder rather than a partial `WHERE`.
   */
  const sqlTarget = useMemo(
    () =>
      columns
        ? {
            table: columns.table,
            columnOf: (name: string) => columns.byName.get(name)?.name ?? null,
            pkColumns: columns.pkColumns,
          }
        : undefined,
    [columns],
  );
  /** Where an FK cell's new value must exist — an alias edits as the column it
   *  stands for. The referenced schema defaults to the relation's. */
  const fkRefOf = useCallback(
    (column: string) => {
      const fk = fkByName.get(column);
      return fk
        ? {
            connectionId,
            schema: fk.referenced_schema ?? columns?.schema,
            table: fk.referenced_table,
            column: fk.referenced_column,
            nullable: fk.nullable,
          }
        : undefined;
    },
    [fkByName, connectionId, columns],
  );
  const navigateFk = useCallback(
    (column: string, value: CellValue) => {
      const fk = fkByName.get(column);
      if (fk) openReferencedRow(connectionId, fk, value);
    },
    [fkByName, connectionId],
  );

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

  /**
   * Plan a pasted block against the result. Judged on table columns (the key,
   * the policy, the catalogue's types and `BIT`s), shown by result names.
   */
  const planResultPaste = useCallback(
    (paste: GridPaste, rows: CellValue[][]): PastePlan => {
      const byName = relation?.writable ?? new Map<string, ColumnInfo>();
      const catalog = new Map([...byName.values()].map((c) => [c.name, c]));
      return planPaste({
        block: parsePasteBlock(paste.text),
        rows,
        columns: paste.columns,
        columnIndexByName: new Map(
          resultColumns.map((c, i) => [c.name, i]),
        ),
        columnOf: (name) => byName.get(name)?.name ?? null,
        keyOf,
        pkColumns: relation?.pkColumns ?? [],
        columnInfo: catalog,
        bitColumns: new Set(
          [...catalog.values()].filter((c) => isBitType(c.data_type)).map((c) => c.name),
        ),
        canUpdate: !policy.update,
        newRows: "result",
        updateLock: policy.updateColumnLock,
      });
    },
    [relation, resultColumns, keyOf, policy.update, policy.updateColumnLock],
  );

  const applyPaste = useCallback(
    (plan: PastePlan) => {
      if (!relation) throw new Error("This result cannot be written back");
      return api.applyPaste({
        connectionId,
        schema: relation.schema,
        table: relation.table,
        pkColumns: relation.pkColumns,
        updates: plan.updates,
        // A result adds no rows; the plan never holds any, and this says so.
        inserts: [],
      });
    },
    [relation, connectionId],
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
      sqlTarget,
      keyOf,
      hydrate: asIs,
      refreshPage: onRefresh,
      refreshAll: onRefresh,
      insert: unsupported,
      duplicate: unsupported,
      fieldUnset: unsupported,
      fkNavigate: fkColumnNames.length
        ? available({ columns: fkColumnNames, navigateFk })
        : unsupported,
      bulkUpdate: unsupported,
      // Writing the rows to a file: the caller's chrome performs it
      // (`exportResult.ts`); the backend asks the policy again
      // (`Need::FreeExport`), whatever this says.
      export: policy.export ? blocked(policy.export) : AVAILABLE,
    } as const;
    if (!relation) {
      // Not one table with its key: the plain read-only grid, with no row
      // identity and therefore no selection.
      return {
        ...shared,
        addressable: false,
        getRowKey: undefined,
        paste: unsupported,
        update: unsupported,
        delete: unsupported,
      };
    }
    return {
      ...shared,
      addressable: true,
      getRowKey,
      // The plan skips what the update lock refuses, so a paste needs only
      // addressable rows — as on a table.
      paste: available({
        relationLabel: qualified,
        planPaste: planResultPaste,
        applyPaste,
      }),
      update: policy.update
        ? blocked(policy.update)
        : available({ saveField, columnLock, fkRefOf }),
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
    policy.export,
    keyOf,
    getRowKey,
    onRefresh,
    saveField,
    columnLock,
    connectionId,
    deleteRows,
    fkColumnNames,
    navigateFk,
    qualified,
    planResultPaste,
    applyPaste,
    sqlTarget,
    fkRefOf,
  ]);
}
