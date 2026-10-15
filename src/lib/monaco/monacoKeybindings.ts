/**
 * Shared redispatch for the customizable actions Monaco would otherwise
 * swallow inside its own focus area (gotcha #9).
 *
 * `editor.addCommand` can't work here: it resolves a fixed keybinding
 * bitmask once, inside Monaco's own keybinding service, before the handler
 * ever runs — there's no way to re-check a user-rebindable combo at call
 * time. `editor.onKeyDown` gives us the raw `KeyboardEvent` instead.
 *
 * What it feeds that event to is the *same* `createKeyDispatcher` the window
 * listener uses, so an action bound to a chord sequence works inside the
 * editor exactly as it does outside it, and the editor no longer carries its
 * own idea of what beats what. The scope is `editor`, plus `global`.
 */

import { usePreferences } from "@/stores/preferences/preferences";
import { usePendingChord } from "@/stores/session/pendingChord";
import {
  createKeyDispatcher,
  resolveBindings,
  type ActionHandlers,
  type ActionId,
  type Keybindings,
  type ResolvedBindings,
  type Scope,
} from "@/lib/keybindings";

interface MonacoKeyDownEvent {
  browserEvent: KeyboardEvent;
}

interface EditorLike {
  onKeyDown: (fn: (e: MonacoKeyDownEvent) => void) => { dispose: () => void };
}

const EDITOR_SCOPES: Scope[] = ["global", "editor"];

/** One-entry memo so a keystroke doesn't rebuild the whole index: the store
 *  hands back the same overrides object until something actually changes. */
let cachedFor: Keybindings | null = null;
let cached: ResolvedBindings | null = null;

function resolvedNow(): ResolvedBindings {
  const keybindings = usePreferences.getState().prefs.keybindings;
  if (cached === null || cachedFor !== keybindings) {
    cachedFor = keybindings;
    cached = resolveBindings(keybindings);
  }
  return cached;
}

/** Registers one `onKeyDown` listener that redispatches to whichever of
 *  `actions` matches the user's current binding. Returns a disposer. */
export function registerEditorActionRedispatch(
  editor: EditorLike,
  actions: { id: ActionId; run: () => void }[],
): () => void {
  const handlers: ActionHandlers = {};
  for (const { id, run } of actions) handlers[id] = run;

  const dispatcher = createKeyDispatcher({
    getResolved: resolvedNow,
    getHandlers: () => handlers,
    onPendingChange: (chords) => usePendingChord.getState().setChords(chords),
  });

  const disposable = editor.onKeyDown((e) => {
    if (!dispatcher.handleKey(e.browserEvent, EDITOR_SCOPES)) return;
    e.browserEvent.preventDefault();
    // Monaco's own keybinding service runs after this listener, so a matched
    // key has to be stopped here or the editor also acts on it.
    e.browserEvent.stopPropagation();
  });
  return () => {
    dispatcher.reset();
    disposable.dispose();
  };
}
