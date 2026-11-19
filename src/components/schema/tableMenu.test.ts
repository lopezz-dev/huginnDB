import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/ai/runTask", () => ({ runAiTask: vi.fn(() => Promise.resolve()) }));

import { copyToClipboard } from "@/lib/clipboard";
import { arrangeMenu, type MenuSpec } from "@/lib/menu/menuSpec";
import type { TableActions } from "@/lib/schema/tableActions";
import type { Driver, TableInfo } from "@/types";
import { tableMenu, type TableMenuContext } from "./tableMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

const actions = (driver: Driver): TableActions => ({
  openTab: vi.fn(),
  onOpenQuery: vi.fn(),
  refresh: vi.fn(),
  onRename: vi.fn(),
  onDrop: vi.fn(),
  onEmpty: vi.fn(),
  onImportFile: vi.fn(),
  onRenameView: vi.fn(),
  onDropView: vi.fn(),
  driver,
});

const table: TableInfo = { schema: "public", name: "orders", kind: "table", row_count: 48214 };
const view: TableInfo = { schema: "public", name: "v_daily_sales", kind: "view" };

function ctx(over: Partial<TableMenuContext> & { driver?: Driver } = {}): TableMenuContext {
  const { driver = "postgres", ...rest } = over;
  return {
    t,
    connectionId: "pg",
    table,
    actions: actions(driver),
    lock: () => null,
    openTable: vi.fn(),
    ...rest,
  };
}

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

const find = (spec: MenuSpec, id: string) => {
  const entry = spec.entries.find((e) => e && e.id === id);
  if (!entry || entry.kind === "submenu" || entry.kind === "custom") throw new Error(id);
  return entry;
};

const common = ["navigate:open", "copy:copyName,copySelect", "view:refresh,documentWithAi"];

describe("tableMenu", () => {
  it("lays out a SQL table, with Empty now red beside Drop", () => {
    expect(layout(tableMenu(ctx()))).toEqual([
      ...common,
      "create:newQuery",
      "edit:editStructure,rename",
      "transfer:importFile",
      "danger:empty,drop",
    ]);
  });

  it("lays out a SQL view", () => {
    expect(layout(tableMenu(ctx({ table: view })))).toEqual([
      ...common,
      "create:newQuery",
      "edit:editView,renameView",
      "danger:dropView",
    ]);
  });

  it("lays out a MongoDB collection", () => {
    const coll: TableInfo = { schema: "crm", name: "users", kind: "table" };
    expect(layout(tableMenu(ctx({ driver: "mongodb", table: coll })))).toEqual([
      ...common,
      "create:newQuery,newAggregation",
      "edit:indexes,rename",
      "danger:empty,drop",
    ]);
  });

  it("lays out a MongoDB view: its pipeline, and drop", () => {
    const mview: TableInfo = { schema: "crm", name: "active_users", kind: "view" };
    expect(layout(tableMenu(ctx({ driver: "mongodb", table: mview })))).toEqual([
      ...common,
      "create:newQuery",
      "edit:editPipeline",
      "danger:dropView",
    ]);
  });

  it("tags the header with the kind of relation", () => {
    expect(tableMenu(ctx()).header).toEqual({
      title: "orders",
      tags: ["schema.context.kind.table"],
    });
    expect(tableMenu(ctx({ table: view })).header.tags).toEqual(["schema.context.kind.view"]);
    expect(tableMenu(ctx({ driver: "mongodb" })).header.tags).toEqual([
      "schema.context.kind.collection",
    ]);
  });

  it("names the query action the new way", () => {
    expect(find(tableMenu(ctx()), "newQuery").label).toBe("schema.context.newQueryOnTable");
  });

  it("carries the policy's reason on each guarded action", () => {
    const lock = (need: string) => `no ${need}`;
    const spec = tableMenu(ctx({ lock }));
    expect(find(spec, "open").locked).toBe("no read");
    expect(find(spec, "newQuery").locked).toBe("no freeSql");
    expect(find(spec, "editStructure").locked).toBe("no read");
    expect(find(spec, "importFile").locked).toBe("no insert");
    for (const id of ["rename", "empty", "drop"]) expect(find(spec, id).locked).toBe("no ddl");
  });

  it("opens the tab the row's click opens, and edits on this connection and schema", () => {
    const c = ctx();
    const spec = tableMenu(c);
    find(spec, "open").onSelect();
    expect(c.openTable).toHaveBeenCalled();
    find(spec, "editStructure").onSelect();
    expect(c.actions.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "structure",
        structureMode: "edit",
        connectionId: "pg",
        schema: "public",
        table: "orders",
      }),
    );
  });

  it("copies the relation's name", () => {
    find(tableMenu(ctx()), "copyName").onSelect();
    expect(copyToClipboard).toHaveBeenCalledWith("orders");
  });
});
