/**
 * The grid's two context menus, as descriptions (`MenuSpec`, ADR #143): the
 * menu of one cell, and the menu of a multi-row selection.
 *
 * Split out of `GridRow`, where they were 330 lines of JSX inside the cell
 * loop. `GridRow` decides *which* one a right-click gets and hands over what
 * the row knows; everything about order, headings and colour is
 * `ContextActionMenu`'s. Both functions run only while a menu is open.
 */

import type { TFunction } from "i18next";
import {
  ArrowRightCircle,
  ClipboardCopy,
  Copy,
  CopyPlus,
  Eraser,
  Filter,
  FilterX,
  PanelRight,
  Plus,
  Trash2,
} from "lucide-react";

import type { GridRowCallbacks } from "@/components/grid/GridRow";
import { rowLabel, viewAsDateEntry } from "@/components/epoch/ViewAsDateAction";
import {
  sqlLiteral,
  toJson as rowToJson,
  toSqlInsert as rowToSqlInsert,
  toSqlUpdate as rowToSqlUpdate,
  type SqlTarget,
} from "@/lib/grid/copyFormats";
import { formatValue } from "@/lib/grid/formatValue";
import type { MenuSpec } from "@/lib/menu/menuSpec";
import type { CellValue, ColumnFilter, ColumnMeta, Driver } from "@/types";

/** The grid-wide facts and callbacks both menus draw from — what `GridRow`
 *  receives as props, unchanged. Each is optional exactly where the grid
 *  offers the gesture only sometimes, and an absent one removes its item. */
export interface GridMenuContext {
  t: TFunction;
  language: string;
  callbacks: Pick<
    GridRowCallbacks,
    | "copyToClipboard"
    | "copyRows"
    | "openSidePanelEditor"
    | "selectedColumnValues"
    | "withFullRow"
    | "isTrimmedCell"
  >;
  resultColumns: ColumnMeta[];
  columnIndexByName: Map<string, number>;
  driver?: Driver;
  tableName?: string;
  sqlTarget?: SqlTarget;
  pkColumnNames?: string[];
  editable?: boolean;
  columnLock?: (column: string) => string | null;
  onCellSave?: (rowValues: CellValue[], columnName: string, value: string | null) => Promise<void>;
  onNavigateFk?: (columnName: string, value: CellValue) => void;
  onAddFilter?: (f: ColumnFilter) => void;
  onInsertRow?: () => void;
  onDuplicateRow?: (rowValues: CellValue[]) => void;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  onBulkDelete?: (rows: CellValue[][]) => void;
}

/** The cell the menu opened on. */
export interface MenuCell {
  rowValues: CellValue[];
  /** Index into `resultColumns` and `rowValues`. */
  colIdx: number;
  meta: ColumnMeta;
  value: CellValue;
  /** Whether the column is a foreign key the grid can follow. */
  isFkCell: boolean;
}

/** The menu of one cell. */
export function cellMenu(ctx: GridMenuContext, cell: MenuCell): MenuSpec {
  const { t, callbacks: cb } = ctx;
  const { rowValues, colIdx, meta, value } = cell;
  // A cell the page left on the server holds a stand-in `null`, not a NULL.
  const trimmed = cb.isTrimmedCell(rowValues, meta.name);
  const copyFromRow = (render: (row: CellValue[]) => string) => () =>
    cb.withFullRow(rowValues, (r) => cb.copyToClipboard(render(r)));
  const { onAddFilter, onCellSave } = ctx;

  return {
    header: {
      title: meta.name,
      tags: [meta.data_type, value === null && !trimmed && "NULL"],
    },
    entries: [
      cell.isFkCell &&
        value !== null &&
        value !== undefined && {
          id: "goToReference",
          section: "navigate",
          icon: ArrowRightCircle,
          label: t("dataGrid.ctxGoToReference"),
          onSelect: () => ctx.onNavigateFk?.(meta.name, value),
        },
      {
        id: "copy",
        section: "copy",
        icon: Copy,
        label: t("dataGrid.ctxCopy"),
        shortcut: { fixed: "copyCell" },
        onSelect: copyFromRow((r) => formatValue(r[colIdx])),
      },
      {
        id: "copyWithColumn",
        section: "copy",
        icon: ClipboardCopy,
        label: t("dataGrid.ctxCopyWithColumn"),
        onSelect: copyFromRow((r) => `${meta.name} = ${sqlLiteral(r[colIdx], ctx.driver)}`),
      },
      // Row-level formatters: the less frequent "I want the whole row" cases,
      // kept off the top level.
      {
        id: "copyRowAs",
        section: "copy",
        kind: "submenu",
        icon: Copy,
        label: t("dataGrid.ctxCopyRowAs"),
        items: [
          {
            id: "json",
            label: "JSON",
            onSelect: copyFromRow((r) => rowToJson(r, ctx.resultColumns)),
          },
          {
            id: "insert",
            label: "SQL INSERT",
            onSelect: copyFromRow((r) =>
              rowToSqlInsert(r, ctx.resultColumns, ctx.driver, ctx.sqlTarget),
            ),
          },
          {
            id: "update",
            label: "SQL UPDATE",
            onSelect: copyFromRow((r) =>
              rowToSqlUpdate(r, ctx.resultColumns, ctx.driver, ctx.sqlTarget, ctx.pkColumnNames),
            ),
          },
        ],
      },
      {
        id: "sideEditor",
        section: "view",
        icon: PanelRight,
        label: t("dataGrid.openInSideEditor"),
        onSelect: () => cb.openSidePanelEditor(rowValues, meta, formatValue(value)),
      },
      viewAsDateEntry(
        value,
        {
          relation: ctx.tableName,
          column: meta.name,
          driver: ctx.driver,
          row: rowLabel(rowValues, ctx.pkColumnNames, ctx.columnIndexByName),
        },
        t,
        ctx.language,
      ),
      onAddFilter && {
        id: "filterBy",
        section: "filter",
        icon: Filter,
        // Filtering by a value the page never received would filter by its
        // stand-in `null`.
        disabled: trimmed,
        label: t("dataGrid.ctxFilterBy"),
        onSelect: () =>
          onAddFilter(
            value === null
              ? { column: meta.name, op: "is_null" }
              : { column: meta.name, op: "eq", value },
          ),
      },
      onAddFilter && {
        id: "filterExcluding",
        section: "filter",
        icon: FilterX,
        disabled: trimmed,
        label: t("dataGrid.ctxFilterExcluding"),
        onSelect: () =>
          onAddFilter(
            value === null
              ? { column: meta.name, op: "is_not_null" }
              : { column: meta.name, op: "ne", value },
          ),
      },
      ctx.onInsertRow && {
        id: "insertRow",
        section: "create",
        icon: Plus,
        label: t("dataGrid.ctxInsertRow"),
        onSelect: ctx.onInsertRow,
      },
      ctx.onDuplicateRow && {
        id: "duplicateRow",
        section: "create",
        icon: CopyPlus,
        label: t("dataGrid.ctxDuplicateRow"),
        onSelect: () => ctx.onDuplicateRow?.(rowValues),
      },
      ctx.editable &&
        onCellSave && {
          id: "setNull",
          section: "edit",
          icon: Eraser,
          disabled: value === null && !trimmed,
          locked: ctx.columnLock?.(meta.name) ?? null,
          label: t("cellEditor.setNull"),
          // The rejection is already reported by `DataGrid`'s save seam (which
          // notifies and rethrows); swallowing it here only keeps the
          // unhandled-rejection warning out of the console.
          onSelect: () => void onCellSave(rowValues, meta.name, null).catch(() => {}),
        },
      ctx.onDeleteRow && {
        id: "deleteRow",
        section: "danger",
        icon: Trash2,
        label: t("dataGrid.ctxDeleteRow"),
        onSelect: () => ctx.onDeleteRow?.(rowValues),
      },
    ],
  };
}

/**
 * The menu of a multi-row selection, opened on a cell of one of its rows:
 * selection-wide copy, filter by the column's selected values, delete.
 * `selectedRows` is read by the caller at the moment the menu opens.
 */
export function selectionMenu(
  ctx: GridMenuContext,
  cell: Pick<MenuCell, "colIdx" | "meta">,
  selectedRows: CellValue[][],
): MenuSpec {
  const { t, callbacks: cb, onAddFilter, onBulkDelete } = ctx;
  const { colIdx, meta } = cell;
  const count = selectedRows.length;
  const anyTrimmed = selectedRows.some((r) => cb.isTrimmedCell(r, meta.name));
  const column = () => cb.selectedColumnValues(colIdx);
  return {
    header: { title: t("dataGrid.ctxRowsSelected", { count }) },
    entries: [
      {
        id: "copyRowsAs",
        section: "copy",
        kind: "submenu",
        icon: Copy,
        label: t("dataGrid.ctxCopyRowsAs", { count }),
        items: [
          { id: "json", label: "JSON", onSelect: () => cb.copyRows(selectedRows, "json") },
          { id: "insert", label: "SQL INSERT", onSelect: () => cb.copyRows(selectedRows, "insert") },
          { id: "update", label: "SQL UPDATE", onSelect: () => cb.copyRows(selectedRows, "update") },
        ],
      },
      onAddFilter && {
        id: "filterIn",
        section: "filter",
        icon: Filter,
        disabled: anyTrimmed,
        label: t("dataGrid.ctxFilterInSelected", { column: meta.name, count: column().distinct }),
        onSelect: () => onAddFilter({ column: meta.name, op: "in", values: column().values }),
      },
      onAddFilter && {
        id: "filterNotIn",
        section: "filter",
        icon: FilterX,
        disabled: anyTrimmed,
        label: t("dataGrid.ctxFilterNotInSelected", {
          column: meta.name,
          count: column().distinct,
        }),
        onSelect: () => onAddFilter({ column: meta.name, op: "not_in", values: column().values }),
      },
      onBulkDelete && {
        id: "deleteRows",
        section: "danger",
        icon: Trash2,
        label: t("dataGrid.ctxDeleteRows", { count }),
        onSelect: () => onBulkDelete(selectedRows),
      },
    ],
  };
}
