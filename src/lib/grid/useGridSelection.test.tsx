// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useGridSelection } from "./useGridSelection";
import type { CellValue } from "@/types";

/** Rows keyed by their first column, the way a single-column PK behaves. */
const rows: CellValue[][] = [
  [1, "alpha"],
  [2, "beta"],
  [3, "gamma"],
  [4, "beta"],
];
const byFirstColumn = (r: CellValue[]) => String(r[0]);

function click(mods: Partial<React.MouseEvent> = {}) {
  return { ctrlKey: false, metaKey: false, shiftKey: false, ...mods } as React.MouseEvent;
}

function setup(
  visibleRows = rows,
  getRowKey: ((r: CellValue[]) => string | null) | undefined = byFirstColumn,
  onSelectionChange?: (selected: number, visible: number) => void,
) {
  return renderHook(
    ({ visibleRows }: { visibleRows: CellValue[][] }) =>
      useGridSelection({ visibleRows, getRowKey, onSelectionChange }),
    { initialProps: { visibleRows } },
  );
}

describe("useGridSelection", () => {
  it("keyOf answers a visible row from the keys already computed", () => {
    const getRowKey = vi.fn(byFirstColumn);
    const { result } = setup(rows, getRowKey);
    const calls = getRowKey.mock.calls.length;
    // One key per visible row, once — not again for each render that asks.
    expect(calls).toBe(rows.length);
    expect(rows.map((r) => result.current.keyOf(r))).toEqual(["1", "2", "3", "4"]);
    expect(getRowKey.mock.calls.length).toBe(calls);
    // A row outside the visible set still gets an answer.
    expect(result.current.keyOf([9, "zeta"])).toBe("9");
  });

  it("keyOf is null for every row when the grid has no row identity", () => {
    // Not `setup(rows, undefined)`: that would take its default key.
    const { result } = renderHook(() =>
      useGridSelection({ visibleRows: rows, getRowKey: undefined }),
    );
    expect(result.current.keyOf(rows[0])).toBeNull();
  });
  it("toggles a single row and reports it by value, not index", () => {
    const { result } = setup();
    act(() => result.current.toggleRowKey("2"));
    // Identity is the key, and what comes back is the row payload — never a
    // display index (ADR #7).
    expect(result.current.selectedRows).toEqual([[2, "beta"]]);
    act(() => result.current.toggleRowKey("2"));
    expect(result.current.selectedRows).toEqual([]);
  });

  it("returns selected rows in visible order, not click order", () => {
    const { result } = setup();
    act(() => result.current.toggleRowKey("4"));
    act(() => result.current.toggleRowKey("1"));
    expect(result.current.selectedRows.map((r) => r[0])).toEqual([1, 4]);
  });

  it("refuses to select a row with no resolvable key", () => {
    const { result } = setup(rows, () => null);
    act(() => result.current.applyRowSelectionClick(null, click()));
    expect(result.current.hasSelection).toBe(false);
    expect(result.current.allSelected).toBe(false);
  });

  describe("click semantics", () => {
    it("Ctrl/Cmd-click toggles one row into the selection", () => {
      const { result } = setup();
      act(() => result.current.applyRowSelectionClick("2", click({ ctrlKey: true })));
      act(() => result.current.applyRowSelectionClick("4", click({ metaKey: true })));
      expect(result.current.selectedRows.map((r) => r[0])).toEqual([2, 4]);
    });

    it("Shift-click extends a contiguous range from the anchor", () => {
      const { result } = setup();
      act(() => result.current.applyRowSelectionClick("2", click({ ctrlKey: true })));
      act(() => result.current.applyRowSelectionClick("4", click({ shiftKey: true })));
      expect(result.current.selectedRows.map((r) => r[0])).toEqual([2, 3, 4]);
    });

    it("Shift-click extends backwards too", () => {
      const { result } = setup();
      act(() => result.current.applyRowSelectionClick("4", click({ ctrlKey: true })));
      act(() => result.current.applyRowSelectionClick("2", click({ shiftKey: true })));
      expect(result.current.selectedRows.map((r) => r[0])).toEqual([2, 3, 4]);
    });

    it("Shift-click with no anchor degrades to a single toggle", () => {
      const { result } = setup();
      act(() => result.current.applyRowSelectionClick("3", click({ shiftKey: true })));
      expect(result.current.selectedRows.map((r) => r[0])).toEqual([3]);
    });

    it("a plain click clears a multi-selection", () => {
      const { result } = setup();
      act(() => result.current.applyRowSelectionClick("1", click({ ctrlKey: true })));
      act(() => result.current.applyRowSelectionClick("2", click({ ctrlKey: true })));
      act(() => result.current.applyRowSelectionClick("3", click()));
      expect(result.current.hasSelection).toBe(false);
    });
  });

  describe("select all", () => {
    it("selects every selectable visible row, then clears", () => {
      const { result } = setup();
      act(() => result.current.toggleSelectAll());
      expect(result.current.allSelected).toBe(true);
      expect(result.current.someSelected).toBe(false);
      expect(result.current.selectedRows).toHaveLength(4);
      act(() => result.current.toggleSelectAll());
      expect(result.current.hasSelection).toBe(false);
    });

    it("reports someSelected while the selection is partial", () => {
      const { result } = setup();
      act(() => result.current.toggleRowKey("1"));
      expect(result.current.allSelected).toBe(false);
      expect(result.current.someSelected).toBe(true);
    });

    it("is not 'all selected' over an empty grid", () => {
      const { result } = setup([]);
      expect(result.current.allSelected).toBe(false);
    });
  });

  it("prunes keys whose row is no longer visible", () => {
    const { result, rerender } = setup();
    act(() => result.current.toggleSelectAll());
    expect(result.current.selectedRows).toHaveLength(4);
    // A refetch dropped two rows: the user must not be left about to delete
    // something they can no longer see.
    rerender({ visibleRows: [rows[0], rows[1]] });
    expect(result.current.selectedRows.map((r) => r[0])).toEqual([1, 2]);
    expect(result.current.allSelected).toBe(true);
  });

  it("mirrors (selected, visible) up to the parent", () => {
    const onSelectionChange = vi.fn();
    const { result } = setup(rows, byFirstColumn, onSelectionChange);
    expect(onSelectionChange).toHaveBeenLastCalledWith(0, 4);
    act(() => result.current.toggleRowKey("2"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(1, 4);
  });

  describe("selectedColumnValues", () => {
    it("counts distinct values, not rows", () => {
      const { result } = setup();
      act(() => result.current.toggleSelectAll());
      // "beta" twice: the backend dedupes the IN list, so the menu label must
      // promise 3, not 4.
      const { values, distinct } = result.current.selectedColumnValues(1);
      expect(values).toEqual(["alpha", "beta", "gamma", "beta"]);
      expect(distinct).toBe(3);
    });

    it("counts NULL apart from the empty string", () => {
      // `formatValue(null)` is "", so folding NULL in with the formatted values
      // would undercount a column holding both.
      const mixed: CellValue[][] = [[1, null], [2, ""], [3, null]];
      const { result } = setup(mixed);
      act(() => result.current.toggleSelectAll());
      expect(result.current.selectedColumnValues(1).distinct).toBe(2);
    });

    it("treats a missing cell as NULL", () => {
      const short: CellValue[][] = [[1]];
      const { result } = setup(short);
      act(() => result.current.toggleSelectAll());
      expect(result.current.selectedColumnValues(1).values).toEqual([null]);
    });
  });
});
