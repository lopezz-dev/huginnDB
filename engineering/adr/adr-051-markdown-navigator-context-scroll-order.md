---
id: 51
type: adr
status: accepted
date: 2026-08-24
tags: [react, docs-viewer]
triggered_by_external_trap: true
related: [32]
supersedes: []
superseded_by: null
amends: []
---

# ADR #51: Markdown's navigator is React context, and its scroll-to-anchor clears last

`renderBlocks` is memoized on `source` alone, so a callback prop would either go stale or force a full reparse; `DocsDialog`'s `ScrollToAnchor` clears the pending anchor inside the `requestAnimationFrame` after scrolling, not before, or the effect's own cleanup cancels the frame.

**External trap behind it:** In a React effect that schedules a requestAnimationFrame, updating a dependency before the frame runs triggers the effect cleanup, which cancels the frame so the scroll never happens.

**Decision:** Markdown's DocNavigator is provided by React context rather than a prop, and ScrollToAnchor clears the pending anchor inside the requestAnimationFrame after scrolling.

**Alternatives rejected:**

- Threading a navigator callback prop through renderBlocks: captured stale or forces a full reparse.
- Clearing the anchor before the rAF: the store update re-runs the effect, whose cleanup cancels the scroll frame.

## Detail

**`Markdown`'s navigator arrives by React context, not as a prop — and its scroll-to-anchor consumes the anchor *after* the scroll, not before.** Two separate traps in the same component:
    - `renderBlocks` is memoized on `source` alone (`Markdown.tsx`), so a callback threaded down through `renderBlocks` → `renderInline` → `DocLink` would either be captured stale or have to join the dependency array and throw the whole parse away on every parent render. A context that `DocLink` reads during its own render has neither problem. `DocNavigator` is deliberately two methods (`canFollow` / `follow`) so the cursor can tell the truth about a link the host cannot resolve.
    - `DocsDialog`'s `ScrollToAnchor` clears the pending anchor **inside** the `requestAnimationFrame`, after scrolling. Clearing first is the ordering that reads more naturally and does not work: it updates the store, which changes the effect's dependencies, which runs its cleanup, which cancels the frame that was going to do the scrolling — the effect tidies up after itself and never scrolls. `PrefRow` (ADR #32's settings highlight) clears before its own rAF and may well have the same latent bug; it was not touched here because its flash works and the scroll half was never verified.
