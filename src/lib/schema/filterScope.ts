/**
 * What the tree's filter box is currently searching, as one value.
 *
 * The panel used to have two *implicit* scopes and no way to see either:
 * `useUi.selectedConnectionId` decided which connection the needle reached
 * (`ConnectionsTree` passed `""` to every other one), and `MultiDbExplorer`'s
 * local `activeDatabaseName` narrowed it further to whichever database had been
 * expanded last. Neither was announced, and both moved on their own — opening a
 * tab or picking a table from the command palette changes the selected
 * connection, so the box quietly started searching somewhere else.
 *
 * A `FilterScope` replaces both. It is explicit (the user sets it), visible (a
 * chip inside the box says so) and reversible (the chip's ✕, Backspace on an
 * empty box, Escape, or the connection going away). `selectedConnectionId` goes
 * back to meaning only "where tabs and the editor point", which is the one
 * thing it always meant well.
 *
 * Everything here is pure so the rules can be tested without a store or a
 * React tree — in particular the synthetic-child rule, which is the one that
 * decides whether a multi-DB server's tables are inside its own scope.
 */

import { databaseViewId, parentConnectionId } from "@/lib/connectionLabel";

export type FilterScope =
  | { kind: "all" }
  | { kind: "connection"; connectionId: string }
  | { kind: "database"; connectionId: string; database: string };

/** The neutral scope: search every active connection in the environment. */
export const ALL_SCOPE: FilterScope = { kind: "all" };

/** The profile id a scope is anchored to, or `null` for `all`. */
export function scopeConnectionId(scope: FilterScope): string | null {
  return scope.kind === "all" ? null : scope.connectionId;
}

/**
 * One level out: database → connection → all. Idempotent at the top, which is
 * what lets Backspace-on-an-empty-box and Escape share this without either
 * having to know how deep the scope currently is.
 */
export function widenScope(scope: FilterScope): FilterScope {
  switch (scope.kind) {
    case "database":
      return { kind: "connection", connectionId: scope.connectionId };
    case "connection":
      return ALL_SCOPE;
    case "all":
      return ALL_SCOPE;
  }
}

/**
 * Is `connectionId` inside `scope`?
 *
 * `connectionId` may be a profile id or a synthetic `<parent>::db::<db>` view
 * id, and a connection scope has to include its children: a multi-DB server
 * keeps every one of its tables in those child slices (ADR #36), so a scope
 * that excluded them would search a server and find nothing in it.
 */
export function scopeIncludes(scope: FilterScope, connectionId: string): boolean {
  if (scope.kind === "all") return true;
  if (parentConnectionId(connectionId) !== scope.connectionId) return false;
  if (scope.kind === "connection") return true;
  // A database scope still includes the parent row itself — it is what hosts
  // the database — but only the one child view that *is* that database.
  return (
    connectionId === scope.connectionId ||
    connectionId === databaseViewId(scope.connectionId, scope.database)
  );
}

/** Is `database` of `connectionId` inside `scope`? */
export function scopeIncludesDatabase(
  scope: FilterScope,
  connectionId: string,
  database: string,
): boolean {
  if (scope.kind === "all") return true;
  if (scope.connectionId !== connectionId) return false;
  return scope.kind === "connection" || scope.database === database;
}

/**
 * Drop a scope whose connection is gone (disconnected, deleted, or filtered out
 * of the environment's `visibleConnections`).
 *
 * Without this the box keeps a chip naming a connection that is no longer in
 * the tree, and every search silently returns nothing — the exact failure mode
 * the implicit scopes had, with a label on it.
 */
export function pruneScope(
  scope: FilterScope,
  isReachable: (connectionId: string) => boolean,
): FilterScope {
  const id = scopeConnectionId(scope);
  if (id === null) return scope;
  return isReachable(id) ? scope : ALL_SCOPE;
}

/**
 * The chip's text, given the connection's display name.
 *
 * Deliberately takes the name rather than looking it up, and returns plain text
 * rather than a translated string: the two pieces it joins are both proper
 * nouns, so there is nothing here to translate and nothing to mock in a test.
 */
export function scopeLabel(scope: FilterScope, connectionName: string): string {
  switch (scope.kind) {
    case "all":
      return "";
    case "connection":
      return connectionName;
    case "database":
      return `${connectionName} · ${scope.database}`;
  }
}

/** Do two scopes describe the same thing? Used to skip no-op store writes. */
export function sameScope(a: FilterScope, b: FilterScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "all" || b.kind === "all") return true;
  if (a.connectionId !== (b as { connectionId: string }).connectionId) return false;
  if (a.kind === "database" && b.kind === "database") return a.database === b.database;
  return true;
}
