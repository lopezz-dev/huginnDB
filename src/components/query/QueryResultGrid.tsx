/**
 * The query tab's result grid — `DataGrid` driven by the same controller as
 * the table browse (ADR #135), with the result set as its source.
 *
 * What may be written is `useQuerySource`'s call, on the relation
 * `useQueryRelation` resolves from the statement: one `SELECT` over one table,
 * with the table's whole primary key in the result. Anything else — a join,
 * an aggregate, a key left out — renders exactly the read-only grid. Edit and
 * delete go through the shared controller, so they confirm, reload and report
 * the selection exactly as a table tab does; inserting and duplicating are not
 * offered from a result set (see `useQuerySource`).
 */

import { useMemo } from "react";
import { DataGrid } from "@/components/grid/DataGrid";
import { useGridController } from "@/components/grid/useGridController";
import { useRelationPolicy } from "@/lib/policy/useRelationPolicy";
import { useQueryRelation, useQuerySource } from "@/lib/query/useQuerySource";
import type { Driver, QueryResult } from "@/types";

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

/** A result set has no banner of its own to show a key error in; a gesture
 *  that cannot start there has nothing to report beyond not starting. */
const ignore = () => {};

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
  const resolved = useQueryRelation(connectionId, driver, sql, result.columns);
  // Read once for the relation the statement reads; `null` (not one table)
  // asks only about the connection, and locks nothing by column.
  const relation = useMemo(
    () =>
      resolved
        ? { schema: resolved.columns.schema, name: resolved.columns.table }
        : null,
    [resolved],
  );
  const policy = useRelationPolicy(connectionId, relation, false);
  const source = useQuerySource({
    connectionId,
    resolved,
    policy,
    onRefresh,
  });
  const { gridProps, dialogs } = useGridController(source, {
    tabId,
    // A result over several tables keeps no selection, so it reports none.
    reportSelection: source.addressable,
    onError: ignore,
  });

  // `DataGrid` sizes itself with `h-full`, so it needs a box with a definite
  // height: a flex share of the results column, `overflow-hidden` so it may
  // shrink to it (contract K in `uiContracts.test.ts`).
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <DataGrid
        {...gridProps}
        result={result}
        tabId={tabId}
        driver={driver}
        globalFilter={globalFilter}
        onGlobalFilterChange={onGlobalFilterChange}
      />
      {dialogs}
    </div>
  );
}
