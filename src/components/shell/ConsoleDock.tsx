/**
 * Bottom dock — replaces the old "console" outer-dockview panel.
 * Owns its own header (the Console / Terminal tabs and a collapse button)
 * and a persisted height; `StatusBar`'s `ConsoleToggle` is the other way to
 * reopen it once collapsed (see gotcha-style note in that file).
 *
 * The two tabs share the dock's height — both want as many lines as can be
 * spared — and only one shows at a time (`panelLayout.bottomTab`). The
 * Terminal tab is mounted the first time it is shown and, while it has
 * sessions, stays mounted through a collapse: unmounting it would end every
 * shell and `mongosh` the user had open, which hiding the dock must never do.
 */

import { useEffect, useState } from "react";
import { ChevronDown, ScrollText, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Console } from "@/components/query/Console";
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  flushPanelLayoutStorage,
  useSessionPanelLayout,
  type BottomTabId,
} from "@/stores/session/panelLayout";
import { usePreferences } from "@/stores/preferences/preferences";
import { useTerminals } from "@/stores/session/terminals";
import { Sash } from "@/components/shell/Sash";
import { CollapsiblePanel } from "@/components/shell/CollapsiblePanel";
import { cn } from "@/lib/utils";

export function ConsoleDock() {
  const { t } = useTranslation();
  const open = useSessionPanelLayout((s) => s.consoleOpen);
  const height = useSessionPanelLayout((s) => s.consoleHeight);
  const bottomTab = useSessionPanelLayout((s) => s.bottomTab);
  const showBottomTab = useSessionPanelLayout((s) => s.showBottomTab);
  const nudgePanel = useSessionPanelLayout((s) => s.nudgePanel);
  const terminalEnabled = usePreferences((s) => s.prefs.terminal.enabled);
  const hasSessions = useTerminals((s) => s.tabs.length > 0);
  const [dragging, setDragging] = useState(false);

  const tab: BottomTabId = terminalEnabled ? bottomTab : "console";
  const [terminalMounted, setTerminalMounted] = useState(open && tab === "terminal");
  useEffect(() => {
    if (open && tab === "terminal") setTerminalMounted(true);
  }, [open, tab]);
  // Switched off in Settings: `AppShell` closes every session; this lets the
  // panel go too, so turning it back on starts from a clean slate.
  useEffect(() => {
    if (!terminalEnabled) setTerminalMounted(false);
  }, [terminalEnabled]);

  const tabs: { id: BottomTabId; icon: typeof ScrollText; label: string }[] = [
    { id: "console", icon: ScrollText, label: t("panels.console") },
    ...(terminalEnabled
      ? [{ id: "terminal" as const, icon: SquareTerminal, label: t("panels.terminal") }]
      : []),
  ];

  return (
    <>
      {open && (
        <Sash
          orientation="horizontal"
          onResize={(delta) => nudgePanel("consoleHeight", -delta)}
          onDraggingChange={(d) => {
            setDragging(d);
            if (!d) flushPanelLayoutStorage();
          }}
        />
      )}
      <CollapsiblePanel
        open={open}
        size={height}
        axis="height"
        dragging={dragging}
        keepMounted={hasSessions}
      >
        <div
          className={cn(
            "flex h-full flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-background",
            "shadow-[0_1px_2px_color-mix(in_srgb,var(--foreground)_4%,transparent),0_6px_20px_color-mix(in_srgb,var(--foreground)_5%,transparent)]",
          )}
        >
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-1.5">
            <div role="tablist" aria-label={t("shell.bottomDock")} className="flex items-center gap-0.5">
              {tabs.map(({ id, icon, label }) => (
                <Button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  variant="quiet"
                  flat
                  size="xs"
                  icon={icon}
                  onClick={() => showBottomTab(id)}
                  className={cn(
                    "h-6 px-2 text-[10.5px] font-semibold uppercase tracking-wider",
                    tab === id && "bg-accent text-foreground",
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
            <IconButton
              type="button"
              flat
              size="xs"
              icon={ChevronDown}
              label={t("shell.console.collapse")}
              side="top"
              onClick={() => useSessionPanelLayout.setState({ consoleOpen: false })}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="h-full" hidden={tab !== "console"}>
              <Console />
            </div>
            {terminalEnabled && terminalMounted && (
              <div className="h-full" hidden={tab !== "terminal"}>
                <TerminalPanel visible={open && tab === "terminal"} />
              </div>
            )}
          </div>
        </div>
      </CollapsiblePanel>
    </>
  );
}
