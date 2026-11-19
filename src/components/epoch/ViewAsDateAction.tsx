/**
 * "View as date" — the context-menu entry that hands a timestamp cell to the
 * Dates panel. Shared by the table grid and the document view so both decide
 * the same way when to show it: `detectEpoch` on the value alone, nothing
 * about the column's name or type (see `lib/epoch/epoch.ts`).
 *
 * `viewAsDateEntry` is the menu entry as data, for a menu described with
 * `MenuSpec` (ADR #143); `null` when the value is not a plausible timestamp.
 * `ViewAsDateAction` draws the same entry for a menu still written in JSX
 * (the document view, until it moves to `ContextActionMenu`).
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CalendarClock } from "lucide-react";
import { ContextMenuAction } from "@/components/ui/context-menu";
import { detectEpoch, shortDate } from "@/lib/epoch/epoch";
import { formatValue } from "@/lib/grid/formatValue";
import type { MenuAction } from "@/lib/menu/menuSpec";
import { useEpochPanel, type EpochSource } from "@/stores/session/epoch";
import type { CellValue } from "@/types";

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

export function ViewAsDateAction({
  value,
  source,
}: {
  value: unknown;
  source: EpochSource;
}) {
  const { t, i18n } = useTranslation();
  const entry = viewAsDateEntry(value, source, t, i18n.language);
  if (!entry) return null;
  return (
    <ContextMenuAction
      icon={entry.icon}
      label={entry.label}
      detail={entry.detail}
      onSelect={entry.onSelect}
    />
  );
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
