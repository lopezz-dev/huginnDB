/**
 * Tabs store — the open table-data and query-editor tabs in the main
 * workspace.
 *
 * Tab ids are random short strings rather than UUIDs because they only
 * need to be unique within the current session.
 */

import { useRef } from "react";
import { create } from "zustand";
import { isDatabaseViewOf, tableTabTitle } from "@/lib/connectionLabel";
import type { AppTab, ConnectionProfile, TabViewState } from "@/types";
import { shortId } from "@/lib/utils";

interface TabsState {
  tabs: AppTab[];
  activeId: string | null;
  /**
   * Open a new tab and make it active. For `kind: "table"` tabs, a
   * matching (connection, schema, table) already in the list is reused
   * instead of being duplicated.
   */
  open: (tab: Omit<AppTab, "id"> & { id?: string }) => string;
  /** Remove a tab. If it was active, the previous tab becomes active. */
  close: (id: string) => void;
  /** Close every tab in the current workspace (pinned tabs are kept). */
  closeAll: () => void;
  /** Close every tab except `id` and pinned ones; `id` stays active. */
  closeOthers: (id: string) => void;
  /** Close every tab positioned after `id` in the list, keeping pinned ones. */
  closeToRight: (id: string) => void;
  /** Close every tab of `id`'s connection except `id` and pinned ones. */
  closeOthersInConnection: (id: string) => void;
  setActive: (id: string) => void;
  /** Set (or clear, with `null`) a tab's cosmetic colour. */
  setColor: (id: string, color: string | null) => void;
  /**
   * Update a tab's displayed title and, for table/structure tabs, the
   * underlying table name — used after a table rename applies (structure
   * editor "Apply", or the schema tree's quick-rename dialog) so the open
   * tab reflects the new name instead of the one it was opened with.
   */
  rename: (id: string, title: string, table?: string) => void;
  /** Pin / unpin a tab (pinned tabs survive bulk-close). */
  setPinned: (id: string, pinned: boolean) => void;
  /** Update the in-memory SQL of a query tab. */
  updateQuery: (id: string, query: string) => void;
  /**
   * Record a table tab's committed filters / sort / search so they persist with
   * the tab (#112). Called by `TableDataTab` on each committed change; a no-op
   * write is skipped so it can't cause a redundant persist round.
   */
  setViewState: (id: string, viewState: TabViewState) => void;
  /**
   * Resolve the connectionId a fresh query tab on `parentId` should open
   * against: the database-scoped child (`<parentId>::db::<database>`) of
   * whichever tab is currently focused, if that tab belongs to this same
   * connection — so "new query" while browsing a specific database lands the
   * editor on that database instead of always resetting to the connection's
   * default. Falls back to `parentId` itself when the focused tab belongs to
   * another connection (or there isn't one).
   */
  queryTargetFor: (parentId: string) => string;
  /** Drop every tab for a connection (called on disconnect). */
  closeForConnection: (connectionId: string) => void;
  /**
   * Replace every tab plus the active id in one shot. Used by the
   * per-connection workspace restore (`persistedTabs.hydrate`) so the
   * incoming snapshot lands atomically instead of as a stream of `open`
   * calls — keeps the active-tab pointer correct and avoids the dedup
   * branch in `open` from collapsing legitimately-distinct tabs.
   */
  replaceAll: (tabs: AppTab[], activeId: string | null) => void;
}

function genId() {
  return shortId();
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  open: (input) => {
    if (
      input.kind === "table" ||
      input.kind === "security" ||
      input.kind === "aggregation" ||
      // The index manager is a view onto one collection's catalogue, not a
      // draft: a second tab for the same collection would be two windows onto
      // the same list, drifting apart after the first create.
      input.kind === "indexes"
    ) {
      const existing = get().tabs.find(
        (t) =>
          t.kind === input.kind &&
          t.connectionId === input.connectionId &&
          (input.kind === "security" ||
            (t.schema === input.schema &&
              t.table === input.table &&
              // Aggregation tabs additionally key on the view they're bound
              // to: "Edit pipeline" on a view and a scratch pipeline over the
              // same collection are different working sessions. Within one
              // identity the tab is reused, so re-opening it can't quietly
              // strand a pipeline the user was still building.
              (input.kind !== "aggregation" || t.view === input.view))),
      );
      if (existing) {
        // Re-navigation (FK "go to referenced row") may carry a fresh
        // initial filter for an already-open table — apply it so the tab
        // refilters to the new master record instead of silently no-opping.
        if (input.initialFilters) {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === existing.id
                ? { ...t, initialFilters: input.initialFilters }
                : t,
            ),
            activeId: existing.id,
          }));
        } else {
          set({ activeId: existing.id });
        }
        return existing.id;
      }
    }
    const id = input.id ?? genId();
    const tab: AppTab = { ...input, id } as AppTab;
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  close: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length ? tabs[tabs.length - 1].id : null;
      }
      return { tabs, activeId };
    });
  },
  closeAll: () =>
    set((s) => {
      // Pinned tabs survive a "close all" so they can't be lost by accident.
      const kept = s.tabs.filter((t) => t.pinned);
      const activeId = kept.some((t) => t.id === s.activeId)
        ? s.activeId
        : (kept[kept.length - 1]?.id ?? null);
      return { tabs: kept, activeId };
    }),
  closeOthers: (id) =>
    set((s) => {
      const kept = s.tabs.filter((t) => t.id === id || t.pinned);
      // If the target somehow no longer exists, fall back to keeping only the
      // pinned set rather than leaving orphaned tabs the reconciler can't
      // account for.
      const activeId = kept.some((t) => t.id === id)
        ? id
        : (kept[kept.length - 1]?.id ?? null);
      return { tabs: kept, activeId };
    }),
  closeToRight: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      // Keep everything up to and including the anchor, plus any pinned tab
      // that happens to sit to its right.
      const kept = s.tabs.filter((t, i) => i <= idx || t.pinned);
      const activeId = kept.some((t) => t.id === s.activeId)
        ? s.activeId
        : id;
      return { tabs: kept, activeId };
    }),
  closeOthersInConnection: (id) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === id);
      if (!target) return {};
      // Other connections' tabs are untouched; within this connection only the
      // anchor and pinned tabs stay.
      const kept = s.tabs.filter(
        (t) =>
          t.connectionId !== target.connectionId || t.id === id || t.pinned,
      );
      const activeId = kept.some((t) => t.id === s.activeId)
        ? s.activeId
        : id;
      return { tabs: kept, activeId };
    }),
  setActive: (id) => set({ activeId: id }),
  setColor: (id, color) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, color: color ?? undefined } : t,
      ),
    })),
  rename: (id, title, table) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, title, ...(table ? { table } : {}) } : t,
      ),
    })),
  setPinned: (id, pinned) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)),
    })),
  updateQuery: (id, query) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, query } : t)),
    })),
  queryTargetFor: (parentId) => {
    const { tabs, activeId } = get();
    const active = tabs.find((t) => t.id === activeId);
    return active && isDatabaseViewOf(active.connectionId, parentId)
      ? active.connectionId
      : parentId;
  },
  setViewState: (id, viewState) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return s;
      // Bail on an unchanged value. Every write to this store wakes the
      // `persistedTabs` subscription and schedules a disk save, and
      // `TableDataTab` calls this from effects that re-run on unrelated
      // renders — so without this a stable filter set would keep re-saving.
      if (JSON.stringify(tab.viewState ?? {}) === JSON.stringify(viewState)) {
        return s;
      }
      return {
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, viewState } : t)),
      };
    }),
  replaceAll: (tabs, activeId) => set({ tabs, activeId }),
  closeForConnection: (connectionId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== connectionId);
      const activeStillThere =
        s.activeId && tabs.some((t) => t.id === s.activeId);
      return {
        tabs,
        activeId: activeStillThere
          ? s.activeId
          : tabs.length
            ? tabs[tabs.length - 1].id
            : null,
      };
    }),
}));

/**
 * Close every tab bound to a (connection, schema, table) triple.
 *
 * The companion to [`retitleTabsForTableRename`] for the one rename that
 * *can't* be retitled: a MongoDB `renameCollection` that also moves the
 * collection to another database. The destination lives behind a different
 * connection id (its own `<parent>::db::<db>` pool), so a retitled tab would
 * keep querying the database the collection just left.
 */
export function closeTabsForTable(
  connectionId: string,
  schema: string | undefined,
  table: string,
): void {
  const { tabs, close } = useTabs.getState();
  for (const tab of tabs) {
    if (
      tab.connectionId === connectionId &&
      tab.schema === schema &&
      tab.table === table
    ) {
      close(tab.id);
    }
  }
}

/**
 * Retitle every open table-data or structure tab pointing at a table that
 * was just renamed, so it doesn't keep showing (or, for structure tabs,
 * re-fetching) the old name. Called from both places a rename can happen:
 * the schema tree's quick-rename dialog and a structure-editor Apply that
 * changed the table's name. `structureSuffix` is the already-translated
 * `t("tabs.structureSuffix")` string — this module isn't a React component,
 * so it can't call `useTranslation()` itself.
 */
export function retitleTabsForTableRename(
  profiles: ConnectionProfile[],
  connectionId: string,
  schema: string | undefined,
  oldName: string,
  newName: string,
  structureSuffix: string,
): void {
  const { tabs, rename } = useTabs.getState();
  for (const tab of tabs) {
    if (
      tab.connectionId !== connectionId ||
      tab.schema !== schema ||
      tab.table !== oldName
    ) {
      continue;
    }
    if (tab.kind === "table") {
      rename(tab.id, tableTabTitle(profiles, connectionId, newName), newName);
    } else if (tab.kind === "structure") {
      rename(tab.id, `${newName} (${structureSuffix})`, newName);
    }
  }
}

/**
 * Whether two `tabs` arrays differ only in tabs' `query` text.
 *
 * `updateQuery` runs on every keystroke in the SQL editor and, like every
 * other write here, replaces the array and the edited tab object. Anything
 * that reads the tab list but not the SQL body — the dockview host, the tab
 * switcher, the window title, the command palette, the tree's open-table
 * markers — was re-rendering on each of those keystrokes, which a slow CPU
 * feels as typing lag. This is the equality that lets them skip it.
 */
export function sameTabsIgnoringQuery(a: AppTab[], b: AppTab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xKeys = Object.keys(x) as (keyof AppTab)[];
    if (xKeys.length !== Object.keys(y).length) return false;
    for (const k of xKeys) {
      if (k !== "query" && x[k] !== y[k]) return false;
    }
  }
  return true;
}

/**
 * `useTabs((s) => s.tabs)` for a component that never reads a tab's `query`:
 * it re-renders when tabs open, close, move, retitle or change any other
 * field, but not while someone types SQL.
 *
 * The array handed back is the one from the last change that mattered, so its
 * tabs' `query` values may be stale — that is the whole point. A component
 * that does need the SQL body must subscribe with `useTabs` directly, or read
 * `useTabs.getState()` inside the handler that needs it.
 */
export function useTabsIgnoringQuery(): AppTab[] {
  const last = useRef<AppTab[] | null>(null);
  return useTabs((s) => {
    const prev = last.current;
    if (prev && sameTabsIgnoringQuery(prev, s.tabs)) return prev;
    last.current = s.tabs;
    return s.tabs;
  });
}
