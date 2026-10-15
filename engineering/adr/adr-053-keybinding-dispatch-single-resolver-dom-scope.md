---
id: 53
type: adr
status: accepted
date: 2026-08-25
tags: [keybindings, zustand, monaco]
triggered_by_external_trap: false
related: [1, 9, 32, 40, 47]
supersedes: []
superseded_by: null
amends: []
---

# ADR #53: A keystroke resolves in exactly one place; scope comes from the DOM

`resolveBindings` returns a fresh `Map` so it can never be a Zustand selector; `data-kb-scope` on containers plus `scopesAt(activeElement)` decides applicability, `ActionSpec.fixed` declares non-rebindable bindings, and Monaco keeps its own `onKeyDown` feeding the same dispatcher for consistency.

**Decision:** Keystrokes resolve in exactly one dispatcher (lib/keybindings/dispatch.ts), scope comes from data-kb-scope via scopesAt(activeElement), bindings are string[] with three meaningful states, fixed bindings are declared via ActionSpec.fixed, and only overrides are exported.

**Alternatives rejected:**

- Four independent listeners: they disagreed with each other.
- Calling resolveBindings from a Zustand selector: returns a fresh Map, causing infinite renders.
- A special case for an overlay scope: focus already makes other scopes unreachable.
- Normalising a reset by writing defaults into the map: breaks the 'modified' filter and reset buttons.
- A separate keybindings2 field to keep downgrade compatibility: not chosen, though noted as still available.
- Reserving Mod+R via an if-branch in App.tsx: invisible to Settings and the conflict check.
- Exporting effective bindings: would bake this version's defaults into the file.

## Detail

**A keystroke is resolved in exactly one place (`lib/keybindings/dispatch.ts`), and the *scope* that decides whether it applies comes from the DOM.** The subsystem was one 127-line file plus four listeners that disagreed with each other; it is now a catalogue, a pure key lexicon, a resolver and a single stateful dispatcher. The things that will bite:
    - **`resolveBindings` returns a fresh `Map` per call, so it can NEVER be called from a Zustand selector** (gotcha #1). `useKeybindingDispatcher` derives it with `useMemo` from the raw overrides map and reads it through a ref, which is also what lets its `window` listener register once and never re-register on a rebind. The six `getBinding` selectors it replaced were only ever safe because `getBinding` returns a `string`, compared by value — that is still true, and `useShortcutLabel` is built on it for the same reason. If you add a helper here, returning a string is the difference between "safe as a selector" and "infinite render".
    - **A scope is declared with `data-kb-scope` on a container, and `scopesAt(document.activeElement)` walks up to the nearest one.** There is deliberately *no* special case for `overlay`: with a palette open the focus is inside it, so `grid`/`tree`/`editor` are already unreachable, while `global` stays reachable because the palette's own toggle is a global action and has to be able to close it. Two scopes overlap iff they are equal or one is `global` — which is what makes it legal for the grid and the editor to hold the same key, and what `findConflicts` uses so a rebind is only refused when the ambiguity is real.
    - **A binding is a `string[]`, and its three states are all load-bearing**: key absent = use `ActionSpec.defaults`, `[]` = deliberately unbound, non-empty = primary first then aliases. Never "normalise" a reset by writing the default into the map — the Settings screen's "modified" filter and its reset buttons are key-presence checks, and `resetKeybindings` empties the map for exactly this reason. Rust reads both this and the pre-1.19 bare string via `prefs::string_or_vec`; **writes are always the list form**, so a downgrade cannot parse the file and falls back to `Preferences::default()`, losing every preference and not just the shortcuts. That trade is documented at the deserializer; the alternative (a `keybindings2` field with the old one deprecated, the `Environment.origins` shape of ADR #40) is still available if it ever looks better.
    - **`ActionSpec.fixed` is how a non-rebindable binding is declared** — today only `Mod+R`, which stops the WebView reloading the app out from under an open transaction. It used to be an `if` branch inside `App.tsx`'s handler, which meant the Settings list could not show it and the conflict check could not see it, so rebinding something onto `Mod+R` was accepted and then never fired. Anything reserved goes here, not into a branch.
    - **Monaco keeps its own `onKeyDown`** (gotcha #9 — `addCommand` resolves a bitmask once, inside Monaco's keybinding service, and cannot re-check a live binding) but feeds the *same* dispatcher, so a chord sequence behaves identically inside and outside the editor. It memoizes the resolved index against the overrides object's identity, since the store hands back the same reference until something changes.
    - **The focus guard is `isTypeableChord`, and it is deliberately narrow.** Only a chord with no `Mod`/`Ctrl`/`Meta`/`Alt` *and* a printable token is suppressed inside a text field, so binding an action to a bare letter cannot make that letter untypeable — while `F5`, `Escape` and the arrows keep working with the cursor in an input, which is what anyone expects of a refresh key. The old listener had no such check at all.
    - **`ActionId` is the id namespace for the palette and the menus too.** `PrefId` derives `keybinding.${ActionId}` (ADRs #32/#47), so adding an action grows the palette's settings index and `PrefRow`'s anchors for free — but a new action still needs its `labelKey` in **both** locales, and `actions.test.ts` is what turns that into a test failure instead of a raw dotted key on screen. That test also asserts the shipped defaults do not collide *through the real scope rule*, and that each is stored in canonical form; a default in non-canonical form compiles fine and silently never matches.
    - **Only *overrides* are exported** (`lib/keybindings/transfer.ts`). Writing out each action's effective binding would bake this version's defaults into the file and opt the importing machine out of every default added since.
    - Still open, and they travel together: `CellEditor`'s `Mod+S` is a fixed `addCommand` with a literal hint, and `SideEditorPanel` still wins its `Mod+S` race with `stopImmediatePropagation`. Making either a real catalogue action means making that `addCommand` dynamic, which is the same piece of work.
