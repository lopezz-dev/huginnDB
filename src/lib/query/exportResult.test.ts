/**
 * Export of a query's results (ADR #135, ADR #138): which formats are offered
 * and what reaches the backend, which writes every file. What the files hold
 * is pinned on the Rust side and by `exportResult.golden.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlTarget } from "@/lib/grid/copyFormats";

const exportQueryResult = vi.fn();
vi.mock("@/lib/tauri", () => ({
  api: { exportQueryResult: (...a: unknown[]) => exportQueryResult(...a) },
}));

import { EXPORT_FORMATS, exportFormats, exportResult, serverTarget } from "./exportResult";

const columns = [
  { name: "id", data_type: "int" },
  { name: "p", data_type: "numeric" },
  { name: "doubled", data_type: "numeric" },
];
const rows = [
  [7, "9.50", "19.00"],
  [8, null, null],
];
const as: Record<string, string | null> = { id: "id", p: "price", doubled: null };
const target: SqlTarget = { table: "items", columnOf: (c) => as[c] ?? null, pkColumns: ["id"] };

beforeEach(() => exportQueryResult.mockReset().mockResolvedValue("/tmp/x"));

describe("exportFormats", () => {
  it("offers SQL only when the result names one table, Excel always", () => {
    expect(exportFormats(target)).toEqual(["csv", "csvSemicolon", "xlsx", "json", "sql"]);
    expect(exportFormats(undefined)).toEqual(["csv", "csvSemicolon", "xlsx", "json"]);
  });

  it("a table offers every format, in the same order", () => {
    expect(EXPORT_FORMATS).toEqual(exportFormats(target));
  });
});

describe("serverTarget", () => {
  it("evaluates the table column of each result column, in result order", () => {
    expect(serverTarget("sql", target, columns)).toEqual({
      table: "items",
      columns: ["id", "price", null],
    });
  });

  it("is absent for every other format, and without a table", () => {
    expect(serverTarget("csv", target, columns)).toBeUndefined();
    expect(serverTarget("xlsx", target, columns)).toBeUndefined();
    expect(serverTarget("sql", undefined, columns)).toBeUndefined();
  });
});

describe("exportResult", () => {
  it("hands the backend the rows as they are, under the result's own names", async () => {
    await exportResult("c1", "xlsx", { rows, columns, target });
    expect(exportQueryResult).toHaveBeenCalledWith(
      "c1",
      "xlsx",
      ["id", "p", "doubled"],
      rows,
      undefined,
    );
  });

  it("sends the table an INSERT names with a SQL export", async () => {
    await exportResult("c1", "sql", { rows, columns, target });
    expect(exportQueryResult.mock.calls[0][4]).toEqual({
      table: "items",
      columns: ["id", "price", null],
    });
  });
});
