/**
 * The query tab's run lifecycle: what ran, what came back, and which of its
 * tabs is on screen (ADR #137).
 *
 * It **decides** which backend path a text takes and **acts** on it:
 *
 * - `run(text)` splits the text in the tab's dialect and sends more than one
 *   statement to `execute_batch`, one statement to `execute_query`. The Run
 *   button, `runQuery` and `runAll` call it with whatever `runTarget` named.
 * - `runSingle(text)` always takes `execute_query`. The CodeLens runs one
 *   statement by construction; the history sidebar's "Run again" calls it too,
 *   which is the replayed-batch defect the history dock removes.
 *
 * Every outcome becomes tabs through `lib/query/statementTabs` — a thrown
 * error included, which is an error tab like a failed batch statement rather
 * than a box of its own — and **a new run replaces every tab**. The run lands
 * on `initialTabKey`'s choice. It records the run in the history (under the
 * parent connection, with the batch's total time) and drives the toolbar's
 * timer through an imperative handle, so the 50 ms tick never re-renders the
 * tab (see `QueryTimer`).
 *
 * **Stop** (ADR #137): every run carries a `runId`, and `stop()` asks the
 * backend to stop that run where it runs (`cancelQuery`) — the statement on the
 * server, not just the wait. The run then answers its own caller: a single
 * statement rejects with a stop the backend words (`stoppedOutcome`), a batch
 * resolves with `stopped` set; either becomes a stopped tab that says whether
 * the statement may have applied.
 *
 * What it does **not** own: the grid's client-side filter (the results area
 * keeps it), the database the tab targets (`useDatabaseSelector`), and the
 * editor (the tab reads it and passes text and its first line in).
 */

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import {
  initialTabKey,
  tabsFromBatch,
  tabsFromFailure,
  tabsFromSingle,
  tabsFromStopped,
  type RunOrigin,
  type StatementTab,
} from "@/lib/query/statementTabs";
import { splitSql, type SqlDialect } from "@/lib/sql/sqlSplit";
import { useQueryHistory } from "@/stores/query/queryHistory";

/** Imperative handle the run drives the toolbar's timer through. */
export interface QueryTimerHandle {
  start: () => void;
  stop: (ok: boolean) => void;
}

export interface UseQueryRunOptions {
  /** Where statements run: the tab's connection or a `::db::` view of it. */
  connectionId: string;
  /** The parent connection, which the history is filed under. */
  historyConnectionId: string;
  dialect: SqlDialect;
  /** The toolbar timer. Read at call time, so it needs no stable identity. */
  timer: RefObject<QueryTimerHandle | null>;
}

export interface QueryRun {
  /** Every tab of the last run, Summary first in a batch. */
  tabs: StatementTab[];
  /** The tab on screen; falls back to the first so it is never stale. */
  active: StatementTab | null;
  /** Where `tabs` came from — not necessarily `connectionId`, which the
   *  database selector can move after the run. A grid write goes here. */
  resultsOn: string;
  running: boolean;
  /** Stop the run in flight on the server; a no-op when nothing runs. */
  stop: () => void;
  /**
   * @param firstLine The editor line `text` starts on, for *Go to
   *   statement*; `null` when the text is not in the editor.
   */
  run: (text: string, firstLine?: number | null) => Promise<void>;
  runSingle: (text: string, firstLine?: number | null) => Promise<void>;
  selectTab: (key: string) => void;
  /** Re-run the rows tab on screen after a grid write; failures notify. */
  refreshActive: () => Promise<void>;
}

export function useQueryRun({
  connectionId,
  historyConnectionId,
  dialect,
  timer,
}: UseQueryRunOptions): QueryRun {
  const { t } = useTranslation();
  const addHistory = useQueryHistory((s) => s.add);

  const [tabs, setTabs] = useState<StatementTab[]>([]);
  const [resultsOn, setResultsOn] = useState(connectionId);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The guard reads a ref, not `running`: two calls in the same render (a
  // double click) would both see `running === false` in their closure.
  const runningRef = useRef(false);
  /** The run in flight's id, for `stop`; `null` between runs. */
  const runIdRef = useRef<string | null>(null);

  /** Start a run: its id, or `null` when one is already in flight. */
  const begin = useCallback((): string | null => {
    if (runningRef.current) return null;
    runningRef.current = true;
    const id = newRunId();
    runIdRef.current = id;
    setRunning(true);
    timer.current?.start();
    return id;
  }, [timer]);

  const end = useCallback(() => {
    runningRef.current = false;
    runIdRef.current = null;
    setRunning(false);
  }, []);

  const stop = useCallback(() => {
    const id = runIdRef.current;
    // `false` (the run had already ended) is not an error: Stop was pressed
    // as the result arrived, and the run answers its caller either way.
    if (id) void api.cancelQuery(id).catch(() => {});
  }, []);

  /** Replace every tab with the run's, and land on the right one. */
  const show = useCallback(
    (next: StatementTab[]) => {
      setTabs(next);
      setResultsOn(connectionId);
      setActiveKey(initialTabKey(next));
    },
    [connectionId],
  );

  const runSingle = useCallback(
    async (text: string, firstLine: number | null = null) => {
      const toRun = text.trim();
      if (!toRun) return;
      const runId = begin();
      if (!runId) return;
      const origin: RunOrigin = { text, firstLine, dialect };
      try {
        const r = await api.executeQuery(connectionId, toRun, runId);
        show(tabsFromSingle(origin, r));
        addHistory({
          sql: toRun,
          connectionId: historyConnectionId,
          elapsedMs: r.elapsed_ms,
          rowsAffected: r.rows_affected,
        });
        timer.current?.stop(true);
      } catch (e) {
        show(tabsFromStopped(origin, String(e)) ?? tabsFromFailure(origin, String(e), false));
        addHistory({
          sql: toRun,
          connectionId: historyConnectionId,
          elapsedMs: 0,
          rowsAffected: 0,
          error: String(e),
        });
        timer.current?.stop(false);
      } finally {
        end();
      }
    },
    [begin, end, show, dialect, connectionId, historyConnectionId, addHistory, timer],
  );

  /** One connection, every statement in order (the prepared protocol rejects
   *  a `;`-joined buffer). */
  const runBatch = useCallback(
    async (origin: RunOrigin, texts: string[]) => {
      if (texts.length === 0) return;
      const runId = begin();
      if (!runId) return;
      try {
        const r = await api.executeBatch(connectionId, texts, runId);
        const next = tabsFromBatch(origin, r, texts);
        show(next);
        const failed = r.statements.find((s) => s.error);
        addHistory({
          // What the person ran, as they wrote it. It used to be the split
          // texts re-joined with ";\n", over texts that already end in ";".
          sql: origin.text.trim(),
          connectionId: historyConnectionId,
          elapsedMs: r.statements.reduce((n, s) => n + s.elapsed_ms, 0),
          rowsAffected: r.total_affected,
          error: failed?.error ?? undefined,
        });
        timer.current?.stop(!failed && !r.stopped);
      } catch (e) {
        show(tabsFromFailure(origin, String(e), true));
        timer.current?.stop(false);
      } finally {
        end();
      }
    },
    [begin, end, show, connectionId, historyConnectionId, addHistory, timer],
  );

  const run = useCallback(
    async (text: string, firstLine: number | null = null) => {
      const statements = splitSql(text, dialect);
      if (statements.length > 1) {
        await runBatch(
          { text, firstLine, dialect },
          statements.map((s) => s.text),
        );
      } else {
        await runSingle(text, firstLine);
      }
    },
    [dialect, runBatch, runSingle],
  );

  const active = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null,
    [tabs, activeKey],
  );

  // Only that statement runs again — never the rest of a batch, whose other
  // statements may be writes. A failure here comes *after* the write
  // succeeded, so it is reported on its own rather than thrown to the grid.
  const refreshKey =
    active?.kind === "rows" && active.refreshable ? active.key : undefined;
  const refreshSql = active?.kind === "rows" ? active.sql : undefined;
  const refreshActive = useCallback(async () => {
    if (!refreshKey || !refreshSql) return;
    try {
      const r = await api.executeQuery(resultsOn, refreshSql);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.key === refreshKey && tab.kind === "rows" ? { ...tab, result: r } : tab,
        ),
      );
    } catch (e) {
      notify.error(t("query.refreshFailed"), { description: String(e) });
    }
  }, [refreshKey, refreshSql, resultsOn, t]);

  return {
    tabs,
    active,
    resultsOn,
    running,
    stop,
    run,
    runSingle,
    selectTab: setActiveKey,
    refreshActive,
  };
}

/** A run's id. `crypto.randomUUID` is present in the webview; the fallback is
 *  for a jsdom test and an older WebView2 that predates it. */
function newRunId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
