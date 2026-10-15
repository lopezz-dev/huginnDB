---
id: 90
type: adr
status: accepted
date: 2026-09-18
tags: [monaco, zustand, themes]
triggered_by_external_trap: false
related: [88]
supersedes: []
superseded_by: null
amends: []
---

# ADR #90: An id validated against an asynchronously-filled registry must be *derived* from a store, not sampled from a module-level `Map`

`resolveMonacoTheme` guards `monaco.editor.setTheme`, which throws on an id nothing has defined — so it refuses any id absent from `IMPORTED_THEMES`, a module-level `Map` filled by `hydrateInstalledThemes` one async call **after** first paint. Every editor that mounted inside that window therefore resolved the user's imported theme down to `huginn-dark`, correctly and permanently: `<Editor theme={...}>` only re-applies when the prop changes, and the prop was computed from a `Map` no component subscribes to. The fix is not to relax the guard — it is to read the same fact through the store that React can subscribe to (`useMonacoTheme` → `importedEditorThemes`), so the update that registers the definitions is the update that repaints.

**Decision:** Resolve the editor theme through the subscribable store (`useMonacoTheme` → `importedEditorThemes`) rather than the module-level Map, and have installing/switching a theme move `editor.theme` via the pure `nextEditorTheme`.

**Alternatives rejected:**

- Relaxing resolveMonacoTheme's guard — rejected because monaco.editor.setTheme throws on an undefined id.
- Pushing monaco.editor.setTheme from the hydration path — rejected because it loses to the next editor mounting with a stale prop.
- Adding a reverse dependency from preferences.ts to the theme store — rejected because it would cycle two stores read before first paint.

## Detail

**The guard was right; the plumbing was the bug.** `resolveMonacoTheme` cannot accept an unregistered id — `setTheme` throws, and a throw inside Monaco's theme service leaves the editor unpainted rather than default-painted. So the function is correct in isolation for every input. What made it produce a wrong *answer* was that its input set changes over time and its callers sampled it exactly once, at mount.

**A module-level `Map` is invisible to React by construction.** `IMPORTED_THEMES` exists for a real reason (ADR #88: registration happens at two unrelated moments — store rehydration and a mid-session import — and both must see the same set, so the module remembers definitions *and* every Monaco namespace it has been handed). That is the right home for the registry. It is the wrong home for the *question* "which theme should this editor show", because a `Map` mutation is not a state update. The store already held the same information in a reactive shape (`importedEditorThemes`, populated by the very `setState` that precedes registration); nine call sites were reading the non-reactive copy.

**The comment in `App.tsx` asserted the repaint that never happened.** It read: *"an editor that mounts first gets repainted when the definitions land"*. Nothing implemented that. This is the failure mode worth naming — a comment describing an invariant nobody wired, next to the code that would have to wire it, reads as verification and suppresses the question.

**`useMonacoTheme` lists a value it does not read as a dependency, on purpose.** The hook's `useMemo` depends on `[id, imported]` while the body only uses `id`; `imported`'s identity *is* the signal that a resolve can now return a different answer. Same derived-in-one-place shape as `focusFollowsTab` (1.25.0) — the alternative, pushing `monaco.editor.setTheme` from the hydration path, works for the frame it runs in and loses to the next editor that mounts with a stale prop.

**The crash on top of it was a separate, sharper instance of the same confusion.** `getMonacoPreviewColors` indexed `MONACO_THEME_DEFINITIONS` — keyed by the *compile-time* catalogue — with whatever `resolveMonacoTheme` returned, which for an imported theme is the imported id. `undefined.rules` threw and took the whole Settings dialog down. Two registries, one lookup: the type system did not catch it because `resolveMonacoTheme` returns `MonacoThemeId` and an imported id is cast into that union at the boundary (`return id as MonacoThemeId`), which is what makes the union a claim rather than a guarantee. Any consumer of that return value must go through both registries, or state in writing why the catalogue alone is enough.

**Installing a theme is one act, so `editor.theme` follows it.** Before this, the chrome repainted and the editor did not, with nothing in the UI saying they were separate knobs — which is how the bug was noticed at all. `nextEditorTheme` (pure, exported, tested without a store) decides: an install or update forces the move, a light/dark flip follows the family to its other side, a family switch follows when the editor was on the family being left, and a delete moves it off an id that stopped existing. It returns `null` — leave the editor alone — whenever the editor is parked on a *curated* theme, because Monokai next to a Dracula chrome is a choice, not drift. `syncEditorTheme` also returns early when `usePreferences` is not hydrated: before `hydrate()` the in-memory prefs are defaults, and writing there persists a theme the user never chose.

**The store dependency is one-way and must stay that way.** `stores/preferences/theme.ts` now imports `usePreferences`; `preferences.ts` knows nothing about themes. Adding the reverse edge would cycle two stores that are both read before first paint.
