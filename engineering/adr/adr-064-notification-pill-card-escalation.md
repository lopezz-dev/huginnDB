---
id: 64
type: adr
status: accepted
date: 2026-09-07
tags: [ui, ux]
triggered_by_external_trap: false
related: [68]
supersedes: []
superseded_by: null
amends: []
---

# ADR #64: Notifications have two anatomies and one escalation rule, decided at the seam

Every non-error notification is a one-line pill unless it carries `actions`, a `path` or a description too long for the line, in which case it escalates to the card — a single decision in `surfaceFor` (`lib/notify.tsx`), never at the call site. The two anatomies live in two Sonner hosts, which Sonner routes natively.

**Decision:** Non-error notifications are one-line pills unless they carry actions, a path or a too-long description, decided only in surfaceFor (lib/notify.tsx); pills and cards render in two Sonner hosts routed by toasterId.

**Alternatives rejected:**

- Re-deriving pill vs card at each call site: rejected because a call site that forgets silently drops its buttons.
- Measuring rendered width for the budget: not possible because the decision is made before mount; a Spanish-calibrated character count is used.
- Patching Sonner or writing a second container: unnecessary since Sonner routes by toasterId natively.
- Picker restrictions or pixel arithmetic when both hosts share a corner: rejected; one host is mounted and the stacks merge.
- Folding a card's buttons into a live pill group: rejected; a group breaks when its anatomy changes.
- Fixing the pill row width: rejected because Sonner drives positioning via transform; pointer-events is used instead.

## Detail

**The card was being spent on notifications with nothing to put in it.** "Cell saved" occupied 380 px, a medallion, a body slot and a button row to deliver two words. `NotificationPill` is the other anatomy: 32 px, one line, icon + title + optional mono suffix + `×N`, dismissed by clicking it. What is settled:

- **`surfaceFor(kind, title, opts)` in `lib/notify.tsx` is the only place the two are told apart**, and the question it answers is *"does this fit on one line"*, not *"which kind is this"*. `error` and `file` are always cards (an error carries a driver message to copy; a file notification's whole reason to exist is the buttons under the name). Everything else is a pill until it grows `actions`, a `path`, a multi-line description, or one longer than `PILL_SUFFIX_BUDGET`. **Never re-derive this at a call site** — a call site that had to remember would be one that silently dropped its own buttons. This is the doctrine's *Prefer the seam* (CONTRIBUTING → "Feedback and transition state") applied to anatomy.
- **The budgets are a character count, not a measurement, and are calibrated in Spanish.** The decision is made in `raise()`, before anything mounts, so there is nothing to measure. `es.json` runs ~9 % longer than `en.json`, so a budget tuned on English truncates in the other language half the users read.
- **Two hosts, routed by Sonner itself.** `sonner@2.0.7` filters by `toast.toasterId === toaster.id` (`dist/index.mjs:924`), and a `<Toaster>` with **no** `id` renders exactly the toasts with **no** `toasterId`. So the card host stays the default and the pill host is opt-in (`PILL_TOASTER_ID`). Nothing was patched and no second container was written; `NotificationHosts` mounts both and is the only place a `<Toaster>` appears.
- **Same corner for both is not a collision to arbitrate — it is one stack.** When `pillPosition === position`, `NotificationHosts` mounts one host and `toasterIdFor` stops tagging pills, so they fall into it and Sonner stacks the two heights together. No picker restriction, no pixel arithmetic. Consequence to know: changing `pillPosition` to match while pills are live unmounts their host and they vanish. Transitory, in the settings dialog only, and not worth fixing.
- **`useToastStack` records the *rendering* host, not the anatomy.** Those differ in the merged case, and `protectStackBoundary` reasoning about two stacks that do not exist is exactly the bug that produced (`hostForToasterId` is the inverse of `toasterIdFor`; use it, not `surface`).
- **A progress bar that resolves into the other anatomy cannot keep its slot.** `notify.progress()` normally relabels its toast in place (`forceToastId`), but a pill failing into an error card belongs to a host that will not render it. `raise()` detects the mismatch, dismisses the old toast and raises a fresh one. So `progress → success` keeps its id and `progress → error` does not — the one place the "same slot" promise is deliberately broken.
- **A group breaks when its anatomy changes.** `LiveGroup` carries a `surface`; a repeat that would render the other way starts a new toast with the counter back at 1 rather than folding into the live one. The alternative is folding a card's buttons into a pill that cannot show them.
- **A pill takes the base duration — `KIND_FACTOR` applies to cards only.** The multiplier buys reading time and a pill has nothing to read. A `warning` therefore drops from 12 s to 6 s; one that carries something to act on has already escalated to a card and gets the ×2 back with it. Known cost: without the drain hairline, `expandOnHover`'s timer freeze has no visible acknowledgement on a pill.
- **The pill host's row is inert, and that is what costs the swipe.** Sonner sizes every custom toast to `--width` (356 px), so a pill's row is mostly a transparent band that would swallow clicks across a third of the window. `index.css` sets `pointer-events: none` on `[data-sonner-toast]` under `.notif-pill-stack` and `auto` on the button inside it. The swipe handler lives on the row, so a pill dismisses on a plain click instead; hover still pauses every timer, because the event starts on the button and bubbles to the container. **Do not "fix" the width instead** — Sonner leaves `left` unset for a centred stack and drives the stacking animation through `transform`, so the row is not ours to re-position; alignment inside it is (`NotificationPill`'s `align`).
- **`NotificationOverflowBadge` is the "+N more" counter, not a pill.** It was `NotificationOverflowPill` until the pill anatomy existed; two things called a pill in one subsystem is one too many.

- **What raises a notification is decided by "is the effect on this screen", and the answers that keep getting re-litigated are written down.** Raising one: connecting (seconds long, and started before people look away), `disconnectAll` (for the count), applying structure/view DDL, dropping or renaming a table/view/database, MongoDB index work, publishing to an origin, `originSync.syncAll` when it actually changed something, an import's result, an MCP write policy, a multi-row clipboard copy (the count is the question), a heartbeat connection loss, and a session restore that could not reopen a connection. **Staying silent, on purpose:** a single disconnect (the row greys and its tabs close), resetting the shortcuts or the panel layout (the list or the screen visibly reverts), duplicating a theme (it appears in the list in front of you), copying one cell or one row (the paste is the confirmation), and refreshing the schema **when it works** — a schema read that *fails* raises, and the distinction is not a hedge: the tree is where that failure was rendered, and it is not mounted unless the connection's row is expanded and active, nor when a filter has folded the row away. See ADR #68 for the case that made the difference load-bearing, where the same rule let the app raise "Connected" for a server that had never answered. This is CONTRIBUTING's *confirm a write only when its effect is not self-evident* applied outside the grid; a rule you apply everywhere is as wrong as one nobody applies.
