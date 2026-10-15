/**
 * Which window this code is running in.
 *
 * The distinction is load-bearing, not cosmetic. `tab_state.json` is written by
 * the main window *only* (ADRs #8 and #27): a secondary "New window"
 * instance that read or wrote the shared blob would corrupt the main window's
 * session, so every tab-state-aware path has to be gated. Same for the
 * shared-origin sweep and the environment rail.
 *
 * That invariant used to be spelled sixteen different ways —
 * `getCurrentWindow().label === "main"`, its negation, and two copies of a
 * private `isMainWindow()` helper in two different stores, one of them in a file
 * that already had the helper in scope 88 lines above. Sixteen chances to forget
 * the guard on the next tab-state-aware command. Now there is one.
 *
 * Note this is not the only question asked of the window label: a detached tab
 * window carries a `tabwin-<id>` label it parses for its own id, and the Console
 * log bridge uses the label as an event *target* to scope `emit_to` deliveries
 * (gotcha #25). Those read the label for what it says, not for which window it
 * is, and stay as they are.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

/** The Tauri label of the primary window, as configured in `tauri.conf.json`. */
export const MAIN_WINDOW_LABEL = "main";

/**
 * Whether this is the primary window.
 *
 * Reads the label on every call rather than caching it: the value is fixed for
 * a window's lifetime, but a module-level constant would be evaluated at import
 * time, which is a worse failure mode if this ever loads before the window is
 * ready.
 */
export function isMainWindow(): boolean {
  return getCurrentWindow().label === MAIN_WINDOW_LABEL;
}

/**
 * Which of the four window shapes a label identifies — the same distinction
 * `main.tsx` already makes to pick a window's React root, restated here as a
 * pure classifier so `WindowColorBadge` can label a window ("Main window" /
 * "Secondary window" / …) without re-deriving the prefixes a third time.
 * Order matters: check the specific prefixes before falling back to
 * "secondary", since a `win-<uuid>` label ("New window") shares no prefix
 * with the other two but must still be told apart from `main`.
 */
export type WindowKind = "main" | "secondary" | "tabWindow" | "pulseWindow";

export function windowKindOf(label: string): WindowKind {
  if (label === MAIN_WINDOW_LABEL) return "main";
  if (label.startsWith("tabwin-")) return "tabWindow";
  if (label.startsWith("pulsewin-")) return "pulseWindow";
  return "secondary";
}
