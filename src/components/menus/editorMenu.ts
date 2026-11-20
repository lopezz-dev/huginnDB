/**
 * The context menu of a Monaco editor, as a description (`MenuSpec`,
 * ADR #143).
 *
 * One description for every editor in the app: what changes from one to the
 * next is only which *capabilities* its call site turns on. The clipboard
 * entries are always there (or, in a read-only editor, Copy and Select all);
 * Format, the AI entries and the command palette appear only when the call
 * site hands over the means to do them. An absent capability removes its
 * entry rather than disabling it — what an editor can never do is not offered
 * (the rule ADR #136 set for the query toolbar).
 *
 * Pure: it reads the editor's state as plain facts (`EditorMenuState`) and
 * the operations as callbacks (`EditorCommands`). The component that wires it
 * to a live editor is `EditorContextMenu`.
 */

import type { TFunction } from "i18next";
import {
  ClipboardPaste,
  Command,
  Copy,
  ReplaceAll,
  Scissors,
  Snail,
  Sparkles,
  TextSelect,
  WandSparkles,
} from "lucide-react";

import type { EditorCommands, EditorMenuState } from "@/lib/monaco/editorCommands";
import type { MenuHeader, MenuShortcut, MenuSpec } from "@/lib/menu/menuSpec";

/**
 * What a call site may turn on beyond the clipboard. Each is a group: present
 * means the editor can do it, and carries what doing it takes.
 */
export interface EditorMenuCapabilities {
  /** Format the selection, else the buffer. `shortcut` only where the key
   *  really formats *this* editor (the query tab's `formatQuery`). */
  format?: { run: () => void; shortcut?: MenuShortcut };
  /** The assisted-mode questions about the statement under the caret.
   *  Hand it over only when the AI is reachable for the connection. */
  ai?: { explainQuery: () => void; explainSlow: () => void };
  /** Open the app's command palette. */
  commandPalette?: () => void;
}

export interface EditorMenuInput extends EditorMenuCapabilities {
  t: TFunction;
  header: MenuHeader;
  state: EditorMenuState;
  commands: EditorCommands;
}

export function editorMenu(input: EditorMenuInput): MenuSpec {
  const { t, state, commands, format, ai, commandPalette } = input;
  const writable = !state.readOnly;
  return {
    header: input.header,
    entries: [
      commandPalette && {
        id: "commandPalette",
        section: "navigate",
        icon: Command,
        label: t("editorMenu.commandPalette"),
        shortcut: { action: "toggleCommandPalette" },
        onSelect: commandPalette,
      },
      writable && {
        id: "cut",
        section: "copy",
        icon: Scissors,
        label: t("editorMenu.cut"),
        disabled: !state.hasSelection,
        shortcut: { fixed: "editorCut" },
        onSelect: () => void commands.cut(),
      },
      {
        id: "copy",
        section: "copy",
        icon: Copy,
        label: t("editorMenu.copy"),
        disabled: !state.hasSelection,
        shortcut: { fixed: "editorCopy" },
        onSelect: () => void commands.copy(),
      },
      writable && {
        id: "paste",
        section: "copy",
        icon: ClipboardPaste,
        label: t("editorMenu.paste"),
        shortcut: { fixed: "editorPaste" },
        onSelect: () => void commands.paste(),
      },
      // Only where nothing else selects: in an editor you can type in, the
      // key is one everyone knows and the menu has better uses for the row.
      state.readOnly && {
        id: "selectAll",
        section: "copy",
        icon: TextSelect,
        label: t("editorMenu.selectAll"),
        shortcut: { fixed: "editorSelectAll" },
        onSelect: commands.selectAll,
      },
      ai && {
        id: "explainQuery",
        section: "view",
        icon: Sparkles,
        label: t("ai.task.explainQuery"),
        onSelect: ai.explainQuery,
      },
      ai && {
        id: "explainSlow",
        section: "view",
        icon: Snail,
        label: t("ai.task.explainSlow"),
        onSelect: ai.explainSlow,
      },
      state.canChangeAll && {
        id: "changeAll",
        section: "edit",
        icon: ReplaceAll,
        label: t("editorMenu.changeAll"),
        shortcut: { fixed: "editorChangeAll" },
        onSelect: commands.changeAll,
      },
      writable &&
        format && {
          id: "format",
          section: "edit",
          icon: WandSparkles,
          label: t("editorMenu.format"),
          shortcut: format.shortcut,
          onSelect: format.run,
        },
    ],
  };
}
