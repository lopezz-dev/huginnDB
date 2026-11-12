/**
 * Keeps the OS window title (taskbar / Alt-Tab entry) in sync with what the
 * window is actually showing, so multiple HuginnDB windows are tellable apart
 * from outside the app (#59) and the active table's database + name is always
 * visible (#57).
 *
 * Renders nothing — it is a side-effect-only component mounted once per window.
 * Runs in EVERY window (not main-only): each window has its own title, and a
 * secondary window is exactly the case #59 is about. `setTitle` is guarded in a
 * try/catch because it is an async IPC call whose permission is capability-
 * scoped; a failure must never break rendering.
 *
 * Title shape:
 *   "<profile> · <db>.<table> — HuginnDB"   when a table tab is active
 *   "<profile> · <db> — HuginnDB"           when another tab / connection is focused
 *   "HuginnDB"                              when nothing is connected
 */

import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs, useTabsIgnoringQuery } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import {
  resolveConnectionLabel,
  resolveConnectionParts,
} from "@/lib/connectionLabel";

export function WindowTitleSync() {
  const tabs = useTabsIgnoringQuery();
  const activeId = useTabs((s) => s.activeId);
  const profiles = useConnections((s) => s.profiles);
  const selectedConnectionId = useUi((s) => s.selectedConnectionId);
  // Flavor-aware app name: the canary build must read "HuginnDB Canary" in the
  // taskbar / Alt-Tab entry too, otherwise it is indistinguishable from the
  // stable install from outside the window. Defaults to "HuginnDB" until the
  // flavor resolves. This is why the OS title set by tauri.canary.conf.json
  // couldn't stand on its own — this effect used to overwrite it every render.
  const appName = useAppFlavor((s) => s.productName);

  /**
   * Computed as its own `useMemo`, separate from the `setTitle` IPC call
   * below, so the effect can depend on the resulting STRING rather than on
   * `tabs` itself. `tabs` is replaced on every `updateQuery` call — i.e. on
   * every keystroke in the SQL editor — and the title text almost never
   * actually changes while typing (a query tab's title depends on its
   * connection, not its SQL body). Gating the IPC call on `[title]` instead
   * of `[tabs, activeId, profiles, selectedConnectionId, appName]` is what
   * turns "one `setTitle` round-trip per keystroke" into "one per actual
   * title change".
   */
  const title = useMemo(() => {
    const activeTab = tabs.find((t) => t.id === activeId);
    const APP_NAME = appName;

    if (activeTab?.table) {
      const { profileName, database } = resolveConnectionParts(
        profiles,
        activeTab.connectionId,
      );
      const dbTable = database
        ? `${database}.${activeTab.table}`
        : activeTab.table;
      return profileName
        ? `${profileName} · ${dbTable} — ${APP_NAME}`
        : `${dbTable} — ${APP_NAME}`;
    }
    if (activeTab) {
      // A query / structure / security tab: identify the connection at least.
      const label = resolveConnectionLabel(profiles, activeTab.connectionId);
      return label ? `${label} — ${APP_NAME}` : APP_NAME;
    }
    if (selectedConnectionId) {
      const label = resolveConnectionLabel(profiles, selectedConnectionId);
      return label ? `${label} — ${APP_NAME}` : APP_NAME;
    }
    return APP_NAME;
  }, [tabs, activeId, profiles, selectedConnectionId, appName]);

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {
        // Capability-scoped IPC; never let a title update break the UI.
      });
  }, [title]);

  return null;
}
