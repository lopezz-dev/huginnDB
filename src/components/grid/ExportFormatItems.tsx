/**
 * The export formats of a grid's "Export data ▾" menu, one item each (ADR
 * #138). Both grids render these — a query's result (`useResultExportItem`)
 * and a table's rows (`TableDataTab`) — so a format is named the same way in
 * both, and a new one is added here once. Which formats a grid offers, and
 * what choosing one does, stay with the grid: this is the labels and the
 * items, nothing else.
 */

import { useTranslation } from "react-i18next";
import { DropdownMenuItem } from "@/components/ui/dropdown";
import type { ResultExportFormat } from "@/types";

/** Each format's menu label: the two CSVs say which delimiter they use. */
export function exportFormatLabel(
  format: ResultExportFormat,
  t: (key: string) => string,
): string {
  switch (format) {
    case "csv":
      return t("query.export.csvComma");
    case "csvSemicolon":
      return t("query.export.csvSemicolon");
    case "xlsx":
      return "Excel (.xlsx)";
    case "json":
      return "JSON";
    case "sql":
      return "SQL INSERT";
  }
}

export interface ExportFormatItemsProps {
  formats: readonly ResultExportFormat[];
  onSelect: (format: ResultExportFormat) => void;
  /** Distinguishes two groups of the same formats in one menu. */
  keyPrefix?: string;
  title?: string;
}

export function ExportFormatItems({
  formats,
  onSelect,
  keyPrefix = "",
  title,
}: ExportFormatItemsProps) {
  const { t } = useTranslation();
  return (
    <>
      {formats.map((f) => (
        <DropdownMenuItem
          key={`${keyPrefix}${f}`}
          title={title}
          onSelect={() => onSelect(f)}
        >
          {exportFormatLabel(f, t)}
        </DropdownMenuItem>
      ))}
    </>
  );
}
