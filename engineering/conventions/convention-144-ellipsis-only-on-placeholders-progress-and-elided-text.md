---
id: 144
type: convention
status: active
date: 2026-11-20
tags: [ui, ux, i18n]
related: [61, 143]
supersedes: []
superseded_by: null
amends: []
---

# Convention #144: "…" goes on a placeholder, a state in progress or elided text — never on an action

No action label in HuginnDB ends in an ellipsis — not a menu item, a button, a tab or a dialog title — even when it opens a dialog. The ellipsis is kept for the three things it means everywhere: an input's placeholder ("Filter connections…"), work in progress ("Loading…", "Exporting…") and text that was cut (`… and 3 more rows`, `ObjectId(…)`). `src/lib/i18n/ellipsis.test.ts` enforces it from the key's name, with no list of exceptions.

## Rule

- **An action has no ellipsis**, in either locale: "Edit structure", "Export database", "Save", "Browse". That covers a label quoted in prose too — a hint that says *use "Add from file" in Preferences* names the button as the button reads.
- **The key decides whether a string may end in "…"**, and the test reads it that way:
  - a placeholder's key ends in `placeholder` (`filterPlaceholder`, `pickConnectionPlaceholder`) — an empty-selection label in a `<select>` or picker is a placeholder too;
  - a state in progress has a word ending in `-ing` in its last segment, or the word `pending` / `progress` (`saving`, `checkingReferences`, `exactCountRunning`, `chordPending`);
  - elided text needs no key rule, because its ellipsis is not action-shaped: it opens the string, sits inside brackets or closes a list.
- A new string that needs the ellipsis gets a key that says which of the three it is. If the natural name does not, rename the key; do not add an exception to the test.
- Elision produced in code (`text.slice(0, max) + "…"`) is fine; a component that appends "…" to a *label* is not (the export menu's `ellipsis` prop was removed for that reason).
- `docs/*.md` quote a label exactly as the app shows it, so they drop the ellipsis with it.

## Why

The ellipsis was the old desktop convention for "this action asks for more input before it runs", and here it was applied by hand: some items that open a dialog had it, others did not, and the same action carried it in one menu and not in the next, which the unified menus of ADR #143 made visible side by side. A rule that depends on knowing what an action does next cannot be checked by a test, so it would drift again. The three remaining meanings can be read off the key's name, so the test can hold the line — and the maintainer decided (2026-11-19) that the "opens a dialog" hint was not worth the inconsistency.
