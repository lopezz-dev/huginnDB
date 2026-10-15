/**
 * Dockview helpers for the *inner* workspace dockview only — the nested
 * `DockviewReact` inside `TabbedArea` that hosts open table/query tabs
 * (ADR #10).
 *
 * The outer shell (Schema/Saved/Console docking, the workspace island) no
 * longer uses dockview at all — see `stores/session/panelLayout.ts` for
 * why (dockview's panel API has no `setVisible`, so a 0px-collapsed panel
 * isn't expressible without add/remove and its proportional-reflow side
 * effect). This file used to also own that outer dockview's theme, panel
 * registry, and layout persistence; all of that was removed once every
 * consumer (`App.tsx`, `ViewMenu`, `WindowMenu`, `useCommands`, `DataGrid`,
 * `CellEditor`) migrated to the new store.
 */

import type { DockviewApi, DockviewTheme } from "dockview-react";
import type { AppTab } from "@/types";
import { isDatabaseViewOf } from "@/lib/connectionLabel";

/**
 * Theme for the inner tab dockview (`TabbedArea`). No `gap` — open
 * table/query tabs stay flush; the user asked to keep data tables
 * edge-to-edge. Shares the `dockview-theme-huginndb` class (defined in
 * `src/index.css`) with the old outer theme, so it inherits the same CSS
 * variables without redeclaring them.
 */
export const huginnDockviewThemeInner: DockviewTheme = {
  name: "huginndb",
  className: "dockview-theme-huginndb",
  dndPanelOverlay: "group",
  dndOverlayMounting: "absolute",
  dndTabIndicator: "fill",
  dndOverlayBorder: "2px dashed var(--primary)",
  tabGroupIndicator: "none",
  gap: 0,
};

// ---------------------------------------------------------------------------
// Inner (workspace) dockview — the nested DockviewReact inside the Workspace
// panel that hosts open table/query tabs. There is exactly one mounted at a
// time (the active workspace's), so a module-level singleton mirrors the outer
// one above. `persistedTabs.ts` reaches it through these helpers to capture
// (`toJSON`) and restore (`fromJSON`) the per-connection split/float geometry.
// ---------------------------------------------------------------------------

let innerDockviewApi: DockviewApi | null = null;

/**
 * Layout blob handed in by `hydrateTabState` before the inner dockview has
 * mounted. `TabbedArea.onReady` consumes it once the API exists, so hydrate
 * and mount can happen in either order without a race.
 */
let pendingInternalLayout: unknown | null = null;

export function registerInnerDockviewApi(api: DockviewApi) {
  innerDockviewApi = api;
}

export function getInnerDockviewApi(): DockviewApi | null {
  return innerDockviewApi;
}

/** Drop the singleton when the inner dockview unmounts so a stale handle
 *  from a previous workspace can't be captured/restored against. */
export function clearInnerDockviewApi(api: DockviewApi) {
  if (innerDockviewApi === api) innerDockviewApi = null;
}

export function setPendingInternalLayout(layout: unknown | null) {
  pendingInternalLayout = layout;
}

/** Read and clear the pending layout (single-shot). */
export function consumePendingInternalLayout(): unknown | null {
  const v = pendingInternalLayout;
  pendingInternalLayout = null;
  return v;
}

/**
 * Panels that `hydrateWorkspaceLayout` restored from a saved geometry blob
 * whose tab hadn't shown up in `useTabs` yet at that moment — keyed by panel
 * (= tab) id, valued by the connection id from that panel's own params.
 *
 * Why this needs to exist at all: a saved split's panel ids only match
 * `useTabs` once every tab that owned one is back — but a table/query/security
 * tab against a multi-DB "database view" child (`<parent>::db::<database>`)
 * is NOT restored by `restoreSession`'s reconnect loop. It comes back later,
 * asynchronously, whenever `SchemaExplorer`'s own auto-re-expand effect (for a
 * database node that was expanded before) gets around to calling
 * `openTrackedDatabaseView` — a completely separate React component's effect,
 * on its own schedule, decoupled from `restoreSession` entirely. If
 * `hydrateWorkspaceLayout` waited for `useTabs` to already contain that tab
 * before restoring the split (an earlier version of this fix tried exactly
 * that, via a reconciler-convergence poll), it would wait on a `tabs` value
 * that was never going to arrive within any reasonable window — the poll's
 * timeout would elapse, or `hydrateWorkspaceLayout` just wouldn't be called
 * for it at all if gated on "are there tabs yet" (the actual regression this
 * fixes: `restoreSession` used to skip the whole layout restore when the only
 * tabs belonged to a not-yet-reopened database view).
 *
 * So `hydrateWorkspaceLayout` applies the saved split unconditionally and
 * marks whatever panel doesn't have a matching tab YET as protected here,
 * instead of pruning it — same treatment `TabbedArea`'s own reconciler
 * effect gives it (see `syncTabPanels` below). The moment the real tab shows
 * up, it's simply in `live` again and protection is moot. The only way a
 * protected panel is ever removed is a genuine close — of the tab itself, or
 * of its connection (`clearProtectedPanelsForConnection`, called from
 * `useConnections.markDisconnected`) — never "it wasn't in `tabs` at this
 * particular instant", which is the check this whole thing exists to not
 * rely on for these panels.
 */
const protectedPanels = new Map<string, string>();

/** Protect `panelId` (whose tab isn't in `useTabs` yet) from the reconciler's
 *  prune step until its tab shows up or `connectionId` disconnects. */
export function protectPanelUntilRestored(
  panelId: string,
  connectionId: string,
): void {
  protectedPanels.set(panelId, connectionId);
}

/**
 * Drop protection for every panel belonging to `connectionId` or one of its
 * `<connectionId>::db::*` children, and immediately re-run the reconciler
 * against the current `tabs` so anything now-unprotected-and-still-absent
 * gets pruned right away rather than waiting on some unrelated future tab
 * change. Call when a connection disconnects — nothing is coming back for it.
 */
export function clearProtectedPanelsForConnection(
  connectionId: string,
  tabs: AppTab[],
): void {
  let changed = false;
  for (const [panelId, connId] of protectedPanels) {
    if (connId === connectionId || isDatabaseViewOf(connId, connectionId)) {
      protectedPanels.delete(panelId);
      changed = true;
    }
  }
  if (changed && innerDockviewApi) syncTabPanels(innerDockviewApi, tabs);
}

/**
 * Reconcile the inner dockview's panels against `tabs`: add a panel for any
 * tab that doesn't have one yet (in the default tabbed arrangement — no
 * `position`, so it lands in whatever group is active), and remove any panel
 * whose tab is gone — EXCEPT one `protectPanelUntilRestored` is still holding
 * (see that function's comment for why some panels can't be judged by "is its
 * tab in `tabs` right now"). This is `TabbedArea`'s own store→dockview
 * reconciler effect, factored out so `persistedTabs.hydrateWorkspaceLayout`
 * can call the exact same panel-creation logic as a recovery path.
 *
 * That recovery path matters because it's the one case where this can't rely
 * on the reconciler's *own* `useEffect` to converge on its own: at launch,
 * `fromJSON` runs inside `TabbedArea.onReady`, before the reconciler effect
 * has ever fired for this mount — so a failed restore there is naturally
 * cleaned up by the reconciler's first-ever run right after. During an
 * environment switch the inner dockview is already mounted and the
 * reconciler has already been converging tabs → panels throughout the
 * reconnect, so a `fromJSON` failure at that point leaves nothing else
 * scheduled to rebuild the layout — see the call site for why it invokes
 * this directly instead of waiting on the effect.
 */
export function syncTabPanels(api: DockviewApi, tabs: AppTab[]): void {
  for (const tab of tabs) {
    if (api.getPanel(tab.id)) continue;
    let params: Record<string, unknown>;
    if (tab.kind === "table") {
      params = {
        connectionId: tab.connectionId,
        schema: tab.schema,
        table: tab.table,
      };
    } else if (tab.kind === "structure") {
      params = {
        tabId: tab.id,
        connectionId: tab.connectionId,
        schema: tab.schema,
        table: tab.table,
        mode: tab.structureMode ?? "edit",
      };
    } else if (tab.kind === "view") {
      params = {
        tabId: tab.id,
        connectionId: tab.connectionId,
        schema: tab.schema,
        view: tab.view,
        mode: tab.viewMode ?? "edit",
      };
    } else if (tab.kind === "aggregation") {
      params = {
        tabId: tab.id,
        connectionId: tab.connectionId,
        schema: tab.schema,
        // The pipeline's source collection; for a view tab it is refilled from
        // the view's own `viewOn` once the definition loads.
        collection: tab.table,
        view: tab.view,
        mode: tab.viewMode ?? "new",
      };
    } else if (tab.kind === "indexes") {
      params = {
        tabId: tab.id,
        connectionId: tab.connectionId,
        schema: tab.schema,
        collection: tab.table,
      };
    } else {
      params = { tabId: tab.id, connectionId: tab.connectionId };
    }
    api.addPanel({ id: tab.id, component: tab.kind, params });
  }
  const live = new Set(tabs.map((t) => t.id));
  for (const panel of api.panels) {
    if (live.has(panel.id)) {
      // Its tab showed up for real — protection (if any) has done its job.
      protectedPanels.delete(panel.id);
      continue;
    }
    if (protectedPanels.has(panel.id)) continue;
    api.removePanel(panel);
  }
}
