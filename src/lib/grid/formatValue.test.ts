import { describe, expect, it, vi } from "vitest";

import type { CellValue } from "@/types";
import {
  cellDisplayText,
  formatValue,
  jsonPrefix,
  rawCellText,
  truncateForDisplay,
} from "./formatValue";

describe("formatValue", () => {
  it("renders NULL as the empty string, not the word", () => {
    // The grid draws its own NULL affordance, and a client-side search for
    // "null" must not match every empty cell.
    expect(formatValue(null)).toBe("");
    // `undefined` is not in `CellValue`, but a sparse row from a driver that
    // omitted a column reaches this as one, so the guard covers it too.
    expect(formatValue(undefined as unknown as null)).toBe("");
  });

  it("passes primitives through as text", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(false)).toBe("false");
    expect(formatValue("already text")).toBe("already text");
  });

  it("serialises objects and arrays as JSON", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, "two"])).toBe('[1,"two"]');
  });
});

describe("cellDisplayText", () => {
  // What the cell used to paint, built the expensive way.
  const reference = (v: CellValue, at: number) =>
    truncateForDisplay(rawCellText(v, false, "true_false"), at);

  const samples: CellValue[] = [
    null,
    "",
    "short",
    "x".repeat(500),
    42,
    true,
    {},
    [],
    { a: 1, b: "two", c: [1, 2, { d: null }], e: { f: true } },
    [1, "two", null, [3, [4]], { k: "v" }],
    // Escapes lengthen the text past its source length.
    { quote: 'he said "hi"\n\ttab\slash', ctl: "\u0001\u001f" },
    // A surrogate pair straddling every possible cut point.
    { emoji: "a😀".repeat(150) },
    ["😀".repeat(300)],
    { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, neg: -0.5 },
    { skipped: undefined, kept: 1 } as unknown as object,
    [undefined, 1] as unknown as object,
    { nested: { deep: { deeper: "y".repeat(1000) } } },
  ];

  it("paints exactly what truncating the whole text painted", () => {
    for (const v of samples) {
      for (const at of [0, 1, 2, 5, 17, 50, 200, 199, 201, 5000]) {
        expect(
          cellDisplayText(v, false, "true_false", at),
          `${JSON.stringify(v)} @${at}`,
        ).toBe(reference(v, at));
      }
    }
  });

  it("keeps the BIT rendering for numbers in a BIT column", () => {
    expect(cellDisplayText(1, true, "true_false", 200)).toBe(
      rawCellText(1, true, "true_false"),
    );
  });

  it("does not serialise the whole of a huge nested value", () => {
    const huge = "z".repeat(2_000_000);
    const doc = { list: [{ role: "SYSTEM", content: huge }], tail: 1 };
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const text = cellDisplayText(doc, false, "true_false", 200);
      expect(text).toBe(`${JSON.stringify(doc).slice(0, 200)}…`);
      const calls = spy.mock.calls.length;
      // The reference above is the one call allowed to see the whole value.
      const biggest = Math.max(
        ...spy.mock.calls
          .slice(0, calls - 1)
          .map(([arg]) => (typeof arg === "string" ? arg.length : 0)),
      );
      expect(biggest).toBeLessThan(1000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("jsonPrefix", () => {
  it("returns the whole text when it is shorter than the limit", () => {
    expect(jsonPrefix({ a: [1, "b"] }, 1000)).toBe('{"a":[1,"b"]}');
  });

  it("returns exactly the first limit characters otherwise", () => {
    const v = { a: "x".repeat(100), b: [1, 2, 3] };
    for (const n of [1, 2, 6, 7, 50, 105, 106, 110]) {
      expect(jsonPrefix(v, n)).toBe(JSON.stringify(v).slice(0, n));
    }
  });
});
