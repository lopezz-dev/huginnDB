/**
 * Keys the app answers that are not in the action catalogue.
 *
 * The catalogue (`actions.ts`) holds what a user can rebind. A few keys are
 * wired directly where they act and are not rebindable — the grid's copy is
 * the browser-standard chord, handled by the grid's own keyboard hook — and a
 * menu still wants to show them next to the item they trigger.
 *
 * Each entry names the place that answers it. A menu may only advertise a key
 * listed here or in the catalogue (ADR #143), so this list is also the place
 * to look when one of those handlers moves or goes away: the menu would go on
 * promising a key that no longer does anything.
 */
export const FIXED_KEYS = {
  /** Copies the active cell's value: `lib/grid/useGridKeyboardNav.ts`,
   *  `handleCopyPasteChord`. */
  copyCell: "Mod+C",
  // Inside a Monaco editor these are Monaco's own keybindings, not the app's:
  // the editor answers them itself and nothing in HuginnDB intercepts them
  // (`lib/monaco/monacoKeybindings.ts` only redispatches catalogue actions).
  // The editor's context menu (`components/menus/editorMenu.ts`) shows them.
  /** Monaco: `editor.action.clipboardCutAction`. */
  editorCut: "Mod+X",
  /** Monaco: `editor.action.clipboardCopyAction`. */
  editorCopy: "Mod+C",
  /** Monaco: `editor.action.clipboardPasteAction`. */
  editorPaste: "Mod+V",
  /** Monaco: `editor.action.selectAll`. */
  editorSelectAll: "Mod+A",
  /** Monaco: `editor.action.changeAll`. */
  editorChangeAll: "Mod+F2",
} as const;

export type FixedKey = keyof typeof FIXED_KEYS;
