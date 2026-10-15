/**
 * The custom tab header for a workspace panel: title, driver dot, per-tab
 * colour accent, close and middle-click, and the tab's own context menu.
 *
 * Split out of `TabbedArea`, where it was 445 of 1080 lines. **The close
 * affordances call `useTabs.close`, never `panel.api.close()`** — the store is
 * the source of truth and the reconciler in `TabbedArea` flows store → dockview
 * only, so closing through the panel API would feed removal back on itself
 * (ADR #10).
 */

import { useEffect, useMemo, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, X } from "lucide-react";

import { DriverBadge } from "@/components/common/DriverBadge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { api } from "@/lib/tauri";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  resolveConnectionDriver,
  resolveConnectionLabel,
  tabLeafTitle,
} from "@/lib/connectionLabel";
import { useClipFade } from "@/lib/useClipFade";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import type { AppTab, Driver, TabAccentStyle } from "@/types";
import type { IDockviewPanelHeaderProps } from "dockview-react";

/**
 * Whether two tab lists differ in anything a tab *header* renders.
 *
 * The header subscribes to the whole `tabs` array (it needs the sibling set to
 * decide whether to prefix the connection name), so without a custom equality
 * every store write — a scroll position, a result set landing — would re-render
 * every tab header. Compares only the fields the header reads; `AppTab` carrying
 * a new field that shows up in a header means adding it here too.
 */
function tabsRelevantEqual(a: AppTab[], b: AppTab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.connectionId !== y.connectionId ||
      x.kind !== y.kind ||
      x.title !== y.title ||
      x.schema !== y.schema ||
      x.table !== y.table ||
      x.color !== y.color ||
      x.pinned !== y.pinned
    ) {
      return false;
    }
  }
  return true;
}

/** Preset swatches offered in the tab colour picker (issue #24). Explicit hex
 *  so a user's chosen colour is stable regardless of theme. */
const TAB_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#0ea5e9",
  "#a855f7",
  "#ec4899",
];

/** Box-shadow for a per-tab custom colour, on the same edge as the active-tab
 *  accent rule in `index.css` for the given `tabAccentStyle` — so the two
 *  never compete for opposite sides of the tab. "boxed" uses the elevation
 *  shadow for the *default* brand accent, so a custom colour there draws a
 *  bottom-edge underline instead of fighting over the same box-shadow slot. */
function accentBoxShadow(style: TabAccentStyle, color: string): string {
  switch (style) {
    case "rail":
      return `inset 3px 0 0 0 ${color}`;
    case "boxed":
      return `inset 0 -2px 0 0 ${color}`;
    case "cap":
    default:
      return `inset 0 2px 0 0 ${color}`;
  }
}

/**
 * Custom equality for `WorkspaceTab`'s `tabs` subscription: only the fields
 * this component's render actually depends on (id/connectionId/kind/title
 * for the label + collision check, color/pinned for the accent + pin icon).
 * `useTabs` mutates `tabs` immutably on EVERY store action — including
 * `setViewState`, which `TableDataTab` fires on nearly every filter/sort/
 * search change — so a bare reference-equality subscription re-rendered
 * every open tab's header on every keystroke-driven query elsewhere, not
 * just on tab open/close/rename. Comparing by these fields instead means a
 * `viewState`/`initialFilters` change on some other tab no longer touches
 * this one.
 */

export function WorkspaceTab(props: IDockviewPanelHeaderProps) {
  const { t } = useTranslation();
  const id = props.api.id;
  // dockview renders this same component in two places: the tab strip
  // (`header`) and the "∨ N" overflow popover (`headerOverflow`). They are
  // different objects — a chip competing for horizontal space vs. a row in a
  // vertical list with room to spare — so the strip's truncation budget and
  // hover affordances would be exactly wrong in the popover. Branch on it
  // rather than shipping one layout that suits neither (see the overflow
  // rules in `index.css`, which turn each popover `.dv-tab` into a flush,
  // full-width row).
  const inOverflow = props.tabLocation === "headerOverflow";
  const tabs = useStoreWithEqualityFn(
    useTabs,
    (s) => s.tabs,
    tabsRelevantEqual,
  );
  // Derive active state from the store (the source of truth), NOT from
  // `props.api.isActive`: dockview does not re-render this custom tab on an
  // active-panel change, so reading `isActive` at render time goes stale and
  // the highlight never moves when you switch tabs. Subscribing to `activeId`
  // forces the re-render and keeps both tabs' styling in sync.
  const isActive = useTabs((s) => s.activeId === id);
  const profiles = useConnections((s) => s.profiles);

  // Last identity this panel had while its tab existed. A panel can outlive
  // its tab entry for a render or two — closing one (the panel is removed by
  // the reconciler, not by this component) and a restore-protected panel
  // waiting for its tab to arrive both do it — and falling back to the raw
  // panel id there put a bare `api02wzj` on screen where a name had been.
  // Holding the last one over is always closer to the truth than the id.
  const lastIdentity = useRef<{
    label: string;
    leaf: string;
    context: string | null;
    connName: string;
    qualified: string;
    driver: Driver | undefined;
  } | null>(null);

  const identity = useMemo(() => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) {
      return (
        lastIdentity.current ?? {
          label: id,
          leaf: id,
          context: null,
          connName: "",
          qualified: id,
          driver: undefined,
        }
      );
    }

    // Show the connection/database context whenever it's needed to tell tabs
    // apart: either more than one connection is in play, or another open tab
    // carries the same bare title (the same table opened on two connections /
    // databases — issue #22, where both rendered as an identical bare name). A
    // lone tab, or unique titles on a single connection, stay bare. The driver
    // badge (rendered unconditionally, see below) already gives every tab a
    // permanent visual anchor to its connection, so this context is only
    // needed for the disambiguation cases, not as the primary "which
    // connection" cue anymore.
    const distinctConnections = new Set(tabs.map((x) => x.connectionId)).size;
    const titleCollision =
      tabs.filter((x) => x.kind === tab.kind && x.title === tab.title).length >
      1;
    const showConn = distinctConnections > 1 || titleCollision;
    const connName = resolveConnectionLabel(profiles, tab.connectionId);
    // `tabLeafTitle` drops the `database.` prefix a table tab's title carries,
    // because `connName` right beside it already ends in that same database —
    // printing it twice is what pushed the table name itself out of view.
    const leafTitle = tabLeafTitle(profiles, tab);
    const qualified =
      tab.kind === "table" && tab.table
        ? `${tab.schema ? `${tab.schema}.` : ""}${tab.table}`
        : tab.title;
    return {
      // Flat string for the surfaces that need one (the detached-window
      // title). The rendered tab composes the two parts separately so the
      // context can truncate before the name does.
      label: showConn ? `${connName} · ${leafTitle}` : leafTitle,
      leaf: leafTitle,
      context: showConn ? connName : null,
      connName,
      qualified,
      driver: resolveConnectionDriver(profiles, tab.connectionId),
    };
  }, [tabs, profiles, id]);

  const { label, leaf, context, connName, qualified, driver } = identity;
  // Remember it only while the tab is real — writing back an identity that
  // *came* from the ref would pin it forever.
  if (tabs.some((tb) => tb.id === id)) lastIdentity.current = identity;

  // A clipped label fades into the tab instead of ending in an ellipsis, so
  // each of the four one-line labels (strip: context + name, popover row:
  // name + connection) needs to know whether it is actually being cut off.
  const contextFade = useClipFade<HTMLSpanElement>(context ?? "");
  const nameFade = useClipFade<HTMLSpanElement>(leaf);
  const rowNameFade = useClipFade<HTMLSpanElement>(leaf);
  const rowContextFade = useClipFade<HTMLSpanElement>(connName);

  // Full identity on hover — the tab strip truncates by design, so this is
  // where the whole name lives. Two lines, weighted: what the tab *is*, then
  // where it comes from.
  const tooltip = (
    <span className="flex max-w-[22rem] flex-col gap-0.5">
      <span className="break-all font-medium">{qualified}</span>
      <span className="break-all text-muted-foreground">{connName}</span>
    </span>
  );

  const thisTab = tabs.find((tb) => tb.id === id);
  // User-assigned tab colour (issue #24), rendered as an inset accent whose
  // edge follows `tabAccentStyle` (issue #35) — see `accentBoxShadow`.
  const tabColor = thisTab?.color;
  const tabAccentStyle = usePreferences((s) => s.prefs.ui.tabAccentStyle);
  const isPinned = !!thisTab?.pinned;

  // Route closing through the store so the reconciler does the actual panel
  // removal — keeps add/remove strictly store → dockview.
  const requestClose = () => useTabs.getState().close(id);
  const closeOthers = () => useTabs.getState().closeOthers(id);
  const closeToRight = () => useTabs.getState().closeToRight(id);
  const closeOthersInConnection = () =>
    useTabs.getState().closeOthersInConnection(id);
  const closeAll = () => useTabs.getState().closeAll();
  const setColor = (color: string | null) =>
    useTabs.getState().setColor(id, color);
  const togglePin = () => useTabs.getState().setPinned(id, !isPinned);
  // Pop this tab out into a real, independent OS window (see
  // `open_tab_window` / `DetachedTabWindow`) — unlike dockview's
  // `addFloatingGroup`, it isn't confined to the inner workspace's bounds
  // and can be dragged anywhere on the desktop. Closing that window is the
  // whole story for this tab, so it's removed from this window right away
  // rather than waiting for a close signal that never comes back.
  const detachToWindow = async () => {
    if (!thisTab) return;
    try {
      await api.openTabWindow(thisTab, label);
      useTabs.getState().close(id);
    } catch (e) {
      console.error("Failed to open detached tab window:", e);
    }
  };
  const hasOthers = tabs.length > 1;
  // Whether another tab of this connection exists (gates "close others in
  // this connection").
  const hasOthersInConnection =
    !!thisTab &&
    tabs.some((tb) => tb.id !== id && tb.connectionId === thisTab.connectionId);

  // Keep the active tab fully in view. dockview appends a newly-opened tab at
  // the end of the strip and can leave it clipped behind the right-hand
  // actions (the overflow ∨, the tab-switcher button, "+"), so an active tab
  // you just opened isn't visible. Scroll it into the scrollable tab list
  // whenever it becomes active; the rAF defers past dockview's panel-add
  // layout so the tab has its real width when we measure. `block: "nearest"`
  // keeps it from nudging any vertical scroll.
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only the strip scrolls; in the overflow popover this would yank the
    // list to the active row the moment it opens.
    if (!isActive || inOverflow) return;
    const raf = requestAnimationFrame(() => {
      tabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, inOverflow]);

  const closeButton = (
    <button
      className={cn(
        "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive",
        isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
      )}
      title={t("tabs.closeTab")}
      onClick={(e) => {
        // In the strip the click stops here — activating a tab you just
        // closed would be nonsense. In the popover it must NOT: dockview's
        // own listener on the row wrapper is what dismisses the popover, and
        // the popover cannot survive this click. It is built once, at open
        // time, from the tabs that were hidden *then* (see
        // dockview-core's `tabsContainer.js`), and nothing rebuilds it — so a
        // row whose tab just went away stays on screen as a dead entry. Let
        // it through and the whole popover closes, which is also what the
        // user means by closing a tab from a list of tabs.
        if (!inOverflow) e.stopPropagation();
        requestClose();
      }}
      // Same drag-suppression as the menu trigger.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );

  // Overflow popover row: still a chip (the popover keeps the strip's
  // trench-and-island look — see `index.css`), but stood on its side. There
  // is room here, so the context gets its own line under the name instead of
  // competing with it for width, and the strip-only affordances (tooltip,
  // context menu — both would portal *outside* the popover, whose own
  // pointerdown-outside handler then closes it under them) are left off.
  // Closing stays available inline.
  if (inOverflow) {
    return (
      <div
        className={cn(
          "group/tab flex w-full items-center gap-2.5 py-1.5 pl-2.5 pr-1.5 text-xs",
          isActive ? "text-foreground" : "text-foreground/90",
        )}
        // No middle-click-to-close here, unlike the strip: dockview only
        // dismisses the popover on a primary click, so a middle click would
        // close the tab and leave its dead row behind.
      >
        {driver && <DriverBadge driver={driver} />}
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="flex min-w-0 items-center gap-1.5">
            {isPinned && (
              <Pin className="h-3 w-3 shrink-0 -rotate-45 text-brand" />
            )}
            {tabColor && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: tabColor }}
              />
            )}
            <span
              ref={rowNameFade.ref}
              className={cn(
                "overflow-hidden whitespace-nowrap",
                isActive && "font-medium",
                rowNameFade.clipped && "fade-tail",
              )}
            >
              {leaf}
            </span>
          </span>
          <span
            ref={rowContextFade.ref}
            className={cn(
              "overflow-hidden whitespace-nowrap text-2xs text-muted-foreground/70",
              rowContextFade.clipped && "fade-tail",
            )}
          >
            {connName}
          </span>
        </span>
        {closeButton}
      </div>
    );
  }

  return (
    <ContextMenu>
      <SimpleTooltip label={tooltip} side="bottom" delayDuration={300}>
        <ContextMenuTrigger asChild>
          <div
            ref={tabRef}
            className={cn(
              // `max-w` is what makes the priority truncation below actually fire:
              // a `.dv-tab` is a non-shrinking flex item in a scrolling strip, so
              // without an explicit ceiling the tab just grows and nothing inside
              // it ever has to give way.
              "group/tab flex h-full min-w-0 max-w-[19rem] items-center gap-2 px-3 text-xs",
              // The active tab already carries a bg-background surface + a 2px brand
              // top cap from index.css (`.inner-dock .dv-active-tab`); here we add the
              // matching weight so the label reads as the active one too.
              isActive
                ? "font-medium text-foreground"
                : "text-muted-foreground/75",
            )}
            style={
              tabColor
                ? { boxShadow: accentBoxShadow(tabAccentStyle, tabColor) }
                : undefined
            }
            // Middle-click (wheel button) closes the tab, matching editor
            // conventions. `mousedown` preventDefault suppresses the browser's
            // middle-click autoscroll affordance.
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestClose();
              }
            }}
          >
            {driver && <DriverBadge driver={driver} />}
            {isPinned && (
              <Pin className="h-3 w-3 shrink-0 -rotate-45 text-brand" />
            )}
            {/*
             * Two-part label with an explicit space priority: the connection
             * context is the disposable half (it repeats across every tab of that
             * connection, and the driver badge already anchors it), the name is
             * the half that tells two tabs apart, so the context is weighted to
             * shrink several times faster and both carry a floor so neither
             * collapses to a bare ellipsis. A hairline divider — not another "·" —
             * separates them: `schema.table` is full of dots already, and one more
             * read as part of the name.
             */}
            <span className="flex min-w-0 items-center gap-1.5">
              {context && (
                <>
                  <span
                    ref={contextFade.ref}
                    className={cn(
                      "min-w-[2.5rem] max-w-[8.5rem] shrink-[6] overflow-hidden whitespace-nowrap text-2xs text-muted-foreground/70",
                      contextFade.clipped && "fade-tail",
                    )}
                  >
                    {context}
                  </span>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
                </>
              )}
              <span
                ref={nameFade.ref}
                className={cn(
                  "min-w-[4rem] shrink overflow-hidden whitespace-nowrap",
                  nameFade.clipped && "fade-tail",
                )}
              >
                {leaf}
              </span>
            </span>
            {/*
             * No explicit action menu here anymore — every action below (split,
             * float, colour, close variants) lives in the right-click context menu
             * on this same tab (see `ContextMenuContent` below). Drag-to-split
             * still works natively.
             */}
            {closeButton}
          </div>
        </ContextMenuTrigger>
      </SimpleTooltip>
      <ContextMenuContent className="text-xs">
        <ContextMenuItem onSelect={togglePin}>
          {isPinned ? (
            <PinOff className="mr-2 h-3.5 w-3.5" />
          ) : (
            <Pin className="mr-2 h-3.5 w-3.5" />
          )}
          {isPinned ? t("tabs.unpin") : t("tabs.pin")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            props.api.moveTo({ group: props.api.group, position: "right" })
          }
        >
          {t("tabs.splitRight")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            props.api.moveTo({ group: props.api.group, position: "bottom" })
          }
        >
          {t("tabs.splitDown")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={detachToWindow}>
          {t("tabs.floatPanel")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="mb-1 text-3xs uppercase tracking-wider text-muted-foreground">
            {t("tabs.color")}
          </div>
          <div className="flex items-center gap-1">
            {TAB_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-110",
                  tabColor === c &&
                    "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
                )}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
            <button
              type="button"
              onClick={() => setColor(null)}
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full border border-border/50 text-muted-foreground hover:bg-accent",
                !tabColor &&
                  "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
              )}
              title={t("tabs.colorNone")}
            >
              <X className="h-2.5 w-2.5" />
            </button>
            <input
              type="color"
              value={tabColor ?? "#888888"}
              onChange={(e) => setColor(e.target.value)}
              className="h-4 w-6 cursor-pointer rounded-sm border border-border/50 bg-transparent p-0"
              title={t("tabs.colorCustom")}
            />
          </div>
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={requestClose}>
          {t("tabs.closeTab")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={closeOthers}>
          {t("tabs.closeOthers")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={closeToRight}>
          {t("tabs.closeToRight")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasOthersInConnection}
          onSelect={closeOthersInConnection}
        >
          {t("tabs.closeOthersInConnection")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={closeAll}>
          {t("tabs.closeAll")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Per-group right-slot action: the "+" that opens a fresh query tab on the
 *  selected connection.
 *
 *  It used to be preceded by a "⊞ N" button opening the modal tab switcher.
 *  That was a second, heavier way to answer the question dockview's own "∨ N"
 *  overflow popover — two pixels to its left — already answers by listing the
 *  tabs that don't fit, so the button is gone. The dialog itself stays: its
 *  keyboard route (Ctrl/Cmd+P, rebindable) is the only surface that searches
 *  *every* open tab by name, which the overflow list can't do. */
