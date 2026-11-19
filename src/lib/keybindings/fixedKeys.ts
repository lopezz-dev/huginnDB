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
} as const;

export type FixedKey = keyof typeof FIXED_KEYS;
