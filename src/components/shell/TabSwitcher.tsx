/**
 * Open-tabs quick switcher (Ctrl/Cmd+P). A keyboard-first overlay listing
 * *currently open* tabs across every connection — the answer to "I have so
 * many tabs open I can't tell what's there / jump to one". Distinct from the
 * command palette (Ctrl+K), which opens *new* things from the schema; this
 * only ever navigates between tabs that already exist.
 *
 * Tabs are grouped: pinned first (so they never get lost), then one section
 * per `connection · database`. Enter jumps to the highlighted tab (and points
 * the workspace at its connection); the trailing buttons pin/unpin and close a
 * tab inline without leaving the list; Delete closes the highlighted tab.
 *
 * Built on the Radix Dialog primitive directly (same reasoning as
 * `CommandPalette`) with a plain substring filter — no new dependency.
 */

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { MICRO_HEADING } from "@/components/ui/styles";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayPalette } from "@/components/shell/OverlayPalette";
import { useListNavigation } from "@/lib/useListNavigation";
import {
  Eye,
  Hammer,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  SquareTerminal,
  Table as TableIcon,
  KeyRound,
  Workflow,
  X,
} from "lucide-react";
import { useTabs, useTabsIgnoringQuery } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import {
  resolveConnectionLabel,
  resolveConnectionParts,
  tabLeafTitle,
} from "@/lib/connectionLabel";
import { cn } from "@/lib/utils";
import type { AppTab, TabKind } from "@/types";
import { Kbd } from "@/components/ui/kbd";

interface TabSwitcherState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Shared so the window listener and the Monaco-scoped command both reach it. */
export const useTabSwitcher = create<TabSwitcherState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

const KIND_ICON: Record<TabKind, React.ReactNode> = {
  table: <TableIcon className="h-4 w-4" />,
  query: <SquareTerminal className="h-4 w-4" />,
  structure: <Hammer className="h-4 w-4" />,
  view: <Eye className="h-4 w-4" />,
  security: <ShieldCheck className="h-4 w-4" />,
  aggregation: <Workflow className="h-4 w-4" />,
  indexes: <KeyRound className="h-4 w-4" />,
};

interface Entry {
  tab: AppTab;
  group: string;
  connLabel: string;
  /** The tab's name with the database stripped when the subtitle repeats it. */
  leaf: string;
  subtitle: string;
}

export function TabSwitcher() {
  const { t } = useTranslation();
  const open = useTabSwitcher((s) => s.open);
  const setOpen = useTabSwitcher((s) => s.setOpen);

  const tabs = useTabsIgnoringQuery();
  const activeId = useTabs((s) => s.activeId);
  const profiles = useConnections((s) => s.profiles);

  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const pinnedLabel = t("tabSwitcher.pinned");

  // Build the grouped, ordered entry list: pinned first (one section), then a
  // section per connection · database in first-appearance order.
  const entries = useMemo<Entry[]>(() => {
    const labelFor = (cid: string) => resolveConnectionLabel(profiles, cid);
    const toEntry = (tab: AppTab, group: string): Entry => {
      const connLabel = labelFor(tab.connectionId);
      // The row already prints `connection · database` underneath, so the
      // title sheds the `database.` prefix it carries for standalone use
      // (same reasoning as the tab strip — see `tabLeafTitle`), and the
      // schema joins the subtitle only when it isn't that same database.
      const { database } = resolveConnectionParts(profiles, tab.connectionId);
      const schema =
        tab.kind === "table" && tab.schema && tab.schema !== database
          ? tab.schema
          : null;
      return {
        tab,
        group,
        connLabel,
        leaf: tabLeafTitle(profiles, tab),
        subtitle: schema ? `${schema} · ${connLabel}` : connLabel,
      };
    };

    const pinned = tabs
      .filter((x) => x.pinned)
      .map((x) => toEntry(x, pinnedLabel));

    const rest: Entry[] = [];
    const seen = new Set<string>();
    for (const x of tabs) {
      if (x.pinned) continue;
      const label = labelFor(x.connectionId);
      if (!seen.has(label)) {
        seen.add(label);
        // Append every non-pinned tab of this connection contiguously.
        for (const y of tabs) {
          if (!y.pinned && labelFor(y.connectionId) === label) {
            rest.push(toEntry(y, label));
          }
        }
      }
    }
    return [...pinned, ...rest];
  }, [tabs, profiles, pinnedLabel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      // The full `database.table` title stays in the haystack even though the
      // row renders the stripped leaf — typing the qualified name must match.
      `${e.tab.title} ${e.leaf} ${e.subtitle} ${e.connLabel}`
        .toLowerCase()
        .includes(q),
    );
  }, [entries, query]);

  // Arrow keys, bounds and scroll-into-view. No `wrap`: this list is short
  // enough to see whole, so wrapping past the end would read as a jump (the
  // command palette, whose list can be long, wraps).
  const { highlight, setHighlight, listRef, handleArrows } = useListNavigation(
    filtered.length,
  );

  function jump(tab: AppTab) {
    // Focusing the tab is the whole of it: `focusFollowsTab` folds the tab's
    // connection through the owning profile and moves the workspace there.
    // This used to do that itself, which is why the rule now lives in one place.
    useTabs.getState().setActive(tab.id);
    setOpen(false);
  }

  function closeTab(id: string) {
    useTabs.getState().close(id);
    // Closing the last open tab leaves nothing to switch to.
    if (useTabs.getState().tabs.length === 0) setOpen(false);
  }

  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.group, (m.get(e.group) ?? 0) + 1);
    return m;
  }, [filtered]);

  let lastGroup: string | null = null;

  return (
    <OverlayPalette
      open={open}
      onOpenChange={setOpen}
      title={t("tabSwitcher.title")}
      className="max-w-xl top-[15%]"
      query={query}
      onQueryChange={setQuery}
      placeholder={t("tabSwitcher.placeholder")}
      onKeyDown={(e) => {
        if (handleArrows(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          const e0 = filtered[highlight];
          if (e0) jump(e0.tab);
        } else if (e.key === "Delete") {
          e.preventDefault();
          const e0 = filtered[highlight];
          if (e0) closeTab(e0.tab.id);
        }
      }}
    >
      <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
            <Search className="h-5 w-5 opacity-40" />
            {tabs.length === 0
              ? t("tabSwitcher.noneOpen")
              : t("tabSwitcher.noResults")}
          </div>
        ) : (
          filtered.map((e, i) => {
            const showHeader = e.group !== lastGroup;
            lastGroup = e.group;
            const activeRow = i === highlight;
            const isCurrent = e.tab.id === activeId;
            return (
              <div key={e.tab.id}>
                {showHeader && (
                  <div
                    className={cn(
                      "flex items-center justify-between px-2 pb-1 pt-2",
                      MICRO_HEADING,
                    )}
                  >
                    <span className="truncate">{e.group}</span>
                    <span className="tabular-nums text-muted-foreground/60">
                      {groupCounts.get(e.group)}
                    </span>
                  </div>
                )}
                <div
                  data-index={i}
                  onMouseMove={() => setHighlight(i)}
                  className={cn(
                    "group/row flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                    activeRow
                      ? "bg-accent text-accent-foreground shadow-[inset_2px_0_0_var(--brand)]"
                      : "text-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => jump(e.tab)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                  >
                    <span
                      className={cn(
                        "shrink-0",
                        activeRow ? "text-brand" : "text-muted-foreground",
                      )}
                    >
                      {KIND_ICON[e.tab.kind]}
                    </span>
                    {e.tab.color && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: e.tab.color }}
                      />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{e.leaf}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-sm bg-brand/15 px-1 text-3xs font-medium uppercase tracking-wide text-brand">
                            {t("tabSwitcher.current")}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-2xs text-muted-foreground">
                        {e.subtitle}
                      </span>
                    </span>
                  </button>

                  {/* A pinned tab keeps its pin on screen — it is the row's
                      state, not only an action — so it reveals on hover only
                      while unpinned. */}
                  <IconButton
                    type="button"
                    flat
                    size="xs"
                    icon={e.tab.pinned ? PinOff : Pin}
                    label={
                      e.tab.pinned
                        ? t("tabSwitcher.unpin")
                        : t("tabSwitcher.pin")
                    }
                    revealOnHover={e.tab.pinned ? undefined : "row"}
                    onClick={() =>
                      useTabs.getState().setPinned(e.tab.id, !e.tab.pinned)
                    }
                    className={cn("shrink-0", e.tab.pinned && "text-brand")}
                  />
                  <IconButton
                    type="button"
                    size="xs"
                    tone="destructive"
                    icon={X}
                    label={t("tabSwitcher.close")}
                    revealOnHover="row"
                    onClick={() => closeTab(e.tab.id)}
                    className="shrink-0"
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-3xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd>
          {t("tabSwitcher.hintNavigate")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          {t("tabSwitcher.hintJump")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>del</Kbd>
          {t("tabSwitcher.hintClose")}
        </span>
      </div>
    </OverlayPalette>
  );
}
