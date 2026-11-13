/**
 * Export of a query's results (ADR #135): which formats are offered, what
 * each writes, and what reaches the backend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlTarget } from "@/lib/grid/copyFormats";

const exportQueryResult = vi.fn();
vi.mock("@/lib/tauri", () => ({
  api: { exportQueryResult: (...a: unknown[]) => exportQueryResult(...a) },
}));

import { exportFormats, exportResult, serializeResult } from "./exportResult";

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
  it("offers SQL only when the result names one table", () => {
    expect(exportFormats(target)).toEqual(["csv", "json", "sql"]);
    expect(exportFormats(undefined)).toEqual(["csv", "json"]);
  });
});

describe("serializeResult", () => {
  const input = { rows, columns, driver: "postgres" as const, target };

  it("CSV keeps the names the query gave, aliases and expressions included", () => {
    expect(serializeResult("csv", input)).toBe(
      "﻿id,p,doubled\r\n7,9.50,19.00\r\n8,,\r\n",
    );
  });

  it("JSON keeps them too", () => {
    expect(JSON.parse(serializeResult("json", input))).toEqual([
      { id: 7, p: "9.50", doubled: "19.00" },
      { id: 8, p: null, doubled: null },
    ]);
  });

  it("SQL addresses the table through its aliases, leaving expressions out", () => {
    expect(serializeResult("sql", input)).toBe(
      'INSERT INTO "items" ("id", "price") VALUES (7, \'9.50\');\n' +
        'INSERT INTO "items" ("id", "price") VALUES (8, NULL);\n',
    );
  });

  it("refuses SQL without a table to insert into", () => {
    expect(() => serializeResult("sql", { ...input, target: undefined })).toThrow();
  });
});

describe("exportResult", () => {
  it("hands the backend the serialised rows with a name from the table", async () => {
    await exportResult("c1", "csv", { rows, columns, driver: "postgres", target });
    expect(exportQueryResult).toHaveBeenCalledWith(
      "c1",
      "items_results",
      "csv",
      "﻿id,p,doubled\r\n7,9.50,19.00\r\n8,,\r\n",
    );
  });

  it("names the file generically over several tables", async () => {
    await exportResult("c1", "json", { rows, columns, driver: "postgres", target: undefined });
    expect(exportQueryResult.mock.calls[0][1]).toBe("query_results");
  });
});
