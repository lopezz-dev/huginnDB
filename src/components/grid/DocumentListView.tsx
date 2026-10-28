/**
 * The data grid's **list view**: one card per row, one `key : value` line per
 * field, MongoDB-Compass style.
 *
 * Why it exists: a wide or deeply nested row (a MongoDB document, but equally a
 * 40-column SQL table or a JSONB blob) is unreadable in a table — it scrolls
 * horizontally and every nested value collapses into a single unreadable JSON
 * line. Here each field gets its own line, nested objects/arrays fold, and the
 * type of every field is visible in the right gutter.
 *
 * It is an *editor*, not just a viewer:
 *
 * - double-click a value → inline edit, committed on Enter/blur (the same
 *   immediate per-field commit the table view uses, through the same
 *   `update_cell` command);
 * - the expand button escalates to the heavyweight Monaco editor, exactly as
 *   the table's inline editor does — that is how a whole sub-document is
 *   edited as JSON;
 * - on MongoDB only, the type gutter is a picker (rewriting the field with the
 *   chosen BSON type), fields can be added (`$set` on a new path) and removed
 *   (`$unset`, behind the destructive-action confirmation). SQL rows have a
 *   fixed column set, so those three affordances are hidden there — a column is
 *   not a per-row thing.
 * - a whole new row/document is inserted here too, as a draft card pinned above
 *   the documents (`DraftDocumentCard`) — the same draft state and the same
 *   `insert_row` call the table view's pinned draft row uses, so view mode
 *   changes how the draft is drawn and nothing about what it writes.
 *
 * Two structural notes:
 *
 * - Every mutation addresses its field by **path**, never by a display index —
 *   the list is filtered/sorted client-side just like the table (ADR #7),
 *   and a nested field has no index to speak of.
 * - Per-card state (folds, the field being edited, the draft field) lives in
 *   `DocumentCard`, so editing one document never re-renders the others. Cards
 *   are keyed by position, which is what makes folds survive the refetch that
 *   follows every commit.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { notify } from "@/lib/notify";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Filter,
  FilterX,
  Inbox,
  Maximize2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  DraftCellControl,
  firstEditableColumn,
  isAutoPkColumn,
} from "@/components/grid/DraftCellControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { toJson as rowToJson } from "@/lib/grid/copyFormats";
import { formatValue } from "@/lib/grid/formatValue";
import { rowNumber } from "@/lib/grid/pagination";
import { removeSortLevel, sortLevelOf, sortOnly } from "@/lib/grid/sortSpec";
import {
  BSON_TYPES,
  defaultText,
  displayValue,
  draftTypeFor,
  editText,
  flattenDocument,
  isValidForType,
  nextArrayIndex,
  pathKey,
  typeLabel,
  typeTextFor,
  typeValue,
  type BsonType,
  type DocField,
} from "@/lib/grid/documentTree";
import { cn } from "@/lib/utils";
import type {
  BsonTypeTree,
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ColumnMeta,
  DraftCell,
  DraftRow,
  SortSpec,
} from "@/types";

/**
 * A grid-wide "expand / collapse every nested object" gesture, broadcast to
 * every card at once.
 *
 * An **epoch**, not a plain boolean, because this is an *action* and not a
 * state: each card keeps its own folds (and its own per-card expand-all), so
 * "expand everything" has to be something a card can apply once and then
 * diverge from — pressing it, folding one object by hand, and pressing it
 * again must expand that object back. A boolean prop would already be `true`
 * on the second press and nothing would happen; a counter changes every time.
 *
 * It deliberately does not touch the `listExpandNested` preference: that one
 * answers "how should documents *open*", this one answers "show me everything
 * in what I am looking at right now", and conflating them would make a
 * one-off gesture rewrite a persisted setting.
 */
export interface ExpandAllSignal {
  epoch: number;
  expanded: boolean;
}

/** Commit one field. `path` is the field path from the document root, `value`
 *  the text the editor produced (`null` for SQL NULL / BSON null), `typeHint`
 *  the type it should be written as. */
export type FieldSave = (
  rowValues: CellValue[],
  path: string[],
  value: string | null,
  typeHint?: string,
) => Promise<void>;

interface DocumentListViewProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** Per-cell BSON type trees (MongoDB only) — see `QueryResult.row_types`. */
  rowTypes?: BsonTypeTree[][] | null;
  nullDisplay: string;
  zebraStripes: boolean;
  /** Font size inherited from the grid "zoom" (`gridPrefs.rowHeight`). */
  fontSize?: string | number;
  /** Whether nested containers start expanded (`gridPrefs.listExpandNested`). */
  expandNested: boolean;
  /** The grid's last "expand/collapse all" press — see {@link ExpandAllSignal}.
   *  `null` on a surface that offers no such control. */
  expandAll?: ExpandAllSignal | null;
  showTypes: boolean;
  lineNumbers: boolean;
  /** Rows before this page on the server, so each card's number is absolute
   *  (`rowNumber`). Display only; defaults to 0 off the paginated browse. */
  rowNumberOffset?: number;
  /** Absent when the relation isn't writable (no PK, read-only result). */
  onFieldSave?: FieldSave;
  /** MongoDB only: `$unset` a field. Absent → no delete/add/type affordances,
   *  which is also what tells this component it is rendering a SQL row. */
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
  /**
   * Why the policy will not let the person change a top-level field (ADR
   * #113), or `null`. A locked field reads as any read-only one: no inline
   * edit, retype or removal. Stable identity expected (it reaches the memo).
   */
  fieldLock?: (field: string) => string | null;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  /** Escalate a field to the heavyweight (Monaco) editor. */
  onExpandField?: (
    rowValues: CellValue[],
    path: string[],
    value: string,
    type: string,
  ) => void;
  copyToClipboard: (text: string) => void;
  emptyLabel: string;
  /**
   * The grid's scroll container, owned by `DataGrid` and shared with the table
   * view. Needed because this list windows its cards against it — see the note
   * on the virtualizer below.
   */
  scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * The just-saved pulse (`useSavedCellFlash`), split into "which document" and
   * "which field" because this component keys documents by position and fields
   * by dotted path. The parent resolves the row key against the very `rows`
   * array it passes here, in the same render, so the index cannot drift the way
   * ADR #7 warns about — it is not carried across two different arrays.
   */
  flashedRowIndex?: number | null;
  flashedPath?: string | null;
  /** Inline INSERT card, pinned above the documents. Absent → this surface
   *  isn't insertable (a pipeline preview, a read-only query result). */
  draft?: ListDraft | null;
  /**
   * The browse's server-side sort, and the seam that replaces it. This view
   * has no column headers, so a field's context menu is where "sort by this"
   * lives here — the same "order by *this*" a plain header click means in the
   * table view (`sortOnly`, not an added level). Absent → no sort entries.
   */
  sort?: SortSpec[];
  onSortChange?: (next: SortSpec[]) => void;
  /** Push a server-side filter — the table view's "Filter by this value",
   *  offered on a field here. Absent → no filter entries. */
  onAddFilter?: (f: ColumnFilter) => void;
  /**
   * Whether a nested field can be sorted and filtered on by its dotted path.
   * True on MongoDB, where `sort()` and `find()` both take one; false on SQL,
   * where `ORDER BY` and `WHERE` name a column, so only top-level fields do.
   */
  nestedPaths?: boolean;
}

/**
 * Everything the list view needs to render an inline INSERT as a card.
 *
 * The state itself lives where the table view's draft row already keeps it
 * (`TableDataTab`), and the commit goes through the very same `insert_row`
 * call: switching view mode changes how the draft is *drawn*, never what it
 * writes. That is also why the field set is the result's column list rather
 * than a free-form document builder — on MongoDB those are the top-level keys
 * of the current page, and extra fields are added to the new document with the
 * per-document `+` once it exists.
 */
export interface ListDraft {
  row: DraftRow;
  /** Catalog info per column (PK / nullable / FK / type), when available. */
  columns: ColumnInfo[];
  /** MongoDB: each field may be written as a chosen BSON type. */
  documentMode: boolean;
  bitDisplay: "true_false" | "zero_one";
  connectionId?: string;
  tableSchema?: string;
  /** Receives the first editable control, so the grid can focus it on mount. */
  focusRef?: MutableRefObject<HTMLElement | null>;
  /** Why the policy will not let the person fill a field (ADR #113). */
  columnLock?: (column: string) => string | null;
  onChange: (column: string, cell: DraftCell) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * The four callbacks `DocumentCard` needs from its caller, mirrored through
 * `callbacksRef` (the same pattern as `DataGrid`'s `interactiveRef` /
 * `rowCallbacksRef` and `GridRow`'s own `callbacksRef`). `DocumentCard` is
 * `memo()`-wrapped, but `onFieldSave`/`onFieldDelete`/`onDeleteRow` arrive
 * here as plain function declarations from `TableDataTab` and `onExpandField`
 * as an inline arrow from `DataGrid` — all four get a fresh identity on every
 * render of a component several layers up, which used to defeat the memo on
 * every single card, every single render, regardless of whether that row's
 * own data had changed. Reading them from a ref instead of a prop means the
 * memo only compares `rowValues`/`columns`/`types` and the boolean
 * capability flags below — the actual functions are always read fresh, at
 * call time, without ever being part of the props diff.
 */
interface DocumentCardCallbacks {
  onFieldSave?: FieldSave;
  onFieldDelete?: (rowValues: CellValue[], path: string[]) => Promise<void>;
  onDeleteRow?: (rowValues: CellValue[]) => void;
  onExpandField?: (
    rowValues: CellValue[],
    path: string[],
    value: string,
    type: string,
  ) => void;
  copyToClipboard: (text: string) => void;
  onSortChange?: (next: SortSpec[]) => void;
  onAddFilter?: (f: ColumnFilter) => void;
  /** Read at call time by "remove from the sort", like every callback here. */
  sort: SortSpec[];
}

/** Field-row copy, precomputed once per language rather than once per field
 *  row — see the `useTranslation()` call below for why. */
interface DocFieldLabels {
  addField: string;
  ctxCopy: string;
  ctxDeleteRow: string;
  deleteField: string;
  collapse: string;
  expand: string;
  expandAll: string;
  collapseAll: string;
  expandEditor: string;
  opaqueType: string;
  changeType: string;
}

/** The empty sort, one identity for every render that has none — a fresh `[]`
 *  per render would break every card's memo. */
const NO_SORT: SortSpec[] = [];

export function DocumentListView({
  columns,
  rows,
  rowTypes,
  nullDisplay,
  zebraStripes,
  fontSize,
  expandNested,
  expandAll,
  showTypes,
  lineNumbers,
  rowNumberOffset = 0,
  onFieldSave,
  onFieldDelete,
  fieldLock,
  onDeleteRow,
  onExpandField,
  copyToClipboard,
  emptyLabel,
  scrollRef,
  flashedRowIndex,
  flashedPath,
  draft,
  sort,
  onSortChange,
  onAddFilter,
  nestedPaths = false,
}: DocumentListViewProps) {
  const { t, i18n } = useTranslation();
  /**
   * One `useTranslation()` subscription for the whole page of cards, instead
   * of one per `DocumentCard` and one per `FieldRow` (up to ~100 + ~4,000 on
   * a page of wide documents — each a live i18next subscription, each
   * re-rendering on a language change). All nine strings here are static (no
   * interpolation), so they're resolved once into plain strings and handed
   * down as `labels`, which stays referentially stable across renders that
   * don't actually change the language.
   *
   * Deliberately depends on `i18n.language`, not `t` — `t`'s own identity is
   * stable in react-i18next, so keying off it would just re-run this memo on
   * every render for no reason; keying off the language is what actually
   * needs to invalidate these precomputed strings on a live language switch.
   */
  const labels: DocFieldLabels = useMemo(
    () => ({
      addField: t("dataGrid.list.addField"),
      ctxCopy: t("dataGrid.ctxCopy"),
      ctxDeleteRow: t("dataGrid.ctxDeleteRow"),
      deleteField: t("dataGrid.list.deleteField"),
      collapse: t("dataGrid.list.collapse"),
      expand: t("dataGrid.list.expand"),
      expandAll: t("dataGrid.list.expandAll"),
      collapseAll: t("dataGrid.list.collapseAll"),
      expandEditor: t("dataGrid.expandEditor"),
      opaqueType: t("dataGrid.list.opaqueType"),
      changeType: t("dataGrid.list.changeType"),
    }),
    [i18n.language],
  );

  const callbacksRef = useRef<DocumentCardCallbacks>({
    onFieldSave,
    onFieldDelete,
    onDeleteRow,
    onExpandField,
    copyToClipboard,
    onSortChange,
    onAddFilter,
    sort: sort ?? NO_SORT,
  });
  callbacksRef.current = {
    onFieldSave,
    onFieldDelete,
    onDeleteRow,
    onExpandField,
    copyToClipboard,
    onSortChange,
    onAddFilter,
    sort: sort ?? NO_SORT,
  };

  /**
   * Windowing, because a page here is not a page of rows — it is a page of
   * *documents*, each expanded into one line per field. At the largest page
   * size that is 500 cards of a dozen-plus fields each, so the table view's
   * hundreds of DOM nodes become this view's thousands, all of them built in
   * one synchronous commit. That is the pause when switching from table to list
   * on a large collection, and the reason scrolling never felt right
   * afterwards.
   *
   * Dynamic measurement, unlike the table's virtualizer next door. There every
   * row is exactly `rowHeight` tall so `estimateSize` is the truth and no
   * measurement is needed; here a card's height is its field count, which
   * varies per document and changes when a nested container is folded. So each
   * card reports its real height through `measureElement`, and `estimateSize`
   * only has to be close enough to keep the scrollbar honest before the first
   * measurement lands — the header plus a line per top-level field.
   *
   * It shares `DataGrid`'s scroll container rather than introducing one of its
   * own. That element is also what the table's virtualizer watches, which is
   * why that one is explicitly disabled in list mode (see its note); two
   * virtualizers on one scroller, each with a different idea of the content
   * height, is exactly the fight that note describes.
   */
  const estimatedCardHeight = useMemo(() => {
    const line = typeof fontSize === "number" ? fontSize + 8 : 20;
    return 28 + Math.max(1, columns.length) * line;
  }, [fontSize, columns.length]);

  /**
   * The scroll element as *state*, not read straight off the ref.
   *
   * The ref belongs to a `<div>` this component is rendered *inside*, and React
   * attaches host refs bottom-up in the same commit pass that runs layout
   * effects — so a child's layout effect runs before its parent's ref is set.
   * The virtualizer's own setup is a layout effect, so reading
   * `scrollRef.current` there gets `null`, and nothing re-renders this
   * component afterwards to make it look again: the list windows against
   * nothing and shows an empty container of the right height.
   *
   * A passive effect runs after the whole commit, when the ref is populated,
   * and setting state from it costs one extra render on mount and makes the
   * dependency explicit instead of relying on the parent happening to re-render
   * for some other reason. (`DataGrid`'s own virtualizer has no such problem —
   * it renders the ref'd `<div>` itself, so its effects see it attached.)
   */
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setScrollEl(scrollRef.current);
  }, [scrollRef]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimatedCardHeight,
    overscan: 4,
  });

  // An empty relation gets the shared branded empty frame, the same one the
  // table view shows in place of its rows — an unadorned grey line here was the
  // one place the list view fell out of that family. Suppressed while a draft
  // card is open: the surface is no longer empty, it is a form.
  if (rows.length === 0 && !draft) {
    return <EmptyState size="sm" icon={Inbox} title={emptyLabel} />;
  }
  return (
    <div>
      {/* The draft is pinned above the window, not inside it: it is one card at
          a known position and virtualising it would mean it could scroll out of
          view while it holds unsaved input. */}
      {draft && (
        <div className="border-b border-border/60">
          <DraftDocumentCard
            columns={columns}
            fontSize={fontSize}
            showTypes={showTypes}
            draft={draft}
          />
        </div>
      )}
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const i = virtualRow.index;
          const rowValues = rows[i];
          return (
            <div
              key={i}
              // `data-index` + `measureElement` is how the virtualizer learns
              // this card's real height; without both it keeps the estimate and
              // the scrollbar drifts as you go.
              data-index={i}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full border-b border-border/60"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <DocumentCard
                key={i}
                rowNumber={rowNumber(rowNumberOffset, i)}
                columns={columns}
                rowValues={rowValues}
                types={rowTypes?.[i]}
                nullDisplay={nullDisplay}
                striped={zebraStripes && i % 2 === 1}
                fontSize={fontSize}
                expandNested={expandNested}
                expandAll={expandAll ?? null}
                showTypes={showTypes}
                lineNumbers={lineNumbers}
                // Capabilities as booleans, not the functions themselves — see
                // `DocumentCardCallbacks` above. Each `!!x` is recomputed on every
                // render, but a boolean's IDENTITY is itself (`Object.is` on a
                // primitive), so the memo still bails out whenever the capability
                // hasn't actually changed.
                // A primitive, so the memo below still bails out for every card
                // except the one holding the pulse.
                flashedPath={
                  flashedRowIndex === i ? (flashedPath ?? null) : null
                }
                documentMode={!!onFieldDelete}
                hasFieldSave={!!onFieldSave}
                fieldLock={fieldLock}
                hasDeleteRow={!!onDeleteRow}
                hasExpandField={!!onExpandField}
                sort={sort ?? NO_SORT}
                canSort={!!onSortChange}
                canFilter={!!onAddFilter}
                nestedPaths={nestedPaths}
                t={t}
                labels={labels}
                callbacksRef={callbacksRef}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The list view's inline INSERT: one card of `key : <control>` lines, pinned
 * above the documents exactly where the table view pins its draft row.
 *
 * Two deliberate differences from that row:
 *
 * - **Focus leaving the card does not commit.** The row commits on blur because
 *   a grid row is a strip of cells you tab out of; a card is a form, and it
 *   hosts a Radix type picker whose popover lives in a portal *outside* the
 *   card — a blur-commit would fire the INSERT the moment the user opened that
 *   picker. Enter or "Save" commits, Esc or "✕" discards.
 * - **On MongoDB every field carries its own BSON type**, written into the
 *   draft cell and sent as `insert_row`'s type hint. Inferring it from the text
 *   would store `"301353073"` as an `Int32` where the collection holds a
 *   `Long`, which is the fidelity trap ADR #29 documents one level up.
 */
function DraftDocumentCard({
  columns,
  fontSize,
  showTypes,
  draft,
}: {
  columns: ColumnMeta[];
  fontSize?: string | number;
  showTypes: boolean;
  draft: ListDraft;
}) {
  const { t } = useTranslation();
  const infoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draft.columns) m.set(c.name, c);
    return m;
  }, [draft.columns]);
  const firstEditableIdx = useMemo(
    () => firstEditableColumn(columns, infoByName, draft.columnLock),
    [columns, infoByName, draft.columnLock],
  );
  const saving = draft.row.saving;

  function handleKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      draft.onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      draft.onCommit();
    }
  }

  return (
    <div
      className="border-l-2 border-l-primary bg-primary/5 px-3 py-2"
      onKeyDown={handleKeyDown}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 text-3xs font-medium text-primary">
          {saving ? "…" : "+"}
        </span>
        <span className="text-3xs uppercase text-muted-foreground/70">
          {draft.documentMode
            ? t("dataGrid.list.newDocument")
            : t("dataGrid.list.newRow")}
        </span>
        <span className="text-3xs text-muted-foreground/50">
          {t("dataGrid.list.insertHint")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={saving}
            onClick={draft.onCommit}
          >
            {t("common.save")}
          </Button>
          {/* Card chrome, so it is a real `IconButton` — unlike the inline
              affordances inside a field row below, which cannot be (see the
              note in `uiAdoption.test.ts`). */}
          <IconButton
            icon={X}
            size="xs"
            label={t("common.cancel")}
            disabled={saving}
            onClick={draft.onCancel}
          />
        </span>
      </div>

      <div className="space-y-px" style={{ fontSize }}>
        {columns.map((col, idx) => {
          const cell: DraftCell = draft.row.cells[col.name] ?? {
            value: null,
            touched: false,
          };
          const info = infoByName.get(col.name);
          const type = cell.type ?? draftTypeFor(info?.data_type);
          return (
            <div
              key={col.name}
              className="flex items-center gap-2 font-mono leading-relaxed"
            >
              <span className="w-10 shrink-0" />
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <span className="w-3 shrink-0" />
                <span className="w-32 shrink-0 truncate font-semibold text-foreground/90">
                  {col.name}
                </span>
                <span className="shrink-0 text-muted-foreground/60">:</span>
                <span className="min-w-0 flex-1">
                  <DraftCellControl
                    info={info}
                    cell={cell}
                    saving={saving}
                    autoFocus={idx === firstEditableIdx}
                    focusRef={
                      idx === firstEditableIdx ? draft.focusRef : undefined
                    }
                    connectionId={draft.connectionId}
                    tableSchema={draft.tableSchema}
                    bitDisplay={draft.bitDisplay}
                    locked={draft.columnLock?.(col.name)}
                    onChange={(next) => draft.onChange(col.name, next)}
                  />
                </span>
              </span>
              {showTypes &&
                (draft.documentMode && !isAutoPkColumn(info) ? (
                  // The picker's own Enter / Escape must not reach the card's
                  // keyboard handler below, which reads them as "insert now" /
                  // "discard the draft". Radix renders the popover in a portal,
                  // but a portal still bubbles through the *React* tree, so the
                  // guard has to sit here rather than on the content.
                  <span
                    className="shrink-0"
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Select
                      value={typeValue(type)}
                      onValueChange={(v) =>
                        draft.onChange(col.name, {
                          ...cell,
                          type: v as BsonType,
                        })
                      }
                    >
                      <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BSON_TYPES.map((bsonType) => (
                          <SelectItem
                            key={bsonType}
                            value={bsonType}
                            className="text-xs"
                          >
                            {typeLabel(bsonType)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                ) : (
                  <span className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60">
                    {info?.data_type ?? col.data_type}
                  </span>
                ))}
            </div>
          );
        })}
      </div>

      {draft.row.error && (
        <div className="mt-1 rounded-sm bg-destructive/10 px-2 py-1 text-3xs text-destructive">
          {draft.row.error}
        </div>
      )}
    </div>
  );
}

interface DocumentCardProps {
  /** The number shown in the card's header — display only, never identity. */
  rowNumber: number;
  /** Dotted path of the field pulsing in *this* document, or `null`. */
  flashedPath: string | null;
  columns: ColumnMeta[];
  rowValues: CellValue[];
  types?: BsonTypeTree[];
  nullDisplay: string;
  striped: boolean;
  fontSize?: string | number;
  expandNested: boolean;
  /** Stable object identity (it lives in `DataGrid` state), so it only breaks
   *  this card's `memo()` when the gesture actually fires. */
  expandAll: ExpandAllSignal | null;
  showTypes: boolean;
  lineNumbers: boolean;
  /** Derived from which callbacks the caller supplied (see
   *  `DocumentCardCallbacks`) — plain booleans instead of the functions
   *  themselves, so this component's `memo()` reacts to a capability
   *  actually changing rather than to a new function identity on every
   *  render of something several layers up. The functions themselves are
   *  read from `callbacksRef`. */
  documentMode: boolean;
  hasFieldSave: boolean;
  /** See `DocumentListViewProps.fieldLock`. */
  fieldLock?: (field: string) => string | null;
  hasDeleteRow: boolean;
  hasExpandField: boolean;
  /** The active sort — a stable array (the tab's state), so it breaks the memo
   *  only when the sort itself changes. Read for each field's menu. */
  sort: SortSpec[];
  canSort: boolean;
  canFilter: boolean;
  nestedPaths: boolean;
  /** `t`'s own identity is stable in react-i18next, so passing it through
   *  props doesn't fight the memo — only needed here for the few strings
   *  that interpolate a value computed per field (a count, a path, a type
   *  name); everything static comes from `labels` instead. */
  t: TFunction;
  labels: DocFieldLabels;
  callbacksRef: MutableRefObject<DocumentCardCallbacks>;
}

/** Inline edit in flight, narrowed to the one field it belongs to. */
interface EditState {
  key: string;
  text: string | null;
  type: string;
}

/** A field being added: its parent container plus the key/type/value form. */
interface DraftState {
  parent: string[];
  /** Index in the parent's child list to insert after (arrays append, so this
   *  is only used to position the draft row visually). */
  afterKey: string | null;
  key: string;
  type: BsonType;
  text: string;
  inArray: boolean;
}

/**
 * The subset of `FieldRow`'s interaction surface that used to be ~13 inline
 * arrow functions built fresh per field, per render (`~52k` closures on a
 * page of 100 rows × 40 fields wide with the type menu open). `FieldRow` is
 * `memo()`-wrapped, so those inline arrows — a new function identity every
 * time regardless of whether that field actually changed — defeated it just
 * as thoroughly as `DocumentCard`'s own unstable callback props did. Built
 * once per `DocumentCard` render as a ref (the same `interactiveRef` /
 * `rowCallbacksRef` pattern `DataGrid` and `GridRow` already use) rather
 * than per field, and each method takes the field it acts on as an
 * argument instead of closing over one particular field — that's what lets
 * every `FieldRow` share the exact same, stable `actionsRef` object.
 */
interface FieldRowActions {
  openTypeMenu: (key: string) => void;
  closeTypeMenu: () => void;
  toggleFold: (key: string) => void;
  startEdit: (f: DocField) => void;
  editChange: (value: string | null) => void;
  commitEdit: (f: DocField) => void;
  cancelEdit: () => void;
  changeType: (f: DocField, next: BsonType) => void;
  deleteField: (f: DocField) => void;
  addAfter: (f: DocField) => void;
  expandField: (f: DocField) => void;
  sortBy: (f: DocField, desc: boolean) => void;
  unsort: (f: DocField) => void;
  filterBy: (f: DocField, exclude: boolean) => void;
  copyValue: (f: DocField) => void;
}

const DocumentCard = memo(function DocumentCard({
  rowNumber: displayNumber,
  flashedPath,
  columns,
  rowValues,
  types,
  nullDisplay,
  striped,
  fontSize,
  expandNested,
  expandAll,
  showTypes,
  lineNumbers,
  documentMode,
  hasFieldSave,
  fieldLock,
  hasDeleteRow,
  hasExpandField,
  sort,
  canSort,
  canFilter,
  nestedPaths,
  t,
  labels,
  callbacksRef,
}: DocumentCardProps) {
  /**
   * Folds the user toggled, as a *diff* from the `listExpandNested`
   * preference rather than an absolute set: with the preference off a path in
   * here is open, with it on a path in here is closed. Storing the diff is
   * what lets the preference be flipped at runtime without stale per-card
   * state fighting it.
   */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * What the diff above is a diff *from*, when this card has been expanded or
   * collapsed wholesale — `null` means "whatever the preference says".
   *
   * "Expand every object in this document" cannot be expressed as a set of
   * toggles: a nested container that is currently folded contributes no line,
   * so its path is not in `fields` and there is nothing to toggle. Flipping
   * the base the folds are measured against expands the whole tree in one
   * move, at any depth, and costs nothing per level.
   *
   * Initialised from the grid-wide gesture so a card that scrolls into the
   * window *after* "expand all" was pressed mounts already expanded — the
   * virtualizer unmounts off-screen cards, so a freshly mounted one has no
   * history of its own to go on.
   */
  const [baseExpanded, setBaseExpanded] = useState<boolean | null>(
    expandAll?.expanded ?? null,
  );
  const [edit, setEdit] = useState<EditState | null>(null);
  /**
   * Path key of the field whose type picker is open. The picker is mounted
   * only for that one field: a Radix `Select` per line would mean thousands of
   * mounted popovers on a page of wide documents, for a control used once in a
   * while. Closed, it is a plain button showing the type label.
   */
  const [typeMenu, setTypeMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  /** Guards against a blur-commit racing the Enter-commit of the same edit. */
  const committingRef = useRef(false);
  /**
   * `deleteField` awaits a confirm dialog before it acts, which is a real
   * gap now that confirming is a Promise instead of a blocking
   * `window.confirm` — the row this card renders can refresh underneath it
   * while the user is still deciding. Reading `rowValues` (the prop) after
   * that await would use whatever this render closed over, not what the
   * row holds by the time the action actually runs; the ref is always the
   * latest, updated every render exactly like `callbacksRef` above.
   */
  const rowValuesRef = useRef(rowValues);
  rowValuesRef.current = rowValues;

  /**
   * Apply the grid-wide gesture, and let the preference win over a stale
   * per-card override when it changes at runtime.
   *
   * Both are React's documented "adjust state when a prop changes" pattern —
   * set during render, not in an effect, so the card never paints one frame
   * with the old folds before correcting itself.
   *
   * **The "last seen" marker has to be state, not a ref**, and this is the
   * whole reason these two lines are worth a docblock. `StrictMode` (which
   * `main.tsx` wraps the app in) invokes a component's body twice and throws
   * the first pass away — but a ref mutation is not part of what gets thrown
   * away. Written to a ref, the marker was already up to date when the second
   * pass ran, the condition was false, and the `setBaseExpanded` that the
   * discarded pass had queued was the only one there ever was. The result was
   * a card that had demonstrably *seen* the gesture (its marker said so) and
   * was still folded. State is discarded along with the render that set it, so
   * the second pass sees the same "before" value the first one did and queues
   * the update that survives.
   *
   * `toggled` is deliberately cleared with the gesture (it is a diff from a
   * base that just moved, so keeping it would silently invert every hand-made
   * fold) and deliberately kept when only the preference changes, which is the
   * diff semantics the preference has always had.
   */
  const [seenEpoch, setSeenEpoch] = useState(expandAll?.epoch ?? 0);
  if (expandAll && expandAll.epoch !== seenEpoch) {
    setSeenEpoch(expandAll.epoch);
    setBaseExpanded(expandAll.expanded);
    setToggled(new Set());
  }
  const [seenPref, setSeenPref] = useState(expandNested);
  if (seenPref !== expandNested) {
    setSeenPref(expandNested);
    setBaseExpanded(null);
  }

  const base = baseExpanded ?? expandNested;
  const isExpanded = useCallback(
    (key: string) => (toggled.has(key) ? !base : base),
    [toggled, base],
  );

  const fields = useMemo(
    () => flattenDocument(columns, rowValues, types, isExpanded),
    [columns, rowValues, types, isExpanded],
  );

  /** Column catalog type by name, for `typeTextFor` — memoized once per
   *  column list instead of a `columns.find()` per field per render (O(fields
   *  × columns), ~160,000 string comparisons on a page of 100 rows × 40
   *  columns). */
  const columnTypeByName = useMemo(
    () => new Map(columns.map((c) => [c.name, c.data_type])),
    [columns],
  );

  /**
   * Whether every container *on screen* is open, which is what decides
   * whether the card's header button reads "expand all" or "collapse all".
   *
   * Measured against the visible lines rather than the whole document on
   * purpose: a container hidden inside a folded ancestor is not something the
   * user can see the state of, so letting it decide the button's direction
   * would make the control disagree with what is in front of them.
   */
  const hasContainers = fields.some((f) => f.container !== null);
  const allExpanded =
    hasContainers && fields.every((f) => f.container === null || f.expanded);

  /** Open (or fold) every nested object in this document, at any depth. */
  function toggleAll() {
    setBaseExpanded(!allExpanded);
    setToggled(new Set());
  }

  function toggleFold(key: string) {
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** A MongoDB document's `_id` is immutable server-side: `$set` on it errors
   *  and `$unset` would orphan the document. It is read-only here rather than
   *  offering edits that can only fail — the same call Compass makes. */
  function isImmutableId(f: DocField): boolean {
    return documentMode && f.path.length === 1 && f.path[0] === "_id";
  }

  /**
   * Whether the backend can address this field at all. MongoDB takes a dotted
   * update path, so any depth works; a SQL `UPDATE` names a *column*, so only
   * a top-level field is addressable — the contents of a JSON column are
   * edited by rewriting the whole column value (expand it, one level up).
   */
  function isAddressable(f: DocField): boolean {
    return documentMode || f.path.length === 1;
  }

  /** Whether this field's value may be edited inline. */
  function canEdit(f: DocField): boolean {
    return (
      hasFieldSave &&
      f.editable &&
      isAddressable(f) &&
      !isImmutableId(f) &&
      !fieldLock?.(f.path[0] ?? "")
    );
  }

  /** Whether this field may be retyped, removed, or have a sibling added.
   *  Unlike {@link canEdit} this stays true for an opaque type — replacing it
   *  via the type picker is exactly how such a field is edited at all. */
  function canMutate(f: DocField): boolean {
    return (
      documentMode && hasFieldSave && !isImmutableId(f) && !fieldLock?.(f.path[0] ?? "")
    );
  }

  async function save(
    path: string[],
    value: string | null,
    typeHint?: string,
  ): Promise<boolean> {
    const onFieldSave = callbacksRef.current.onFieldSave;
    if (!onFieldSave) return false;
    try {
      await onFieldSave(rowValues, path, value, typeHint);
      return true;
    } catch (e) {
      notify.error(String(e));
      return false;
    }
  }

  function startEdit(f: DocField) {
    if (!canEdit(f)) return;
    setEdit({
      key: pathKey(f.path),
      text:
        f.value === null || f.value === undefined
          ? null
          : editText(f.value, f.type),
      type: f.type,
    });
  }

  async function commitEdit(f: DocField) {
    if (!edit || committingRef.current) return;
    const original =
      f.value === null || f.value === undefined
        ? null
        : editText(f.value, f.type);
    if (edit.text === original) {
      setEdit(null);
      return;
    }
    // A field that was null/undefined has no type to preserve, so the first
    // value typed into it is written as a string — the type picker (MongoDB)
    // is how any other type is chosen deliberately.
    const hint =
      edit.text !== null && (f.type === "null" || f.type === "undefined")
        ? "string"
        : f.type;
    if (edit.text !== null && !isValidForType(hint, edit.text)) {
      notify.error(t("dataGrid.list.invalidValue", { type: typeLabel(hint) }));
      return;
    }
    committingRef.current = true;
    setEdit(null);
    await save(f.path, edit.text, hint);
    committingRef.current = false;
  }

  /**
   * Rewrite the field with a different BSON type. The current value is reused
   * when it is a plausible spelling of the new type, otherwise the type's
   * neutral default is written — switching `String` → `Object` on the text
   * `"hello"` has to produce *something*, and an empty document is the answer
   * that loses the least.
   */
  async function changeType(f: DocField, next: BsonType) {
    if (next === f.type) return;
    const current =
      f.value === null || f.value === undefined
        ? ""
        : editText(f.value, f.type);
    const text = isValidForType(next, current) ? current : defaultText(next);
    await save(f.path, next === "null" ? null : text, next);
  }

  async function deleteField(f: DocField) {
    const onFieldDelete = callbacksRef.current.onFieldDelete;
    if (!onFieldDelete) return;
    if (
      !(await confirmDestructive(
        t("dataGrid.list.confirmDeleteField", { field: pathKey(f.path) }),
      ))
    ) {
      return;
    }
    try {
      // Re-read after the await, not the `rowValues` this render closed
      // over — see `rowValuesRef`'s docblock above.
      await onFieldDelete(rowValuesRef.current, f.path);
    } catch (e) {
      notify.error(String(e));
    }
  }

  /** Open the "new field" form under `f`: inside it when it is an expanded
   *  container, next to it otherwise. */
  function startDraft(f: DocField) {
    const intoContainer = f.container !== null && f.expanded;
    const parent = intoContainer ? f.path : f.path.slice(0, -1);
    const inArray = intoContainer ? f.container === "array" : f.inArray;
    setDraft({
      parent,
      afterKey: pathKey(f.path),
      key: inArray ? String(nextArrayIndex(fields, parent)) : "",
      type: "string",
      text: "",
      inArray,
    });
  }

  async function commitDraft() {
    if (!draft) return;
    const key = draft.key.trim();
    if (!key) {
      notify.error(t("dataGrid.list.fieldNameRequired"));
      return;
    }
    if (draft.type !== "null" && !isValidForType(draft.type, draft.text)) {
      notify.error(
        t("dataGrid.list.invalidValue", { type: typeLabel(draft.type) }),
      );
      return;
    }
    const ok = await save(
      [...draft.parent, key],
      draft.type === "null" ? null : draft.text,
      draft.type,
    );
    if (ok) setDraft(null);
  }

  /** Document-level affordance: "add a field to this document" (the root
   *  counterpart of the per-field `+`). */
  const canAddRootField = documentMode && hasFieldSave;

  // Built fresh every `DocumentCard` render (mirroring `interactiveRef` /
  // `rowCallbacksRef`), NOT memoized with an empty dependency array — its
  // methods close over this render's `edit`/`toggled`/`typeMenu`/`draft`
  // local state, same as `toggleFold`/`startEdit`/etc. themselves. What
  // stays constant across renders is the `actionsRef` OBJECT's identity
  // (it's a ref), which is all `memo(FieldRow)` ever sees as a prop.
  /**
   * The browse column a field is sorted and filtered on, or `null` when it
   * cannot be one.
   *
   * **Array indexes are dropped**, the way the filter builder's paths drop
   * them (ADR #81): `items.0.sku` browses as `items.sku`, and an element of
   * a scalar array as the array itself. That is what the gesture means from a
   * document — "filter by this value" on one tag is "has this tag", which
   * `{ tags: "x" }` is and `{ "tags.0": "x" }` is not, and `sort()` does not
   * read a positional index at all. The list's own paths keep the index
   * because a `$set` has to name one element; that is a different job.
   *
   * Ruled out: a container (ordering or matching on a whole sub-document is
   * legal on MongoDB and almost never what anyone means), and on SQL anything
   * below the top level, because `ORDER BY` and `WHERE` name a column
   * (`nestedPaths`, MongoDB only).
   */
  const browsePaths = useMemo(() => {
    const out = new Map<string, string>();
    for (const f of fields) {
      // Parents precede their children in `fields`, so the parent's entry is
      // always there by the time a child is reached.
      const parent = out.get(pathKey(f.path.slice(0, -1))) ?? "";
      out.set(
        pathKey(f.path),
        f.inArray ? parent : parent ? `${parent}.${f.key}` : f.key,
      );
    }
    return out;
  }, [fields]);
  function browseColumn(f: DocField): string | null {
    if (f.container !== null) return null;
    if (!nestedPaths && f.path.length !== 1) return null;
    return browsePaths.get(pathKey(f.path)) || null;
  }

  function sortDescOf(f: DocField): boolean | null {
    const column = canSort ? browseColumn(f) : null;
    return column ? (sortLevelOf(sort, column)?.desc ?? null) : null;
  }

  // One object, rebuilt every `DocumentCard` render (its methods close over
  // this render's `edit`/`toggled`/`typeMenu`/`draft` local state, same as
  // `toggleFold`/`startEdit`/etc. themselves) and published through a ref.
  // What stays constant across renders is the `actionsRef` OBJECT's identity,
  // which is all `memo(FieldRow)` ever sees as a prop.
  const actions: FieldRowActions = {
    openTypeMenu: (key) => setTypeMenu(key),
    closeTypeMenu: () => setTypeMenu(null),
    toggleFold,
    startEdit,
    editChange: (value) =>
      setEdit((prev) => (prev ? { ...prev, text: value } : prev)),
    commitEdit: (f) => void commitEdit(f),
    cancelEdit: () => setEdit(null),
    changeType: (f, next) => void changeType(f, next),
    deleteField: (f) => void deleteField(f),
    addAfter: startDraft,
    expandField: (f) => {
      const onExpandField = callbacksRef.current.onExpandField;
      if (!onExpandField || !isAddressable(f)) return;
      onExpandField(
        rowValues,
        f.path,
        f.value === null || f.value === undefined
          ? ""
          : editText(f.value, f.type),
        f.type,
      );
    },
    sortBy: (f, desc) => {
      const column = browseColumn(f);
      if (column) callbacksRef.current.onSortChange?.(sortOnly(column, desc));
    },
    unsort: (f) => {
      const column = browseColumn(f);
      const { onSortChange, sort: current } = callbacksRef.current;
      if (column) onSortChange?.(removeSortLevel(current, column));
    },
    filterBy: (f, exclude) => {
      const column = browseColumn(f);
      const onAddFilter = callbacksRef.current.onAddFilter;
      if (!column || !onAddFilter) return;
      // Same shape the table view's cell menu pushes, so a chip made here is
      // indistinguishable from one made there.
      onAddFilter(
        f.value === null || f.value === undefined
          ? { column, op: exclude ? "is_not_null" : "is_null" }
          : { column, op: exclude ? "ne" : "eq", value: f.value },
      );
    },
    copyValue: (f) => callbacksRef.current.copyToClipboard(formatValue(f.value)),
  };
  const actionsRef = useRef<FieldRowActions>(actions);
  actionsRef.current = actions;

  return (
    <div className={cn("group/doc px-3 py-2", striped && "bg-muted/30")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 tabular-nums text-3xs text-muted-foreground">
          {displayNumber}
        </span>
        {/* Unlike the card's other actions this one is always visible, not
            revealed on hover: it is the answer to "what is actually in this
            document", which is the question you have before you know whether
            the card is worth pointing at. Hidden when nothing nests — a
            control that would do nothing is worse than no control. */}
        {hasContainers && (
          <IconButton
            size="xs"
            icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
            label={allExpanded ? labels.collapseAll : labels.expandAll}
            className="-ml-1 shrink-0"
            onClick={toggleAll}
          />
        )}
        <span className="text-3xs uppercase text-muted-foreground/50">
          {t("dataGrid.fieldsCount", { count: columns.length })}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover/doc:opacity-100">
          {canAddRootField && (
            <IconButton
              icon={Plus}
              label={labels.addField}
              onClick={() =>
                setDraft({
                  parent: [],
                  afterKey: null,
                  key: "",
                  type: "string",
                  text: "",
                  inArray: false,
                })
              }
            />
          )}
          <IconButton
            icon={Copy}
            label={labels.ctxCopy}
            onClick={() =>
              callbacksRef.current.copyToClipboard(
                rowToJson(rowValues, columns),
              )
            }
          />
          {hasDeleteRow && (
            <IconButton
              icon={Trash2}
              tone="destructive"
              label={labels.ctxDeleteRow}
              onClick={() => callbacksRef.current.onDeleteRow?.(rowValues)}
            />
          )}
        </span>
      </div>

      <div className="space-y-px" style={{ fontSize }}>
        {draft && draft.afterKey === null && (
          <DraftRow
            draft={draft}
            depth={0}
            onChange={setDraft}
            onCommit={() => void commitDraft()}
            onCancel={() => setDraft(null)}
          />
        )}
        {fields.map((f, i) => {
          const key = pathKey(f.path);
          const editing = edit?.key === key;
          return (
            <div key={key}>
              <FieldRow
                field={f}
                line={i + 1}
                lineNumbers={lineNumbers}
                showTypes={showTypes}
                typeText={typeTextFor(f, documentMode, columnTypeByName)}
                nullDisplay={nullDisplay}
                editing={editing}
                isFlashing={key === flashedPath}
                editText={edit?.text ?? null}
                canEdit={canEdit(f)}
                canMutate={canMutate(f)}
                canExpand={hasExpandField && isAddressable(f)}
                typeMenuOpen={typeMenu === key}
                sortable={canSort && browseColumn(f) !== null}
                sortDesc={sortDescOf(f)}
                filterable={canFilter && browseColumn(f) !== null}
                labels={labels}
                actionsRef={actionsRef}
              />
              {draft && draft.afterKey === key && (
                <DraftRow
                  draft={draft}
                  depth={f.container && f.expanded ? f.depth + 1 : f.depth}
                  onChange={setDraft}
                  onCommit={() => void commitDraft()}
                  onCancel={() => setDraft(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface FieldRowProps {
  /** This field's write just landed — pulse it once. See
   *  `useSavedCellFlash`. */
  isFlashing: boolean;
  field: DocField;
  line: number;
  lineNumbers: boolean;
  showTypes: boolean;
  typeText: string;
  nullDisplay: string;
  editing: boolean;
  editText: string | null;
  canEdit: boolean;
  /** MongoDB: the add/delete/retype gutter is available. */
  canMutate: boolean;
  /** Whether the expand-to-Monaco button is shown for this field. */
  canExpand: boolean;
  /** Whether this row's type picker is the one currently mounted. */
  typeMenuOpen: boolean;
  /** The context menu offers "sort by this field". */
  sortable: boolean;
  /** This field's direction in the sort, or `null` when it isn't in it. A
   *  primitive, so a sort change re-renders only the fields it touches. */
  sortDesc: boolean | null;
  /** The context menu offers "filter by this value". */
  filterable: boolean;
  labels: DocFieldLabels;
  /** Stable across renders — see `FieldRowActions`. Every method takes the
   *  field it acts on, so `FieldRow` never needs a field-specific callback
   *  identity to stay memo-safe. */
  actionsRef: MutableRefObject<FieldRowActions>;
}

const FieldRow = memo(function FieldRow({
  field: f,
  line,
  lineNumbers,
  showTypes,
  typeText,
  nullDisplay,
  editing,
  isFlashing,
  editText: text,
  canEdit,
  canMutate,
  canExpand,
  typeMenuOpen,
  sortable,
  sortDesc,
  filterable,
  labels,
  actionsRef,
}: FieldRowProps) {
  const isNull = f.value === null || f.value === undefined;
  const row = (
    <div
      className={cn(
        "group/field flex items-center gap-2 font-mono leading-relaxed hover:bg-accent",
        // "It saved." Same one-shot pulse the table view gives a cell, on the
        // field the list view actually draws — a nested `customData.format`
        // edit pulses that line, not the whole document.
        isFlashing && "rounded-sm animate-brand-flash",
      )}
    >
      {/* Left gutter: per-field actions, revealed on hover so the reading
          rhythm of the document isn't broken by a column of icons. */}
      <span className="flex w-10 shrink-0 items-center justify-end gap-0.5">
        {canMutate && (
          <>
            <IconButton
              size="xs"
              icon={Trash2}
              tone="destructive"
              revealOnHover="field"
              label={labels.deleteField}
              onClick={() => actionsRef.current.deleteField(f)}
            />
            <IconButton
              size="xs"
              icon={Plus}
              revealOnHover="field"
              flat={false}
              label={labels.addField}
              onClick={() => actionsRef.current.addAfter(f)}
            />
          </>
        )}
      </span>
      {lineNumbers && (
        <span className="w-6 shrink-0 select-none text-right tabular-nums text-3xs text-muted-foreground/50">
          {line}
        </span>
      )}
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingLeft: f.depth * 14 }}
      >
        {f.container ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground/70 hover:text-foreground"
            onClick={() => actionsRef.current.toggleFold(pathKey(f.path))}
            title={f.expanded ? labels.collapse : labels.expand}
          >
            {f.expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 font-semibold text-foreground/90">
          {f.key}
        </span>
        <span className="shrink-0 text-muted-foreground/60">:</span>
        {editing ? (
          // No inline "set NULL" button here (there used to be one) — same
          // one-stray-click risk `CellInput` dropped it for, and the same
          // fix: `canExpand`'s full-editor escalation still takes `null` as
          // a deliberate typed value.
          <input
            autoFocus
            className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
            placeholder={text === null ? nullDisplay : ""}
            value={text ?? ""}
            onChange={(e) => actionsRef.current.editChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                actionsRef.current.commitEdit(f);
              } else if (e.key === "Escape") {
                e.preventDefault();
                actionsRef.current.cancelEdit();
              }
            }}
            onBlur={() => actionsRef.current.commitEdit(f)}
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              canEdit && "cursor-text",
              isNull
                ? "italic text-muted-foreground"
                : f.container
                  ? "text-muted-foreground"
                  : valueClass(f.type),
            )}
            title={f.editable ? undefined : labels.opaqueType}
            onDoubleClick={() =>
              f.container
                ? actionsRef.current.toggleFold(pathKey(f.path))
                : actionsRef.current.startEdit(f)
            }
          >
            {displayValue(f, nullDisplay)}
          </span>
        )}
        {canExpand && (
          <IconButton
            size="xs"
            icon={Maximize2}
            revealOnHover="field"
            label={labels.expandEditor}
            className="shrink-0"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => actionsRef.current.expandField(f)}
          />
        )}
      </span>
      {showTypes &&
        (canMutate && typeMenuOpen ? (
          <Select
            open
            value={typeValue(f.type)}
            onOpenChange={(open) => !open && actionsRef.current.closeTypeMenu()}
            onValueChange={(v) => {
              actionsRef.current.closeTypeMenu();
              actionsRef.current.changeType(f, v as BsonType);
            }}
          >
            <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
              <SelectValue>{typeText}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BSON_TYPES.map((type) => (
                <SelectItem key={type} value={type} className="text-xs">
                  {typeLabel(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : canMutate ? (
          <button
            type="button"
            className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60 hover:text-foreground"
            title={labels.changeType}
            onClick={() => actionsRef.current.openTypeMenu(pathKey(f.path))}
          >
            {typeText}
          </button>
        ) : (
          <span className="w-32 shrink-0 truncate px-1 text-right text-3xs text-muted-foreground/60">
            {typeText}
          </span>
        ))}
    </div>
  );
  // No menu while the value is being edited: a right-click inside the input
  // belongs to the text field (paste, select all), not to the document.
  if (editing) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <FieldMenuItems
          field={f}
          sortable={sortable}
          sortDesc={sortDesc}
          filterable={filterable}
          actionsRef={actionsRef}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * A field's context menu. Its own component so its `useTranslation()` (the
 * labels interpolate the field's path) is paid only while a menu is open —
 * Radix mounts the content lazily — rather than once per field row.
 *
 * Sorting here *replaces* the sort, like a plain header click in the table
 * view; building a multi-level sort is the toolbar's "Sort by" menu's job (see
 * `lib/grid/sortSpec.ts`).
 */
function FieldMenuItems({
  field: f,
  sortable,
  sortDesc,
  filterable,
  actionsRef,
}: {
  field: DocField;
  sortable: boolean;
  sortDesc: boolean | null;
  filterable: boolean;
  actionsRef: MutableRefObject<FieldRowActions>;
}) {
  const { t } = useTranslation();
  const field = pathKey(f.path);
  const isNull = f.value === null || f.value === undefined;
  return (
    <>
      <ContextMenuLabel>
        {field}
        {isNull ? " · NULL" : ""}
      </ContextMenuLabel>
      {sortable && (
        <>
          <ContextMenuAction
            icon={ArrowUp}
            label={t("dataGrid.sort.byAsc", { field })}
            disabled={sortDesc === false}
            onSelect={() => actionsRef.current.sortBy(f, false)}
          />
          <ContextMenuAction
            icon={ArrowDown}
            label={t("dataGrid.sort.byDesc", { field })}
            disabled={sortDesc === true}
            onSelect={() => actionsRef.current.sortBy(f, true)}
          />
          {sortDesc !== null && (
            <ContextMenuAction
              icon={X}
              label={t("dataGrid.sort.removeField", { field })}
              onSelect={() => actionsRef.current.unsort(f)}
            />
          )}
          <ContextMenuSeparator />
        </>
      )}
      {filterable && (
        <>
          <ContextMenuAction
            icon={Filter}
            label={t("dataGrid.ctxFilterBy")}
            onSelect={() => actionsRef.current.filterBy(f, false)}
          />
          <ContextMenuAction
            icon={FilterX}
            label={t("dataGrid.ctxFilterExcluding")}
            onSelect={() => actionsRef.current.filterBy(f, true)}
          />
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuAction
        icon={Copy}
        label={t("dataGrid.ctxCopy")}
        onSelect={() => actionsRef.current.copyValue(f)}
      />
    </>
  );
}

/** The "new field" form row: key, type and value, committed as one `$set`. */
function DraftRow({
  draft,
  depth,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: DraftState;
  depth: number;
  onChange: (next: DraftState) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 font-mono leading-relaxed">
      <span className="w-10 shrink-0" />
      <span className="w-6 shrink-0" />
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="w-3 shrink-0" />
        <input
          autoFocus
          className="h-5 w-32 shrink-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
          placeholder={t("dataGrid.list.fieldName")}
          value={draft.key}
          // An array's new element is appended at its next index: naming it
          // anything else would create a sparse object-like key.
          disabled={draft.inArray}
          onChange={(e) => onChange({ ...draft, key: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
        <span className="shrink-0 text-muted-foreground/60">:</span>
        <input
          className="h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-inherit focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20"
          placeholder={t("dataGrid.list.fieldValue")}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded-sm px-1 text-3xs text-brand hover:underline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCommit}
        >
          {t("common.add")}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-sm px-1 text-muted-foreground/70 hover:text-foreground"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
          title={t("common.cancel")}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
      <Select
        value={draft.type}
        onValueChange={(v) => onChange({ ...draft, type: v as BsonType })}
      >
        <SelectTrigger className="h-5 w-32 shrink-0 border-0 bg-transparent px-1 text-3xs text-muted-foreground/70 focus:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BSON_TYPES.map((type) => (
            <SelectItem key={type} value={type} className="text-xs">
              {typeLabel(type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Colour a scalar by its type, the way a JSON viewer would. */
function valueClass(type: string): string {
  switch (type) {
    case "string":
    case "symbol":
    case "javascript":
      return "text-success";
    case "int":
    case "long":
    case "double":
    case "decimal128":
      return "text-numeric";
    case "bool":
      return "text-warning";
    case "objectId":
    case "uuid":
      return "text-pk";
    case "date":
    case "timestamp":
      return "text-fk";
    default:
      return "text-foreground/80";
  }
}

/**
 * BSON type a *new* field should default to, from the type the collection was
 * sampled as. `describe_table` reports a nested document as `"document"` while
 * the picker (and the backend's type-hint vocabulary) spells it `"object"`, so
 * that one name is translated rather than silently falling through to `string`.
 */
