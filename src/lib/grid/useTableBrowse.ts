/**
 * The table browser's data: one page of a relation and its row total, read
 * through `api.fetchTableData` / `api.countTableRows` for whatever the tab has
 * applied (page, sort, filters, search, query panel).
 *
 * Extracted from `TableDataTab` unchanged (refactor block 4). What it keeps
 * together is the machinery whose pieces only make sense as one:
 *
 * - **Dedupe on the wire.** A byte-identical page or count request already in
 *   flight is not sent again (StrictMode's double mount, a transient dependency
 *   change — issue #41).
 * - **The count runs after the page.** The total is fetched separately so an
 *   exact `COUNT(*)` never gates the first rows (issue #77), and it waits for the
 *   page's request to settle so one open tab holds one pooled connection at a
 *   time. It is keyed on the predicate only: paging and sorting reuse it.
 * - **An exact count belongs to its predicate.** The footer's *exact count* is
 *   dropped if the predicate or a refresh moved on while it ran.
 * - **Trimmed cells (ADR #133).** On MongoDB a page can leave oversized fields
 *   on the server; `trimmedRows` loads a row back whole when it is opened.
 *
 * The caller owns the applied view state and passes it in; this hook owns what
 * came back. Registering `reloadAll` with the F5 handler stays with the tab,
 * which is what knows its id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useSchema } from "@/stores/session/schema";
import {
  describeTrimmed,
  indexTrimmed,
  isUnloadable,
  mergeLoadedRow,
  type TrimmedRows,
} from "@/lib/grid/trimmedCells";
import type { CountStatus } from "@/lib/grid/pagination";
import type {
  CellValue,
  ColumnFilter,
  Projection,
  QueryResult,
  SortSpec,
} from "@/types";

/** What the tab has applied — everything a page or a count is read for. */
export interface TableBrowseQuery {
  connectionId: string;
  schema?: string;
  table: string;
  pageSize: number;
  offset: number;
  sort: SortSpec[];
  serverFilters: ColumnFilter[];
  /** The committed search box; empty is none. */
  appliedFilter: string;
  /** The projection as it goes on the wire — key columns already added. */
  wire: Projection | undefined;
  /** The query panel's expression, blank already turned into `undefined`. */
  raw: string | undefined;
  collation: string | undefined;
  hint: string | undefined;
  /** Bytes above which a MongoDB field stays on the server (ADR #133). */
  trimAbove: number | undefined;
  /** The columns the search box searches. Read lazily — see `searchColumnsRef`. */
  searchColumns: string[];
  /** The relation's field list has not loaded (or failed): load it, and retry on refresh. */
  columnsMissing: boolean;
}

export function useTableBrowse({
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
  trimAbove,
  searchColumns,
  columnsMissing,
}: TableBrowseQuery) {
  const { t } = useTranslation();
  const loadColumns = useSchema((s) => s.loadColumns);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  // Where the background count stands — `total` is `null` both while it runs
  // and after it gave up, and only the second is worth offering a retry for.
  const [countStatus, setCountStatus] = useState<CountStatus>("loading");
  // The user's *exact count* action is on the wire.
  const [exactCounting, setExactCounting] = useState(false);

  // Signature (connection + relation + predicate) the current total was
  // computed for. The count depends only on the WHERE predicate, so
  // sort/offset/page changes reuse it and never re-count; the count request is
  // deduped on this key (StrictMode remount + transient dep-identity changes).
  const countInflightRef = useRef<string | null>(null);
  // Bumped every time the total is recomputed for a new predicate or a
  // refresh. An exact count remembers the generation it started in and drops
  // its answer if that has moved on: the figure belongs to a predicate (or a
  // moment) that is no longer the one on screen. That is also its whole cache
  // policy — an exact total stays until a filter change or refresh replaces it.
  const countGenerationRef = useRef(0);

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
      trimAbove,
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
        trimAbove,
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
    trimAbove,
  ]);

  // The cells this page left on the server, and how a row gets them back
  // (ADR #133). `resultRef` because a load resolves after renders that may
  // have replaced the page: the row is merged into whatever page is current
  // then, found by identity, or by `_id` if a refetch rebuilt every array.
  const resultRef = useRef(result);
  resultRef.current = result;
  const trimmedIndex = useMemo(() => indexTrimmed(result), [result]);
  const loadingRowsRef = useRef(new Map<CellValue[], Promise<CellValue[]>>());
  const trimmedRows: TrimmedRows = useMemo(
    () => ({
      of: (row) => trimmedIndex.get(row),
      explainUnloadable: (row, column) => {
        const cut = trimmedIndex.get(row)?.get(column);
        if (!cut || !isUnloadable(cut)) return false;
        notify.info(t("dataGrid.trimmed.binaryTitle"), {
          description: t("dataGrid.trimmed.binaryDesc", {
            label: describeTrimmed(cut),
          }),
        });
        return true;
      },
      hydrate: (row) => {
        if (!trimmedIndex.get(row)) return Promise.resolve(row);
        const pending = loadingRowsRef.current.get(row);
        if (pending) return pending;
        const page = resultRef.current;
        const idIndex = page?.columns.findIndex((c) => c.name === "_id") ?? -1;
        const load = (async () => {
          // A large document over a slow tunnel takes seconds; say so rather
          // than leave the click looking ignored. Not for the quick ones —
          // a card that flashes for 100 ms is noise.
          let progress: ReturnType<typeof notify.progress> | null = null;
          const slow = setTimeout(() => {
            progress = notify.progress(t("dataGrid.trimmed.loading"));
          }, 300);
          try {
            if (idIndex < 0) throw new Error(t("dataGrid.trimmed.noId"));
            const id = row[idIndex];
            const loaded = await api.fetchTableData({
              connectionId,
              schema,
              table,
              limit: 1,
              offset: 0,
              filters: [{ column: "_id", op: "eq", value: id }],
              withCount: false,
            });
            if (loaded.rows.length === 0) {
              throw new Error(t("dataGrid.trimmed.gone"));
            }
            const current = resultRef.current;
            if (!current) return row;
            let at = current.rows.indexOf(row);
            if (at < 0) {
              const key = JSON.stringify(id);
              at = current.rows.findIndex(
                (r) => JSON.stringify(r[idIndex]) === key,
              );
            }
            if (at < 0) return row;
            const merged = mergeLoadedRow(current, at, loaded);
            resultRef.current = merged;
            setResult(merged);
            return merged.rows[at];
          } catch (e) {
            const description = String(e instanceof Error ? e.message : e);
            const failed = progress as ReturnType<typeof notify.progress> | null;
            if (failed) {
              failed.error(t("dataGrid.trimmed.loadFailed"), { description });
              progress = null;
            } else {
              notify.error(t("dataGrid.trimmed.loadFailed"), { description });
            }
            throw e;
          } finally {
            clearTimeout(slow);
            (progress as ReturnType<typeof notify.progress> | null)?.dismiss();
            loadingRowsRef.current.delete(row);
          }
        })();
        loadingRowsRef.current.set(row, load);
        return load;
      },
    }),
    // `t` is stable per language; the rest name the relation the load reads.
    [trimmedIndex, connectionId, schema, table, t],
  );

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
    countGenerationRef.current += 1;
    setTotal(null);
    setCountStatus("loading");
    setExactCounting(false);
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
      setCountStatus("ready");
    } catch {
      // Non-fatal: the grid pages fine without a total. Leave it null; the
      // footer shows the current range without "/ N" — and offers the exact
      // count, which is not capped the way this one is on MongoDB.
      setCountStatus("failed");
    } finally {
      if (countInflightRef.current === countKey)
        countInflightRef.current = null;
    }
  }, [connectionId, schema, table, serverFilters, appliedFilter, raw, collation]);

  /**
   * The footer's *exact count* action: count the current predicate for real,
   * skipping the engine estimate and — on MongoDB — the background count's
   * ten-second ceiling (`CountMode::Exact` in `commands/query.rs`).
   *
   * Unbounded on purpose. The user asked for this figure, the same as a query
   * they typed, and the collections whose estimate is worth doubting are the
   * big ones a ceiling would fail on. There is no server-side cancel to offer
   * for it, so rather than a Cancel button that only hides the spinner, the
   * answer is simply dropped if the predicate changes or the tab is refreshed
   * while it runs (`countGenerationRef`).
   */
  const countExactly = useCallback(async () => {
    const generation = countGenerationRef.current;
    setExactCounting(true);
    try {
      const c = await api.countTableRows(
        {
          connectionId,
          schema,
          table,
          filters: serverFilters.length ? serverFilters : undefined,
          search: appliedFilter || undefined,
          searchColumns: appliedFilter ? searchColumnsRef.current : undefined,
          raw,
          collation,
          // Changes no total, but on MongoDB it is the index the count walks
          // — the page's own. Only here: in the background count it would
          // re-key a recount on every hint edit for no different answer.
          hint,
        },
        true,
      );
      if (countGenerationRef.current !== generation) return;
      setTotal(c.total);
      setTotalEstimated(c.estimated);
      setCountStatus("ready");
    } catch (e) {
      if (countGenerationRef.current !== generation) return;
      notify.error(t("tableData.exactCountFailed"), { description: String(e) });
    } finally {
      if (countGenerationRef.current === generation) setExactCounting(false);
    }
  }, [
    connectionId,
    schema,
    table,
    serverFilters,
    appliedFilter,
    raw,
    collation,
    hint,
    t,
  ]);

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
    if (columnsMissing) void loadColumns(connectionId, schema, table);
    return fetchPromiseRef.current;
  }, [
    fetchData,
    refreshCount,
    columnsMissing,
    loadColumns,
    connectionId,
    schema,
    table,
  ]);

  // Before the fetch below, as it ran when this lived in `TableDataTab`: the
  // field list is requested first and the page second.
  useEffect(() => {
    if (columnsMissing) loadColumns(connectionId, schema, table);
  }, [columnsMissing, connectionId, schema, table, loadColumns]);

  useEffect(() => {
    // Stash the promise before `refreshCount`'s effect (declared next, runs
    // right after this one within the same commit) reads it.
    fetchPromiseRef.current = fetchData();
  }, [fetchData]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  return {
    result,
    loading,
    error,
    /** For the tab's own failures that belong where a failed page shows. */
    setError,
    resultOffset,
    total,
    totalEstimated,
    countStatus,
    exactCounting,
    fetchData,
    trimmedRows,
    countExactly,
    reloadAll,
  };
}
