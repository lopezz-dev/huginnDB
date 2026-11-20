import { describe, expect, it, vi } from "vitest";

import {
  CHANGE_ALL_ACTION,
  caretClientPoint,
  isContextMenuChord,
  editorCommands,
  editorMenuState,
  placeCaretAt,
  type CommandEditor,
  type EditorPosition,
  type EditorSelection,
} from "./editorCommands";

/** A selection over [from, to) on line 1; `text` is what it covers. */
function sel(text: string, from = 1, to = from + text.length) {
  return {
    text,
    isEmpty: () => from === to,
    containsPosition: (p: EditorPosition) => p.lineNumber === 1 && p.column >= from && p.column <= to,
  };
}

function fakeEditor(over: {
  selections?: ReturnType<typeof sel>[];
  readOnly?: boolean;
  changeAll?: boolean;
  target?: EditorPosition | null;
} = {}) {
  const selections = over.selections ?? [];
  const changeAllRun = vi.fn(() => Promise.resolve());
  const editor = {
    edits: [] as { range: EditorSelection; text: string }[][],
    undoStops: 0,
    position: null as EditorPosition | null,
    selected: null as unknown,
    focused: 0,
    changeAllRun,
    getModel: () => ({
      getValueInRange: (r: EditorSelection) => (r as ReturnType<typeof sel>).text,
      getEOL: () => "\n",
      getFullModelRange: () => "FULL",
    }),
    getSelection: () => selections[0] ?? null,
    getSelections: () => selections,
    setSelection: (r: unknown) => {
      editor.selected = r;
    },
    setPosition: (p: EditorPosition) => {
      editor.position = p;
    },
    executeEdits: (_src: string, edits: { range: EditorSelection; text: string }[]) => {
      editor.edits.push(edits);
      return true;
    },
    pushUndoStop: () => {
      editor.undoStops++;
      return true;
    },
    focus: () => {
      editor.focused++;
    },
    getTargetAtClientPoint: () =>
      over.target === undefined ? null : { position: over.target },
    getAction: (id: string) =>
      id === CHANGE_ALL_ACTION && over.changeAll !== false
        ? { isSupported: () => true, run: changeAllRun }
        : null,
    getRawOptions: () => ({ readOnly: over.readOnly }),
  };
  return editor;
}

const asEditor = (e: ReturnType<typeof fakeEditor>) => e as unknown as CommandEditor;

function clipboard(content: string | null = null) {
  return { write: vi.fn(() => Promise.resolve()), read: vi.fn(() => Promise.resolve(content)) };
}

describe("editorMenuState", () => {
  it("reads the selection, the read-only option and Change all's support", () => {
    expect(editorMenuState(asEditor(fakeEditor({ selections: [sel("ab")] })))).toEqual({
      hasSelection: true,
      readOnly: false,
      canChangeAll: true,
    });
    expect(
      editorMenuState(asEditor(fakeEditor({ selections: [sel("", 3)], readOnly: true }))),
    ).toEqual({ hasSelection: false, readOnly: true, canChangeAll: false });
    expect(editorMenuState(asEditor(fakeEditor({ changeAll: false }))).canChangeAll).toBe(false);
  });
});

describe("editorCommands", () => {
  it("Copy writes every selected range through the clipboard seam, one per line", async () => {
    const ed = fakeEditor({ selections: [sel("a"), sel("", 4), sel("bc", 6)] });
    const cb = clipboard();
    await editorCommands(asEditor(ed), cb).copy();
    expect(cb.write).toHaveBeenCalledWith("a\nbc");
    expect(ed.edits).toEqual([]);
  });

  it("Copy with nothing selected writes nothing", async () => {
    const cb = clipboard();
    await editorCommands(asEditor(fakeEditor({ selections: [sel("", 2)] })), cb).copy();
    expect(cb.write).not.toHaveBeenCalled();
  });

  it("Cut writes, then removes exactly what it copied, as one undo step", async () => {
    const a = sel("SELECT");
    const ed = fakeEditor({ selections: [a] });
    const cb = clipboard();
    await editorCommands(asEditor(ed), cb).cut();
    expect(cb.write).toHaveBeenCalledWith("SELECT");
    expect(ed.edits).toHaveLength(1);
    expect(ed.edits[0]).toEqual([expect.objectContaining({ range: a, text: "" })]);
    expect(ed.undoStops).toBe(2);
  });

  it("Paste reads the clipboard (in Rust, via the seam) and replaces each selection", async () => {
    const a = sel("x");
    const b = sel("", 5);
    const ed = fakeEditor({ selections: [a, b] });
    const cb = clipboard("now()");
    await editorCommands(asEditor(ed), cb).paste();
    expect(cb.read).toHaveBeenCalledOnce();
    expect(ed.edits[0]).toEqual([
      expect.objectContaining({ range: a, text: "now()" }),
      expect.objectContaining({ range: b, text: "now()" }),
    ]);
  });

  it("Paste of an empty or unreadable clipboard does nothing", async () => {
    const ed = fakeEditor({ selections: [sel("", 1)] });
    await editorCommands(asEditor(ed), clipboard(null)).paste();
    await editorCommands(asEditor(ed), clipboard("")).paste();
    expect(ed.edits).toEqual([]);
  });

  it("Select all selects the model's full range; Change all runs Monaco's action", () => {
    const ed = fakeEditor();
    const cmds = editorCommands(asEditor(ed), clipboard());
    cmds.selectAll();
    expect(ed.selected).toBe("FULL");
    cmds.changeAll();
    expect(ed.changeAllRun).toHaveBeenCalledOnce();
  });
});

describe("placeCaretAt", () => {
  it("moves the caret to a right-click outside the selection", () => {
    const ed = fakeEditor({ selections: [sel("abc", 1)], target: { lineNumber: 1, column: 9 } });
    placeCaretAt(asEditor(ed), 10, 10);
    expect(ed.position).toEqual({ lineNumber: 1, column: 9 });
  });

  it("keeps the selection when the right-click is inside it", () => {
    const ed = fakeEditor({ selections: [sel("abc", 1)], target: { lineNumber: 1, column: 2 } });
    placeCaretAt(asEditor(ed), 10, 10);
    expect(ed.position).toBeNull();
  });

  it("does nothing off the text (a margin, the scrollbar)", () => {
    const ed = fakeEditor({ target: null });
    placeCaretAt(asEditor(ed), 10, 10);
    expect(ed.position).toBeNull();
  });
});

describe("keyboard opening", () => {
  it("Shift+F10 is the chord; F10 alone or with another modifier is not", () => {
    const k = (init: Partial<KeyboardEvent>) =>
      ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;
    expect(isContextMenuChord(k({ key: "F10", shiftKey: true }))).toBe(true);
    expect(isContextMenuChord(k({ key: "F10" }))).toBe(false);
    expect(isContextMenuChord(k({ key: "F10", shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it("the caret's point is on its own line, not the next one", () => {
    const editor = {
      getPosition: () => ({ lineNumber: 2, column: 6 }),
      getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50 }) }),
      getScrolledVisiblePosition: () => ({ left: 40, top: 19, height: 19 }),
    } as unknown as CommandEditor;
    expect(caretClientPoint(editor)).toEqual({ x: 140, y: 87 });
  });

  it("no point when the caret is scrolled out of view", () => {
    const editor = {
      getPosition: () => ({ lineNumber: 200, column: 1 }),
      getDomNode: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      getScrolledVisiblePosition: () => null,
    } as unknown as CommandEditor;
    expect(caretClientPoint(editor)).toBeNull();
  });
});
