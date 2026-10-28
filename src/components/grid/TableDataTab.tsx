/**
 * Tab body for browsing one database table. Loads pages via
 * `api.fetchTableData`, supports sort + server-side column filters +
 * row mutations (insert / duplicate / delete), and routes cell edits
 * to `api.updateCell` (requires a PK column to be present in the
 * result set).
 *
 * Insert / Duplicate model: rather than a dialog, the grid renders an
 * inline draft row pinned to the top. The user fills cells like in
 * HeidiSQL — Tab moves between fields, Esc cancels, and clicking
 * outside the row (or pressing Enter) commits the INSERT. If the
 * backend rejects the row, the draft survives with an inline error so
 * the user can fix and retry without losing what they typed.
 *
 * Filtering model: the toolbar input applies a server-side "any column
 * contains" search (case-insensitive `LIKE`/`ILIKE`), committed on
 * Enter (or via the history dropdown / clear button) so each keystroke
 * does not refetch and the history dropdown only collects deliberate
 * queries. The grid's right-click "Filter by this value" pushes
 * structured `ColumnFilter` entries onto `serverFilters`, which
 * compose with the search via `AND`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ListFilter,
  RefreshCw,
  ReplaceAll,
  Rows3,
  Table2,
  Braces,
  FilePlus2,
  Lock,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { NativeSelect } from "@/components/ui/native-select";
import { notify } from "@/lib/notify";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useFilterHistory } from "@/stores/grid/filterHistory";
import { useConnections } from "@/stores/session/connections";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { tableTabTitle } from "@/lib/connectionLabel";
import { useGridSelection } from "@/stores/grid/gridSelection";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { confirmDestructive } from "@/lib/confirmDestructive";
import type {
  CellValue,
  ColumnFilter,
  DraftCell,
  DraftRow,
  Projection,
  QueryResult,
  RowValue,
  SortSpec,
} from "@/types";
import {
  DataGrid,
  type GridToolbarItem,
  type InsertAlternative,
  type QueryChip,
} from "@/components/grid/DataGrid";
import {
  QueryPanel,
  type QueryPanelFocus,
} from "@/components/grid/QueryPanel";
import { GoToRowInput } from "@/components/grid/GoToRowInput";
import { BulkUpdateDialog } from "@/components/grid/dialogs/BulkUpdateDialog";
import { DeleteRowsDialog } from "@/components/grid/dialogs/DeleteRowsDialog";
import { PasteCellsDialog } from "@/components/grid/dialogs/PasteCellsDialog";
import { InsertDocumentDialog } from "@/components/grid/dialogs/InsertDocumentDialog";
import { InsertRowsDialog } from "@/components/grid/dialogs/InsertRowsDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { PAGE_SIZE_OPTIONS } from "@/lib/constants";
import { formatNumber } from "@/lib/utils";
import { runExport } from "@/lib/grid/exportTable";
import { clampRowHeight } from "@/lib/grid/rowHeight";
import { nextOffset, pageWindow, prevOffset } from "@/lib/grid/pagination";
import { collectNestedFieldPaths } from "@/lib/grid/fieldPaths";
import { nextSort } from "@/lib/grid/sortSpec";
import { isNarrowing, wireProjection } from "@/lib/grid/projection";
import { SortByMenuItems, type SortField } from "@/components/grid/SortControls";
import { pickJsonFile } from "@/lib/dialogs";
import { cn } from "@/lib/utils";
import { PolicyLockHint, PolicyVerbNotice } from "@/components/common/PolicyLock";
import { usePolicyColumns, usePolicyLocker } from "@/lib/policy/access";
import { isBitType } from "@/lib/grid/columnKinds";
import { parsePasteBlock } from "@/lib/grid/pasteBlock";
import { planPaste, type PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";
import {
  registerTableRefresh,
  unregisterTableRefresh,
} from "@/lib/grid/tableRefresh";

interface Props {
  /** The owning tab's id — used to scope the grid-selection report. */
  tabId: string;
  connectionId: string;
  schema?: string;
  table: string;
}

interface PendingDelete {
  /**
   * One tuple per row to delete, each parallel to `pkColumns`. A single-row
   * delete is just a one-element list, so the confirmation dialog and the
   * `deleteRows` call handle one and many rows through the same path.
   */
  pkValueRows: CellValue[][];
}

/** Build an empty draft (all cells untouched / NULL). */
function emptyDraft(columnNames: string[]): DraftRow {
  const cells: Record<string, DraftCell> = {};
  for (const c of columnNames) {
    cells[c] = { value: null, touched: false };
  }
  return { cells, error: null, saving: false };
}

/**
 * Build a draft prefilled from an existing row (for Duplicate). Auto-PK
 * columns (PK whose type contains int/serial/rowid) are left untouched
 * so the database picks the next value.
 */
function duplicateDraft(
  resultColumns: string[],
  values: CellValue[],
  pkColumn:
    | { name: string; is_primary_key: boolean; data_type: string }
    | undefined,
  // A column the policy will not let the person fill is left untouched too,
  // so the copy takes the database's default there (ADR #113).
  insertLock?: (column: string) => string | null,
): DraftRow {
  const cells: Record<string, DraftCell> = {};
  const pkIsAuto =
    pkColumn &&
    pkColumn.is_primary_key &&
    /int|serial|rowid/i.test(pkColumn.data_type);
  for (let i = 0; i < resultColumns.length; i++) {
    const name = resultColumns[i];
    if ((pkIsAuto && pkColumn?.name === name) || insertLock?.(name)) {
      cells[name] = { value: null, touched: false };
      continue;
    }
    const v = values[i];
    if (v === null || v === undefined) {
      cells[name] = { value: null, touched: true };
    } else {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      cells[name] = { value: s, touched: true };
    }
  }
  return { cells, error: null, saving: false };
}

// A connection with no filter history yet reads `filterHistory` as
// `undefined`; `?? []` at the DataGrid call site would otherwise hand it a
// fresh array every render, same trap as `NO_ROWS` in `DataGrid.tsx`.
const NO_HISTORY: string[] = [];

export function TableDataTab({ tabId, connectionId, schema, table }: Props) {
  const reportSelection = useGridSelection((s) => s.report);
  const clearSelection = useGridSelection((s) => s.clear);
  const onSelectionChange = useCallback(
    (count: number, total: number) => reportSelection(tabId, count, total),
    [reportSelection, tabId],
  );
  // Drop this tab's selection entry when the tab unmounts (close /
  // disconnect) so the status bar never reads a stale count.
  useEffect(() => () => clearSelection(tabId), [tabId, clearSelection]);
  const loadColumns = useSchema((s) => s.loadColumns);
  // Needed by the DataGrid so its "Copy as SQL …" snippets use the right
  // identifier quoting (backticks for MySQL, brackets for SQL Server, double
  // quotes for PG/SQLite).
  const driver = useConnectionDriver(connectionId);
  // What the managed policy lets the person do on this relation. The browse
  // itself is gated one level up (`PolicyGate`), so everything here is about
  // the verbs of a table they may read.
  const lock = usePolicyLocker(connectionId, { schema, name: table });
  const insertLock = lock("insert");
  const updateLock = lock("update");
  const deleteLock = lock("delete");
  const exportLock = lock("export");
  // On SQL the query panel's expression is a `WHERE` fragment — free SQL, a
  // subquery reads any table — so a rule that limits relations refuses it
  // (`guard::raw_filter`). On MongoDB it is a filter over this one collection.
  const rawLock = driver === "mongodb" ? null : lock("freeSql");
  // Which columns the role may write, when it limits them (ADR #113). Each
  // lock is `undefined` when the verb is not limited, so the grid's paths
  // stay exactly as they were for everyone else.
  const policyColumns = usePolicyColumns(
    connectionId,
    { schema, name: table },
    driver === "mongodb",
  );
  const columnLock = useMemo(
    () =>
      policyColumns.update
        ? (column: string) => policyColumns.lock("update", column)
        : undefined,
    [policyColumns],
  );
  const draftColumnLock = useMemo(
    () =>
      policyColumns.insert
        ? (column: string) => policyColumns.lock("insert", column)
        : undefined,
    [policyColumns],
  );
  const tableKey = `${schema ?? ""}.${table}`;
  // Subscribe to THIS tab's own column entry, not the whole per-connection
  // `columns` map. `loadColumns` (schema.ts) writes a new map reference on
  // every table load (any table, any tab), so subscribing to the map made
  // every already-open table tab on the connection re-render whenever a
  // sibling tab loaded its columns — harmless on its own (this entry stays
  // reference-stable so the effect below still no-ops), but with several
  // tabs open on the same connection each one paid a full re-render for
  // every unrelated tab's first load, which is what made opening tab N+1
  // feel like it was reloading everything instead of just the new table.
  const cols = useSchema(
    (s) => s.byConnection[connectionId]?.columns[tableKey],
  );
  /**
   * Why the column list is missing, when it is. Read as a primitive (a string
   * or `undefined`), so it costs no re-render on unrelated slice writes.
   *
   * The tab used to ignore this entirely: `loadColumns` records the failure,
   * but the effect below only fires while `cols` is absent and its deps do not
   * change when the load rejects, so a failed inference left the tab with no
   * columns, no retry and nothing on screen saying so. On a big MongoDB
   * collection — where inference is a sample over the whole thing and is the
   * load most likely to time out — the visible symptom was the advanced filter
   * silently offering no fields to filter on.
   */
  const colError = useSchema(
    (s) => s.byConnection[connectionId]?.columnErrors[tableKey],
  );
  /** Inference in flight (or not started): no list yet and nothing saying why. */
  const colsLoading = !cols && !colError;

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  // The offset `result` was actually fetched with. `offset` moves the moment
  // an arrow is clicked, while the previous page stays on screen until the new
  // one lands — numbering those stale rows from the new offset would flash
  // page 2's numbers over page 1's rows.
  const [resultOffset, setResultOffset] = useState(0);
  // Row total for the pagination footer, fetched out-of-band from the data
  // page (see `refreshCount`) so an exact `COUNT(*)` never gates the first
  // rows. `null` while the count is in flight (footer shows the range without
  // "/ N"); `totalEstimated` flags a fast engine estimate, rendered as `~N`.
  const [total, setTotal] = useState<number | null>(null);
  const [totalEstimated, setTotalEstimated] = useState(false);
  // Seed the page size from the user's `defaultPageSize` preference. Lazy
  // initialiser: prefs are hydrated before the UI mounts, and the value is a
  // per-tab starting point the dropdown can override — so we deliberately do
  // not subscribe to live changes here.
  const [pageSize, setPageSize] = useState<number>(
    () => usePreferences.getState().prefs.grid.defaultPageSize,
  );
  // Merge the current page size into the dropdown choices so a custom
  // `defaultPageSize` (e.g. 300) still renders a selected option.
  const pageSizeOptions = useMemo(
    () =>
      Array.from(new Set<number>([...PAGE_SIZE_OPTIONS, pageSize])).sort(
        (a, b) => a - b,
      ),
    [pageSize],
  );
  /**
   * Multi-column sort, in precedence order (`sort[0]` is the primary key).
   * A plain header click replaces it with a single key; Ctrl/Cmd+click adds
   * (or cycles) a level. See [[applySort]].
   */
  /**
   * View state restored with the tab (#112). Read once, at mount: from here on
   * the `useState` values below are the working copy and this component pushes
   * changes back out via `setViewState`, so reading it reactively would fight
   * its own writes.
   */
  const restoredViewState = useRef(
    useTabs.getState().tabs.find((t) => t.id === tabId)?.viewState,
  ).current;
  /**
   * "table" vs "list" row layout — this tab's own choice (#131), not a global
   * preference: two windows (or two tabs on the same table) must be able to
   * show it differently. Falls back to the `GridPrefs.documentViewMode`
   * default only when this tab has never had one set, read once here — same
   * non-reactive, read-once-at-mount treatment as `restoredViewState` itself,
   * so a later change to the global default (or another tab's toggle) never
   * yanks an already-open tab.
   */
  const [documentViewMode, setDocumentViewMode] = useState<"table" | "list">(
    () =>
      restoredViewState?.documentViewMode ??
      usePreferences.getState().prefs.grid.documentViewMode,
  );
  const [sort, setSort] = useState<SortSpec[]>(
    () => restoredViewState?.sort ?? [],
  );
  /** Free-text search bound to the toolbar input (uncommitted draft). */
  const [filter, setFilter] = useState(() => restoredViewState?.search ?? "");
  /**
   * The query panel under the toolbar (it replaced the advanced filter dialog
   * of #66). `queryFocus` is the chip the user clicked to open it, as an event
   * — see `QueryPanelFocus` — or `null` when it was opened from its button.
   */
  const [queryOpen, setQueryOpen] = useState(false);
  /** The table's index names for the panel's hint picker — fetched the first
   *  time the panel opens, `null` until then (or when the read fails, which
   *  leaves the picker disabled rather than offering nothing to choose). */
  const [indexNames, setIndexNames] = useState<string[] | null>(null);
  const [queryFocus, setQueryFocus] = useState<QueryPanelFocus | null>(null);
  /** What was actually committed via Enter — drives the backend fetch. */
  const [appliedFilter, setAppliedFilter] = useState(
    () => restoredViewState?.search ?? "",
  );
  // Seed filters from the tab's `initialFilters` (set by FK "go to referenced
  // row" navigation) so the table lands pre-filtered to the master record.
  const tabInitialFilters = useTabs(
    (s) => s.tabs.find((t) => t.id === tabId)?.initialFilters,
  );
  const [serverFilters, setServerFilters] = useState<ColumnFilter[]>(
    // FK navigation wins over the restored set: it is an explicit gesture the
    // user just made, while the restored filters are last session's leftovers.
    () => tabInitialFilters ?? restoredViewState?.filters ?? [],
  );
  /**
   * The query panel's projection, as the user chose it — the key columns are
   * added only on the way to the wire (`wireProjection`, below), so this is
   * also what persists with the tab and what the panel shows.
   */
  const [projection, setProjection] = useState<Projection | undefined>(
    () => restoredViewState?.projection,
  );
  /**
   * The query panel's hand-written expression — a `WHERE` fragment on SQL, a
   * filter document on MongoDB — ANDed with the chips and the search. Applied
   * state, like `serverFilters`: the panel holds the draft.
   */
  const [rawFilter, setRawFilter] = useState<string>(
    () => restoredViewState?.rawFilter ?? "",
  );
  /** The expression as the backend should see it: blank is none. */
  // A restored expression the policy no longer allows is kept (the panel shows
  // it, locked) but not sent: sending it would refuse the whole browse.
  const raw = rawFilter.trim() && !rawLock ? rawFilter : undefined;
  /**
   * The query panel's *Advanced* row, applied: a collation (a name on SQL, a
   * document on MongoDB) and an index hint. Blank is none, like `rawFilter`.
   */
  const [collationText, setCollationText] = useState<string>(
    () => restoredViewState?.collation ?? "",
  );
  const [hintText, setHintText] = useState<string>(
    () => restoredViewState?.hint ?? "",
  );
  const collation = collationText.trim() || undefined;
  const hint = hintText.trim() || undefined;
  // Re-apply when a *new* `initialFilters` array arrives — i.e. the user
  // navigated via FK into a table tab that was already open. The initial mount
  // already seeded `serverFilters` above, so the ref starts at that value and
  // the effect skips it; only a later, distinct array triggers a refilter.
  const appliedInitialRef = useRef(tabInitialFilters);
  useEffect(() => {
    if (tabInitialFilters && tabInitialFilters !== appliedInitialRef.current) {
      appliedInitialRef.current = tabInitialFilters;
      setServerFilters(tabInitialFilters);
      setOffset(0);
    }
  }, [tabInitialFilters]);

  // Publish the committed view state onto the tab so it persists with it
  // (#112, #131). Driven off the same values the backend fetch uses (plus
  // `documentViewMode`, which is purely a display choice), so what is saved is
  // always what was actually applied — never the uncommitted toolbar draft.
  // `setViewState` skips no-op writes, which keeps this from scheduling a disk
  // save on every unrelated re-render.
  const setViewState = useTabs((s) => s.setViewState);
  useEffect(() => {
    setViewState(tabId, {
      filters: serverFilters.length > 0 ? serverFilters : undefined,
      sort: sort.length > 0 ? sort : undefined,
      search: appliedFilter || undefined,
      documentViewMode,
      projection: isNarrowing(projection) ? projection : undefined,
      rawFilter: raw,
      collation,
      hint,
    });
  }, [
    setViewState,
    tabId,
    serverFilters,
    sort,
    appliedFilter,
    documentViewMode,
    projection,
    raw,
    collation,
    hint,
  ]);

  const pushHistory = useFilterHistory((s) => s.push);
  const filterHistory = useFilterHistory((s) => s.byConnection[connectionId]);

  const { t } = useTranslation();
  /**
   * Persisted grid "zoom". The same `gridPrefs.rowHeight` the DataGrid reads;
   * the toolbar +/− buttons nudge it (Ctrl+wheel over the grid does the same).
   * Subscribed as a primitive so the selector stays reference-stable.
   */
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  const updateGrid = usePreferences((s) => s.updateGrid);
  const isMongo = driver === "mongodb";
  const zoomRows = useCallback(
    (delta: number) =>
      updateGrid({ rowHeight: clampRowHeight(rowHeight + delta) }),
    [rowHeight, updateGrid],
  );

  /**
   * Apply the supplied value: refetch from page 0 and, if the query is
   * non-trivial, record it in the per-connection history. The value is
   * passed explicitly (rather than read from `filter`) so callers can
   * commit a value that `setFilter` hasn't flushed yet — e.g. picking a
   * history entry or hitting the clear button.
   */
  function submitFilter(value: string) {
    setAppliedFilter(value);
    setOffset(0);
    if (value.trim().length >= 2) {
      pushHistory(connectionId, value);
    }
  }

  const searchColumns = useMemo(() => cols?.map((c) => c.name) ?? [], [cols]);

  /** Apply a header click to the sort state and refetch from page 0 (a new
   *  ordering shouldn't leave the user stranded mid-table). */
  const applySort = useCallback((column: string, additive: boolean) => {
    setSort((current) => nextSort(current, column, additive));
    setOffset(0);
  }, []);

  /** Replace the sort wholesale — the chips, the "Sort by" menu and the list
   *  view's field menu. Same page reset as a header click. */
  const replaceSort = useCallback((next: SortSpec[]) => {
    setSort(next);
    setOffset(0);
  }, []);

  /** The "Sort by" menu is open (bar dropdown or overflow submenu). Gates the
   *  nested-path walk below, like the filter dialogs gate theirs. */
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  /** A pasted block waiting for its confirmation (ADR #114). */
  const [pendingPaste, setPendingPaste] = useState<PastePlan | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false);

  /**
   * MongoDB's nested field paths for the two filter dialogs, read off the page
   * on screen (`lib/grid/fieldPaths.ts`). `infer_columns` only ever reports
   * top-level fields — it doubles as the grid's column list — so without this
   * the advanced filter could not name `customData.format` while the list view
   * two panels away was rendering, typing and editing it.
   *
   * Computed only while a dialog that shows them is open: the walk is bounded
   * but it is still a walk of every document in the page, and it would
   * otherwise re-run on every fetch for a list nobody is looking at.
   */
  const nestedFieldsWanted =
    isMongo && (queryOpen || bulkUpdateOpen || sortMenuOpen);
  const nestedFields = useMemo(
    () =>
      nestedFieldsWanted && result
        ? collectNestedFieldPaths(result.columns, result.rows, result.row_types)
        : [],
    [nestedFieldsWanted, result],
  );

  /**
   * What the "Sort by" menu offers. SQL: the table's columns, from the catalog
   * — `ORDER BY` names a column and nothing else. MongoDB: the same paths the
   * advanced filter offers (top-level plus nested, array indexes dropped),
   * minus sub-documents, which sort legally and meaninglessly. Built only
   * while the menu is open, for the same reason `nestedFields` is.
   */
  const sortFields: SortField[] = useMemo(() => {
    if (!sortMenuOpen) return [];
    if (isMongo) {
      return nestedFields
        .filter((f) => f.type !== "object" && f.type !== "document")
        .map((f) => ({ path: f.path, type: f.type }));
    }
    return (cols ?? []).map((c) => ({ path: c.name, type: c.data_type }));
  }, [sortMenuOpen, isMongo, nestedFields, cols]);

  /**
   * Every column that participates in the table's PRIMARY KEY, in
   * catalog order. Composite PKs surface multiple entries here; tables
   * without a PK yield an empty list (data is read-only in that case).
   *
   * Using `find` instead of `filter` here used to silently corrupt data
   * on composite-PK tables: the cell-save path would send only the
   * leading column to `update_cell`, and the backend's
   * `WHERE first_pk_col = ?` predicate would match every row sharing
   * that leading value. Always operate on the full list.
   */
  const pkColumns = useMemo(
    () => cols?.filter((c) => c.is_primary_key) ?? [],
    [cols],
  );
  /** Convenience: the first PK column, used for snippet generation and
   *  the (legacy) `RETURNING <pk>` hint on inserts. Do NOT use this for
   *  any UPDATE/DELETE predicate — that needs the full `pkColumns`. */
  const pkColumn = pkColumns[0];
  /** `DataGrid`'s `pkColumnNames` prop — a plain `.map()` on `pkColumns`
   *  would otherwise hand it a new array (and, downstream, a defeated
   *  `GridRow` memo — see that file's header comment) every render. */
  const pkColumnNames = useMemo(
    () => pkColumns.map((c) => c.name),
    [pkColumns],
  );

  /** What the browse and the export send for `projection` — the key columns
   *  added, so a projected row is still one the grid can write to. */
  const wire = useMemo(
    () =>
      wireProjection(projection, {
        document: isMongo,
        keyColumns: pkColumnNames,
      }),
    [projection, isMongo, pkColumnNames],
  );
  const projected = wire !== undefined;
  /** Single-column FK columns, for the grid header key icon (presentational). */
  const fkColumnNames = useMemo(
    () => cols?.filter((c) => c.referenced_table).map((c) => c.name) ?? [],
    [cols],
  );

  // Signature (connection + relation + predicate) the current total was
  // computed for. The count depends only on the WHERE predicate, so
  // sort/offset/page changes reuse it and never re-count; the count request is
  // deduped on this key (StrictMode remount + transient dep-identity changes).
  const countInflightRef = useRef<string | null>(null);

  // `searchColumns` is derived from `cols`, which loads asynchronously after
  // mount. Listing it in `fetchData`'s deps recreated the callback the instant
  // columns arrived, re-firing the `[fetchData]` effect and issuing a second,
  // identical COUNT+SELECT on table open (issue #41). It's only ever sent when
  // a search filter is active, so read it lazily through a ref instead of
  // depending on its identity.
  const searchColumnsRef = useRef(searchColumns);
  searchColumnsRef.current = searchColumns;

  // Signature of the request currently on the wire. React StrictMode (dev)
  // mounts effects twice, and a transient dep-identity change can re-run the
  // fetch effect — either way a byte-identical request must not hit the DB
  // twice (issue #41). We dedupe on the wire: the key is set synchronously
  // before the first `await`, so the StrictMode remount's call sees it and
  // bails; it's cleared in `finally`, so genuine later refetches with the same
  // params still go through.
  const inflightKeyRef = useRef<string | null>(null);

  // The most recently dispatched `fetchData()` call, so `refreshCount` (below)
  // can wait for it to release its pooled connection before asking for one of
  // its own. `fetchTableData` and `countTableRows` used to fire as two
  // genuinely concurrent requests on every table open / predicate change —
  // fine for MongoDB's ~100-connection default pool, but MySQL/Postgres cap
  // at `MAX_CONNECTIONS_SERVER = 5` (`pool.rs`), sized for "a couple of
  // in-flight queries at once". Doubling the concurrent connection demand per
  // open tab saturated that pool with more than a couple of tabs open, which
  // read as "MySQL got slower" even on small tables — a pool-contention
  // regression, not a per-query one (confirmed by profiling: the MySQL
  // estimate query itself runs in single-digit ms). Sequencing restores the
  // pre-regression "1 connection in flight per tab" behaviour without giving
  // up the original point of the split — the data page still renders the
  // moment `fetchTableData` resolves, `refreshCount` just no longer races it
  // for a connection.
  const fetchPromiseRef = useRef<Promise<void> | null>(null);

  const fetchData = useCallback(async () => {
    const reqKey = JSON.stringify({
      connectionId,
      schema,
      table,
      pageSize,
      offset,
      sort,
      serverFilters,
      appliedFilter,
      wire,
      raw,
      collation,
      hint,
    });
    if (inflightKeyRef.current === reqKey) return;
    inflightKeyRef.current = reqKey;
    setLoading(true);
    setError(null);
    try {
      // Always `withCount: false` — the total is fetched separately by
      // `refreshCount` so the exact `COUNT(*)` never blocks these rows from
      // painting (issue #77).
      const r = await api.fetchTableData({
        connectionId,
        schema,
        table,
        limit: pageSize,
        offset,
        order: sort.length ? sort : undefined,
        filters: serverFilters.length ? serverFilters : undefined,
        search: appliedFilter || undefined,
        searchColumns: appliedFilter ? searchColumnsRef.current : undefined,
        projection: wire,
        raw,
        collation,
        hint,
        withCount: false,
      });
      setResult(r);
      setResultOffset(offset);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      // Only clear if a newer fetch hasn't already claimed the slot.
      if (inflightKeyRef.current === reqKey) inflightKeyRef.current = null;
    }
  }, [
    connectionId,
    schema,
    table,
    pageSize,
    offset,
    sort,
    serverFilters,
    appliedFilter,
    wire,
    raw,
    collation,
    hint,
  ]);

  // Fetch the row total independently of the data page. Keyed only on the
  // predicate (filters + committed search) — not on sort/offset/pageSize — so
  // paging and re-sorting reuse the total and never re-count. With no
  // predicate the backend returns a fast engine estimate (rendered `~N`); any
  // filter/search forces an exact count, but it still runs off the data
  // page's critical path so rows appear first.
  const refreshCount = useCallback(async () => {
    const countKey = JSON.stringify({
      connectionId,
      schema,
      table,
      f: serverFilters,
      s: appliedFilter,
      r: raw,
      c: collation,
    });
    if (countInflightRef.current === countKey) return;
    countInflightRef.current = countKey;
    setTotal(null);
    // Let the sibling data fetch (if any) release its pooled connection
    // first — see `fetchPromiseRef`'s comment above `fetchData`. A failed
    // data fetch shouldn't block the count from trying anyway.
    await fetchPromiseRef.current?.catch(() => {});
    try {
      const c = await api.countTableRows({
        connectionId,
        schema,
        table,
        filters: serverFilters.length ? serverFilters : undefined,
        search: appliedFilter || undefined,
        searchColumns: appliedFilter ? searchColumnsRef.current : undefined,
        raw,
        collation,
      });
      setTotal(c.total);
      setTotalEstimated(c.estimated);
    } catch {
      // Non-fatal: the grid pages fine without a total. Leave it null; the
      // footer shows the current range without "/ N".
    } finally {
      if (countInflightRef.current === countKey)
        countInflightRef.current = null;
    }
  }, [connectionId, schema, table, serverFilters, appliedFilter, raw, collation]);

  /**
   * Reload the page **and** the row total — what "refresh" means to a user.
   *
   * `fetchData` alone leaves the footer's total showing whatever it was last
   * counted for, because `refreshCount` only ever ran from its own effect,
   * keyed on the predicate (connection, relation, filters, search). Nothing in
   * that key changes when rows are added or removed, so pressing refresh, or
   * F5, or deleting fifty rows, all left the count stale — and on a collection
   * where the count is the only thing telling you how big it is, a stale one is
   * worse than none.
   *
   * Deliberately **not** used after a cell edit or a bulk update. Those change
   * values, never the number of documents, and an exact count over a filtered
   * predicate is the one genuinely expensive thing on this screen — issue #77
   * moved it off the first-paint path precisely so it would not be paid
   * casually. Paying it per keystroke-committed cell would put it back.
   *
   * Mirrors the two effects below rather than calling them: the fetch promise
   * has to be stashed *before* the count starts, since `refreshCount` awaits it
   * to let the data page release its pooled connection first.
   */
  const reloadAll = useCallback(() => {
    fetchPromiseRef.current = fetchData();
    void refreshCount();
    // Retry the field list too. It is loaded once on mount and never again, so
    // before this a failed inference was permanent for the life of the tab —
    // there was no way to ask for it a second time short of closing and
    // reopening. "Refresh" is exactly when someone expects that to be retried.
    if (!cols) void loadColumns(connectionId, schema, table);
    return fetchPromiseRef.current;
  }, [fetchData, refreshCount, cols, loadColumns, connectionId, schema, table]);

  useEffect(() => {
    if (!cols) loadColumns(connectionId, schema, table);
  }, [cols, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    // Stash the promise before `refreshCount`'s effect (declared next, runs
    // right after this one within the same commit) reads it.
    fetchPromiseRef.current = fetchData();
  }, [fetchData]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  // Registered so the global F5 / Ctrl+R interceptor (App.tsx) can reload
  // this tab's data when it's the active one, instead of the WebView's
  // default full-page reload. Re-registered whenever `reloadAll`'s identity
  // changes so the handler always closes over the current filters/sort/page.
  useEffect(() => {
    registerTableRefresh(tabId, reloadAll);
    return () => unregisterTableRefresh(tabId);
  }, [tabId, reloadAll]);

  /**
   * Indices of every PK column inside `result.columns`, memoised so cell
   * mutations don't re-scan the array on every keystroke. A negative
   * entry means that PK column was excluded from the result set — the
   * editable gate below treats the table as read-only in that case so
   * UPDATE/DELETE never run with an incomplete key.
   */
  const pkColumnIndices = useMemo(() => {
    if (!result || pkColumns.length === 0) return [];
    return pkColumns.map((c) =>
      result.columns.findIndex((rc) => rc.name === c.name),
    );
  }, [result, pkColumns]);

  /**
   * Resolve the row's full PK tuple directly from its payload. Returning
   * one value per `pkColumns` entry — composite PKs ship every value to
   * the backend so the WHERE clause stays unambiguous. Using
   * `row.original` rather than a row index sidesteps the client-side
   * filter / sort reshuffle problem documented in ADR #7.
   */
  function pkValuesFromRow(rowValues: CellValue[]): CellValue[] {
    if (pkColumns.length === 0) throw new Error("Table has no primary key");
    if (pkColumnIndices.some((i) => i < 0))
      throw new Error("Primary-key columns missing from the result set");
    return pkColumnIndices.map((i) => rowValues[i]);
  }

  /**
   * Commit one field of one row, addressed by **path**.
   *
   * A table-view cell is the single-segment case of a list-view field, so both
   * grids commit through here (`onCellSave` = `saveField(row, [column], value)`)
   * — the two used to be near-copies, and the copy is exactly where the type
   * rule below would drift.
   *
   * The `columnType` hint exists so the backend can cast a textual literal
   * server-side where a plain string bind would be coerced wrongly (MySQL
   * `BIT` — see `update_cell`; MongoDB Date/int/long — see `string_to_bson`).
   * Which type to send is **not** uniform:
   *
   * - On MongoDB, prefer the field's real BSON type as reported by
   *   `QueryResult.row_types`, never a guess at the display JSON: `Int32`,
   *   `Int64` and `Double` all arrive as a plain JSON number, so inferring
   *   would silently rewrite a `Long` as an `Int` the first time someone fixed
   *   a typo in it (ADR #29). A dotted path (`customData.format`, `tags.2`)
   *   is what `$set` takes natively.
   * - On the SQL drivers the hint is deliberately IGNORED and the catalog type
   *   wins. `update_cell` reads `columnType` to decide whether a MySQL `BIT`
   *   needs its `CAST(? AS UNSIGNED)` (gotcha #15), and handing it the list
   *   view's inferred `"string"` would both miss the cast and suppress the
   *   backend's catalog fallback. Only a top-level column is addressable there
   *   anyway.
   *
   * The catalog side prefers the schema store (`cols`) over the result set
   * because a MongoDB result reports a generic `"bson"` per column while the
   * store carries the inferred per-field type.
   */
  const saveField = useCallback(
    async (
      rowValues: CellValue[],
      path: string[],
      value: string | null,
      typeHint?: string,
    ) => {
      if (pkColumns.length === 0) {
        throw new Error("Cannot update: table has no primary key");
      }
      const pkValues = pkValuesFromRow(rowValues);
      const column = path.join(".");
      const catalogType =
        cols?.find((c) => c.name === column)?.data_type ??
        result?.columns.find((c) => c.name === column)?.data_type;
      await api.updateCell({
        connectionId,
        schema,
        table,
        pkColumns: pkColumns.map((c) => c.name),
        pkValues,
        column,
        value,
        columnType: isMongo ? (typeHint ?? catalogType) : catalogType,
      });
      await fetchData();
    },
    // `pkValuesFromRow` isn't listed: it's a plain function recreated every
    // render, but it closes over `pkColumns`/`pkColumnIndices` from THIS
    // same render, and both are already listed — so whenever either
    // changes, this callback is rebuilt anyway and picks up a `pkValuesFromRow`
    // that agrees with it. Listing it too would just make eslint happy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pkColumns, cols, result, connectionId, schema, table, isMongo, fetchData],
  );

  /**
   * Table-view cell commit: one column, no type hint of its own.
   *
   * This has to be as stable as `saveField` itself: it's the one that
   * reaches `useGridColumns` as `onCellSave` (`GridColumnsOptions`), whose
   * whole `columns` array is rebuilt — and the entire table body remounted,
   * per that file's "dependency array is load-bearing" note — every time
   * this identity changes.
   */
  const onCellSave = useCallback(
    (rowValues: CellValue[], columnName: string, value: string | null) =>
      saveField(rowValues, [columnName], value),
    [saveField],
  );

  /**
   * List-view field removal — MongoDB `$unset` on the document addressed by
   * its `_id`. Only wired for MongoDB: a SQL row's columns are a property of
   * the table, not of the row, so "remove this field from this row" has no
   * counterpart there (setting it to NULL does, and that is `saveField`).
   */
  async function onFieldDelete(rowValues: CellValue[], path: string[]) {
    const idValue = pkValuesFromRow(rowValues)[0] ?? null;
    await api.unsetField({
      connectionId,
      collection: table,
      idValue,
      field: path.join("."),
    });
    await fetchData();
  }

  /**
   * "Go to referenced row": open (or focus) the table the FK column points at,
   * pre-filtered to the clicked value. Resolves the referenced table/column
   * from the schema-store column metadata (`cols`), which carries the
   * single-column FK reference. No-op for non-FK columns. The referenced table
   * lives in the same connection/database, so we reuse `connectionId`.
   */
  const onNavigateFk = useCallback(
    (columnName: string, value: CellValue) => {
      const col = cols?.find((c) => c.name === columnName);
      if (!col?.referenced_table || !col.referenced_column) return;
      // Both reads are `getState()` snapshots, not subscriptions — neither
      // `profiles` nor the tab list needs to be a dependency here.
      useTabs.getState().open({
        kind: "table",
        title: tableTabTitle(
          useConnections.getState().profiles,
          connectionId,
          col.referenced_table,
        ),
        connectionId,
        schema: col.referenced_schema ?? undefined,
        table: col.referenced_table,
        initialFilters: [{ column: col.referenced_column, op: "eq", value }],
      });
    },
    [cols, connectionId],
  );

  function onAddFilter(f: ColumnFilter) {
    setServerFilters((prev) => {
      const existing = prev.findIndex(
        (p) => p.column === f.column && p.op === f.op,
      );
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = f;
        return next;
      }
      return [...prev, f];
    });
    setOffset(0);
  }

  function onRemoveFilter(index: number) {
    setServerFilters((prev) => prev.filter((_, i) => i !== index));
    setOffset(0);
  }

  /** The toolbar button: open the panel blank-focused, or close it (which
   *  discards an unapplied draft — see `QueryPanel`). */
  const toggleQueryPanel = useCallback(() => {
    setQueryOpen((open) => !open);
    setQueryFocus(null);
  }, []);

  /**
   * Open the query panel on the condition a chip stands for.
   *
   * No id is needed and none exists: `QueryPanel` renders one row per
   * `serverFilters` entry, in order, for every filter shape — so the chip's
   * index *is* the row's. That correspondence is the whole mechanism, and it
   * is stated in the panel's docstring too.
   */
  function onEditFilter(index: number) {
    setQueryOpen(true);
    setQueryFocus((prev) => ({ index, epoch: (prev?.epoch ?? 0) + 1 }));
  }

  /** Stage rows for deletion. With `ui.confirmDestructive` on (default) this
   *  opens the confirmation dialog; with it off the rows are deleted straight
   *  away (the toggle's whole purpose is to skip the prompt). */
  function requestDelete(pkValueRows: CellValue[][]) {
    if (pkValueRows.length === 0) return;
    if (usePreferences.getState().prefs.ui.confirmDestructive) {
      setPendingDelete({ pkValueRows });
    } else {
      void runDelete(pkValueRows).catch((e: unknown) =>
        notify.error(t("tableData.deleteFailedTitle"), {
          description: String(e),
        }),
      );
    }
  }

  function onDeleteRow(rowValues: CellValue[]) {
    try {
      requestDelete([pkValuesFromRow(rowValues)]);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Multi-selection delete — routes the whole selection through the same
   *  confirmation + bulk `deleteRows` call as a single row. */
  function onBulkDelete(rows: CellValue[][]) {
    try {
      requestDelete(rows.map((r) => pkValuesFromRow(r)));
    } catch (e) {
      setError(String(e));
    }
  }

  /** Actually perform the bulk delete and refresh the page. Rejects when the
   *  server refuses: the confirmation dialog says why in place, and with
   *  `ui.confirmDestructive` off (no dialog) `requestDelete` raises a toast. */
  async function runDelete(pkValueRows: CellValue[][]) {
    if (pkColumns.length === 0) return;
    await api.deleteRows({
      connectionId,
      schema,
      table,
      pkColumns: pkColumns.map((c) => c.name),
      pkValueRows,
    });
    setPendingDelete(null);
    await reloadAll();
  }

  /**
   * "Export the full table/collection" — unfiltered, the counterpart of the
   * MongoDB tree's per-collection JSON export (#65), now also available for
   * SQL tables via `exportTable`. A cancelled save dialog is a silent no-op.
   */
  const exportFull = useCallback(() => {
    return runExport(
      () =>
        isMongo
          ? api.exportCollection(connectionId, table)
          : api.exportTable(connectionId, schema, table),
      (path) =>
        notify.file(
          isMongo
            ? t("notifications.fileSaved.collection")
            : t("notifications.fileSaved.table"),
          { path },
        ),
      (message) => notify.error(message),
    );
  }, [isMongo, connectionId, schema, table, t]);

  /**
   * "Export query results" — what the grid shows, without its paging: the
   * query panel's conditions (`serverFilters`), the committed search, the
   * sort and the projection. Identical to `exportFull` when none is active.
   */
  const exportFiltered = useCallback(() => {
    const scan = {
      filters: serverFilters,
      search: appliedFilter || undefined,
      searchColumns: appliedFilter ? searchColumns : undefined,
      order: sort.length ? sort : undefined,
      projection: wire,
      raw,
      collation,
      hint,
    };
    return runExport(
      () =>
        isMongo
          ? api.exportCollection(connectionId, table, scan)
          : api.exportTableRows({ connectionId, schema, table, ...scan }),
      (path) =>
        notify.file(
          isMongo
            ? t("notifications.fileSaved.collection")
            : t("notifications.fileSaved.rows"),
          { path },
        ),
      (message) => notify.error(message),
    );
  }, [
    isMongo,
    connectionId,
    schema,
    table,
    serverFilters,
    appliedFilter,
    searchColumns,
    sort,
    wire,
    raw,
    collation,
    hint,
    t,
  ]);

  /**
   * "Import JSON…" (Mongo only) — the same `import_collection` flow the
   * schema tree used to expose per-collection (#65), now reachable from the
   * DataGrid toolbar instead. Additive (`insert_many`); existing documents
   * sharing an `_id` stop the import, so it still goes through the
   * destructive-write confirmation like the tree version did.
   */
  /** Free-form document insert (MongoDB). Tab-scoped, like the other two
   *  dialogs below — it writes to this tab's collection and nothing else
   *  needs to open it. */
  const [insertDocOpen, setInsertDocOpen] = useState(false);
  /** Bulk row insert from pasted JSON (the SQL drivers). Tab-scoped for the
   *  same reason as its Mongo twin above. */
  const [insertRowsOpen, setInsertRowsOpen] = useState(false);

  const importCollectionJsonForTab = useCallback(async () => {
    const picked = await pickJsonFile(t("schema.importCollection.pickTitle"));
    if (!picked) return;
    if (
      !(await confirmDestructive(
        t("schema.importCollection.confirm", { collection: table }),
      ))
    ) {
      return;
    }
    try {
      const count = await api.importCollection(connectionId, table, picked);
      notify.success(t("schema.importCollection.success", { count }));
      await reloadAll();
    } catch (e) {
      notify.error(String(e));
    }
  }, [t, table, connectionId, fetchData]);

  function onInsertRow() {
    if (!cols || draft) return;
    setDraft(emptyDraft(cols.map((c) => c.name)));
  }

  function onDuplicateRow(rowValues: CellValue[]) {
    if (!result || !cols || draft) return;
    setDraft(
      duplicateDraft(
        result.columns.map((c) => c.name),
        rowValues,
        pkColumn,
        draftColumnLock,
      ),
    );
  }

  function onDraftCellChange(column: string, cell: DraftCell) {
    setDraft((prev) =>
      prev
        ? { ...prev, cells: { ...prev.cells, [column]: cell }, error: null }
        : prev,
    );
  }

  function onDraftCancel() {
    setDraft(null);
  }

  async function onDraftCommit() {
    if (!draft || draft.saving) return;
    const values: RowValue[] = Object.entries(draft.cells)
      .filter(([column, c]) => c.touched && !draftColumnLock?.(column))
      .map(([column, c]) => ({
        column,
        value: c.value,
        // A per-cell type wins over the catalog one: the list view's draft card
        // lets a MongoDB field be written as a chosen BSON type, and only the
        // cell knows about it (see `DraftCell.type`).
        columnType:
          c.type ??
          cols?.find((col) => col.name === column)?.data_type ??
          result?.columns.find((col) => col.name === column)?.data_type,
      }));
    // Empty draft (user never typed) → silently cancel rather than send
    // an `INSERT () VALUES ()` that the backend would reject.
    if (values.length === 0) {
      setDraft(null);
      return;
    }
    setDraft((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      await api.insertRow({
        connectionId,
        schema,
        table,
        pkColumn: pkColumn?.name,
        values,
      });
      setDraft(null);
      await reloadAll();
    } catch (e) {
      setDraft((prev) =>
        prev ? { ...prev, saving: false, error: String(e) } : prev,
      );
    }
  }

  // Which rows this page covers and whether either arrow is live — see
  // `lib/grid/pagination.ts` for the estimated-total rule and its tests.
  const page = pageWindow({
    offset,
    pageSize,
    total,
    totalEstimated,
    rowsOnPage: result?.rows.length ?? 0,
  });
  // Editable iff the table has at least one PK column AND every PK
  // column is present in the result set (otherwise we couldn't build a
  // safe WHERE clause).
  const hasPk =
    pkColumns.length > 0 &&
    (result === null || pkColumnIndices.every((i) => i >= 0));

  /**
   * A block pasted into the grid (ADR #114): work out what it writes — cells
   * by their row's key, new rows from its overflow, and what it leaves out —
   * and ask before sending any of it.
   */
  function onPasteBlock(paste: GridPaste) {
    if (!result) return;
    setPendingPaste(
      planPaste({
        block: parsePasteBlock(paste.text),
        rows: paste.rows,
        columns: paste.columns,
        columnIndexByName: new Map(result.columns.map((c, i) => [c.name, i])),
        pkColumns: pkColumnNames,
        columnInfo: new Map((cols ?? []).map((c) => [c.name, c])),
        bitColumns: new Set(
          result.columns.filter((c) => isBitType(c.data_type)).map((c) => c.name),
        ),
        canUpdate: !updateLock,
        canInsert: !insertLock,
        updateLock: columnLock,
        insertLock: draftColumnLock,
      }),
    );
  }

  async function applyPaste(plan: PastePlan) {
    const summary = await api.applyPaste({
      connectionId,
      schema,
      table,
      pkColumns: pkColumnNames,
      updates: plan.updates,
      inserts: plan.inserts,
    });
    setPendingPaste(null);
    notify.success(
      t("dataGrid.paste.done", { cells: summary.updated, count: summary.inserted }),
    );
    await reloadAll();
  }

  /**
   * Stable identity for a grid row, derived from its payload rather than a
   * display index (ADR #7). Drives the grid's multi-row selection.
   *
   * With a usable PK the key is the PK tuple. Without one it falls back to the
   * full values array: a no-PK table used to get no `getRowKey` at all, which
   * switched `selectionEnabled` off in `DataGrid` and left the user with *no*
   * selection whatsoever — no checkbox column, no Shift range, no Ctrl toggle
   * (the third strand of #113). The fallback is honest about its limit: two
   * byte-identical rows share a key and therefore select together, which a PK
   * would have told apart. That's acceptable here because every gesture the
   * fallback unlocks is read-only — copy, and the `IN` filter — while every
   * mutating path (`editable`, insert/duplicate/delete, bulk delete) stays
   * gated on `hasPk` at the call site below and never sees this key.
   *
   * `useCallback` matters beyond tidiness: `DataGrid` lists `getRowKey` in the
   * deps of the memo that pairs every visible row with its key, so an unstable
   * identity would recompute it on each render of a full page of rows.
   */
  const getRowKey = useCallback(
    (rowValues: CellValue[]): string | null => {
      try {
        return JSON.stringify(hasPk ? pkValuesFromRow(rowValues) : rowValues);
      } catch {
        return null;
      }
    },
    // `pkValuesFromRow` closes over `pkColumns`/`pkColumnIndices`; it is a plain
    // function redeclared each render, so key off its inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasPk, pkColumns, pkColumnIndices],
  );

  // Leading toolbar content folded into the grid's own toolbar (via DataGrid's
  // `toolbarLeading`) so a table tab shows ONE header bar instead of two
  // stacked ones. The schema › table breadcrumb used to live here, but the
  // tab title already shows `database.table` (#57) — repeating it next to the
  // filter was pure redundancy, so the leading area is just the two
  // filter-related actions: refresh, the query panel and the sort. Every
  // other action (add/export/bulk data, pagination, zoom, view toggle) lives
  // in the header's right cluster or the footer instead — see `insertExtra`/
  // `footerContent` below — so this left side stays a small, stable cluster.
  //
  // Every entry declares both a `bar` and a `menu` form, because DataGrid's
  // toolbar is responsive: on a narrow pane these move into its overflow menu
  // rather than wrapping onto a second row (see `GridToolbarItem`). The menu
  // form is a labelled row — which is also the chance to spell out what an
  // icon-only button only implies in a tooltip.
  useEffect(() => {
    if (!queryOpen || indexNames !== null) return;
    let live = true;
    api
      .listIndexes(connectionId, schema, table)
      .then((ix) => live && setIndexNames(ix.map((x) => x.name)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [queryOpen, indexNames, connectionId, schema, table]);

  /**
   * The projection and the expression, as chips under the toolbar — see
   * `GridToolbarProps.queryChips` for why they must be on screen while on.
   */
  const queryChips: QueryChip[] = useMemo(() => {
    const openPanel = () => {
      setQueryOpen(true);
      setQueryFocus(null);
    };
    const out: QueryChip[] = [];
    if (isNarrowing(projection)) {
      const fields = projection.fields.join(", ");
      out.push({
        id: "projection",
        section: t("dataGrid.chipRow.projection"),
        label: projection.exclude
          ? t("dataGrid.chipRow.projectionExcluding", { fields })
          : fields,
        editLabel: t("dataGrid.chipRow.editProjection"),
        removeLabel: t("dataGrid.chipRow.removeProjection"),
        onEdit: openPanel,
        onRemove: () => setProjection(undefined),
      });
    }
    if (collation || hint) {
      out.push({
        id: "advanced",
        section: t("dataGrid.chipRow.advanced"),
        label: [
          collation &&
            t("tableData.query.collationSummary", { value: collation }),
          hint && t("tableData.query.hintSummary", { value: hint }),
        ]
          .filter(Boolean)
          .join(" · "),
        editLabel: t("dataGrid.chipRow.editAdvanced"),
        removeLabel: t("dataGrid.chipRow.removeAdvanced"),
        onEdit: openPanel,
        onRemove: () => {
          setCollationText("");
          setHintText("");
        },
      });
    }
    if (raw) {
      out.push({
        id: "expression",
        section: t("dataGrid.chipRow.expression"),
        // One line: a multi-line expression is read in the panel, not here.
        label: raw.replace(/\s+/g, " ").trim(),
        editLabel: t("dataGrid.chipRow.editExpression"),
        removeLabel: t("dataGrid.chipRow.removeExpression"),
        onEdit: openPanel,
        onRemove: () => {
          setRawFilter("");
          setOffset(0);
        },
      });
    }
    return out;
  }, [projection, raw, collation, hint, t]);

  const leadingToolbar: GridToolbarItem[] = useMemo(
    () => [
      {
        id: "refresh",
        bar: (
          <IconButton
            icon={RefreshCw}
            label={t("tableData.refresh")}
            loading={loading}
            onClick={reloadAll}
          />
        ),
        menu: (
          <DropdownMenuItem
            className="text-xs"
            disabled={loading}
            onSelect={reloadAll}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t("tableData.refresh")}
          </DropdownMenuItem>
        ),
      },
      {
        id: "query-panel",
        bar: (
          // Three states, not two. The panel is built entirely from the field
          // list, so without one it is an empty form — but "still loading" and
          // "failed" are different answers and a disabled button says neither.
          // Inference can take a couple of seconds on a large collection (see
          // `INFER_TIMEOUT_MS`), and a control that is simply dead for that long
          // reads as broken.
          <SimpleTooltip
            label={
              cols
                ? queryOpen
                  ? t("tableData.query.close")
                  : t("tableData.query.open")
                : colError
                  ? t("tableData.filter.schemaFailed", { message: colError })
                  : t("tableData.filter.loadingSchema")
            }
          >
            <Button
              variant="ghost"
              size="icon"
              disabled={!cols}
              onClick={toggleQueryPanel}
              aria-label={t("tableData.query.title")}
              aria-expanded={queryOpen}
              // Brand-tint the icon while filters are active so it reads as "on"
              // and doubles as an at-a-glance indicator, with the count as a badge.
              // The accent fill says the panel itself is open.
              className={cn("relative", queryOpen && "bg-accent")}
            >
              {colsLoading ? (
                <Spinner size="sm" />
              ) : (
                <ListFilter
                  className={cn(
                    "h-3.5 w-3.5",
                    serverFilters.length ? "text-brand" : "",
                  )}
                />
              )}
              {serverFilters.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-1 text-3xs font-semibold text-white">
                  {serverFilters.length}
                </span>
              )}
            </Button>
          </SimpleTooltip>
        ),
        menu: (
          <DropdownMenuItem
            className="text-xs"
            onSelect={toggleQueryPanel}
          >
            <ListFilter
              className={cn(
                "mr-2 h-3.5 w-3.5",
                serverFilters.length ? "text-brand" : "",
              )}
            />
            {queryOpen ? t("tableData.query.close") : t("tableData.query.open")}
            {serverFilters.length > 0 && (
              <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                {serverFilters.length}
              </span>
            )}
          </DropdownMenuItem>
        ),
      },
      {
        // The sort's own entry point. The table view always had one (its
        // headers); the list view had none, which is the gap this closes —
        // and it is offered in both modes so the control is where the user
        // left it when they switch.
        id: "sort-by",
        bar: (
          <DropdownMenu onOpenChange={setSortMenuOpen}>
            <SimpleTooltip label={t("dataGrid.sort.button")}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("dataGrid.sort.button")}
                  className="relative"
                >
                  <ArrowUpDown
                    className={cn("h-3.5 w-3.5", sort.length ? "text-brand" : "")}
                  />
                  {sort.length > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-1 text-3xs font-semibold text-white">
                      {sort.length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
            </SimpleTooltip>
            <DropdownMenuContent align="start" className="max-w-[22rem]">
              <SortByMenuItems
                fields={sortFields}
                sort={sort}
                onChange={replaceSort}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ),
        // A dropdown collapses into a submenu, never a nested dropdown — see
        // `DropdownMenuSubTrigger`.
        menu: (
          <DropdownMenuSub onOpenChange={setSortMenuOpen}>
            <DropdownMenuSubTrigger className="text-xs">
              <ArrowUpDown
                className={cn(
                  "mr-2 h-3.5 w-3.5",
                  sort.length ? "text-brand" : "",
                )}
              />
              {t("dataGrid.sort.button")}
              {sort.length > 0 && (
                <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
                  {sort.length}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-[22rem]">
              <SortByMenuItems
                fields={sortFields}
                sort={sort}
                onChange={replaceSort}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ),
      },
    ],
    // `cols`/`colError`/`colsLoading` are load-bearing here and were missing:
    // the filter button renders from them, and `fetchData` — the only thing in
    // this list that moves on its own — deliberately does NOT depend on `cols`
    // (see its own note on reading `searchColumns` through a ref). So when the
    // field list arrived, nothing in this array changed, the memo kept its
    // first render's JSX, and the button spun forever regardless of how small
    // the collection was. The project runs no `exhaustive-deps` lint by design,
    // so a dependency array is read by hand or not at all — read it.
    [
      reloadAll,
      loading,
      t,
      serverFilters,
      cols,
      colError,
      colsLoading,
      sort,
      sortFields,
      replaceSort,
      queryOpen,
      toggleQueryPanel,
    ],
  );

  // Rendered right beside DataGrid's own "Insert" button (via `insertExtra`),
  // so every action that adds, exports, or mass-edits data reads as one group
  // on the header's right side instead of being split across the toolbar.
  /**
   * The other two ways to add documents to a collection, behind the Insert
   * button's chevron rather than beside it. They were separate toolbar buttons
   * and that was wrong: three controls for one intent, in a bar that already
   * collapses for want of room, when only MongoDB has more than one way in.
   *
   * Data rather than the `{bar, menu}` pairs the slots below use — see
   * `InsertAlternative`. The default action stays what "Insert" means on every
   * other driver, so only the chevron appears or does not.
   */
  const insertAlternatives: InsertAlternative[] = useMemo(
    () =>
      isMongo
        ? [
            {
              id: "insert-document",
              label: t("dataGrid.insertDocument.action"),
              icon: FilePlus2,
              onSelect: () => setInsertDocOpen(true),
            },
            {
              id: "import-collection",
              label: t("schema.importCollection.title"),
              icon: Upload,
              onSelect: () => void importCollectionJsonForTab(),
            },
          ]
        : [
            // Until this existed the array was empty on SQL, which is also
            // what kept the Insert button's chevron from rendering at all
            // there — the split control has been waiting for a second way in.
            {
              id: "insert-rows-json",
              label: t("dataGrid.insertRows.action"),
              icon: Braces,
              onSelect: () => setInsertRowsOpen(true),
            },
          ],
    [isMongo, t, importCollectionJsonForTab],
  );

  const insertExtraContent: GridToolbarItem[] = useMemo(
    () => [
      // MongoDB only: additive JSON import into this collection (#65), moved
      // here from the schema tree's right-click menu so the action lives with
      // the data it affects instead of the tree. SQL has no table-scoped import
      // primitive (only a whole-connection `.sql` batch), so it keeps that entry
      // point in the tree unchanged.
      {
        id: "export-data",
        bar: (
          <DropdownMenu>
            <PolicyLockHint reason={exportLock}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!!exportLock}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("tableData.exportData.label")}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
            </PolicyLockHint>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => void exportFull()}>
                {isMongo
                  ? t("schema.exportCollection.title")
                  : t("tableData.exportData.table")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportFiltered()}>
                {t("tableData.exportData.queryResults")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
        // A dropdown can't collapse into a menu as a nested dropdown (it would
        // portal outside the parent's content and dismiss it), so it becomes a
        // submenu with the very same two choices.
        menu: (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-xs" disabled={!!exportLock}>
              <Download className="mr-2 h-3.5 w-3.5" />
              {t("tableData.exportData.label")}
              {exportLock && <Lock className="ml-2 h-3 w-3 opacity-70" />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => void exportFull()}
              >
                {isMongo
                  ? t("schema.exportCollection.title")
                  : t("tableData.exportData.table")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => void exportFiltered()}
              >
                {t("tableData.exportData.queryResults")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ),
      },
      ...(hasPk && !updateLock
        ? [
            {
              id: "bulk-update",
              bar: (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setBulkUpdateOpen(true)}
                  title={t("tableData.bulkUpdate.toolbarTitle")}
                >
                  <ReplaceAll className="h-3.5 w-3.5" />
                  {t("tableData.bulkUpdate.toolbarLabel")}
                </Button>
              ),
              menu: (
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={() => setBulkUpdateOpen(true)}
                >
                  <ReplaceAll className="mr-2 h-3.5 w-3.5" />
                  {t("tableData.bulkUpdate.toolbarLabel")}
                </DropdownMenuItem>
              ),
            },
          ]
        : []),
    ],
    [
      isMongo,
      hasPk,
      updateLock,
      exportLock,
      t,
      importCollectionJsonForTab,
      exportFull,
      exportFiltered,
    ],
  );

  // Trailing (right-aligned) HEADER content, rendered after `insertExtra` —
  // just the table/list view toggle, a *display* control rather than a data
  // action, so it stays apart from the insert/export/bulk group. Offered for
  // every driver: the list view started out MongoDB-only, but a 40-column SQL
  // table (or a row with a big JSONB column) has exactly the same problem it
  // solves. The choice is this tab's own `documentViewMode` state (#131), not
  // a global preference — see its declaration above.
  const trailingToolbar: GridToolbarItem[] = useMemo(
    () => [
      {
        id: "view-mode",
        // One segmented control, so one item — splitting it in two would put a
        // gap through the middle of a control whose two halves ARE the choice.
        bar: (
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            <IconButton
              icon={Table2}
              label={t("dataGrid.viewModeTable")}
              className={cn(
                "h-7 w-7 rounded-none",
                documentViewMode === "table" ? "bg-accent text-brand" : "",
              )}
              onClick={() => setDocumentViewMode("table")}
            />
            <IconButton
              icon={Rows3}
              label={t("dataGrid.viewModeList")}
              className={cn(
                "h-7 w-7 rounded-none",
                documentViewMode === "list" ? "bg-accent text-brand" : "",
              )}
              onClick={() => setDocumentViewMode("list")}
            />
          </div>
        ),
        // In the menu the segment becomes two checkable rows: the "which of the
        // two is active" state the segmented control shows by tinting one half
        // has to be readable here too.
        menu: (
          <>
            <DropdownMenuCheckboxItem
              className="text-xs"
              checked={documentViewMode === "table"}
              onSelect={() => setDocumentViewMode("table")}
            >
              {t("dataGrid.viewModeTable")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              className="text-xs"
              checked={documentViewMode === "list"}
              onSelect={() => setDocumentViewMode("list")}
            >
              {t("dataGrid.viewModeList")}
            </DropdownMenuCheckboxItem>
          </>
        ),
      },
    ],
    [documentViewMode, t],
  );

  // FOOTER content (a second, bottom toolbar row via DataGrid's `footer`) —
  // "how you're browsing", kept apart from the header's data actions. Two
  // groups anchored to opposite edges (DataGrid's footer container has no
  // `justify-end` of its own): row-zoom on the LEFT, and — pushed right via
  // `ml-auto` — the human-format pagination range (`1–100 de 19759`,
  // replacing the grid's redundant "N rows of M" count, hence
  // `showRowCount={false}` below), prev/next page buttons, and the page-size
  // selector.
  const footerContent = useMemo(
    () => (
      <>
        <div className="flex items-center">
          <IconButton
            icon={ZoomOut}
            label={t("dataGrid.zoomOut")}
            onClick={() => zoomRows(-2)}
            disabled={rowHeight <= 14}
          />
          <IconButton
            icon={ZoomIn}
            label={t("dataGrid.zoomIn")}
            onClick={() => zoomRows(2)}
            disabled={rowHeight >= 40}
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className="tabular-nums text-muted-foreground"
            title={totalEstimated ? t("tableData.approxTotal") : undefined}
          >
            {formatNumber(page.from)}–{formatNumber(page.to)}
            {total !== null && (
              <>
                {" "}
                {t("dataGrid.of")}{" "}
                <span className="font-medium text-foreground">
                  {totalEstimated ? "~" : ""}
                  {formatNumber(total)}
                </span>
              </>
            )}
          </span>
          <GoToRowInput
            total={total}
            totalEstimated={totalEstimated}
            disabled={loading}
            onGo={setOffset}
          />
          <div className="flex items-center">
            <IconButton
              icon={ChevronLeft}
              label={t("tableData.prevPage")}
              onClick={() => setOffset(prevOffset(offset, pageSize))}
              disabled={!page.canPrev || loading}
            />
            <IconButton
              icon={ChevronRight}
              label={t("tableData.nextPage")}
              onClick={() => setOffset(nextOffset(offset, pageSize))}
              disabled={!page.canNext || loading}
            />
          </div>
          <NativeSelect
            value={pageSize}
            onChange={(e) => {
              setOffset(0);
              setPageSize(Number(e.target.value));
            }}
            size="xs"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {t("tableData.perPage", { count: n })}
              </option>
            ))}
          </NativeSelect>
        </div>
      </>
    ),
    [
      zoomRows,
      rowHeight,
      t,
      page.from,
      page.to,
      page.canPrev,
      page.canNext,
      totalEstimated,
      total,
      offset,
      pageSize,
      loading,
      pageSizeOptions,
    ],
  );

  return (
    <div className="flex h-full flex-col" data-table-tab={tabId}>
      {error && (
        <div className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}
      {hasPk && (
        <PolicyVerbNotice
          locked={{
            insert: !!insertLock,
            update: !!updateLock,
            delete: !!deleteLock,
          }}
          columns={{
            insert: insertLock ? null : policyColumns.insert,
            update: updateLock ? null : policyColumns.update,
          }}
        />
      )}
      <div className="flex-1 overflow-hidden">
        {result ? (
          <DataGrid
            result={result}
            editable={hasPk && !updateLock}
            columnLock={columnLock}
            draftColumnLock={draftColumnLock}
            onPasteBlock={hasPk ? onPasteBlock : undefined}
            connectionId={connectionId}
            tableSchema={schema}
            tableName={table}
            tabId={tabId}
            driver={driver}
            pkColumnNames={pkColumnNames}
            fkColumnNames={fkColumnNames}
            onNavigateFk={onNavigateFk}
            onCellSave={onCellSave}
            onFieldSave={saveField}
            onFieldDelete={isMongo ? onFieldDelete : undefined}
            sort={sort}
            onSortChange={applySort}
            onSortSpecsChange={replaceSort}
            // `globalFilter` drives the grid's client-side `visibleRows`
            // pass and MUST match the filter the backend used to build
            // `result.rows` — that's `appliedFilter`, not the
            // uncommitted toolbar draft. Mixing the two caused
            // cell saves under a typed-but-not-Enter search to look
            // like they applied to the row above (see ADR #7 in
            // CLAUDE.md). The toolbar input still reflects the live
            // draft via `filterInput`.
            globalFilter={appliedFilter}
            filterInput={filter}
            onGlobalFilterChange={setFilter}
            onGlobalFilterSubmit={submitFilter}
            searchHistory={filterHistory ?? NO_HISTORY}
            serverFilters={serverFilters}
            typedFilterValues={isMongo}
            onAddFilter={onAddFilter}
            onRemoveFilter={onRemoveFilter}
            onEditFilter={onEditFilter}
            onInsertRow={hasPk && !insertLock ? onInsertRow : undefined}
            // A duplicate copies the row as the page holds it, so under a
            // projection it would silently drop every hidden column's value.
            onDuplicateRow={
              hasPk && !projected && !insertLock ? onDuplicateRow : undefined
            }
            onDeleteRow={hasPk && !deleteLock ? onDeleteRow : undefined}
            onBulkDelete={hasPk && !deleteLock ? onBulkDelete : undefined}
            getRowKey={getRowKey}
            onSelectionChange={onSelectionChange}
            draftRow={draft}
            draftColumns={cols}
            onDraftCellChange={onDraftCellChange}
            onDraftCommit={onDraftCommit}
            onDraftCancel={onDraftCancel}
            loading={loading}
            toolbarLeading={leadingToolbar}
            insertExtra={insertExtraContent}
            insertAlternatives={insertAlternatives}
            toolbarTrailing={trailingToolbar}
            footer={footerContent}
            // The page is the server's answer to the search; see the prop.
            rowsFromServer
            rowNumberOffset={resultOffset}
            queryChips={queryChips}
            belowToolbar={
              queryOpen && (
                <QueryPanel
                  columns={cols ?? []}
                  nestedFields={nestedFields}
                  customFields={isMongo}
                  applied={serverFilters}
                  appliedProjection={projection}
                  appliedRaw={rawFilter}
                  appliedCollation={collationText}
                  appliedHint={hintText}
                  driver={driver}
                  indexNames={indexNames}
                  document={isMongo}
                  keyColumns={pkColumnNames}
                  rawLocked={rawLock}
                  preview={{
                    connectionId,
                    schema,
                    table,
                    limit: pageSize,
                    offset,
                    order: sort.length ? sort : undefined,
                    search: appliedFilter || undefined,
                    searchColumns: appliedFilter ? searchColumns : undefined,
                  }}
                  focus={queryFocus}
                  onApply={(next) => {
                    setServerFilters(next.filters);
                    setProjection(next.projection);
                    setRawFilter(next.raw);
                    setCollationText(next.collation);
                    setHintText(next.hint);
                    setOffset(0);
                  }}
                  onClose={() => setQueryOpen(false)}
                />
              )
            }
            showRowCount={false}
            viewMode={documentViewMode}
          />
        ) : (
          // Initial load (no rows yet): a shimmer skeleton that reads as
          // "fetching". The tab title carries the table's identity (#57), so
          // this strip is just the loading indicator. Refetch-with-stale-rows
          // is handled by the grid's own dim overlay (the `loading` prop above).
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              <Spinner size="sm" className="shrink-0" />
              {t("schema.loading")}
            </div>
            <div className="flex-1 space-y-1.5 p-3" aria-hidden>
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="h-6 animate-pulse rounded-sm bg-muted-foreground/10"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {pendingPaste && (
        <PasteCellsDialog
          plan={pendingPaste}
          table={`${schema ? `${schema}.` : ""}${table}`}
          documentMode={isMongo}
          onApply={() => applyPaste(pendingPaste)}
          onClose={() => setPendingPaste(null)}
        />
      )}

      {pendingDelete && (
        <DeleteRowsDialog
          connectionId={connectionId}
          schema={schema}
          table={table}
          pkColumns={pkColumns.map((c) => c.name)}
          pkValueRows={pendingDelete.pkValueRows}
          onDelete={() => runDelete(pendingDelete.pkValueRows)}
          onClose={() => setPendingDelete(null)}
        />
      )}

      {bulkUpdateOpen && (
        <BulkUpdateDialog
          connectionId={connectionId}
          schema={schema}
          table={table}
          columns={cols ?? []}
          nestedFields={nestedFields}
          initialFilters={serverFilters}
          isMongo={isMongo}
          expressionIgnored={!!raw}
          columnLock={columnLock}
          onApplied={() => void fetchData()}
          onClose={() => setBulkUpdateOpen(false)}
        />
      )}

      {isMongo && (
        // Mounted rather than conditionally created, unlike the two above: the
        // dialog owns Monaco, and tearing the editor down and rebuilding it on
        // every open is the cost `open` exists to avoid. It resets its source
        // when `open` flips true.
        <InsertDocumentDialog
          open={insertDocOpen}
          onOpenChange={setInsertDocOpen}
          connectionId={connectionId}
          collection={table}
          onInserted={() => void reloadAll()}
        />
      )}

      {!isMongo && (
        // Same reasoning as the Mongo dialog above: mounted rather than
        // conditionally created, because it owns a Monaco instance.
        <InsertRowsDialog
          open={insertRowsOpen}
          onOpenChange={setInsertRowsOpen}
          connectionId={connectionId}
          schema={schema}
          table={table}
          onInserted={() => void reloadAll()}
        />
      )}
    </div>
  );
}
