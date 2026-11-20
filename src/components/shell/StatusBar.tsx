/**
 * Bottom status bar. Left side: a connections dropdown (see
 * `StatusConnections`) plus the active tab's selection count, if any (query
 * tabs have their own run stats — timer, rows, history — inside the query
 * editor itself, see `QueryEditorTab`, rather than duplicated here). Right
 * side: encoding, the connected server version, the query-history count
 * (which opens the History panel), and quick density / theme toggles.
 *
 * Everything here subscribes to reference-stable store values and derives
 * scalars locally, per the Zustand selector rule in CLAUDE.md.
 */

import { useTranslation } from "react-i18next";
import {
  History,
  Moon,
  Rows3,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabs } from "@/stores/session/tabs";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { useGridSelection } from "@/stores/grid/gridSelection";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { useThemeStore, selectActiveMode } from "@/stores/preferences/theme";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { usePendingChord } from "@/stores/session/pendingChord";
import { formatForDisplay } from "@/lib/keybindings";
import { StatusConnections } from "@/components/connection/StatusConnections";
import { EnvironmentSwitcher } from "@/components/connection/EnvironmentSwitcher";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/** Thin vertical divider between status bar sections. */
function Sep() {
  return <span className="text-muted-foreground/30">|</span>;
}

/**
 * The bar's two labelled controls. The bar is flat chrome at `text-2xs` in a
 * 28px strip, and `xs` — the smallest labelled size — is itself 28px at
 * `text-xs`, so these keep the bar's own line box rather than the size's.
 */
const STATUS_TEXT_BUTTON = "h-auto px-1 py-0.5 text-2xs font-normal";

/** Row-height presets driving the grid "density" quick toggle. */
const DENSITY_PRESETS: { key: string; labelKey: string; rowHeight: number }[] =
  [
    { key: "compact", labelKey: "statusBar.densityCompact", rowHeight: 20 },
    { key: "cosy", labelKey: "statusBar.densityCosy", rowHeight: 26 },
    {
      key: "comfortable",
      labelKey: "statusBar.densityComfortable",
      rowHeight: 32,
    },
  ];

export function StatusBar() {
  const { t } = useTranslation();
  const versions = useConnections((s) => s.versions);

  // NOT `s.tabs.find((t) => t.id === s.activeId)` — `.find()` returning "a
  // stable reference to an existing tab object" is true in general, but
  // false right after `updateQuery`, which replaces the active tab's own
  // object (`{...t, query}`) on every keystroke in the SQL editor. Selecting
  // the one primitive this component actually reads (`connectionId`) keeps
  // the selector reference-stable across a query edit, per the Zustand rule
  // in this file's own header comment.
  const activeConnectionId = useTabs((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeId);
    return tab?.connectionId;
  });
  const activeId = useTabs((s) => s.activeId);

  const historyCount = useQueryHistory((s) => s.entries.length);

  // Selection for the active tab (table tabs report; query tabs don't).
  const selection = useGridSelection((s) =>
    activeId ? s.byTab[activeId] : undefined,
  );

  const serverVersion = activeConnectionId
    ? versions[activeConnectionId]
    : undefined;

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-card/60 px-2 text-2xs text-muted-foreground">
      {/* Left — connections + selection stats */}
      <div className="flex items-center gap-2">
        <EnvironmentSwitcher />
        <Sep />
        <StatusConnections />

        {selection && selection.count > 0 && (
          <>
            <Sep />
            <span className="tabular-nums text-foreground">
              {t("statusBar.selected", { count: selection.count })}
            </span>
          </>
        )}
      </div>

      {/* Right — pending chord · encoding · version · history · density · theme */}
      <div className="flex items-center gap-2">
        <PendingChordHint />
        <SimpleTooltip label={t("statusBar.commandPaletteTooltip")} side="top">
          <Button
            type="button"
            flat
            variant="quiet"
            size="xs"
            onClick={() => useCommandPalette.getState().toggle()}
            className={STATUS_TEXT_BUTTON}
          >
            {t("statusBar.commandPaletteHint")}
          </Button>
        </SimpleTooltip>
        <Sep />
        <span>{t("statusBar.encoding")}</span>
        {serverVersion && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="max-w-[12rem] truncate">{serverVersion}</span>
          </>
        )}
        <span className="text-muted-foreground/30">·</span>
        <HistoryButton count={historyCount} />
        <Sep />
        <DensityMenu />
        <ConsoleToggle />
        <ThemeToggle />
      </div>
    </div>
  );
}

/**
 * The bar's query-history readout: the count, and a click that opens the
 * History panel in the dock (ADR #137).
 *
 * It used to be a menu of its own — the last 15 entries and a "Clear
 * history" that emptied every connection's history without asking — which
 * the dock panel made a second, weaker copy of the same list. Decided with
 * Alex on 2026-11-15: keep the count where it always was, and send the click
 * to the one place the history lives. It opens the panel rather than
 * toggling it: a status-bar readout that closed what you came to look at
 * would read as broken.
 */
function HistoryButton({ count }: { count: number }) {
  const { t } = useTranslation();
  const showRightPanel = useSessionPanelLayout((s) => s.showRightPanel);
  return (
    <SimpleTooltip label={t("statusBar.openHistory")} side="top">
      <Button
        type="button"
        flat
        variant="quiet"
        size="xs"
        className={cn(STATUS_TEXT_BUTTON, "gap-1")}
        onClick={() => showRightPanel("history")}
      >
        {/* A child rather than `icon`: the bar's type is `text-2xs`, a
            step below the smallest size whose glyph the button owns. */}
        <History className="h-3 w-3" />
        {t("statusBar.history")} {count}
      </Button>
    </SimpleTooltip>
  );
}

/** Grid row-density quick toggle (reuses the persisted `gridPrefs.rowHeight`). */
function DensityMenu() {
  const { t } = useTranslation();
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          flat
          size="xs"
          icon={Rows3}
          label={t("statusBar.density")}
          side="top"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-40">
        <DropdownMenuLabel>{t("statusBar.density")}</DropdownMenuLabel>
        {DENSITY_PRESETS.map((d) => (
          <DropdownMenuItem
            key={d.key}
            onSelect={() => updateGrid({ rowHeight: d.rowHeight })}
            className={cn(
              rowHeight === d.rowHeight && "font-semibold text-brand",
            )}
          >
            {t(d.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Reopens the console dock once it's been collapsed from its own header
 *  (`ConsoleDock`) — the VSCode "toggle terminal" pattern, since collapsing
 *  it there leaves no other affordance to bring it back. */
function ConsoleToggle() {
  const { t } = useTranslation();
  const consoleOpen = useSessionPanelLayout((s) => s.consoleOpen);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  return (
    <IconButton
      type="button"
      flat
      size="xs"
      icon={SquareTerminal}
      label={
        consoleOpen ? t("shell.console.collapse") : t("shell.console.expand")
      }
      side="top"
      onClick={toggleConsole}
      aria-pressed={consoleOpen}
      className={cn(consoleOpen && "text-foreground")}
    />
  );
}

/** Light/dark quick toggle, mirroring the header button. */
function ThemeToggle() {
  const { t } = useTranslation();
  const mode = useThemeStore(selectActiveMode);
  const setMode = useThemeStore((s) => s.setActiveMode);
  return (
    <IconButton
      type="button"
      flat
      size="xs"
      icon={mode === "dark" ? Sun : Moon}
      label={t("statusBar.toggleTheme")}
      side="top"
      onClick={() => setMode(mode === "dark" ? "light" : "dark")}
    />
  );
}

/**
 * What the app is waiting for mid-chord.
 *
 * A half-typed sequence swallows the next keystroke, so it has to be visible —
 * otherwise `Mod+K` followed by a pause looks exactly like a broken keyboard.
 * Renders nothing at all when there is no prefix pending, which is almost
 * always, so it costs one subscription and no layout.
 */
function PendingChordHint() {
  const { t } = useTranslation();
  const chords = usePendingChord((s) => s.chords);
  if (chords.length === 0) return null;
  return (
    <>
      <span className="rounded-sm bg-brand/15 px-1.5 py-0.5 font-mono text-brand">
        {formatForDisplay(chords.join(" "))}
      </span>
      <span>{t("statusBar.chordPending")}</span>
      <Sep />
    </>
  );
}
