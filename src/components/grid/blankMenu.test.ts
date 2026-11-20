import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { ClipboardPaste } from "lucide-react";
import { arrangeMenu, type MenuAction, type MenuSpec } from "@/lib/menu/menuSpec";
import { blankMenu, blankMenuOffers, type BlankMenuContext } from "./blankMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

const ctx = (over: Partial<BlankMenuContext> = {}): BlankMenuContext => ({
  t,
  tableName: "orders",
  ...over,
});

const pasteJson = {
  id: "pasteJson",
  label: "Paste rows as JSON",
  icon: ClipboardPaste,
  onSelect: vi.fn(),
};

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

const action = (spec: MenuSpec, id: string) =>
  arrangeMenu(spec)
    .sections.flatMap((s) => s.entries)
    .find((e) => e.id === id) as MenuAction | undefined;

describe("blankMenu", () => {
  it("is headed by the table, reload first and the ways to add a row after", () => {
    const spec = blankMenu(
      ctx({ onInsertRow: vi.fn(), insertAlternatives: [pasteJson], onReload: vi.fn() }),
    );
    expect(spec.header).toEqual({ title: "orders" });
    expect(layout(spec)).toEqual(["view:reload", "create:insertRow,alt:pasteJson"]);
  });

  it("advertises F5 on Reload", () => {
    expect(action(blankMenu(ctx({ onReload: vi.fn() })), "reload")?.shortcut).toEqual({
      action: "refreshData",
    });
  });

  it("keeps a blocked insert, locked with its reason, and drops the alternatives", () => {
    const spec = blankMenu(
      ctx({
        insertBlocked: "No primary key",
        insertAlternatives: [pasteJson],
        onReload: vi.fn(),
      }),
    );
    expect(layout(spec)).toEqual(["view:reload", "create:insertRow"]);
    expect(action(spec, "insertRow")?.locked).toBe("No primary key");
  });

  it("does not lock an insert that can begin", () => {
    expect(action(blankMenu(ctx({ onInsertRow: vi.fn() })), "insertRow")?.locked).toBeNull();
  });

  it("offers only Reload when inserting is not something the grid does", () => {
    expect(layout(blankMenu(ctx({ onReload: vi.fn() })))).toEqual(["view:reload"]);
  });
});

describe("blankMenuOffers", () => {
  it("is false for a grid with nothing to offer, such as a query result", () => {
    expect(blankMenuOffers({})).toBe(false);
  });

  it("is true for a blocked insert alone: the reason is worth a right-click", () => {
    expect(blankMenuOffers({ insertBlocked: "No primary key" })).toBe(true);
  });
});
