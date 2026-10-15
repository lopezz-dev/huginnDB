---
id: 96
type: adr
status: accepted
date: 2026-09-24
tags: [policy, ui, ux]
triggered_by_external_trap: false
related: [95]
supersedes: []
superseded_by: null
amends: []
---

# ADR #96: A policy lock in the interface is advisory, reads as allowed until answered, and is asked for in batches

Phase 2 of managed policy mirrors in the interface what `commands::guard` already refuses (ADR #95). The backend is the boundary. The interface only decides what a control looks like, so it is built to be cheap and never to be the reason something is refused.

**Decision:** Interface policy locks come from one store and one pure lockFor decision, treat a not-yet-arrived answer as allowed, batch policy_access/policy_relation_access calls per microtask, show locked controls with reasons, and gate tabs where they mount.

**Alternatives rejected:**

- Locking until an answer arrives — rejected because it would flash a lock on every menu on unmanaged machines.
- One query per relation — rejected; batched so a 200-table listing costs one call.
- Showing the reason as a tooltip on a disabled Radix item or Button — not possible because they get pointer-events: none; a second line or a focusable PolicyLockHint wrapper is used.
- Gating each entry point instead of the tab mount — rejected because mount gating covers restored tabs, palette, shortcuts and AI code blocks at once.

## Detail

- **One store, three answers.** `stores/session/policyAccess.ts` caches `policy_access` per connection id (profile or `<parent>::db::<name>` view) and `policy_relation_access` per relation. Every lock goes through `lockFor` in `lib/policy/access.ts`, the one pure decision:
  - pending or broken locks everything;
  - unmanaged, or an answer not yet arrived, locks nothing;
  - a connection the role does not reach locks everything on it;
  - otherwise the connection's upper bound is checked, then the relation's own verbs.
- **An answer not yet arrived reads as allowed.** This is on purpose. On the ordinary machine, which has no policy, the other choice flashes a lock on every menu for one round trip. The cost is that a managed machine can show a control enabled for a frame, and it then fails with the backend's refusal. That is exactly what the backend exists to guarantee.
- **Batched, and never asked when it cannot matter.** A hook that finds its entry missing queues it. One microtask later the queue goes out as one `policy_access` call, plus one `policy_relation_access` per connection, so a listing of 200 tables costs one call, not 200.
  - Relations are not asked about until the connection's answer says it is managed. On an unmanaged machine that means never.
  - An answer to a question asked before `invalidate()` is dropped, using a generation counter. Otherwise a slow answer to the old policy would overwrite the new one.
- **Invalidated on two events.** `huginndb://policy-changed` (from `lib/bridges/policy-bridge.ts`) is emitted by the reload thread when its `Debug` fingerprint changes. `-profiles-changed` also invalidates, because editing a host can move a connection onto another rule. Each webview has its own store, so the policy bridge is mounted in `App`, `DetachedTabWindow` and `PulseWindow`.
- **Locked, not hidden, and the reason is on the control.**
  - A menu item takes `ContextMenuAction`'s `locked` prop. It is disabled, gets a lock, and shows the reason as a second line under the label. A disabled Radix item gets `pointer-events: none`, so a tooltip could never show there.
  - A disabled button is wrapped in `PolicyLockHint`, a focusable `<span>` carrying the tooltip, for the same reason (`Button` has `disabled:pointer-events-none`).
  - Relations the role cannot see are still never listed. The backend filters the listing, and this layer adds nothing there.
- **Tabs are gated where they are mounted.** `PolicyGate` wraps every panel body in `TabbedArea` and `TabBody` in `DetachedTabWindow`, driven by `tabNeed`:
  - query tabs need free SQL, Security needs `monitor`, and a new structure or view needs `ddl`;
  - everything else needs `select` on its relation.
  - Gating the mount rather than each entry point is what covers tabs restored by `hydrateTabState`, the palette, the shortcut and an AI code block, all at once. `openQueryTab` is deliberately unchanged, so a locked query tab still opens and says why.
- **The grid drops what the verb forbids and says so once.** `editable`, `onInsertRow` and `onDuplicateRow` (INSERT), `onDeleteRow` and `onBulkDelete` (DELETE), and bulk update (UPDATE) are withheld per verb. The grid shows no disabled cell editor, so `PolicyVerbNotice` names what is missing in one line above the rows.
- **A restored free expression is kept but not sent.** On SQL the query panel's `raw` is free SQL (`guard::raw_filter`). Under a scoped rule `TableDataTab` keeps it in state, so the panel shows it read-only and it can be removed, but never sends it, since sending it would refuse the whole browse. MongoDB's `raw` is a filter over the one collection and is not locked.
- **The view editor's previews run the body.** `ViewEditorTab` runs `execute_query` / `preview_view_change` on every keystroke. Under a free-SQL lock it shows the reason instead of sending two statements a second that would be refused.
