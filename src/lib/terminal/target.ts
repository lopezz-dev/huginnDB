/**
 * What a new `mongosh` tab would sign in as, from what the workspace is
 * focused on — or why there is nothing to sign in as.
 *
 * The connection is the workspace's current one (`useUi.selectedConnectionId`,
 * itself derived from the focused tab — see `focusFollowsTab`), never a
 * per-database view: the backend signs `mongosh` in with the *top-level*
 * pool's password and tunnel. The database is the one the focused tab is
 * pointed at, when that tab belongs to the same connection, so the prompt
 * opens where the user was already looking.
 */

import {
  databaseOfViewId,
  parentConnectionId,
  resolveConnectionLabel,
} from "@/lib/connectionLabel";
import type { ConnectionProfile } from "@/types";

export interface MongoshTarget {
  connectionId: string;
  database: string | null;
  /** The tab title: the connection's name, with the database when there is one. */
  title: string;
}

export type MongoshUnavailable = "noConnection" | "notMongo" | "notConnected";

export function mongoshTarget(
  selectedConnectionId: string | null,
  focusedTabConnectionId: string | null,
  profiles: ConnectionProfile[],
  active: ReadonlySet<string>,
): { target: MongoshTarget } | { unavailable: MongoshUnavailable } {
  if (!selectedConnectionId) return { unavailable: "noConnection" };
  const connectionId = parentConnectionId(selectedConnectionId);
  const profile = profiles.find((p) => p.id === connectionId);
  if (!profile) return { unavailable: "noConnection" };
  if (profile.driver !== "mongodb") return { unavailable: "notMongo" };
  if (!active.has(connectionId)) return { unavailable: "notConnected" };

  const database =
    focusedTabConnectionId && parentConnectionId(focusedTabConnectionId) === connectionId
      ? databaseOfViewId(focusedTabConnectionId) || null
      : null;
  return {
    target: {
      connectionId,
      database,
      // The profile's own label already carries its default database; a tab
      // pointed elsewhere names that one instead of both.
      title: database
        ? `${profile.name} · ${database}`
        : resolveConnectionLabel(profiles, connectionId),
    },
  };
}
