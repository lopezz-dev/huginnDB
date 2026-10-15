/**
 * How many things each connection's subtree matches, for the filter box's
 * per-row counters.
 *
 * This is what replaces the old model, where the needle went down as a raw
 * string and every explorer re-derived its own answer. Deriving it once, up
 * here, is what makes the three states the tree has to tell apart expressible
 * at all:
 *
 * - **pending** — the connection's own list is still being fetched. A `0` here
 *   would be a lie that lasts as long as the fetch does.
 * - **cold** — a multi-DB server whose per-database table lists have never been
 *   read (they live in `<parent>::db::<db>` child slices that only exist once
 *   something opens that view, ADR #36). We have not looked, so we do not
 *   say `0`; the row offers to look instead. Typing must never open a pool by
 *   itself — see `warmForSearch`.
 * - **failed** — we asked and the server would not answer. Added in 1.21.x, and
 *   its absence was the same bug one state over: a connection whose schema read
 *   failed is `initialized: true, tables: []`, which read as `none`, so the row
 *   dimmed, grew a confident `0` and was *folded away by the filter* —
 *   unmounting the one place the error was rendered. See ADR #68.
 * - **none** — everything visible is loaded and nothing matched. The only state
 *   in which a `0` badge is the truth.
 *
 * The old explorer collapsed all three into one boolean (`prefetching`), and
 * computed it over `cs.databases` *without* the visible-databases subset, while
 * the loop that actually warmed them applied it — so with a subset active it
 * was stuck true forever and the "no matches" line could never appear. The user
 * saw an empty tree and no explanation.
 *
 * Pure, and pure over *inputs the caller already has*: the schema slices come in
 * as a plain record so the hook above (`useTreeMatchCounts`) can hold the app's
 * single wide subscription to `useSchema.byConnection` and this file can be
 * tested with three object literals.
 */

import { databaseViewId } from "@/lib/connectionLabel";
import { matchesPatterns } from "@/lib/schema/matchesFilter";
import {
  scopeIncludes,
  scopeIncludesDatabase,
  type FilterScope,
} from "@/lib/schema/filterScope";

/** The parts of a `useSchema` slice this file reads. */
export interface SchemaSliceLike {
  databases: { name: string }[];
  tables: { name: string }[];
  loading: boolean;
  initialized: boolean;
  /**
   * The last read's failure, if it failed. Load-bearing here rather than a
   * detail the tree can render on its own: without it a failed slice is
   * indistinguishable from an empty one, and this file's whole job is to keep
   * "nothing matched" apart from "nobody looked".
   */
  error: string | null;
}

/** One connection, as the tree knows it before any counting happens. */
export interface TreeConnectionInput {
  connectionId: string;
  /** Server-wide profile: its tables live in the per-database child slices. */
  multiDb: boolean;
  /** Resolved visible-databases subset (`null` = all). Multi-DB only. */
  visibleDatabases: string[] | null;
}

export interface ConnectionMatchSummary {
  connectionId: string;
  /** Matching tables/views, plus databases matched by their own name. */
  count: number;
  /** Per-database table/view match counts. Empty for a single-DB connection. */
  byDatabase: Map<string, number>;
  /** Visible databases whose own name matched the needle. */
  databaseNameMatches: string[];
  /** Visible databases with no table list in the store yet. */
  coldDatabases: string[];
  /**
   * Why this connection's own schema read failed, or `null`.
   *
   * Distinct from `coldDatabases`, which is "we have not looked". This is "we
   * looked and were refused", and the two have different remedies: one is the
   * warm button, the other is a reconnect or a server that needs fixing.
   */
  failed: string | null;
  /** Visible databases whose own table list failed to read. */
  failedDatabases: string[];
  /** The connection's own list is still loading and has never completed. */
  pending: boolean;
  /**
   * The search is scoped somewhere else, so this connection was not searched
   * at all.
   *
   * Kept apart from a `0` deliberately: "nothing here matched" and "this was
   * not looked at" are different facts, and only one of them is a reason to
   * try a different needle.
   */
  outOfScope: boolean;
}

/**
 * Names of a slice's tables, lowercased once and remembered.
 *
 * Keyed on the `tables` array itself: `useSchema.refresh` *replaces* the slice
 * (and with it the array) rather than mutating it, so the array's identity is a
 * perfect, self-invalidating cache key — the same property gotcha #1 relies on
 * for selectors. A `WeakMap` means a dropped connection's entry goes with it.
 */
const loweredNames = new WeakMap<object, string[]>();

function lowered(tables: { name: string }[]): string[] {
  const cached = loweredNames.get(tables);
  if (cached) return cached;
  const next = tables.map((t) => t.name.toLowerCase());
  loweredNames.set(tables, next);
  return next;
}

/** How many of a slice's tables match, using the lowercased-name cache. */
function countMatches(
  slice: SchemaSliceLike | undefined,
  patterns: string[],
): number {
  if (!slice) return 0;
  if (patterns.length === 0) return slice.tables.length;
  let n = 0;
  for (const name of lowered(slice.tables)) {
    if (patterns.some((p) => name.includes(p))) n += 1;
  }
  return n;
}

/**
 * Summarise every connection the tree is showing.
 *
 * `connections` is the *active* set — an idle connection has nothing to search
 * and gets no summary, which is what lets its row say "connect to include it"
 * instead of a misleading `0`.
 *
 * An empty `patterns` list matches everything, following `matchesPatterns`, so
 * the counts are only *meaningful* while something is typed. `useTreeMatchCounts`
 * short-circuits to an empty map in that case rather than counting every table
 * on every server for a number nothing renders.
 */
export function summarizeMatches(
  connections: TreeConnectionInput[],
  byConnection: Record<string, SchemaSliceLike | undefined>,
  patterns: string[],
  scope: FilterScope,
): ConnectionMatchSummary[] {
  return connections.map((c) => {
    const slice = byConnection[c.connectionId];
    const summary: ConnectionMatchSummary = {
      connectionId: c.connectionId,
      count: 0,
      byDatabase: new Map(),
      databaseNameMatches: [],
      coldDatabases: [],
      failed: slice?.error ?? null,
      failedDatabases: [],
      pending: !!slice?.loading && !slice.initialized,
      outOfScope: !scopeIncludes(scope, c.connectionId),
    };

    if (summary.outOfScope) {
      // Nothing was read on this connection's behalf, so nothing is claimed
      // about it — not even that it is still loading, or that an earlier read
      // had failed.
      summary.pending = false;
      summary.failed = null;
      return summary;
    }

    if (!c.multiDb) {
      summary.count = countMatches(slice, patterns);
      return summary;
    }

    const visible = c.visibleDatabases;
    const allowed = visible && visible.length > 0 ? new Set(visible) : null;
    for (const database of slice?.databases ?? []) {
      const name = database.name;
      if (allowed && !allowed.has(name)) continue;
      if (!scopeIncludesDatabase(scope, c.connectionId, name)) continue;
      if (matchesPatterns(name, patterns)) {
        summary.databaseNameMatches.push(name);
        summary.count += 1;
      }
      const child = byConnection[databaseViewId(c.connectionId, name)];
      if (!child?.initialized) {
        summary.coldDatabases.push(name);
        continue;
      }
      // A failed child is `initialized`, so it used to fall straight through to
      // `byDatabase.set(name, 0)` — reported as an honest zero, and dropped
      // from what the warm button offers, because it is no longer "cold".
      //
      // Its tables are still counted: `refresh` does not wipe them on the
      // failure path, so what is there is the last thing the server did say,
      // and hiding it would lose data the tree is showing. The count is
      // annotated rather than suppressed — the same treatment `coldDatabases`
      // gets, where matches win and the incompleteness is flagged beside them.
      if (child.error) summary.failedDatabases.push(name);
      const n = countMatches(child, patterns);
      summary.byDatabase.set(name, n);
      summary.count += n;
    }
    return summary;
  });
}

/** Roll the per-connection summaries up into the box's one-line status. */
export function totalMatches(list: Iterable<ConnectionMatchSummary>): {
  matches: number;
  /** Connections that matched at least once — never those that merely exist. */
  connections: number;
  /** Databases nobody has read yet, across every connection. */
  cold: number;
  /**
   * Connections that would not answer — the whole connection, or at least one
   * of its databases. Counted per *connection* rather than per database,
   * because that is the unit of the remedy: you reconnect a connection.
   */
  failed: number;
  /** True while any connection's own list is still on its first fetch. */
  pending: boolean;
} {
  let matches = 0;
  let connections = 0;
  let cold = 0;
  let failed = 0;
  let pending = false;
  for (const s of list) {
    matches += s.count;
    if (s.count > 0) connections += 1;
    cold += s.coldDatabases.length;
    if (s.failed !== null || s.failedDatabases.length > 0) failed += 1;
    pending ||= s.pending;
  }
  return { matches, connections, cold, failed, pending };
}

/**
 * The states a connection row can be in under an active filter.
 *
 * `unloaded` outranks `none` on purpose: a multi-DB server whose databases are
 * all cold has *no* evidence for a `0`, and a provisional `0` is what makes a
 * user abandon a search that would have worked. `out-of-scope` outranks
 * everything for the same reason, one step further out.
 *
 * `failed` outranks both, and that ordering is the fix for ADR #68's last
 * loose end. A connection whose read failed used to land in `none` — the one
 * state that means "this really is empty" — so the row dimmed, showed `0`, and
 * `ConnectionsTree.filterFoldsIgnoringOverride` folded it to a single line,
 * taking the inline error message off the screen with it. It ranks above
 * `unloaded` because the two are answered differently: `unloaded` asks the user
 * to look, `failed` says looking did not work.
 *
 * It stays *below* `matches`, like `unloaded` does: a stale count is still a
 * count, and the partial-ness rides along on the badge's `+` rather than
 * replacing a number the user can act on.
 */
export type RowMatchState =
  | "out-of-scope"
  | "pending"
  | "failed"
  | "unloaded"
  | "none"
  | "matches";

export function rowMatchState(summary: ConnectionMatchSummary): RowMatchState {
  if (summary.outOfScope) return "out-of-scope";
  if (summary.pending) return "pending";
  if (summary.count > 0) return "matches";
  if (summary.failed !== null || summary.failedDatabases.length > 0)
    return "failed";
  if (summary.coldDatabases.length > 0) return "unloaded";
  return "none";
}
