---
id: 8
type: adr
status: accepted
date: 2026-05-20
tags: [state-files, environments, tauri]
triggered_by_external_trap: false
related: [10, 27, 40]
supersedes: []
superseded_by: null
amends: []
---

# ADR #8: tab_state.json is v5 environments, main-window-only

`tab_state.json` holds a list of environments plus a global origins registry, and only the main window ever touches it — guarded by the single-spelling `isMainWindow()` check. Each environment owns launch state (`activeConnections`/`selectedConnectionId`/`activeTabId`) restored in a load-bearing order by `useEnvironments.restoreSession`.

**Decision:** tab_state.json is a v5 list of environments plus a global origins registry, written only by the main window behind the single isMainWindow() guard, with restoreSession doing reconnect, then layout hydration, then focus restore.

**Alternatives rejected:**

- v2 per-window 'workspaces': removed in 1.4.0 in favour of real per-window instances.
- Merging v2 workspaces on load: rejected as a confirmed product decision; all but the active one are discarded.
- Multiple spellings of the main-window check (there were sixteen): replaced by one isMainWindow() because a new writer ends up missing it.
- Duplicating the restore sequence between boot and environment switch: it invites drift, so restoreSession is shared.

## Detail

**`tab_state.json` is v5 — a list of environments (plus a global origins registry, ADR #40), and only the main window ever touches it.** See ADR #27 for the environment layer itself; the rest of this note describes the per-connection state *inside* an environment, which is unchanged. "Workspaces" (v2, shipped 0.5.0–1.3.0) were a stand-in for real per-window instances; 1.4.0 removed them, and the environments introduced in v4 are a different axis, not a revival. A v2 blob discards every workspace except the active one on load (confirmed product decision — no merge semantics); a v1 blob (already flat) is folded, like v3, into a single unnamed environment. `prefs::get_tab_state` / `save_tab_state` / `clear_tab_state` resolve against `active_environment()` / `active_environment_mut()` — still no per-*window* scoping on the backend at all. Secondary windows opened via `open_new_window` ("New window") are ephemeral entirely on the **frontend** side: every writer early-returns unless this is the main window, so a secondary window never calls `getTabState`/`saveTabState` and therefore never touches the file. **That guard has exactly one spelling — `isMainWindow()` in `src/lib/window.ts`** (it had sixteen, including three different comparisons against `getCurrentWindow().label`, which is how it ends up missing from a new writer). If you add a new tab-state-aware command, keep that main-window-only guard — a secondary window silently reading or writing the shared blob would corrupt the main window's session. **Each environment carries main-window-owned fields beyond `connections`:** `internalLayout` (the session workspace geometry, ADR #10) and a `launch: LaunchState` holding `activeConnections` / `selectedConnectionId` / `activeTabId` (the connections live in the main window at last close, the focused connection, and the globally-active tab — persisted on graceful close and opportunistically on connect/disconnect via `persistLaunchState`, all main-window-guarded, read back via `get/save_launch_state`, which answer for the active environment). Those three were top-level in v3; `LaunchState` itself now lives in `tab_state.rs` rather than being declared a second time in `commands/prefs.rs`. The restore sequence lives in **`useEnvironments.restoreSession`** (`src/stores/session/environments.ts`), called both by the `App.tsx` launch effect and by `switchTo` — entering an environment is the same operation whether at boot or on a switch, and duplicating it invites drift. When `reconnectOnLaunch` is on it reads `getLaunchState()` and calls `connect(id)` with no password (falling back to the keychain secret) for each still-existing, not-already-active id; failures are per-connection and never block boot. **Order is load-bearing:** reconnect first (so every reconnected connection's tabs land in `useTabs`), THEN `hydrateWorkspaceLayout()` (ADR #10), THEN restore focus (`setSelectedConnectionId` + `useTabs.setActive`) — the focus restore runs last because `connect()` never sets `selectedConnectionId` itself (the `App.tsx` auto-select effect picks whichever pool opened first, which is nondeterministic under the parallel reconnect).
