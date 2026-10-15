/**
 * Root layout of the outer shell: the environment rail (left), two
 * collapsible side panels (Schema, and a right dock the activity bar
 * selects into), the workspace island, and a bottom console dock.
 *
 * Replaces the old outer `DockviewReact` (5 equal-rank panels — see
 * `stores/session/panelLayout.ts` for why). Fixed roles instead of
 * draggable/floatable panels: nothing here can be reordered or torn off,
 * which is the whole point — the previous layout visually implied you
 * could spin up more "workspaces", and this one can't.
 *
 * The left rail is `EnvironmentRail` (Discord-style environment icons),
 * not a generic `ActivityBar` — there is no separate "Schema" toggle
 * button; clicking the already-active environment's icon collapses/
 * expands the Schema panel instead. The right side keeps the generic
 * `ActivityBar`, since nothing docked there is tied to a per-environment
 * identity; it selects which panel occupies the single right dock rather
 * than toggling each one independently (see `panelLayout.ts`).
 *
 * `TabbedArea` (nested dockview, ADR #10) lives untouched inside
 * `IslandShell`; nothing in this file talks to dockview at all.
 */

import { useEffect, useState } from "react";
import {
  Activity,
  Blocks,
  Bot,
  Moon,
  Save,
  Settings,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUi } from "@/stores/session/ui";
import {
  flushPanelLayoutStorage,
  rightPanelSizeKey,
  useSessionPanelLayout,
} from "@/stores/session/panelLayout";
import { useThemeStore, selectActiveMode } from "@/stores/preferences/theme";
import { usePreferences } from "@/stores/preferences/preferences";
import { useTerminals } from "@/stores/session/terminals";
import { moduleEnabled } from "@/lib/panelModules";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { ConnectionsTree } from "@/components/connection/ConnectionsTree";
import { SavedQueriesPanel } from "@/components/query/SavedQueriesPanel";
import { PulsePanel } from "@/components/pulse/PulsePanel";
import { AiPanel } from "@/components/ai/AiPanel";
import { ConnectionErrorBoundary } from "@/components/connection/ConnectionErrorBoundary";
import { EnvironmentRail } from "@/components/connection/EnvironmentRail";
import {
  ActivityBar,
  type ActivityBarButton,
} from "@/components/shell/ActivityBar";
import { ExtensionsPanel } from "@/components/settings/ExtensionsPanel";
import { IslandShell } from "@/components/shell/IslandShell";
import { ConsoleDock } from "@/components/shell/ConsoleDock";
import { CollapsiblePanel } from "@/components/shell/CollapsiblePanel";
import { Sash } from "@/components/shell/Sash";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function SchemaPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return (
    <ConnectionErrorBoundary resetKey={id ?? undefined}>
      <ConnectionsTree />
    </ConnectionErrorBoundary>
  );
}

function SavedPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return <SavedQueriesPanel connectionId={id} />;
}

// Module-level: `SchemaPanel`/`SavedPanel` take no props, so this element
// can be created exactly once and reused forever. Passing the SAME element
// reference down every render is what lets `SchemaSidePanel`/`RightSidePanel`
// re-render on a width change (many times a second, mid-drag) without React
// ever reconciling this subtree — it sees the identical element and bails
// out, same optimization a `useMemo(() => <SchemaPanel />, [])` would give,
// without needing the memo at all since there are no props to depend on.
const SCHEMA_PANEL_ELEMENT = <SchemaPanel />;
const SAVED_PANEL_ELEMENT = <SavedPanel />;

const PANEL_SHADOW =
  "shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_4%,transparent),0_6px_20px_color-mix(in_srgb,var(--foreground)_5%,transparent)]";

/**
 * Owns the schema panel's width/dragging state so `AppShell` itself never
 * subscribes to `schemaWidth` — that value changes on every animation frame
 * of a sash drag (see `useSashDrag`), and `AppShell` re-rendering for it
 * would re-render its whole child tree (`IslandShell`, `ConsoleDock`, the
 * right activity bar, …) on every one of those frames. Confining the
 * subscription here means only this wrapper (and `CollapsiblePanel`) pay
 * for the drag; `SCHEMA_PANEL_ELEMENT`'s stable identity is what keeps
 * `SchemaPanel`'s own subtree from re-rendering even for THIS wrapper.
 */
function SchemaSidePanel() {
  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const schemaWidth = useSessionPanelLayout((s) => s.schemaWidth);
  const nudgePanel = useSessionPanelLayout((s) => s.nudgePanel);
  const [dragging, setDragging] = useState(false);

  return (
    <>
      <CollapsiblePanel
        open={schemaOpen}
        size={schemaWidth}
        axis="width"
        dragging={dragging}
      >
        <div className="h-full overflow-hidden py-2 pl-2">
          <div
            className={cn(
              "h-full overflow-hidden rounded-[var(--radius)] border border-border bg-background",
              PANEL_SHADOW,
            )}
          >
            {SCHEMA_PANEL_ELEMENT}
          </div>
        </div>
      </CollapsiblePanel>
      {schemaOpen && (
        <Sash
          orientation="vertical"
          onResize={(delta) => nudgePanel("schemaWidth", delta)}
          onDraggingChange={(d) => {
            setDragging(d);
            if (!d) flushPanelLayoutStorage();
          }}
        />
      )}
    </>
  );
}

/**
 * The right dock. Same width-subscription reasoning as `SchemaSidePanel`,
 * but the size it reads depends on *which* panel is docked: each occupant
 * keeps its own width (see `panelLayout.ts`), so the sash has to nudge the
 * active one's key rather than a fixed `savedWidth`.
 *
 * When the dock is collapsed the sash still needs a key to aim at, hence the
 * fall back to `lastRightPanel` — it is never actually dragged in that state,
 * but reading `rightPanelSizeKey(null)` would mean widening the helper to
 * accept a case that cannot happen.
 */
function RightSidePanel() {
  const rightPanel = useSessionPanelLayout((s) => s.rightPanel);
  const lastRightPanel = useSessionPanelLayout((s) => s.lastRightPanel);
  const savedWidth = useSessionPanelLayout((s) => s.savedWidth);
  const pulseWidth = useSessionPanelLayout((s) => s.pulseWidth);
  const aiWidth = useSessionPanelLayout((s) => s.aiWidth);
  const extensionsWidth = useSessionPanelLayout((s) => s.extensionsWidth);
  const nudgePanel = useSessionPanelLayout((s) => s.nudgePanel);
  const selectedConnectionId = useUi((s) => s.selectedConnectionId);
  const [dragging, setDragging] = useState(false);

  // Pulse is mounted the first time it is selected and stays mounted after
  // that, hidden rather than unmounted while Saved is showing — same reason
  // Saved is `keepMounted` below (a pinned connection and a scroll position
  // are worth keeping), and it costs nothing while hidden because its polling
  // is gated on `active`, not on being mounted. Not mounted before that first
  // selection, so a user who never opens Pulse never pays for it at all.
  const [pulseMounted, setPulseMounted] = useState(rightPanel === "pulse");
  useEffect(() => {
    if (rightPanel === "pulse") setPulseMounted(true);
  }, [rightPanel]);

  // Same deferred mount for the AI panel, and it matters more here: each SQL
  // block in a transcript is a Monaco instance, so a user who never opens the
  // panel pays for none of them — and one who closes it keeps the conversation
  // they were mid-way through, which unmounting would discard.
  const [aiMounted, setAiMounted] = useState(rightPanel === "ai");
  useEffect(() => {
    if (rightPanel === "ai") setAiMounted(true);
  }, [rightPanel]);

  // Same again for the extensions panel: nobody pays for a registry search
  // they never asked for, and once opened it keeps its results and scroll
  // position while the dock shows something else. Its `active` prop is what
  // gates fetching, not being mounted.
  const [extensionsMounted, setExtensionsMounted] = useState(rightPanel === "extensions");
  useEffect(() => {
    if (rightPanel === "extensions") setExtensionsMounted(true);
  }, [rightPanel]);

  const docked = rightPanel ?? lastRightPanel;
  const open = rightPanel !== null;
  const width =
    docked === "pulse"
      ? pulseWidth
      : docked === "ai"
        ? aiWidth
        : docked === "extensions"
          ? extensionsWidth
          : savedWidth;

  return (
    <>
      {open && (
        <Sash
          orientation="vertical"
          onResize={(delta) => nudgePanel(rightPanelSizeKey(docked), -delta)}
          onDraggingChange={(d) => {
            setDragging(d);
            if (!d) flushPanelLayoutStorage();
          }}
        />
      )}
      <CollapsiblePanel
        open={open}
        size={width}
        axis="width"
        dragging={dragging}
        // `SavedQueriesPanel` owns local, unpersisted state (search filter,
        // the rename/edit dialog) — unmounting it on every collapse would
        // silently discard whatever the user was mid-typing there.
        keepMounted
      >
        <div className="h-full overflow-hidden py-2 pr-2">
          <div
            className={cn(
              "h-full overflow-hidden rounded-[var(--radius)] border border-border bg-background",
              PANEL_SHADOW,
            )}
          >
            <div className="h-full" hidden={docked !== "saved"}>
              {SAVED_PANEL_ELEMENT}
            </div>
            {pulseMounted && (
              <div className="h-full" hidden={docked !== "pulse"}>
                <PulsePanel active={open && rightPanel === "pulse"} />
              </div>
            )}
            {aiMounted && (
              <div className="h-full" hidden={docked !== "ai"}>
                <AiPanel connectionId={selectedConnectionId} />
              </div>
            )}
            {extensionsMounted && (
              <div className="h-full" hidden={docked !== "extensions"}>
                <ExtensionsPanel active={open && rightPanel === "extensions"} />
              </div>
            )}
          </div>
        </div>
      </CollapsiblePanel>
    </>
  );
}

/**
 * Theme + Settings buttons, moved here from the top header (they used to
 * sit at its far right) into the left activity bar's footer — the user
 * asked for chrome-level actions to live with the rest of the shell
 * chrome instead of the header, which now only carries the menu bar and
 * the breadcrumb.
 */
function ChromeFooter() {
  const { t } = useTranslation();
  const mode = useThemeStore(selectActiveMode);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const updateNotificationVisible = useUpdateStore(
    selectUpdateNotificationVisible,
  );
  const availableVersion = useUpdateStore((s) => s.availableVersion);

  return (
    <>
      <SimpleTooltip label={t("common.tooltipToggleTheme")} side="right">
        <button
          type="button"
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {mode === "dark" ? (
            <Sun className="h-5 w-5" />
          ) : (
            <Moon className="h-5 w-5" />
          )}
        </button>
      </SimpleTooltip>
      <SimpleTooltip
        side="right"
        label={
          updateNotificationVisible
            ? t("update.tooltipUpdateAvailable", { version: availableVersion })
            : t("common.tooltipOpenPreferences")
        }
      >
        <button
          type="button"
          onClick={() =>
            updateNotificationVisible ? openSettings("about") : openSettings()
          }
          className="relative mt-1 flex h-9 w-9 items-center justify-center rounded-[10px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <Settings className="h-5 w-5" />
          {updateNotificationVisible && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-background",
              )}
            />
          )}
        </button>
      </SimpleTooltip>
    </>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const selectedConnectionId = useUi((s) => s.selectedConnectionId);

  // Low-frequency values only (a rail click, not a drag frame), so
  // subscribing to them here is harmless. The widths themselves live inside
  // `SchemaSidePanel`/`RightSidePanel` (see their doc comments) precisely so
  // a drag never reaches this component.
  const rightPanel = useSessionPanelLayout((s) => s.rightPanel);
  const selectRightPanel = useSessionPanelLayout((s) => s.selectRightPanel);
  const terminalShown = useSessionPanelLayout(
    (s) => s.consoleOpen && s.bottomTab === "terminal",
  );
  const toggleTerminal = useSessionPanelLayout((s) => s.toggleTerminal);
  const pulseOn = usePreferences((s) => moduleEnabled(s.prefs, "pulse"));
  const aiOn = usePreferences((s) => moduleEnabled(s.prefs, "ai"));
  const terminalOn = usePreferences((s) => moduleEnabled(s.prefs, "terminal"));

  // A module switched off in Settings takes its panel with it — off screen,
  // and out of what the dock's edge toggle would bring back. The terminal's
  // sessions end too: a switch that hid the icon but left shells running
  // would be the "hidden, not off" this switch promises not to be.
  useEffect(() => {
    const { retirePanel } = useSessionPanelLayout.getState();
    if (!pulseOn) retirePanel("pulse");
    if (!aiOn) retirePanel("ai");
    if (!terminalOn) {
      retirePanel("terminal");
      useTerminals.getState().closeAll();
    }
  }, [pulseOn, aiOn, terminalOn]);

  // A *selector* over the dock's occupants, not two independent switches —
  // see `panelLayout.ts`. The terminal is the one exception: it opens in the
  // bottom dock (a terminal wants width), but it is reached from here like
  // every other tool.
  const rightButtons: ActivityBarButton[] = [
    {
      id: "saved",
      icon: Save,
      label: t("panels.saved"),
      active: rightPanel === "saved",
      onClick: () => selectRightPanel("saved"),
    },
    ...(pulseOn
      ? [
          {
            id: "pulse",
            icon: Activity,
            label: t("panels.pulse"),
            active: rightPanel === "pulse",
            onClick: () => selectRightPanel("pulse"),
          },
        ]
      : []),
    ...(aiOn
      ? [
          {
            id: "ai",
            icon: Bot,
            label: t("panels.ai"),
            active: rightPanel === "ai",
            onClick: () => selectRightPanel("ai"),
          },
        ]
      : []),
    ...(terminalOn
      ? [
          {
            id: "terminal",
            icon: SquareTerminal,
            label: t("panels.terminal"),
            active: terminalShown,
            onClick: toggleTerminal,
          },
        ]
      : []),
    {
      id: "extensions",
      icon: Blocks,
      label: t("panels.extensions"),
      active: rightPanel === "extensions",
      onClick: () => selectRightPanel("extensions"),
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-muted/40">
      <EnvironmentRail footer={<ChromeFooter />} />

      <SchemaSidePanel />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2">
        <IslandShell connectionId={selectedConnectionId} />
        <ConsoleDock />
      </div>

      <RightSidePanel />

      <ActivityBar side="right" buttons={rightButtons} />
    </div>
  );
}
