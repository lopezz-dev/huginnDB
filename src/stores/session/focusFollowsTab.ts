/**
 * Keep `useUi.selectedConnectionId` following the focused tab.
 *
 * The app had two independent "current" pointers and nothing connecting them:
 * `useUi.selectedConnectionId` — what the workspace points at, and what the tab
 * strip's `+`, the `newQuery` keybinding and the command palette's new-query
 * entry all resolve their target from — and `useTabs.activeId`, the focused tab,
 * which carries its own `connectionId`.
 *
 * Only the *connection* flows wrote the first one (connect, reconnect, the
 * status-bar picker, the workspace picker, environment restore). Opening a tab
 * wrote only the second. So with two connections live, clicking a MySQL table in
 * the schema tree and pressing `+` opened the editor against whichever
 * connection happened to have been connected last — the schema tree never
 * touched the selection at all. Clicking an *already open* tab of the other
 * connection had the same ending, which is the half nobody reported because the
 * tree is where people notice it.
 *
 * `queryTargetFor` could not rescue this by design: it only ever refines
 * *within* the connection it is handed (parent → its `::db::` child) and
 * deliberately discards a focused tab belonging to somebody else.
 *
 * So the fix is not another `setSelected` call at a third call site — the
 * command palette and the Ctrl+Tab switcher already carried one each, which is
 * the shape of a rule that wants to live in one place. Focus *is* the focused
 * tab's connection, derived here, once.
 *
 * Two constraints this has to respect, both of which cost a bug when ignored:
 *
 * - **Always fold through `parentConnectionId`** (ADR #032).
 *   `selectedConnectionId` must name a real profile: `useConnections.active`
 *   only ever holds top-level ids, and `App.tsx` clears any selection outside
 *   that set and re-selects an arbitrary pool one render later. A tab on a
 *   `<parent>::db::<db>` child would therefore be undone immediately.
 * - **Subscribe to the store, not to dockview.** `onDidActivePanelChange`
 *   already flows into `useTabs.setActive`; hanging this off it as well would be
 *   the second dockview↔store path ADR #010 exists to forbid.
 */

import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import { parentConnectionId } from "@/lib/connectionLabel";

let unsubscribe: (() => void) | null = null;

/**
 * Start mirroring the focused tab's connection into `useUi`. Idempotent — a
 * second call is a no-op rather than a second subscription, matching
 * `persistedTabs`' `ensureSharedTabsSubscription`.
 *
 * Returns the teardown, so a test can unsubscribe; `App.tsx` mounts it for the
 * window's lifetime and never calls it.
 */
export function startFocusFollowsTab(): () => void {
  if (unsubscribe) return unsubscribe;

  const unsub = useTabs.subscribe((state, prev) => {
    // Every tab edit wakes this subscription (a keystroke in the SQL editor
    // replaces the whole `tabs` array), so the focus change is the only thing
    // worth reacting to.
    if (state.activeId === prev.activeId) return;
    // No tab focused: leave the selection alone. Closing the last tab and
    // switching environments both land here, and both have their own opinion
    // about what the selection should become — clearing it from here would
    // fight `App.tsx`'s active-set sync and `switchTo`'s teardown.
    if (!state.activeId) return;

    const tab = state.tabs.find((t) => t.id === state.activeId);
    if (!tab) return;

    const parent = parentConnectionId(tab.connectionId);
    const { selectedConnectionId, setSelectedConnectionId } = useUi.getState();
    if (parent === selectedConnectionId) return;
    // A tab whose pool is gone can still be in the list for a moment during
    // teardown; pointing the workspace at it would be undone a render later.
    if (!useConnections.getState().active.has(parent)) return;

    setSelectedConnectionId(parent);
  });

  unsubscribe = () => {
    unsub();
    unsubscribe = null;
  };
  return unsubscribe;
}
