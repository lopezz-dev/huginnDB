---
id: 107
type: adr
status: accepted
date: 2026-10-15
tags: [terminal, mongodb, policy]
triggered_by_external_trap: false
related: [63, 96, 97]
supersedes: []
superseded_by: null
amends: []
---

# ADR #107: the terminal's sessions are owned by the component that shows them, and `mongosh` signs in as the open pool

The terminal panel (`crate::terminal`, `components/terminal/`) runs a real PTY per tab — `portable-pty`, ConPTY on Windows and `openpty` elsewhere — rendered by xterm.js in the bottom dock. Its reason to exist is MongoDB: AI tools answer "check this in MongoDB" with `mongosh` scripts (variables, loops, `printjson`), which the query editor's bounded parser (`db::mongo::shell`) refuses by design. Rather than grow that parser into a JavaScript engine, the panel starts the user's own `mongosh`, signed in as the connection. A plain shell (pwsh / Windows PowerShell, `$SHELL` / bash / sh) is the same plumbing with no credential.

**Decision:** A PTY per tab (portable-pty) runs mongosh built from the open pool's effective profile, cached password and tunnel port, passing the URI through the environment and a fixed bootstrap; sessions are owned by the TerminalView component and the backend registry, classified free_sql with all verbs under policy.

**Alternatives rejected:**

- Growing the db::mongo::shell parser into a JavaScript engine — rejected in favour of starting the user's own mongosh.
- Building the mongosh URI from the profile alone — rejected; it signs in as the open pool so nothing dials a server the explorer has not.
- Passing the password on the command line — rejected because arguments are world-readable.
- Passing --quiet — rejected because it would hide mongosh's own telemetry notice.
- A parent effect sweeping orphaned sessions — rejected because it would run after the child opened a session and close it.

## Detail

### `mongosh` signs in as the *open pool*, never from the profile alone
- `terminal_open_mongosh` requires the top-level pool to be open and MongoDB, then builds the URI from `credentials::effective_profile` (a personal database user wins, ADR #97), the password **cached in `session_secrets` by `connect`** (falling back to `resolve_password`), and `ActiveConnections::tunnel_port` — the local end of the pool's own SSH tunnel. So a password typed in the connect dialog and never stored works, and nothing dials a server the explorer has not.
- `mongosh::launch_uri` renders what `db::mongo::open_pool` connects with back into one string: the password is injected only when the URI carries none, `authSource` is added only when absent (case-insensitive), and a tunnel rewrites the host to `127.0.0.1:<port>` with `directConnection=true` and no `replicaSet` — the same topology rule `open_pool` follows. SRV and seed lists cannot ride a tunnel, as for the pool.
- The frontend picks the target with `lib/terminal/target.ts`: the workspace's current connection folded through `parentConnectionId`, opened on the focused tab's `::db::` database. A per-database view id is never sent.

### The password never reaches the command line
Arguments are world-readable on Linux (`/proc/<pid>/cmdline`) and shown by every process monitor; the environment is readable only by the same user. `mongosh` starts as `--nodb --shell --eval <BOOTSTRAP>`; the fixed bootstrap reads `HUGINNDB_MONGOSH_URI` (and `HUGINNDB_MONGOSH_DB`), connects, deletes both from `process.env`, and ends in `void 0` so `--eval` prints nothing above the first prompt. `--quiet` is **not** passed: it would also hide `mongosh`'s own telemetry notice, which is not ours to suppress. Verified against MongoDB 7.0 + `mongosh` 2.13.0 by the `#[ignore]`d `live_mongosh_signs_in_and_never_prints_the_password` (MongoDB 8.0 refuses to start on Linux ≥ 6.19, SERVER-121912, and 8.2 segfaults there — use 7.0 for that test on such a kernel).

### Policy: free text with every verb
`guard::mongosh` asks for `Need::FreeSql(Verbs::ALL)`: inside `mongosh` everything is reachable and nothing typed can be checked, so it is refused under any rule that limits relations (D3) or withholds a write or DDL. Classified `free_sql` in `HUMAN_POLICY`; the plain shell and the session plumbing (`write`/`resize`/`close`) are `none`. The panel's advisory lock checks `freeSql`, `insert`, `update`, `delete`, `ddl` and shows the first reason (ADR #96); the backend refuses regardless.

### Who owns a session
- **The backend registry** (`TerminalRegistry`, managed Tauri state of its own) holds writer, master and killer per session id, tagged with the window and, for `mongosh`, the connection. Sessions are closed with their window (`WindowEvent::Destroyed`), with their connection (`close_connection`, so a disconnect never leaves a `mongosh` riding a tunnel that is about to close), and on `RunEvent::Exit`.
- **Two threads per session.** The reader decodes output with `Utf8Stream` (a read that splits a multi-byte character must not become two U+FFFD) and sends the single `Exit` after end-of-stream. The waiter blocks on the child and then *removes the session*, which drops the master: on Windows ConPTY keeps its output pipe open until the pseudoconsole closes, so without the waiter the reader would never see end-of-stream after the shell exits. On Unix the slave is dropped right after spawning for the same reason.
- **The frontend's lifetime is the component's.** `stores/session/terminals.ts` holds descriptors only; `TerminalView` opens the session on mount and closes it on unmount, and every tab stays mounted while hidden. Consequences: `ConsoleDock` passes `keepMounted` while any session exists (`CollapsiblePanel` unmounts children on collapse, which would kill every shell), and the Terminal tab mounts on first show.
- **A reload keeps the window but kills the channels.** The window hook never fires, so the previous page's sessions would run on unseen. `sweepOrphanedSessions` calls `terminal_close_window_sessions` once per page, and every `TerminalView` awaits it before opening — a parent effect would run *after* the child that opened a session and close it.

### The keyboard belongs to the terminal
The dispatcher listens on `window`, so a shell's `Ctrl+B`/`Ctrl+K`/`Ctrl+R` would toggle panels. `TerminalView` stops propagation of every keydown on its host except `PASS_THROUGH` (palette, Preferences, `togglePanelConsole`, `togglePanelTerminal`), matched against the live bindings; for those it also tells xterm not to type them. `Ctrl+R` cannot reload the webview from inside, because xterm cancels the event for keys it handles. Copy/paste are `Ctrl+Shift+C/V` through the native clipboard plugin (ADR #63) — `Ctrl+C` stays the interrupt.

### Modules can be switched off, everywhere at once
`lib/panelModules.ts::moduleEnabled` is the one answer for Pulse (`pulse.enabled`, new, default on — off also idles `pulse::sampler`, keeping the per-connection opt-ins), the AI (`ai.enabled`) and the terminal (`terminal.enabled`, default on). The rail, the View menu, the palette and the shortcut handlers (which return `false` to let the key fall through) all read it; `AppShell` calls `panelLayout.retirePanel` for a module turned off and closes every terminal tab. The commands refuse while the terminal is off, so the switch is an off, not a hidden icon. The bottom dock's `toggleConsole` now *switches* to the console when the terminal is showing rather than closing it; the persisted `consoleOpen` keeps its name, and a v2 layout blob gets `bottomTab: "console"` from the defaults.

## Addendum (2026-10-16)

`mongosh` is still not bundled, and the reason it is not belongs in the alternatives above: the official archive is 63–94 MB (205 MB unpacked on Windows) with its own, faster release cadence. What changed is that a machine without one is no longer sent away: ADR #109 adds an on-demand, checksum-verified download into the app's own data directory, found by `mongosh::locate` after the configured path, `PATH` and the official installers' locations.
