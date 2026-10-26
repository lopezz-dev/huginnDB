/**
 * @vitest-environment jsdom
 *
 * A column the managed policy locks (ADR #113) opens the way a read-only
 * grid's cells do — as a viewer — while its neighbours still edit inline.
 */

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useCellEditing } from "./useCellEditing";
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
