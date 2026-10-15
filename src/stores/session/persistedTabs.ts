/**
 * Bridges the in-memory `useTabs` + `useSchema.expanded` stores with the
 * on-disk `tab_state.json` so a user's workspace (open tabs, the active
 * tab, expanded schema tree nodes) survives across app restarts on a
 * per-connection basis.
 *
 * Flow:
 *
 *   • On `connect(id)` →
 *       `hydrate(id)` reads the persisted blob (if any), respects the
 *       `restoreTabsOnOpen` UI preference, and replaces `useTabs` /
 *       `useSchema.expanded` for that connection atomically.
 *
 *   • While the connection is open →
 *       a single Zustand subscription on `useTabs` (filtered to the
 *       active connection's tabs) and on `useSchema.byConnection[id]`
 *       debounce-flushes the snapshot to disk 600ms after the last
 *       change.
 *
 *   • On `disconnect(id)` →
 *       `flush(id)` cancels the debounce and writes the latest snapshot
 *       synchronously, then detaches the subscriptions. We deliberately
 *       do NOT clear `useTabs` here — `useConnections.disconnect` calls
 *       `useTabs.closeForConnection` afterwards as before.
 *
 * One snapshot at a time is kept per connection. If the user connects,
 * disconnects, and reconnects in quick succession, we re-hydrate from
 * disk on the second connect — staleness between in-memory and disk
 * is bounded by the debounce window.
 *
 *   • On window close (main window only) →
 *       `flushAllTabState()` (wired from `App.tsx`'s `onCloseRequested`
 *       handler) synchronously saves every still-active connection plus the
 *       session-level workspace layout, bypassing the debounce. Before this
 *       existed, only an explicit `disconnect()` ever flushed synchronously —
 *       a normal window close (let alone a crash) could lose up to
 *       `SAVE_DEBOUNCE_MS` of trailing tab/layout edits.
 *
 * The inner-dockview split/float geometry is NOT per connection: one inner
 * dockview hosts every open connection's tabs, so its geometry is a
 * session-level artifact persisted once (top-level `workspaceLayout` in
 * `tab_state.json`) via `scheduleSaveActive` → `saveWorkspaceLayoutNow`, and
 * restored once at launch via `hydrateWorkspaceLayout`. It used to be
 * duplicated under every connection, which made restore order-dependent.
 */

import type { ConnectionTabState, PersistedTab, AppTab } from "@/types";
import { api } from "@/lib/tauri";
import i18n from "@/lib/i18n";
import { useTabs } from "@/stores/session/tabs";
import { useSchema } from "@/stores/session/schema";
import { useConnections } from "@/stores/session/connections";
import { resolveConnectionDriver } from "@/lib/connectionLabel";
import { currentLaunchView, useUi } from "@/stores/session/ui";
import { usePreferences } from "@/stores/preferences/preferences";
import { isMainWindow } from "@/lib/window";
import { debounce, type Debounce } from "@/lib/schedule";
import {
  getInnerDockviewApi,
  setPendingInternalLayout,
  syncTabPanels,
  protectPanelUntilRestored,
} from "@/lib/dockview";

const SAVE_DEBOUNCE_MS = 600;

interface ActiveSubscription {
  /** Trailing save for this connection, armed by its tab/schema subscriptions. */
  save: Debounce<[]>;
  unsubTabs: () => void;
  unsubSchema: () => void;
}

const active = new Map<string, ActiveSubscription>();

/**
 * True while an environment switch is tearing down/rebuilding the session
 * (`useEnvironments.switchTo`). While set, `scheduleSave` and
 * `scheduleSaveActive` are no-ops instead of arming a timer.
 *
 * `cancelPendingSaves()` alone (the pre-existing guard, kept below) only
 * drops timers already armed *at the moment it's called* — it does nothing
 * about one armed a tick later. And one reliably gets armed a tick later:
 * `switchTo`'s teardown loop calls `disconnect()` for each outgoing
 * connection, which awaits a real backend IPC round-trip and then runs
 * `markDisconnected` — which drops the connection's schema cache and, for a
 * multi-DB parent, closes its children's tabs. Either can wake another
 * still-subscribed connection's `useTabs`/`useSchema` listener mid-loop, long
 * after the last `cancelPendingSaves()` call, and that timer fires ~600ms
 * later against whichever environment is active by then — the *incoming*
 * one, since `setActiveEnvironment` has since run. The result is exactly the
 * regression `2299f40` fixed once already, just via a path that fix didn't
 * close: a snapshot of the (still transiently empty) tab store overwrites
 * the incoming environment's real, previously-saved tabs.
 *
 * A suspend flag closes every path at once, regardless of what wakes a
 * subscription, instead of chasing individual re-arm sites one at a time.
 *
 * `persistLaunchState` (below) checks the same flag, for the same reason via
 * a sibling path this flag didn't originally cover: `switchTo`'s teardown
 * loop calls `useConnections.disconnect()` for each outgoing connection, and
 * `disconnect()` fires `persistLaunchState` itself (fire-and-forget, never
 * awaited by the loop) with whatever `useUi`/`useTabs` hold *at that instant*
 * — which by then is the nulled-out focus/active-tab/folds/filter that
 * `switchTo` step 2 already cleared, since step 2 runs before the disconnect
 * loop. `switchTo` re-saves the *real* captured values right after the loop,
 * but that write and the loop's fire-and-forget ones are unrelated, unawaited
 * promises with no ordering guarantee between them — if even one straggler
 * from the loop resolves after the real re-save (plausible: it's one
 * `saveLaunchState` IPC round-trip per disconnected connection, racing a
 * single corrective write), it overwrites the good launch state with nulls,
 * and if it resolves after `setActiveEnvironment` too, it corrupts the
 * *incoming* environment's launch state instead. Gating it on `saveSuspended`
 * turns every one of those calls into a no-op for the same window the tab/
 * layout saves are already blocked in.
 */
let saveSuspended = false;

/**
 * Block `scheduleSave`/`scheduleSaveActive` from arming new timers, and drop
 * any already pending. Call right after the outgoing environment's own
 * `flushAllTabState()` has written its good snapshot — anything that wakes a
 * subscription from that point until `resumeSaves()` is not a real edit, just
 * teardown/rebuild noise.
 */
export function suspendSaves(): void {
  saveSuspended = true;
  cancelPendingSaves();
}

/** Re-arm normal debounced saving once the incoming environment's session is
 *  fully rebuilt. Must run even if the switch fails partway — callers use
 *  try/finally. */
export function resumeSaves(): void {
  saveSuspended = false;
}

function snapshotFor(connectionId: string): ConnectionTabState {
  const tabsState = useTabs.getState();
  const schemaSlice = useSchema.getState().byConnection[connectionId];
  const tabs: PersistedTab[] = tabsState.tabs
    .filter((t) => t.connectionId === connectionId)
    // Structure-editor, view-editor, aggregation and index-manager tabs are
    // ephemeral working sessions (a half-built "new table"/"new view", an
    // in-progress edit, a scratch pipeline, or a look at one collection's
    // indexes) — don't persist them across restarts.
    .filter(
      (t) =>
        t.kind !== "structure" &&
        t.kind !== "view" &&
        t.kind !== "aggregation" &&
        t.kind !== "indexes",
    )
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      schema: t.schema ?? null,
      table: t.table ?? null,
      query: t.query ?? null,
      title: t.title ?? null,
      color: t.color ?? null,
      pinned: t.pinned ?? null,
      // Committed table-tab view state (#112). Flattened onto the persisted tab
      // rather than nested, matching the Rust struct's four fields — each one
      // has to be declared there or serde drops it at the IPC boundary
      // (gotcha #14).
      filters: t.viewState?.filters ?? null,
      sort: t.viewState?.sort ?? null,
      search: t.viewState?.search ?? null,
      documentViewMode: t.viewState?.documentViewMode ?? null,
      projection: t.viewState?.projection ?? null,
      rawFilter: t.viewState?.rawFilter ?? null,
      collation: t.viewState?.collation ?? null,
      hint: t.viewState?.hint ?? null,
    }));
  const activeId = tabs.find((t) => t.id === tabsState.activeId)?.id ?? null;
  const expandedSchemaNodes = schemaSlice
    ? Array.from(schemaSlice.expanded)
    : [];

  // Note: the inner-dockview geometry is NOT captured here anymore. It is a
  // session-level artifact (one shared inner dockview hosts every
  // connection's tabs), so it is persisted once via `saveWorkspaceLayoutNow`
  // into the top-level `workspaceLayout`, not duplicated under each
  // connection — see the module header and `saveWorkspaceLayoutNow`.
  return {
    tabs,
    activeTabId: activeId,
    expandedSchemaNodes,
    lastOpened: Math.floor(Date.now() / 1000),
  };
}

function scheduleSave(connectionId: string) {
  if (saveSuspended) return;
  active.get(connectionId)?.save.schedule();
}

/** The debounced write for one connection, created with its subscription. */
function saveDebounceFor(connectionId: string): Debounce<[]> {
  return debounce(SAVE_DEBOUNCE_MS, () => {
    void api
      .saveTabState(connectionId, snapshotFor(connectionId))
      .catch((err) => {
        console.error(`[persistedTabs] save failed for ${connectionId}:`, err);
      });
  });
}

// --- Session-level workspace layout -----------------------------------------
// The inner dockview's split/float geometry is shared across every open
// connection (one inner dockview hosts them all), so it is persisted once at
// the top level of `tab_state.json` rather than duplicated per connection.

/** Capture the current inner-dockview geometry and write it to disk now.
 *  Writes `null` (default tabbed layout) unless the user has actually split
 *  or floated panels (>1 group) — keeping the blob lean and the common case
 *  on the fast default-restore path. Main-window-only and best-effort. */
async function saveWorkspaceLayoutNow(): Promise<void> {
  if (!isMainWindow()) return;
  const innerApi = getInnerDockviewApi();
  const layout =
    innerApi && innerApi.groups.length > 1
      ? (innerApi.toJSON() as unknown)
      : null;
  try {
    await api.saveWorkspaceLayout(layout);
  } catch (err) {
    console.error("[persistedTabs] workspace layout save failed:", err);
  }
}

const saveLayout = debounce(SAVE_DEBOUNCE_MS, () => {
  void saveWorkspaceLayoutNow();
});

/**
 * Debounced save of the session-level inner-dockview geometry. Wired to the
 * inner dockview's `onDidLayoutChange` (a pure split/float/resize gesture
 * touches no tab or schema state, so nothing else would schedule a save for
 * it) — see `TabbedArea.tsx`. Named `scheduleSaveActive` for historical
 * reasons; it now saves one session-level blob, not one per connection.
 */
export function scheduleSaveActive() {
  if (!isMainWindow()) return;
  if (saveSuspended) return;
  saveLayout.schedule();
}

/**
 * Persist the launch-restore state: the connections currently live in this
 * (main) window (passed in by the caller to avoid importing `useConnections`
 * and creating an import cycle), plus the focused connection (`useUi`) and the
 * globally-active tab (`useTabs`). Best-effort; fire-and-forget. The
 * definitive write happens on graceful close; connect/disconnect calls keep it
 * roughly fresh for an abrupt exit.
 */
export function persistLaunchState(
  activeConnectionIds: string[],
): Promise<void> {
  if (!isMainWindow()) return Promise.resolve();
  // See `saveSuspended`'s comment: during an environment switch this would
  // otherwise fire once per disconnected connection, each carrying the
  // already-cleared (null/empty) focus and tab state, racing `switchTo`'s own
  // corrective `saveLaunchState` call with no ordering guarantee between them.
  if (saveSuspended) return Promise.resolve();
  return api
    .saveLaunchState({
      activeConnections: activeConnectionIds,
      selectedConnectionId: useUi.getState().selectedConnectionId,
      activeTabId: useTabs.getState().activeId,
      ...currentLaunchView(),
    })
    .catch((err) => {
      console.error("[persistedTabs] launch-state save failed:", err);
    });
}

/**
 * Rehydrate persisted tabs + expansion for `connectionId`. Returns
 * silently when the preference toggle is off, when there is no persisted
 * state, or when the call fails — never blocks the connect flow.
 */
export async function hydrateTabState(connectionId: string): Promise<void> {
  // Only the main window persists tab state — secondary windows (opened via
  // "New window") are intentionally ephemeral, so they never hydrate from or
  // save to `tab_state.json` (see `commands::prefs::get_tab_state`). Without
  // this guard a secondary window would silently overwrite the main
  // window's persisted snapshot the moment it opened a connection.
  if (!isMainWindow()) return;

  const restore = usePreferences.getState().prefs.ui.restoreTabsOnOpen;
  if (!restore) {
    // Skip both restore *and* save: with the preference off, we leave the
    // previously persisted workspace alone on disk so flipping the toggle
    // back on later still produces a useful restore. Attaching the
    // subscription here would silently overwrite the saved snapshot with
    // whatever the user happens to open in this session.
    return;
  }
  try {
    const state = await api.getTabState(connectionId);
    if (state) {
      const restored: AppTab[] = state.tabs.map((p) => ({
        id: p.id,
        kind: p.kind,
        connectionId,
        // Persisted state never carries a generated title for table tabs
        // (it can be derived from the table name on demand); we fall back
        // to the table name or "Query" so the tab bar always has a label.
        title:
          p.title ??
          p.table ??
          (p.kind === "query"
            ? i18n.t(
                resolveConnectionDriver(
                  useConnections.getState().profiles,
                  connectionId,
                ) === "mongodb"
                  ? "tabs.mongoQueryFileName"
                  : "tabs.queryFileName",
              )
            : i18n.t("tabs.tableFallback")),
        schema: p.schema ?? undefined,
        table: p.table ?? undefined,
        query: p.query ?? undefined,
        color: p.color ?? undefined,
        pinned: p.pinned ?? undefined,
        // Re-nest the flat persisted fields into `viewState` (#112). Left
        // `undefined` when the tab carried none, so `TableDataTab` falls back to
        // its own defaults rather than starting from empty-but-present state.
        viewState:
          p.filters ||
          p.sort ||
          p.search ||
          p.documentViewMode ||
          p.projection ||
          p.rawFilter ||
          p.collation ||
          p.hint
            ? {
                filters: p.filters ?? undefined,
                sort: p.sort ?? undefined,
                search: p.search ?? undefined,
                documentViewMode: p.documentViewMode ?? undefined,
                projection: p.projection ?? undefined,
                rawFilter: p.rawFilter ?? undefined,
                collation: p.collation ?? undefined,
                hint: p.hint ?? undefined,
              }
            : undefined,
      }));

      // Merge: keep tabs from other connections, drop the previous set
      // for this one, append the restored ones. Avoids clobbering a
      // workspace the user already has open against a different DB.
      const tabsStore = useTabs.getState();
      const carryover = tabsStore.tabs.filter(
        (t) => t.connectionId !== connectionId,
      );
      const nextTabs = [...carryover, ...restored];
      const nextActive =
        state.activeTabId &&
        restored.some((t) => t.id === state.activeTabId)
          ? state.activeTabId
          : (restored[restored.length - 1]?.id ?? tabsStore.activeId);

      // The inner-dockview geometry is no longer restored here — it is
      // session-level, applied once via `hydrateWorkspaceLayout` (called from
      // the launch flow), not per connection. The TabbedArea reconciler adds
      // this connection's tabs into whatever geometry is already in place.
      tabsStore.replaceAll(nextTabs, nextActive);

      useSchema
        .getState()
        .replaceExpanded(connectionId, new Set(state.expandedSchemaNodes));
    }
  } catch (err) {
    console.error(`[persistedTabs] hydrate failed for ${connectionId}:`, err);
  } finally {
    attachSubscriptions(connectionId);
  }
}

/**
 * Open (or resolve, if already open) a multi-DB connection's per-database
 * child pool, hydrating its persisted tabs/schema-expansion and attaching its
 * save subscription the first time it's opened — the same thing `connect()`
 * does for a top-level connection via `hydrateTabState`.
 *
 * A `<parentId>::db::<database>` child is never "connected" in the
 * `useConnections`/`connect()` sense: the schema tree opens one directly
 * (`useDatabaseViews.ensure`) the first time a database node is expanded (or a
 * per-database action needs it), entirely independent of the top-level
 * connection lifecycle. Nothing about that path ever called `hydrateTabState`
 * or `attachSubscriptions`, so a table/query/security tab opened against a
 * child id was invisible to this module — never saved, never restored,
 * regardless of whether the environment switched, the app restarted, or
 * anything else. Every call site that opens a database view for the tree
 * MUST go through this instead of calling
 * `api.openDatabaseView` directly, or its tabs silently stop persisting
 * again.
 *
 * Guarded by the SAME `active` map `attachSubscriptions` populates — not a
 * separate "have we seen this child" set. A database can be closed and
 * reopened (or the tree re-expanded) multiple times per session without a
 * fresh `openDatabaseView` round-trip once dockview already has the id, and
 * re-running the restore each time would clobber whatever the user has open
 * with the on-disk snapshot again; `active.has(id)` is true for exactly as
 * long as that's true. It goes back to false the moment
 * `useConnections.markDisconnected` flushes and tears the child down (see
 * `subscribedConnectionIds`), so the *next* open — the parent reconnecting,
 * or the same database reopened after being dropped and recreated — restores
 * fresh from disk instead of being skipped as "already done this session". A
 * private tracking set would drift from that lifecycle independently (and
 * did, in an earlier version of this fix): it can only be reset by whoever
 * remembered to call into it, whereas `active` is reset by the one thing that
 * actually stops the subscription.
 */
export async function openTrackedDatabaseView(
  parentId: string,
  database: string,
): Promise<string> {
  const id = await api.openDatabaseView(parentId, database);
  if (!active.has(id)) {
    await hydrateTabState(id);
  }
  return id;
}

/**
 * Every connection id (top-level or `<parentId>::db::<database>` child) with
 * a live save subscription right now. Used by `useConnections.markDisconnected`
 * to find every child connection under a disconnecting parent: by the time it
 * runs during an environment switch, `useTabs` has already been cleared (the
 * switch does that before tearing down connections) and a child that was
 * opened but never had anything persisted yet has no `useSchema` slice either
 * (`hydrateTabState` only writes one when it finds saved state to restore) —
 * so neither store is a reliable index of "what children exist" on its own.
 * The subscription registry always is, since `attachSubscriptions` is the one
 * thing that puts a connection (parent or child) into it.
 */
export function subscribedConnectionIds(): string[] {
  return Array.from(active.keys());
}

/**
 * Restore the session-level inner-dockview geometry: at launch, AFTER the
 * launch flow has populated `useTabs` (auto-reconnect settling), or from
 * `useEnvironments.switchTo`'s `restoreSession` on an environment switch.
 *
 * `fromJSON` (dockview-core) is applied UNCONDITIONALLY — not gated on
 * "are there tabs yet", which an earlier version of this function was, and
 * which was the actual bug behind a report of "tabs come back but the split
 * doesn't": a table/query/security tab against a multi-DB "database view"
 * child (`<parent>::db::<database>`) is NOT restored by `restoreSession`'s
 * reconnect loop — it comes back later, whenever the schema tree's needs
 * effect (`useSchemaTreeNeeds`, for a database node that was expanded before)
 * gets around to calling `openTrackedDatabaseView`, a completely separate React
 * component's effect on its own schedule. A saved split whose panels all
 * belonged to such a child meant `useTabs` was still empty by the time this
 * ran, the old `if (tabs.length > 0)` gate skipped the whole restore, and the
 * layout was simply never applied — no exception, no trace, just silently
 * skipped. (A version in between tried waiting for `TabbedArea`'s reconciler
 * to "converge" on the current `tabs` first; that doesn't help either, since
 * "current tabs" was `[]` the entire time this function ran — there was
 * nothing to converge on yet.)
 *
 * Since `fromJSON` runs regardless of what's in `useTabs` right now, a panel
 * it creates may not have a matching tab yet. Those get `protectPanelUntilRestored`
 * instead of being pruned — see that function's comment for why "not in
 * `tabs` at this instant" can't be trusted to mean "gone for good" here, and
 * why the eventual real close (of the tab, or of its connection) is the only
 * thing allowed to remove one.
 *
 * `fromJSON` already clears the dockview before rebuilding (dockview-core's
 * own behaviour, not something this module needs to do), so it can't collide
 * with panels the reconciler already added — but if it throws partway
 * through (a corrupt/incompatible blob), the dockview is left genuinely empty
 * with nothing else scheduled to rebuild it. `syncTabPanels` (also used by
 * the reconciler itself) rebuilds the flat layout directly in that case, so a
 * bad geometry blob degrades to "tabs came back, just not split" instead of
 * an empty workspace. Main-window-only and gated on `restoreTabsOnOpen`.
 */
export async function hydrateWorkspaceLayout(): Promise<void> {
  if (!isMainWindow()) return;
  if (!usePreferences.getState().prefs.ui.restoreTabsOnOpen) return;
  try {
    const layout = (await api.getWorkspaceLayout()) ?? null;
    if (!layout) return;
    setPendingInternalLayout(layout);
    const innerApi = getInnerDockviewApi();
    if (innerApi) {
      // Already mounted — an environment switch, not launch (see the doc
      // comment above). Consume the pending blob ourselves so a future
      // onReady can't replay a stale one.
      setPendingInternalLayout(null);
      try {
        innerApi.fromJSON(layout as Parameters<typeof innerApi.fromJSON>[0]);
        const live = new Set(useTabs.getState().tabs.map((t) => t.id));
        for (const panel of innerApi.panels) {
          if (live.has(panel.id)) continue;
          const connectionId = (
            panel.params as { connectionId?: string } | undefined
          )?.connectionId;
          if (connectionId) protectPanelUntilRestored(panel.id, connectionId);
        }
      } catch (err) {
        console.warn("[persistedTabs] workspace layout restore failed:", err);
        // `fromJSON`'s own internal clear() already emptied the dockview, and
        // nothing else is going to rebuild it (see the doc comment above) — do
        // it ourselves so a bad/stale geometry blob degrades to "tabs came
        // back, just not split" instead of an empty workspace.
        syncTabPanels(innerApi, useTabs.getState().tabs);
      }
    }
    // If not mounted yet, the blob stays pending: `TabbedArea.onReady` replays
    // it and its reconciler effect (protecting/adding/pruning) as tabs land.
  } catch (err) {
    console.error("[persistedTabs] workspace layout hydrate failed:", err);
  }
}

/**
 * One `useTabs.subscribe` for every tracked connection, instead of one per
 * connection. Each `attachSubscriptions` call used to register its own
 * `useTabs.subscribe(() => scheduleSave(connectionId))` — harmless with one
 * connection open, but with N live connections a single keystroke in the SQL
 * editor (which replaces the whole `tabs` array via `updateQuery`) fired N
 * separate subscription callbacks, each just to reset that one connection's
 * own debounce timer. Registered lazily on the first `attachSubscriptions`
 * call and torn down once `active` is empty (in `flushTabState`, the only
 * place that removes an entry) — fanning out to `scheduleSave` for every id
 * currently in `active` is exactly what each per-connection subscription did
 * on its own, just counted once instead of N times per edit.
 */
let sharedTabsUnsub: (() => void) | null = null;
function ensureSharedTabsSubscription() {
  if (sharedTabsUnsub) return;
  // We watch the full tabs array; filtering happens inside `snapshotFor`.
  // Zustand's subscribe fires on every state change, which keeps the wiring
  // simple — the cost is one shallow comparison per tab edit, now paid once
  // rather than once per tracked connection.
  sharedTabsUnsub = useTabs.subscribe(() => {
    for (const connectionId of active.keys()) scheduleSave(connectionId);
  });
}

/**
 * Subscribe to tab and schema-expansion changes for `connectionId`. The
 * subscription is idempotent — calling twice for the same id is a no-op.
 */
function attachSubscriptions(connectionId: string) {
  if (active.has(connectionId)) return;

  ensureSharedTabsSubscription();

  const entry: ActiveSubscription = {
    save: saveDebounceFor(connectionId),
    // The tabs side is the shared subscription above; this entry's own
    // `unsubTabs` has nothing left to do; kept as a no-op rather than
    // removed from `ActiveSubscription` so `flushTabState`'s unconditional
    // `entry.unsubTabs()` call needs no special-casing.
    unsubTabs: () => {},
    unsubSchema: () => {},
  };

  entry.unsubSchema = useSchema.subscribe((state, prev) => {
    if (state.byConnection[connectionId] !== prev.byConnection[connectionId]) {
      scheduleSave(connectionId);
    }
  });

  active.set(connectionId, entry);
}

/**
 * Drop every pending debounced save without writing it.
 *
 * For the environment switch (`useEnvironments.switchTo`): tearing a session
 * down removes dockview panels and closes tabs, which arms a layout save and
 * per-connection tab saves. Those timers resolve against whichever environment
 * is active *when they fire*, so if the switch completes first they write the
 * torn-down state into the environment being entered and destroy its saved
 * geometry. The outgoing state has already been flushed by then, so there is
 * nothing worth keeping in these timers — discarding is correct, not lossy.
 *
 * Subscriptions are left attached; only the queued writes are dropped.
 */
export function cancelPendingSaves(): void {
  saveLayout.cancel();
  for (const entry of active.values()) entry.save.cancel();
}

/**
 * Flush the pending debounce (if any) and detach the per-connection
 * subscription. Called on disconnect; safe to call when nothing is
 * subscribed.
 */
export async function flushTabState(connectionId: string): Promise<void> {
  const entry = active.get(connectionId);
  if (!entry) return;
  // Only write when a save was actually armed: nothing pending means whatever
  // is in the store already reached disk.
  if (entry.save.cancel()) {
    try {
      await api.saveTabState(connectionId, snapshotFor(connectionId));
    } catch (err) {
      console.error(`[persistedTabs] flush failed for ${connectionId}:`, err);
    }
  }
  entry.unsubTabs();
  entry.unsubSchema();
  active.delete(connectionId);
  // Last tracked connection gone — nothing left for the shared subscription
  // to fan out to, so drop it rather than leaking a listener that fires
  // (and no-ops over an empty `active`) on every future `useTabs` write
  // until some connection re-attaches.
  if (active.size === 0 && sharedTabsUnsub) {
    sharedTabsUnsub();
    sharedTabsUnsub = null;
  }
}

/**
 * Save every currently-tracked connection's snapshot to disk right now,
 * unconditionally (unlike `flushTabState`, this does not require a pending
 * debounce timer — the window is closing, so whatever the current in-memory
 * state is must reach disk). Subscriptions are left attached; the window is
 * going away, not the connection.
 *
 * Saves run sequentially, not `Promise.all` — `save_tab_state` writes each
 * connection through a fixed `.json.tmp` path before renaming, and two
 * concurrent saves would race on that same temp file.
 */
export async function flushAllTabState(): Promise<void> {
  for (const connectionId of active.keys()) {
    active.get(connectionId)?.save.cancel();
    try {
      await api.saveTabState(connectionId, snapshotFor(connectionId));
    } catch (err) {
      console.error(`[persistedTabs] flush-all failed for ${connectionId}:`, err);
    }
  }
  // The session-level inner-dockview geometry is debounced separately
  // (`scheduleSaveActive`); cancel any pending timer and write it now so a
  // trailing split/resize gesture isn't lost on close.
  saveLayout.cancel();
  await saveWorkspaceLayoutNow();
}
