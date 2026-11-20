/**
 * The Monaco options that come from the user's editor preferences.
 *
 * Seven surfaces mount a Monaco — the query editor, the pipeline editor, the
 * cell editor, its docked twin, the Console detail pane, the JSON Schema body
 * editor and the DDL preview — and each assembled its own options object. The
 * option *sets* genuinely differ (the Console adds `domReadOnly` and turns
 * folding off; the schema editor is the one that wants folding on; the DDL
 * preview forces line numbers off regardless of the preference), so this is not
 * one shared object.
 *
 * What was repeated seven times is narrower and worth owning: *which*
 * preferences reach Monaco, and how each is spelled — `wordWrap` as
 * `"on" | "off"` rather than a boolean, `minimap` as `{ enabled }`. Adding an
 * editor preference used to mean finding all seven sites.
 *
 * Spread it and override:
 *
 *     options={{ ...editorOptionsFromPrefs(prefs), readOnly: true, folding: false }}
 */

import type { EditorPrefs } from "@/types";

/** Options every surface wants, plus the preference-derived ones. */
export function editorOptionsFromPrefs(prefs: EditorPrefs) {
  return {
    minimap: { enabled: prefs.minimap },
    wordWrap: (prefs.wordWrap ? "on" : "off") as "on" | "off",
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    tabSize: prefs.tabSize,
    lineNumbers: (prefs.lineNumbers ? "on" : "off") as "on" | "off",
    // Not preferences, but true of every editor in the app: the layout is
    // driven by a resizable pane, and trailing blank space below the last line
    // reads as content in a short pane.
    scrollBeyondLastLine: false,
    automaticLayout: true,
    // Monaco's own right-click menu is off in every editor: the menu is
    // HuginnDB's (`components/menus/EditorContextMenu`, ADR #143), and
    // Monaco's Paste would go through the webview clipboard (ADR #63).
    contextmenu: false,
  };
}

/**
 * Preference-derived options for a **read-only viewer** — the DDL preview, the
 * Console detail pane, a read-only cell.
 *
 * The minimap and line numbers are off regardless of preference: these panes are
 * short, and a minimap of eight lines is decoration. `domReadOnly` also blocks
 * the underlying textarea, so the caret cannot be placed at all.
 */
export function readOnlyEditorOptions(prefs: EditorPrefs) {
  return {
    ...editorOptionsFromPrefs(prefs),
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    lineNumbers: "off" as const,
  };
}
