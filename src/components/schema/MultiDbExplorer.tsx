/**
 * Multi-DB explorer — for a profile whose `database` is blank. Lists every
 * database the user can see on the server as a top-level node; expanding one
 * lazily opens a synthetic `<parent>::db::<name>` connection
 * (`open_database_view`) and the nested subtree is a regular
 * `SingleDbExplorer` pointed at that synthetic id.
 *
 * Two things here are load-bearing and documented at the site as well:
 *
 * - **Nothing here opens a connection pool on its own.** The cross-database
 *   search prefetch that used to live in this file is gone; warming is an
 *   explicit action on the filter box (`lib/schema/warmForSearch.ts`).
 * - **The `useMemo`s stay above the `if (!cs)` early return**, for the same
 *   hook-count reason `SingleDbExplorer`'s header spells out.
 *
 * **This file no longer owns any part of the search.** It used to debounce the
 * needle itself, compute its own match set over a wide `byConnection`
 * subscription, and keep a hidden second scope (`activeDatabaseName`, set as a
 * side effect of expanding a database). All three now live in the tree: the
 * needle is committed once, counted once, and arrives here already parsed
 * (`patterns`) alongside this connection's `summary`.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  DatabaseZap,
  ListFilter,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import { usePolicyLock } from "@/lib/policy/access";

import { DatabaseNodeMenu } from "@/components/schema/DatabaseNodeMenu";
import { SingleDbExplorer } from "@/components/schema/SingleDbExplorer";
import { SchemaLoadError, TreeSkeleton } from "@/components/schema/TreeStatus";
import { CreateDatabaseDialog } from "@/components/schema/dialogs/CreateDatabaseDialog";
import { DatabaseVisibilityDialog } from "@/components/schema/dialogs/DatabaseVisibilityDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TreeRow } from "@/components/ui/tree-row";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { useVisibleDatabases } from "@/lib/connection/useVisibleDatabases";
import { databaseViewId } from "@/lib/connectionLabel";
import { scopeIncludesDatabase } from "@/lib/schema/filterScope";
import {
  supportsCreateDatabase,
  supportsDropDatabase,
} from "@/lib/db/driver";
import { api } from "@/lib/tauri";
import { cn, formatBytes } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";
import { useEnsureSchemaLoaded, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useTreeSearch } from "@/stores/session/treeSearch";
import { useUi } from "@/stores/session/ui";
import type { ConnectionMatchSummary } from "@/lib/schema/treeMatches";
import type { Driver } from "@/types";

export const MultiDbExplorer = memo(function MultiDbExplorer({
  parentId,
  patterns,
  summary,
}: {
  parentId: string;
  /** The committed, parsed needle, forwarded by `SchemaExplorer`. */
  patterns: string[];
  /** This connection's match counts, computed once by the tree. */
  summary?: ConnectionMatchSummary;
}) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[parentId]);
  const toggleNode = useSchema((s) => s.toggleNode);
  // CREATE DATABASE is server-level DDL, only meaningful for Postgres/MySQL —
  // SQLite never reaches multi-DB mode at all, and MongoDB creates databases
  // implicitly on first write (see `create_database`'s doc comment).
  // The whole profile: we need the driver AND the visible-databases subset
  // (#64). `find` returns the existing object ref (stable until `profiles` is
  // replaced), so this is a safe selector (gotcha #1 forbids fresh arrays/
  // objects, not existing refs).
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === parentId),
  );
  const driver = profile?.driver;
  const canCreateDatabase = supportsCreateDatabase(driver);
  const canDropDatabase = supportsDropDatabase(driver);
  const createDbLock = usePolicyLock(parentId, "ddl");
  // DataGrip-style visible-databases subset. `null`/empty = show all. Resolved
  // across both layers (this environment's override, then the profile) rather
  // than read off the profile: the profile is global, so reading it directly is
  // what used to leak one environment's subset into all the others.
  const visibleDatabases = useVisibleDatabases(parentId);
  // Whether the subset in force is this environment's override rather than the
  // profile's default — worth saying out loud in the header, since the same
  // connection can legitimately show a different set in the next environment.
  const subsetIsLocal = useUi(
    (s) => s.databaseVisibility[parentId] !== undefined,
  );
  const visibleSet = useMemo(
    () =>
      visibleDatabases && visibleDatabases.length > 0
        ? new Set(visibleDatabases)
        : null,
    [visibleDatabases],
  );
  /**
   * The database the user last looked at, as a *visual* accent only.
   *
   * It used to be local state that doubled as a hidden second filter scope:
   * expanding a database silently narrowed the search to it and collapsed its
   * siblings, with nothing on screen saying so. The search no longer reads it
   * at all — the scope is explicit, visible and lives in `useTreeSearch` — and
   * what is left of it moved to `useUi` so the scope affordances and the tree
   * act on one value. Read as a primitive, so the selector is safe (gotcha #1).
   */
  const activeDatabaseName =
    useUi((s) => s.activeDatabaseByConnection[parentId]) ?? null;
  const setActiveDatabase = useUi((s) => s.setActiveDatabase);

  /** The explicit scope, so a narrowed search shows only what it searches. */
  const scope = useTreeSearch((s) => s.scope);
  const narrowTo = useTreeSearch((s) => s.narrowTo);
  const requestSearchFocus = useTreeSearch((s) => s.requestFocus);

  useEnsureSchemaLoaded(parentId);

  // Both dialogs the empty state offers. Mounted from here rather than reached
  // through the connection's context menu because the whole point of the empty
  // state is that the tree gives the user nothing to right-click on: the row
  // that would carry that menu is the one that does not exist.
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);

  const filterActive = patterns.length > 0;

  // No eager warm on connect: with many databases (a server with 19+ is
  // common) precaching every child's table list made the initial load
  // noticeably slow, and the DataGrip-style visible-databases selector (#64)
  // plus lazy expand already give the user control over what actually loads.
  //
  // Nor any warm while *typing*. This file used to run a bounded prefetch off
  // the debounced needle, so a search reached databases nobody had opened —
  // at the cost of a connection pool per database, driven by a keystroke.
  // Searching now looks only at what is already in `useSchema`, and reaching
  // further is an explicit action on the filter box (`warmForSearch`). A
  // freshly connected server is therefore "cold" until asked, and the tree
  // says so rather than reporting a `0` it cannot back up.

  /**
   * Which database rows to render, and what each one knows about itself.
   *
   * With no filter that is simply the visible subset. With one, a database
   * earns its row by containing a match, by its own name matching, or by being
   * cold — we have not read it, so hiding it would be claiming it is empty.
   *
   * This memo MUST live above the early return below: React relies on hooks
   * being called in the same order on every render, so a conditional
   * `if (!cs) return …` above it would skip the hook on the first render and
   * call it on subsequent ones — a Rules of Hooks violation that blanked the
   * whole multi-DB panel in 0.7.0 / 0.7.1 (no error UI, just an empty tree).
   */
  const dbRows = useMemo(() => {
    const visible = (cs?.databases ?? [])
      .filter((db) => !visibleSet || visibleSet.has(db.name))
      // A database scope on *this* connection hides its siblings, even before
      // anything is typed: "search here only" that still lists everywhere
      // would be a strange thing to look at. A scope naming a *different*
      // connection deliberately does not touch this list — narrowing the
      // search elsewhere must not blank out an unrelated server's databases;
      // that connection's own row already dims and folds while a search is
      // running (`out-of-scope`).
      .filter(
        (db) =>
          scope.kind !== "database" ||
          scope.connectionId !== parentId ||
          scopeIncludesDatabase(scope, parentId, db.name),
      );
    if (!filterActive) {
      return visible.map((db) => ({
        db,
        count: 0,
        cold: false,
        nameMatch: false,
      }));
    }
    const cold = new Set(summary?.coldDatabases ?? []);
    const nameMatches = new Set(summary?.databaseNameMatches ?? []);
    return visible.flatMap((db) => {
      const count = summary?.byDatabase.get(db.name) ?? 0;
      const isCold = cold.has(db.name);
      const nameMatch = nameMatches.has(db.name);
      if (count === 0 && !isCold && !nameMatch) return [];
      return [{ db, count, cold: isCold, nameMatch }];
    });
  }, [cs?.databases, visibleSet, filterActive, summary, scope, parentId]);

  // See `SingleDbExplorer`: the slice exists from the first instant of the
  // first read, so "no slice" alone never showed the user anything.
  if (!cs || (!cs.initialized && !cs.error)) {
    return (
      <TreeSkeleton
        label={t("schema.loading")}
        rows={4}
        className="space-y-1.5 px-3 py-2"
      />
    );
  }

  /**
   * Note the database a table was just opened from, for the brand accent.
   *
   * It used to also collapse every *other* expanded database, on the theory
   * that the user was now working in this one. While a search is running that
   * is exactly wrong — the whole point is that results from several databases
   * are on screen at once — so the sibling collapse is skipped in that case.
   */
  const activateDb = (dbName: string) => {
    setActiveDatabase(parentId, dbName);
    if (filterActive) return;
    for (const key of cs.expanded) {
      if (key.startsWith("db:") && key !== `db:${dbName}`) {
        toggleNode(parentId, key);
      }
    }
  };

  return (
    <div className="flex flex-col">
      {visibleSet && (
        <div className="px-3 pb-2">
          {/* The header's brand-tinted "select databases" icon used to be the only
              sign that a subset was hiding databases. With the actions moved to the
              connection's context menu that cue would have vanished silently, so it
              is stated here instead. */}
          {visibleSet && (
            <div className="text-2xs text-muted-foreground">
              {t(
                subsetIsLocal
                  ? "schema.selectDatabases.subsetActiveLocal"
                  : "schema.selectDatabases.subsetActive",
                {
                  count: visibleSet.size,
                  total: cs.databases.length,
                },
              )}
            </div>
          )}
        </div>
      )}
      {cs.error && (
        <SchemaLoadError
          message={cs.error}
          onRetry={() => void useSchema.getState().refresh(parentId)}
        />
      )}
      <div className="pb-1 text-sm">
        {/* Only ever said about databases we have actually read: a cold one
            still gets a row, so `dbRows` being empty means every visible
            database reported and none of them matched. This is the line the
            old `prefetching` flag could never let through once a
            visible-databases subset was active. */}
        {filterActive && dbRows.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {/* The tree with nothing in it. Until 1.23.1 this rendered literally
            nothing — no row, no sentence — which reads as a connection that
            failed rather than a server that is empty, and left the only way to
            create the first database (the connection row's context menu) as
            something the user had to already know about. The two reasons a
            server shows no databases need different answers, so they are told
            apart rather than sharing one vague line. */}
        {!filterActive && dbRows.length === 0 && (
          <div className="space-y-2 px-3 py-3">
            <div className="text-xs text-muted-foreground">
              {t(
                cs.databases.length === 0
                  ? "schema.noDatabases.empty"
                  : "schema.noDatabases.allHidden",
                { total: cs.databases.length },
              )}
            </div>
            {cs.databases.length === 0
              ? canCreateDatabase && (
                  <PolicyLockHint reason={createDbLock}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={!!createDbLock}
                      onClick={() => setCreateDbOpen(true)}
                    >
                      <DatabaseZap className="mr-1.5 h-3.5 w-3.5" />
                      {t("schema.createDatabase.title")}
                    </Button>
                  </PolicyLockHint>
                )
              : /* Hidden, not absent: the fix is the visibility picker, and
                   offering "new database" here would answer a question the
                   user did not ask. */
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setDbPickerOpen(true)}
                >
                  <ListFilter className="mr-1.5 h-3.5 w-3.5" />
                  {t("schema.selectDatabases.title")}
                </Button>}
          </div>
        )}
        {dbRows.map(({ db, count, cold, nameMatch }) => (
          <DatabaseRoot
            key={`${parentId}::${db.name}`}
            parentId={parentId}
            dbName={db.name}
            driver={driver}
            canDrop={canDropDatabase}
            expanded={cs.expanded.has(`db:${db.name}`)}
            onToggle={() => toggleNode(parentId, `db:${db.name}`)}
            onScopeHere={() => {
              narrowTo({
                kind: "database",
                connectionId: parentId,
                database: db.name,
              });
              requestSearchFocus();
            }}
            onTableOpen={() => activateDb(db.name)}
            patterns={patterns}
            filterActive={filterActive}
            // Auto-expand databases that contain a table match so the result
            // is visible immediately. A name-only match keeps the database
            // collapsed — the user is presumably picking the database, not
            // browsing inside it — and a cold one has nothing to show yet.
            autoExpand={count > 0}
            matchCount={filterActive && !cold ? count : null}
            cold={cold}
            nameMatch={nameMatch}
            active={activeDatabaseName === db.name}
            // Only dim siblings when a concrete database is the accent. With
            // none, every database is equally in play and dimming would be
            // misleading.
            dimmed={
              activeDatabaseName != null && activeDatabaseName !== db.name
            }
          />
        ))}
      </div>
      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={parentId}
          onClose={() => setCreateDbOpen(false)}
          onDone={(name) => {
            setCreateDbOpen(false);
            // The new row appearing in the tree is the confirmation here — the
            // subtree is by definition expanded, since the user is looking at
            // its empty state — so this refreshes and stays quiet.
            void useSchema.getState().refresh(parentId);
            notify.success(t("schema.createDatabase.created", { name }));
          }}
        />
      )}
      {dbPickerOpen && (
        <DatabaseVisibilityDialog
          profileId={parentId}
          databases={cs.databases.map((db) => db.name)}
          onClose={() => setDbPickerOpen(false)}
        />
      )}
    </div>
  );
});

/** One database row in the multi-DB explorer. Lazily opens the synthetic
 *  child pool the first time it is expanded; subsequent expansions reuse
 *  it. */
function DatabaseRoot({
  parentId,
  dbName,
  driver,
  canDrop,
  expanded,
  onToggle,
  onScopeHere,
  onTableOpen,
  patterns,
  filterActive,
  autoExpand,
  matchCount,
  cold,
  nameMatch,
  active,
  dimmed,
}: {
  parentId: string;
  dbName: string;
  /** Parent connection's driver — gates the Mongo-only "New collection" entry. */
  driver: Driver | undefined;
  /** Whether dropping the database is offered — every driver but SQLite. */
  canDrop: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Narrow the tree's search to this database (explicit, from the menu). */
  onScopeHere: () => void;
  /** Called when the user opens a table inside this DB. */
  onTableOpen: () => void;
  /** The committed, parsed needle, forwarded to the nested explorer. */
  patterns: string[];
  /** True when the parent filter has any content; auto-expands already-opened
   *  databases so search results surface without an extra click. */
  filterActive: boolean;
  /** True when the parent has determined this DB contains a table match
   *  for the current filter — auto-opens the subtree (Compass-style). */
  autoExpand?: boolean;
  /** Matches inside this database, or `null` when there is nothing to say
   *  (no filter, or the database has never been read). */
  matchCount: number | null;
  /** True when this database's table list has never been fetched. */
  cold: boolean;
  /** True when the database's own name is what matched. */
  nameMatch: boolean;
  /** True when this is the DB the filter is scoped to (brand marker). */
  active: boolean;
  /** True when *another* DB is the active scope — render this one dimmed. */
  dimmed: boolean;
}) {
  const { t } = useTranslation();
  const [childId, setChildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // Subscribe to the primitive, never to a derived object (gotcha #1): this
  // is one number out of a record, compared by value.
  const sizeBytes = useSchema(
    (s) => s.byConnection[parentId]?.databaseSizes[dbName],
  );
  const loadDatabaseSizes = useSchema((s) => s.loadDatabaseSizes);
  // Asked for when a database node actually renders, not when the connection
  // opens. `loadDatabaseSizes` is idempotent and guarded, so the nineteen
  // nodes of a nineteen-database server produce one sweep between them — see
  // its doc comment for why that guard is the point rather than a nicety.
  useEffect(() => {
    void loadDatabaseSizes(parentId);
  }, [loadDatabaseSizes, parentId]);
  const sizeBadge = sizeBytes != null ? formatBytes(sizeBytes) : null;
  // See `ConnectionActionsMenu`'s matching state: the row that was
  // right-clicked stops looking hovered as soon as the pointer moves onto
  // the open menu, so this drives the same ring explicitly instead.
  const [menuOpen, setMenuOpen] = useState(false);

  // Resolve this database's synthetic `<parentId>::db::<db>` child id,
  // opening the pool the first time any action here needs it — every
  // per-database action below goes through this rather than calling
  // `api.openDatabaseView` directly. `openTrackedDatabaseView` (not the bare
  // `api` wrapper) is what hydrates the child's persisted tabs/schema
  // expansion and attaches its save subscription on that first open; a table,
  // query or security tab opened against a child id that skipped this never
  // gets remembered — not on the next reconnect, not across an environment
  // switch, not even across a plain app restart (see the CHANGELOG entry).
  // Returns `null` (after setting and reporting `error`) if the open fails, so
  // callers can just bail with `if (!id) return;`.
  //
  // Reported as well as recorded, because `error` renders inside the
  // `effectiveExpanded` branch below — and every context-menu action on this
  // node ("New query here", "New table", "Security", export, import, "New
  // collection", "Refresh") goes through here on a node that may well be
  // *collapsed*. There the state was written into a branch that is not
  // mounted, so the menu item did nothing at all and said nothing about it.
  // See ADR #68.
  //
  // One open at a time: the expand effect and a context-menu action fired
  // while it is still running used to open the view twice — two pools against
  // the server, the second replacing the first. A second caller now waits on
  // the first open instead.
  const opening$ = useRef<Promise<string | null> | null>(null);
  const resolveChildId = (): Promise<string | null> => {
    if (childId) return Promise.resolve(childId);
    if (!opening$.current) {
      opening$.current = openChild().finally(() => {
        opening$.current = null;
      });
    }
    return opening$.current;
  };
  const openChild = async (): Promise<string | null> => {
    try {
      const id = await openTrackedDatabaseView(parentId, dbName);
      setChildId(id);
      // Cleared here and not only in the expand effect, so a stale line does
      // not sit under a subtree that has since worked.
      setError(null);
      return id;
    } catch (e) {
      setError(String(e));
      notify.error(t("schema.openDatabaseFailed", { name: dbName }), {
        description: String(e),
      });
      return null;
    }
  };

  /**
   * Refresh what this node actually shows.
   *
   * The tables under a database live in its synthetic
   * `<parent>::db::<db>` slice, so refreshing the *parent* — which is what
   * this menu used to do — re-fetched a table list nobody renders and left
   * the visible subtree exactly as it was. A table created outside the app
   * never appeared, no matter how many times "Refresh" was clicked. Both
   * slices are refreshed: the parent for the database list itself, the child
   * for this database's collections/tables.
   *
   * `resolveChildId` opens the pool when this database has never been
   * expanded, the same lazy-open every other action in this menu does.
   */
  const refreshThisDatabase = async () => {
    const id = await resolveChildId();
    const schema = useSchema.getState();
    await Promise.all([
      schema.refresh(parentId),
      id ? schema.refresh(id) : Promise.resolve(),
    ]);
  };

  // Drop this database. On success we tear down the child pool's frontend
  // state (its schema slice + any open tabs) and refresh the parent tree so
  // the row disappears; the backend already closed the child pool.
  //
  // `confirmIrreversible`, not `confirmDestructive`: this used to read the
  // `ui.confirmDestructive` preference, which meant a user who had turned
  // confirmations off — a reasonable thing to do when the prompt is about
  // deleting a row you can re-insert — dropped a whole database on a single
  // menu click with nothing in between. A database is the definition of the
  // thing that helper's doc comment says belongs here.
  //
  // The multi-DB aftermath: the row goes away and the user carries on with
  // the rest of the tree. `SingleDbExplorer`'s version of this has to close
  // the connection instead, which is why `onDrop` is the menu's prop rather
  // than its own business.
  const dropThisDatabase = async () => {
    if (
      !(await confirmIrreversible(
        t("schema.dropDatabase.confirm", { name: dbName }),
      ))
    )
      return;
    try {
      await api.dropDatabase(parentId, dbName);
      const droppedId = databaseViewId(parentId, dbName);
      useTabs.getState().closeForConnection(droppedId);
      useSchema.getState().drop(droppedId);
      await useSchema.getState().refresh(parentId);
      notify.success(t("schema.dropDatabase.done", { name: dbName }));
    } catch (e) {
      // The success path above has always notified; this one only set state
      // that a collapsed node never renders, so a refused DROP was silent.
      setError(String(e));
      notify.error(t("schema.dropDatabase.failed", { name: dbName }), {
        description: String(e),
      });
    }
  };

  // Three ways the subtree can be open:
  //   1. The user clicked the chevron (`expanded`).
  //   2. The user is searching and the DB was already opened earlier
  //      (`filterActive && childId`).
  //   3. The Compass-style filter has determined this DB has matching
  //      tables and asks us to auto-open it (`autoExpand`).
  const effectiveExpanded =
    expanded || autoExpand || (filterActive && childId !== null);

  // Opens the view once per expand. `error` is in the guard on purpose: this
  // effect depends on `opening`, so without it a failed open flipped `opening`
  // back to false, re-ran the effect and tried again — forever, one error card
  // per attempt, against a server that was already saying no. A failure now
  // stays on screen with a Retry button (which clears it), and collapsing the
  // node forgets it so the next expand tries afresh.
  useEffect(() => {
    if (!effectiveExpanded || childId || opening || error) return;
    setOpening(true);
    void resolveChildId().finally(() => setOpening(false));
  }, [effectiveExpanded, childId, opening, error, parentId, dbName]);
  useEffect(() => {
    if (!effectiveExpanded) setError(null);
  }, [effectiveExpanded]);

  // The child's own read, as one boolean (gotcha #1). Together with `opening`
  // it is everything this node can be waiting on, and it is shown on the row
  // itself so it is visible with the node collapsed too — a menu "Refresh" on
  // a closed database used to give no sign of life at all.
  const childLoading = useSchema((s) =>
    childId ? (s.byConnection[childId]?.loading ?? false) : false,
  );
  const busy = opening || childLoading;

  return (
    <div>
      <DatabaseNodeMenu
        dbName={dbName}
        accessId={databaseViewId(parentId, dbName)}
        driver={driver}
        canDrop={canDrop}
        resolveTargetId={resolveChildId}
        onRefresh={refreshThisDatabase}
        onScopeHere={onScopeHere}
        onDrop={dropThisDatabase}
        onOpenChange={setMenuOpen}
      >
        <TreeRow
            menuOpen={menuOpen}
            className={cn(
              "transition-opacity",
              dimmed && "opacity-50 hover:opacity-100",
            )}
            // Expanding a database used to *also* narrow the filter to it and
            // collapse its siblings, invisibly. Now it only expands: the scope
            // is a separate, deliberate gesture ("Search here only", below).
            onClick={onToggle}
          >
            {effectiveExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            {/* Always reserve the dot's width so names don't shift when a DB
                becomes the active scope; only the active one is coloured. */}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                active ? "bg-brand" : "bg-transparent",
              )}
            />
            <Database
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                active ? "text-brand" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "truncate text-xs",
                nameMatch && "font-medium text-foreground",
              )}
            >
              {dbName}
            </span>
            {/* One `ml-auto` slot, two possible occupants, and the filter wins.
                A search is a transient question the user just asked and the
                match count is its answer; the size is ambient. Rendering both
                would also wrap the row at the width this panel is docked at. */}
            {!filterActive && busy && (
              <Spinner
                size="xs"
                className="ml-auto shrink-0 text-muted-foreground"
              />
            )}
            {!filterActive && !busy && sizeBadge !== null && (
              <span className="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-muted-foreground">
                {sizeBadge}
              </span>
            )}
            {filterActive && (
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-sm px-1 text-3xs leading-4 tabular-nums",
                  // A cold database says "—", never "0": nobody has read it,
                  // and a provisional zero is what makes a search look failed.
                  matchCount === null
                    ? "bg-muted text-muted-foreground/60"
                    : matchCount > 0
                      ? "bg-brand/15 text-brand"
                      : "bg-muted text-muted-foreground/60",
                )}
                title={cold ? t("connectionsTree.filter.counting") : undefined}
              >
                {matchCount ?? "—"}
              </span>
            )}
        </TreeRow>
      </DatabaseNodeMenu>
      {effectiveExpanded && (
        <div className="ml-3 border-l border-border/35 pl-0.5">
          {error && (
            <SchemaLoadError message={error} onRetry={() => setError(null)} />
          )}
          {opening && !childId && (
            <TreeSkeleton
              label={t("schema.loading")}
              className="space-y-1.5 px-3 py-2"
            />
          )}
          {childId && (
            <SingleDbExplorer
              connectionId={childId}
              headerLevel="nested"
              patterns={patterns}
              onTableOpen={onTableOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}
