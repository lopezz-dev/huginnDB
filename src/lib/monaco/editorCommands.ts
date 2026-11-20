/**
 * What HuginnDB's own context menu does to a Monaco editor: cut, copy,
 * paste, select all, change all occurrences — and put the caret where the
 * right-click landed.
 *
 * Monaco's native menu did these itself, but through the webview's clipboard:
 * its Paste reads with `navigator.clipboard.readText()`, which is exactly the
 * call that makes WebView2 ask "allow this site to see your clipboard?" in a
 * desktop app (ADR #63). These go through `lib/clipboard` instead, which reads
 * and writes in Rust, and apply the text with `executeEdits` so each one is a
 * single undoable step.
 *
 * Typed structurally, like the rest of the app's Monaco call sites, so a
 * test can hand over a plain object and no heavy `monaco-editor` type is
 * imported. The menu that offers these is `components/menus/EditorContextMenu`.
 */

import { copyToClipboard, readFromClipboard } from "@/lib/clipboard";

export interface EditorPosition {
  lineNumber: number;
  column: number;
}

/** A Monaco `Selection`: a range Monaco can also edit through. */
export interface EditorSelection {
  isEmpty: () => boolean;
  containsPosition: (position: EditorPosition) => boolean;
}

/** The subset of `IStandaloneCodeEditor` the menu needs. */
export interface CommandEditor {
  getModel: () => {
    getValueInRange: (range: EditorSelection) => string;
    getEOL: () => string;
    getFullModelRange: () => unknown;
  } | null;
  getSelection: () => EditorSelection | null;
  getSelections: () => EditorSelection[] | null;
  setSelection: (range: never) => void;
  setPosition: (position: EditorPosition) => void;
  executeEdits: (
    source: string,
    edits: { range: EditorSelection; text: string; forceMoveMarkers?: boolean }[],
  ) => boolean;
  pushUndoStop: () => boolean;
  focus: () => void;
  getTargetAtClientPoint: (
    clientX: number,
    clientY: number,
  ) => { position: EditorPosition | null } | null;
  getAction: (id: string) => { isSupported: () => boolean; run: () => Promise<void> } | null;
  getRawOptions: () => { readOnly?: boolean };
  getPosition: () => EditorPosition | null;
  getScrolledVisiblePosition: (
    position: EditorPosition,
  ) => { top: number; left: number; height: number } | null;
  getDomNode: () => HTMLElement | null;
  onKeyDown: (fn: (e: { browserEvent: KeyboardEvent }) => void) => { dispose: () => void };
}

/** Monaco's own command for "Change all occurrences" (Ctrl/Cmd+F2). */
export const CHANGE_ALL_ACTION = "editor.action.changeAll";

/** The clipboard seam, injectable so a test does not need the Tauri plugin. */
export interface ClipboardBridge {
  write: (text: string) => Promise<void>;
  read: () => Promise<string | null>;
}

const SYSTEM_CLIPBOARD: ClipboardBridge = { write: copyToClipboard, read: readFromClipboard };

/** The source id Monaco records for the menu's edits. */
const EDIT_SOURCE = "huginndb.contextMenu";

/**
 * What the editor is right now, read at the moment the menu opens: the facts
 * that decide which entries it shows and which it disables.
 */
export interface EditorMenuState {
  hasSelection: boolean;
  readOnly: boolean;
  canChangeAll: boolean;
}

export function editorMenuState(editor: CommandEditor): EditorMenuState {
  const readOnly = editor.getRawOptions().readOnly === true;
  return {
    hasSelection: nonEmpty(editor).length > 0,
    readOnly,
    canChangeAll: !readOnly && editor.getAction(CHANGE_ALL_ACTION)?.isSupported() === true,
  };
}

export interface EditorCommands {
  cut: () => Promise<void>;
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  selectAll: () => void;
  changeAll: () => void;
}

export function editorCommands(
  editor: CommandEditor,
  clipboard: ClipboardBridge = SYSTEM_CLIPBOARD,
): EditorCommands {
  /** Replace each range with its text as one undo step. */
  const edit = (edits: { range: EditorSelection; text: string }[]) => {
    editor.pushUndoStop();
    editor.executeEdits(
      EDIT_SOURCE,
      edits.map((e) => ({ ...e, forceMoveMarkers: true })),
    );
    editor.pushUndoStop();
    editor.focus();
  };
  return {
    copy: async () => {
      const text = selectedText(editor);
      if (text) await clipboard.write(text);
      editor.focus();
    },
    cut: async () => {
      // The ranges are taken before the write: an await later the selection
      // could have moved, and the cut must remove what it copied.
      const ranges = nonEmpty(editor);
      const text = selectedText(editor);
      if (!text) return;
      await clipboard.write(text);
      edit(ranges.map((range) => ({ range, text: "" })));
    },
    paste: async () => {
      const text = await clipboard.read();
      if (!text) return;
      const ranges = editor.getSelections() ?? [];
      if (ranges.length === 0) return;
      edit(ranges.map((range) => ({ range, text })));
    },
    selectAll: () => {
      const model = editor.getModel();
      if (!model) return;
      editor.setSelection(model.getFullModelRange() as never);
      editor.focus();
    },
    changeAll: () => {
      editor.focus();
      void editor.getAction(CHANGE_ALL_ACTION)?.run();
    },
  };
}

/**
 * Put the caret where a right-click landed, unless it landed inside the
 * selection — the selection is what the menu's Cut and Copy act on, so a
 * right-click on it must keep it. Monaco did this for its own menu; with that
 * menu turned off (`contextmenu: false`) it is ours to do.
 */
export function placeCaretAt(editor: CommandEditor, clientX: number, clientY: number): void {
  const position = editor.getTargetAtClientPoint(clientX, clientY)?.position;
  if (!position) return;
  const selection = editor.getSelection();
  if (selection && !selection.isEmpty() && selection.containsPosition(position)) return;
  editor.setPosition(position);
}

/**
 * Where the caret is on screen, on the last pixel row of its line — where a
 * menu opened from the keyboard belongs. Not one pixel lower: the event at
 * this point also goes through `placeCaretAt`, which would otherwise move the
 * caret to the next line. `null` when the caret is scrolled out of view.
 */
export function caretClientPoint(editor: CommandEditor): { x: number; y: number } | null {
  const position = editor.getPosition();
  const node = editor.getDomNode();
  if (!position || !node) return null;
  const at = editor.getScrolledVisiblePosition(position);
  if (!at) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + at.left, y: rect.top + at.top + at.height - 1 };
}

/** Shift+F10 — the keyboard's "open the context menu", which Monaco
 *  swallows (its own binding shows its own menu, and that menu is off). The
 *  Menu key needs nothing: the browser fires `contextmenu` at the caret. */
export function isContextMenuChord(e: KeyboardEvent): boolean {
  return e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function nonEmpty(editor: CommandEditor): EditorSelection[] {
  return (editor.getSelections() ?? []).filter((s) => !s.isEmpty());
}

/** Every selected range's text, one per line, as Monaco copies a multi-cursor
 *  selection. */
function selectedText(editor: CommandEditor): string {
  const model = editor.getModel();
  if (!model) return "";
  return nonEmpty(editor)
    .map((range) => model.getValueInRange(range))
    .join(model.getEOL());
}
