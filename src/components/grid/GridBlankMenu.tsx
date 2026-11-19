/**
 * The right-click menu of the grid's blank space (#267): the empty result's
 * `EmptyState`, and whatever of the scroll area no row covers.
 *
 * Every row has its own menu, so before this a table with no rows — empty, or
 * emptied by a filter — had no right-click at all, and the one way to add its
 * first row was the toolbar button. What the menu holds is described in
 * `blankMenu.ts` and drawn by `ContextActionMenu` (ADR #143); this component
 * decides only *where* it opens.
 *
 * The trigger wraps the whole scroll area, but only opens on blank space. A
 * row's own trigger already claims its right-click (Radix marks the event as
 * handled, and this one then stands down), and anything else that is not blank
 * — the header, the draft row's inputs — is declined here, so the menu never
 * appears over something it is not about.
 */

import { useTranslation } from "react-i18next";
import type { MouseEvent, ReactElement } from "react";

import { ContextActionMenu } from "@/components/menus/ContextActionMenu";
import { blankMenu, blankMenuOffers, type BlankMenuContext } from "@/components/grid/blankMenu";

/** Marks an element whose right-click counts as blank space. */
export const GRID_BLANK_ATTR = "data-grid-blank";

/**
 * True when a right-click on `target` landed on blank space inside
 * `container`: the container itself (below or beside a short table), the bare
 * table structure around the rows, or anything marked `GRID_BLANK_ATTR`.
 */
export function isBlankTarget(target: Element, container: Element): boolean {
  if (target === container) return true;
  if (target.closest(`[${GRID_BLANK_ATTR}]`)) return true;
  return target.tagName === "TABLE" || target.tagName === "TBODY";
}

/** Radix opens only on an event nobody has handled yet, so declining is
 *  `preventDefault`. */
function declineUnlessBlank(e: MouseEvent<HTMLElement>) {
  if (!isBlankTarget(e.target as Element, e.currentTarget)) e.preventDefault();
}

type GridBlankMenuProps = Omit<BlankMenuContext, "t" | "tableName"> & {
  /** The table the grid shows. Without one there is no subject for the menu
   *  — a query result, a preview — and the grid keeps no blank-space menu. */
  tableName: string | undefined;
  /** The scroll area. Must forward its ref and spread its props (`asChild`). */
  children: ReactElement;
};

export function GridBlankMenu({ children, tableName, ...ctx }: GridBlankMenuProps) {
  const { t } = useTranslation();
  if (tableName === undefined || !blankMenuOffers(ctx)) return children;
  return (
    <ContextActionMenu
      width="sm"
      onContextMenu={declineUnlessBlank}
      menu={() => blankMenu({ ...ctx, t, tableName })}
    >
      {children}
    </ContextActionMenu>
  );
}
