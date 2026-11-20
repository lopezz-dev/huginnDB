/**
 * A workspace tab's context menu, as a description (`MenuSpec`, ADR #143).
 *
 * Split out of `WorkspaceTab`, where it was a hand-built list of
 * `ContextMenuItem`s with one icon among nine. `WorkspaceTab` knows the tab and
 * hands over what it is and what can be done to it; order, headings and colour
 * are `ContextActionMenu`'s. Runs only while the menu is open.
 */

import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import {
  AppWindow,
  ArrowRightToLine,
  Columns2,
  CopyX,
  ListX,
  Pin,
  PinOff,
  Rows2,
  SquareX,
  X,
} from "lucide-react";

import type { MenuSpec } from "@/lib/menu/menuSpec";

/** What the menu can do to its tab. Every one acts on *this* tab — the one
 *  right-clicked — never on whichever happens to be active. */
export interface TabMenuActions {
  togglePin: () => void;
  splitRight: () => void;
  splitDown: () => void;
  float: () => void;
  close: () => void;
  closeOthers: () => void;
  closeToRight: () => void;
  closeOthersInConnection: () => void;
  closeAll: () => void;
}

export interface TabMenuContext {
  t: TFunction;
  /** The tab's full name (`schema.table`, or the query's title). */
  title: string;
  /**
   * Whether it is the active tab when the menu opens. `togglePinTab` and
   * `closeTab` act on the active tab (`App.tsx`), so their keys describe this
   * menu's items only when this is that tab.
   */
  isActive: boolean;
  isPinned: boolean;
  /** Any other tab is open (gates "close others" and "close to the right"). */
  hasOthers: boolean;
  /** Another tab of this tab's connection is open. */
  hasOthersInConnection: boolean;
  /** The colour swatches: not an action, so a `custom` entry in `edit`. */
  renderColor: () => ReactNode;
  actions: TabMenuActions;
}

export function tabMenu(ctx: TabMenuContext): MenuSpec {
  const { t, actions: a } = ctx;
  return {
    // The title alone. The connection was its tag, but a header tag does not
    // shrink (`ContextMenuHeader`), so a long connection name pushed the title
    // out of the menu entirely; the tab's tooltip already names it.
    header: { title: ctx.title },
    entries: [
      { id: "color", section: "edit", kind: "custom", render: ctx.renderColor },
      {
        id: "pin",
        section: "session",
        icon: ctx.isPinned ? PinOff : Pin,
        label: ctx.isPinned ? t("tabs.unpin") : t("tabs.pin"),
        shortcut: ctx.isActive ? { action: "togglePinTab" } : undefined,
        onSelect: a.togglePin,
      },
      {
        id: "splitRight",
        section: "session",
        icon: Columns2,
        label: t("tabs.splitRight"),
        onSelect: a.splitRight,
      },
      {
        id: "splitDown",
        section: "session",
        icon: Rows2,
        label: t("tabs.splitDown"),
        onSelect: a.splitDown,
      },
      {
        id: "float",
        section: "session",
        icon: AppWindow,
        label: t("tabs.floatPanel"),
        onSelect: a.float,
      },
      // Closing destroys nothing — a pinned tab or one with unsaved changes
      // has its own guard — so these are `session`, not `danger` (Alex,
      // 19-11-2026).
      {
        id: "close",
        section: "session",
        icon: X,
        label: t("tabs.closeTab"),
        shortcut: ctx.isActive ? { action: "closeTab" } : undefined,
        onSelect: a.close,
      },
      {
        id: "closeOthers",
        section: "session",
        icon: CopyX,
        label: t("tabs.closeOthers"),
        disabled: !ctx.hasOthers,
        onSelect: a.closeOthers,
      },
      {
        id: "closeToRight",
        section: "session",
        icon: ArrowRightToLine,
        label: t("tabs.closeToRight"),
        disabled: !ctx.hasOthers,
        onSelect: a.closeToRight,
      },
      {
        id: "closeOthersInConnection",
        section: "session",
        icon: ListX,
        label: t("tabs.closeOthersInConnection"),
        disabled: !ctx.hasOthersInConnection,
        onSelect: a.closeOthersInConnection,
      },
      {
        id: "closeAll",
        section: "session",
        icon: SquareX,
        label: t("tabs.closeAll"),
        // Means the same wherever it is pressed.
        shortcut: { action: "closeAllTabs" },
        onSelect: a.closeAll,
      },
    ],
  };
}
