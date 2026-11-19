import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { arrangeMenu, type MenuSpec } from "@/lib/menu/menuSpec";
import { cellMenu, selectionMenu, type GridMenuContext, type MenuCell } from "./cellMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

function ctx(over: Partial<GridMenuContext> = {}): GridMenuContext {
  return {
    t,
    language: "en",
    callbacks: {
      copyToClipboard: vi.fn(),
      copyRows: vi.fn(),
      openSidePanelEditor: vi.fn(),
      selectedColumnValues: () => ({ values: [1, 2], distinct: 2 }),
      withFullRow: (row, run) => run(row),
      isTrimmedCell: () => false,
    },
    resultColumns: [
      { name: "id", data_type: "int4" },
      { name: "customer_id", data_type: "int4" },
    ],
    columnIndexByName: new Map([
      ["id", 0],
      ["customer_id", 1],
    ]),
    driver: "postgres",
    tableName: "orders",
    pkColumnNames: ["id"],
    ...over,
  };
}

const cell = (over: Partial<MenuCell> = {}): MenuCell => ({
  rowValues: [48211, 1093],
  colIdx: 1,
  meta: { name: "customer_id", data_type: "int4" },
  value: 1093,
  isFkCell: false,
  ...over,
});

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

const editableTable: Partial<GridMenuContext> = {
  editable: true,
  onCellSave: () => Promise.resolve(),
  onNavigateFk: vi.fn(),
  onAddFilter: vi.fn(),
  onInsertRow: vi.fn(),
  onDuplicateRow: vi.fn(),
  onDeleteRow: vi.fn(),
  onBulkDelete: vi.fn(),
};

describe("cellMenu", () => {
  it("lays out an editable table's foreign-key cell", () => {
    expect(layout(cellMenu(ctx(editableTable), cell({ isFkCell: true })))).toEqual([
      "navigate:goToReference",
      "copy:copy,copyWithColumn,copyRowAs",
      "view:sideEditor",
      "filter:filterBy,filterExcluding",
      "create:insertRow,duplicateRow",
      "edit:setNull",
      "danger:deleteRow",
    ]);
  });

  it("offers a query result only what it can do: copy and view", () => {
    expect(layout(cellMenu(ctx(), cell()))).toEqual([
      "copy:copy,copyWithColumn,copyRowAs",
      "view:sideEditor",
    ]);
  });

  it("does not offer to follow a NULL foreign key", () => {
    const spec = cellMenu(ctx(editableTable), cell({ isFkCell: true, value: null }));
    expect(layout(spec)[0]).toBe("copy:copy,copyWithColumn,copyRowAs");
  });

  it("adds View as date to a plausible timestamp", () => {
    const spec = cellMenu(ctx(), cell({ value: 1763372482 }));
    expect(layout(spec)).toContain("view:sideEditor,viewAsDate");
  });

  it("tags the header with the type, and NULL only for a real NULL", () => {
    expect(cellMenu(ctx(), cell({ value: null })).header.tags).toEqual(["int4", "NULL"]);
    const trimmed = ctx({ callbacks: { ...ctx().callbacks, isTrimmedCell: () => true } });
    expect(cellMenu(trimmed, cell({ value: null })).header.tags).toEqual(["int4", false]);
  });

  it("advertises Ctrl+C on Copy, the key the grid answers", () => {
    const copy = cellMenu(ctx(), cell()).entries.find((e) => e && e.id === "copy");
    expect(copy && "shortcut" in copy && copy.shortcut).toEqual({ fixed: "copyCell" });
  });

  it("disables filtering by a value the page left on the server", () => {
    const trimmed = ctx({
      ...editableTable,
      callbacks: { ...ctx().callbacks, isTrimmedCell: () => true },
    });
    const filter = cellMenu(trimmed, cell()).entries.find((e) => e && e.id === "filterBy");
    expect(filter && "disabled" in filter && filter.disabled).toBe(true);
  });

  it("copies the cell's value from the full row", () => {
    const c = ctx();
    const copy = cellMenu(c, cell()).entries.find((e) => e && e.id === "copy");
    if (!copy || copy.kind === "submenu" || copy.kind === "custom") throw new Error("no copy");
    copy.onSelect();
    expect(c.callbacks.copyToClipboard).toHaveBeenCalledWith("1093");
  });
});

describe("selectionMenu", () => {
  const rows = [
    [48211, 1093],
    [48213, 1093],
  ];

  it("lays out a selection on an editable table", () => {
    const spec = selectionMenu(ctx(editableTable), cell(), rows);
    expect(layout(spec)).toEqual([
      "copy:copyRowsAs",
      "filter:filterIn,filterNotIn",
      "danger:deleteRows",
    ]);
    expect(spec.header.title).toBe("dataGrid.ctxRowsSelected");
  });

  it("deletes exactly the rows it was opened with", () => {
    const c = ctx(editableTable);
    const del = selectionMenu(c, cell(), rows).entries.find((e) => e && e.id === "deleteRows");
    if (!del || del.kind === "submenu" || del.kind === "custom") throw new Error("no delete");
    del.onSelect();
    expect(c.onBulkDelete).toHaveBeenCalledWith(rows);
  });
});
