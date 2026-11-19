/**
 * Public surface of the keybinding subsystem.
 *
 * The module used to be a single `src/lib/keybindings.ts`; it is now four
 * files (catalogue / lexicon / resolver / dispatcher) re-exported here so that
 * every existing `@/lib/keybindings` import keeps resolving unchanged.
 *
 * `comboFromEvent` / `matchesBinding` / `formatComboForDisplay` are the
 * pre-split names, kept as aliases of their `chord.ts` equivalents.
 */

export {
  ACTIONS,
  ACTION_BY_ID,
  CATEGORY_ORDER,
  type ActionId,
  type ActionSpec,
  type Category,
  type Scope,
} from "./actions";

export { FIXED_KEYS, type FixedKey } from "./fixedKeys";

export {
  type KeyLike,
  chordFromEvent,
  formatForDisplay,
  formatSequence,
  isChordSequence,
  keyTokenFromEvent,
  normalizeChord,
  parseSequence,
} from "./chord";

export {
  CHORD_TIMEOUT_MS,
  type ActionHandlers,
  type KeyDispatcher,
  createKeyDispatcher,
  isTypeableChord,
  scopesAt,
} from "./dispatch";

export { useKeybindingDispatcher } from "./useDispatcher";

export { useShortcutLabel } from "./useShortcutLabel";

export {
  SHORTCUTS_FILE_NAME,
  ShortcutImportError,
  type ShortcutImportResult,
  parseKeybindingsFile,
  serializeKeybindings,
} from "./transfer";

export {
  type Binding,
  type Conflict,
  type Keybindings,
  type ResolvedBindings,
  allBindings,
  findConflicts,
  getBinding,
  resolveBindings,
  scopesOverlap,
  userBindings,
} from "./resolve";

import { chordFromEvent, formatForDisplay, parseSequence, type KeyLike } from "./chord";

/** Legacy alias for {@link chordFromEvent}. */
export const comboFromEvent = chordFromEvent;

/** Legacy alias for {@link formatForDisplay}. */
export const formatComboForDisplay = formatForDisplay;

/**
 * Pure predicate: does this single keypress match the given binding? Never
 * calls `preventDefault` — every call site does that itself right after a
 * match, matching the app's existing convention.
 *
 * A multi-chord binding can never match one event, so it returns `false`:
 * sequences are the dispatcher's job, since only it can remember a prefix.
 */
export function matchesBinding(e: KeyLike, binding: string): boolean {
  const sequence = parseSequence(binding);
  if (sequence.length !== 1) return false;
  return chordFromEvent(e) === sequence[0];
}
