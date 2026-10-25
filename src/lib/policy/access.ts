/**
 * Locked controls: whether the managed policy lets the person using the app do
 * one thing on a connection or relation, and the reason to show when it does
 * not. Built on `stores/session/policyAccess.ts`, which caches the backend's
 * answers; the backend refuses on its own either way, so these only decide
 * what a control looks like.
 *
 * The hooks hand back text (a string or `null`) rather than an object, so a
 * component can use it as a `disabled` / `locked` prop without a shallow
 * comparison (gotcha #1); `usePolicyLocker` hands back a function producing it.
 */

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { columnAllowed, topLevelField } from "@/lib/policy/glob";
import {
  relationKey,
  usePolicyAccess,
  type PolicyStateLabel,
} from "@/stores/session/policyAccess";
import type { ConnectionAccess, PolicyVerb, RelationAccess } from "@/types";

/** What a control asks the policy for. */
export type PolicyNeed =
  /** Opening the connection at all: the role reaches it. */
  | "connect"
  | "read"
  | "freeSql"
  | "insert"
  | "update"
  | "delete"
  | "ddl"
  | "export"
  | "monitor";

/** Why a control is locked, before it is put into words. */
export type Lock =
  | { kind: "state"; state: "pending" | "broken"; reason: string | null }
  | { kind: "connection"; reason: string | null }
  | { kind: "need"; need: PolicyNeed };

const VERB_OF: Partial<Record<PolicyNeed, PolicyVerb>> = {
  read: "select",
  insert: "insert",
  update: "update",
  delete: "delete",
  ddl: "ddl",
};

/**
 * The pure decision. `conn` / `rel` are `undefined` while their answer has not
 * arrived, which reads as allowed (see the store's note on why).
 */
export function lockFor(
  state: PolicyStateLabel,
  stateReason: string | null,
  conn: ConnectionAccess | undefined,
  rel: RelationAccess | undefined,
  need: PolicyNeed,
): Lock | null {
  if (state === "pending" || state === "broken") {
    return { kind: "state", state, reason: stateReason };
  }
  if (state === "unmanaged" || !conn) return null;
  if (!conn.visible) return { kind: "connection", reason: conn.reason };
  if (!conn.managed || need === "connect") return null;

  const verb = VERB_OF[need];
  const allowedOnConnection =
    need === "freeSql"
      ? conn.freeSql
      : need === "monitor"
        ? conn.monitor
        : need === "export"
          ? conn.export
          : verb !== undefined && conn.verbs.includes(verb);
  if (!allowedOnConnection) return { kind: "need", need };

  if (rel) {
    const allowedOnRelation =
      need === "export"
        ? rel.export
        : verb !== undefined
          ? rel.visible && rel.verbs.includes(verb)
          : true;
    if (!allowedOnRelation) return { kind: "need", need };
  }
  return null;
}

/** The short text a locked menu item, button or empty state shows. */
export function useLockText(): (lock: Lock | null) => string | null {
  const { t } = useTranslation();
  return (lock) => {
    if (!lock) return null;
    switch (lock.kind) {
      case "state":
        return t(`policy.lock.${lock.state}`);
      case "connection":
        return t("policy.lock.connection");
      case "need":
        return t("policy.lock.need", { what: t(`policy.what.${lock.need}`) });
    }
  };
}

/** The connection's cached answer, asking for it if it is missing. */
export function useConnectionAccess(
  connectionId: string | null | undefined,
): ConnectionAccess | undefined {
  const conn = usePolicyAccess((s) =>
    connectionId ? s.connections[connectionId] : undefined,
  );
  const request = usePolicyAccess((s) => s.request);
  useEffect(() => {
    if (connectionId && !conn) request([connectionId]);
  }, [connectionId, conn, request]);
  return conn;
}

/**
 * The relation's cached answer, asking for it once the connection is known to
 * be managed. `undefined` while it has not arrived, which reads as allowed.
 */
function useRelationAccess(
  connectionId: string | null | undefined,
  conn: ConnectionAccess | undefined,
  relation: { schema: string | null | undefined; name: string } | null | undefined,
): RelationAccess | undefined {
  const state = usePolicyAccess((s) => s.state);
  const key =
    connectionId && relation
      ? relationKey(connectionId, relation.schema, relation.name)
      : null;
  const rel = usePolicyAccess((s) => (key ? s.relations[key] : undefined));
  const requestRelations = usePolicyAccess((s) => s.requestRelations);
  const schema = relation?.schema ?? null;
  const name = relation?.name;
  const managed = conn?.managed;
  useEffect(() => {
    if (!connectionId || !name || rel) return;
    // Wait for the connection's answer: an unmanaged one needs no relations.
    if (state === "unknown" || state === "unmanaged" || managed !== true) return;
    requestRelations(connectionId, [{ schema, name }]);
  }, [connectionId, schema, name, rel, state, managed, requestRelations]);
  return rel;
}

/**
 * A locker for one connection — and, when `relation` is given, one relation of
 * it: `lock(need)` is the text to show when the policy does not allow `need`,
 * or `null` when the control is usable. One subscription for a menu that locks
 * seven items, rather than seven.
 */
export function usePolicyLocker(
  connectionId: string | null | undefined,
  relation?: { schema: string | null | undefined; name: string } | null,
): (need: PolicyNeed) => string | null {
  const state = usePolicyAccess((s) => s.state);
  const stateReason = usePolicyAccess((s) => s.reason);
  const conn = useConnectionAccess(connectionId);
  const rel = useRelationAccess(connectionId, conn, relation);
  const text = useLockText();
  return (need) => text(lockFor(state, stateReason, conn, rel, need));
}

/** The verbs a rule can limit to some columns (ADR #113). */
export type ColumnVerb = "insert" | "update";

/**
 * The column limit on one verb of one relation — `null` when there is none:
 * no policy, an unmanaged connection, an answer still on its way, or a role
 * that may write every column. Pure, for the tests.
 */
export function columnLimitFor(
  rel: RelationAccess | undefined,
  verb: ColumnVerb,
): string[] | null {
  return rel?.columns?.[verb] ?? null;
}

/** What {@link usePolicyColumns} hands back. */
export interface PolicyColumns {
  /** The limit on each verb, as patterns; `null` means every column. */
  insert: string[] | null;
  update: string[] | null;
  /**
   * The text to show where `verb` may not write `column`, or `null` when it
   * may. Only the column limit: whether the verb is granted at all is
   * {@link usePolicyLocker}'s question.
   */
  lock: (verb: ColumnVerb, column: string) => string | null;
}

/**
 * Which columns the person may write on one relation (ADR #113). On MongoDB
 * (`documentMode`) a field path is judged by its top-level field, as the
 * backend judges it. Stable while the cached answer is, so it can be a prop.
 */
export function usePolicyColumns(
  connectionId: string | null | undefined,
  relation: { schema: string | null | undefined; name: string } | null | undefined,
  documentMode = false,
): PolicyColumns {
  const { t } = useTranslation();
  const conn = useConnectionAccess(connectionId);
  const rel = useRelationAccess(connectionId, conn, relation);
  return useMemo(() => {
    const insert = columnLimitFor(rel, "insert");
    const update = columnLimitFor(rel, "update");
    return {
      insert,
      update,
      lock: (verb, column) => {
        const key = documentMode ? topLevelField(column) : column;
        if (columnAllowed(verb === "insert" ? insert : update, key)) return null;
        return t(`policy.lock.column.${verb}`, { column: key });
      },
    };
  }, [rel, documentMode, t]);
}

/** The lock on one need — {@link usePolicyLocker} for a single control. */
export function usePolicyLock(
  connectionId: string | null | undefined,
  need: PolicyNeed,
  relation?: { schema: string | null | undefined; name: string } | null,
): string | null {
  return usePolicyLocker(connectionId, relation)(need);
}

/**
 * The policy's state on this machine, for the global banner. Asks once for it
 * if nothing has yet.
 */
export function usePolicyState(): {
  state: PolicyStateLabel;
  reason: string | null;
} {
  const state = usePolicyAccess((s) => s.state);
  const reason = usePolicyAccess((s) => s.reason);
  const request = usePolicyAccess((s) => s.request);
  useEffect(() => {
    if (state === "unknown") request([]);
  }, [state, request]);
  return { state, reason };
}

/** What a tab of each kind asks of the policy just to be shown. */
export function tabNeed(tab: {
  kind: string;
  schema?: string;
  table?: string;
  view?: string;
  mode?: "new" | "edit";
}): {
  need: PolicyNeed;
  relation: { schema: string | undefined; name: string } | null;
} {
  const relationOf = (name: string | undefined) =>
    name ? { schema: tab.schema, name } : null;
  switch (tab.kind) {
    // The editor is nothing but free SQL (or a free `db.…` command).
    case "query":
      return { need: "freeSql", relation: null };
    case "security":
      return { need: "monitor", relation: null };
    // Creating a table or view has no relation yet to read; what it needs is
    // the right to change the structure at all.
    case "structure":
    case "view":
      if (tab.mode === "new") return { need: "ddl", relation: null };
      return {
        need: "read",
        relation: relationOf(tab.kind === "view" ? tab.view : tab.table),
      };
    default:
      return { need: "read", relation: relationOf(tab.table ?? tab.view) };
  }
}
