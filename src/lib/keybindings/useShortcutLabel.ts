/**
 * The display form of an action's primary binding, for menu items and hints.
 *
 * Safe as a Zustand selector because `getBinding` returns a `string`, which is
 * compared by value — the rule from gotcha #1 that the rest of this
 * module has to work around. Returns `undefined` for an unbound action so a
 * caller can render nothing rather than an empty chip.
 */

import { selectKeybindings, usePreferences } from "@/stores/preferences/preferences";
import type { ActionId } from "./actions";
import { formatForDisplay } from "./chord";
import { getBinding } from "./resolve";

export function useShortcutLabel(id: ActionId | undefined): string | undefined {
  // `undefined` lets a list of items call this unconditionally (the rules of
  // hooks) when only some of them name an action — `ContextActionMenu`.
  const binding = usePreferences((s) =>
    id === undefined ? undefined : getBinding(selectKeybindings(s), id),
  );
  return binding ? formatForDisplay(binding) : undefined;
}
