/**
 * @vitest-environment jsdom
 *
 * A column the managed policy locks (ADR #113) opens the way a read-only
 * grid's cells do — as a viewer — while its neighbours still edit inline.
 */

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useCellEditing } from "./useCellEditing";
import type { TrimmedRows } from "./trimmedCells";
import type { CellValue, ColumnMeta } from "@/types";

const estado = { name: "estado", data_type: "varchar" } as ColumnMeta;
const importe = { name: "importe", data_type: "decimal" } as ColumnMeta;
const row: CellValue[] = ["Abierto", "12.50"];

function setup() {
  return renderHook(() =>
    useCellEditing({
      editable: true,
      connectionId: "erp",
      tableSchema: "dbo",
      tableName: "pedidos",
      tabId: "t1",
      cellEditorMode: "modal",
      columnInfoByName: new Map(),
      columnIndexByName: new Map([
        ["estado", 0],
        ["importe", 1],
      ]),
      columnLock: (c) => (c === "importe" ? "locked" : null),
      onCellSave: async () => {},
      onFieldSave: undefined,
    }),
  );
}

describe("useCellEditing with a column lock", () => {
  it("edits an allowed column inline", () => {
    const { result } = setup();
    act(() => result.current.openCellEdit(row, estado));
    expect(result.current.inlineEdit?.column.name).toBe("estado");
    expect(result.current.editorOpen).toBe(false);
  });

  it("opens a locked column as a viewer instead", () => {
    const { result } = setup();
    act(() => result.current.openCellEdit(row, importe));
    expect(result.current.inlineEdit).toBeNull();
    expect(result.current.editorOpen).toBe(true);
    expect(result.current.editorTarget?.value).toBe("12.50");
  });
});

/**
 * A row the page cut a cell of (ADR #133) holds a stand-in `null` there. No
 * editor may open on that: every opener loads the row and reads the value
 * from what came back, whatever the caller passed.
 */
describe("useCellEditing on a row with a cut cell", () => {
  const log = { name: "log", data_type: "array" } as ColumnMeta;
  const cutRow: CellValue[] = ["a1", null];
  const loadedRow: CellValue[] = ["a1", [{ role: "SYSTEM", content: "big" }]];
  const trimmed: TrimmedRows = {
    of: (r) =>
      r === cutRow
        ? new Map([["log", { bytes: 1_500_000, type: "array" }]])
        : undefined,
    hydrate: async (r) => (r === cutRow ? loadedRow : r),
  };

  function setupCut(mode: "modal" | "side" = "modal") {
    return renderHook(() =>
      useCellEditing({
        editable: true,
        connectionId: "mongo",
        tableSchema: "iMesPyme",
        tableName: "aiAgentLog",
        tabId: "t1",
        cellEditorMode: mode,
        columnInfoByName: new Map(),
        columnIndexByName: new Map([
          ["_id", 0],
          ["log", 1],
        ]),
        onCellSave: async () => {},
        onFieldSave: async () => {},
        trimmed,
      }),
    );
  }

  it("starts an inline edit on the loaded value, against the loaded row", async () => {
    const { result } = setupCut();
    await act(async () => result.current.openCellEdit(cutRow, log));
    expect(result.current.inlineEdit?.rowValues).toBe(loadedRow);
    expect(result.current.inlineEdit?.value).toBe(JSON.stringify(loadedRow[1]));
  });

  it("opens the heavy editor on the loaded value, not the caller's", async () => {
    const { result } = setupCut();
    await act(async () => result.current.openHeavyEditor(cutRow, log, ""));
    expect(result.current.editorTarget?.rowValues).toBe(loadedRow);
    expect(result.current.editorTarget?.value).toBe(JSON.stringify(loadedRow[1]));
  });

  it("reads a list-view field at its path from the loaded row", async () => {
    const { result } = setupCut();
    await act(async () =>
      result.current.openHeavyEditor(cutRow, log, "", {
        path: ["log"],
        type: "array",
      }),
    );
    expect(JSON.parse(result.current.editorTarget!.value)).toEqual(loadedRow[1]);
  });

  it("opens nothing when the load fails", async () => {
    const failing: TrimmedRows = {
      ...trimmed,
      hydrate: () => Promise.reject(new Error("gone")),
    };
    const { result } = renderHook(() =>
      useCellEditing({
        editable: true,
        connectionId: "mongo",
        tableSchema: undefined,
        tableName: "aiAgentLog",
        tabId: "t1",
        cellEditorMode: "modal",
        columnInfoByName: new Map(),
        columnIndexByName: new Map([
          ["_id", 0],
          ["log", 1],
        ]),
        onCellSave: async () => {},
        onFieldSave: undefined,
        trimmed: failing,
      }),
    );
    await act(async () => result.current.openCellEdit(cutRow, log));
    expect(result.current.inlineEdit).toBeNull();
    expect(result.current.editorOpen).toBe(false);
  });

  it("leaves a whole row alone, synchronously", () => {
    const { result } = setupCut();
    act(() => result.current.openHeavyEditor(loadedRow, log, "as given"));
    expect(result.current.editorTarget?.value).toBe("as given");
  });
});
