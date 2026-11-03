import { describe, expect, it } from "vitest";

import { describeTrimmed, indexTrimmed, mergeLoadedRow } from "./trimmedCells";
import type { QueryResult } from "@/types";

function page(): QueryResult {
  return {
    columns: [
      { name: "_id", data_type: "string" },
      { name: "log", data_type: "array" },
      { name: "n", data_type: "int" },
    ],
    rows: [
      ["a", null, 1],
      ["b", [1], 2],
    ],
    rows_affected: 2,
    elapsed_ms: 0,
    total: null,
    row_types: [
      ["string", "array", "int"],
      ["string", ["int"], "int"],
    ],
    trimmed: [{ row: 0, column: 1, bytes: 1_500_000 }],
  };
}

describe("indexTrimmed", () => {
  it("finds a row's cut cells by the row array itself", () => {
    const p = page();
    const index = indexTrimmed(p);
    expect(index.get(p.rows[0])?.get("log")).toEqual({ bytes: 1_500_000, type: "array" });
    expect(index.get(p.rows[1])).toBeUndefined();
  });

  it("is empty for a page with nothing cut, or no page", () => {
    const p = { ...page(), trimmed: undefined };
    expect(indexTrimmed(p).get(p.rows[0])).toBeUndefined();
    expect(indexTrimmed(null)).toBeInstanceOf(WeakMap);
  });
});

describe("mergeLoadedRow", () => {
  // The loaded document comes back with its own column order, and without a
  // field the page has a column for.
  const loaded: QueryResult = {
    columns: [
      { name: "log", data_type: "array" },
      { name: "_id", data_type: "string" },
    ],
    rows: [[[{ role: "SYSTEM" }], "a"]],
    rows_affected: 1,
    elapsed_ms: 0,
    total: null,
    row_types: [[[{ role: "string" }], "string"]],
  };

  it("lays the document out on the page's columns, by name", () => {
    const merged = mergeLoadedRow(page(), 0, loaded);
    expect(merged.rows[0]).toEqual(["a", [{ role: "SYSTEM" }], null]);
    expect(merged.row_types?.[0]).toEqual(["string", [{ role: "string" }], "null"]);
  });

  it("drops the row's cuts and leaves every other row untouched", () => {
    const p = page();
    const merged = mergeLoadedRow(p, 0, loaded);
    expect(merged.trimmed).toBeUndefined();
    expect(merged.rows[1]).toBe(p.rows[1]);
    // A new array for the loaded row: identity is how the grid tracks rows.
    expect(merged.rows[0]).not.toBe(p.rows[0]);
    expect(merged.rows).not.toBe(p.rows);
  });
});

describe("describeTrimmed", () => {
  it("reads as the picker's type label and a size", () => {
    expect(describeTrimmed({ bytes: 1_550_000, type: "array" })).toBe("Array · 1.5 MB");
    expect(describeTrimmed({ bytes: 737_280, type: "document" })).toBe("Object · 720.0 KB");
  });
});
