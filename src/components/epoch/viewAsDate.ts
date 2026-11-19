/**
 * "View as date" — the context-menu entry that hands a timestamp value to the
 * Dates panel, as data for a menu described with `MenuSpec` (ADR #143).
 * Shared by the table grid's cell menu and the document view's field menu so
 * both decide the same way when to offer it: `detectEpoch` on the value alone,
 * nothing about the column's name or type (see `lib/epoch/epoch.ts`).
 *
 * This was `ViewAsDateAction.tsx`, which also drew the entry as a component
 * for the menus still written in JSX; with the field menu moved to
 * `ContextActionMenu` no menu draws its own entries any more, and the file
 * holds only data.
 */

import type { TFunction } from "i18next";
import { CalendarClock } from "lucide-react";
import { detectEpoch, shortDate } from "@/lib/epoch/epoch";
import { formatValue } from "@/lib/grid/formatValue";
import type { MenuAction } from "@/lib/menu/menuSpec";
import { useEpochPanel, type EpochSource } from "@/stores/session/epoch";
import type { CellValue } from "@/types";

/** The entry, or `null` when the value is not a plausible timestamp. */
export function viewAsDateEntry(
  value: unknown,
  source: EpochSource,
  t: TFunction,
  language: string,
): MenuAction | null {
  const detected = detectEpoch(value);
  if (!detected) return null;
  return {
    id: "viewAsDate",
    section: "view",
    icon: CalendarClock,
    label: t("dataGrid.ctxViewAsDate"),
    // The date itself, so a glance at the menu is often all it takes.
    detail: shortDate(detected.millis, language),
    onSelect: () =>
      useEpochPanel.getState().openFromCell(detected.digits, source, detected.approximate),
  };
}

/** `id 48211` for a row with a single-column primary key; nothing otherwise —
 *  a composite key would make the label longer than it is useful. */
export function rowLabel(
  rowValues: CellValue[],
  pkColumnNames: string[] | undefined,
  columnIndexByName: Map<string, number>,
): string | undefined {
  if (!pkColumnNames || pkColumnNames.length !== 1) return undefined;
  const pk = pkColumnNames[0];
  const idx = columnIndexByName.get(pk);
  if (idx === undefined) return undefined;
  const v = rowValues[idx];
  return v === null || v === undefined ? undefined : `${pk} ${formatValue(v)}`;
}
