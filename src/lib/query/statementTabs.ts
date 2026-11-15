/**
 * Turn a query tab's run into the tabs its results area shows (ADR #137):
 * **one tab per statement the run executed** — reads, writes and the one that
 * failed — with a **Summary** first in a batch.
 *
 * Replaces `resultPanels.ts`, whose panels covered only the statements that
 * returned rows; writes and the failure lived in a summary list above, tied to
 * the strip only by `#n`. Now every statement has a place of its own to be
 * selected, and the summary is one of the tabs.
 *
 * Pure, and the reason the type is a discriminated union: a `rows` tab without
 * a result, or an `error` tab without a message, cannot be built. Nothing here
 * reads SQL — the outcome is all it needs — so a MongoDB run goes through the
 * same model (see the tests' Mongo fixture).
 *
 * Each statement tab carries the **lines** its statement occupies in the
 * editor, from `splitSql` over the text that ran plus the line that text
 * started on. That is what *Go to statement* selects. It is `null` when the
 * text is not in the editor (a history entry run from the sidebar).
 */

import { splitSql, type SqlDialect } from "@/lib/sql/sqlSplit";
import type { BatchResult, QueryResult } from "@/types";

/** 1-based, inclusive line range in the editor. */
export interface LineRange {
  start: number;
  end: number;
}

interface StatementBase {
  /** Stable within a run; what the strip selects by. */
  key: string;
  /** 1-based statement number, as the Summary counts. */
  statement: number;
  /** The statement's text as it was sent. */
  sql: string;
  lines: LineRange | null;
}

export interface RowsTab extends StatementBase {
  kind: "rows";
  /** 1-based ordinal within the statement, or `null` when it produced one set
   *  — every driver but SQL Server, whose single statement can return several. */
  set: number | null;
  result: QueryResult;
  /** `false` for one of several sets: re-running the statement could not say
   *  which of its sets to refresh, and it is not a single-table SELECT. */
  refreshable: boolean;
}

export interface WriteTab extends StatementBase {
  kind: "write";
  rowsAffected: number;
  elapsedMs: number;
}

export interface ErrorTab extends Omit<StatementBase, "statement"> {
  kind: "error";
  /** `null` when the run failed as a whole, before any statement (a batch
   *  whose connection could not be acquired). */
  statement: number | null;
  message: string;
}

export interface SummaryStatement {
  statement: number;
  preview: string;
  status: "ok" | "failed";
  /** Rows returned by a read, rows changed by a write. */
  rows: number;
  isRead: boolean;
  elapsedMs: number;
  error: string | null;
  /** The key of the statement's first tab, so the Summary can select it. */
  tabKey: string;
}

export interface SummaryTab {
  kind: "summary";
  key: typeof SUMMARY_KEY;
  statements: SummaryStatement[];
  totalAffected: number;
  totalElapsedMs: number;
  /** 1-based number of the statement that stopped the batch, if one did. */
  failedAt: number | null;
}

export type StatementTab = RowsTab | WriteTab | ErrorTab | SummaryTab;

export const SUMMARY_KEY = "summary";

/** Where the text that ran sits in the editor: the line it starts on, or
 *  `null` when it is not in the editor at all. */
export interface RunOrigin {
  text: string;
  firstLine: number | null;
  dialect: SqlDialect;
}

/** Line ranges of each statement of `origin.text`, offset into the editor. */
function rangesOf(origin: RunOrigin): (LineRange | null)[] {
  const { firstLine } = origin;
  return splitSql(origin.text, origin.dialect).map((s) =>
    firstLine === null
      ? null
      : { start: s.startLine + firstLine - 1, end: s.endLine + firstLine - 1 },
  );
}

/** The text's own range when it is one statement (or failed as a whole). */
function wholeRange(origin: RunOrigin): LineRange | null {
  if (origin.firstLine === null) return null;
  const ranges = rangesOf(origin);
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  return first && last ? { start: first.start, end: last.end } : null;
}

/** A single statement through `execute_query`. */
export function tabsFromSingle(origin: RunOrigin, result: QueryResult): StatementTab[] {
  const base = { statement: 1, sql: origin.text.trim(), lines: wholeRange(origin) };
  if (result.columns.length === 0) {
    return [
      {
        ...base,
        kind: "write",
        key: "0:w",
        rowsAffected: result.rows_affected,
        elapsedMs: result.elapsed_ms,
      },
    ];
  }
  return [{ ...base, kind: "rows", key: "0:0", set: null, result, refreshable: true }];
}

/** A run that threw: a single statement's error, or a batch failing whole. */
export function tabsFromFailure(
  origin: RunOrigin,
  message: string,
  wasBatch: boolean,
): StatementTab[] {
  return [
    {
      kind: "error",
      key: "run:e",
      statement: wasBatch ? null : 1,
      sql: origin.text.trim(),
      lines: wholeRange(origin),
      message,
    },
  ];
}

/**
 * A batch through `execute_batch`: Summary first, then each statement's tabs
 * in order. `texts` is what was sent, indexed like the outcomes' `index`.
 */
export function tabsFromBatch(
  origin: RunOrigin,
  batch: BatchResult,
  texts: readonly string[],
): StatementTab[] {
  const ranges = rangesOf(origin);
  const tabs: StatementTab[] = [];
  const summary: SummaryStatement[] = [];
  let failedAt: number | null = null;

  for (const s of batch.statements) {
    const statement = s.index + 1;
    const sql = (texts[s.index] ?? s.preview).trim();
    const lines = ranges[s.index] ?? null;
    let tabKey: string;
    if (s.error !== null) {
      failedAt ??= statement;
      tabKey = `${s.index}:e`;
      tabs.push({ kind: "error", key: tabKey, statement, sql, lines, message: s.error });
    } else if (s.results.length > 0) {
      tabKey = `${s.index}:0`;
      const several = s.results.length > 1;
      s.results.forEach((result, i) =>
        tabs.push({
          kind: "rows",
          key: `${s.index}:${i}`,
          statement,
          set: several ? i + 1 : null,
          result,
          sql,
          lines,
          refreshable: !several,
        }),
      );
    } else {
      // A write, or a read the driver returned no set for.
      tabKey = `${s.index}:w`;
      tabs.push({
        kind: "write",
        key: tabKey,
        statement,
        sql,
        lines,
        rowsAffected: s.rows_affected,
        elapsedMs: s.elapsed_ms,
      });
    }
    summary.push({
      statement,
      preview: s.preview,
      status: s.error === null ? "ok" : "failed",
      rows: s.rows_affected,
      isRead: s.is_select,
      elapsedMs: s.elapsed_ms,
      error: s.error,
      tabKey,
    });
  }

  return [
    {
      kind: "summary",
      key: SUMMARY_KEY,
      statements: summary,
      totalAffected: batch.total_affected,
      totalElapsedMs: summary.reduce((n, s) => n + s.elapsedMs, 0),
      failedAt,
    },
    ...tabs,
  ];
}

/**
 * The tab a run lands on (ADR #137): the statement that failed; else the first
 * set of rows; else the Summary; else whatever came first.
 */
export function initialTabKey(tabs: readonly StatementTab[]): string | null {
  return (
    tabs.find((t) => t.kind === "error")?.key ??
    tabs.find((t) => t.kind === "rows")?.key ??
    tabs.find((t) => t.kind === "summary")?.key ??
    tabs[0]?.key ??
    null
  );
}

/** How many characters of a statement a result tab shows. */
const PREVIEW_CHARS = 24;

/**
 * The start of a statement, for its result tab's label (ADR #137): enough to
 * tell `#2 · UPDATE Track SET…` from `#3 · INSERT INTO Genre…` without
 * reading the Summary.
 *
 * Leading comments are skipped — a tab that says `-- fix the prices…` names
 * the comment, not the statement — and whitespace runs, line breaks included,
 * become one space, and the closing `;` goes. Longer than `max` is cut with
 * an ellipsis.
 */
export function sqlPreview(sql: string, max = PREVIEW_CHARS): string {
  let text = sql.trim();
  for (;;) {
    if (text.startsWith("--") || text.startsWith("//")) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1).trimStart();
    } else if (text.startsWith("/*")) {
      const close = text.indexOf("*/");
      text = close === -1 ? "" : text.slice(close + 2).trimStart();
    } else {
      break;
    }
  }
  const flat = text.replace(/[\s;]+$/, "").replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}
