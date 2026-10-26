/**
 * Central preferences dialog.
 *
 * Two-pane layout: a left rail and a right pane that renders the active
 * section. Open/close + active section live in `useSettingsDialog` so any
 * component can request the dialog (FileMenu, ThemeMenu, ViewMenu, Ctrl/Cmd+,
 * hotkey, the topbar button) without prop-drilling through App.
 *
 * - **The rail is grouped** (Workspace / Data & sharing / Integrations /
 *   Organization, About pinned at the foot) and each entry is one line: at
 *   fourteen sections a label plus a description per entry stopped fitting
 *   without scrolling, and the grouping says more than the descriptions did.
 *   The description moved into the pane's own header, where there is room.
 *   Entries carry what the user would otherwise open the section to learn —
 *   how many connections MCP exposes and Pulse samples, whether the AI panel is
 *   on, and a dot on any section holding a setting off its default.
 * - **The rail has its own search.** It filters `SETTINGS_INDEX` — the command
 *   palette's registry, so a setting the palette can find is one this box can
 *   find — and replaces the pane with results until it is cleared.
 * - **Every section gets the same header**: its name and description, and, when
 *   any of its settings has moved, a count and a "Reset section" that puts them
 *   back. Sections used to title themselves or not at all (only JSON Schemas and
 *   Origins did), so the pane's top edge looked different on every click.
 *
 * Controls inside each section read from / write to `usePreferences` (or
 * `useThemeStore` for Appearance) directly — there is no local form state
 * and no Save button. Changes apply live; the preferences store debounces
 * the disk write 400 ms downstream.
 *
 * The legacy single-prop signature `(open, onOpenChange)` is preserved for
 * App.tsx, which still owns its own local boolean while the rest of the
 * codebase migrates to `useSettingsDialog.openAt(...)`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  BookOpen,
  Bell,
  Bot,
  Cable,
  Network,
  Cog,
  LockKeyhole,
  FolderSync,
  FileJson,
  FileText,
  Keyboard,
  Palette,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Table2,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/components/settings/useSettingsDialog";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { useConnections } from "@/stores/session/connections";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import {
  docForSettingsSection,
  resolveSettingsDoc,
} from "@/lib/appInfo/settingsDocs";
import { DEFAULT_PREFS, usePreferences } from "@/stores/preferences/preferences";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import { SecuritySection } from "@/components/settings/sections/SecuritySection";
import { EditorSection } from "@/components/settings/sections/EditorSection";
import { GridSection } from "@/components/settings/sections/GridSection";
import { NotificationsSection } from "@/components/settings/sections/NotificationsSection";
import { ConnectionsSection } from "@/components/settings/sections/ConnectionsSection";
import { AppearanceSection } from "@/components/settings/sections/AppearanceSection";
import { ShortcutsSection } from "@/components/settings/sections/ShortcutsSection";
import { McpSection } from "@/components/settings/sections/McpSection";
import { PulseSection } from "@/components/settings/sections/PulseSection";
import { AiSection } from "@/components/settings/sections/AiSection";
import { TerminalSection } from "@/components/settings/sections/TerminalSection";
import { PolicySection } from "@/components/settings/sections/PolicySection";
import { JsonSchemasSection } from "@/components/settings/sections/JsonSchemasSection";
import { OriginsSection } from "@/components/settings/sections/OriginsSection";
import { AboutSection } from "@/components/settings/sections/AboutSection";
import {
  SettingsSearchResults,
  type SectionHit,
} from "@/components/settings/SettingsSearchResults";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { NavRailItem } from "@/components/ui/nav-rail";
import { SearchField } from "@/components/ui/search-field";
import { MICRO_HEADING } from "@/components/ui/styles";
import { useShortcutLabel } from "@/lib/keybindings";
import {
  SETTINGS_INDEX,
  type SettingEntry,
} from "@/lib/commandPalette/settingsRegistry";
import { matchSettings } from "@/lib/commandPalette/searchSettings";
import { modifiedPrefIds } from "@/lib/prefDefaults";
import type { PrefId } from "@/lib/prefId";
import { cn } from "@/lib/utils";

interface Props {
  /** Optional controlled-mode signature kept for backwards compatibility. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type SectionIcon = React.ComponentType<{ className?: string }>;

const NAV: { group: string; items: { id: SettingsSection; icon: SectionIcon }[] }[] = [
  {
    // How the app looks and behaves on this machine.
    group: "workspace",
    items: [
      { id: "general", icon: Cog },
      // Who may open HuginnDB on this machine: the app lock now, Windows
      // Hello and the session lock next. Settings' own section; the tab that
      // lists a server's users and privileges is a different thing.
      { id: "security", icon: LockKeyhole },
      { id: "editor", icon: FileText },
      { id: "grid", icon: Table2 },
      { id: "appearance", icon: Palette },
      { id: "notifications", icon: Bell },
      { id: "shortcuts", icon: Keyboard },
    ],
  },
  {
    // JSON Schemas sit with Origins rather than with Editor: both are user
    // *content* shared across machines, not knobs on how the app behaves.
    group: "data",
    items: [
      { id: "connections", icon: Network },
      { id: "jsonSchemas", icon: FileJson },
      { id: "origins", icon: FolderSync },
    ],
  },
  {
    // What HuginnDB is allowed to reach and what leaves the machine — the
    // question a user comes to this group with.
    group: "integrations",
    items: [
      { id: "mcp", icon: Cable },
      { id: "pulse", icon: Activity },
      { id: "ai", icon: Bot },
      { id: "terminal", icon: SquareTerminal },
    ],
  },
  {
    // Not a knob but the answer to "who decided what the AI may reach here?"
    // when an organization manages the machine.
    group: "organization",
    items: [{ id: "policy", icon: ShieldCheck }],
  },
];

const ABOUT = { id: "about" as const, icon: Info };

const ALL_SECTIONS: { id: SettingsSection; icon: SectionIcon }[] = [
  ...NAV.flatMap((g) => g.items),
  ABOUT,
];
const SECTION_ORDER = ALL_SECTIONS.map((s) => s.id);
const ICON_OF = Object.fromEntries(ALL_SECTIONS.map((s) => [s.id, s.icon])) as Record<
  SettingsSection,
  SectionIcon
>;

/** The registry's ids per section, computed once: it is static data. */
const IDS_BY_SECTION = SETTINGS_INDEX.reduce(
  (acc, e) => {
    (acc[e.section] ??= []).push(e.prefId);
    return acc;
  },
  {} as Partial<Record<SettingsSection, PrefId[]>>,
);

export function SettingsDialog({ open, onOpenChange }: Props) {
  const openSettingsShortcut = useShortcutLabel("openSettings");
  const storeOpen = useSettingsDialog((s) => s.open);
  const setStoreOpen = useSettingsDialog((s) => s.setOpen);
  const section = useSettingsDialog((s) => s.section);
  const setSection = useSettingsDialog((s) => s.setSection);
  const openAtPref = useSettingsDialog((s) => s.openAtPref);
  const showUpdateDot = useUpdateStore(selectUpdateNotificationVisible);
  const prefs = usePreferences((s) => s.prefs);
  const resetPrefs = usePreferences((s) => s.resetPrefs);
  // Counts, not arrays: a number out of the selector keeps the subscription
  // stable (gotcha #1), and the rail only needs the number.
  const mcpExposed = useConnections(
    (s) => s.profiles.filter((p) => p.mcp_exposed).length,
  );
  const pulseSampled = useConnections(
    (s) => s.profiles.filter((p) => p.pulse_enabled).length,
  );
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchFocusRequest = useSettingsDialog((s) => s.searchFocusRequest);
  const { t, i18n } = useTranslation();

  // Keep the controlled prop (from App.tsx's existing button) in sync with
  // the central store so either entry point opens / closes the same UI.
  useEffect(() => {
    if (open !== undefined && open !== storeOpen) setStoreOpen(open);
  }, [open, storeOpen, setStoreOpen]);

  const isOpen = open ?? storeOpen;

  // A search left in the box would greet the next opening with a results page
  // instead of the section the caller asked for (the palette, the About link).
  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  // The find key while Settings is open. Select what is there so typing
  // replaces the last search instead of appending to it.
  useEffect(() => {
    if (searchFocusRequest === 0) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchFocusRequest]);

  const handleOpenChange = (next: boolean) => {
    setStoreOpen(next);
    onOpenChange?.(next);
  };

  const modifiedBySection = useMemo(() => {
    const out: Partial<Record<SettingsSection, PrefId[]>> = {};
    for (const id of SECTION_ORDER) {
      const ids = modifiedPrefIds(prefs, DEFAULT_PREFS, IDS_BY_SECTION[id] ?? []);
      if (ids.length > 0) out[id] = ids;
    }
    return out;
  }, [prefs]);

  const searching = query.trim().length > 0;
  const hits = useMemo(() => {
    if (!searching) return { sections: [] as SectionHit[], settings: [] as SettingEntry[] };
    const sections = matchSettings(query, ALL_SECTIONS, (s) => ({
      label: t(`settings.sections.${s.id}.label`),
      rest: t(`settings.sections.${s.id}.desc`),
    }));
    const settings = matchSettings(query, SETTINGS_INDEX, (e) => ({
      label: t(e.labelKey),
      rest: [
        e.descKey ? t(e.descKey) : "",
        e.keywords ?? "",
        t(`settings.sections.${e.section}.label`),
      ].join(" "),
    }));
    return { sections, settings };
  }, [query, searching, t]);

  const pickSection = (id: SettingsSection) => {
    setQuery("");
    setSection(id);
  };
  const pickSetting = (entry: SettingEntry) => {
    setQuery("");
    openAtPref(entry.section, entry.prefId);
  };

  const sectionModified = modifiedBySection[section] ?? [];

  // The guide that explains this section, if one does (`settingsDocs`). Every
  // section with a guide gets the same button in the same place, which is what
  // the hand-written "full guide" links at the foot of MCP and Pulse were an
  // inconsistent half of.
  const guide = searching ? undefined : docForSettingsSection(section);
  const openGuide = () => {
    if (!guide) return;
    const target = resolveSettingsDoc(
      guide,
      guide.headingKey ? t(guide.headingKey) : null,
      i18n.language,
    );
    handleOpenChange(false);
    useDocsDialog.getState().openTo(target.id, target.section, target.anchor);
  };

  const trailingFor = (id: SettingsSection) => {
    const parts: React.ReactNode[] = [];
    if (id === "mcp" && mcpExposed > 0)
      parts.push(
        <Badge key="n" size="xs" mono>
          {mcpExposed}
        </Badge>,
      );
    if (id === "pulse" && pulseSampled > 0)
      parts.push(
        <Badge key="n" size="xs" mono>
          {pulseSampled}
        </Badge>,
      );
    if (id === "ai" && prefs.ai.enabled)
      parts.push(
        <span key="on" className="text-3xs font-medium text-success">
          {t("commandPalette.settings.on")}
        </span>,
      );
    if (modifiedBySection[id])
      parts.push(
        <span key="mod" className="flex items-center">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
          <span className="sr-only">{t("settings.changed")}</span>
        </span>,
      );
    return parts.length > 0 ? <span className="flex items-center gap-1.5">{parts}</span> : undefined;
  };

  const railItem = ({ id, icon }: { id: SettingsSection; icon: SectionIcon }) => (
    <NavRailItem
      key={id}
      icon={icon}
      active={!searching && id === section}
      label={t(`settings.sections.${id}.label`)}
      trailing={trailingFor(id)}
      badge={
        id === "about" && showUpdateDot ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-background"
          />
        ) : undefined
      }
      onClick={() => pickSection(id)}
    />
  );

  const HeaderIcon = searching ? Search : ICON_OF[section];

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        tier="workbench"
        className="flex h-[85vh] max-w-6xl flex-col"
        // Escape clears a search before it closes the dialog: the user typing
        // in the rail's box expects Escape to undo the typing, not to lose
        // the whole dialog.
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery("");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-brand" />
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="text-2xs">
            {t("settings.description")}{" "}
            {/* Read from the catalogue, not written out: this line used to say
                `Ctrl/Cmd + ,` regardless of what the user had rebound it to. */}
            <Kbd className="px-1 py-0.5 text-3xs">
              {openSettingsShortcut ?? t("settings.shortcuts.unassigned")}
            </Kbd>
            .
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid grid-cols-[224px_1fr]">
          <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
            <div className="shrink-0 p-2 pb-1">
              <SearchField
                ref={searchRef}
                value={query}
                onValueChange={setQuery}
                onClear={() => setQuery("")}
                clearLabel={t("settings.search.clear")}
                size="sm"
                placeholder={t("settings.search.placeholder", {
                  count: SETTINGS_INDEX.length,
                })}
                aria-label={t("settings.search.label")}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const first = hits.settings[0];
                  if (first) pickSetting(first);
                  else if (hits.sections[0]) pickSection(hits.sections[0].id);
                }}
              />
            </div>
            <nav
              aria-label={t("settings.title")}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2"
            >
              {NAV.map((g) => (
                <div key={g.group} className="space-y-0.5">
                  <div className={cn(MICRO_HEADING, "px-2.5 pb-1")}>
                    {t(`settings.groups.${g.group}`)}
                  </div>
                  {g.items.map(railItem)}
                </div>
              ))}
            </nav>
            <div className="shrink-0 border-t border-border p-2">{railItem(ABOUT)}</div>
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-start gap-3 px-6 pb-4 pt-5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <HeaderIcon className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold leading-tight tracking-tight">
                  {searching
                    ? t("settings.search.title", { query: query.trim() })
                    : t(`settings.sections.${section}.label`)}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {searching
                    ? t("settings.search.count", {
                        count: hits.settings.length + hits.sections.length,
                      })
                    : t(`settings.sections.${section}.desc`)}
                </p>
              </div>
              {!searching && (sectionModified.length > 0 || guide) && (
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {sectionModified.length > 0 && (
                    <>
                      <Badge tone="brand">
                        {t("settings.changedCount", {
                          count: sectionModified.length,
                        })}
                      </Badge>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon={RotateCcw}
                        onClick={() => setConfirmReset(true)}
                      >
                        {t("settings.resetSection")}
                      </Button>
                    </>
                  )}
                  {guide && (
                    <Button
                      size="xs"
                      variant="outline"
                      icon={BookOpen}
                      onClick={openGuide}
                    >
                      {t("docs.readGuide")}
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div
              // Keyed on what it shows so switching section — or into and out
              // of search — starts at the top instead of inheriting the last
              // view's scroll offset, which dropped results mid-list.
              key={searching ? "search" : section}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
            >
              {searching ? (
                <SettingsSearchResults
                  sections={hits.sections}
                  settings={hits.settings}
                  order={SECTION_ORDER}
                  onPickSection={pickSection}
                  onPickSetting={pickSetting}
                />
              ) : (
                <>
                  {section === "general" && <GeneralSection />}
                  {section === "editor" && <EditorSection />}
                  {section === "grid" && <GridSection />}
                  {section === "notifications" && <NotificationsSection />}
                  {section === "connections" && <ConnectionsSection />}
                  {section === "appearance" && <AppearanceSection />}
                  {section === "shortcuts" && <ShortcutsSection />}
                  {section === "jsonSchemas" && <JsonSchemasSection />}
                  {section === "origins" && <OriginsSection />}
                  {section === "mcp" && <McpSection />}
                  {section === "pulse" && <PulseSection />}
                  {section === "ai" && <AiSection />}
                  {section === "terminal" && <TerminalSection />}
                  {section === "security" && <SecuritySection />}
                  {section === "policy" && <PolicySection />}
                  {section === "about" && <AboutSection />}
                </>
              )}
            </div>
          </main>
        </DialogBody>

        <ConfirmDialog
          open={confirmReset}
          onOpenChange={setConfirmReset}
          title={t("settings.resetSectionTitle", {
            section: t(`settings.sections.${section}.label`),
          })}
          description={t("settings.resetSectionConfirm", {
            count: sectionModified.length,
          })}
          confirmLabel={t("settings.resetSection")}
          onConfirm={() => {
            resetPrefs(sectionModified);
            setConfirmReset(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
