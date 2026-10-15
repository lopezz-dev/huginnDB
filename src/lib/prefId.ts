/**
 * The addressable id of a single setting.
 *
 * "Go to this setting" from the command palette is a string contract between two
 * files that have no other link: `SETTINGS_INDEX[].prefId` in
 * `lib/commandPalette/settingsRegistry.ts` and the `prefId` prop on that
 * setting's `PrefRow`. `openAtPref` puts the string in the store, the matching
 * row scrolls itself into view and flashes — and a typo on either side degrades
 * to "the section opens, nothing is highlighted", which no test and no reviewer
 * reliably catches (ADR #32).
 *
 * Deriving the union from `Preferences` makes that failure a compile error
 * instead: only a real `<group>.<key>` path type-checks, so renaming a
 * preference breaks both halves at once rather than silently unhooking the jump.
 *
 * `version` and `keybindings` are excluded from the path side deliberately —
 * neither is a row. Keybindings *are* addressable, but as one row per action
 * (`ShortcutRow` emits `keybinding.<ActionId>` for every entry in `ACTIONS`),
 * which is why they come in through `ActionId` rather than as a key of
 * `Preferences`.
 */

import type { ActionId } from "@/lib/keybindings";
import type { Preferences } from "@/types";

/** The preference groups that render as sections of rows. */
type PrefGroup =
  | "editor"
  | "grid"
  | "ui"
  | "notifications"
  | "connections"
  | "pulse"
  | "ai"
  | "updates"
  | "terminal";

/** `"editor.wordWrap" | "grid.rowHeight" | …` — every real preference path. */
type PrefPath = {
  [G in PrefGroup]: `${G}.${Extract<keyof Preferences[G], string>}`;
}[PrefGroup];

export type PrefId = PrefPath | `keybinding.${ActionId}`;
