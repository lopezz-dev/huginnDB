import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { Pin, PinOff } from "lucide-react";
import {
  arrangeMenu,
  type MenuAction,
  type MenuSpec,
} from "@/lib/menu/menuSpec";
import { tabMenu, type TabMenuContext } from "./tabMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

function ctx(over: Partial<TabMenuContext> = {}): TabMenuContext {
  return {
    t,
    title: "public.orders",
    connection: "Analytics PG",
    isActive: true,
    isPinned: false,
    hasOthers: true,
    hasOthersInConnection: true,
    renderColor: () => null,
    actions: {
      togglePin: vi.fn(),
      splitRight: vi.fn(),
      splitDown: vi.fn(),
      float: vi.fn(),
      close: vi.fn(),
      closeOthers: vi.fn(),
      closeToRight: vi.fn(),
      closeOthersInConnection: vi.fn(),
      closeAll: vi.fn(),
    },
    ...over,
  };
}

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map(
    (s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`,
  );

const action = (spec: MenuSpec, id: string) =>
  arrangeMenu(spec)
    .sections.flatMap((s) => s.entries)
    .find((e) => e.id === id) as MenuAction;

describe("tabMenu", () => {
  it("puts the colour row in Edit and every other action, closing included, in Session", () => {
    const arranged = arrangeMenu(tabMenu(ctx()));
    expect(layout(tabMenu(ctx()))).toEqual([
      "edit:color",
      "session:pin,splitRight,splitDown,float,close,closeOthers,closeToRight,closeOthersInConnection,closeAll",
    ]);
    // Closing destroys nothing: nothing in this menu is red.
    expect(arranged.sections.some((s) => s.destructive)).toBe(false);
    // Two sections, so both get their heading — the one the colour row used
    // to draw by hand.
    expect(arranged.sections.every((s) => s.showLabel)).toBe(true);
  });

  it("names the tab in the header, with its connection as the tag", () => {
    expect(tabMenu(ctx()).header).toEqual({
      title: "public.orders",
      tags: ["Analytics PG"],
    });
  });

  it("draws no tag while the tab has no connection name", () => {
    // `ContextMenuHeader` skips a null tag, so no empty chip.
    expect(tabMenu(ctx({ connection: null })).header.tags).toEqual([null]);
  });

  it("gives every action an icon", () => {
    const actions = arrangeMenu(tabMenu(ctx()))
      .sections.flatMap((s) => s.entries)
      .filter((e) => e.kind !== "custom") as MenuAction[];
    expect(
      actions.every(
        (e) => typeof e.icon === "object" || typeof e.icon === "function",
      ),
    ).toBe(true);
  });

  it("offers Pin on an unpinned tab and Unpin on a pinned one", () => {
    expect(action(tabMenu(ctx()), "pin")).toMatchObject({
      label: "tabs.pin",
      icon: Pin,
    });
    expect(action(tabMenu(ctx({ isPinned: true })), "pin")).toMatchObject({
      label: "tabs.unpin",
      icon: PinOff,
    });
  });

  it("advertises the pin and close keys only on the active tab, and close-all always", () => {
    const active = tabMenu(ctx({ isActive: true }));
    expect(action(active, "pin").shortcut).toEqual({ action: "togglePinTab" });
    expect(action(active, "close").shortcut).toEqual({ action: "closeTab" });
    expect(action(active, "closeAll").shortcut).toEqual({
      action: "closeAllTabs",
    });

    // Those keys act on the active tab (`App.tsx`), not on this one.
    const inactive = tabMenu(ctx({ isActive: false }));
    expect(action(inactive, "pin").shortcut).toBeUndefined();
    expect(action(inactive, "close").shortcut).toBeUndefined();
    expect(action(inactive, "closeAll").shortcut).toEqual({
      action: "closeAllTabs",
    });
  });

  it("disables closing the others when this is the only tab", () => {
    const spec = tabMenu(
      ctx({ hasOthers: false, hasOthersInConnection: false }),
    );
    expect(action(spec, "closeOthers").disabled).toBe(true);
    expect(action(spec, "closeToRight").disabled).toBe(true);
    expect(action(spec, "closeOthersInConnection").disabled).toBe(true);
    expect(action(spec, "close").disabled).toBeFalsy();
    expect(action(spec, "closeAll").disabled).toBeFalsy();
  });

  it("disables only the same-connection close when the others are on other connections", () => {
    const spec = tabMenu(
      ctx({ hasOthers: true, hasOthersInConnection: false }),
    );
    expect(action(spec, "closeOthers").disabled).toBe(false);
    expect(action(spec, "closeToRight").disabled).toBe(false);
    expect(action(spec, "closeOthersInConnection").disabled).toBe(true);
  });

  it("wires each item to its own action", () => {
    const c = ctx();
    const spec = tabMenu(c);
    for (const id of [
      "splitRight",
      "splitDown",
      "float",
      "close",
      "closeOthers",
      "closeToRight",
      "closeOthersInConnection",
      "closeAll",
    ] as const) {
      action(spec, id).onSelect();
      expect(c.actions[id]).toHaveBeenCalledTimes(1);
    }
    action(spec, "pin").onSelect();
    expect(c.actions.togglePin).toHaveBeenCalledTimes(1);
  });
});
