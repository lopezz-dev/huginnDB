import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { arrangeMenu, type MenuAction, type MenuSpec } from "@/lib/menu/menuSpec";
import type { DocField } from "@/lib/grid/documentTree";
import { fieldMenu, type FieldMenuContext } from "./fieldMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

function ctx(over: Partial<FieldMenuContext> = {}): FieldMenuContext {
  return {
    t,
    language: "en",
    sortable: true,
    sortDesc: null,
    filterable: true,
    actions: { copyValue: vi.fn(), sortBy: vi.fn(), unsort: vi.fn(), filterBy: vi.fn() },
    ...over,
  };
}

const field = (over: Partial<DocField> = {}): DocField => ({
  path: ["profile", "email"],
  key: "email",
  value: "ana@example.com",
  type: "string",
  depth: 1,
  container: null,
  childCount: 0,
  expanded: false,
  inArray: false,
  editable: true,
  ...over,
});

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

const action = (spec: MenuSpec, id: string) =>
  arrangeMenu(spec)
    .sections.flatMap((s) => s.entries)
    .find((e) => e.id === id) as MenuAction | undefined;

describe("fieldMenu", () => {
  it("lays out a sortable, filterable field", () => {
    expect(layout(fieldMenu(ctx(), field()))).toEqual([
      "copy:copy",
      "sort:sortAsc,sortDesc",
      "filter:filterBy,filterExcluding",
    ]);
  });

  it("is headed by the field's dotted path and its type", () => {
    expect(fieldMenu(ctx(), field()).header).toEqual({
      title: "profile.email",
      tags: ["string", undefined, false],
    });
  });

  it("offers only Copy on a field that can be neither sorted nor filtered", () => {
    const spec = fieldMenu(ctx({ sortable: false, filterable: false }), field());
    expect(layout(spec)).toEqual(["copy:copy"]);
    // One section: no heading over a lone Copy.
    expect(arrangeMenu(spec).sections[0].showLabel).toBe(false);
  });

  it("disables the direction the field is already sorted in, and offers to remove it", () => {
    const asc = fieldMenu(ctx({ sortDesc: false }), field());
    expect(layout(asc)).toContain("sort:sortAsc,sortDesc,unsort");
    expect(action(asc, "sortAsc")?.disabled).toBe(true);
    expect(action(asc, "sortDesc")?.disabled).toBe(false);

    const desc = fieldMenu(ctx({ sortDesc: true }), field());
    expect(action(desc, "sortAsc")?.disabled).toBe(false);
    expect(action(desc, "sortDesc")?.disabled).toBe(true);
  });

  it("does not offer to remove a sort the field is not part of", () => {
    expect(layout(fieldMenu(ctx({ sortDesc: null }), field()))).toContain(
      "sort:sortAsc,sortDesc",
    );
  });

  it("offers View as date on a timestamp, with the date as its detail", () => {
    const spec = fieldMenu(ctx(), field({ value: 1731836482000, type: "long" }));
    expect(layout(spec)).toEqual([
      "copy:copy",
      "view:viewAsDate",
      "sort:sortAsc,sortDesc",
      "filter:filterBy,filterExcluding",
    ]);
    expect(action(spec, "viewAsDate")?.detail).toBeTruthy();
  });

  it("tags a NULL value", () => {
    expect(fieldMenu(ctx(), field({ value: null, type: "null" })).header.tags).toEqual([
      "null",
      undefined,
      "NULL",
    ]);
  });

  it("tags a trimmed field with what the page left on the server, not as NULL", () => {
    // The view passes `filterable: false` for a trimmed field (its `null` is
    // a stand-in); the menu still must not call it NULL or read it as a date.
    const trimmed = field({ value: null, type: "array", trimmed: "Array · 1.4 MB" });
    const spec = fieldMenu(ctx({ filterable: false }), trimmed);
    expect(spec.header.tags).toEqual(["array", "Array · 1.4 MB", false]);
    expect(layout(spec)).toEqual(["copy:copy", "sort:sortAsc,sortDesc"]);
  });

  it("never offers View as date on a trimmed field, whatever its stand-in", () => {
    const trimmed = field({ value: 1731836482000, trimmed: "Long" });
    expect(action(fieldMenu(ctx(), trimmed), "viewAsDate")).toBeUndefined();
  });

  it("acts on the field it was opened on", () => {
    const c = ctx();
    const f = field();
    const spec = fieldMenu(c, f);
    action(spec, "copy")?.onSelect();
    action(spec, "sortDesc")?.onSelect();
    action(spec, "filterExcluding")?.onSelect();
    expect(c.actions.copyValue).toHaveBeenCalledWith(f);
    expect(c.actions.sortBy).toHaveBeenCalledWith(f, true);
    expect(c.actions.filterBy).toHaveBeenCalledWith(f, true);
  });

  it("advertises no key on Copy: the list view does not answer Ctrl+C", () => {
    expect(action(fieldMenu(ctx(), field()), "copy")?.shortcut).toBeUndefined();
  });
});
