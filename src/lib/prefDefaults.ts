/**
 * "Has this setting moved off its default, and what does putting it back
 * look like?" — the pure half of the Preferences dialog's changed markers.
 *
 * A `PrefId` is already a `<group>.<key>` path into `Preferences` (see
 * `lib/prefId.ts`), so every row that passes one can answer the question with
 * no extra wiring: read the path out of the live prefs and out of the defaults
 * and compare. What this module adds is the decision of which rows *should*
 * answer it:
 *
 * - **Only the groups that are taste, not configuration.** `editor`, `grid`,
 *   `ui`, `notifications`, `connections`, `pulse` and `terminal` hold knobs with a
 *   meaningful stock value. `ai` does not: its endpoint, model and trust
 *   describe the user's own infrastructure, and a "reset" that blanks the
 *   model or re-points the panel at Ollama's default port would be a way to
 *   break a working setup with one click, not a way to undo a tweak.
 * - **`ui.language` is excluded.** It is the user's locale rather than a
 *   deviation from anything: every Spanish-speaking user would carry a
 *   permanent "changed" dot on General, and "reset" would switch them to
 *   English.
 * - **Keybindings are excluded** by construction (`keybinding.*` is not a
 *   group here) — the Shortcuts section has its own per-row and global reset.
 *
 * The defaults are a parameter rather than an import so this stays free of the
 * store (and its Tauri imports) and can be tested as plain data.
 */

import type { PrefId } from "@/lib/prefId";
import type { Preferences } from "@/types";

type ResettableGroup =
  | "editor"
  | "grid"
  | "ui"
  | "notifications"
  | "connections"
  | "pulse"
  | "terminal";

const RESETTABLE_GROUPS: ReadonlySet<string> = new Set<ResettableGroup>([
  "editor",
  "grid",
  "ui",
  "notifications",
  "connections",
  "pulse",
  "terminal",
]);

const NOT_RESETTABLE: ReadonlySet<string> = new Set<PrefId>(["ui.language"]);

export interface PrefPath {
  group: ResettableGroup;
  key: string;
}

/** The path behind `id`, or `null` when that setting has no reset. */
export function resettablePath(id: PrefId): PrefPath | null {
  if (NOT_RESETTABLE.has(id)) return null;
  const dot = id.indexOf(".");
  const group = id.slice(0, dot);
  if (!RESETTABLE_GROUPS.has(group)) return null;
  return { group: group as ResettableGroup, key: id.slice(dot + 1) };
}

export function readPref(prefs: Preferences, path: PrefPath): unknown {
  return (prefs[path.group] as unknown as Record<string, unknown>)[path.key];
}

/** Rows only ever address scalars, so identity is the right comparison. */
export function isPrefModified(
  prefs: Preferences,
  defaults: Preferences,
  id: PrefId,
): boolean {
  const path = resettablePath(id);
  if (!path) return false;
  return !Object.is(readPref(prefs, path), readPref(defaults, path));
}

export function modifiedPrefIds(
  prefs: Preferences,
  defaults: Preferences,
  ids: readonly PrefId[],
): PrefId[] {
  return ids.filter((id) => isPrefModified(prefs, defaults, id));
}

/**
 * `prefs` with every resettable id in `ids` put back to its default.
 *
 * Only the groups actually touched are copied, and `prefs` itself comes back
 * unchanged when nothing needed resetting — the store's slice selectors
 * (`selectEditorPrefs`, …) depend on untouched groups keeping their identity,
 * which is the infinite-re-render trap the store's own header warns about.
 */
export function withDefaults(
  prefs: Preferences,
  defaults: Preferences,
  ids: readonly PrefId[],
): Preferences {
  let next = prefs;
  for (const id of ids) {
    if (!isPrefModified(next, defaults, id)) continue;
    const path = resettablePath(id);
    if (!path) continue;
    next = {
      ...next,
      [path.group]: { ...next[path.group], [path.key]: readPref(defaults, path) },
    };
  }
  return next;
}
