/**
 * Merges the catalogue's defaults with the user's overrides into the two
 * things the rest of the app needs: an index the dispatcher can look up per
 * keystroke, and a conflict list the Settings UI can explain.
 *
 * ⚠️ **Everything here returns fresh objects.** `resolveBindings` builds a new
 * `Map` on every call, so it must only ever be invoked inside a `useMemo` (or
 * imperatively via `getState()`), never from a Zustand selector — a selector
 * returning a fresh reference re-renders forever. See gotcha #1.
 * `getBinding` is the exception: it returns a `string`, which Zustand compares
 * by value, which is why the existing selectors are safe.
 */

import { parseSequence } from "./chord";
import { ACTIONS, ACTION_BY_ID, type ActionId, type ActionSpec, type Scope } from "./actions";

/** User overrides as persisted in `prefs.json`, keyed by action id.
 *
 *  Three states, all meaningful and all distinct:
 *  - key absent  → use the action's `defaults`
 *  - `[]`        → the user deliberately unbound it
 *  - `[a, b, …]` → primary first, then aliases */
export type Keybindings = Record<string, string[]>;

/** One resolved binding: a sequence of chords pointing at an action. */
export interface Binding {
  actionId: ActionId;
  scope: Scope;
  /** The stored form, e.g. `"Mod+K Mod+S"`. */
  binding: string;
  /** The same thing split, normalized, ready to match chord by chord. */
  sequence: string[];
  /** `true` for entries that came from `ActionSpec.fixed` — not rebindable. */
  fixed: boolean;
}

export interface Conflict {
  chordSequence: string;
  actions: ActionId[];
}

export interface ResolvedBindings {
  /** Keyed by the binding's **first** chord. A chord with more than one
   *  candidate is normal (different scopes); a chord whose candidates all have
   *  longer sequences is a pending-prefix, which is what makes chords work. */
  index: Map<string, Binding[]>;
  conflicts: Conflict[];
}

/**
 * Two scopes can both hear the same key when they are the same scope, or when
 * either of them is `global`. Siblings (`grid` vs `editor`) cannot — which is
 * exactly what lets one key mean different things in the grid and the editor.
 */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  return a === b || a === "global" || b === "global";
}

/** The user-editable bindings for one action: their override if they set one,
 *  the catalogue's defaults otherwise. Does **not** include `fixed`. */
export function userBindings(keybindings: Keybindings, id: ActionId): string[] {
  const spec = ACTION_BY_ID.get(id);
  const override = keybindings[id];
  if (Array.isArray(override)) return override;
  // Tolerate a v1 blob that reached us without going through the backend's
  // `string_or_vec` (e.g. an import file written by an older build).
  if (typeof override === "string") return [override];
  return spec?.defaults ?? [];
}

/** Everything that fires this action, user-editable entries first. */
export function allBindings(keybindings: Keybindings, id: ActionId): string[] {
  const spec = ACTION_BY_ID.get(id);
  return [...userBindings(keybindings, id), ...(spec?.fixed ?? [])];
}

/**
 * The action's primary binding as a display string, or `""` when it ships or
 * was left unbound. Returns a `string` on purpose — see the module header.
 */
export function getBinding(keybindings: Keybindings, id: ActionId): string {
  return userBindings(keybindings, id)[0] ?? "";
}

/** Build the dispatch index plus the conflicts the Settings UI reports. */
export function resolveBindings(
  keybindings: Keybindings,
  actions: ActionSpec[] = ACTIONS,
): ResolvedBindings {
  const index = new Map<string, Binding[]>();
  // Grouped by the *whole* sequence so a collision on `Mod+K` between a
  // one-chord and a two-chord binding isn't reported as a conflict — it isn't
  // one, the first is simply shadowed only when the second doesn't complete.
  const bySequence = new Map<string, Binding[]>();

  for (const spec of actions) {
    const entries: [string, boolean][] = [
      ...userBindings(keybindings, spec.id).map((b) => [b, false] as [string, boolean]),
      ...(spec.fixed ?? []).map((b) => [b, true] as [string, boolean]),
    ];
    for (const [raw, fixed] of entries) {
      const sequence = parseSequence(raw);
      if (sequence.length === 0) continue; // unbound, or unparseable
      const binding: Binding = {
        actionId: spec.id,
        scope: spec.scope,
        binding: sequence.join(" "),
        sequence,
        fixed,
      };
      const head = sequence[0];
      const bucket = index.get(head);
      if (bucket) bucket.push(binding);
      else index.set(head, [binding]);

      const key = binding.binding;
      const sibs = bySequence.get(key);
      if (sibs) sibs.push(binding);
      else bySequence.set(key, [binding]);
    }
  }

  const conflicts: Conflict[] = [];
  for (const [chordSequence, group] of bySequence) {
    if (group.length < 2) continue;
    const clashing = new Set<ActionId>();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].actionId === group[j].actionId) continue;
        if (!scopesOverlap(group[i].scope, group[j].scope)) continue;
        clashing.add(group[i].actionId);
        clashing.add(group[j].actionId);
      }
    }
    if (clashing.size > 0) {
      conflicts.push({ chordSequence, actions: [...clashing] });
    }
  }

  return { index, conflicts };
}

/**
 * Which actions would clash if `binding` were assigned to `candidate`.
 * Used by the capture dialog to warn while the user is still typing, instead
 * of rejecting after the fact.
 */
export function findConflicts(
  keybindings: Keybindings,
  candidate: ActionId,
  binding: string,
  actions: ActionSpec[] = ACTIONS,
): Binding[] {
  const sequence = parseSequence(binding);
  if (sequence.length === 0) return [];
  const target = sequence.join(" ");
  const candidateScope = ACTION_BY_ID.get(candidate)?.scope ?? "global";
  const { index } = resolveBindings(keybindings, actions);
  return (index.get(sequence[0]) ?? []).filter(
    (b) =>
      b.actionId !== candidate &&
      b.binding === target &&
      scopesOverlap(b.scope, candidateScope),
  );
}
