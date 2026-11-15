import { describe, expect, it } from "vitest";
import { cutBy, MAX_ADHOC_QUERY_ROWS } from "./resultCap";
import type { QueryResult } from "@/types";

const result = (n: number, truncated?: boolean): QueryResult => ({
  columns: [{ name: "a", data_type: "int" }],
  rows: Array.from({ length: n }, (_, i) => [i]),
  rows_affected: n,
  elapsed_ms: 0,
  total: null,
  truncated,
});

describe("cutBy", () => {
  it("is null for a whole result, marked or not", () => {
    expect(cutBy(result(3))).toBeNull();
    expect(cutBy(result(3, false))).toBeNull();
  });

  it("blames the statement's own cap when the result holds the full cap", () => {
    expect(cutBy(result(MAX_ADHOC_QUERY_ROWS, true))).toBe("statement");
  });

  it("blames the batch budget when it was cut short of the cap", () => {
    expect(cutBy(result(MAX_ADHOC_QUERY_ROWS - 1, true))).toBe("budget");
    expect(cutBy(result(0, true))).toBe("budget");
  });
});
