/**
 * Generic data grid used for both table data and ad-hoc query results.
 * Built on top of TanStack Table; the table view's rows are windowed by
 * `@tanstack/react-virtual` (list view — MongoDB's `DocumentListView` — is
 * not, see its own file).
 *
 * Visual features:
 * - Numeric columns (int, float, decimal, …) are highlighted in amber.
 * - Clicking a row selects it (blue tint); clicking a cell opens the
 *   compact `CellPreview` panel at the bottom-right of the container.
 * - Double-clicking a cell opens the full Monaco `CellEditor` for
 *   multi-line viewing and, when editable, saving.
 *
 * Interaction features (when `editable`):
 * - Right-click on a cell shows a HeidiSQL-style context menu with
 *   copy / set-null / filter / row ops (insert, duplicate, delete).
 * - Server-side column filters render as removable chips above the
 *   grid. The pre-existing client text filter sits next to them and
 *   keeps acting on the current page only.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { tableKey } from "@/stores/session/schema";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  Inbox,
  Pin,
  UnfoldHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common/EmptyState";
import { isBitType, isNumericType } from "@/lib/grid/columnKinds";
import {
  computeAutoFitWidths,
  distributeToWidth,
} from "@/lib/grid/autoFitColumn";
import { useGridPrefs } from "@/lib/grid/useGridPrefs";
import {
  DocumentListView,
  type ExpandAllSignal,
  type FieldSave,
} from "@/components/grid/DocumentListView";
import type {
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ColumnMeta,
  DraftCell,
  DraftRow,
  QueryResult,
  SortSpec,
} from "@/types";
import { CellEditor } from "@/components/grid/dialogs/CellEditor";
import { CellPreview } from "@/components/grid/CellPreview";
import { isAutoPkColumn } from "@/components/grid/DraftCellControl";
import { DraftRowView } from "@/components/grid/DraftRowView";
import { IconButton } from "@/components/ui/icon-button";
import { Separator } from "@/components/ui/separator";
import {
  GridToolbar,
  type GridToolbarItem,
  type InsertAlternative,
  type QueryChip,
} from "@/components/grid/GridToolbar";
import { GridRow, type GridRowCallbacks } from "@/components/grid/GridRow";
import { copyToClipboard } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import { toBulk } from "@/lib/grid/copyFormats";
import {
  formatValue,
  rawCellText,
  truncateForDisplay,
} from "@/lib/grid/formatValue";
import {
  GRID_GUTTER_WIDTH,
  MAX_AUTOFIT_WIDTH,
  MIN_COLUMN_WIDTH,
  useColumnSizing,
} from "@/lib/grid/useColumnSizing";
import { usePinnedColumns } from "@/lib/grid/usePinnedColumns";
import { useCtrlWheelZoom } from "@/lib/grid/useCtrlWheelZoom";
import { useGridColumns } from "@/lib/grid/useGridColumns";
import { useGridKeyboardNav, type GridPaste } from "@/lib/grid/useGridKeyboardNav";
import { rowNumber } from "@/lib/grid/pagination";
import { useGridSelection } from "@/lib/grid/useGridSelection";
import { useSavedCellFlash } from "@/lib/grid/useSavedCellFlash";
import { removeSortLevel, toggleSortLevel } from "@/lib/grid/sortSpec";
import { useCellEditing } from "@/lib/grid/useCellEditing";
import { useJsonSchemas, relationKey } from "@/stores/jsonSchemas";
import type { Driver } from "@/types";

/**
 * Module-level so its identity never changes (gotcha #1, applied to a
 * library prop rather than a store selector). In list mode the table's own
 * `<tbody>` never renders, but `useReactTable`/`getCoreRowModel()` are still
 * called unconditionally (hooks can't be conditional) — feeding them a
 * fresh `[]` on every render would still build a `Row`/`Cell` tree for zero
 * rows on every keystroke elsewhere in the grid, for no reason.
 */
const NO_ROWS: CellValue[][] = [];

interface Props {
  result: QueryResult;
  editable?: boolean;
  /**
   * Why the person may not change one column, when the managed policy limits
   * which columns they may write (ADR #113) — `null` for a column they may.
   * Narrows `editable` per column: a locked cell opens read-only. Stable
   * identity expected (it reaches the memoised rows).
   */
  columnLock?: (column: string) => string | null;
  /**
   * The same for the draft row: why the person may not give this column a
   * value when adding a row. A locked draft cell is left to its default.
   */
  draftColumnLock?: (column: string) => string | null;
  /**
   * A block pasted with Ctrl+V — several cells copied from a spreadsheet or
   * another grid — and where it lands (ADR #114). Without it, pasting writes
   * the clipboard into the one cell as text.
   */
  onPasteBlock?: (paste: GridPaste) => void;
  /**
   * Connection + table coordinates. When set, draft-row cells whose
   * column carries a single-column FK constraint render a searchable
   * combobox of valid referenced values instead of a plain text input.
   */
  connectionId?: string;
  tableSchema?: string;
  tableName?: string;
  /** Id of the tab hosting this grid. Threaded to the docked side editor so it
   *  can close itself when this tab is closed (it lives outside the subtree). */
  tabId?: string;
  /**
   * Driver of the underlying connection. Used purely to make the
   * "Copy as ▸ SQL …" snippets quote identifiers correctly
   * (MySQL backticks vs PG/SQLite double quotes). Optional because
   * query-result grids may not know which connection a row came from
   * — the snippets still render with sensible defaults.
   */
  driver?: Driver;
  /**
   * Names of every column that participates in the table's primary key,
   * in catalog order. The grid uses them (a) to skip PK columns in the
   * "Copy as UPDATE" SET clause and (b) to AND-join the WHERE predicate
   * — keeping the snippet safe on composite-PK tables. When absent or
   * empty, UPDATE renders with `<pk> = <value>` placeholders so the
   * user notices.
   */
  pkColumnNames?: string[];
  /** Names of columns that are a single-column FOREIGN KEY, for the header
   *  key icon (HeidiSQL-style). Purely presentational. */
  fkColumnNames?: string[];
  /**
   * "Go to referenced row" — invoked when the user Ctrl/Cmd+clicks (or picks
   * the context-menu item on) a cell whose column is a single-column FK, with
   * the FK value. The parent resolves the referenced table from its column
   * metadata and opens it filtered to that value (IDE "go to definition").
   * Only the cells whose column carries `referenced_table` (known via
   * `draftColumns`/`columnInfoByName`) trigger it.
   */
  onNavigateFk?: (columnName: string, value: CellValue) => void;
  /**
   * Cell edit callback. Receives the **full row values array** (not a
   * row index) so the parent can resolve identity (PK value) directly
   * from the data, immune to client-side filtering reshuffling
   * positions. The previous index-based contract silently corrupted
   * data when `globalFilter` was active because the index referred to
   * the filtered display order while the parent read from the
   * unfiltered backend page — see plan A1.
   */
  onCellSave?: (
    rowValues: CellValue[],
    columnName: string,
    value: string | null,
  ) => Promise<void>;
  /**
   * List-view field commit — `onCellSave` generalised to a field **path**, so
   * a nested field (`["customData", "format"]`, `["tags", "2"]`) can be
   * written as well as a top-level one, with the type it should be written
   * as. Only the list view uses it; the table view has no nested cells to
   * address. Absent → the list view renders read-only.
   */
  onFieldSave?: FieldSave;
  /**
   * List-view field removal (MongoDB `$unset`). Its presence is also what puts
   * the list view in *document* mode: the add-field, delete-field and BSON
   * type picker affordances only make sense where a row's field set is a
   * property of the row itself, which is exactly where a `$unset` exists.
   */
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
  /** Header click handler. `additive` is true when Ctrl/Cmd was held, which
   *  the parent uses to build a multi-column sort. */
  onSortChange?: (column: string, additive: boolean) => void;
  /** Active multi-column sort, in precedence order. */
  sort?: SortSpec[];
  /**
   * Replace the whole sort. The seam every header-less surface uses — the
   * sort chips in the toolbar and the list view's field context menu — where
   * `onSortChange`'s "a header was clicked" vocabulary does not apply. The
   * transitions are `lib/grid/sortSpec.ts`'s. Absent → no chips and no sort
   * entries in the list view's menu.
   */
  onSortSpecsChange?: (next: SortSpec[]) => void;
  /**
   * Applied filter — drives the client-side `visibleRows` pass and is
   * what the grid believes is the *current* search. For tabs that
   * commit explicitly (table data), pass the committed/applied value
   * here, NOT the uncommitted toolbar input — otherwise the rows
   * actually rendered diverge from the backend page that fed
   * `result.rows`, which silently corrupts cell-save UX (the row the
   * user perceives as "above" can become a different backend row after
   * a refetch). Query-result tabs that have no backend filter just
   * pass the live input value.
   */
  globalFilter?: string;
  /**
   * Optional value shown in the toolbar search box. Use it when the
   * uncommitted draft (what the user is typing) is intentionally
   * different from the applied filter — i.e. table-data tabs that
   * only refetch on Enter. When absent the input mirrors
   * `globalFilter`.
   */
  filterInput?: string;
  onGlobalFilterChange?: (v: string) => void;
  /**
   * Called when the user explicitly commits the current search — by
   * pressing Enter, picking an entry from the history dropdown, or
   * hitting the clear (×) button. Receives the value being committed
   * so callers don't depend on the not-yet-flushed `onChange` state.
   */
  onGlobalFilterSubmit?: (v: string) => void;
  /**
   * Newest-first list of recent search queries shown in a small
   * dropdown next to the filter input. Empty list → no dropdown button.
   */
  searchHistory?: string[];

  /** Server-side column filters; rendered as chips. */
  serverFilters?: ColumnFilter[];
  /** Render filter-chip values with their BSON type visible — MongoDB only.
   *  See `ServerFilterChips`' `valueText` for why the distinction matters
   *  there and is noise on the SQL drivers. */
  typedFilterValues?: boolean;
  onAddFilter?: (f: ColumnFilter) => void;
  onRemoveFilter?: (index: number) => void;
  /** Open the query panel focused on the condition at this index. */
  onEditFilter?: (index: number) => void;

  /**
   * Row-level mutations. Only wired when the table has a PK. Like
   * `onCellSave`, these receive the row's full values array to resolve
   * identity safely under client filtering.
   */
  onInsertRow?: () => void;
  onDuplicateRow?: (rowValues: CellValue[]) => void;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  /**
   * Delete several rows at once (the multi-selection path). Receives one
   * values array per selected row. Wired only when the table has a PK; the
   * parent shows the same confirmation dialog used for single-row delete.
   */
  onBulkDelete?: (rows: CellValue[][]) => void;
  /**
   * Stable identity key for a row, derived from its primary key by the
   * parent (`JSON.stringify(pkValues)`). Returns `null` when the row has no
   * resolvable PK, which disables selection — consistent with the existing
   * editable/delete gate. Identity is data-derived (not the display index)
   * so a selection survives refetch / sort / client filtering (ADR #7).
   */
  getRowKey?: (rowValues: CellValue[]) => string | null;

  /**
   * Reports the live multi-selection count and the visible-row total
   * whenever either changes. Used by the status bar (via the parent, which
   * owns the tab id) to show "N selected". Selection itself stays internal.
   */
  onSelectionChange?: (count: number, total: number) => void;

  /**
   * Inline draft row state (insert / duplicate). When set, an extra
   * editable row is rendered at the top of the grid. Schema-level column
   * metadata is needed so the inputs can show PK / NOT NULL hints.
   */
  draftRow?: DraftRow | null;
  draftColumns?: ColumnInfo[];
  onDraftCellChange?: (column: string, cell: DraftCell) => void;
  onDraftCommit?: () => void;
  onDraftCancel?: () => void;

  /**
   * Actions rendered at the START of the toolbar row (before the search box),
   * with a divider after them. TableDataTab folds its refresh + advanced
   * filter controls in here so a table tab shows ONE toolbar instead of two
   * stacked bars. Query-result tabs omit it.
   */
  toolbarLeading?: GridToolbarItem[];
  /**
   * Actions rendered right beside the built-in "Insert" button, both living in
   * the toolbar's right-aligned cluster. TableDataTab folds its "Add
   * data"/"Export data"/"Bulk update" controls in here so every action that
   * adds, exports, or mass-edits data reads as one group instead of being
   * split across the toolbar.
   */
  insertExtra?: GridToolbarItem[];
  /** Other ways to add data, offered behind the Insert button's chevron.
   *  Empty leaves a plain one-click button — see `GridToolbar`. */
  insertAlternatives?: InsertAlternative[];
  /**
   * Actions rendered on the TRAILING (right) side of the toolbar row, after
   * `insertExtra`, before the elapsed-time readout. TableDataTab folds its
   * table/list view toggle in here.
   */
  toolbarTrailing?: GridToolbarItem[];
  /**
   * Optional second toolbar row, rendered below the grid body (a footer, not
   * a header). TableDataTab folds its pagination range/prev/next/page-size
   * and row-zoom controls in here — those are "how you're browsing", kept
   * apart from the header's "what you're doing to the data" actions. Omitted
   * entirely (no empty bar) when not provided, so query/view result tabs
   * that don't paginate see no change.
   */
  footer?: ReactNode;
  /** The projection / expression chips, forwarded to the toolbar's chip row. */
  queryChips?: QueryChip[];
  /**
   * The rows are already the server's answer to `globalFilter`, so the
   * client-side text pass below must not run over them again.
   *
   * That pass only ever sees the columns on screen, and the server searched
   * every column of the table. The two agreed as long as every column was on
   * screen; a projection breaks that, and a row the server matched on a hidden
   * column would vanish here with nothing saying why. Table tabs set this;
   * query results, which have no server to ask, keep the pass.
   */
  rowsFromServer?: boolean;
  /**
   * How many rows precede this page on the server — the browse's `offset` —
   * so the gutter's row numbers (and the list view's) are absolute: page 2 of
   * a 100-row page starts at 101, not 1. Display only (`rowNumber`); selection,
   * editing and every other index in here stay page-relative. Defaults to 0
   * for the surfaces that do not paginate.
   */
  rowNumberOffset?: number;
  /**
   * Content rendered between the toolbar and the grid body — TableDataTab's
   * query panel. Outside the scroll container on purpose: it must not scroll
   * away with the rows it shapes, and its keys must not reach the grid's
   * keyboard navigation (`data-kb-scope="grid"` is on the scroller).
   */
  belowToolbar?: ReactNode;
  /**
   * Whether to render the built-in "N rows of M" count in the toolbar
   * (default true). TableDataTab sets this false because its trailing slot
   * already shows a human-format pagination range (`1–100 of 19759`), which
   * makes the row count redundant; query/view result tabs keep it, since it's
   * their only row-total indicator (they don't paginate).
   */
  showRowCount?: boolean;
  /**
   * When true, dims the grid body and shows a spinner overlay — used while a
   * refetch is in flight but stale rows are still on screen, so the grid
   * doesn't look frozen. Initial load (no rows yet) is handled by the caller's
   * skeleton placeholder instead.
   */
  loading?: boolean;
  /**
   * Row layout: "table" (default) is the regular column grid; "list" renders
   * each row as a card with one `field: value` line per column, folding
   * nested objects/arrays — see `DocumentListView`. It was built for MongoDB
   * documents but the problem it solves (a wide or nested row that scrolls
   * horizontally and flattens nested values into one unreadable line) is not
   * MongoDB's alone, so every driver can use it.
   *
   * List mode drives its own editing (inline per field, escalating to the
   * same Monaco editor) through `onFieldSave`/`onFieldDelete`; what it does
   * NOT have is the table-specific chrome — FK overlay, keyboard cell
   * navigation, and the draft-row insert/duplicate UI — so Insert and
   * Duplicate stay hidden while it is active.
   */
  viewMode?: "table" | "list";
}

/**
 * Re-exported so the toolbar's own contract keeps its historical import path:
 * `TableDataTab` builds its three slot arrays against it, and the type now
 * lives with the bar that consumes it.
 */
export type { GridToolbarItem, InsertAlternative, QueryChip };

export interface SelectedCell {
  /**
   * Full row values array. We carry the row payload (not its display
   * index) so saves stay correct when the visible order diverges from
   * the underlying `result.rows` page — e.g. while `globalFilter` is
   * active.
   */
  rowValues: CellValue[];
  colIndex: number;
  column: ColumnMeta;
  value: CellValue;
}

export function DataGrid({
  result,
  editable,
  columnLock,
  draftColumnLock,
  onPasteBlock,
  connectionId,
  tableSchema,
  tableName,
  tabId,
  driver,
  pkColumnNames,
  onCellSave: onCellSaveProp,
  onSortChange,
  sort,
  onSortSpecsChange,
  fkColumnNames,
  onNavigateFk,
  globalFilter,
  filterInput,
  onGlobalFilterChange,
  onGlobalFilterSubmit,
  searchHistory,
  serverFilters,
  typedFilterValues,
  onAddFilter,
  onRemoveFilter,
  onEditFilter,
  onInsertRow,
  onDuplicateRow,
  onDeleteRow,
  onBulkDelete,
  onFieldSave: onFieldSaveProp,
  onFieldDelete,
  getRowKey,
  onSelectionChange,
  draftRow,
  draftColumns,
  onDraftCellChange,
  onDraftCommit,
  onDraftCancel,
  toolbarLeading,
  insertExtra,
  insertAlternatives,
  toolbarTrailing,
  footer,
  belowToolbar,
  queryChips,
  rowsFromServer = false,
  rowNumberOffset = 0,
  showRowCount = true,
  loading,
  viewMode = "table",
}: Props) {
  const { t } = useTranslation();
  const draftRowRef = useRef<HTMLTableRowElement | null>(null);
  // Holds either the plain text input or the FkCombobox trigger, so any
  // editable element type can claim the autofocus slot.
  const firstDraftInputRef = useRef<HTMLElement | null>(null);

  /**
   * Focus the first editable draft cell when a draft is created so the
   * user can start typing immediately. Re-runs only when a new draft
   * appears (identity-stable boolean).
   *
   * The focus is granted in a `setTimeout` *chained after* a frame, not inside
   * the frame itself, and that ordering is load-bearing. "Insert row" is
   * reachable from two Radix menus (the row context menu and the toolbar's
   * overflow menu), and Radix's `FocusScope` restores focus to whatever was
   * focused before the menu opened from inside its own `setTimeout(…, 0)` on
   * unmount. Focusing synchronously in the frame therefore lost the race: Radix
   * pulled focus out of the just-mounted draft a tick later, the row's
   * focus-leave handler fired, and an untouched draft is silently cancelled —
   * so the row appeared and vanished instantly (the only reliable way to insert
   * was the toolbar button, which involves no menu). Our timeout is always
   * queued after Radix's, so the draft ends up focused either way.
   */
  const draftActive = !!draftRow;
  useEffect(() => {
    if (!draftActive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The frame is what waits for the row / card to be mounted.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => firstDraftInputRef.current?.focus(), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [draftActive]);

  /** Fast lookup of column metadata by name for FK detection in the cell renderer. */
  const columnInfoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draftColumns ?? []) m.set(c.name, c);
    return m;
  }, [draftColumns]);

  /** Compact preview panel state. Cleared when the user clicks away or presses Esc. */
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  /** Row index of the currently selected row (blue highlight). */
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  /**
   * Multi-row selection. Keyed by the parent-supplied stable row key
   * (PK-derived) rather than display index or array reference, so a selection
   * survives refetch / sort / client filtering (ADR #7). Only meaningful
   * when `getRowKey` is wired; otherwise the checkbox column is hidden and
   * bulk actions never appear — which is still the case for ad-hoc query
   * result grids. A *table* grid always wires it: `TableDataTab` derives the
   * key from the PK tuple when there is one and from the whole values array
   * when there isn't, so a no-PK table keeps its selection gestures (see the
   * note there). Selection being enabled therefore no longer implies a PK
   * exists — destructive bulk actions gate on their own callbacks
   * (`onBulkDelete`), which the parent withholds without one.
   */
  const selectionEnabled = !!getRowKey;
  /**
   * Optional client-side text filter over the rows already in memory.
   * Used by query results (where there is no underlying table to
   * refetch from). `TableDataTab` instead pushes the same `globalFilter`
   * value to the backend, so a second pass here is a harmless no-op.
   */
  const visibleRows = useMemo(() => {
    if (!globalFilter || rowsFromServer) return result.rows;
    const q = globalFilter.toLowerCase();
    return result.rows.filter((r) =>
      r.some((c) => formatValue(c).toLowerCase().includes(q)),
    );
  }, [result.rows, globalFilter, rowsFromServer]);

  // Row selection — keys, clicks, select-all and the derived answers the
  // toolbar and context menus need. See the hook for the invariants (identity
  // by key not index, pruning to the visible set, distinct value counts).
  const {
    selectedKeys,
    selectedRows,
    hasSelection,
    allSelected,
    someSelected,
    toggleRowKey,
    applyRowSelectionClick,
    toggleSelectAll,
    selectedColumnValues,
  } = useGridSelection({ visibleRows, getRowKey, onSelectionChange });

  /**
   * Success feedback for a write, decided once here rather than at each of the
   * twelve places a save is fired from (inline commit, the keyboard's
   * type-to-replace, the FK combobox, the ∅ button, the modal editor, the
   * docked panel, the list view's fields). Wrapping the two callbacks *before*
   * they are handed down means every one of those paths — and any added later —
   * confirms itself without knowing this exists. Wrapping them individually
   * would have been twelve chances to forget, which is how the app ended up
   * with no confirmation anywhere in the first place.
   *
   * The mark is set only after the save resolves, and every save path refetches
   * on its way through, so the pulse lands on the *refreshed* value — it says
   * "this is what the database now holds", not "your keystrokes were accepted".
   * A rejected write throws before it, so a failure can never look like a
   * success.
   */
  const { flashed, markSaved } = useSavedCellFlash();

  /** Position of the pulsing row in `visibleRows`, for the list view (which
   *  keys documents by position). `-1` becomes `null` — the row may have left
   *  the page between the save and its refetch. */
  const flashedRowIndex = useMemo(() => {
    if (!flashed || !getRowKey) return null;
    const i = visibleRows.findIndex((r) => getRowKey(r) === flashed.rowKey);
    return i === -1 ? null : i;
  }, [flashed, getRowKey, visibleRows]);

  /**
   * Reporting a rejected save belongs at this seam for the same reason the
   * confirmation does: the grid commits an edit from a dozen places across six
   * files, and every one of the fast paths — the inline editor, the FK picker,
   * Ctrl+V, "Set NULL" — used to end in `.catch(() => {})`. A write to the
   * database was being refused by the server and leaving no trace at all: the
   * flash simply did not happen, and silence had to be read as success by a
   * user who had just been told to read silence as success.
   *
   * `quiet` is for the two surfaces that own an error slot of their own — the
   * modal editor and the docked side panel both keep the editor open and print
   * the driver message beside the value that caused it, which is strictly
   * better than a card behind the dialog. Two opt-outs decided here beat five
   * call sites each remembering to opt in.
   */
  const decorateCellSave = useCallback(
    (quiet: boolean) =>
      onCellSaveProp &&
      (async (
        rowValues: CellValue[],
        columnName: string,
        value: string | null,
      ) => {
        try {
          await onCellSaveProp(rowValues, columnName, value);
        } catch (e) {
          if (!quiet) {
            notify.error(t("dataGrid.saveFailed"), { description: String(e) });
          }
          // Rethrown either way: the caller decides whether to keep an editor
          // open, and `markSaved` below must never run for a refused write.
          throw e;
        }
        markSaved(getRowKey?.(rowValues) ?? null, [columnName]);
      }),
    [onCellSaveProp, getRowKey, markSaved, t],
  );

  const decorateFieldSave = useCallback(
    (quiet: boolean) =>
      onFieldSaveProp &&
      (async (
        rowValues: CellValue[],
        path: string[],
        value: string | null,
        type?: string,
      ) => {
        try {
          await onFieldSaveProp(rowValues, path, value, type);
        } catch (e) {
          if (!quiet) {
            notify.error(t("dataGrid.saveFailed"), { description: String(e) });
          }
          throw e;
        }
        markSaved(getRowKey?.(rowValues) ?? null, path);
      }),
    [onFieldSaveProp, getRowKey, markSaved, t],
  );

  const onCellSave = useMemo(() => decorateCellSave(false), [decorateCellSave]);
  const onFieldSave = useMemo(() => decorateFieldSave(false), [decorateFieldSave]);
  /** The same commit, for a surface that prints the failure itself. */
  const onCellSaveQuiet = useMemo(() => decorateCellSave(true), [decorateCellSave]);
  const onFieldSaveQuiet = useMemo(() => decorateFieldSave(true), [decorateFieldSave]);

  /**
   * Re-resolve `selectedCell` after a refetch replaces every row's array
   * reference (e.g. `onCellSave` awaiting `fetchData()` while the docked side
   * editor stays open across the save). Without this, a cell selected before
   * the save keeps pointing at a now-detached array once the fresh result
   * lands: the selected-cell "expand" affordance and the `cellPreview` panel
   * both key off `rowValues` identity (ADR #7), so they'd silently go
   * stale — the button vanishes from the grid and, if `cellPreview` is on,
   * the floating panel keeps showing the pre-save value forever, even though
   * the side editor is still open and "focused" on that same logical cell.
   * `visibleRows.includes` is a no-op on a sort/filter reshuffle, which reuses
   * the same row objects — this only does work on a genuine refetch. Falls
   * back to clearing the selection when it can't be resolved (no `getRowKey`,
   * or the row is gone) rather than leaving a phantom target.
   */
  useEffect(() => {
    setSelectedCell((prev) => {
      if (!prev || visibleRows.includes(prev.rowValues)) return prev;
      if (!getRowKey) return null;
      const key = getRowKey(prev.rowValues);
      if (key === null) return null;
      const next = visibleRows.find((r) => getRowKey(r) === key);
      if (!next) return null;
      return { ...prev, rowValues: next, value: next[prev.colIndex] };
    });
    // Deliberately only `visibleRows`: `getRowKey` is a per-render prop and
    // `selectedCell` is what this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows]);

  /**
   * Pre-computed set of column names that carry numeric data.
   * Recomputed only when the column list changes (not on every row render).
   */
  const numericColNames = useMemo(
    () =>
      new Set(
        result.columns
          .filter((c) => isNumericType(c.data_type))
          .map((c) => c.name),
      ),
    [result.columns],
  );

  /**
   * Column names whose type is MySQL `BIT`. Rendered through the user's
   * `bitDisplay` preference (true/false vs 0/1) instead of the raw number.
   */
  const bitColNames = useMemo(
    () =>
      new Set(
        result.columns.filter((c) => isBitType(c.data_type)).map((c) => c.name),
      ),
    [result.columns],
  );
  /**
   * Every preference the grid reads. **Destructured, never spread into a
   * dependency array** — `columns` below depends on four of these, and
   * rebuilding it remounts the table body (see `interactiveRef`), so it must
   * keep tracking the individual values rather than the bundle. See the hook
   * for why the subscriptions inside it stay one-per-primitive (gotcha #1).
   */
  const {
    bitDisplay,
    cellEditorMode,
    nullDisplay,
    truncateLongTextAt,
    zebraStripes,
    stickyHeader,
    cellPreview,
    listExpandNested,
    listShowTypes,
    listLineNumbers,
    rowHeight,
    expandCellCombo,
    updateGrid,
  } = useGridPrefs();

  /**
   * Column widths (persisted per table) and the live resize drag — see
   * `useColumnSizing` for why the drag writes the DOM directly.
   */
  const persistKey = tableName ? tableKey(tableSchema, tableName) : null;
  const { columnSizing, commitWidths, resizingColId, startColumnResize } =
    useColumnSizing({ persistKey, updateGrid });
  /** Pinned ("frozen") columns — see `usePinnedColumns` and `GRID_GUTTER_WIDTH`
   *  below, used to compute each pinned column's sticky `left` offset. */
  const { pinnedColumns, togglePin } = usePinnedColumns({
    persistKey,
    updateGrid,
  });
  const pinnedColumnSet = useMemo(
    () => new Set(pinnedColumns),
    [pinnedColumns],
  );
  /** The header's dimmed type hint renders at the `text-3xs` token (10px). */
  const TYPE_HINT_FONT_SIZE = 10;

  /**
   * Inline styles derived from `rowHeight`. Memoised so the object identity
   * is stable across the per-cell render loop (it feeds hundreds of cells).
   * Font-size tracks the row height but is clamped to stay legible.
   */
  const { cellStyle, headerStyle } = useMemo(() => {
    const fontSize = Math.min(22, Math.max(10, Math.round(rowHeight * 0.46)));
    const padY = Math.max(1, Math.round((rowHeight - fontSize) / 2));
    return {
      cellStyle: {
        fontSize,
        paddingTop: padY,
        paddingBottom: padY,
      } as React.CSSProperties,
      headerStyle: {
        fontSize: Math.max(9, fontSize - 2),
      } as React.CSSProperties,
    };
  }, [rowHeight]);

  // Ctrl+wheel row zoom (non-passive listener — ADR #13). Also the ref the
  // grid attaches to its scroll container.
  const scrollRef = useCtrlWheelZoom(rowHeight, updateGrid);

  /**
   * Backend column index keyed by name. The cell render loop walks
   * `row.getVisibleCells()` whose position index is TanStack's *visible*
   * order — if a future change ever introduces column reordering /
   * hiding, that index would silently diverge from `result.columns`.
   * Resolving by `cell.column.id` (which we set to `col.name`) keeps
   * cell metadata and underlying row values aligned regardless of
   * display order.
   */
  const columnIndexByName = useMemo(() => {
    const m = new Map<string, number>();
    result.columns.forEach((c, i) => m.set(c.name, i));
    return m;
  }, [result.columns]);

  /**
   * Which editor is open on which cell, and the four entry points that decide
   * between them (ADR #12's routing lives in `openCellEdit`). Owns the
   * modal / inline-FK / inline-text state, so none of it is here any more.
   */
  const {
    editorOpen,
    setEditorOpen,
    editorTarget,
    fkEditCell,
    setFkEditCell,
    inlineEdit,
    setInlineEdit,
    bindingContextFor,
    openSidePanelEditor,
    openHeavyEditor,
    openCellEdit,
  } = useCellEditing({
    editable,
    connectionId,
    tableSchema,
    tableName,
    tabId,
    cellEditorMode,
    columnInfoByName,
    columnIndexByName,
    columnLock,
    // The quiet pair: the only commit this hook performs is the docked side
    // editor's, which keeps the panel open and prints the driver message there.
    onCellSave: onCellSaveQuiet,
    onFieldSave: onFieldSaveQuiet,
  });

  // Whether the open heavy editor's column is one the policy locks: it then
  // shows the value read-only. A list-view field is judged by its top-level
  // field, as the backend judges a MongoDB path.
  const editorLocked =
    editorTarget && columnLock
      ? columnLock(editorTarget.field?.path[0] ?? editorTarget.column.name)
      : null;

  // The columns the policy will not let this person change, split by whether
  // a new row may still fill them: a lock in the header for a column they can
  // neither change nor fill, and an "only when adding a row" mark for one the
  // draft row still offers — a plain lock there read as a contradiction next
  // to the Insert button. Derived once per result rather than asked of
  // `columnLock` in the renderer, since the column definitions must not
  // depend on a function.
  // A boolean, not the callback: `onInsertRow` is a fresh function on every
  // render of the tab, and these sets feed the column definitions, whose
  // rebuild remounts the table body (see `useGridColumns`).
  const canInsert = !!onInsertRow;
  const [lockedNameSet, insertOnlyNameSet] = useMemo(() => {
    const locked = new Set<string>();
    const insertOnly = new Set<string>();
    if (editable && columnLock) {
      for (const c of result.columns) {
        if (!columnLock(c.name)) continue;
        const fillable =
          canInsert &&
          !draftColumnLock?.(c.name) &&
          !isAutoPkColumn(columnInfoByName.get(c.name));
        (fillable ? insertOnly : locked).add(c.name);
      }
    }
    return [locked, insertOnly] as const;
  }, [
    editable,
    columnLock,
    draftColumnLock,
    canInsert,
    columnInfoByName,
    result.columns,
  ]);

  // Key-icon lookups for the header (PK = amber, FK = sky), HeidiSQL-style.
  const pkNameSet = useMemo(
    () => new Set(pkColumnNames ?? []),
    [pkColumnNames],
  );
  const fkNameSet = useMemo(
    () => new Set(fkColumnNames ?? []),
    [fkColumnNames],
  );

  /**
   * Size a column to its widest *visible* value — HeidiSQL's double-click on
   * the column's edge, which is the gesture people reach for when a value is
   * clipped and they'd rather read it in place than open the cell editor.
   *
   * Widths are measured off-screen (`computeColumnFitWidth`) rather than by
   * letting the browser do it: the table is `table-fixed`, so there is no
   * `width: auto` shrink-to-fit pass to borrow — the declared header widths
   * *are* the layout, and a column's content never influences it. Measuring
   * the strings ourselves is also what keeps this honest about what's on
   * screen: the same formatting the `cell` renderer applies (BIT display
   * mode, the NULL placeholder, the `truncateLongTextAt` cap) is replayed
   * here, so the fit matches the rendered text and not the raw value.
   *
   * Scope is the rows currently in the grid (`visibleRows`, i.e. the fetched
   * page after the client filter), matching HeidiSQL: fitting to rows the
   * user can't see would need a full-table scan per double-click.
   */
  function measureFitWidths(colIds: readonly string[]) {
    return computeAutoFitWidths({
      host: scrollRef.current,
      colIds,
      columns: result.columns,
      columnIndexByName,
      rows: visibleRows,
      // The fit has to reproduce what the cell paints, NULL placeholder and
      // length cap included — hence the same two helpers the `cell` renderer
      // below calls, rather than a second copy of the rule.
      cellText: (v, idx) =>
        v === null
          ? nullDisplay
          : truncateForDisplay(
              rawCellText(
                v as CellValue,
                bitColNames.has(result.columns[idx].name),
                bitDisplay,
              ),
              truncateLongTextAt,
            ),
      // gap before the type (4) + the sort glyph and its gap (16) + one key
      // icon and its gap per PK/FK badge (16 each) + the multi-sort rank
      // badge ("1", "2", …) next to the arrow.
      headerChrome: (name) =>
        20 +
        (pkNameSet.has(name) ? 16 : 0) +
        (fkNameSet.has(name) ? 16 : 0) +
        (lockedNameSet.has(name) || insertOnlyNameSet.has(name) ? 16 : 0) +
        ((sort?.length ?? 0) > 1 && sort!.some((s) => s.column === name)
          ? 12
          : 0),
      cellFontSize: (cellStyle.fontSize as number) ?? 12,
      headerFontSize: (headerStyle.fontSize as number) ?? 10,
      typeFontSize: TYPE_HINT_FONT_SIZE,
      min: MIN_COLUMN_WIDTH,
      max: MAX_AUTOFIT_WIDTH,
    });
  }

  function autoFitColumns(colIds: readonly string[]) {
    const widths = measureFitWidths(colIds);
    // One state update (and therefore one `prefs.json` write) for the whole
    // gesture, however many columns it covered.
    if (Object.keys(widths).length > 0) {
      commitWidths((prev) => ({ ...prev, ...widths }));
    }
  }

  /**
   * Fit every column into the width on screen, so the whole row is readable
   * without scrolling sideways.
   *
   * The sibling of `autoFitColumns`, not a replacement for it: that one asks
   * "how wide does this column need to be" and overflows when the answer is
   * "wider than the window", which is right when you are reading one long
   * value. This one asks "show me the whole row" and pays for it in truncation.
   * Both gestures are wanted and neither is the better default, so both are
   * offered — see `distributeToWidth`, which holds the arithmetic and its
   * reasoning.
   *
   * It starts from the *content* fit rather than dividing the width evenly,
   * which is what keeps an `id` column narrow and a `description` wide instead
   * of flattening the table into equal strips.
   *
   * `clientWidth` excludes the vertical scrollbar, so the target is the real
   * content box; the leading gutter is subtracted because it is a fixed column
   * the data columns do not get to spend.
   */
  /** List view has no columns to size; an empty result has nothing to size. */
  const showFitControls = viewMode !== "list" && result.columns.length > 0;

  /**
   * The list view's counterpart to the fit controls: same footer, same
   * question ("how am I looking at this"), same "only where it means
   * something" gating — one sizes columns you can only have in the table, the
   * other unfolds nested objects you can only see in the list.
   *
   * Held as state here rather than pushed down as a prop per card because
   * every card has to hear the same press; see `ExpandAllSignal` for why it
   * is an epoch and not a boolean. The object identity only changes when the
   * gesture fires, so it doesn't defeat `DocumentCard`'s memo in between.
   */
  const showListControls = viewMode === "list" && result.columns.length > 0;
  const [expandAll, setExpandAll] = useState<ExpandAllSignal | null>(null);
  function expandAllDocuments(expanded: boolean) {
    setExpandAll((prev) => ({ epoch: (prev?.epoch ?? 0) + 1, expanded }));
  }

  function fitColumnsToWidth() {
    const port = scrollRef.current;
    if (!port) return;
    const colIds = result.columns.map((c) => c.name);
    const widths = distributeToWidth(
      measureFitWidths(colIds),
      port.clientWidth - GRID_GUTTER_WIDTH,
      MIN_COLUMN_WIDTH,
    );
    if (Object.keys(widths).length > 0) {
      commitWidths((prev) => ({ ...prev, ...widths }));
    }
  }

  /**
   * Live mirror of fkEditCell/inlineEdit/selectedCell, read by the `cell`
   * renderers below instead of closing over the state directly. TanStack's
   * `flexRender` treats `columnDef.cell` as a component TYPE (anything
   * `typeof === "function"` gets rendered as `<Comp {...props} />`), so if
   * these fast-changing values stayed in the `columns` memo's dependency
   * array, every keystroke of an inline edit would rebuild the entire
   * `columns` array with brand-new `cell` function references — React reads
   * that as a different element type for every cell and unmounts + remounts
   * the whole table body, including the input mid-edit. A freshly-mounted
   * `autoFocus` input always plants the caret at the end, which is exactly
   * the "cursor jumps to the end while typing" bug. Updating this ref every
   * render (not via effect) keeps `cell` seeing live state while its own
   * function identity — and therefore the mounted DOM — stays put.
   */
  const interactiveRef = useRef({ fkEditCell, inlineEdit, selectedCell });
  interactiveRef.current = { fkEditCell, inlineEdit, selectedCell };

  // Same idea, for `GridRow` (below): these are plain function declarations
  // recreated on every `DataGrid` render, so passing them as ordinary props
  // would make every row look "changed" on every render and defeat the
  // memoization `GridRow` exists for. See its own doc comment for the full
  // rationale.
  /**
   * Copy a multi-row selection, and say how many rows went.
   *
   * The one clipboard gesture in the grid that reports: copying a single cell
   * is confirmed by the paste a second later, but "copy 24 rows as INSERT"
   * produces nothing on screen at all and the number is the whole question —
   * a selection is easy to get wrong by one row, and you find out in whatever
   * you pasted into.
   */
  function copyRows(
    rows: CellValue[][],
    fmt: "json" | "insert" | "update",
  ) {
    copyToClipboard(bulkCopy(rows, fmt));
    notify.success(t("dataGrid.rowsCopied", { count: rows.length }));
  }

  const rowCallbacksRef = useRef<GridRowCallbacks>({
    openCellEdit,
    openSidePanelEditor,
    copyToClipboard,
    bulkCopy,
    copyRows,
    selectedColumnValues,
    applyRowSelectionClick,
    toggleRowKey,
  });
  rowCallbacksRef.current = {
    openCellEdit,
    openSidePanelEditor,
    copyToClipboard,
    bulkCopy,
    copyRows,
    selectedColumnValues,
    applyRowSelectionClick,
    toggleRowKey,
  };

  // Resolve the relation's schema bindings once, when the grid mounts for a
  // table. One IPC call per data tab — never per cell, and never per render.
  const ensureResolvedSchemas = useJsonSchemas((s) => s.ensureResolved);
  const resolvedSchemas = useJsonSchemas((s) => s.resolved);
  const schemaRevision = useJsonSchemas((s) => s.revision);
  useEffect(() => {
    if (!tableName) return;
    void ensureResolvedSchemas(
      connectionId,
      tableSchema,
      tableName,
      result.columns.map((c) => c.name),
    );
    // `schemaRevision` re-runs it after any library change, since the store
    // clears the cache on every mutation.
  }, [
    connectionId,
    tableSchema,
    tableName,
    result.columns,
    ensureResolvedSchemas,
    schemaRevision,
  ]);

  /**
   * Name of the schema bound to `column`, or `null`.
   *
   * Only used to *signal* — the expand buttons swap their icon and tooltip so the
   * feature is discoverable without opening Settings. Double-click still goes to
   * the inline `CellInput` (ADR #12 stands); only the icon changed.
   */
  const boundSchemaNames = useMemo(() => {
    if (!tableName) return new Map<string, string>();
    const key = relationKey(connectionId, tableSchema, tableName);
    const bucket = resolvedSchemas[key];
    if (!bucket) return new Map<string, string>();
    return new Map(Object.entries(bucket).map(([col, hit]) => [col, hit.name]));
  }, [connectionId, tableSchema, tableName, resolvedSchemas]);

  /**
   * TanStack column definitions — the sortable header and the `cell` renderer.
   *
   * **Preferences are passed as individual values, never as the `useGridPrefs`
   * bundle.** Rebuilding these definitions remounts the whole table body (see
   * the hook's own note, and `interactiveRef` below), so the array must track
   * exactly the four preferences the renderer reads and nothing else.
   */
  const columns = useGridColumns({
    resultColumns: result.columns,
    display: {
      numericColNames,
      bitColNames,
      bitDisplay,
      nullDisplay,
      truncateLongTextAt,
      expandCellCombo,
    },
    meta: {
      columnInfoByName,
      columnIndexByName,
      pkNameSet,
      fkNameSet,
      lockedNameSet,
      insertOnlyNameSet,
      boundSchemaNames,
    },
    editing: {
      interactiveRef,
      setFkEditCell,
      setInlineEdit,
      openHeavyEditor,
    },
    sort,
    onSortChange,
    connectionId,
    tableSchema,
    onCellSave,
  });

  const table = useReactTable({
    // List mode renders `DocumentListView`, not this table's `<tbody>` — feed
    // it `NO_ROWS` there so `getCoreRowModel()` doesn't build a `Row`/`Cell`
    // tree (one per row, ~40 `Cell` objects each on a wide table) that
    // nothing reads.
    data: viewMode === "list" ? NO_ROWS : visibleRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Column resizing is handled by our own `startColumnResize`, not
    // TanStack's built-in `getResizeHandler()` — see `useColumnSizing` for why.
    // `columnSizing` stays the single source of truth for committed widths.
    state: { columnSizing },
    onColumnSizingChange: commitWidths,
  });

  /**
   * Windows `<tbody>`'s rows so a large result (up to the backend's
   * `MAX_ADHOC_QUERY_ROWS` cap, or any bigger table-data page) never mounts
   * more than a couple dozen real `<tr>`s at once — see the file-header
   * comment; the previous "virtualised by the browser via overflow-auto" was
   * never true, every row was a real DOM node.
   *
   * `estimateSize` returns the *exact* row height (`rowHeight` is one
   * persisted px value applied uniformly via `cellStyle`, ADR #13 — not an
   * estimate to refine later), so no `measureElement`/dynamic measurement is
   * needed; the padding-row technique below is exact from the first paint.
   */
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    // In list mode `scrollRef` is the SAME scroll container, but it now
    // hosts `DocumentListView` instead of this table — leaving the
    // virtualizer enabled there means it keeps listening to that element's
    // `scroll` events while its own virtual size (rowCount × rowHeight, a
    // few thousand px) is wildly out of sync with what's actually scrolling
    // (tens of thousands of px of list content), so its computed range
    // changes on almost every scroll event, each one flushing a full
    // `DataGrid` re-render synchronously (`flushSync`, see the adapter's
    // `shouldRerender` — it's unconditional without `directDomUpdates`,
    // which this grid doesn't pass). `enabled: false` runs `cleanup()`
    // internally (drops the scroll/resize listeners, clears measurements),
    // and it re-subscribes on its own the moment `viewMode` flips back —
    // `getScrollElement` is left untouched on purpose so that happens
    // without any extra wiring here. This looks like a redundant library
    // option until you know that story, which is exactly how it gets
    // deleted in a future cleanup — don't.
    enabled: viewMode !== "list",
  });
  // `estimateSize` alone doesn't retroactively resize rows the virtualizer
  // already cached a size for — `measure()` clears that cache so a Ctrl+wheel
  // zoom (which changes `rowHeight` without touching row *count*) takes
  // effect immediately instead of only on the next scroll. `viewMode` is a
  // dependency for the same reason `rowHeight` is: returning to table mode
  // must not replay a stale measurement cache from before the list-mode
  // detour.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, viewMode, rowVirtualizer]);

  /**
   * The inset-ring active cell plus every key that moves or acts on it. Owns
   * `activeCell`; `setActiveCell` still comes back because a cell *click* sets
   * it too, so the mouse and the keyboard share one position.
   */
  const { activeCell, setActiveCell, handleGridKeyDown } = useGridKeyboardNav({
    grid: {
      table,
      rowVirtualizer,
      scrollRef,
      columns: result.columns,
      columnIndexByName,
    },
    editing: {
      inlineEdit,
      fkEditCell,
      setInlineEdit,
      openCellEdit,
      openHeavyEditor,
    },
    selectedCell,
    setSelectedRowIndex,
    columnInfoByName,
    bitColNames,
    bitDisplay,
    expandCellCombo,
    editable,
    columnLock,
    onPasteBlock,
    onCellSave,
  });

  /** Serialise several rows for the bulk "Copy N rows as ▸" menu. */
  function bulkCopy(rows: CellValue[][], fmt: "json" | "insert" | "update") {
    return toBulk(rows, fmt, {
      columns: result.columns,
      driver,
      tableName,
      pkColumnNames,
    });
  }

  return (
    // `relative` allows CellPreview to be positioned absolute within this container.
    <div className="relative flex h-full flex-col">
      <GridToolbar
        toolbarLeading={toolbarLeading}
        insertExtra={insertExtra}
        insertAlternatives={insertAlternatives}
        toolbarTrailing={toolbarTrailing}
        filterInput={filterInput}
        globalFilter={globalFilter}
        onGlobalFilterChange={onGlobalFilterChange}
        onGlobalFilterSubmit={onGlobalFilterSubmit}
        searchHistory={searchHistory}
        serverFilters={serverFilters}
        typedFilterValues={typedFilterValues}
        onRemoveFilter={onRemoveFilter}
        onEditFilter={onEditFilter}
        sort={onSortSpecsChange ? sort : undefined}
        onToggleSort={
          onSortSpecsChange &&
          ((column) => onSortSpecsChange(toggleSortLevel(sort ?? [], column)))
        }
        onRemoveSort={
          onSortSpecsChange &&
          ((column) => onSortSpecsChange(removeSortLevel(sort ?? [], column)))
        }
        queryChips={queryChips}
        onInsertRow={onInsertRow}
        showRowCount={showRowCount}
        visibleRowCount={visibleRows.length}
        total={result.total}
        elapsedMs={result.elapsed_ms}
        truncated={result.truncated}
      />
      {belowToolbar}

      {/* Scrollable data table, wrapped so the refetch overlay covers only the
          grid body (not the toolbar). */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full overflow-auto outline-none"
          // Anything bound at `grid` scope is only audible from in here.
          data-kb-scope="grid"
          // Focusable so it can receive keyboard navigation; a cell click focuses
          // it (below). The active-cell ring is the visible focus affordance, so
          // the container's own outline is suppressed.
          tabIndex={0}
          onKeyDown={viewMode === "list" ? undefined : handleGridKeyDown}
          // Close the cell preview when clicking outside the table cells.
          onClick={() => setSelectedCell(null)}
        >
          {viewMode === "list" ? (
            <DocumentListView
              scrollRef={scrollRef}
              columns={result.columns}
              rows={visibleRows}
              rowNumberOffset={rowNumberOffset}
              rowTypes={result.row_types}
              nullDisplay={nullDisplay}
              zebraStripes={zebraStripes}
              fontSize={cellStyle.fontSize}
              expandNested={listExpandNested}
              expandAll={expandAll}
              showTypes={listShowTypes}
              lineNumbers={listLineNumbers}
              onFieldSave={editable ? onFieldSave : undefined}
              onFieldDelete={editable ? onFieldDelete : undefined}
              fieldLock={editable ? columnLock : undefined}
              onDeleteRow={onDeleteRow}
              sort={sort}
              onSortChange={onSortSpecsChange}
              onAddFilter={onAddFilter}
              // MongoDB addresses a nested field by its dotted path, in a sort
              // as in a filter; a SQL `ORDER BY`/`WHERE` names a column, so
              // there only top-level fields get those menu entries.
              nestedPaths={driver === "mongodb"}
              onExpandField={(rowValues, path, value, type) =>
                openHeavyEditor(
                  rowValues,
                  // Synthetic column: the heavy editor only reads the name (as
                  // its title) and the commit is routed by `field` below.
                  { name: path.join("."), data_type: type },
                  value,
                  { path, type },
                )
              }
              copyToClipboard={copyToClipboard}
              emptyLabel={t("dataGrid.noRows")}
              // Resolved here, against the very array passed as `rows` above
              // and in the same render, so the index cannot be carried across
              // two different arrays — which is the failure ADR #7 is about,
              // not indices as such.
              flashedRowIndex={flashedRowIndex}
              flashedPath={flashed ? flashed.path.join(".") : null}
              draft={
                draftRow && onDraftCellChange && onDraftCommit && onDraftCancel
                  ? {
                      row: draftRow,
                      columns: draftColumns ?? [],
                      // Same switch the cards use: only the MongoDB tab supplies
                      // the `$unset` callback, and only there is a field's type a
                      // per-document choice.
                      documentMode: !!onFieldDelete,
                      bitDisplay,
                      connectionId,
                      tableSchema,
                      focusRef: firstDraftInputRef,
                      columnLock: draftColumnLock,
                      onChange: onDraftCellChange,
                      onCommit: onDraftCommit,
                      onCancel: onDraftCancel,
                    }
                  : null
              }
            />
          ) : (
            <>
              {/* `select-none`: row range-select via Shift+Click otherwise also
            drags a native text selection across the rows (issue #30). Inline
            cell-edit inputs keep their own selection (form controls override
            an ancestor's user-select), and copying goes through the row
            context menu / cell preview panel rather than raw text selection. */}
              <table className="w-full table-fixed select-none border-separate border-spacing-0 text-left">
                <thead
                  className={
                    stickyHeader ? "sticky top-0 z-10 bg-card" : "bg-card"
                  }
                >
                  {table.getHeaderGroups().map((hg) => {
                    // Left offset of each pinned column's sticky `<th>`, in the
                    // columns' own display order (not pin order) — the gutter is
                    // always pinned first, so every pinned data column starts
                    // counting from its width.
                    const pinnedLeftById = new Map<string, number>();
                    let pinnedLeftAcc = GRID_GUTTER_WIDTH;
                    for (const h of hg.headers) {
                      if (!pinnedColumnSet.has(h.column.id)) continue;
                      pinnedLeftById.set(h.column.id, pinnedLeftAcc);
                      pinnedLeftAcc += h.getSize();
                    }
                    return (
                      <tr key={hg.id}>
                        <th
                          className="sticky left-0 z-20 border-b border-border border-r border-r-border bg-card px-2 py-1 font-semibold uppercase tracking-wider text-muted-foreground"
                          style={{ ...headerStyle, width: GRID_GUTTER_WIDTH }}
                        >
                          {selectionEnabled ? (
                            <Checkbox
                              className="align-middle"
                              ref={(el) => {
                                if (el) el.indeterminate = someSelected;
                              }}
                              checked={allSelected}
                              onChange={toggleSelectAll}
                              aria-label={
                                allSelected
                                  ? t("dataGrid.deselectAll")
                                  : t("dataGrid.selectAll")
                              }
                              title={
                                allSelected
                                  ? t("dataGrid.deselectAll")
                                  : t("dataGrid.selectAll")
                              }
                            />
                          ) : (
                            "#"
                          )}
                        </th>
                        {hg.headers.map((h) => {
                          const isPinned = pinnedColumnSet.has(h.column.id);
                          return (
                            <th
                              key={h.id}
                              data-col-id={h.column.id}
                              className={cn(
                                // Slightly elevated surface (`card` over the grid's
                                // `background`) + semibold, per the brand language: the
                                // header is a label strip, not another data row.
                                "group/th relative border-b border-border border-r border-r-border bg-card px-2 py-1 font-semibold uppercase tracking-wider text-muted-foreground transition-colors duration-150",
                                resizingColId === h.column.id && "bg-brand/10",
                                // Pinned columns stick to the offset accumulated above;
                                // z-20 so their (already-opaque) bg-card paints over
                                // whatever scrolls underneath, and over the plain
                                // sticky <thead>'s own z-10.
                                isPinned && "sticky z-20",
                              )}
                              style={{
                                ...headerStyle,
                                width: h.getSize(),
                                ...(isPinned
                                  ? { left: pinnedLeftById.get(h.column.id) }
                                  : {}),
                              }}
                            >
                              <div className="flex items-center gap-1 overflow-hidden">
                                <div className="min-w-0 flex-1 overflow-hidden">
                                  {flexRender(
                                    h.column.columnDef.header,
                                    h.getContext(),
                                  )}
                                </div>
                                {/* Pin toggle — always visible once pinned (so it
                          reads as a persistent state, not a hover-only
                          affordance), otherwise revealed on hover like the
                          resize handle below. */}
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    togglePin(h.column.id);
                                  }}
                                  title={
                                    isPinned
                                      ? t("dataGrid.unpinColumn")
                                      : t("dataGrid.pinColumn")
                                  }
                                  className={cn(
                                    "shrink-0 rounded-sm p-0.5 text-muted-foreground/70 hover:text-foreground",
                                    isPinned
                                      ? "inline-block text-brand"
                                      : "hidden group-hover/th:inline-block",
                                  )}
                                >
                                  <Pin
                                    className={cn(
                                      "h-3 w-3",
                                      isPinned && "fill-current",
                                    )}
                                  />
                                </button>
                              </div>
                              {/* Drag handle — thin strip on the column's trailing edge.
                        `select-none` stops text selection while dragging. */}
                              <div
                                onMouseDown={(e) =>
                                  startColumnResize(
                                    e,
                                    h.column.id,
                                    h.column.getSize(),
                                  )
                                }
                                // Double-click = fit the column to its content
                                // (HeidiSQL), Ctrl/Cmd held = fit every column at once.
                                // Routed through `click` + `detail`, not `onDoubleClick`:
                                // some Linux WebKitGTK builds never fire `dblclick`
                                // inside a `user-select: none` subtree (this table sets
                                // it globally), the same quirk the cells work around —
                                // see the `e.detail >= 2` note in `GridRow`.
                                onClick={(e) => {
                                  if (e.detail < 2) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  autoFitColumns(
                                    e.ctrlKey || e.metaKey
                                      ? result.columns.map((c) => c.name)
                                      : [h.column.id],
                                  );
                                }}
                                title={t("dataGrid.resizeHandleHint")}
                                className={cn(
                                  "absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-brand/50",
                                  resizingColId === h.column.id && "bg-brand",
                                )}
                              />
                            </th>
                          );
                        })}
                        {/* Filler column: absorbs any leftover width itself, so
                    real columns never get proportionally stretched by the
                    browser's fixed-table-layout algorithm (which otherwise
                    makes a resized column's rendered width outrun the
                    cursor — see `startColumnResize`). Needs a matching
                    empty cell in every row below, not just here. */}
                        <th className="border-b border-border bg-card" />
                      </tr>
                    );
                  })}
                </thead>
                <tbody>
                  {draftRow && (
                    <DraftRowView
                      rowRef={draftRowRef}
                      firstInputRef={firstDraftInputRef}
                      columns={result.columns}
                      draftColumns={draftColumns ?? []}
                      draft={draftRow}
                      connectionId={connectionId}
                      tableSchema={tableSchema}
                      tableName={tableName}
                      bitDisplay={bitDisplay}
                      columnLock={draftColumnLock}
                      onChange={onDraftCellChange}
                      onCommit={onDraftCommit}
                      onCancel={onDraftCancel}
                    />
                  )}
                  {(() => {
                    const virtualRows = rowVirtualizer.getVirtualItems();
                    // +2: the gutter column and the filler `<th>`'s matching `<td>`
                    // (see the header's own comment on the filler column).
                    const colSpan = result.columns.length + 2;
                    return (
                      <>
                        {virtualRows.length > 0 && (
                          <tr aria-hidden>
                            <td
                              colSpan={colSpan}
                              style={{
                                height: virtualRows[0].start,
                                padding: 0,
                                border: 0,
                              }}
                            />
                          </tr>
                        )}
                        {virtualRows.map((virtualRow) => {
                          const i = virtualRow.index;
                          const row = tableRows[i];
                          // `rowValues` is the underlying payload (CellValue[]) for
                          // this row — used to resolve identity below rather than
                          // `i`, which is the *filtered display index*.
                          const rowValues = row.original as CellValue[];
                          const rowKey = selectionEnabled
                            ? (getRowKey?.(rowValues) ?? null)
                            : null;
                          // Every prop below is narrowed to "does this concern THIS
                          // row" (isSelected/isMultiSelected/activeColIdx/
                          // inlineEditHere/fkEditHere) or already stable across a
                          // plain click, so `GridRow`'s
                          // `React.memo` skips re-rendering every row except the (at
                          // most two) actually affected — see `GridRow`'s doc comment.
                          return (
                            <GridRow
                              key={row.id}
                              row={row}
                              rowIndex={i}
                              rowNumber={rowNumber(rowNumberOffset, i)}
                              isSelected={selectedRowIndex === i}
                              isMultiSelected={
                                rowKey !== null && selectedKeys.has(rowKey)
                              }
                              rowKey={rowKey}
                              activeColIdx={
                                activeCell?.r === i ? activeCell.c : null
                              }
                              // Same shape as `activeColIdx`: the parent
                              // answers "which column of *this* row", so the
                              // row never has to know about the flash state.
                              flashedColIdx={
                                flashed && rowKey === flashed.rowKey
                                  ? // The table view paints one cell per
                                    // top-level column, so a nested field
                                    // pulses the cell that contains it.
                                    (columnIndexByName.get(flashed.path[0]) ??
                                    null)
                                  : null
                              }
                              inlineEditHere={
                                inlineEdit && inlineEdit.rowValues === rowValues
                                  ? inlineEdit
                                  : null
                              }
                              fkEditHere={
                                fkEditCell && fkEditCell.rowValues === rowValues
                                  ? fkEditCell
                                  : null
                              }
                              selectionEnabled={selectionEnabled}
                              hasSelection={hasSelection}
                              selectedRows={selectedRows}
                              zebraStripes={zebraStripes}
                              cellStyle={cellStyle}
                              pinnedColumnSet={pinnedColumnSet}
                              resultColumns={result.columns}
                              columnIndexByName={columnIndexByName}
                              columnInfoByName={columnInfoByName}
                              driver={driver}
                              tableName={tableName}
                              pkColumnNames={pkColumnNames}
                              editable={editable}
                              columnLock={columnLock}
                              onCellSave={onCellSave}
                              onNavigateFk={onNavigateFk}
                              onAddFilter={onAddFilter}
                              onInsertRow={onInsertRow}
                              onDuplicateRow={onDuplicateRow}
                              onDeleteRow={onDeleteRow}
                              onBulkDelete={onBulkDelete}
                              scrollRef={scrollRef}
                              setSelectedRowIndex={setSelectedRowIndex}
                              setActiveCell={setActiveCell}
                              setSelectedCell={setSelectedCell}
                              callbacksRef={rowCallbacksRef}
                            />
                          );
                        })}
                        {virtualRows.length > 0 && (
                          <tr aria-hidden>
                            <td
                              colSpan={colSpan}
                              style={{
                                height:
                                  rowVirtualizer.getTotalSize() -
                                  virtualRows[virtualRows.length - 1].end,
                                padding: 0,
                                border: 0,
                              }}
                            />
                          </tr>
                        )}
                      </>
                    );
                  })()}
                  {visibleRows.length === 0 && !draftRow && (
                    <tr>
                      <td colSpan={result.columns.length + 2}>
                        <EmptyState
                          size="sm"
                          icon={Inbox}
                          title={t("dataGrid.noRows")}
                          className="h-auto"
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
        {/* Refetch overlay: dims the (stale) rows and shows a spinner so a
            reload doesn't look frozen. pointer-events-none keeps the stale
            data interactive. Initial load is handled by the caller's skeleton. */}
        {loading && (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center bg-background/40"
            aria-hidden
          >
            <Spinner size="lg" className="mt-6 text-brand" />
          </div>
        )}
      </div>

      {/* Footer: "how you're browsing" (zoom · pagination), kept apart from
          the header's "what you're doing to the data" actions. No
          `justify-end` here — the caller anchors its own left (zoom) and
          right (pagination) groups so they land on opposite edges instead of
          bunching together. Omitted entirely when the caller has nothing to
          put here (query/view result tabs, which don't paginate). */}
      {(footer || showFitControls || showListControls) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-1.5 text-xs">
          {/* Column sizing sits with the row-height zoom, not in the header.
              Both answer "how am I looking at this", which is what the footer
              row is for — the header is data actions (insert, export, filter).
              They lived up there until someone pointed out that the two halves
              of the same question were on opposite edges of the grid.

              Rendered here rather than handed to the caller as footer content
              because the measurement needs the scroll container and the width
              map, neither of which leaves this component. That is also why the
              row now appears for a footerless grid: a query result has columns
              worth fitting and no pagination, so gating the whole row on the
              caller's footer would have taken both gestures away from it. */}
          {showFitControls && (
            <div className="flex items-center">
              <IconButton
                icon={UnfoldHorizontal}
                label={t("dataGrid.fitColumns")}
                onClick={() =>
                  autoFitColumns(result.columns.map((c) => c.name))
                }
              />
              <IconButton
                icon={Columns3}
                label={t("dataGrid.fitColumnsToWidth")}
                onClick={fitColumnsToWidth}
              />
            </div>
          )}
          {showListControls && (
            <div className="flex items-center">
              <IconButton
                icon={ChevronsUpDown}
                label={t("dataGrid.list.expandAllDocuments")}
                onClick={() => expandAllDocuments(true)}
              />
              <IconButton
                icon={ChevronsDownUp}
                label={t("dataGrid.list.collapseAllDocuments")}
                onClick={() => expandAllDocuments(false)}
              />
            </div>
          )}
          {showListControls && footer && (
            <Separator />
          )}
          {/* Column sizing and row zoom are neighbours but not one group, and a
              gap alone does not say so — the same separator `GridToolbar` uses
              between its own groups. Only when something follows: with no
              caller footer (a query result) this cluster is the whole row and a
              trailing rule would divide it from nothing. */}
          {showFitControls && footer && (
            <Separator />
          )}
          {footer}
        </div>
      )}

      {/* Compact cell preview panel — gated by the `cellPreview` grid pref.
          When disabled, selecting a cell stays pure navigation (the heavy
          editor is still reachable via double-click / context menu). */}
      {cellPreview && selectedCell && (
        <CellPreview
          columnName={selectedCell.column.name}
          value={selectedCell.value}
          connectionId={connectionId}
          onClose={() => setSelectedCell(null)}
          onFullscreen={() => {
            openHeavyEditor(
              selectedCell.rowValues,
              selectedCell.column,
              formatValue(selectedCell.value),
            );
            setSelectedCell(null);
          }}
          onSave={
            editable && onCellSave && !columnLock?.(selectedCell.column.name)
              ? async (v) => {
                  await onCellSave(
                    selectedCell.rowValues,
                    selectedCell.column.name,
                    v,
                  );
                  setSelectedCell(null);
                }
              : undefined
          }
          onSetNull={
            editable && onCellSave && !columnLock?.(selectedCell.column.name)
              ? async () => {
                  await onCellSave(
                    selectedCell.rowValues,
                    selectedCell.column.name,
                    null,
                  );
                  setSelectedCell(null);
                }
              : undefined
          }
        />
      )}

      {/* Full Monaco editor (escalated from CellPreview or double-click). */}
      {editorTarget && (
        <CellEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          initialValue={editorTarget.value}
          columnName={editorTarget.column.name}
          ownerId={tabId}
          binding={bindingContextFor(editorTarget.column, editorTarget.field)}
          readonly={
            !editable ||
            !(editorTarget.field ? onFieldSave : onCellSave) ||
            !!editorLocked
          }
          onSave={
            // Quiet: `CellEditor` stays open on failure and renders the message
            // beside the value that caused it (`cellEditor.saveFailed`).
            editable &&
            !editorLocked &&
            (editorTarget.field ? onFieldSaveQuiet : onCellSaveQuiet)
              ? async (newValue) => {
                  const field = editorTarget.field;
                  if (field) {
                    await onFieldSaveQuiet!(
                      editorTarget.rowValues,
                      field.path,
                      newValue,
                      field.type,
                    );
                  } else {
                    await onCellSaveQuiet!(
                      editorTarget.rowValues,
                      editorTarget.column.name,
                      newValue,
                    );
                  }
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
