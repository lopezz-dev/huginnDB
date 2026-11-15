import { describe, expect, it } from "vitest";
import {
  initialTabKey,
  sqlPreview,
  tabsFromBatch,
  tabsFromFailure,
  tabsFromSingle,
  type RunOrigin,
  type StatementTab,
} from "./statementTabs";
import type { BatchResult, QueryResult, StmtOutcome } from "@/types";

const rows = (n: number, extra: Partial<QueryResult> = {}): QueryResult => ({
  columns: [{ name: "n", data_type: "int" }],
  rows: Array.from({ length: n }, (_, i) => [i]),
  rows_affected: n,
  elapsed_ms: 1,
  total: null,
  ...extra,
});
const write = (n: number): QueryResult => ({
  columns: [],
  rows: [],
  rows_affected: n,
  elapsed_ms: 4,
  total: null,
});
const stmt = (index: number, over: Partial<StmtOutcome> = {}): StmtOutcome => ({
  index,
  preview: `stmt ${index}`,
  rows_affected: 0,
  is_select: true,
  error: null,
  elapsed_ms: 10,
  results: [],
  ...over,
});
const sql = (text: string, firstLine: number | null = 1): RunOrigin => ({
  text,
  firstLine,
  dialect: "sql",
});
const kinds = (tabs: StatementTab[]) => tabs.map((t) => `${t.kind}:${t.key}`);

describe("tabsFromSingle", () => {
  it("a read is one rows tab, refreshable, with its lines", () => {
    const [tab] = tabsFromSingle(sql("SELECT 1", 4), rows(1));
    expect(tab).toMatchObject({
      kind: "rows",
      statement: 1,
      set: null,
      sql: "SELECT 1",
      lines: { start: 4, end: 4 },
      refreshable: true,
    });
  });

  it("a columns-less result is a write tab with its count and time", () => {
    const [tab] = tabsFromSingle(sql("DELETE FROM t"), write(3));
    expect(tab).toMatchObject({ kind: "write", rowsAffected: 3, elapsedMs: 4 });
  });

  it("text that is not in the editor has no lines", () => {
    const [tab] = tabsFromSingle(sql("SELECT 1", null), rows(1));
    expect(tab.kind === "rows" && tab.lines).toBeNull();
  });
});

describe("tabsFromFailure", () => {
  it("a single statement's error is statement 1, spanning the text", () => {
    const [tab] = tabsFromFailure(sql("SELEC\n  1", 2), "syntax", false);
    expect(tab).toMatchObject({
      kind: "error",
      statement: 1,
      message: "syntax",
      lines: { start: 2, end: 3 },
    });
  });

  it("a batch failing as a whole names no statement", () => {
    const [tab] = tabsFromFailure(sql("SELECT 1;\nSELECT 2"), "lost", true);
    expect(tab).toMatchObject({ kind: "error", statement: null });
  });
});

describe("tabsFromBatch", () => {
  const TEXT = "SELECT a;\nUPDATE t SET a = 1;\n\nSELECT b";
  const TEXTS = ["SELECT a;", "UPDATE t SET a = 1;", "SELECT b"];

  it("Summary first, then one tab per statement: reads, writes and the failure", () => {
    const batch: BatchResult = {
      statements: [
        stmt(0, { results: [rows(2)], rows_affected: 2 }),
        stmt(1, { is_select: false, rows_affected: 5 }),
        stmt(2, { error: "boom" }),
      ],
      total_affected: 5,
    };
    const tabs = tabsFromBatch(sql(TEXT, 10), batch, TEXTS);
    expect(kinds(tabs)).toEqual([
      "summary:summary",
      "rows:0:0",
      "write:1:w",
      "error:2:e",
    ]);
    const [, read, upd, err] = tabs;
    expect(read).toMatchObject({ statement: 1, sql: "SELECT a;", lines: { start: 10, end: 10 } });
    expect(upd).toMatchObject({ statement: 2, rowsAffected: 5, lines: { start: 11, end: 11 } });
    expect(err).toMatchObject({ statement: 3, message: "boom", lines: { start: 13, end: 13 } });
  });

  it("the Summary tallies rows, time and where the batch stopped", () => {
    const batch: BatchResult = {
      statements: [
        stmt(0, { results: [rows(2)], rows_affected: 2, elapsed_ms: 7 }),
        stmt(1, { is_select: false, rows_affected: 5, elapsed_ms: 3 }),
        stmt(2, { error: "boom", elapsed_ms: 1 }),
      ],
      total_affected: 5,
    };
    const [summary] = tabsFromBatch(sql(TEXT), batch, TEXTS);
    expect(summary).toMatchObject({
      kind: "summary",
      totalAffected: 5,
      totalElapsedMs: 11,
      failedAt: 3,
    });
    expect(summary.kind === "summary" && summary.statements).toEqual([
      expect.objectContaining({ statement: 1, status: "ok", rows: 2, isRead: true, tabKey: "0:0" }),
      expect.objectContaining({ statement: 2, status: "ok", rows: 5, isRead: false, tabKey: "1:w" }),
      expect.objectContaining({ statement: 3, status: "failed", error: "boom", tabKey: "2:e" }),
    ]);
  });

  it("a statement with several sets gets a tab per set, none refreshable", () => {
    const batch: BatchResult = {
      statements: [stmt(0, { results: [rows(1), rows(2)] }), stmt(1, { results: [rows(3)] })],
      total_affected: 0,
    };
    const tabs = tabsFromBatch(sql("EXEC p;\nSELECT 1"), batch, ["EXEC p;", "SELECT 1"]);
    expect(
      tabs.filter((t) => t.kind === "rows").map((t) => t.kind === "rows" && [t.statement, t.set, t.refreshable]),
    ).toEqual([
      [1, 1, false],
      [1, 2, false],
      [2, null, true],
    ]);
  });

  it("a batch whose text is not in the editor has no lines", () => {
    const batch: BatchResult = { statements: [stmt(0, { results: [rows(1)] })], total_affected: 0 };
    const [, tab] = tabsFromBatch(sql("SELECT 1;\nSELECT 2", null), batch, ["SELECT 1;", "SELECT 2"]);
    expect(tab.kind === "rows" && tab.lines).toBeNull();
  });

  it("MongoDB: no SQL is assumed — line breaks split, writes and reads tab the same way", () => {
    const origin: RunOrigin = {
      text: "db.users.find({})\ndb.users.deleteMany({ old: true })",
      firstLine: 1,
      dialect: "mongo",
    };
    const batch: BatchResult = {
      statements: [
        stmt(0, { preview: "db.users.find({})", results: [rows(2, { row_types: [] })] }),
        stmt(1, { preview: "db.users.deleteMany(…)", is_select: false, rows_affected: 4 }),
      ],
      total_affected: 4,
    };
    const tabs = tabsFromBatch(origin, batch, [
      "db.users.find({})",
      "db.users.deleteMany({ old: true })",
    ]);
    expect(kinds(tabs)).toEqual(["summary:summary", "rows:0:0", "write:1:w"]);
    expect(tabs[2]).toMatchObject({ rowsAffected: 4, lines: { start: 2, end: 2 } });
  });
});

describe("initialTabKey", () => {
  const batch = (over: StmtOutcome[]): StatementTab[] =>
    tabsFromBatch(sql("a;\nb;\nc"), { statements: over, total_affected: 0 }, ["a;", "b;", "c"]);

  it("lands on the statement that failed", () => {
    const tabs = batch([stmt(0, { results: [rows(1)] }), stmt(1, { error: "x" })]);
    expect(initialTabKey(tabs)).toBe("1:e");
  });

  it("else on the first set of rows", () => {
    const tabs = batch([stmt(0, { is_select: false }), stmt(1, { results: [rows(1)] })]);
    expect(initialTabKey(tabs)).toBe("1:0");
  });

  it("else on the Summary", () => {
    const tabs = batch([stmt(0, { is_select: false }), stmt(1, { is_select: false })]);
    expect(initialTabKey(tabs)).toBe("summary");
  });

  it("a single write lands on its own card; nothing lands nowhere", () => {
    expect(initialTabKey(tabsFromSingle(sql("DELETE"), write(1)))).toBe("0:w");
    expect(initialTabKey([])).toBeNull();
  });
});

describe("sqlPreview", () => {
  it("keeps a short statement whole, on one line", () => {
    expect(sqlPreview("SELECT 1")).toBe("SELECT 1");
    expect(sqlPreview("SELECT 1; ")).toBe("SELECT 1");
    expect(sqlPreview(`  SELECT a,
	 b
FROM t `)).toBe("SELECT a, b FROM t");
  });

  it("cuts a long one with an ellipsis", () => {
    expect(sqlPreview("UPDATE Track SET Name = Name WHERE TrackId = 1")).toBe(
      "UPDATE Track SET Name =…",
    );
  });

  it("skips leading comments, SQL and Mongo alike", () => {
    expect(sqlPreview(`-- fix the prices
UPDATE t SET p = 1`)).toBe("UPDATE t SET p = 1");
    expect(sqlPreview(`/* a
b */ DELETE FROM t`)).toBe("DELETE FROM t");
    expect(sqlPreview(`// seed
db.users.find({})`)).toBe("db.users.find({})");
  });

  it("is empty for a statement that is only a comment", () => {
    expect(sqlPreview("-- nothing")).toBe("");
  });
});
