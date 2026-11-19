import { describe, expect, it } from "vitest";
import { Copy } from "lucide-react";
import { arrangeMenu, MENU_SECTIONS, type MenuEntry, type MenuSectionId } from "./menuSpec";

const noop = () => {};
const action = (id: string, section: MenuSectionId): MenuEntry => ({
  id,
  section,
  icon: Copy,
  label: id,
  onSelect: noop,
});

const ids = (m: ReturnType<typeof arrangeMenu>) =>
  m.sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

describe("arrangeMenu", () => {
  it("orders sections by the vocabulary, whatever order the call site wrote", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: [
        action("del", "danger"),
        action("ins", "create"),
        action("copy", "copy"),
        action("nav", "navigate"),
      ],
    });
    expect(ids(m)).toEqual(["navigate:nav", "copy:copy", "create:ins", "danger:del"]);
  });

  it("keeps the call site's order within a section", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: [action("b", "copy"), action("a", "copy"), action("c", "copy")],
    });
    expect(ids(m)).toEqual(["copy:b,a,c"]);
  });

  it("skips falsy entries and empty submenus", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: [
        false,
        null,
        undefined,
        { id: "sub", section: "copy", kind: "submenu", icon: Copy, label: "s", items: [] },
        action("a", "view"),
      ],
    });
    expect(ids(m)).toEqual(["view:a"]);
  });

  it("labels sections only when there is more than one to tell apart", () => {
    const one = arrangeMenu({ header: { title: "t" }, entries: [action("a", "copy")] });
    expect(one.sections[0].showLabel).toBe(false);

    const two = arrangeMenu({
      header: { title: "t" },
      entries: [action("a", "copy"), action("b", "view")],
    });
    expect(two.sections.map((s) => s.showLabel)).toEqual([true, true]);
  });

  it("never labels danger, which a separator sets off instead", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: [action("a", "copy"), action("b", "edit"), action("d", "danger")],
    });
    const danger = m.sections.at(-1)!;
    expect(danger.showLabel).toBe(false);
    expect(danger.separatorBefore).toBe(true);
    // A labelled section needs no separator: its heading divides.
    expect(m.sections[1].separatorBefore).toBe(false);
  });

  it("does not count danger when deciding whether to label", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: [action("a", "view"), action("d", "danger")],
    });
    expect(m.sections.map((s) => [s.id, s.showLabel, s.separatorBefore])).toEqual([
      ["view", false, false],
      ["danger", false, true],
    ]);
  });

  it("makes exactly the danger section destructive", () => {
    const m = arrangeMenu({
      header: { title: "t" },
      entries: MENU_SECTIONS.map((s) => action(s, s)),
    });
    expect(m.sections.filter((s) => s.destructive).map((s) => s.id)).toEqual(["danger"]);
  });

  it("passes the header through", () => {
    const header = { title: "col", tags: ["int4", false] as const };
    expect(arrangeMenu({ header, entries: [] }).header).toBe(header);
  });
});
