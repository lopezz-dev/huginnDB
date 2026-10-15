/**
 * Mounts the shared dispatcher on `window`. One listener for the whole app,
 * registered once and never re-registered — a rebind changes what it finds in
 * the index, not who is listening.
 *
 * ⚠️ The index is derived with `useMemo` from the **raw** overrides map, never
 * inside a Zustand selector: `resolveBindings` returns a fresh `Map` on every
 * call, and a selector returning a fresh reference re-renders forever
 * (gotcha #1). The six `getBinding` selectors this replaces were
 * only safe because each returned a `string`.
 */

import { useEffect, useMemo, useRef } from "react";
import { selectKeybindings, usePreferences } from "@/stores/preferences/preferences";
import { usePendingChord } from "@/stores/session/pendingChord";
import { resolveBindings, type ResolvedBindings } from "./resolve";
import { createKeyDispatcher, scopesAt, type ActionHandlers } from "./dispatch";

export function useKeybindingDispatcher(handlers: ActionHandlers): void {
  const keybindings = usePreferences(selectKeybindings);
  const resolved = useMemo(() => resolveBindings(keybindings), [keybindings]);

  // Both are read on every keystroke rather than captured, which is what lets
  // the listener below register with an empty dependency list. Same reasoning
  // as `monacoKeybindings`, which reads the store imperatively.
  const resolvedRef = useRef<ResolvedBindings>(resolved);
  const handlersRef = useRef<ActionHandlers>(handlers);
  useEffect(() => {
    resolvedRef.current = resolved;
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const setChords = usePendingChord.getState().setChords;
    const dispatcher = createKeyDispatcher({
      getResolved: () => resolvedRef.current,
      getHandlers: () => handlersRef.current,
      onPendingChange: setChords,
    });
    const onKey = (e: KeyboardEvent) => {
      if (dispatcher.handleKey(e, scopesAt(document.activeElement))) {
        e.preventDefault();
      }
    };
    // A half-typed sequence that survives losing focus would fire against
    // whatever the user clicked on next.
    const onBlur = () => dispatcher.reset();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      dispatcher.reset();
    };
  }, []);
}
