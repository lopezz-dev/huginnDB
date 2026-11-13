---
id: 136
type: adr
status: accepted
date: 2026-11-13
tags: [grid, ux]
triggered_by_external_trap: false
related: [96, 114]
supersedes: []
superseded_by: null
amends: [135]
---

# ADR #136: a gesture the relation can never perform is not offered; one this person cannot perform now is shown disabled with why

A grid gesture that is unavailable is one of two different things, and the interface treats them differently. When **this person cannot do it here now** — a policy lock, a key the projection hid, a table with no key — the control stays, disabled, with the reason: the reason is something they can act on or need to know (ADR #96, #267). When **the relation never does it from the grid, for anyone** — rows are not added to a view from the grid — the control is not offered at all: a disabled Insert on a view only advertises something that does not exist, and the reason it carried ("insert into the table it reads from") is not about this grid. `GridSource` expresses the second case as its own capability state, `unsupported`, distinct from `blocked`.

**Decision:** add `{ state: "unsupported" }` to `Capability<Ops>`; the controller wires neither a handler nor a reason for it, so every surface that keys on `onInsertRow` / `insertBlocked` / `onDuplicateRow` (toolbar, blank-space menu, row menu, empty state, the insert alternatives behind the chevron) drops the gesture. A view's insert and duplicate are `unsupported`, and a paste's overflow rows on a view are left out with their own reason.

**Alternatives rejected:**

- **Keep a view's Insert disabled with its reason** (#267, ADR #135 as written). Alex rejected it on 2026-11-13: a view is managed by us, not by the person's permissions, so there is nothing for them to learn from a locked button that will never unlock.
- **Reuse `pending` for views.** It hides the control the same way, but says "not decidable yet": a reader of the source would expect it to become available, and a future "show a spinner while pending" would spin forever on every view.
- **Hide in the grid with a presentational flag** (`hideInsert`). The grid would be deciding what a relation can do, which is the source's job (ADR #135), and every consumer would have to remember to set it.

## Context

Until 1.40 a view's Insert was disabled with "A view can't take new rows here — insert into the table it reads from", the blanket "disabled with the reason, not hidden" rule of #267 applied to every reason. Duplicate, though, was not gated on views at all: it was offered, and sent an INSERT that a non-updatable view refuses and an updatable one may accept — the same gesture behaving three ways for one kind of relation. The GridSource extraction (ADR #135, #330) made that inconsistency explicit, and raising it with Alex settled the rule: what a relation structurally cannot do is ours to hide; what the person is not allowed to do is theirs to see.

## Consequences

- `lib/grid/gridSource.ts`: `Capability<Ops>` has four states; `reasonOf` returns `null` for `unsupported` and `pending`, so neither is explained.
- `lib/grid/useTableSource.ts`: on a view, `insert` and `duplicate` are `unsupported`; `insertAvailability` no longer knows views (its `view` kind and the `dataGrid.insertBlocked.view` string are gone).
- `lib/grid/pastePlan.ts`: `canInsert: boolean` became `newRows: "allowed" | "policy" | "view"` — one field, so a flag and its reason cannot disagree — and a view's overflow is skipped with `dataGrid.paste.reason.view`, never with the policy's sentence.
- Policy locks keep ADR #96's rule unchanged: a `blocked` gesture is still shown disabled with its reason. A new reason for unavailability has to be classified as one or the other; "it can never happen on this relation" is the only one that hides.
- **Updatable views** (PostgreSQL, MySQL and SQL Server can insert through a simple view) lose the grid's Duplicate, which could have worked on them. Accepted: the grid already refused Insert on every view, telling them apart would mean asking each engine whether a view is updatable, and an `INSERT` from the SQL editor still reaches them.
- Undoing this — showing a structurally impossible gesture again, or hiding a policy-blocked one — needs a new ADR that supersedes this one.
