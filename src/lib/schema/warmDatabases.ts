/**
 * Bounded, on-demand loading of a multi-database server's table lists, so the
 * command palette and the schema tree's filter can search tables the user has
 * never expanded.
 *
 * The palette indexes `useSchema.byConnection`, which for a server-wide
 * connection (`profile.database === ""`) starts out holding only the *database*
 * list: each database's tables arrive under its own `<parent>::db::<name>` slice
 * and only once something opens that view. So a freshly connected multi-DB
 * server had nothing for `@` to find — the tables existed, the index didn't.
 *
 * Why this is a deliberate, user-triggered action rather than an automatic
 * fan-out on every keystroke: **each database view is a whole separate
 * connection pool**. The schema explorer learned this the hard way — its
 * cross-database search used to start every database at once, and a server with
 * nineteen databases turned one keystroke into nineteen simultaneous connection
 * attempts, which was itself enough to exhaust a shared server's limit. It then
 * learned it a second time: bounding that fan-out to three at a time made it
 * survivable but left typing in charge of opening pools, which is the thing the
 * connections-tree redesign finally removed. The shape of the fix is here —
 * `DB_VIEW_WARM_CONCURRENCY` at a time, and a hard stop the moment the server
 * says it is full, because every remaining database would fail identically —
 * and `warmForSearch` is the tree's entry point into it.
 */

import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { useSchema } from "@/stores/session/schema";
import { isTooManyConnections } from "@/lib/db/driver";
import { databaseViewId } from "@/lib/connectionLabel";

/**
 * How many database views may be opened at once.
 *
 * Every `openDatabaseView` is a separate connection pool against the same
 * server, so an unbounded fan-out is indistinguishable from a denial-of-service
 * against a database the user shares with their IDE, their application backend
 * and any MCP sidecars — a nineteen-database server firing nineteen at once was
 * itself enough to exhaust a shared limit (1.13.0). Three keeps a warm feeling
 * responsive on a handful of databases while making that case a queue rather
 * than a burst.
 *
 * **There used to be two schedulers, and now there is one.** The schema
 * explorer had its own: a re-entrant effect that re-derived its queue on every
 * pass, so a keystroke, a newly active database or a changed visible set
 * changed what still got warmed, and the tree filled in progressively. That
 * behaviour was worth keeping only for as long as *typing* was what triggered
 * the warm — which is precisely what the connections-tree redesign removed
 * (`warmForSearch`). With the warm now a deliberate, one-shot action over a
 * list the tree already computed, the re-entrant version has nothing left to
 * re-derive, and the reason the two could not be merged went with it.
 */
export const DB_VIEW_WARM_CONCURRENCY = 3;

export interface WarmResult {
  /** Databases whose table list is now in the store. */
  loaded: number;
  /** Databases whose view would not open, or whose table list would not read. */
  skipped: number;
  /** The connection-limit error, when that is what stopped us. */
  limitError: unknown | null;
  /**
   * The first failure that was *not* a connection limit, kept so a caller can
   * say what went wrong rather than only how many.
   *
   * Before this existed, every non-limit failure was reduced to `skipped += 1`
   * and the error itself was dropped on the floor — so a Mongo server that had
   * gone away across nineteen databases produced a counter and nothing else.
   */
  firstError: unknown | null;
}

/**
 * Open a view per database of `parentId` and pull its table list into
 * `useSchema`, `DB_VIEW_WARM_CONCURRENCY` at a time.
 *
 * Individual failures are counted and skipped — one unreachable database
 * shouldn't cost the others — but a connection-limit refusal aborts the rest.
 * The first non-limit failure is kept in `firstError` so the caller can name
 * it; reporting per database is deliberately left to the caller, since a
 * fan-out of nineteen would otherwise be nineteen cards.
 */
export async function warmDatabases(
  parentId: string,
  databases: string[],
): Promise<WarmResult> {
  const queue = [...databases];
  const result: WarmResult = {
    loaded: 0,
    skipped: 0,
    limitError: null,
    firstError: null,
  };

  const worker = async () => {
    for (;;) {
      if (result.limitError) return; // circuit broken by another worker
      const name = queue.shift();
      if (name === undefined) return;
      try {
        // `openTrackedDatabaseView`, not the bare `api` wrapper: it is what
        // attaches the child's persistence subscription, so a tab opened
        // against this view afterwards is actually remembered (ADR #27).
        const childId = await openTrackedDatabaseView(parentId, name);
        // `quiet`: this loop is the one place a failure per database would mean
        // a card per database, and the caller reports one summary instead.
        //
        // The returned message is the point: `refresh` records its failure on
        // the slice rather than throwing, so `loaded += 1` used to count a
        // database whose table list had failed — nineteen loaded, nineteen
        // broken, reported as a clean success. See ADR #68.
        const failure = await useSchema
          .getState()
          .refresh(childId, { quiet: true });
        if (failure) {
          result.skipped += 1;
          result.firstError ??= failure;
        } else {
          result.loaded += 1;
        }
      } catch (e) {
        if (isTooManyConnections(e)) {
          result.limitError = e;
          // Everything still queued would be refused the same way.
          result.skipped += queue.length + 1;
          queue.length = 0;
          return;
        }
        result.skipped += 1;
        result.firstError ??= e;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(DB_VIEW_WARM_CONCURRENCY, queue.length) },
      worker,
    ),
  );
  return result;
}

/**
 * Databases of `parentId` whose tables aren't in the store yet — what
 * `warmDatabases` would actually fetch. An empty array means the index is
 * already complete for that connection, and the palette hides the entry.
 */
export function unwarmedDatabases(
  parentId: string,
  databases: string[],
  byConnection: Record<string, { tables?: unknown[]; initialized?: boolean }>,
): string[] {
  return databases.filter((name) => {
    const slice = byConnection[databaseViewId(parentId, name)];
    return !slice?.initialized;
  });
}
