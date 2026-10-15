---
id: 27
type: adr
status: accepted
date: 2026-07-29
tags: [environments, state-files]
triggered_by_external_trap: false
related: [8, 10, 40]
supersedes: []
superseded_by: null
amends: []
---

# ADR #27: An environment scopes session state, not which connections exist

`tab_state.json` v4+ holds a list of `Environment`s, each owning its own `connections` map, layout and launch state, resolved via `active_environment_mut()`. This is a distinct identity axis, deliberately not a revival of the deleted v2 "workspaces."

**Decision:** tab_state.json holds a list of Environments each owning connections map, internalLayout and launch state, while profiles.json stays one global list; the environment only tags which subset is in play.

**Alternatives rejected:**

- Treating environments as a revival of the v2 workspaces: those stood in for per-window instances, whereas an environment is an identity.
- A global MAX_REMEMBERED_CONNECTIONS cap: a busy environment would evict a quiet one's tabs.
- Writing a literal default environment name in the backend: freezes one language into user data.
- Keeping visible_databases only on the global profile: narrowing in one environment leaked into others.
- Cloning the profile per environment: duplicates credentials and keychain entries and opens a second pool against one server.
- Gating the view-filter restore behind reconnectOnLaunch: left the previous environment's filters on screen.

## Detail

**An "environment" scopes session state, not connections — and switching one has a load-bearing order.** `tab_state.json` (v4 introduced this; v5 is current — see ADR #40) holds a list of `Environment`s (`tab_state.rs`) plus `activeEnvironmentId`; each owns a `connections` map, an `internalLayout` and a `launch: LaunchState`. Every session-state command (`get/save_tab_state`, `get/save_workspace_layout`, `get/save_launch_state`) resolves against the active one, so their signatures never changed — which is why the frontend kept working across the schema bump. **This is deliberately NOT a revival of the v2 workspaces 1.4.0 deleted:** those stood in for real per-window instances, whereas an environment is an identity (which connections are in play, and where they came from). Say so in review if someone calls it a regression.
    - **Connections are *not* owned by an environment.** `profiles.json` stays one global list; the environment tags which subset is in play. Deleting one discards tabs and geometry only — never a profile or a keychain entry. Conversely, deleting a *profile* sweeps **every** environment's `connections` and `launch` lists (`clear_tab_state` + `commands::connection::delete_profile`), because an entry surviving elsewhere would come back as a tab pointing at a connection that no longer exists.
    - **`active_environment_mut()` is the only way to reach the active environment for writing.** It creates one when the list is empty and *re-anchors* a dangling `activeEnvironmentId` rather than just working around it — leave the id dangling and the fallback re-runs on every call, potentially landing on a different environment each time. `prune()` applies `MAX_REMEMBERED_CONNECTIONS` **per environment**: a global cap would let a busy environment evict a quiet one's tabs.
    - **The migrated/initial environment is created with an EMPTY `name`.** Empty means "never named by the user" and the frontend renders `t("environments.defaultName")` via `environmentLabel()`. Don't write a literal there — the backend picking display copy would freeze one language into the user's data permanently. Same reason the backend never interprets `color`/`icon`.
    - **`useEnvironments.switchTo` order is load-bearing** (`src/stores/session/environments.ts`): flush the outgoing session while the backend still points at it → disconnect every pool → **re-save the outgoing `launch` state from the set captured *before* the teardown** → `set_active_environment` → clear the tab store → `restoreSession()`. That third step is not redundant: `useConnections.disconnect` persists the launch state as it goes, so after the loop the outgoing environment believes nothing was open and returning to it would restore an empty session. The last write wins, and it has to be ours.
    - **A per-connection *view* filter is environment state, not profile state — but the profile stays its default.** `visible_databases` ("Bases de datos a mostrar") lived only on the global `ConnectionProfile`, so narrowing a shared test server to one client's database from inside a "Producción" environment also narrowed it in the environment that server belongs to (the same bug `visible_connections` had one level up, before it moved onto `LaunchState`). It is now resolved in two layers by `useVisibleDatabases` (`SchemaExplorer.tsx`): **`LaunchState.databaseVisibility[connectionId]` if the key is present, otherwise `profile.visible_databases`.** The map's value is itself nullable — a stored `null` means "show all *here*", which is the only way an environment can widen a subset the profile narrows, so never collapse `undefined` (no override) and `null` (override to all) into one thing. The profile keeps the field because it is what travels through export/import and shared origins; the picker writes the override by default and only touches the profile when the user picks "all environments" (in which case it also *clears* the override, or the profile-wide choice would be invisible where they made it). Don't "simplify" this by cloning the profile per environment: that duplicates credentials and keychain entries, opens a second pool against one server, and breaks the bullet above. Unlike the id lists, `delete_profile` sweeps this map — a keyed payload is worth reaping.
    - **The three view filters in `restoreSession` are restored *before* the `reconnectOnLaunch` gate**, everything else after it. They describe how the environment looks (folds, `visibleConnections`, `databaseVisibility`), not what it reopens; `persistLaunchState` writes them regardless of the preference and `switchTo` clears them on the way out, so gating their restore left the *previous* environment's filters on screen with reconnect off. Keep new view-only state on that side of the gate and anything that opens a pool on the other.
    - `restoreSession()` is shared with the `App.tsx` launch effect on purpose — entering an environment is one operation, and its ordering (reconnect → layout → focus, ADRs #8 and #10) is too subtle to maintain in two places.
