/**
 * The right-click menu of the grid's blank space (#267): the empty result's
 * `EmptyState`, and whatever of the scroll area no row covers.
 *
 * Every row has its own menu, so before this a table with no rows — empty, or
 * emptied by a filter — had no right-click at all, and the one way to add its
 * first row was the toolbar button. This menu offers the table-level actions
 * that make sense with nothing selected: insert a row, the other ways to add
 * data (`insertAlternatives` — Paste rows as JSON… on SQL), and reload.
 *
 * It reuses the row menu's callbacks and labels rather than owning any logic:
 * `onInsertRow` is the same function the row menu's *Insert row…* calls, and a
 * blocked insert shows the same reason the toolbar's disabled button does.
 *
 * The trigger wraps the whole scroll area, but only opens on blank space. A
 * row's own trigger already claims its right-click (Radix marks the event as
 * handled, and this one then stands down), and anything else that is not blank
 * — the header, the draft row's inputs — is declined here, so the menu never
 * appears over something it is not about.
 */

import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw } from "lucide-react";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { InsertAlternative } from "@/components/grid/GridToolbar";

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

interface GridBlankMenuProps {
  /** The scroll area. Must accept a ref and event handlers (`asChild`). */
  children: ReactNode;
  onInsertRow?: () => void;
  /** Why an insert cannot begin, when `onInsertRow` is absent. */
  insertBlocked?: string | null;
  insertAlternatives?: InsertAlternative[];
  onReload?: () => void;
}

export function GridBlankMenu({
  children,
  onInsertRow,
  insertBlocked,
  insertAlternatives,
  onReload,
}: GridBlankMenuProps) {
  const { t } = useTranslation();
  const canInsert = !!onInsertRow;
  const offersInsert = canInsert || !!insertBlocked;
  // A query-result grid has none of these, and keeps no menu at all.
  if (!offersInsert && !onReload) return <>{children}</>;

  const declineUnlessBlank = (e: MouseEvent<HTMLElement>) => {
    if (!isBlankTarget(e.target as Element, e.currentTarget)) {
      // Radix opens only on an event nobody has handled yet.
      e.preventDefault();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={declineUnlessBlank}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {offersInsert && (
          <ContextMenuAction
            icon={Plus}
            label={t("dataGrid.ctxInsertRow")}
            onSelect={() => onInsertRow?.()}
            locked={canInsert ? null : insertBlocked}
          />
        )}
        {canInsert &&
          (insertAlternatives ?? []).map((a) => (
            <ContextMenuAction
              key={a.id}
              icon={a.icon}
              label={a.label}
              onSelect={a.onSelect}
            />
          ))}
        {onReload && (
          <>
            {offersInsert && <ContextMenuSeparator />}
            <ContextMenuAction
              icon={RefreshCw}
              label={t("dataGrid.ctxReload")}
              onSelect={onReload}
            />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
