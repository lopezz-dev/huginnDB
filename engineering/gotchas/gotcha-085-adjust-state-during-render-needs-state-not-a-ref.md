---
id: 85
type: gotcha
status: active
date: 2026-09-16
tags: [react, testing]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #85: "Adjust state when a prop changes" must remember the previous prop in *state* — a ref survives the render StrictMode throws away

The list view's page-wide "expand every nested object" reached every card and did nothing. The card tracked the last gesture it had applied in a `useRef`; `StrictMode` invokes a component body twice and discards the first pass, but a ref mutation is not part of what gets discarded — so the second pass read "already applied", skipped the `setState`, and the only update ever queued belonged to the render React threw away. React's documented pattern stores the previous prop in `useState` for exactly this reason.

**Trap:** Under StrictMode a component body runs twice and the first pass is discarded, but a useRef mutation is not, so a ref-based 'last applied' marker makes the second pass skip the setState and the update is lost; tests not mounted in StrictMode cannot see it.

## Detail

**The shape of the bug.** `DocumentCard` keeps its folds as a diff from a base, and a grid-wide press arrives as an epoch (`ExpandAllSignal`) that the card applies once:

```tsx
const lastEpoch = useRef(expandAll?.epoch ?? 0);   // WRONG
if (expandAll && expandAll.epoch !== lastEpoch.current) {
  lastEpoch.current = expandAll.epoch;             // survives the discard
  setBaseExpanded(expandAll.expanded);             // discarded with the render
  setToggled(new Set());
}
```

Setting state during render is legal and is the right tool here — it is React's "adjust state when a prop changes", and it beats a `useEffect` because the card never paints one frame with the stale folds before correcting itself. What is *not* legal is remembering the comparison value in a ref. Under `StrictMode` (which `main.tsx` wraps the whole app in) the body runs twice for every render. Pass 1 mutates the ref and queues the update; React discards pass 1's queued update and runs the body again; pass 2 now compares against the mutated ref, the condition is false, and nothing is queued. The card is left having *seen* the gesture and not applied it. The fix is one substitution — `useState` for the marker, so it is discarded alongside the render that set it and pass 2 sees the same "before" value pass 1 did.

- **The symptom is uniquely misleading, which is why it is worth a gotcha rather than a line in a commit.** The state was visibly flowing: instrumenting the footer and the card header showed `grid:e21T` next to `card:e21T·seen21·baseF` — the grid had counted 21 presses, the card had received all 21 and marked the newest as seen, and its base had never moved. Every "is it wired up?" hypothesis (a memo bailing out, a prop not threaded through, a stale HMR module, a remount losing state) predicts a card that has *not* seen the signal, and all of them were wrong. A marker that advances while its paired `setState` does not is the fingerprint of this specific mistake, and nothing else here produces it.
- **The event-handler path kept working, which hid it in manual testing.** The same `setBaseExpanded` driven by the card's own header button was fine: an `onClick` is not a render, runs once, and has no marker to get ahead of itself. So the per-document control worked and the page-wide one did not, from one line of shared state — which reads like a wiring fault in the page-wide path and is not.
- **Tests that do not mount in `StrictMode` cannot see it.** Four characterization tests covered the gesture, including the grandchild three levels down and a repeated epoch, and all four passed against the broken build, because outside `StrictMode` the body runs once and pass 1 *is* the render. `DocumentListView.test.tsx` now wraps every case in `<StrictMode>` exactly as `main.tsx` does, and reintroducing the ref fails `applies the grid-wide gesture, and re-applies it on a second press`. **Any component that adjusts state during render belongs under `StrictMode` in its test**, or the test is agreeing with the bug.
- **Why an epoch at all, rather than a boolean.** The press is an action, not a state: after it the user may fold one object by hand, and pressing again must reopen it — a boolean prop would already be `true` and nothing would change. The epoch is also what lets a card that scrolls into the virtualizer's window *after* the press mount already expanded, since off-screen cards are unmounted and a fresh one has no history of its own. Both properties survive the fix; only where the marker lives changed.
- **The neighbouring "let the preference win" block had the same defect and the same fix.** `listExpandNested` changing at runtime must clear a card's wholesale override, and it compared against a ref too. It never misbehaved in practice only because flipping that preference is rare enough that nobody pressed it twice in one session — the identical failure was one user action away.
