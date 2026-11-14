/**
 * The query tab's run lifecycle: what ran, what came back, and what is on
 * screen. Extracted from `QueryEditorTab` (ADR #137, step 2) with no change of
 * behaviour — `QueryEditorTab.test.tsx` pins it.
 *
 * It **decides** which backend path a text takes and **acts** on it:
 *
 * - `run(text)` splits the text in the tab's dialect and sends more than one
 *   statement to `execute_batch`, one statement to `execute_query`. This is
 *   what the Run button and the Run shortcut call.
 * - `runSingle(text)` always takes `execute_query`. The CodeLens runs one
 *   statement by construction; the history's "Run again" calls it too, which
 *   is the replayed-batch defect the history dock (PR 7) removes.
 *
 * Either way it records the run in the history (under the parent connection)
 * and drives the toolbar's timer through an imperative handle, so the 50 ms
 * tick never re-renders the tab (see `QueryTimer`).
 *
 * What it does **not** own: the grid's client-side filter (the results area
 * keeps it, and clears it on a tab switch), the database the tab targets
 * (`useDatabaseSelector`; this hook is handed the resulting id), and the
 * editor (the tab reads the buffer and passes text in).
 */

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { panelsFromBatch, type ResultPanel } from "@/lib/query/resultPanels";
import { splitSql, type SqlDialect } from "@/lib/sql/sqlSplit";
import { useQueryHistory } from "@/stores/query/queryHistory";
import type { BatchResult } from "@/types";

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
  /** Every result set of the last run, one panel each, in statement order. */
  panels: ResultPanel[];
  /** The panel on screen; falls back to the first so it is never stale. */
  active: ResultPanel | null;
  /** Where `panels` came from — not necessarily `connectionId`, which the
   *  database selector can move after the run. A grid write goes here. */
  resultsOn: string;
  /** The last batch's outcome, or `null` after a single run. */
  batchSummary: BatchResult | null;
  /** The message the results area shows in place of a grid. */
  error: string | null;
  running: boolean;
  run: (text: string) => Promise<void>;
  runSingle: (text: string) => Promise<void>;
  selectPanel: (key: string) => void;
  /** Re-run the panel on screen after a grid write; failures notify. */
  refreshActive: () => Promise<void>;
  /** Show an error that did not come from a run (a database switch). Kept
   *  only to preserve today's behaviour; ADR #137 moves it to `notify`. */
  reportError: (message: string) => void;
}

export function useQueryRun({
  connectionId,
  historyConnectionId,
  dialect,
  timer,
}: UseQueryRunOptions): QueryRun {
  const { t } = useTranslation();
  const addHistory = useQueryHistory((s) => s.add);

  const [panels, setPanels] = useState<ResultPanel[]>([]);
  const [resultsOn, setResultsOn] = useState(connectionId);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The guard reads a ref, not `running`: two calls in the same render (a
  // double click) would both see `running === false` in their closure.
  const runningRef = useRef(false);

  const begin = useCallback(() => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    timer.current?.start();
    return true;
  }, [timer]);

  const end = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);

  const runSingle = useCallback(
    async (text: string) => {
      const toRun = text.trim();
      if (!toRun || !begin()) return;
      setBatchSummary(null);
      try {
        const r = await api.executeQuery(connectionId, toRun);
        setPanels([{ key: "0", statement: 1, set: null, result: r, sql: toRun }]);
        setResultsOn(connectionId);
        setActiveKey("0");
        addHistory({
          sql: toRun,
          connectionId: historyConnectionId,
          elapsedMs: r.elapsed_ms,
          rowsAffected: r.rows_affected,
        });
        timer.current?.stop(true);
      } catch (e) {
        setError(String(e));
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
    [begin, end, connectionId, historyConnectionId, addHistory, timer],
  );

  /** One connection, every statement in order (the prepared protocol rejects
   *  a `;`-joined buffer). */
  const runBatch = useCallback(
    async (texts: string[]) => {
      if (texts.length === 0 || !begin()) return;
      try {
        const r = await api.executeBatch(connectionId, texts);
        setBatchSummary(r);
        const next = panelsFromBatch(r.statements, texts);
        setPanels(next);
        setResultsOn(connectionId);
        setActiveKey(next[0]?.key ?? null);
        const failed = r.statements.find((s) => s.error);
        addHistory({
          sql: texts.join(";\n"),
          connectionId: historyConnectionId,
          elapsedMs: 0,
          rowsAffected: r.total_affected,
          error: failed?.error ?? undefined,
        });
        timer.current?.stop(!failed);
      } catch (e) {
        setError(String(e));
        timer.current?.stop(false);
      } finally {
        end();
      }
    },
    [begin, end, connectionId, historyConnectionId, addHistory, timer],
  );

  const run = useCallback(
    async (text: string) => {
      const statements = splitSql(text, dialect);
      if (statements.length > 1) await runBatch(statements.map((s) => s.text));
      else await runSingle(text);
    },
    [dialect, runBatch, runSingle],
  );

  const active = useMemo(
    () => panels.find((p) => p.key === activeKey) ?? panels[0] ?? null,
    [panels, activeKey],
  );

  // Only that statement runs again — never the rest of a batch, whose other
  // statements may be writes. A failure here comes *after* the write
  // succeeded, so it is reported on its own rather than thrown to the grid.
  const activeKeyNow = active?.key;
  const activeSql = active?.sql;
  const refreshActive = useCallback(async () => {
    if (!activeKeyNow || !activeSql) return;
    try {
      const r = await api.executeQuery(resultsOn, activeSql);
      setPanels((prev) =>
        prev.map((p) => (p.key === activeKeyNow ? { ...p, result: r } : p)),
      );
    } catch (e) {
      notify.error(t("query.refreshFailed"), { description: String(e) });
    }
  }, [activeKeyNow, activeSql, resultsOn, t]);

  return {
    panels,
    active,
    resultsOn,
    batchSummary,
    error,
    running,
    run,
    runSingle,
    selectPanel: setActiveKey,
    refreshActive,
    reportError: setError,
  };
}
