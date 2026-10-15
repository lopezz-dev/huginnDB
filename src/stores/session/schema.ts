/**
 * Schema store — per-connection cache of database / table / column /
 * index metadata, plus the expanded-node bookkeeping for the explorer
 * tree. Data is fetched lazily as the user expands tree nodes.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/tauri";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { isDatabaseViewOf, parentConnectionId } from "@/lib/connectionLabel";
import type { ColumnInfo, DatabaseInfo, IndexInfo, TableInfo } from "@/types";

/**
 * Fetch a connection's schema once, on mount, unless it is already loaded or a
 * fetch is in flight.
 *
 * Both explorers had a byte-identical copy of this effect, and the guard is the
 * subtle part: `!cs.loading` matters because `refresh` calls
 * `set({ loading: true })`, which mints a new slice reference, re-runs the
 * effect, and would fire a second concurrent fetch before the first returns —
 * a tight loop on the slower drivers (MySQL). The `!cs` arm covers the very
 * first render, before any slice exists.
 *
 * `id` is whatever the caller renders for: a profile id in the single-database
 * explorer, the *parent* id in the multi-database one (its own tables live in
 * the `::db::` child slices, ADR #36).
 */
export function useEnsureSchemaLoaded(id: string): void {
  const cs = useSchema((s) => s.byConnection[id]);
  const refresh = useSchema((s) => s.refresh);
  useEffect(() => {
    if (!cs || (!cs.initialized && !cs.loading)) refresh(id);
  }, [id, cs, refresh]);
}

/** Per-connection slice of schema state. */
export interface ConnectionSchema {
  databases: DatabaseInfo[];
  tables: TableInfo[];
  /** Columns keyed by `${schema}.${table}`. */
  columns: Record<string, ColumnInfo[]>;
  /** Indexes keyed by `${schema}.${table}`. */
  indexes: Record<string, IndexInfo[]>;
  /**
   * Error from the last `loadColumns` call for a given table key, if it
   * failed. Lets the explorer stop showing a loading skeleton forever on a
   * rejected promise (a timed-out or `NotConnected` metadata call) and offer
   * a retry instead. Cleared on the next successful load for that key.
   */
  columnErrors: Record<string, string>;
  /** Same as `columnErrors`, for `loadIndexes`. */
  indexErrors: Record<string, string>;
  /**
   * On-disk size per database name, from `getDatabaseSizes` (#153).
   *
   * A name is present only once the engine answered a size for it. A database
   * the engine would not size is simply absent, which is the same thing the
   * absent `size_bytes` key means and keeps "would not say" distinct from
   * "empty" all the way to the badge.
   */
  databaseSizes: Record<string, number>;
  /** True while `loadDatabaseSizes` is in flight, so it can't be re-entered. */
  databaseSizesLoading: boolean;
  /** True once a `loadDatabaseSizes` pass has settled — success or failure.
   *  Distinguishes "no badge because nothing was asked for" from "asked, and
   *  this engine would not say". */
  databaseSizesLoaded: boolean;
  /** Set of tree-node keys (e.g. `schema:public`, `table:public.users`). */
  expanded: Set<string>;
  loading: boolean;
  error: string | null;
  /**
   * True once `refresh` has completed at least once successfully for this
   * connection. Stays false when the slice is created by `replaceExpanded`
   * (workspace hydration) so the explorer can distinguish "data loaded and
   * empty" from "never fetched yet".
   */
  initialized: boolean;
}

/** Options every fetch in this store accepts. */
export interface SchemaLoadOptions {
  /**
   * Record the failure on the slice but do not report it.
   *
   * For the two callers that report a *better* message than this store can:
   * `connectAndWarm` names the profile and adds the wrong-driver hint, and
   * `warmDatabases` reports one summary for a whole fan-out instead of a card
   * per database. Two opt-outs at the seam rather than an opt-in at every
   * other call site — the same shape as `DataGrid`'s `decorateCellSave(quiet)`.
   */
  quiet?: boolean;
}

/**
 * Record a failed fetch on the slice **and** report it.
 *
 * Modelled on `environments.ts`'s `fail`, for the same reason: a store that
 * only writes an `error` field is a store whose failures depend on some
 * component happening to render that field. Here the connection-level one is a
 * bare red line inside the tree that is not even mounted unless the row is
 * expanded and active, and the per-table index error was rendered by nothing
 * at all — so a MongoDB server that had gone away could report itself only by
 * the keepalive noticing, three minutes later. See ADR #68.
 *
 * Grouped per connection, not per call: expanding a database with forty tables
 * against a dead server must be one card counting to forty, not forty cards.
 * The anatomy is `surfaceFor`'s decision alone (ADR #64) — all this passes is
 * the message and the group.
 *
 * The i18n singleton rather than the hook, like `environments.ts`: a store is
 * not a component.
 */
function reportSchemaFailure(
  e: unknown,
  titleKey: string,
  connectionId: string,
  quiet: boolean,
): string {
  const message = String(e);
  if (!quiet) {
    notify.error(i18n.t(titleKey), {
      description: message,
      group: `schema-load:${connectionId}`,
    });
  }
  return message;
}

interface SchemaState {
  byConnection: Record<string, ConnectionSchema>;
  /**
   * Re-fetch databases + tables for `connectionId`, **invalidating** the
   * cached columns/indexes with them and re-loading the ones whose tree node
   * is still open.
   *
   * This only ever touches the one slice it is given. On a multi-DB
   * connection that is almost never the slice the user is looking at — use
   * [`refreshTree`] from anything holding a profile id.
   */
  refresh: (
    connectionId: string,
    opts?: SchemaLoadOptions,
  ) => Promise<string | null>;
  /**
   * Refresh a connection *and* every per-database child slice opened beneath
   * it (`<parent>::db::<db>`).
   *
   * A server-wide connection's tables live in the child slices, never in the
   * parent's — the parent's `list_tables` answers for the login's default
   * database (Postgres) or for nothing at all (MySQL, where `SELECT
   * DATABASE()` is NULL). So a plain `refresh(parentId)` re-fetched a list
   * nobody renders and left the visible subtree untouched, which is what made
   * "Refresh" look broken for a table created outside the app.
   */
  refreshTree: (connectionId: string) => Promise<void>;
  /** Toggle a tree-node key in the `expanded` set. */
  toggleNode: (connectionId: string, key: string) => void;
  /** Populate `columns[tableKey(schema, table)]`. */
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
    opts?: SchemaLoadOptions,
  ) => Promise<void>;
  /** Populate `indexes[tableKey(schema, table)]`. */
  loadIndexes: (
    connectionId: string,
    schema: string | undefined,
    table: string,
    opts?: SchemaLoadOptions,
  ) => Promise<void>;

  /**
   * Fetch the per-database sizes for `connectionId`, once.
   *
   * **Deferred on purpose, and never part of the launch refresh.** On Postgres
   * this is `pg_database_size`, which is not a catalog read but a walk of the
   * database's directory calling `stat` per file — seconds on a server with
   * nineteen large databases, against a 20 s backend timeout. It is called
   * when the tree actually renders a database node, not when a connection
   * opens.
   *
   * Failure is swallowed: this is a badge, and an engine that will not answer
   * should cost the badge and nothing else.
   */
  loadDatabaseSizes: (connectionId: string) => Promise<void>;
  /**
   * Fill in the row-count and size badges `refresh` left blank.
   *
   * Started by `refresh` and never awaited by it, for the reason
   * `api.getTableStats` exists: the figures are the part of a listing that
   * grows with the relation count — one command per collection on MongoDB, a
   * statistics catalog or a filesystem walk on the SQL drivers — and on a
   * database with thousands of tables waiting for them was nearly the whole
   * delay before the tree showed a single name.
   *
   * Failure is swallowed, like `loadDatabaseSizes`: this is a badge.
   */
  loadTableStats: (connectionId: string) => Promise<void>;
  /**
   * Open an empty slice for `connectionId` without fetching anything — a
   * no-op when one already exists.
   *
   * The per-table loaders drop their answer when there is no slice, on
   * purpose: that is how a response outliving a `drop` avoids resurrecting a
   * disconnected connection. In the main window the slice is always there
   * first, because connecting runs `refresh`. A detached tab window never
   * connects — the pool is already open in the shared backend — so nothing
   * opened its slice, every `loadColumns` answer was thrown away, and the
   * table's query panel button spun forever. A window that hosts a tab for a
   * connection it did not open calls this first.
   */
  ensure: (connectionId: string) => void;
  /** Drop all cached data for `connectionId` (called on disconnect). */
  drop: (connectionId: string) => void;
  /**
   * Replace the expanded-node set for `connectionId` in one shot. Used by
   * the persisted-workspace hydration path so the saved tree state lands
   * without firing N `toggleNode` events.
   */
  replaceExpanded: (connectionId: string, expanded: Set<string>) => void;
}

function emptyState(): ConnectionSchema {
  return {
    databases: [],
    tables: [],
    columns: {},
    indexes: {},
    columnErrors: {},
    indexErrors: {},
    databaseSizes: {},
    databaseSizesLoading: false,
    databaseSizesLoaded: false,
    expanded: new Set(),
    loading: false,
    error: null,
    initialized: false,
  };
}

/**
 * Fetches in flight, per connection, keyed by what they fetch.
 *
 * Every loader here used to start a fresh round trip on every call. The tree
 * calls them from effects and handlers that cannot see each other, so the same
 * question was routinely asked twice at once: connecting with the row already
 * expanded fired one `refresh` from the explorer's mount effect and a second
 * from `connectAndWarm` — two `list_databases` and two `list_tables` per
 * connect — and collapsing a table and re-opening it before its columns
 * arrived asked for them again. A second caller now **joins** the call already
 * running and gets its answer.
 *
 * Joining means the first caller's options win: if it was `quiet`, a failure
 * is reported by nobody but the callers that read the returned message, which
 * is exactly what a quiet caller asked for. Per connection so `drop` can
 * forget a closed pool's calls in one step.
 */
const inFlight = new Map<string, Map<string, Promise<unknown>>>();

function joinInFlight<T>(
  connectionId: string,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  let calls = inFlight.get(connectionId);
  const running = calls?.get(what);
  if (running) return running as Promise<T>;
  if (!calls) {
    calls = new Map();
    inFlight.set(connectionId, calls);
  }
  const owner = calls;
  const promise = run().finally(() => {
    // Only remove our own entry: `drop` may have replaced the whole map, and a
    // newer call under the same key may already be running in it.
    if (owner.get(what) === promise) owner.delete(what);
    if (owner.size === 0 && inFlight.get(connectionId) === owner) {
      inFlight.delete(connectionId);
    }
  });
  owner.set(what, promise);
  return promise;
}

/** Stable cache key for a (schema, table) pair. */
export function tableKey(schema: string | undefined, table: string) {
  return `${schema ?? ""}.${table}`;
}

/**
 * Whether a listing came back without the per-relation figures, so that
 * `loadTableStats` has something to fill in.
 *
 * Every driver's listing is names-only today, so in practice this is "not
 * empty". It is still read off the rows rather than assumed: a listing that
 * does carry figures (an older backend, a future driver whose catalog makes
 * them free) would make a second call a wasted one, and the store does not
 * know the driver to decide that any other way.
 */
export function needsTableStats(tables: TableInfo[]): boolean {
  return (
    tables.length > 0 &&
    tables.every((t) => t.row_count == null && t.size_bytes == null)
  );
}

/**
 * Fold `getTableStats` rows into a listing by `(schema, name)`.
 *
 * Returns the same array when nothing changed, so a stats answer for a table
 * list that has since been replaced costs no re-render. A row the listing no
 * longer has is ignored rather than added: the listing decides what exists.
 */
export function mergeTableStats(
  tables: TableInfo[],
  stats: TableInfo[],
): TableInfo[] {
  if (stats.length === 0) return tables;
  const byKey = new Map(stats.map((s) => [tableKey(s.schema, s.name), s]));
  let changed = false;
  const merged = tables.map((t) => {
    const s = byKey.get(tableKey(t.schema, t.name));
    if (!s || (s.row_count == null && s.size_bytes == null)) return t;
    changed = true;
    return { ...t, row_count: s.row_count, size_bytes: s.size_bytes };
  });
  return changed ? merged : tables;
}

export const useSchema = create<SchemaState>((set, get) => ({
  byConnection: {},
  refresh: (connectionId, opts) =>
    joinInFlight(connectionId, "refresh", async () => {
      const quiet = opts?.quiet ?? false;
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...(state.byConnection[connectionId] ?? emptyState()),
            loading: true,
            error: null,
          },
        },
      }));
      try {
        // A per-database view answers `list_databases` with the *server's*
        // list — the same one its parent already holds — so asking again was
        // a server-wide catalog read on every database expanded, kept only for
        // the rename dialog's destination picker. Borrow the parent's when it
        // has one; a view refreshed on its own (parent never listed) still
        // asks.
        const parent = parentConnectionId(connectionId);
        const known =
          parent !== connectionId
            ? get().byConnection[parent]?.databases
            : undefined;
        const [databases, tables] = await Promise.all([
          known && known.length > 0
            ? Promise.resolve(known)
            : api.listDatabases(connectionId),
          api.listTables(connectionId),
        ]);
        // Tables whose per-table metadata was cached *and* whose node is still
        // open — read before the wipe below so they can be re-fetched after it.
        // Computed here rather than inside the `set` updater to keep that
        // updater a pure state transition.
        const before = get().byConnection[connectionId];
        const reloadColumns: TableInfo[] = [];
        const reloadIndexes: TableInfo[] = [];
        for (const t of tables) {
          if (!before) break;
          const k = tableKey(t.schema, t.name);
          if (!before.expanded.has(`table:${k}`)) continue;
          if (before.columns[k] || before.columnErrors[k]) reloadColumns.push(t);
          if (before.indexes[k] || before.indexErrors[k]) reloadIndexes.push(t);
        }
        set((state) => {
          // Discard a response that outlived its slice — see the note in the
          // catch below.
          const current = state.byConnection[connectionId];
          if (!current) return state;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                databases,
                tables,
                // Invalidate the per-table metadata too. Keeping it across a
                // refresh is what made an `ALTER TABLE ADD COLUMN` performed
                // outside the app invisible forever: `TableRow` only calls
                // `loadColumns` when the key is *absent* (a deliberate guard, so
                // collapsing and re-expanding doesn't re-query), and the only
                // other thing that ever cleared these was `drop()` on
                // disconnect. "Refresh" has to mean the schema, not just the
                // table list.
                columns: {},
                indexes: {},
                columnErrors: {},
                indexErrors: {},
                // Sizes go with them, for the reason the comment above gives:
                // "Refresh" means the schema. A database that grew — or was
                // dropped and recreated — outside the app would otherwise keep
                // showing the size it had when the tree was first opened, with
                // no way to correct it short of disconnecting. Cleared rather
                // than re-fetched: the next database node to render asks again,
                // so the cost is only paid if something is actually on screen.
                databaseSizes: {},
                databaseSizesLoading: false,
                databaseSizesLoaded: false,
                loading: false,
                initialized: true,
              },
            },
          };
        });
        // Badges after the names, never before them — and not awaited, so a
        // caller awaiting `refresh` (connecting, the warm scheduler) is not held
        // up by figures nobody is blocked on.
        if (needsTableStats(tables)) void get().loadTableStats(connectionId);
        // Re-populate what the user has open, so an expanded table comes back
        // with its (now current) columns instead of an empty node the guard
        // above would never fill on its own.
        await Promise.all([
          ...reloadColumns.map((t) =>
            get().loadColumns(connectionId, t.schema, t.name, { quiet }),
          ),
          ...reloadIndexes.map((t) =>
            get().loadIndexes(connectionId, t.schema, t.name, { quiet }),
          ),
        ]);
        return null;
      } catch (e) {
        // Nothing to report when the slice is already gone: the staleness case
        // described in the updater below means this error describes a pool that
        // no longer exists, and a card about it would be pure noise arriving
        // after a disconnect. Read before the `set` — nothing awaits in between,
        // so this is the same check the updater makes.
        if (!get().byConnection[connectionId]) return null;
        const message = reportSchemaFailure(
          e,
          "schema.loadFailed",
          connectionId,
          quiet,
        );
        set((state) => {
          // If `drop(connectionId)` ran while this call was in flight, the
          // connection is gone (disconnected, or its environment was switched
          // away from) and this result is stale. Writing it would *resurrect* the
          // slice, because the spread below used to fall back to `emptyState()`
          // for a missing entry — and resurrecting it on the error path is
          // permanent damage, not a cosmetic glitch: the entry comes back with
          // `initialized: true`, which is exactly the flag that stops the
          // explorer's `!initialized && !loading` guard from ever retrying.
          //
          // That is the "not connected: <id>" that survived a full reconnect: the
          // teardown closed the pool, an in-flight `list_tables` lost the race and
          // landed after the drop, and the healthy connection that came back
          // inherited a poisoned slice no automatic path would ever refresh.
          const current = state.byConnection[connectionId];
          if (!current) return state;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                loading: false,
                // Mark as initialized even on failure so the useEffect guard
                // (`!cs.initialized && !cs.loading`) does not auto-retry and
                // create a loop. The user can retry manually via the refresh
                // button. Safe only because of the staleness check above.
                initialized: true,
                error: message,
              },
            },
          };
        });
        return message;
      }
    }),
  refreshTree: async (connectionId) => {
    // Accept either id shape: a child id resolves to its parent, so a caller
    // never has to know which one it is holding.
    const parent = parentConnectionId(connectionId);
    const ids = new Set([
      parent,
      connectionId,
      ...Object.keys(get().byConnection).filter((id) =>
        isDatabaseViewOf(id, parent),
      ),
    ]);
    // Per-connection failures are already captured on each slice's `error`,
    // so one unreachable child can't abort the rest.
    await Promise.all([...ids].map((id) => get().refresh(id)));
  },
  toggleNode: (connectionId, key) => {
    const cur = get().byConnection[connectionId] ?? emptyState();
    const expanded = new Set(cur.expanded);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: { ...cur, expanded },
      },
    }));
  },
  loadColumns: (connectionId, schema, table, opts) =>
    joinInFlight(connectionId, `columns:${tableKey(schema, table)}`, async () => {
      const key = tableKey(schema, table);
      try {
        const cols = await api.listColumns(connectionId, schema, table);
        set((state) => {
          // A response outliving its slice (the connection was dropped while
          // this call was in flight — see the note in `refresh`'s catch
          // branch) must not resurrect it.
          const current = state.byConnection[connectionId];
          if (!current) return state;
          // Drop the key entirely rather than storing `undefined`, so
          // `cs.columnErrors?.[key]` reads as absent, not as a falsy value.
          const { [key]: _cleared, ...columnErrors } = current.columnErrors;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                columns: { ...current.columns, [key]: cols },
                columnErrors,
              },
            },
          };
        });
      } catch (e) {
        // Never let a rejected promise here leave the explorer's column cell
        // stuck on its loading skeleton forever — record the error so the UI can
        // render its retry affordance, *and* report it. The inline row is the
        // better affordance and stays; the card is what makes the failure
        // reachable when the node is collapsed, folded away by the filter, or in
        // a window the user is not looking at.
        if (!get().byConnection[connectionId]) return;
        const message = reportSchemaFailure(
          e,
          "schema.columnsLoadFailed",
          connectionId,
          opts?.quiet ?? false,
        );
        set((state) => {
          const current = state.byConnection[connectionId];
          if (!current) return state;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                columnErrors: { ...current.columnErrors, [key]: message },
              },
            },
          };
        });
      }
    }),
  loadIndexes: (connectionId, schema, table, opts) =>
    joinInFlight(connectionId, `indexes:${tableKey(schema, table)}`, async () => {
      const key = tableKey(schema, table);
      try {
        const idx = await api.listIndexes(connectionId, schema, table);
        set((state) => {
          const current = state.byConnection[connectionId];
          if (!current) return state;
          const { [key]: _cleared, ...rest } = current.indexErrors;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                indexes: { ...current.indexes, [key]: idx },
                indexErrors: rest,
              },
            },
          };
        });
      } catch (e) {
        // `indexErrors` is read by no component yet (`IndexesSectionHeader` is
        // headers-only), so until this reported, a failed index read was written
        // to a field nothing rendered and was indistinguishable from a table with
        // no indexes. The card is currently the *only* way it surfaces.
        if (!get().byConnection[connectionId]) return;
        const message = reportSchemaFailure(
          e,
          "schema.indexesLoadFailed",
          connectionId,
          opts?.quiet ?? false,
        );
        set((state) => {
          const current = state.byConnection[connectionId];
          if (!current) return state;
          return {
            byConnection: {
              ...state.byConnection,
              [connectionId]: {
                ...current,
                indexErrors: { ...current.indexErrors, [key]: message },
              },
            },
          };
        });
      }
    }),
  replaceExpanded: (connectionId, expanded) => {
    const cur = get().byConnection[connectionId] ?? emptyState();
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: { ...cur, expanded },
      },
    }));
  },
  loadDatabaseSizes: async (connectionId) => {
    const cs = get().byConnection[connectionId];
    // The guard is the whole reason this is not just a call: a database node
    // renders once per database, so without it expanding a nineteen-database
    // server fires nineteen `pg_database_size` sweeps at once.
    if (!cs || cs.databaseSizesLoading || cs.databaseSizesLoaded) return;

    set((state) => {
      const current = state.byConnection[connectionId];
      if (!current) return state;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...current, databaseSizesLoading: true },
        },
      };
    });

    let sizes: Record<string, number> = {};
    try {
      for (const row of await api.getDatabaseSizes(connectionId)) {
        // `!= null` and no `?? 0`: an absent size means the engine would not
        // say, and defaulting it to zero here would tell the user a database
        // with 31 tables is empty — the exact case the MySQL arm exists for.
        if (row.size_bytes != null) sizes[row.name] = row.size_bytes;
      }
    } catch {
      // Swallowed by design. This is a badge; an engine that will not answer
      // costs the badge and nothing else. `databaseSizesLoaded` still flips,
      // so a permanently unprivileged connection is asked once, not per
      // render.
      sizes = {};
    }

    set((state) => {
      const current = state.byConnection[connectionId];
      // The connection may have been dropped while this was in flight.
      if (!current) return state;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            databaseSizes: sizes,
            databaseSizesLoading: false,
            databaseSizesLoaded: true,
          },
        },
      };
    });
  },
  loadTableStats: async (connectionId) => {
    let stats: TableInfo[];
    try {
      stats = await api.getTableStats(connectionId);
    } catch {
      // Swallowed by design, like `loadDatabaseSizes`: an engine or a role
      // that will not answer costs the badges, and the names are already up.
      return;
    }
    set((state) => {
      const current = state.byConnection[connectionId];
      // Dropped while in flight: writing would resurrect the slice.
      if (!current) return state;
      const tables = mergeTableStats(current.tables, stats);
      if (tables === current.tables) return state;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...current, tables },
        },
      };
    });
  },
  ensure: (connectionId) => {
    if (get().byConnection[connectionId]) return;
    set((state) => ({
      byConnection: { ...state.byConnection, [connectionId]: emptyState() },
    }));
  },
  drop: (connectionId) => {
    // A call still in flight for this connection belongs to the pool that was
    // just closed. Left in the table, the next connection's first `refresh`
    // would *join* it and inherit its "not connected" — the poisoned slice
    // the comment in `refresh`'s catch describes, by a new route.
    inFlight.delete(connectionId);
    set((state) => {
      const copy = { ...state.byConnection };
      delete copy[connectionId];
      return { byConnection: copy };
    });
  },
}));
