/**
 * Connections store — saved profiles + the set of profiles that are
 * currently open *in this window*. `profiles` mirrors the Tauri-managed Rust
 * state (`api.listProfiles`); `active` is a per-window view driven by this
 * window's own connect()/disconnect() plus the cross-window pool-closed
 * cleanup in `connection-sync-bridge.ts` (#50). It is NOT seeded from the
 * backend's global pool set, so opening a new window doesn't adopt another
 * window's live connections.
 *
 * Server version strings are fetched once per connection and cached here
 * so the status bar and other UI can read them without re-querying.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { useFilterHistory } from "@/stores/grid/filterHistory";
import { fkOptionsCache } from "@/stores/grid/fkOptions";
import {
  flushTabState,
  hydrateTabState,
  persistLaunchState,
  subscribedConnectionIds,
} from "@/stores/session/persistedTabs";
import { useConnectionHealth } from "@/stores/session/connectionHealth";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { clearProtectedPanelsForConnection } from "@/lib/dockview";
import type { ConnectionProfile, DeleteProfilesReport } from "@/types";
import { isDatabaseViewOf } from "@/lib/connectionLabel";
import { isMissingPassword } from "@/lib/db/driver";
import {
  askForPassword,
  rememberAskedPassword,
} from "@/lib/connection/passwordPrompt";

interface ConnectionsState {
  /** Profiles persisted on disk (no passwords). */
  profiles: ConnectionProfile[];
  /** Ids of profiles that currently have a live pool in the backend. */
  active: Set<string>;
  /**
   * Ids with a `connect()` call in flight. Shared across every trigger —
   * a manual click, the reconnect loop an environment switch runs in the
   * background, a CLI launch — because they all funnel through the same
   * `connect()`, so one field here is enough for the tree/picker/status bar
   * to show a "connecting…" row instead of a plain "not connected" one while
   * any of them is mid-flight, and for `connect()` itself to refuse a second
   * concurrent call for the same id instead of racing it.
   */
  connecting: Set<string>;
  /**
   * Cached server version strings keyed by profile id.
   * Populated after a successful `connect()` call; never written to disk.
   */
  versions: Record<string, string>;
  loading: boolean;
  error: string | null;
  /** Pull `profiles` and `active` from the backend. */
  refresh: () => Promise<void>;
  /** Create or update a profile; the keychain entries are written when
   *  `password` / `sshSecret` are provided. */
  save: (
    profile: ConnectionProfile,
    password?: string,
    sshSecret?: string,
  ) => Promise<ConnectionProfile>;
  /** Delete a profile and its keychain entries. */
  remove: (id: string) => Promise<void>;
  /**
   * Delete several profiles in one backend call, refreshing once at the end.
   *
   * `remove` stays as it is rather than delegating here: it is the path
   * `useOriginSync.retire` takes, and that one legitimately deletes a profile a
   * shared origin published — which `deleteProfiles` refuses by design.
   */
  removeMany: (ids: string[]) => Promise<DeleteProfilesReport>;
  /** Open a pool for `id`. Falls back to the stored secrets if omitted. */
  connect: (id: string, password?: string, sshSecret?: string) => Promise<void>;
  /** Close the pool for `id`. */
  /**
   * Close one pool and forget everything hanging off it.
   *
   * `persistLaunch: false` suppresses this call's own launch-state write. Bulk
   * teardowns (`disconnectAll`) pass it and write once at the end instead: the
   * write is fire-and-forget and carries the active set *as of its own call*,
   * so N of them racing means the last to resolve wins and it may well be a
   * stale one — a list of connections the user just closed, restored on the
   * next launch. `switchTo` fights the same race with `suspendSaves`.
   *
   * `closeTabs: true` closes the connection's own tabs as part of letting the
   * window go — *before* the backend's graceful close, so they go at the same
   * moment the tree does rather than seconds later. Opt-in, because a
   * reconnect disconnects and reconnects precisely to *keep* its tabs.
   */
  disconnect: (
    id: string,
    opts?: { persistLaunch?: boolean; closeTabs?: boolean },
  ) => Promise<void>;
  /**
   * Local-only side effect of a connection becoming active — no backend
   * call. Used by `connect()` itself. Not driven cross-window: a window only
   * marks a connection active when it opens the pool itself (#50).
   */
  markConnected: (id: string) => void;
  /**
   * Local-only side effect of a connection closing — no backend call. Same
   * split as `markConnected`; mirrors `disconnect()`'s cleanup so a window
   * that didn't initiate the disconnect still drops its own tabs/schema
   * cache for a pool that's now dead everywhere.
   */
  markDisconnected: (id: string) => Promise<void>;
  /** Re-fetch just the saved-profiles list (not `active`) — used by the
   *  sync bridge after another window creates/edits/deletes/imports a
   *  profile, where a full `refresh()` would be a heavier no-op for the
   *  `active` half. */
  refreshProfiles: () => Promise<void>;
  /** Convenience helper for components. */
  isActive: (id: string) => boolean;
  /** Return the cached server version for `id`, or undefined if not yet fetched. */
  getVersion: (id: string) => string | undefined;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  active: new Set(),
  connecting: new Set(),
  versions: {},
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      // `active` is deliberately NOT re-seeded from the backend's global pool
      // set. Every window shares one backend AppState, but each window owns its
      // own view of which connections are open (#50): a window adds to `active`
      // only through its own connect()/disconnect(), plus the cross-window
      // "pool closed everywhere" cleanup in the sync bridge. Pulling
      // api.activeConnections() here would make a freshly opened window adopt
      // the connections another window had open — the exact non-independence
      // #50 reported. The existing `active` set is preserved across refreshes.
      const profiles = await api.listProfiles();
      set({ profiles, loading: false });
    } catch (e) {
      // `error` is read by nothing, so this used to be the whole story: the
      // connection list came back empty and looked like a fresh install. Every
      // other mutation on this store propagates and is reported by its caller;
      // `refresh` is called from effects with nowhere to propagate *to*, which
      // is why it is the one that reports here.
      const message = String(e);
      set({ error: message, loading: false });
      notify.error(i18n.t("connections.refreshFailed"), { description: message });
    }
  },
  save: async (profile, password, sshSecret) => {
    const saved = await api.saveProfile(profile, password, sshSecret);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await api.deleteProfile(id);
    await get().refresh();
  },
  removeMany: async (ids) => {
    const report = await api.deleteProfiles(ids);
    await get().refresh();
    return report;
  },
  connect: async (id, password, sshSecret) => {
    // A no-op re-entry, not an error: an environment switch's background
    // reconnect and a manual click (or a CLI intent following the same
    // connection) can legitimately land on the same id at once, and the
    // second caller has nothing useful to do but wait for the first.
    if (get().connecting.has(id)) return;
    set((s) => ({ connecting: new Set(s.connecting).add(id) }));
    try {
      try {
        await api.connect(id, password, sshSecret);
      } catch (e) {
        // No password in the keychain for the user this connection signs in
        // as — always the case on a person's first connect with their own
        // database user. Ask, rather than report the keychain's emptiness.
        // A password passed in was already an answer, so it is not asked for
        // again.
        const profile = get().profiles.find((p) => p.id === id);
        if (password || !profile || !isMissingPassword(e)) throw e;
        const asked = await askForPassword(profile);
        if (!asked) throw e;
        await api.connect(id, asked.password, sshSecret);
        await rememberAskedPassword(profile, asked).catch((err) =>
          notify.error(i18n.t("passwordPrompt.rememberFailed"), {
            description: String(err),
          }),
        );
        if (asked.remember) await get().refreshProfiles();
      }
      get().markConnected(id);

      // Persist the updated launch state opportunistically so an abrupt close
      // (crash, kill) still leaves the launch flow something to auto-reconnect
      // and refocus. The definitive write happens on graceful close. No-op
      // outside the main window (see `persistLaunchState`).
      void persistLaunchState(Array.from(get().active));

      // Rehydrate the persisted workspace (open tabs + schema-tree
      // expansion) before we kick off the version probe, so the user sees
      // their previous layout immediately on reconnect. The call honours
      // the `restoreTabsOnOpen` preference internally.
      await hydrateTabState(id);

      // Fetch and cache the server version string. This is a best-effort call;
      // a failure should not prevent the connection from succeeding.
      try {
        const version = await api.serverVersion(id);
        set((s) => ({ versions: { ...s.versions, [id]: version } }));
      } catch {
        // Version display is non-critical; swallow the error silently.
      }
    } finally {
      set((s) => {
        if (!s.connecting.has(id)) return s;
        const connecting = new Set(s.connecting);
        connecting.delete(id);
        return { connecting };
      });
    }
  },
  markConnected: (id) => {
    // A successful (re)connect opens a fresh pool with its own heartbeat —
    // any previous "connection lost" flag no longer applies. Whether it is
    // still *edited* is the backend's call: this may have reused a pool
    // another window opened before the profile changed.
    useConnectionHealth.getState().clear(id);
    void useConnectionHealth.getState().refreshEdited();
    set((s) => {
      if (s.active.has(id)) return s;
      const active = new Set(s.active);
      active.add(id);
      return { active };
    });
  },
  disconnect: async (id, opts) => {
    // Flush any pending workspace snapshot to disk and detach the
    // subscription before the pool is dropped. Doing this BEFORE the
    // backend disconnect means a save failure can't leave us with no
    // pool but a still-mounted subscription.
    await flushTabState(id);
    // The window first, the pool second. The backend takes the pool out of
    // its map at once but then *waits* for it to close — gracefully, so a
    // MongoDB client finishes what it was doing and a tunnelled server sees
    // a clean goodbye, which over SSH is seconds. With the window updated
    // last, the connection looked connected for all of that wait: the click
    // felt slow, and every schema read still in flight failed against the
    // pool that was already gone and was reported as "could not read the
    // schema", because its slice still existed. Dropping the slice first is
    // what lets those late failures be recognised as stale and stay quiet.
    // `disconnect` never fails on the backend, so the window cannot end up
    // claiming a disconnect that did not happen.
    await get().markDisconnected(id);
    // After the flush above (which detached the save subscription), so
    // closing them cannot persist an empty tab list over the real one.
    if (opts?.closeTabs) useTabs.getState().closeForConnection(id);
    await api.disconnect(id);
    // Keep the persisted launch state in sync (see `connect`) — unless the
    // caller is tearing several down and will write once at the end.
    if (opts?.persistLaunch !== false) {
      void persistLaunchState(Array.from(get().active));
    }
  },
  markDisconnected: async (id) => {
    // An explicit disconnect isn't a "lost" connection — clear any stale
    // flag so a later reconnect doesn't briefly show the wrong state.
    useConnectionHealth.getState().clear(id);
    void useConnectionHealth.getState().refreshEdited();
    set((s) => {
      const active = new Set(s.active);
      active.delete(id);
      // Remove the stale version entry so a reconnect always fetches a fresh one.
      const versions = { ...s.versions };
      delete versions[id];
      return { active, versions };
    });
    // The user asked for filter history to be tied to the connection
    // lifetime; wipe it when the pool closes.
    useFilterHistory.getState().clearForConnection(id);
    // FK picker options belong to the pool too (children included — see
    // `clearConnection`); a reconnect may well land on different data.
    fkOptionsCache.clearConnection(id);
    // Drop the schema cache so a subsequent reconnect (possibly to a
    // different database on the same host) always fetches fresh metadata
    // instead of showing the stale tree from the previous session.
    useSchema.getState().drop(id);

    // Multi-DB sessions register synthetic `<id>::db::<db>` child
    // connections in the backend (see `open_database_view`); the backend
    // sweeps them when the parent disconnects, but the frontend stores
    // also keep per-child schema slices, open tabs, and — since a table/
    // query/security tab opened against one is now persisted via
    // `openTrackedDatabaseView` (see `persistedTabs.ts`) — a live save
    // subscription. Flush each child's pending tab state to disk BEFORE
    // clearing it, same ordering and same reason as the top-level
    // `flushTabState(id)` above: `closeForConnection` would otherwise wake
    // the subscription with an empty tab list and save that instead of
    // whatever the user actually had open. This matters just as much when
    // the pool died via ANOTHER window's disconnect — this window's own
    // tabs/schema for it are equally stale.
    //
    // `subscribedConnectionIds()` — not `useTabs`/`useSchema` — is what finds
    // the children: mid environment-switch teardown `useTabs` is already
    // empty (the switch clears it before disconnecting anything), and a
    // child opened but never persisted yet has no `useSchema` slice either
    // (only a restore populates one). The subscription registry is the one
    // thing guaranteed to still list every child that was ever opened this
    // session, regardless of whether it has tabs or a schema slice right now.
    const tabsState = useTabs.getState();
    const schemaState = useSchema.getState();
    const childIds = subscribedConnectionIds().filter((cid) =>
      isDatabaseViewOf(cid, id),
    );
    for (const childId of childIds) {
      await flushTabState(childId);
      tabsState.closeForConnection(childId);
      schemaState.drop(childId);
    }

    // Release any panel `hydrateWorkspaceLayout` restored from a saved split
    // whose tab (this connection's own, or a `::db::` child's) hadn't shown up
    // in `useTabs` yet — see `protectPanelUntilRestored`'s comment. Nothing is
    // ever coming back for this connection now, so its protected panels (if
    // any) are safe to prune; this also re-syncs the dockview immediately so
    // they don't linger until some unrelated tab change happens to do it.
    clearProtectedPanelsForConnection(id, useTabs.getState().tabs);
  },
  refreshProfiles: async () => {
    const profiles = await api.listProfiles();
    set({ profiles });
  },
  isActive: (id) => get().active.has(id),
  getVersion: (id) => get().versions[id],
}));
