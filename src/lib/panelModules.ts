/**
 * Which optional modules are switched on — the one answer every surface that
 * opens their panel reads: the right activity bar, the View menu, the command
 * palette and the keyboard shortcuts.
 *
 * Asked in one place so the four cannot disagree: a module switched off in
 * Settings must not leave a shortcut that still opens it, or a menu entry
 * that toggles an empty dock. Saved Queries, Extensions and the Console are
 * not modules — they are always offered.
 *
 * - **AI** — `ai.enabled`, off by default (and every existing install): the
 *   panel reaches an endpoint, so it is opt-in (gotcha #71).
 * - **Pulse** — `pulse.enabled`, on by default: it shipped visible, and the
 *   switch also idles the background sampler.
 * - **Terminal** — `terminal.enabled`, on by default: `mongosh` is the
 *   MongoDB driver's own shell, and the plain shell carries no credential.
 */

import type { Preferences } from "@/types";

export type PanelModule = "pulse" | "ai" | "terminal";

export function moduleEnabled(prefs: Preferences, module: PanelModule): boolean {
  switch (module) {
    case "pulse":
      return prefs.pulse.enabled;
    case "ai":
      return prefs.ai.enabled;
    case "terminal":
      return prefs.terminal.enabled;
  }
}
