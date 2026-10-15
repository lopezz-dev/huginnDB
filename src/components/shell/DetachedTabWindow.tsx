/**
 * Root rendered instead of `<App />` in a "sacar como ventana flotante"
 * window (see `main.tsx`) — a bare, native OS window hosting exactly one
 * workspace tab, no sidebar/menus/tab-strip. Unlike dockview's
 * `addFloatingGroup` (still used for in-app splits), this is a real
 * `WebviewWindow`: fully independent of the main window's bounds, movable
 * across the whole desktop.
 *
 * The window is a fresh JS runtime with its own empty `useTabs` — there is
 * nothing to reconcile against a dockview instance here, so we simply seed
 * that store with the one tab this window was opened for
 * (`replaceAll([tab], tab.id)`) and mount the same panel component
 * `TabbedArea` would have used. Every panel already reads its tab via
 * `useTabs` by id (see `QueryEditorTab`, `StructureEditorTab`,
 * `ViewEditorTab`), so this "just works" the same way opening that tab fresh
 * in the main window would — same cold, empty schema cache and all.
 *
 * Ephemeral by design (ADR #8's secondary-window pattern):
 * nothing here touches `tab_state.json`, and closing the OS window is the
 * whole story — the tab was already removed from the main window's
 * `useTabs` at the moment it was popped out (see `TabbedArea`'s
 * "floatPanel" action), so there's nothing left to reconcile back.
 */

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionErrorBoundary } from "@/components/connection/ConnectionErrorBoundary";
import { SandboxRibbon } from "@/components/shell/SandboxRibbon";
import { WindowColorBadge } from "@/components/shell/WindowColorBadge";
import { TitleBar, WindowCaption } from "@/components/shell/TitleBar";
import { NotificationHosts } from "@/components/shell/NotificationHosts";
import { ConfirmHost } from "@/components/common/ConfirmHost";
import { useBridge } from "@/lib/bridges/useBridge";
import { startPolicyBridge } from "@/lib/bridges/policy-bridge";
import { startWindowListBridge } from "@/lib/bridges/window-list-bridge";
import { TableDataTab } from "@/components/grid/TableDataTab";
import { QueryEditorTab } from "@/components/query/QueryEditorTab";
import { StructureEditorTab } from "@/components/schema/StructureEditorTab";
import { ViewEditorTab } from "@/components/schema/ViewEditorTab";
import { AggregationTab } from "@/components/aggregation/AggregationTab";
import { MongoIndexesTab } from "@/components/indexes/MongoIndexesTab";
import { SecurityTab } from "@/components/schema/SecurityTab";
import { useTabs } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import {
  usePreferences,
} from "@/stores/preferences/preferences";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import { setLanguage } from "@/lib/i18n";
import { PolicyGate } from "@/components/common/PolicyLock";
import { tabNeed } from "@/lib/policy/access";
import { api } from "@/lib/tauri";
import type { AppTab } from "@/types";

function TabBody({ tab }: { tab: AppTab }) {
  // Same lock as `TabbedArea`'s panels: a body the managed policy does not
  // allow is replaced, rather than mounted to fail on every request.
  const { need, relation } = tabNeed({
    kind: tab.kind,
    schema: tab.schema,
    table: tab.table,
    view: tab.view,
    mode: tab.kind === "structure" ? tab.structureMode : tab.viewMode,
  });
  return (
    <PolicyGate connectionId={tab.connectionId} need={need} relation={relation}>
      <TabContent tab={tab} />
    </PolicyGate>
  );
}

function TabContent({ tab }: { tab: AppTab }) {
  switch (tab.kind) {
    case "table":
      return (
        <TableDataTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          table={tab.table ?? ""}
        />
      );
    case "query":
      return <QueryEditorTab tabId={tab.id} connectionId={tab.connectionId} />;
    case "structure":
      return (
        <StructureEditorTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          table={tab.table}
          mode={tab.structureMode ?? "edit"}
        />
      );
    case "view":
      return (
        <ViewEditorTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          view={tab.view}
          mode={tab.viewMode ?? "edit"}
        />
      );
    case "aggregation":
      return (
        <AggregationTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          collection={tab.table}
          view={tab.view}
          mode={tab.viewMode ?? "new"}
        />
      );
    case "indexes":
      return (
        <MongoIndexesTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          collection={tab.table}
        />
      );
    case "security":
      return <SecurityTab tabId={tab.id} connectionId={tab.connectionId} />;
  }
}

export function DetachedTabWindow() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AppTab | null | undefined>(undefined);
  const language = usePreferences((s) => s.prefs.ui.language);

  // Minimal bootstrap — just enough state for the panel components to run
  // standalone, without the main window's launch-restore / reconnect flow
  // (this window never initiates a connection; the pool it needs is already
  // open in the shared backend `AppState`).
  //
  // `takeDetachedTabIntent` REMOVES the intent from the backend map, so it
  // must run exactly once — the same trap `PulseWindow` has: under
  // `<React.StrictMode>` this effect mounts, unmounts and remounts, and a
  // second call finds nothing and resolves `null`, which without a guard
  // always wins over the first call's real payload.
  const intentHandled = useRef(false);
  useEffect(() => {
    if (intentHandled.current) return;
    intentHandled.current = true;
    void useAppFlavor.getState().load();
    void usePreferences.getState().hydrate();
    void useConnections.getState().refresh();
    const label = getCurrentWindow().label;
    void api.takeDetachedTabIntent(label).then((payload) => {
      if (payload) {
        // Before the tab mounts: this window never connects, so nothing else
        // opens the schema slice its column/index loads write into — see
        // `useSchema.ensure`.
        useSchema.getState().ensure(payload.connectionId);
        useTabs.getState().replaceAll([payload], payload.id);
      }
      setTab(payload);
    });
  }, []);

  useEffect(() => {
    setLanguage(language);
  }, [language]);

  useBridge(startWindowListBridge);
  useBridge(startPolicyBridge);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar>
          <WindowCaption />
        </TitleBar>
        <SandboxRibbon />
        <WindowColorBadge />
        <div className="min-h-0 flex-1">
          {tab === undefined ? null : tab === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("tabs.detachedUnavailable")}
            </div>
          ) : (
            <ConnectionErrorBoundary resetKey={tab.connectionId}>
              <TabBody tab={tab} />
            </ConnectionErrorBoundary>
          )}
        </div>
        {/* A detached tab raises its own notifications and keeps its own
            history — the per-window scoping notifications already have. */}
        <NotificationHosts />
        {/* Required here, not optional: `TableDataTab`/`DocumentListView`
            (both reachable via `TabBody` above) call `confirmDestructive`,
            which now awaits this dialog instead of blocking on
            `window.confirm` — a window with no `ConfirmHost` would leave
            that promise unsettled forever. */}
        <ConfirmHost />
      </div>
    </TooltipProvider>
  );
}
