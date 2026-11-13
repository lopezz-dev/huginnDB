/**
 * "Go to referenced row" — one implementation for every grid source
 * (ADR #135): the table browse and a query's result set both navigate a
 * single-column foreign key by opening the referenced table pre-filtered to
 * the clicked value.
 *
 * What makes a column navigable is the catalog's single-column FK reference
 * (`ColumnInfo.referenced_*`); a composite FK reports none and is not offered.
 * The referenced table lives in the same connection (or database view), so
 * the caller's `connectionId` is reused. Opening a tab reads, never writes:
 * whether the person may browse the target is the tab's own policy gate.
 */

import { tableTabTitle } from "@/lib/connectionLabel";
import { useTabs } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import type { CellValue, ColumnInfo } from "@/types";

/** A column a single-column FK makes navigable. */
export type FkColumn = ColumnInfo & {
  referenced_table: string;
  referenced_column: string;
};

export function isFkColumn(c: ColumnInfo | undefined): c is FkColumn {
  return !!c?.referenced_table && !!c.referenced_column;
}

/** Open (or focus) the table `column` references, filtered to `value`. */
export function openReferencedRow(
  connectionId: string,
  column: FkColumn,
  value: CellValue,
): void {
  // Both reads are `getState()` snapshots, not subscriptions: this runs on a
  // click, and nothing here needs to re-render when they change.
  useTabs.getState().open({
    kind: "table",
    title: tableTabTitle(
      useConnections.getState().profiles,
      connectionId,
      column.referenced_table,
    ),
    connectionId,
    schema: column.referenced_schema ?? undefined,
    table: column.referenced_table,
    initialFilters: [{ column: column.referenced_column, op: "eq", value }],
  });
}
