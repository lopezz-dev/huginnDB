import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { arrangeMenu, type MenuSpec } from "@/lib/menu/menuSpec";
import {
  databaseMenu,
  schemaMenu,
  type DatabaseMenuContext,
  type SchemaMenuContext,
} from "./databaseMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

const create = () => ({ newTable: vi.fn(), newView: vi.fn(), newQuery: vi.fn() });

function dbCtx(over: Partial<DatabaseMenuContext> = {}): DatabaseMenuContext {
  return {
    t,
    dbName: "shop",
    driver: "mysql",
    canDrop: true,
    lock: () => null,
    actions: {
      ...create(),
      openSecurity: vi.fn(),
      refresh: vi.fn(),
      scopeSearchHere: vi.fn(),
      newCollection: vi.fn(),
      exportDatabase: vi.fn(),
      importSql: vi.fn(),
      drop: vi.fn(),
    },
    ...over,
  };
}

function schemaCtx(over: Partial<SchemaMenuContext> = {}): SchemaMenuContext {
  return {
    t,
    schema: "public",
    driver: "postgres",
    lock: () => null,
    actions: { ...create(), refresh: vi.fn() },
    ...over,
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

describe("databaseMenu", () => {
  it("lays out a MySQL database in a server-wide tree", () => {
    expect(layout(databaseMenu(dbCtx()))).toEqual([
      "navigate:security",
      "view:refresh",
      "filter:scopeHere",
      "create:newTable,newView,newQuery",
      "transfer:exportDatabase,importSql",
      "danger:dropDatabase",
    ]);
  });

  it("names the database and its engine", () => {
    expect(databaseMenu(dbCtx()).header).toEqual({ title: "shop", tags: ["MySQL"] });
  });

  it("puts Drop database in danger, so it is the one red item", () => {
    const sections = arrangeMenu(databaseMenu(dbCtx())).sections;
    expect(sections.filter((s) => s.destructive).map((s) => s.id)).toEqual(["danger"]);
  });

  it("offers collections, not tables or .sql, on MongoDB", () => {
    expect(layout(databaseMenu(dbCtx({ driver: "mongodb" })))).toEqual([
      "navigate:security",
      "view:refresh",
      "filter:scopeHere",
      "create:newQuery,newCollection",
      "danger:dropDatabase",
    ]);
  });

  it("drops nothing on SQLite, and has no search scope in a single-database tree", () => {
    const actions = { ...dbCtx().actions, scopeSearchHere: undefined };
    expect(layout(databaseMenu(dbCtx({ driver: "sqlite", canDrop: false, actions })))).toEqual([
      "navigate:security",
      "view:refresh",
      "create:newTable,newView,newQuery",
      "transfer:exportDatabase,importSql",
    ]);
  });

  it("dumps .sql on SQL Server", () => {
    expect(layout(databaseMenu(dbCtx({ driver: "sqlserver" })))).toContain(
      "transfer:exportDatabase,importSql",
    );
  });

  it("carries the policy's reason on each guarded action", () => {
    const lock = (need: string) => (need === "ddl" ? null : `no ${need}`);
    const spec = databaseMenu(dbCtx({ lock }));
    expect(find(spec, "security").locked).toBe("no monitor");
    expect(find(spec, "newTable").locked).toBeNull();
    // A view's body is free SQL: refused under freeSql even when DDL is allowed.
    expect(find(spec, "newView").locked).toBe("no freeSql");
    expect(find(spec, "newQuery").locked).toBe("no freeSql");
    expect(find(spec, "exportDatabase").locked).toBe("no export");
    const ddl = databaseMenu(dbCtx({ lock: (n) => `no ${n}` }));
    expect(find(ddl, "dropDatabase").locked).toBe("no ddl");
  });

  it("advertises no key: the catalogue's act on the selected connection", () => {
    const spec = databaseMenu(dbCtx());
    for (const e of spec.entries) {
      if (e && e.kind !== "custom" && e.kind !== "submenu") expect(e.shortcut).toBeUndefined();
    }
  });
});

describe("schemaMenu", () => {
  it("lays out a Postgres schema", () => {
    expect(layout(schemaMenu(schemaCtx()))).toEqual([
      "view:refresh",
      "create:newTable,newView,newQuery",
    ]);
    expect(schemaMenu(schemaCtx()).header).toEqual({ title: "public" });
  });

  it("guards what it creates exactly as the database menu does", () => {
    const lock = (need: string) => `no ${need}`;
    const schema = schemaMenu(schemaCtx({ lock }));
    const db = databaseMenu(dbCtx({ lock, driver: "postgres" }));
    for (const id of ["newTable", "newView", "newQuery"]) {
      expect(find(schema, id).locked).toBe(find(db, id).locked);
    }
  });
});
