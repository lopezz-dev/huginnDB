/**
 * The menu of the grid's blank space (#267), as a description (`MenuSpec`,
 * ADR #143): what makes sense on a table with nothing under the pointer —
 * insert a row, the other ways to add data, reload.
 *
 * `GridBlankMenu` decides *whether* a right-click gets this menu (only on
 * blank space, only on a table's grid); this module only says what is in it.
 * It owns no logic of its own: `onInsertRow` is the function the row menu's
 * Insert row calls, and a blocked insert shows the reason the toolbar's
 * disabled button shows.
 */

import type { TFunction } from "i18next";
import { Plus, RefreshCw } from "lucide-react";

import type { InsertAlternative } from "@/components/grid/GridToolbar";
import type { MenuSpec } from "@/lib/menu/menuSpec";

export interface BlankMenuContext {
  t: TFunction;
  /** The table the grid shows: the menu's subject. */
  tableName: string;
  onInsertRow?: () => void;
  /** Why an insert cannot begin, when `onInsertRow` is absent. */
  insertBlocked?: string | null;
  insertAlternatives?: readonly InsertAlternative[];
  onReload?: () => void;
}

/** Whether the blank space has anything to offer; a grid where it has not
 *  keeps no menu at all. */
export function blankMenuOffers(ctx: Omit<BlankMenuContext, "t" | "tableName">): boolean {
  return !!ctx.onInsertRow || !!ctx.insertBlocked || !!ctx.onReload;
}

export function blankMenu(ctx: BlankMenuContext): MenuSpec {
  const { t, onInsertRow, insertBlocked, onReload } = ctx;
  return {
    header: { title: ctx.tableName },
    entries: [
      // A blocked insert is still offered, locked with its reason: the
      // right-click is where someone looks for it, and the reason is the
      // answer to "why can't I".
      (!!onInsertRow || !!insertBlocked) && {
        id: "insertRow",
        section: "create",
        icon: Plus,
        label: t("dataGrid.ctxInsertRow"),
        locked: onInsertRow ? null : insertBlocked,
        onSelect: () => onInsertRow?.(),
      },
      // The alternatives are other ways to insert, so they go when it does.
      ...(onInsertRow
        ? (ctx.insertAlternatives ?? []).map((a) => ({
            id: `alt:${a.id}`,
            section: "create" as const,
            icon: a.icon,
            label: a.label,
            onSelect: a.onSelect,
          }))
        : []),
      onReload && {
        id: "reload",
        section: "view",
        icon: RefreshCw,
        label: t("dataGrid.ctxReload"),
        // F5 is `refreshActiveData`, which reloads the *active* table tab
        // through `lib/grid/tableRefresh` — the same `reloadAll` that
        // `TableDataTab`, the one grid that passes `onReload`, hands here.
        // The right-click focuses the grid's scroll area (`tabIndex=0`), and
        // dockview activates the group that takes focus, so by the time the
        // key could be pressed this grid's tab is the active one, split view
        // included.
        shortcut: { action: "refreshData" },
        onSelect: onReload,
      },
    ],
  };
}
