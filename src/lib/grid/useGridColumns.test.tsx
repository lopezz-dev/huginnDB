// @vitest-environment jsdom
/**
 * `useGridColumns`'s own header comment calls its dependency array
 * "load-bearing": `columnDef.cell` is treated by TanStack as a component
 * TYPE, so rebuilding the `columns` array on every render remounts the
 * entire table body mid-edit (the cursor-jumps-to-the-end bug). That
 * invariant only holds if callers actually keep `GridColumnsOptions`
 * referentially stable across renders that change nothing relevant —
 * which used to be false for `TableDataTab`'s `onCellSave` (rebuilt on
 * every render as a plain function declaration). This characterizes the
 * hook's own half of the contract: stable input in, stable `columns` out.
 */
import "@/lib/i18n";
import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGridColumns, type GridColumnsOptions } from "./useGridColumns";
import type { ColumnMeta } from "@/types";

const resultColumns: ColumnMeta[] = [
  { name: "id", data_type: "INTEGER" },
  { name: "name", data_type: "TEXT" },
];

function baseOptions(
  overrides: Partial<GridColumnsOptions> = {},
): GridColumnsOptions {
  return {
    resultColumns,
    display: {
      numericColNames: new Set(["id"]),
      bitColNames: new Set(),
      bitDisplay: "true_false",
      nullDisplay: "NULL",
      truncateLongTextAt: 500,
      expandCellCombo: "Mod+E",
    },
    meta: {
      columnInfoByName: new Map(),
      columnIndexByName: new Map([["id", 0], ["name", 1]]),
      pkNameSet: new Set(["id"]),
      fkNameSet: new Set(),
      boundSchemaNames: new Map(),
    },
    editing: {
      interactiveRef: { current: { fkEditCell: null, inlineEdit: null, selectedCell: null } },
      setFkEditCell: () => {},
      setInlineEdit: () => {},
      openHeavyEditor: () => {},
    },
    sort: undefined,
    onSortChange: undefined,
    connectionId: "conn-1",
    tableSchema: "public",
    onCellSave: async () => {},
    ...overrides,
  };
}

describe("useGridColumns", () => {
  it("returns the same columns reference across a render with unchanged options", () => {
    const options = baseOptions();
    const { result, rerender } = renderHook(
      (opts: GridColumnsOptions) => useGridColumns(opts),
      { initialProps: options },
    );
    const first = result.current;
    // Same values, but options is otherwise identical — including
    // `onCellSave`'s reference, which a caller must keep stable itself
    // (TableDataTab does via useCallback; this hook can't fix an unstable
    // caller, only honor a stable one).
    rerender(options);
    expect(result.current).toBe(first);
  });

  it("rebuilds columns when onCellSave's identity changes", () => {
    const options = baseOptions();
    const { result, rerender } = renderHook(
      (opts: GridColumnsOptions) => useGridColumns(opts),
      { initialProps: options },
    );
    const first = result.current;
    rerender(baseOptions({ onCellSave: async () => {} }));
    expect(result.current).not.toBe(first);
  });

  it("does NOT rebuild columns when only interactiveRef's mutable content changes", () => {
    // fkEditCell/inlineEdit/selectedCell are read through the ref at render
    // time inside `cell`, deliberately excluded from the dependency array —
    // otherwise every click (which flips this ref's content) would rebuild
    // every column definition, defeating the whole point of the ref.
    const options = baseOptions();
    const { result, rerender } = renderHook(
      (opts: GridColumnsOptions) => useGridColumns(opts),
      { initialProps: options },
    );
    const first = result.current;
    options.editing.interactiveRef.current = {
      fkEditCell: null,
      inlineEdit: null,
      selectedCell: { rowValues: [1, "alpha"], column: resultColumns[0] },
    };
    rerender(options);
    expect(result.current).toBe(first);
  });

  it("rebuilds columns when resultColumns changes", () => {
    const options = baseOptions();
    const { result, rerender } = renderHook(
      (opts: GridColumnsOptions) => useGridColumns(opts),
      { initialProps: options },
    );
    const first = result.current;
    rerender(
      baseOptions({
        resultColumns: [...resultColumns, { name: "extra", data_type: "TEXT" }],
      }),
    );
    expect(result.current).not.toBe(first);
    expect(result.current).toHaveLength(3);
  });
});

describe("useGridColumns policy marks", () => {
  it("marks a column it can't change apart from one only a new row may fill", () => {
    const options = baseOptions();
    const { result } = renderHook(() =>
      useGridColumns({
        ...options,
        meta: {
          ...options.meta,
          lockedNameSet: new Set(["id"]),
          insertOnlyNameSet: new Set(["name"]),
        },
      }),
    );
    const header = (i: number) => {
      const h = result.current[i].header as () => JSX.Element;
      return render(h());
    };
    header(0);
    expect(screen.getByLabelText("Locked by your organization's policy")).toBeTruthy();
    header(1);
    expect(
      screen.getByLabelText(
        "Locked by your organization's policy — only filled when adding a row",
      ),
    ).toBeTruthy();
  });
});
