import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

import { arrangeMenu, type MenuAction, type MenuSpec } from "@/lib/menu/menuSpec";
import type { EditorCommands, EditorMenuState } from "@/lib/monaco/editorCommands";
import { editorMenu, type EditorMenuInput } from "./editorMenu";

// Keys stand in for the words: the layout is what is under test.
const t = ((key: string) => key) as unknown as TFunction;

const commands = (): EditorCommands => ({
  cut: vi.fn(() => Promise.resolve()),
  copy: vi.fn(() => Promise.resolve()),
  paste: vi.fn(() => Promise.resolve()),
  selectAll: vi.fn(),
  changeAll: vi.fn(),
});

const writable: EditorMenuState = { hasSelection: true, readOnly: false, canChangeAll: true };

function input(over: Partial<EditorMenuInput> = {}): EditorMenuInput {
  return {
    t,
    header: { title: "Query 1", tags: ["PostgreSQL"] },
    state: writable,
    commands: commands(),
    ...over,
  };
}

/** `section:id,id` per section, in display order. */
const layout = (spec: MenuSpec) =>
  arrangeMenu(spec).sections.map((s) => `${s.id}:${s.entries.map((e) => e.id).join(",")}`);

const entry = (spec: MenuSpec, id: string) =>
  arrangeMenu(spec)
    .sections.flatMap((s) => s.entries)
    .find((e) => e.id === id) as MenuAction | undefined;

describe("editorMenu", () => {
  it("the query editor's full menu: palette, clipboard, AI, then edits — and no Run", () => {
    const spec = editorMenu(
      input({
        format: { run: vi.fn(), shortcut: { action: "formatQuery" } },
        ai: { explainQuery: vi.fn(), explainSlow: vi.fn() },
        commandPalette: vi.fn(),
      }),
    );
    expect(layout(spec)).toEqual([
      "navigate:commandPalette",
      "copy:cut,copy,paste",
      "view:explainQuery,explainSlow",
      "edit:changeAll,format",
    ]);
    expect(spec.header).toEqual({ title: "Query 1", tags: ["PostgreSQL"] });
  });

  it("with nothing turned on it is the clipboard and Change all", () => {
    expect(layout(editorMenu(input()))).toEqual(["copy:cut,copy,paste", "edit:changeAll"]);
  });

  it("Cut and Copy are disabled without a selection; Paste never is", () => {
    const spec = editorMenu(input({ state: { ...writable, hasSelection: false } }));
    expect(entry(spec, "cut")?.disabled).toBe(true);
    expect(entry(spec, "copy")?.disabled).toBe(true);
    expect(entry(spec, "paste")?.disabled).toBeFalsy();
  });

  it("the AI entries exist only when the call site hands them over", () => {
    expect(entry(editorMenu(input()), "explainQuery")).toBeUndefined();
    const ai = { explainQuery: vi.fn(), explainSlow: vi.fn() };
    const spec = editorMenu(input({ ai }));
    entry(spec, "explainQuery")!.onSelect();
    entry(spec, "explainSlow")!.onSelect();
    expect(ai.explainQuery).toHaveBeenCalledOnce();
    expect(ai.explainSlow).toHaveBeenCalledOnce();
    expect(entry(spec, "explainQuery")!.label).toBe("ai.task.explainQuery");
  });

  it("Change all is offered only where Monaco supports it", () => {
    const spec = editorMenu(input({ state: { ...writable, canChangeAll: false } }));
    expect(entry(spec, "changeAll")).toBeUndefined();
  });

  it("a read-only editor gets Copy and Select all, and nothing that writes", () => {
    const spec = editorMenu(
      input({
        state: { hasSelection: false, readOnly: true, canChangeAll: false },
        format: { run: vi.fn() },
      }),
    );
    expect(layout(spec)).toEqual(["copy:copy,selectAll"]);
    expect(entry(spec, "copy")?.disabled).toBe(true);
  });

  it("each entry runs its command", () => {
    const cmds = commands();
    const format = vi.fn();
    const palette = vi.fn();
    const spec = editorMenu(
      input({ commands: cmds, format: { run: format }, commandPalette: palette }),
    );
    for (const id of ["cut", "copy", "paste", "changeAll", "format", "commandPalette"]) {
      entry(spec, id)!.onSelect();
    }
    expect(cmds.cut).toHaveBeenCalledOnce();
    expect(cmds.copy).toHaveBeenCalledOnce();
    expect(cmds.paste).toHaveBeenCalledOnce();
    expect(cmds.changeAll).toHaveBeenCalledOnce();
    expect(format).toHaveBeenCalledOnce();
    expect(palette).toHaveBeenCalledOnce();
  });

  it("shortcuts: Monaco's own keys as fixed keys, catalogue actions by id, Format's only if given", () => {
    const spec = editorMenu(input({ format: { run: vi.fn() }, commandPalette: vi.fn() }));
    expect(entry(spec, "cut")?.shortcut).toEqual({ fixed: "editorCut" });
    expect(entry(spec, "copy")?.shortcut).toEqual({ fixed: "editorCopy" });
    expect(entry(spec, "paste")?.shortcut).toEqual({ fixed: "editorPaste" });
    expect(entry(spec, "changeAll")?.shortcut).toEqual({ fixed: "editorChangeAll" });
    expect(entry(spec, "commandPalette")?.shortcut).toEqual({ action: "toggleCommandPalette" });
    // A cell editor's formatter has no key of its own: the menu says none.
    expect(entry(spec, "format")?.shortcut).toBeUndefined();
  });

  it("every action has an icon", () => {
    const spec = editorMenu(
      input({
        format: { run: vi.fn() },
        ai: { explainQuery: vi.fn(), explainSlow: vi.fn() },
        commandPalette: vi.fn(),
      }),
    );
    for (const e of arrangeMenu(spec).sections.flatMap((s) => s.entries)) {
      expect((e as MenuAction).icon, e.id).toBeTruthy();
    }
  });
});

/**
 * The menu each of the other editors gets, as its call site configures it:
 * none of them hands over the AI or the palette, and Format only where the
 * editor already had a formatter.
 */
describe("editorMenu in the other editors", () => {
  const header = { title: "email" };

  it("with a formatter (cell, view, pipeline and stage, JSON Schema): clipboard, Change all, Format without a key", () => {
    const spec = editorMenu(input({ header, format: { run: vi.fn() } }));
    expect(layout(spec)).toEqual(["copy:cut,copy,paste", "edit:changeAll,format"]);
    expect(entry(spec, "format")?.shortcut).toBeUndefined();
    expect(spec.header).toEqual(header);
  });

  it("without one (insert rows, insert document, policy JSON, a plain-text cell): no Format", () => {
    expect(layout(editorMenu(input({ header })))).toEqual([
      "copy:cut,copy,paste",
      "edit:changeAll",
    ]);
  });

  it("read-only (DDL preview, CREATE statement, Console entry, a read-only cell or policy)", () => {
    const readOnly = { hasSelection: true, readOnly: true, canChangeAll: false };
    const spec = editorMenu(input({ header, state: readOnly, format: { run: vi.fn() } }));
    expect(layout(spec)).toEqual(["copy:copy,selectAll"]);
    expect(entry(spec, "copy")?.disabled).toBe(false);
  });
});
