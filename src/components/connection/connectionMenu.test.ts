import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { arrangeMenu, type MenuSpec } from "@/lib/menu/menuSpec";
import { connectionMenu, type ConnectionMenuContext } from "./connectionMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

function ctx(over: Partial<ConnectionMenuContext> = {}): ConnectionMenuContext {
  return {
    t,
    name: "Producción MySQL",
    driver: "mysql",
    isActive: true,
    isMultiDb: true,
    hasDatabases: true,
    isSelected: false,
    lock: () => null,
    actions: {
      refresh: vi.fn(),
      createDatabase: vi.fn(),
      chooseDatabases: vi.fn(),
      scopeSearchHere: vi.fn(),
      exportDatabase: vi.fn(),
      importSql: vi.fn(),
      openSecurity: vi.fn(),
      editConnection: vi.fn(),
      openInNewWindow: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
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

describe("connectionMenu", () => {
  it("lays out a connected server-wide MySQL connection", () => {
    expect(layout(connectionMenu(ctx()))).toEqual([
      "navigate:security",
      "view:refresh",
      "filter:chooseDatabases,scopeHere",
      "create:createDatabase",
      "edit:editConnection",
      "transfer:exportDatabase,importSql",
      "session:openInNewWindow,disconnect",
    ]);
  });

  it("names the profile and its engine", () => {
    expect(connectionMenu(ctx()).header).toEqual({
      title: "Producción MySQL",
      tags: ["MySQL"],
    });
  });

  it("keeps Edit before Session when disconnected, as when connected", () => {
    expect(layout(connectionMenu(ctx({ isActive: false })))).toEqual([
      "edit:editConnection",
      "session:connect,openInNewWindow",
    ]);
  });

  it("offers no database chooser on a single-database connection", () => {
    const spec = connectionMenu(ctx({ driver: "postgres", isMultiDb: false }));
    expect(layout(spec)).toContain("filter:scopeHere");
  });

  it("disables the database chooser until the list has loaded", () => {
    expect(find(connectionMenu(ctx({ hasDatabases: false })), "chooseDatabases").disabled).toBe(
      true,
    );
  });

  it("creates no database on SQLite, but dumps its file as .sql", () => {
    const spec = connectionMenu(ctx({ driver: "sqlite", isMultiDb: false }));
    expect(layout(spec)).toEqual([
      "navigate:security",
      "view:refresh",
      "filter:scopeHere",
      "edit:editConnection",
      "transfer:exportDatabase,importSql",
      "session:openInNewWindow,disconnect",
    ]);
  });

  it("creates a database but dumps no .sql on MongoDB", () => {
    const sections = layout(connectionMenu(ctx({ driver: "mongodb" })));
    expect(sections).toContain("create:createDatabase");
    expect(sections.some((s) => s.startsWith("transfer"))).toBe(false);
  });

  it("dumps .sql on SQL Server", () => {
    expect(layout(connectionMenu(ctx({ driver: "sqlserver" })))).toContain(
      "transfer:exportDatabase,importSql",
    );
  });

  it("drops Connect and Disconnect when the row offers neither", () => {
    const actions = { ...ctx().actions, connect: undefined, disconnect: undefined };
    expect(layout(connectionMenu(ctx({ isActive: false, actions })))).toEqual([
      "edit:editConnection",
      "session:openInNewWindow",
    ]);
    expect(layout(connectionMenu(ctx({ actions })))).toContain("session:openInNewWindow");
  });

  it("carries the policy's reason on each guarded action", () => {
    const lock = (need: string) => `no ${need}`;
    const on = connectionMenu(ctx({ lock }));
    expect(find(on, "createDatabase").locked).toBe("no ddl");
    expect(find(on, "exportDatabase").locked).toBe("no export");
    expect(find(on, "importSql").locked).toBe("no freeSql");
    expect(find(on, "security").locked).toBe("no monitor");
    expect(find(connectionMenu(ctx({ lock, isActive: false })), "connect").locked).toBe(
      "no connect",
    );
  });

  it("advertises Refresh and Search only here only on the selected connection", () => {
    const other = connectionMenu(ctx());
    expect(find(other, "refresh").shortcut).toBeUndefined();
    expect(find(other, "scopeHere").shortcut).toBeUndefined();
    const selected = connectionMenu(ctx({ isSelected: true }));
    expect(find(selected, "refresh").shortcut).toEqual({ action: "refreshSchema" });
    expect(find(selected, "scopeHere").shortcut).toEqual({
      action: "scopeFilterToConnection",
    });
  });
});
