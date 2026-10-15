---
id: 104
type: adr
status: accepted
date: 2026-10-06
tags: [tauri, ssh]
triggered_by_external_trap: false
related: [67]
supersedes: []
superseded_by: null
amends: []
---

# ADR #104: a connection belongs to the windows holding it, and the app closes every pool on the way out

All windows share one process and one `ActiveConnections` map, so a window closing released nothing. A connection opened in a secondary window outlived it: no other window lists it, the reaper never closes a top-level pool a person opened, and the keepalive kept a socket (and any SSH tunnel) open until the app exited. `ActivePool::holders` records which windows are using a connection, and `WindowEvent::Destroyed` closes the ones left with none. `RunEvent::Exit` closes every pool, gracefully and with a time limit, instead of letting the process drop them. `AppState::open_lock` makes opening one id single-flight.

**Decision:** ActivePool::holders records which windows use a connection, WindowEvent::Destroyed closes pools left with none, RunEvent::Exit closes every pool with a 3 s cap, and AppState::open_lock makes opening one id single-flight.

**Alternatives rejected:**

- Letting the process drop pools on exit — rejected because behind an SSH tunnel or pooler the server keeps counting the sessions.
- Treating the main window as special — rejected; it is released like any other.
- Removing per-id open locks after use — rejected because doing so safely would need to know nobody is waiting.

## Detail

**Same shape as ADR #67, for windows instead of the bridge.** The reaper's exemption for top-level pools rests on two claims: the user opened the connection, and the UI shows it as connected. A connection from a window that has since closed fails the second claim. The frontend does not adopt another window's connections (issue #50), so the surviving windows never list it, and `release_idle_pools` skips top-level pools by contract. Restarting the app was the only way to release it.

- **Who holds a connection.**
  - `connect_inner` adds `window_label` on insert, on the reuse path, and when it adopts a bridge pool.
  - `open_tab_window` and `open_pulse_window` add the new window's label for the connection it shows. These windows never call `connect`; they borrow the pool their source window opened. Without this, closing the source window would close the pool under a detached tab that is still open.
  - `hold` folds a `::db::` id to its parent, because a window showing a database is using the connection the database lives on.
- **What releases one.** `ActiveConnections::release_window` removes the label from every pool. It returns only the top-level `User` pools that *lost* their last holder in that call. A pool that never had a holder (one opened headless, from the bridge, or by a path that does not know its window) is not any window's to close, and an empty set never triggers a close by itself. Bridge pools stay with the reaper's TTL.
- **The main window is not special.** It is released like any other. If a secondary window still holds a connection, closing the main window keeps it open.
- **One teardown.** `close_connection` is the body `disconnect` always had: children first while the parent's tunnel is up, then the parent, then the cached secrets, then `connection-closed`. `disconnect` and `release_window` both call it, so they cannot drift apart. The Console line carries the reason.
- **Exit closes everything, within a time limit.** Before this, `tauri::Builder::run` had no `RunEvent` callback and the pools died with the process. That is fine on a LAN, where the server sees the FIN. Behind an SSH tunnel or a pooler, the server only learns when its own timeouts fire, so those sessions keep counting against its limit after HuginnDB is gone.
  - `close_all_pools` drains the map with views first and closes them concurrently, each one bounded by `CLOSE_TIMEOUT`.
  - The whole sweep is capped at three seconds: a quit that hangs on a dead server is worse than sessions the server will reap on its own.
- **Single-flight opening.**
  - `connect_inner` and `open_database_view_inner` used to check the map, await a connect, then insert, with nothing held across the await. Two openers of one id could both find it absent and both dial: a window and the bridge, two sidecars, or the tree's expand effect and a context-menu action.
  - `ActiveConnections::insert` then replaced the first pool with a bare `Drop`, so the server briefly saw both.
  - Each opener now takes `open_lock(id)` before the check, so the second one waits and then finds the first one's pool. The locks are never removed: there is one per id ever opened, which costs bytes, and removing one safely would need to know that nobody is waiting on it.
