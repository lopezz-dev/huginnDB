/**
 * What the managed policy lets the person do on one relation, read once and
 * handed to whoever needs it — a grid source's producer, the tab's own chrome
 * (the verb notice, the export menu, the query panel's free SQL).
 *
 * It exists so that no grid source reads the policy itself (ADR #135): the
 * table browse and a query's result set ask the same questions of the same
 * relation, and two copies of these reads would drift the way the write paths
 * did before the contract. It decides nothing — it translates the policy into
 * the sentences a locked control shows. The backend enforces the same rules
 * regardless (ADRs #95–#96, #113).
 */

import { useMemo } from "react";
import {
  usePolicyColumns,
  usePolicyLocker,
  type PolicyColumns,
} from "@/lib/policy/access";
import type { ColumnLock } from "@/lib/grid/gridSource";

export interface RelationPolicy {
  /** Per verb, the text to show when the policy refuses it, or `null`. */
  insert: string | null;
  update: string | null;
  delete: string | null;
  export: string | null;
  /** A free SQL fragment against this relation (the query panel's `WHERE`). */
  freeSql: string | null;
  /** The column limits as the policy states them, for the verb notice. */
  columns: Pick<PolicyColumns, "insert" | "update">;
  /**
   * Per column, why it cannot be updated / filled in a new row; `undefined`
   * when the verb is not limited to some columns, so the grid's per-cell path
   * stays exactly as it is for everyone else. Stable while the policy's answer
   * is: the grid derives its header locks from them in a memo.
   */
  updateColumnLock: ColumnLock | undefined;
  insertColumnLock: ColumnLock | undefined;
}

/**
 * @param relation `null` when the rows map onto no single relation — every
 *   verb then reads as the connection allows it, and nothing is limited by
 *   column.
 * @param documentMode MongoDB: a field path is judged by its top-level field,
 *   as the backend judges it.
 */
export function useRelationPolicy(
  connectionId: string,
  relation: { schema: string | undefined; name: string } | null,
  documentMode: boolean,
): RelationPolicy {
  const lock = usePolicyLocker(connectionId, relation);
  const columns = usePolicyColumns(connectionId, relation, documentMode);

  const insert = lock("insert");
  const update = lock("update");
  const del = lock("delete");
  const exp = lock("export");
  const freeSql = lock("freeSql");

  const updateColumnLock = useMemo(
    () =>
      columns.update
        ? (column: string) => columns.lock("update", column)
        : undefined,
    [columns],
  );
  const insertColumnLock = useMemo(
    () =>
      columns.insert
        ? (column: string) => columns.lock("insert", column)
        : undefined,
    [columns],
  );

  return useMemo(
    () => ({
      insert,
      update,
      delete: del,
      export: exp,
      freeSql,
      columns: { insert: columns.insert, update: columns.update },
      updateColumnLock,
      insertColumnLock,
    }),
    [
      insert,
      update,
      del,
      exp,
      freeSql,
      columns.insert,
      columns.update,
      updateColumnLock,
      insertColumnLock,
    ],
  );
}
