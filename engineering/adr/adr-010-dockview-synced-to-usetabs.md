---
id: 10
type: adr
status: accepted
date: 2026-05-27
tags: [dockview, environments, state-files]
triggered_by_external_trap: false
related: [27]
supersedes: []
superseded_by: null
amends: []
---

# ADR #10: The nested workspace dockview is synced from useTabs one way

`TabbedArea`'s inner dockview only flows store → dockview for add/remove. Split/float geometry is persisted once per environment and restored exactly once at launch, strictly after the launch reconnect has populated `useTabs` — running it earlier collapses the layout back to default.

**Decision:** The inner workspace dockview is synced from useTabs one way for add/remove, and its split/float geometry is stored once per environment (Environment.internalLayout) and restored once at launch after the reconnect has populated useTabs.

**Alternatives rejected:**

- A second add/remove path or close affordances that mutate dockview directly (panel.api.close()): removal could feed back on itself.
- Per-connection ConnectionTabState.internalLayout: duplicated the same blob under every connection and made restore order-dependent; now deprecated.
- Restoring geometry inside per-connection hydrateTabState or before the reconnect: the reconciler deletes panels fromJSON just built, collapsing the split to the default layout.

## Detail

**The workspace editor is a *nested* dockview synced to `useTabs`, which stays the source of truth.** `TabbedArea.tsx` hosts an inner `DockviewReact` (separate from the outer Schema/Saved/Workspace/Console dockview in `App.tsx`); each open table/query tab is a panel. The reconciler only flows **store → dockview** for add/remove (a `useEffect` on `tabs` adds missing panels, removes stale ones); the custom tab's X button and middle-click call `useTabs.close`, never `panel.api.close()`, so removal can't feed back on itself. Active-panel sync is bidirectional but idempotent (`onDidActivePanelChange` → `setActive`; an effect mirrors `activeId` → `panel.api.setActive()`, a no-op when already active). Don't add a second add/remove path or make the close affordances mutate dockview directly. Persistence (`persistedTabs.ts`) derives its per-connection snapshot from `useTabs`; **split/float geometry IS persisted** as a raw dockview `toJSON()` blob, captured only when there's >1 group. **That blob is stored ONCE per environment (`Environment.internalLayout`, exposed via `get/save_workspace_layout`, which answer for the active one), not per connection.** It was top-level in v3, before environments existed (ADR #27). The inner dockview is a *single* instance that hosts every open connection's tabs at once, so its geometry is a session artifact, not a per-connection one — the old per-connection `ConnectionTabState.internalLayout` duplicated the same blob under every connection and made restore order-dependent (whichever connection hydrated first won). That field is now deprecated (kept only so old blobs deserialise and so `RawState::into_state` can hoist the most-recently-used legacy blob to the top level once, on first load after upgrading); the frontend never writes it. Geometry is saved (debounced) by `scheduleSaveActive` → `saveWorkspaceLayoutNow` on `onDidLayoutChange`, and restored **once at launch** by `hydrateWorkspaceLayout` (main-window-only, gated on `restoreTabsOnOpen`) — NOT inside per-connection `hydrateTabState` anymore. **`hydrateWorkspaceLayout` MUST run AFTER the launch reconnect has populated `useTabs`** (the `App.tsx` effect calls it post-`Promise.allSettled`), because the reconciler below removes any panel whose tab isn't in `useTabs`: run it against an empty tab store and the reconciler deletes the panels `fromJSON` just built, collapsing the split back to the default tabbed layout (the sandbox bug). After `fromJSON` it prunes panels for tabs that never came back (a connection that failed to reconnect). With `reconnectOnLaunch` off there are no launch tabs, so the layout is not auto-restored — layout restore rides with reconnect by design. On hydrate the blob is handed to `TabbedArea` (`setPendingInternalLayout`) and replayed with `fromJSON` **first** — `fromJSON` is the authoritative panel+geometry rebuild (it recreates panels from the params we stored at `addPanel`), so the store→dockview reconciler then runs as an idempotent convergence pass as each connection hydrates its tabs. `fromJSON` is wrapped in try/catch: on drift it falls back to the default tabbed layout (the old behaviour). The inner dockview API is exposed to `persistedTabs` via the `registerInnerDockviewApi`/`getInnerDockviewApi` singleton in `dockview.ts`, mirroring the outer one.
