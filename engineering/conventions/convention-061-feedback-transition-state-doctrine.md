---
id: 61
type: convention
status: active
date: 2026-09-02
tags: [ux, ui]
related: [24, 44]
supersedes: []
superseded_by: null
amends: []
---

# Convention #61: Feedback and transition state follow a written doctrine in CONTRIBUTING.md

Four rules — name the subject of an async transition, destructive-on-hover with separate confirmation tiers, busy belongs to the control via `loading`, and confirm writes only when the effect isn't self-evident — are meant to be applied at a shared seam rather than re-derived per call site.



## Detail

**Feedback and transition state have a written doctrine — `CONTRIBUTING.md` → "Feedback and transition state".** Four decisions the app kept re-making, differently, until each cost a bug; five of the six fixes in the 1.20.x fit-and-finish pass were a decision that already existed somewhere and had been re-made wrongly elsewhere. The rules in one line each, with the question that decides whether each applies — the reasoning and the worked examples are in CONTRIBUTING, and this entry exists so a session finds them before writing the next `switching: boolean`:
    - **An async transition names its subject.** *Acts on one of several visible things?* Then the state holds which one (`switchingTo: string | null`, `connecting: string | null`, `disconnecting: Set<string>`), never a flag paired with "is this the current one". The "current" pointer usually does not move until the operation ends, so that pairing points at the thing being *left* — which is exactly what parked the environment spinner on the wrong avatar. A single-subject operation is a boolean and that is fine.
    - **Destructive intent shows on hover; confirmation is a separate tier.** Muted at rest, `tone="destructive"` on hover. Red at rest turns a panel into a warning nobody reads; no red at all is how "disconnect all" came to look like the filter button beside it. Whether it *also* needs confirming is a separate question with three answers: `confirmDestructive` (preference-gated, for what the user could redo), `confirmIrreversible` (ignores the preference, for what exists nowhere else — an environment's layout, an origin's passphrase, ADR #24's live AI session), and `ConfirmDialog` when the failure has to be explained in place rather than in a toast (ADR #44).
    - **Busy belongs to the control.** Pass `loading` to `Button`/`IconButton` instead of swapping in a `Spinner`; it disables at the same time, which the hand-rolled version forgets. Anything touching a connection can be a round trip — closing a pool through a tunnel is one *per database*. In a dialog, `useAsyncSubmit`, whose refusal to clear on success is deliberate (ADR #44).
    - **Confirm a write only when its effect is not self-evident.** *Would the screen look identical either way?* A delete removes the row and an insert adds one — the result is the confirmation. An in-place update is the case that needs one, since the value was on screen while it was typed. `animate-brand-flash`, one shot, fired **after** the refetch so it confirms the stored value; a rejected write throws before it and can never look like a success.
    - **Apply all four at a seam, not at each call site.** The grid fires a save from twelve places across six files and the confirmation is one wrapper around the two callbacks in `DataGrid`, before they are handed down. Twelve decorations would have been twelve chances to forget — which is how the app came to have no confirmation anywhere.
