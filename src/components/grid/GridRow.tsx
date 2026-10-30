/**
 * One `<tr>` of the data grid, and the two prop shapes that make its
 * memoization work.
 *
 * Split out of `DataGrid`, where it was 650 of 3590 lines. Nothing about the
 * memo contract changed, and that contract is the whole reason this component
 * exists — see the comment on `GridRow` itself. Two rules survive the move and
 * must survive the next one:
 *
 * - **Identity comes from `rowValues`, never a display index** (ADR #7).
 *   TanStack's `row.index` is the *filtered* index while the parent
 *   resolves primary keys against the unfiltered backend page, and the two
 *   diverge the moment a client filter is non-trivial.
 * - **`callbacksRef` is a ref on purpose.** `DataGrid`'s local helpers are
 *   plain function declarations recreated on every render — including the very
 *   clicks this memo exists to make cheap — so passing them as props would hand
 *   every row a changed prop every time and defeat the memo outright.
 */

import { memo } from "react";
import { useTranslation } from "react-i18next";
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
import { flexRender, type Row } from "@tanstack/react-table";

import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  toJson as rowToJson,
  toSqlInsert as rowToSqlInsert,
  toSqlUpdate as rowToSqlUpdate,
  sqlLiteral,
} from "@/lib/grid/copyFormats";
import { formatValue } from "@/lib/grid/formatValue";
import { GRID_GUTTER_WIDTH } from "@/lib/grid/useColumnSizing";
import { cn } from "@/lib/utils";
import { isSideEditorOpen } from "@/stores/session/panelLayout";
import type {
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ColumnMeta,
  Driver,
} from "@/types";
import type { SelectedCell } from "@/components/grid/DataGrid";
import type { FkEdit } from "@/lib/grid/useCellEditing";

/** Stable, ref-delivered slice of `DataGrid`'s own local helper functions —
 *  see the long comment on `GridRow` below for why these can't just be
 *  passed as ordinary props. */
export interface GridRowCallbacks {
  openCellEdit: (rowValues: CellValue[], column: ColumnMeta) => void;
  openSidePanelEditor: (
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) => void;
  copyToClipboard: (text: string) => void;
  bulkCopy: (rows: CellValue[][], fmt: "json" | "insert" | "update") => string;
  /** Copy several rows *and* say how many — see `DataGrid`'s definition. */
  copyRows: (
    rows: CellValue[][],
    fmt: "json" | "insert" | "update",
  ) => void;
  selectedColumnValues: (colIndex: number) => {
    values: CellValue[];
    distinct: number;
  };
  /** The multi-selection as values arrays. Read when a context menu opens
   *  (see `MenuBody`), never during the row's render: as a prop it was a new
   *  array on every selection change and repainted every row for a value
   *  only an open menu reads. */
  selectedRows: () => CellValue[][];
  applyRowSelectionClick: (rowKey: string | null, e: React.MouseEvent) => void;
  toggleRowKey: (key: string) => void;
}

/**
 * Runs `children` when it renders rather than when `GridRow` does. Radix
 * mounts a context menu's content only while it is open, so whatever the
 * function reads through `callbacksRef` is the state at the moment the menu
 * opens — which is what lets the menu show the current multi-selection
 * without that selection being a prop of every row.
 */
function MenuBody({ children }: { children: () => React.ReactNode }) {
  return <>{children()}</>;
}

/** Shape of the inline single-cell editor state, narrowed to "does this
 *  belong to THIS row" before it reaches `GridRow` — see below. */
export interface InlineEditState {
  rowValues: CellValue[];
  column: ColumnMeta;
  value: string | null;
  original: string | null;
}

interface GridRowProps {
  row: Row<CellValue[]>;
  rowIndex: number;
  /** What the gutter shows: absolute across pages, display only — see
   *  `rowNumber` in `lib/grid/pagination.ts`. Never identity (ADR #7). */
  rowNumber: number;
  isSelected: boolean;
  isMultiSelected: boolean;
  rowKey: string | null;
  /** This row's column index for the keyboard-active cell, or `null` when
   *  the active cell belongs to a different row entirely. */
  activeColIdx: number | null;
  /** Backend index of the column that just saved in this row, or `null`. Fed
   *  the same way `activeColIdx` is — see `useSavedCellFlash`. */
  flashedColIdx: number | null;
  /** The inline-edit state, but only when it belongs to this row's
   *  `rowValues` — `null` otherwise. Narrowing this in the parent (rather
   *  than passing the raw `inlineEdit` state) is what lets every row EXCEPT
   *  the one being edited see an unchanged (`null`) prop. */
  inlineEditHere: InlineEditState | null;
  /** Same narrowing as `inlineEditHere`, for the FK combobox's own edit
   *  state. The `cell` renderer in `useGridColumns` already reads the raw
   *  `fkEditCell` correctly via `interactiveRef`, but that only matters once
   *  React actually re-renders this row — and a double-click's second click
   *  updates only `fkEditCell` (the first click already set `activeCell`/
   *  `selectedRowIndex`/`selectedCell`), so with no prop of this row's own
   *  changing, `React.memo` used to skip the render entirely and the
   *  combobox wouldn't appear until an unrelated click on another cell/row
   *  forced a re-render some other way. Deliberately left out of the
   *  destructured params below — `React.memo`'s default shallow comparison
   *  covers the whole props object, so it only needs to exist here to do
   *  its job. */
  fkEditHere: FkEdit | null;
  selectionEnabled: boolean;
  hasSelection: boolean;
  zebraStripes: boolean;
  cellStyle: React.CSSProperties;
  /** Names of columns currently pinned (frozen) to the left edge. A new Set
   *  reference on every toggle, which is what makes `React.memo` re-render
   *  every row when the user pins/unpins a column — see `usePinnedColumns`. */
  pinnedColumnSet: ReadonlySet<string>;
  resultColumns: ColumnMeta[];
  columnIndexByName: Map<string, number>;
  columnInfoByName: Map<string, ColumnInfo>;
  driver?: Driver;
  tableName?: string;
  pkColumnNames?: string[];
  editable?: boolean;
  /** Why the policy locks a column (ADR #113); stable identity expected. */
  columnLock?: (column: string) => string | null;
  onCellSave?: (
    rowValues: CellValue[],
    columnName: string,
    value: string | null,
  ) => Promise<void>;
  onNavigateFk?: (columnName: string, value: CellValue) => void;
  onAddFilter?: (f: ColumnFilter) => void;
  onInsertRow?: () => void;
  onDuplicateRow?: (rowValues: CellValue[]) => void;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  onBulkDelete?: (rows: CellValue[][]) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  setSelectedRowIndex: (i: number) => void;
  setActiveCell: (c: { r: number; c: number }) => void;
  setSelectedCell: (c: SelectedCell | null) => void;
  callbacksRef: React.MutableRefObject<GridRowCallbacks>;
}

/**
 * One `<tr>` of the data grid, including its per-cell context menus.
 *
 * Split out of `DataGrid`'s render body and wrapped in `React.memo` because
 * every interactive grid state (`selectedRowIndex`, `activeCell`,
 * `selectedCell`, `inlineEdit`, `fkEditCell`) used to live inline in
 * `DataGrid`, so a single click re-ran the render function for the WHOLE
 * table — every visible row × every column, each cell wrapping its own
 * `<ContextMenu>` — regardless of how many rows the click actually affected.
 * The cost scales with total visible cells, which is why clicking through a
 * 15-column table felt noticeably slower than a 5-column one at the same row
 * count, even though the click only ever changes one or two rows' worth of
 * state. `GridRow` receives only state that's already been narrowed to
 * "does this concern THIS row" by the caller (below), so React's shallow
 * prop comparison lets it bail out for every row except the (at most two)
 * whose selection / active-cell / inline-edit status actually changed.
 *
 * `callbacksRef` mirrors the `interactiveRef` pattern the `columns` cell
 * definitions already use above: `openCellEdit`, `copyToClipboard`, and the
 * other locally-declared helpers are plain function declarations recreated
 * on every `DataGrid` render — including the very clicks this component
 * exists to make cheap — so passing them as ordinary props would hand every
 * row a "changed" prop every time and defeat the memoization outright.
 * Reading them through a ref that's refreshed each render (not compared by
 * `memo`) keeps `GridRow` seeing the latest closures without their identity
 * forcing a re-render. Everything else below (column metadata, `onCellSave`
 * and friends) comes from the parent tab as ordinary props instead, which
 * only actually bails this memo out because `TableDataTab` itself keeps
 * them referentially stable (`useCallback`/`useMemo`, matching the
 * dependency list `useGridColumns` — in `lib/grid/useGridColumns.tsx`, not
 * this file — already required of `onCellSave`). That used to be false for
 * `onCellSave`/`onNavigateFk`/`pkColumnNames`: `TableDataTab` rebuilt all
 * three on every render, which meant every row here re-rendered on every
 * unrelated keystroke regardless of this memo, `useGridColumns` rebuilding
 * its whole `columns` array along with it (see the "dependency array is
 * load-bearing" note there for what THAT costs). If a value passed through
 * as a plain prop here ever stops being stable at the call site, this memo
 * silently stops paying for itself — it fails open, not loud.
 */
export const GridRow = memo(function GridRow({
  row,
  rowIndex: i,
  rowNumber: displayNumber,
  isSelected,
  isMultiSelected,
  rowKey,
  activeColIdx,
  flashedColIdx,
  inlineEditHere,
  selectionEnabled,
  hasSelection,
  zebraStripes,
  cellStyle,
  pinnedColumnSet,
  resultColumns,
  columnIndexByName,
  columnInfoByName,
  driver,
  tableName,
  pkColumnNames,
  editable,
  columnLock,
  onCellSave,
  onNavigateFk,
  onAddFilter,
  onInsertRow,
  onDuplicateRow,
  onDeleteRow,
  onBulkDelete,
  scrollRef,
  setSelectedRowIndex,
  setActiveCell,
  setSelectedCell,
  callbacksRef,
}: GridRowProps) {
  const { t } = useTranslation();
  const rowValues = row.original as CellValue[];
  const stateBg = isMultiSelected
    ? "bg-brand/30"
    : isSelected
      ? "bg-brand/10"
      : zebraStripes && i % 2 === 1
        ? "bg-muted/30"
        : "bg-background";
  const showsHover = !isMultiSelected && !isSelected;
  /**
   * Solid equivalent of `stateBg`, for pinned/gutter cells only. `bg-brand/30`,
   * `bg-brand/10` and `bg-muted/30` are deliberately translucent — a subtle
   * tint over the ambient page background is the intended look for a normal
   * (non-sticky) row. A `position: sticky` cell can't use that: once the
   * browser promotes it to its own compositing layer, a translucent
   * background lets whatever's scrolling underneath show straight through —
   * not a subtle tint but the next column's text superimposed on this one's.
   * `color-mix()` bakes the same tint-over-background blend into one opaque
   * colour instead, so a pinned cell reads identically to its non-pinned
   * neighbours while still fully hiding the content behind it. Applied as an
   * inline `style.backgroundColor` (not a class) because it has to win
   * outright — no hover variant competes with it, so pinned/gutter cells
   * don't pick up the row's `hover:bg-accent` tint; that's an accepted
   * trade-off, not an oversight.
   */
  const pinnedBgColor = isMultiSelected
    ? "color-mix(in srgb, var(--brand) 30%, var(--background))"
    : isSelected
      ? "color-mix(in srgb, var(--brand) 10%, var(--background))"
      : zebraStripes && i % 2 === 1
        ? "color-mix(in srgb, var(--muted) 30%, var(--background))"
        : "var(--background)";
  // Running left offset for pinned columns' sticky `<td>`s, mirroring the
  // header's own accumulation in `DataGrid` — both start from the gutter's
  // width and walk columns in the same (display) order, so they agree
  // without needing to be computed in one shared place.
  let pinnedLeftAcc = GRID_GUTTER_WIDTH;
  return (
    <tr
      className={cn(
        "group/row",
        // A multi-selected row has to be unmistakable next to the
        // single-row cursor highlight. These used to be `bg-brand/20`
        // against `bg-brand/10` — a delta most panels render as
        // effectively identical, so Ctrl-click toggling a single row
        // looked like it had done nothing (part of #113: the
        // selection was correct, only invisible). The stronger tint
        // pairs with the inset accent bar on the gutter cell below.
        stateBg,
        showsHover && "hover:bg-accent",
      )}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedRowIndex(i);
        callbacksRef.current.applyRowSelectionClick(rowKey, e);
      }}
    >
      <td
        className={cn(
          "sticky left-0 z-[1] border-b border-border/50 border-r border-r-border/70 px-2 tabular-nums text-muted-foreground",
          // Inset accent bar marking a selected row's left edge. It
          // lives on the gutter cell rather than the `<tr>` because
          // box-shadow on a table-row box is unreliable across
          // engines, while a `<td>` is an ordinary box.
          isMultiSelected && "shadow-[inset_3px_0_0_0_var(--brand)]",
        )}
        style={{
          ...cellStyle,
          width: GRID_GUTTER_WIDTH,
          backgroundColor: pinnedBgColor,
        }}
      >
        {selectionEnabled && rowKey !== null ? (
          <>
            <Checkbox
              checked={isMultiSelected}
              onChange={() => callbacksRef.current.toggleRowKey(rowKey)}
              // Stop the row's onClick (a plain click there clears
              // the multi-selection) from firing on checkbox click.
              onClick={(e) => e.stopPropagation()}
              aria-label={t("dataGrid.selectRow")}
              className={cn(
                "align-middle",
                // Every checkbox stays visible while *any* row is
                // selected, not just the selected ones: once the
                // user is in a selecting mood the affordance for
                // extending the set shouldn't require hunting for it
                // on hover (#113 — the gesture was undiscoverable).
                isMultiSelected || hasSelection
                  ? "inline-block"
                  : "hidden group-hover/row:inline-block",
              )}
            />
            <span
              className={
                isMultiSelected || hasSelection
                  ? "hidden"
                  : "group-hover/row:hidden"
              }
            >
              {displayNumber}
            </span>
          </>
        ) : (
          displayNumber
        )}
      </td>
      {row.getVisibleCells().map((cell, cIdx) => {
        // Resolve column meta + value by *name*, not by the
        // position of the cell in `getVisibleCells()`. The
        // grid currently keeps both orders in sync, but a
        // single column hide / reorder would otherwise
        // misalign `resultColumns[colIdx]` with the actual
        // cell — see `columnIndexByName` above.
        const colName = cell.column.id;
        const backendIdx = columnIndexByName.get(colName) ?? -1;
        if (backendIdx < 0) return null;
        const meta = resultColumns[backendIdx];
        const value = rowValues[backendIdx];
        const colIdx = backendIdx;
        // FK-navigable iff the parent wired `onNavigateFk` and this
        // column carries a single-column FK reference. Drives the
        // Ctrl/Cmd+click accelerator, the context-menu entry, and a
        // subtle hover affordance.
        const isFkCell =
          !!onNavigateFk && !!columnInfoByName.get(meta.name)?.referenced_table;
        const isActiveCell = activeColIdx === cIdx;
        // The inline control rendered here (CellInput, or BitInput's
        // <select>) already draws its own bordered box with the same
        // brand-blue focus treatment (`fieldFocus`) — the cell's own
        // active-cell ring on top of that was two blue squares nested inside
        // each other, not one legible focus state. `fkEditHere` isn't read
        // here on purpose (see its prop doc): it exists only to make
        // `React.memo` re-render this row, not as a value this render body
        // can use, so the FK combobox keeps its own ring for now.
        const isEditingHere = inlineEditHere?.column.name === meta.name;
        const isFlashing = flashedColIdx === cIdx;
        const isPinned = pinnedColumnSet.has(colName);
        const stickyLeft = isPinned ? pinnedLeftAcc : undefined;
        if (isPinned) pinnedLeftAcc += cell.column.getSize();
        return (
          <ContextMenu key={cell.id}>
            <ContextMenuTrigger asChild>
              <td
                data-cell={`${i}-${cIdx}`}
                className={cn(
                  "cursor-pointer border-b border-border/50 border-r border-r-border/70 px-2",
                  isFkCell &&
                    "hover:underline hover:decoration-dotted hover:decoration-fk/70 hover:underline-offset-2",
                  // Pinned columns stick to the offset accumulated above.
                  // The background comes from `style` below, not a class —
                  // see `pinnedBgColor`'s comment.
                  isPinned && "sticky z-[1]",
                  // Inset ring marks the keyboard-active cell. `relative`
                  // (with no z-index) is enough to lift a plain cell above
                  // its *unpositioned* neighbours, so the ring isn't clipped
                  // by adjacent cell borders — a positioned box always
                  // paints after static ones, regardless of z-index. A
                  // `z-10` used to be applied unconditionally here, which
                  // beat every pinned column's `z-[1]` even when the active
                  // cell was a plain (non-pinned) one: scrolling a wide
                  // active cell under the pinned gutter painted its content
                  // OVER the gutter instead of hiding it behind, exactly
                  // what `position: sticky` on the gutter is supposed to
                  // prevent. `z-10` is now scoped to the one case that
                  // needs to beat a pinned column's own z-index — the active
                  // cell being pinned itself, so its ring stays visible over
                  // its own `pinnedBgColor` background.
                  // No transition — the ring must track keys instantly.
                  isActiveCell && !isEditingHere && "ring-2 ring-inset ring-brand",
                  // "It saved." One 520ms pulse, fired once the write has
                  // resolved and the page has been refetched, so it confirms
                  // the stored value rather than the keystrokes. `relative` for
                  // the same reason the active ring needs it — the pulse is a
                  // box-shadow and a static cell would let the next one paint
                  // over it.
                  isFlashing && "relative animate-brand-flash",
                  isActiveCell && isPinned && "z-10",
                  isActiveCell && !isPinned && "relative",
                )}
                title={isFkCell ? t("dataGrid.fkNavHint") : undefined}
                style={{
                  ...cellStyle,
                  width: cell.column.getSize(),
                  ...(isPinned
                    ? { left: stickyLeft, backgroundColor: pinnedBgColor }
                    : {}),
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  // While this cell hosts its own inline editor
                  // (notably the BIT `<select>`), don't steal focus
                  // back to the scroll container or recompute the
                  // active/selected cell — focusing the container
                  // collapses a just-opened native dropdown, which
                  // made the boolean BIT picker unusable (issue #44).
                  // Let the inline editor own clicks inside itself.
                  if (inlineEditHere?.column.name === meta.name) {
                    return;
                  }
                  // Second click of a double-click, detected via the
                  // native OS click count rather than the `dblclick`
                  // event. Some Linux WebKitGTK builds never fire
                  // `dblclick` when the target text has
                  // `user-select: none` (this table sets it
                  // globally — see the `select-none` note above),
                  // which made double-clicking directly on a cell's
                  // text silently fail to enter edit mode while
                  // double-clicking the cell's padding (no text
                  // under the pointer) worked fine. `click`'s
                  // `detail` isn't affected by that quirk, so route
                  // through the same path as `onDoubleClick` below
                  // instead of falling into the single-click
                  // selection logic.
                  if (e.detail >= 2) {
                    callbacksRef.current.openCellEdit(rowValues, meta);
                    return;
                  }
                  // Focus the container so keyboard nav continues
                  // from here, and mark this cell active.
                  scrollRef.current?.focus({ preventScroll: true });
                  setActiveCell({ r: i, c: cIdx });
                  // Alt+click on a single-column FK cell is the "go
                  // to referenced row" accelerator. It used to be
                  // Ctrl/Cmd+click, which collided head-on with the
                  // OS-style multi-selection toggle on the very same
                  // chord: this branch returned early, so on a table
                  // whose visible columns are mostly FKs Ctrl+click
                  // could never select a row — the reported "Shift
                  // works, Ctrl doesn't" of #113. Selection is the
                  // more fundamental gesture and it has to behave
                  // identically on every column, so FK nav moved to
                  // a chord of its own. The context-menu entry ("go
                  // to referenced row") is unchanged.
                  if (
                    e.altKey &&
                    !e.shiftKey &&
                    onNavigateFk &&
                    columnInfoByName.get(meta.name)?.referenced_table &&
                    value !== null &&
                    value !== undefined
                  ) {
                    onNavigateFk(meta.name, value);
                    return;
                  }
                  setSelectedRowIndex(i);
                  // Ctrl/Cmd/Shift-click on a cell drives the
                  // OS-style multi-selection; a plain click also
                  // opens the cell preview below.
                  callbacksRef.current.applyRowSelectionClick(rowKey, e);
                  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                    setSelectedCell({
                      rowValues,
                      colIndex: colIdx,
                      column: meta,
                      value,
                    });
                    // If the docked side editor is open, follow
                    // the clicked cell (JetBrains value-viewer
                    // behaviour). The panel guards unsaved edits
                    // before swapping its buffer.
                    if (isSideEditorOpen()) {
                      callbacksRef.current.openSidePanelEditor(
                        rowValues,
                        meta,
                        formatValue(value),
                      );
                    }
                  }
                }}
                onContextMenu={() => {
                  setSelectedRowIndex(i);
                  setSelectedCell({
                    rowValues,
                    colIndex: colIdx,
                    column: meta,
                    value,
                  });
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  callbacksRef.current.openCellEdit(rowValues, meta);
                }}
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <MenuBody>
                {() => {
                  // Read now, while the menu mounts — not when the row last
                  // rendered, which may predate the latest Ctrl+click on
                  // another row (see `GridRowCallbacks.selectedRows`).
                  const selectedRows = callbacksRef.current.selectedRows();
                  // Bulk variant: shown when more than one row is selected
                  // and the right-clicked row is part of that selection.
                  // Replaces the per-cell/row entries with selection-wide
                  // copy + delete; otherwise the regular single-row menu
                  // below renders.
                  return selectionEnabled &&
                    selectedRows.length > 1 &&
                    isMultiSelected ? (
                    <>
                      <ContextMenuLabel>
                        {t("dataGrid.ctxRowsSelected", {
                          count: selectedRows.length,
                        })}
                      </ContextMenuLabel>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Copy className="mr-2 h-3.5 w-3.5 shrink-0" />
                          {t("dataGrid.ctxCopyRowsAs", {
                            count: selectedRows.length,
                          })}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyRows(selectedRows, "json")
                            }
                          >
                            JSON
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyRows(selectedRows, "insert")
                            }
                          >
                            SQL INSERT
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyRows(selectedRows, "update")
                            }
                          >
                            SQL UPDATE
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      {onAddFilter && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuAction
                            icon={Filter}
                            label={t("dataGrid.ctxFilterInSelected", {
                              column: meta.name,
                              count:
                                callbacksRef.current.selectedColumnValues(colIdx)
                                  .distinct,
                            })}
                            onSelect={() =>
                              onAddFilter({
                                column: meta.name,
                                op: "in",
                                values:
                                  callbacksRef.current.selectedColumnValues(colIdx)
                                    .values,
                              })
                            }
                          />
                          <ContextMenuAction
                            icon={FilterX}
                            label={t("dataGrid.ctxFilterNotInSelected", {
                              column: meta.name,
                              count:
                                callbacksRef.current.selectedColumnValues(colIdx)
                                  .distinct,
                            })}
                            onSelect={() =>
                              onAddFilter({
                                column: meta.name,
                                op: "not_in",
                                values:
                                  callbacksRef.current.selectedColumnValues(colIdx)
                                    .values,
                              })
                            }
                          />
                        </>
                      )}
                      {onBulkDelete && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuAction
                            icon={Trash2}
                            destructive
                            label={t("dataGrid.ctxDeleteRows", {
                              count: selectedRows.length,
                            })}
                            onSelect={() => onBulkDelete(selectedRows)}
                          />
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <ContextMenuLabel>
                        {meta.name}
                        {value === null ? " · NULL" : ""}
                      </ContextMenuLabel>
                      {isFkCell && value !== null && value !== undefined && (
                        <>
                          <ContextMenuAction
                            icon={ArrowRightCircle}
                            label={t("dataGrid.ctxGoToReference")}
                            onSelect={() => onNavigateFk?.(meta.name, value)}
                          />
                          <ContextMenuSeparator />
                        </>
                      )}
                      <ContextMenuAction
                        icon={Copy}
                        label={t("dataGrid.ctxCopy")}
                        onSelect={() =>
                          callbacksRef.current.copyToClipboard(formatValue(value))
                        }
                      />
                      <ContextMenuAction
                        icon={ClipboardCopy}
                        label={t("dataGrid.ctxCopyWithColumn")}
                        onSelect={() =>
                          callbacksRef.current.copyToClipboard(
                            `${meta.name} = ${sqlLiteral(value, driver)}`,
                          )
                        }
                      />
                      {/* Row-level formatters. We keep the per-cell
                      entries above (single value, single value
                      with column name) because they're the most
                      common path; this submenu covers the
                      less-frequent "I want the whole row" use
                      cases without bloating the top level. */}
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Copy className="mr-2 h-3.5 w-3.5 shrink-0" />
                          {t("dataGrid.ctxCopyRowAs")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyToClipboard(
                                rowToJson(rowValues, resultColumns),
                              )
                            }
                          >
                            JSON
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyToClipboard(
                                rowToSqlInsert(
                                  rowValues,
                                  resultColumns,
                                  driver,
                                  tableName,
                                ),
                              )
                            }
                          >
                            SQL INSERT
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              callbacksRef.current.copyToClipboard(
                                rowToSqlUpdate(
                                  rowValues,
                                  resultColumns,
                                  driver,
                                  tableName,
                                  pkColumnNames,
                                ),
                              )
                            }
                          >
                            SQL UPDATE
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuAction
                        icon={PanelRight}
                        label={t("dataGrid.openInSideEditor")}
                        onSelect={() =>
                          callbacksRef.current.openSidePanelEditor(
                            rowValues,
                            meta,
                            formatValue(value),
                          )
                        }
                      />
                      {editable && onCellSave && (
                        <ContextMenuAction
                          icon={Eraser}
                          disabled={value === null}
                          locked={columnLock?.(meta.name) ?? null}
                          label={t("cellEditor.setNull")}
                          onSelect={() =>
                            // The rejection is already reported by `DataGrid`'s save seam (which
                            // notifies and rethrows); swallowing it here only keeps the
                            // unhandled-rejection warning out of the console.
                            onCellSave(rowValues, meta.name, null).catch(() => {})
                          }
                        />
                      )}
                      {onAddFilter && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuAction
                            icon={Filter}
                            label={t("dataGrid.ctxFilterBy")}
                            onSelect={() =>
                              onAddFilter(
                                value === null
                                  ? { column: meta.name, op: "is_null" }
                                  : {
                                      column: meta.name,
                                      op: "eq",
                                      value,
                                    },
                              )
                            }
                          />
                          <ContextMenuAction
                            icon={FilterX}
                            label={t("dataGrid.ctxFilterExcluding")}
                            onSelect={() =>
                              onAddFilter(
                                value === null
                                  ? { column: meta.name, op: "is_not_null" }
                                  : {
                                      column: meta.name,
                                      op: "ne",
                                      value,
                                    },
                              )
                            }
                          />
                        </>
                      )}
                      {(onInsertRow || onDuplicateRow) && (
                        <>
                          <ContextMenuSeparator />
                          {onInsertRow && (
                            <ContextMenuAction
                              icon={Plus}
                              label={t("dataGrid.ctxInsertRow")}
                              onSelect={() => onInsertRow()}
                            />
                          )}
                          {onDuplicateRow && (
                            <ContextMenuAction
                              icon={CopyPlus}
                              label={t("dataGrid.ctxDuplicateRow")}
                              onSelect={() => onDuplicateRow(rowValues)}
                            />
                          )}
                        </>
                      )}
                      {onDeleteRow && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuAction
                            icon={Trash2}
                            destructive
                            label={t("dataGrid.ctxDeleteRow")}
                            onSelect={() => onDeleteRow(rowValues)}
                          />
                        </>
                      )}
                    </>
                  );
                }}
              </MenuBody>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {/* Matches the header's filler `<th>` — see the comment there. */}
      <td className="border-b border-border/50" />
    </tr>
  );
});
