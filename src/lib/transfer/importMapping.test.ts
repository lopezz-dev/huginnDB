import { describe, expect, it } from "vitest";

import {
  carryMapping,
  defaultMapping,
  previewCell,
  toColumnSources,
} from "./importMapping";

describe("defaultMapping", () => {
  it("matches file columns by name, ignoring case and blanks", () => {
    expect(
      defaultMapping(["Id", "Name", "note"], [" name ", "ID", "other"]),
    ).toEqual({ Id: 1, Name: 0, note: null });
  });

  it("takes the first of two file columns with one name", () => {
    expect(defaultMapping(["a"], ["A", "a"])).toEqual({ a: 0 });
  });

  it("leaves a column the policy withholds unmapped", () => {
    expect(defaultMapping(["id", "price"], ["id", "price"], ["id"])).toEqual({
      id: 0,
      price: null,
    });
  });
});

describe("toColumnSources", () => {
  it("lists only mapped columns, in table order", () => {
    expect(
      toColumnSources(["a", "b", "c"], { c: 0, a: 2, b: null }),
    ).toEqual([
      { column: "a", source: 2 },
      { column: "c", source: 0 },
    ]);
  });
});

describe("carryMapping", () => {
  it("keeps choices still in range and resets the rest", () => {
    const fresh = { a: 0, b: 1, c: null };
    expect(carryMapping({ a: 3, b: null, c: 1 }, fresh, 2)).toEqual({
      a: 0,
      b: null,
      c: 1,
    });
  });

  it("is the fresh mapping the first time", () => {
    expect(carryMapping(null, { a: 0 }, 1)).toEqual({ a: 0 });
  });
});

describe("previewCell", () => {
  it("renders nulls, objects and scalars", () => {
    expect(previewCell(null)).toBe("NULL");
    expect(previewCell({ n: 1 })).toBe('{"n":1}');
    expect(previewCell(3.5)).toBe("3.5");
    expect(previewCell(true)).toBe("true");
  });
});
