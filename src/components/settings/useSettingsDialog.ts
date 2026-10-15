/**
 * Open/close + active-section state for the Settings dialog.
 *
 * Lives in its own tiny store so `ViewMenu`, `ThemeMenu`, the keyboard
 * shortcut handler (`Ctrl/Cmd+,`), and the topbar button can all open the
 * dialog without prop-drilling through `App.tsx`.
 *
 * **A full-screen editor opened from Settings puts it aside, then gives it
 * back.** Settings is a workbench dialog, and so are the shared-origin and
 * policy editors. Stacking one workbench on another traps focus in whichever
 * mounted last, so the editors are siblings of Settings (mounted in `App`),
 * never its children.
 * - Opening an editor calls `suspend()`, which closes Settings and remembers
 *   the section it was on. It reports whether it did, so the origin editor —
 *   which can also be opened from the connection dialog — knows which surface
 *   to give back (`stores/dialogs/originEditor.ts`).
 * - Closing an editor calls `resume()`, which reopens Settings on that
 *   section, but only if `suspend()` was what closed it.
 *
 * So an editor reached from somewhere else (a connection's banner) leaves
 * Settings closed on the way out, as it found it.
 */

import { create } from "zustand";

import type { PrefId } from "@/lib/prefId";

export type SettingsSection =
  | "general"
  | "editor"
  | "grid"
  | "notifications"
  | "connections"
  | "appearance"
  | "shortcuts"
  | "jsonSchemas"
  | "origins"
  | "mcp"
  | "pulse"
  | "ai"
  | "terminal"
  | "policy"
  | "about";

interface SettingsDialogState {
  open: boolean;
  section: SettingsSection;
  /**
   * `prefId` of a single setting the dialog should scroll to and flash, or
   * `null`. Set by the command palette's "go to this setting" entries; cleared
   * by the `PrefRow` that consumes it (see `clearHighlight`), so the flash plays
   * once per request rather than every time that section is revisited.
   */
  highlightPrefId: PrefId | null;
  /**
   * Bumped to ask the rail's search box to take the focus — the find key
   * (`focusFilter`) pressed while Settings is open. A counter rather than a
   * boolean, the same shape as the schema tree's `focusRequest`: a second
   * press must refocus even if nothing reset a flag in between.
   */
  searchFocusRequest: number;
  /** The section to return to while a full-screen editor opened from Settings
   *  has it put aside (`suspend`); `null` otherwise. */
  suspendedAt: SettingsSection | null;
  openAt: (section?: SettingsSection) => void;
  /** Open `section` and highlight the row registered under `prefId`. */
  openAtPref: (section: SettingsSection, prefId: PrefId) => void;
  setOpen: (open: boolean) => void;
  /** Close Settings for a full-screen surface opened from it, remembering the
   *  section. Does nothing when Settings is not open; returns whether it
   *  closed it. */
  suspend: () => boolean;
  /** Reopen Settings where `suspend` left it. Does nothing if it did not. */
  resume: () => void;
  setSection: (section: SettingsSection) => void;
  clearHighlight: () => void;
  requestSearchFocus: () => void;
}

export const useSettingsDialog = create<SettingsDialogState>()((set, get) => ({
  open: false,
  section: "general",
  highlightPrefId: null,
  searchFocusRequest: 0,
  suspendedAt: null,
  // Any explicit open or close supersedes a pending return.
  openAt: (section) =>
    set((s) => ({
      open: true,
      section: section ?? s.section,
      highlightPrefId: null,
      suspendedAt: null,
    })),
  openAtPref: (section, prefId) =>
    set({ open: true, section, highlightPrefId: prefId, suspendedAt: null }),
  setOpen: (open) => set({ open, suspendedAt: null }),
  suspend: () => {
    const { open, section } = get();
    if (!open) return false;
    set({ open: false, suspendedAt: section });
    return true;
  },
  resume: () =>
    set((s) =>
      s.suspendedAt
        ? { open: true, section: s.suspendedAt, suspendedAt: null }
        : {},
    ),
  // Switching section by hand abandons any pending highlight: the user is
  // navigating somewhere else, and a stale flash on return would be noise.
  setSection: (section) => set({ section, highlightPrefId: null }),
  clearHighlight: () => set({ highlightPrefId: null }),
  requestSearchFocus: () =>
    set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
}));
