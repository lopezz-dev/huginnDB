import { describe, expect, it } from "vitest";

import {
  nextOffset,
  offsetForRow,
  pageWindow,
  prevOffset,
  rowNumber,
} from "./pagination";

const base = { offset: 0, pageSize: 100, total: 250, totalEstimated: false, rowsOnPage: 100 };

describe("pageWindow", () => {
  it("labels the page 1-based and clamps the end to an exact total", () => {
    expect(pageWindow({ ...base, offset: 200 })).toMatchObject({ from: 201, to: 250 });
  });

  it("shows a full-page range while the count is unknown", () => {
    expect(pageWindow({ ...base, offset: 200, total: null })).toMatchObject({
      from: 201,
      to: 300,
    });
  });

  it("stops at the last page when the total is exact", () => {
    expect(pageWindow({ ...base, offset: 200 }).canNext).toBe(false);
    expect(pageWindow({ ...base, offset: 100 }).canNext).toBe(true);
  });

  it("keeps going past an estimated total while pages come back full", () => {
    // A stale-statistics estimate that undershoots must not strand the user:
    // the page is full, so there may well be more.
    const w = pageWindow({ ...base, offset: 200, total: 250, totalEstimated: true });
    expect(w.canNext).toBe(true);
  });

  it("disables Next on a short page when the total is unknown", () => {
    expect(
      pageWindow({ ...base, offset: 200, total: null, rowsOnPage: 42 }).canNext,
    ).toBe(false);
  });

  it("disables Prev only on the first page", () => {
    expect(pageWindow(base).canPrev).toBe(false);
    expect(pageWindow({ ...base, offset: 100 }).canPrev).toBe(true);
  });
});

describe("offsets", () => {
  it("never walks before the first page", () => {
    expect(prevOffset(50, 100)).toBe(0);
    expect(prevOffset(100, 100)).toBe(0);
    expect(nextOffset(100, 100)).toBe(200);
  });
});

describe("offsetForRow", () => {
  it("puts the asked-for row at the top of the page", () => {
    expect(offsetForRow("250", 19759, false)).toBe(249);
    expect(offsetForRow(" 1 ", null, false)).toBe(0);
  });

  it("clamps past an exact total, but not past an estimate", () => {
    expect(offsetForRow("999", 17, false)).toBe(16);
    expect(offsetForRow("999", 17, true)).toBe(998);
  });

  it("refuses anything that is not a row number", () => {
    for (const bad of ["", "0", "-3", "2.5", "abc", "1e3"]) {
      expect(offsetForRow(bad, 100, false)).toBeNull();
    }
  });
});

describe("rowNumber", () => {
  it("counts from 1 on the first page", () => {
    expect(rowNumber(0, 0)).toBe(1);
    expect(rowNumber(0, 99)).toBe(100);
  });

  it("is absolute on later pages, not restarting at 1", () => {
    // Page 2 of 100 rows/page: its first row is row 101.
    expect(rowNumber(100, 0)).toBe(101);
    expect(rowNumber(100, 99)).toBe(200);
  });

  it("agrees with the footer's range and with go-to-row", () => {
    const offset = offsetForRow("250", 1000, false)!;
    const page = pageWindow({ ...base, offset, total: 1000 });
    expect(rowNumber(offset, 0)).toBe(250);
    expect(rowNumber(offset, 0)).toBe(page.from);
    expect(rowNumber(offset, 99)).toBe(page.to);
  });
});
