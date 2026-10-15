/**
 * Top-level layout: header (File menu + centered breadcrumb + theme /
 * settings actions), the outer shell in the middle, and the status bar
 * at the bottom.
 *
 * The outer shell (`AppShell`) is an activity-bar-driven layout: Schema
 * and Saved dock to a fixed side and collapse to 0px from their activity
 * bar button, Console docks to the bottom, and the workspace island (open
 * table/query tabs) is the one fixed, unmovable canvas in the middle — see
 * `stores/session/panelLayout.ts` for why this replaced the old 5-panel
 * outer dockview (it visually implied you could spin up more
 * "workspaces", which was never the intent).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import "dockview-react/dist/styles/dockview.css";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { hydrateInstalledThemes } from "@/stores/preferences/theme";
import { UpdateBanner } from "@/components/shell/UpdateBanner";
import { WindowTitleSync } from "@/components/shell/WindowTitleSync";
import { SandboxRibbon } from "@/components/shell/SandboxRibbon";
import { PolicyRibbon } from "@/components/shell/PolicyRibbon";
import { SplashScreen } from "@/components/shell/SplashScreen";
import { getCurrentVersion } from "@/lib/appInfo/updater";
import { useWhatsNew } from "@/stores/dialogs/whatsNew";
import { WhatsNewDialog } from "@/components/shell/dialogs/WhatsNewDialog";
import { DocsDialog } from "@/components/shell/dialogs/DocsDialog";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import {
  usePreferences,
} from "@/stores/preferences/preferences";
import { useKeybindingDispatcher } from "@/lib/keybindings";
import { moduleEnabled } from "@/lib/panelModules";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useJsonSchemaTransfer } from "@/stores/dialogs/jsonSchemaTransfer";
import { disconnectAll } from "@/lib/connection/connectFlow";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useTreeSearch } from "@/stores/session/treeSearch";
import { startFocusFollowsTab } from "@/stores/session/focusFollowsTab";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { FileMenu } from "@/components/menus/FileMenu";
import { WindowMenu } from "@/components/menus/WindowMenu";
import { ViewMenu } from "@/components/menus/ViewMenu";
import { HelpMenu } from "@/components/menus/HelpMenu";
import { AppShell } from "@/components/shell/AppShell";
import { LayoutToggles } from "@/components/shell/LayoutToggles";
import { TitleBar } from "@/components/shell/TitleBar";
import { NotificationCenter } from "@/components/shell/NotificationCenter";
import { NotificationHosts } from "@/components/shell/NotificationHosts";
import { StatusBar } from "@/components/shell/StatusBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { TabSwitcher, useTabSwitcher } from "@/components/shell/TabSwitcher";
import { SettingsDialog } from "@/components/settings/dialogs/SettingsDialog";
import { OriginEditorOverlay } from "@/components/origins/OriginEditorOverlay";
import { PolicyEditorHost } from "@/components/settings/dialogs/PolicyEditorDialog";
import { OriginRepublishDialog } from "@/components/origins/dialogs/OriginRepublishDialog";
import { EnvironmentEditorDialog } from "@/components/connection/dialogs/EnvironmentEditorDialog";
import { EnvironmentDeleteConfirmDialog } from "@/components/connection/dialogs/EnvironmentDeleteConfirmDialog";
import { ConfirmHost } from "@/components/common/ConfirmHost";
import { PasswordPromptHost } from "@/components/connection/PasswordPromptHost";
import { startAiStreamBridge } from "@/lib/bridges/ai-stream-bridge";
import { startLogBridge } from "@/lib/bridges/log-bridge";
import {
  intentDisplayName,
  useCliIntents,
} from "@/lib/cli/useCliIntents";
import { startConnectionHealthBridge } from "@/lib/bridges/connection-health-bridge";
import { startConnectionSyncBridge } from "@/lib/bridges/connection-sync-bridge";
import { startWindowListBridge } from "@/lib/bridges/window-list-bridge";
import { WindowColorBadge } from "@/components/shell/WindowColorBadge";
import { startPrefsSyncBridge } from "@/lib/bridges/prefs-sync-bridge";
import { startJsonSchemaBridge } from "@/lib/bridges/json-schema-bridge";
import { startOriginsBridge } from "@/lib/bridges/origins-bridge";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { setModePrefs } from "@/lib/monaco/monacoJson";
import { flushAllTabState, persistLaunchState } from "@/stores/session/persistedTabs";
import { useEnvironments } from "@/stores/session/environments";
import { startPeriodicOriginSync } from "@/stores/sync/originSync";
import { useOrigins } from "@/stores/sync/origins";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMainWindow } from "@/lib/window";
import { CliConnectChoiceDialog } from "@/components/connection/dialogs/CliConnectChoiceDialog";
import { FeedbackDialog } from "@/components/shell/dialogs/FeedbackDialog";
import { LEGACY_DOCKVIEW_LAYOUT_KEY } from "@/lib/constants";
import { AdHocDriverDialog } from "@/components/connection/dialogs/AdHocDriverDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { refreshTable } from "@/lib/grid/tableRefresh";
import { focusTableSearch } from "@/lib/grid/tableSearch";
import { sqliteFileLabel } from "@/lib/connectionLabel";
import { useBridge } from "@/lib/bridges/useBridge";
import { startPolicyBridge } from "@/lib/bridges/policy-bridge";

export default function App() {
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshConnections = useConnections((s) => s.refresh);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const canaryFlavor = useAppFlavor((s) => s.canary);
  const hydratePreferences = usePreferences((s) => s.hydrate);
  const language = usePreferences((s) => s.prefs.ui.language);
  // A stable slice reference (gotcha #1) — the whole group is handed to the
  // toaster container at once.
  const openSettings = useSettingsDialog((s) => s.openAt);
  const updateNotificationVisible = useUpdateStore(
    selectUpdateNotificationVisible,
  );
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const { t } = useTranslation();

  // Initial profile load — used to live inside ConnectionList, which is
  // no longer mounted at startup.
  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  // Arm Monaco with the editor themes that came from imported VS Code themes.
  // They live on disk rather than in localStorage (see the note on
  // `importedEditorThemes`), so unlike the palettes they cannot be read before
  // first paint. An editor that mounts first *is* repainted when the
  // definitions land — but only because it resolves its theme through
  // `useMonacoTheme`, which subscribes to the store this fills. This comment
  // used to assert that repaint while nothing implemented it (gotcha #90);
  // the guarantee lives in the hook, not here. Runs in every window; the
  // call is read-only.
  useEffect(() => {
    void hydrateInstalledThemes();
  }, []);

  // Keep the workspace's focused connection following the focused tab. One
  // subscription for the window's lifetime; see
  // `stores/session/focusFollowsTab.ts` for why this is derived in one place
  // rather than being another `setSelectedConnectionId` call per navigation.
  //
  // Safe to start before the launch restore: `restoreSession` sets the
  // persisted focus *last*, after the tabs are in `useTabs`, so its explicit
  // choice still wins over whatever the last restored tab would have implied.
  useEffect(() => startFocusFollowsTab(), []);

  // Launch restore: load the environment list in EVERY window — it's a
  // read-only call, and a secondary "New window" needs it too so its own
  // rail/switcher can render and seed that window's own connection filter
  // from whatever environment is active (see `useEnvironments.load`). Only the
  // main window goes on to bring the active environment's session up — its
  // view filters always, and with `reconnectOnLaunch` on, also reconnect what
  // was live, restore the pane layout and restore focus. (The filters sit
  // before that gate inside `restoreSession`: they say how the environment
  // looks, not what it reopens.)
  //
  // The sequence itself lives in `useEnvironments.restoreSession` because
  // entering an environment at launch and entering one via the switcher are the
  // same operation, and its ordering is load-bearing enough that two copies
  // would eventually drift: the layout `fromJSON` must run AFTER the
  // reconnected tabs are in `useTabs`, or the TabbedArea reconciler deletes the
  // panels it just built (gotcha #10), and focus must come last because
  // `connect()` never sets it and the auto-select effect below would otherwise
  // win with whichever pool opened first. Runs once.
  const launchRestoreDone = useRef(false);
  useEffect(() => {
    if (launchRestoreDone.current) return;
    launchRestoreDone.current = true;
    void (async () => {
      await useEnvironments.getState().load();
      if (!isMainWindow()) {
        // "Open environment in new window": the label's stashed environment id,
        // if any. After `load()` so the environment list is in the store, and
        // here rather than in the CLI-intent effect, which starts concurrently
        // and would race it.
        try {
          const envId = await api.takeWindowEnvironmentIntent(
            getCurrentWindow().label,
          );
          if (envId) await useEnvironments.getState().enterInThisWindow(envId);
        } catch (e) {
          console.warn("[environments] could not enter the requested environment", e);
        }
        return;
      }
      await useEnvironments.getState().restoreSession();
      // Shared origins: first sweep now, then every few hours. After the session
      // is up so a slow or unreachable share can never delay the workspace.
      startPeriodicOriginSync();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate preferences from disk before the user can interact with the
  // settings UI. Failures fall back to defaults inside the store itself,
  // so we don't gate the rest of the boot on this promise.
  useEffect(() => {
    void hydratePreferences();
  }, [hydratePreferences]);

  // Forward the user's language choice into i18next whenever it changes
  // (on hydrate, or when the user picks a different option in Settings).
  useEffect(() => {
    setLanguage(language);
  }, [language]);

  // Update check on launch, plus a recurring background check so an
  // instance that's never closed still catches up on a release published
  // while it was running (see stores/update.ts). Failures inside the store
  // are swallowed and surfaced only inside Settings → About; we never
  // block boot or show an error toast.
  useEffect(() => {
    void useUpdateStore.getState().checkOnLaunch();
    useUpdateStore.getState().startPeriodicChecks();
  }, []);

  // Resolve the build flavor (stable vs canary sandbox) once. Runs in EVERY
  // window — each has its own chrome, and the sandbox ribbon must show in
  // secondary windows too. Idempotent and failure-tolerant (see the store).
  useEffect(() => {
    void useAppFlavor.getState().load();
  }, []);

  // One-shot "What's new" presentation: on the first launch after an update
  // bumped the app to a version flagged `major` in `releaseNotes.ts`, pop the
  // highlights dialog. MAIN-WINDOW-ONLY — the seen-marker is shared, so a
  // secondary ephemeral window shouldn't also fire it (same rationale as the
  // CLI-routing guard below and CLAUDE.md gotcha #8).
  useEffect(() => {
    if (!isMainWindow()) return;
    void (async () => {
      try {
        const version = await getCurrentVersion();
        useWhatsNew.getState().notifyLaunch(version);
      } catch (e) {
        console.error("[whatsNew] version lookup failed", e);
      }
    })();
  }, []);

  // Command-line connection intents: this window's own startup args, and a
  // second launch of the app forwarded by the single-instance handler. Called
  // HERE, not in a child component: a child's effects mount before its
  // parent's, which would move these ahead of the launch-restore sequence
  // above whose ordering gotchas #8 and #10 pin down. This is the position the
  // code occupied before it moved into the hook.
  const cli = useCliIntents();

  // Flush every active connection's tab/layout state to disk before the
  // window actually closes (issue #80). Without this, only an explicit
  // "disconnect" ever flushed synchronously — a normal window close (let
  // alone anything more abrupt) could lose up to the debounce window's
  // worth of trailing tab/layout edits, including split-panel geometry.
  // Main-window-only: secondary ("New window") instances never touch
  // `tab_state.json` (see CLAUDE.md gotcha #8).
  useEffect(() => {
    if (!isMainWindow()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let closing = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          // Record the launch state (live connections, focused connection,
          // active tab) so the next launch restores it, then flush tabs + the
          // session layout. Awaited — the window destroys right after.
          await persistLaunchState(Array.from(useConnections.getState().active));
        } catch (err) {
          console.error("[connections] save-launch-state-on-close failed:", err);
        }
        try {
          await flushAllTabState();
        } catch (err) {
          console.error("[persistedTabs] flush-on-close failed:", err);
        }
        // `destroy()`, not `close()` — `close()` re-emits close-requested
        // and would loop back into this same handler.
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the Rust `huginndb://log` Tauri event so the Console panel
  // sees every SQL + connection event. (`useBridge` owns the unlisten; see its
  // doc for why the cancellation flag matters under StrictMode and HMR.)
  useBridge(startLogBridge);

  // Subscribe to the Rust `huginndb://ai-delta` Tauri event so the AI panel
  // streams. Mounted here rather than in the panel because it has to exist
  // before the first delta arrives — a listener attached when the panel mounts
  // would drop the opening tokens of the first turn (see the bridge's docs).
  useBridge(startAiStreamBridge);

  // Subscribe to the Rust `huginndb://connection-lost` Tauri event so the
  // connection list can surface a reconnect action the moment the
  // background keepalive (`src-tauri/src/keepalive.rs`) detects a dead
  // pool, instead of the user finding out mid-query.
  useBridge(startConnectionHealthBridge);

  // Cross-window sync (issue #18): every window shares one backend
  // AppState, but each window's frontend used to hold a private snapshot
  // of `active`/`profiles`/`prefs` with no way to learn about another
  // window's connect/disconnect/profile edit/settings change.
  useBridge(startConnectionSyncBridge);
  useBridge(startPolicyBridge);

  // Cross-window window-count tracking (the color badge below): a new
  // window opened anywhere, or any window closing, changes what every
  // window's badge should show.
  useBridge(startWindowListBridge);

  // The other half of #18: preference writes from any window.
  useBridge(startPrefsSyncBridge);

  // Keep the JSON language service in step with the three schema switches.
  // Subscribed as primitives, so this effect fires only when one actually flips
  // (gotcha #1) rather than on every preferences write.
  const jsonSchemaValidation = usePreferences(
    (s) => s.prefs.editor.jsonSchemaValidation,
  );
  const jsonSchemaCompletion = usePreferences(
    (s) => s.prefs.editor.jsonSchemaCompletion,
  );
  const jsonSchemaHover = usePreferences((s) => s.prefs.editor.jsonSchemaHover);
  useEffect(() => {
    setModePrefs({
      validation: jsonSchemaValidation,
      completion: jsonSchemaCompletion,
      hover: jsonSchemaHover,
    });
  }, [jsonSchemaValidation, jsonSchemaCompletion, jsonSchemaHover]);

  // The JSON Schema library: hydrate once, then keep in step with the other
  // windows. Unlike tab state, this is global config every window reads and
  // writes (see the bridge for why its listener is deliberately unscoped), so
  // there is no main-window-only guard here.
  useEffect(() => {
    void useJsonSchemas.getState().load();
  }, []);
  useBridge(startJsonSchemaBridge);

  // The shared-origin registry: same shape as the JSON Schema library above and
  // for the same reason — one global list, read by every window, so no
  // main-window guard and an unscoped listener. Read-only, unlike the sync
  // itself (`startPeriodicOriginSync`, which is main-window-only).
  useEffect(() => {
    void useOrigins.getState().load();
  }, []);
  useBridge(startOriginsBridge);

  // Update notifications now render as a custom `UpdateBanner` at the
  // top of the window (see the JSX below). The previous implementation
  // used a corner Sonner toast, but the toast was easy to miss and its
  // styling didn't match the rest of the app chrome — see CHANGELOG
  // entry for 0.4.0. Sonner stays available for short-lived toasts
  // (errors, copy-success confirmations, etc.).

  // Global shortcuts. One `window` listener for the whole app, owned by
  // `useKeybindingDispatcher` — it resolves the chord against the live index,
  // checks the focused surface's `data-kb-scope`, and calls the handler below.
  // Monaco still swallows keys inside its own focus area and redispatches them
  // itself (gotcha #9), but through the same resolver.
  const togglePalette = useCommandPalette((s) => s.toggle);
  const openPaletteWith = useCommandPalette((s) => s.openWith);
  const toggleSwitcher = useTabSwitcher((s) => s.toggle);

  const refreshActiveData = useCallback(() => {
    // The same "refresh" the toolbar button offers: the active table tab's
    // data if one is open, otherwise the schema tree (databases + tables) for
    // the selected connection — the target the explorer's own refresh button
    // hits in both single-DB and multi-DB mode.
    const tabs = useTabs.getState();
    const activeTab = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (activeTab?.kind === "table" && refreshTable(activeTab.id)) return;
    // `refreshTree`: `selected` is always a profile id, and a multi-DB
    // connection keeps its tables in the child slices under it.
    if (selected) void useSchema.getState().refreshTree(selected);
  }, [refreshTable, selected]);

  // Shared by `focusTreeFilter` and the find key's fallback. Module-level
  // stores only, so it needs no dependencies and the memo below stays put.
  const focusTreeFilter = useCallback(() => {
    // A shortcut that focuses something invisible would do nothing at all,
    // so open the panel first.
    useSessionPanelLayout.getState().openSchema();
    useTreeSearch.getState().requestFocus();
  }, []);

  const shortcutHandlers = useMemo(
    () => ({
      openSettings: () => openSettings(),
      toggleCommandPalette: () => togglePalette(),
      // Same palette, pre-filtered to its actions mode (VS Code's
      // Ctrl+Shift+P), so "run a command" never competes with the tables and
      // settings the catch-all mode also searches.
      openCommandActions: () => openPaletteWith(">"),
      toggleTabSwitcher: () => toggleSwitcher(),
      refreshData: refreshActiveData,
      refreshSchema: () => {
        if (selected) void useSchema.getState().refreshTree(selected);
      },

      // The schema tree's search. Each reads `useTreeSearch` imperatively, so
      // none of them widens this memo's dependency list — the same discipline
      // the block below already follows.
      focusTreeFilter: focusTreeFilter,
      // The find key, answered by what the user is looking at. Order matters:
      // the checks that *decline* come first, because a decline is what hands
      // Ctrl+F back to the widget that owns it there.
      focusFilter: () => {
        const focused = document.activeElement;
        // Monaco's own find widget is the only sensible answer inside an
        // editor — including the JSON Schema body editor inside Settings.
        if (focused?.closest(".monaco-editor")) return false;
        if (useSettingsDialog.getState().open) {
          useSettingsDialog.getState().requestSearchFocus();
          return;
        }
        if (useDocsDialog.getState().open) {
          useDocsDialog.getState().requestSearchFocus();
          return;
        }
        // Any other modal holds a focus trap: the filter behind it could not
        // take the focus, so moving it there would silently do nothing.
        if (focused?.closest('[role="dialog"], [role="alertdialog"]')) return false;
        const tabs = useTabs.getState();
        const active = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (active?.kind === "table" && focusTableSearch(active.id)) return;
        focusTreeFilter();
      },
      clearTreeFilter: () => {
        // Layered: text, then the scope one level at a time. When there is
        // nothing left to undo the keystroke still does something visible —
        // it hands focus to the tree — which is what makes the layering
        // learnable rather than a guess.
        if (useTreeSearch.getState().escape() === "none") {
          document
            .querySelector<HTMLElement>("[data-tree-row]")
            ?.focus();
        }
      },
      scopeFilterToConnection: () => {
        // `selectedConnectionId` is always a profile id (gotcha #32), which is
        // exactly what a connection scope anchors to.
        const connectionId = useUi.getState().selectedConnectionId;
        if (!connectionId) return;
        const search = useTreeSearch.getState();
        search.narrowTo({ kind: "connection", connectionId });
        search.requestFocus();
      },

      // Everything below was already a command the palette could run; giving
      // it a catalogue id is what makes it bindable too. Each reads its store
      // imperatively, so none of them widens this memo's dependency list.
      newConnection: () => useConnectionDialog.getState().openNew(),
      manageConnections: () => useConnectionDialog.getState().openManage(selected),
      importProfiles: () => useConnectionDialog.getState().setImportOpen(true),
      exportProfiles: () => useConnectionDialog.getState().setExportOpen(true),
      manageJsonSchemas: () => openSettings("jsonSchemas"),
      importJsonSchemas: () => useJsonSchemaTransfer.getState().setImportOpen(true),
      exportJsonSchemas: () => useJsonSchemaTransfer.getState().openExport(),

      newQuery: () => {
        if (!selected) return;
        const target = useTabs.getState().queryTargetFor(selected);
        if (target) openQueryTab(target);
      },
      closeTab: () => {
        const tabs = useTabs.getState();
        if (tabs.activeId) tabs.close(tabs.activeId);
      },
      closeAllTabs: () => useTabs.getState().closeAll(),
      togglePinTab: () => {
        const tabs = useTabs.getState();
        const active = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (active) tabs.setPinned(active.id, !active.pinned);
      },

      // Shared with the Schema panel's button. This used to be its own loop:
      // concurrent (so fast) but it dropped neither the cached schema nor the
      // tabs pointing at the closed pools, leaving the tree stale — the same
      // command behaving differently depending on where it was invoked from.
      disconnectAll: () => void disconnectAll(),

      togglePanelSchema: () => useSessionPanelLayout.getState().toggleSchema(),
      togglePanelSaved: () =>
        useSessionPanelLayout.getState().selectRightPanel("saved"),
      // A switched-off module's shortcut does nothing — and says so to the
      // dispatcher, so the keystroke falls through rather than being eaten.
      togglePanelPulse: () => {
        if (!moduleEnabled(usePreferences.getState().prefs, "pulse")) return false;
        useSessionPanelLayout.getState().selectRightPanel("pulse");
      },
      togglePanelAi: () => {
        if (!moduleEnabled(usePreferences.getState().prefs, "ai")) return false;
        useSessionPanelLayout.getState().selectRightPanel("ai");
      },
      togglePanelConsole: () => useSessionPanelLayout.getState().toggleConsole(),
      togglePanelTerminal: () => {
        if (!moduleEnabled(usePreferences.getState().prefs, "terminal")) return false;
        useSessionPanelLayout.getState().toggleTerminal();
      },
      newWindow: () => {
        void api.openNewWindow().catch((e) => notify.error(String(e)));
      },
      resetLayout: () => useSessionPanelLayout.getState().resetLayout(),
    }),
    [
      openSettings,
      togglePalette,
      openPaletteWith,
      toggleSwitcher,
      refreshActiveData,
      focusTreeFilter,
      selected,
    ],
  );
  useKeybindingDispatcher(shortcutHandlers);

  // Stable derived breadcrumb metadata; both inputs are reference-stable
  // store values, so this satisfies the Zustand selector invariant.
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selected) ?? null,
    [profiles, selected],
  );

  // Keep `selected` in sync with the live connection set:
  //   • clear when the selected pool disconnects
  //   • auto-select the first active pool when nothing is selected
  useEffect(() => {
    if (selected && !active.has(selected)) setSelected(null);
    if (!selected && active.size > 0) setSelected(Array.from(active)[0]);
  }, [active, selected, setSelected]);

  // One-shot cleanup of the old 5-panel outer dockview's persisted layout
  // blob — superseded by `stores/session/panelLayout.ts`. Not migrated
  // field-by-field (see that store's header comment); just discarded.
  useEffect(() => {
    localStorage.removeItem(LEGACY_DOCKVIEW_LAYOUT_KEY);
  }, []);

  return (
    <TooltipProvider>
      {/* Decorative launch overlay, ~0.5s total. Sits outside the layout flow
          and never blocks it — see `SplashScreen` for why it isn't tied to the
          session-restore sequence. */}
      <SplashScreen />
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {/* The title bar comes first and the ribbons under it: with the native
            frame gone this row is where the window is dragged from and where
            its close button lives, and both belong at the very top edge. */}
        <TitleBar>
          {/* Left — File + Window + View + Help menus */}
          <FileMenu selectedConnectionId={selected} onSelect={setSelected} />
          <WindowMenu />
          <ViewMenu />
          <HelpMenu />

          {/* Centred breadcrumb — absolutely positioned so it stays in the
              middle of the bar regardless of action button widths. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 font-mono text-sm">
              <span className="font-semibold tracking-tight">
                {t("common.brand")}
              </span>
              {canaryFlavor && (
                <span className="rounded-sm bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wider text-amber-950 dark:bg-amber-500 dark:text-black">
                  {t("sandbox.badge")}
                </span>
              )}
              {selectedProfile && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver === "sqlite"
                      ? sqliteFileLabel(selectedProfile.database)
                      : // Multi-DB connections have no single catalog, so
                        // `database` is empty; fall back to the connection
                        // name instead of rendering a blank segment (#51).
                        selectedProfile.database || selectedProfile.name}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right — the notification bell, then the panel toggles. The bell
              sits with the chrome controls rather than in the status bar: it is
              a thing you click, its unread badge has to be noticed, and the
              status bar's 10px row gave it neither the size nor the contrast to
              be either. */}
          <div className="ml-auto flex items-center gap-1">
            <NotificationCenter />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <LayoutToggles />
          </div>
        </TitleBar>
        <SandboxRibbon />
        <PolicyRibbon />
        <WindowColorBadge />
        <SettingsDialog />
        {/* Siblings of Settings, not children: both editors are full-screen
            surfaces. Opening one puts Settings aside (`suspend`) so focus is
            never trapped in two dialogs at once, and closing it brings
            Settings back where it was (`resume`). */}
        <OriginEditorOverlay />
        <PolicyEditorHost />
        {/* Raised by `ConnectionDialog` after a publisher corrects one of its
            own origin's connections, and mounted out here because connecting
            closes that dialog — see `stores/dialogs/originRepublish`. */}
        <OriginRepublishDialog />
        <EnvironmentEditorDialog />
        <EnvironmentDeleteConfirmDialog />
        {/* Replaces `window.confirm` — see `lib/confirmDestructive.ts`. */}
        <ConfirmHost />
        <PasswordPromptHost />
        <div className="flex-1 overflow-hidden">
          <AppShell />
        </div>
        <StatusBar />
      </div>
      <CommandPalette />
      <TabSwitcher />
      <AdHocDriverDialog
        open={cli.driverPrompt !== null}
        connectionName={cli.driverPrompt?.name ?? ""}
        onPick={(driver) => {
          const pending = cli.driverPrompt;
          cli.setDriverPrompt(null);
          if (pending) void cli.createAndConnectAdhoc(pending, driver);
        }}
        onCancel={() => cli.setDriverPrompt(null)}
      />
      <CliConnectChoiceDialog
        open={cli.cliChoice !== null}
        connectionName={
          cli.cliChoice ? intentDisplayName(cli.cliChoice, profiles) : ""
        }
        dontAskAgain={cli.cliDontAskAgain}
        onDontAskAgainChange={cli.setCliDontAskAgain}
        onCurrentWindow={() => {
          const args = cli.cliChoice;
          cli.setCliChoice(null);
          if (cli.cliDontAskAgain) {
            cli.updateUiPrefs({ cliConnectDefault: "current" });
          }
          if (args) cli.routeIncomingConnection(args, "current");
        }}
        onNewWindow={() => {
          const args = cli.cliChoice;
          cli.setCliChoice(null);
          if (cli.cliDontAskAgain) {
            cli.updateUiPrefs({ cliConnectDefault: "new" });
          }
          if (args) cli.routeIncomingConnection(args, "new");
        }}
        onCancel={() => cli.setCliChoice(null)}
      />
      <FeedbackDialog />
      <WhatsNewDialog />
      <DocsDialog />
      <WindowTitleSync />
      {/* Both notification hosts plus their overflow badges. See
          `NotificationHosts` for why the container is not inlined here. */}
      <NotificationHosts />
      {updateNotificationVisible && availableVersion && (
        <UpdateBanner version={availableVersion} />
      )}
    </TooltipProvider>
  );
}
