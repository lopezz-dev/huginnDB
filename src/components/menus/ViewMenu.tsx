/**
 * Top-bar "View" dropdown — toggles UI display preferences (schema
 * metric) and exposes panel-level actions (show/hide Schema, Saved,
 * Pulse, AI, Console, Terminal — the optional modules only when switched on). Panel state lives in `panelLayout.ts`, a plain Zustand store
 * — no dockview API involved for these three since the outer shell
 * redesign (see that store's header comment).
 */

import { ChevronDown, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { usePreferences } from "@/stores/preferences/preferences";
import { ShortcutHint } from "@/components/menus/ShortcutHint";
import type { SchemaTableMetric } from "@/types";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { moduleEnabled } from "@/lib/panelModules";

const METRIC_OPTIONS: { value: SchemaTableMetric; i18nKey: string }[] = [
  { value: "none", i18nKey: "menu.view.metricHide" },
  { value: "row-count", i18nKey: "menu.view.metricRowCount" },
  { value: "size", i18nKey: "menu.view.metricSize" },
  { value: "both", i18nKey: "menu.view.metricBoth" },
];

export function ViewMenu() {
  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);
  const updateUi = usePreferences((s) => s.updateUi);
  const setMetric = (m: SchemaTableMetric) =>
    updateUi({ schemaTableMetric: m });
  const openSettings = useSettingsDialog((s) => s.openAt);
  const { t } = useTranslation();

  const schemaOpen = useSessionPanelLayout((s) => s.schemaOpen);
  const rightPanel = useSessionPanelLayout((s) => s.rightPanel);
  const consoleOpen = useSessionPanelLayout((s) => s.consoleOpen);
  const toggleSchema = useSessionPanelLayout((s) => s.toggleSchema);
  const selectRightPanel = useSessionPanelLayout((s) => s.selectRightPanel);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  const bottomTab = useSessionPanelLayout((s) => s.bottomTab);
  const toggleTerminal = useSessionPanelLayout((s) => s.toggleTerminal);
  // Switched-off modules are not offered here either — see `panelModules`.
  const pulseOn = usePreferences((s) => moduleEnabled(s.prefs, "pulse"));
  const aiOn = usePreferences((s) => moduleEnabled(s.prefs, "ai"));
  const terminalOn = usePreferences((s) => moduleEnabled(s.prefs, "terminal"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button flat variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <Eye className="h-3.5 w-3.5" />
          {t("menu.view.label")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>{t("menu.view.sectionPanels")}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={schemaOpen}
          onSelect={(e) => {
            e.preventDefault();
            toggleSchema();
          }}
        >
          {t("panels.schema")}
          <ShortcutHint action="togglePanelSchema" />
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={rightPanel === "saved"}
          onSelect={(e) => {
            e.preventDefault();
            selectRightPanel("saved");
          }}
        >
          {t("panels.saved")}
          <ShortcutHint action="togglePanelSaved" />
        </DropdownMenuCheckboxItem>
        {pulseOn && (
          <DropdownMenuCheckboxItem
            checked={rightPanel === "pulse"}
            onSelect={(e) => {
              e.preventDefault();
              selectRightPanel("pulse");
            }}
          >
            {t("panels.pulse")}
            <ShortcutHint action="togglePanelPulse" />
          </DropdownMenuCheckboxItem>
        )}
        {aiOn && (
          <DropdownMenuCheckboxItem
            checked={rightPanel === "ai"}
            onSelect={(e) => {
              e.preventDefault();
              selectRightPanel("ai");
            }}
          >
            {t("panels.ai")}
            <ShortcutHint action="togglePanelAi" />
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuCheckboxItem
          checked={consoleOpen && bottomTab === "console"}
          onSelect={(e) => {
            e.preventDefault();
            toggleConsole();
          }}
        >
          {t("panels.console")}
          <ShortcutHint action="togglePanelConsole" />
        </DropdownMenuCheckboxItem>
        {terminalOn && (
          <DropdownMenuCheckboxItem
            checked={consoleOpen && bottomTab === "terminal"}
            onSelect={(e) => {
              e.preventDefault();
              toggleTerminal();
            }}
          >
            {t("panels.terminal")}
            <ShortcutHint action="togglePanelTerminal" />
          </DropdownMenuCheckboxItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuLabel>
          {t("menu.view.sectionSchemaTree")}
        </DropdownMenuLabel>
        {METRIC_OPTIONS.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={metric === opt.value}
            onSelect={(e) => {
              e.preventDefault();
              setMetric(opt.value);
            }}
          >
            {t(opt.i18nKey)}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            openSettings("grid");
          }}
        >
          {t("menu.view.preferences")}
          <ShortcutHint action="openSettings" />
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-3xs leading-snug text-muted-foreground/70">
          {t("menu.view.help")}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
