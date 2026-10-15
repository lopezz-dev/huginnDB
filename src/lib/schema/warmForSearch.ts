/**
 * Load the table lists the tree's search has not read yet — on request, never
 * on a keystroke.
 *
 * The explorer used to do this implicitly: every debounced needle walked the
 * databases it had not loaded and opened a pool for each. Bounded to three at a
 * time since 1.13.0, but still a fan-out of *connection pools* driven by
 * typing, against a server the user shares with their application, their IDE
 * and any MCP sidecars. The invariant this file exists to hold is simple and
 * worth stating plainly: **typing must never open a connection.** Searching
 * looks at what is already in `useSchema`; reaching further is an action with a
 * button on it, so the cost is visible and the user chose to pay it.
 *
 * A deliberately thin wrapper with **no scheduler of its own**: each connection
 * is handed to `warmDatabases`, which already bounds itself to
 * `DB_VIEW_WARM_CONCURRENCY` and already opens each view through
 * `openTrackedDatabaseView` (the tracked path — the explorer's own prefetch
 * used the bare `api` wrapper, so a database warmed by searching never got its
 * persistence subscription, ADR #27).
 *
 * Connections are walked **sequentially**, not in parallel: five connections at
 * once would be fifteen simultaneous pool opens, which is the exact burst the
 * per-connection bound exists to prevent. A connection-limit refusal aborts the
 * rest, because everything still queued would be refused identically.
 */

import { warmDatabases, type WarmResult } from "@/lib/schema/warmDatabases";

/** One connection's worth of work: a parent id and its unread databases. */
export interface WarmTarget {
  parentId: string;
  databases: string[];
}

export interface WarmForSearchResult extends WarmResult {
  /** Connections whose databases were never attempted (the circuit broke). */
  abandonedConnections: number;
}

export async function warmForSearch(
  targets: WarmTarget[],
): Promise<WarmForSearchResult> {
  const result: WarmForSearchResult = {
    loaded: 0,
    skipped: 0,
    limitError: null,
    firstError: null,
    abandonedConnections: 0,
  };
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (target.databases.length === 0) continue;
    const one = await warmDatabases(target.parentId, target.databases);
    result.loaded += one.loaded;
    result.skipped += one.skipped;
    result.firstError ??= one.firstError;
    if (one.limitError) {
      result.limitError = one.limitError;
      result.abandonedConnections = targets.length - i - 1;
      break;
    }
  }
  return result;
}
