/**
 * @vitest-environment jsdom
 *
 * `EditorContextMenu` against a fake editor: where the right-click puts the
 * caret, that the keyboard opens the same menu, that a read-only editor gets
 * the read-only menu, and that nothing opens before the editor has mounted.
 * What the menu *contains* for each editor is `editorMenu.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/lib/i18n";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve()),
  readFromClipboard: vi.fn(() => Promise.resolve("pasted")),
}));

import { EditorContextMenu } from "./EditorContextMenu";
import type { CommandEditor, EditorPosition } from "@/lib/monaco/editorCommands";

afterEach(cleanup);

interface Fake {
  editor: CommandEditor;
  setPosition: ReturnType<typeof vi.fn>;
  /** Press a key inside the editor, as Monaco reports it. */
  keyDown: (init: KeyboardEventInit) => void;
}

function fakeEditor({ readOnly = false, selected = false } = {}): Fake {
  let onKey: ((e: { browserEvent: KeyboardEvent }) => void) | null = null;
  const selection = {
    isEmpty: () => !selected,
    containsPosition: () => false,
  };
  const setPosition = vi.fn();
  const editor: CommandEditor = {
    getModel: () => ({
      getValueInRange: () => "SELECT 1",
      getEOL: () => "\n",
      getFullModelRange: () => ({}),
    }),
    getSelection: () => selection,
    getSelections: () => [selection],
    setSelection: () => {},
    setPosition,
    executeEdits: () => true,
    pushUndoStop: () => true,
    focus: () => {},
    getTargetAtClientPoint: (x: number, y: number) => ({
      position: { lineNumber: y, column: x } satisfies EditorPosition,
    }),
    getAction: () => ({ isSupported: () => true, run: () => Promise.resolve() }),
    getRawOptions: () => ({ readOnly }),
    getPosition: () => ({ lineNumber: 3, column: 7 }),
    getScrolledVisiblePosition: () => ({ top: 40, left: 70, height: 18 }),
    getDomNode: () => document.body,
    onKeyDown: (fn) => {
      onKey = fn;
      return { dispose: () => (onKey = null) };
    },
  };
  return {
    editor,
    setPosition,
    keyDown: (init) => {
      const browserEvent = new KeyboardEvent("keydown", { cancelable: true, ...init });
      act(() => onKey?.({ browserEvent }));
    },
  };
}

function renderMenu(editor: CommandEditor | null, format?: () => void) {
  render(
    <EditorContextMenu
      editor={editor}
      header={{ title: "email" }}
      width="sm"
      format={format && { run: format }}
    >
      <div aria-label="editor" />
    </EditorContextMenu>,
  );
}

const items = () => screen.queryAllByRole("menuitem").map((el) => el.textContent ?? "");

describe("EditorContextMenu", () => {
  it("a right-click moves the caret to the click, then opens HuginnDB's menu", () => {
    const fake = fakeEditor();
    renderMenu(fake.editor, vi.fn());
    fireEvent.contextMenu(screen.getByLabelText("editor"), { clientX: 12, clientY: 5 });
    expect(fake.setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 12 });
    expect(screen.getByRole("menu").textContent).toContain("email");
    expect(items().some((x) => x.includes("Paste"))).toBe(true);
    expect(items().some((x) => x.includes("Format"))).toBe(true);
  });

  it("Shift+F10 in the editor opens the same menu at the caret", () => {
    const fake = fakeEditor();
    renderMenu(fake.editor);
    expect(screen.queryByRole("menu")).toBeNull();
    fake.keyDown({ key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).toBeTruthy();
    // The caret's own position on screen, so the aiming step lands on it.
    expect(fake.setPosition).toHaveBeenCalledWith({ lineNumber: 40 + 18 - 1, column: 70 });
  });

  it("F10 without Shift is not the menu key", () => {
    const fake = fakeEditor();
    renderMenu(fake.editor);
    fake.keyDown({ key: "F10" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a read-only editor gets Copy and Select all, whatever the call site offers", () => {
    const fake = fakeEditor({ readOnly: true, selected: true });
    renderMenu(fake.editor, vi.fn());
    fireEvent.contextMenu(screen.getByLabelText("editor"));
    const labels = items();
    expect(labels.some((x) => x.includes("Copy"))).toBe(true);
    expect(labels.some((x) => x.includes("Select all"))).toBe(true);
    expect(labels.some((x) => /Cut|Paste|Format|Change all/.test(x))).toBe(false);
  });

  it("before the editor has mounted, a right-click opens nothing", () => {
    renderMenu(null);
    fireEvent.contextMenu(screen.getByLabelText("editor"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
