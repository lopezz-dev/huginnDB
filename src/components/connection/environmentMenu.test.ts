import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { arrangeMenu, type MenuSpec } from "@/lib/menu/menuSpec";
import {
  environmentMenu,
  type EnvironmentMenuContext,
} from "./environmentMenu";

const t = ((key: string) => key) as unknown as TFunction;

function ctx(
  over: Partial<EnvironmentMenuContext> = {},
): EnvironmentMenuContext {
  return {
    t,
    label: "Personal",
    canDelete: true,
    onRename: vi.fn(),
    onOpenInNewWindow: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map(
    (s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`,
  );

describe("environmentMenu", () => {
  it("names the environment in the header", () => {
    expect(environmentMenu(ctx()).header).toEqual({ title: "Personal" });
  });

  it("lays out rename, open in a new window and a red delete", () => {
    const spec = environmentMenu(ctx());
    expect(layout(spec)).toEqual([
      "edit:rename",
      "session:openInNewWindow",
      "danger:delete",
    ]);
    const danger = arrangeMenu(spec).sections.find((s) => s.id === "danger")!;
    expect(danger.destructive).toBe(true);
    expect(danger.showLabel).toBe(false);
  });

  it("leaves delete out when the environment cannot be deleted", () => {
    expect(layout(environmentMenu(ctx({ canDelete: false })))).toEqual([
      "edit:rename",
      "session:openInNewWindow",
    ]);
  });

  it("wires each item to its callback", () => {
    const c = ctx();
    const entries = arrangeMenu(environmentMenu(c)).sections.flatMap(
      (s) => s.entries,
    );
    for (const e of entries)
      if (e.kind !== "custom" && e.kind !== "submenu") e.onSelect();
    expect(c.onRename).toHaveBeenCalledTimes(1);
    expect(c.onOpenInNewWindow).toHaveBeenCalledTimes(1);
    expect(c.onDelete).toHaveBeenCalledTimes(1);
  });
});
