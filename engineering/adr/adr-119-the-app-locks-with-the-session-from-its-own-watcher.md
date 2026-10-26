---
id: 119
type: adr
status: accepted
date: 2026-10-26
tags: [security, windows, linux]
triggered_by_external_trap: false
related: [118]
supersedes: []
superseded_by: null
amends: []
---

# ADR #119: the app locks with the operating system's session, watched from a thread of its own, and a disconnect counts as a lock

Phase 3 of the app lock (ADR #118). When the operating system's session locks, HuginnDB locks too. On Windows a message-only window, on its own thread, is registered with `WTSRegisterSessionNotification`; on Linux the same is done with logind over D-Bus. On Windows a console or Remote Desktop *disconnect* also locks. Each watcher only reports the event, and one function decides whether to act: `LockPrefs::with_session` (on by default) and an open vault.

**Decision:** `session_watch` runs a platform watcher on a dedicated thread. It maps `WTS_SESSION_LOCK`, `WTS_CONSOLE_DISCONNECT` and `WTS_REMOTE_DISCONNECT` (Windows), or logind's `LockedHint` and `Lock` (Linux), to a session event, and calls `app_lock::lock_app` through `on_event` when the preference is on and the vault is open.

**Alternatives rejected:**

- **Subclassing the main window to catch `WM_WTSSESSION_CHANGE`.** Tauri/tao own that window procedure and expose no hook for arbitrary messages. Subclassing it would tie the lock to the one window a lock destroys and recreates the content of. A message-only window on its own thread depends on nothing Tauri does.
- **Polling `WTSQuerySessionInformation` for `WTS_SESSIONSTATE_LOCK`.**
  - It locks seconds late, on every machine, all day.
  - The flag reads inverted on Windows 7, a trap we do not need.
  - Events cost nothing between locks.
- **Locking only on `WTS_SESSION_LOCK`.** Closing a Remote Desktop client leaves the session running and *unlocked* on the server. That is the walk-away the lock exists for, in another shape, and the maintainer works this way. A disconnect locks too.
- **A new crate for Linux.** `zbus` 5 is already in the tree, with its default features (blocking API included), through `tauri-plugin-single-instance`. Declaring it for Linux adds nothing.
- **Watching only logind's `Lock` signal.** GNOME and KDE lock and set `LockedHint` without that signal being involved. `loginctl lock-session` sends the signal. Both are watched, one thread each.

## Context

ADR #118 locks at startup, after inactivity and with Ctrl+L. A person who presses Win+L before walking away has already said what they want. Making them also lock HuginnDB, or wait out the idle timeout, leaves an unlocked HuginnDB behind a locked Windows session, one password away for whoever knows that password (a colleague, IT).

## Detail

- **Windows.** `RegisterClassExW` + `CreateWindowExW(.., HWND_MESSAGE, ..)` give a window that is never shown and has no taskbar entry. `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` delivers `WM_WTSSESSION_CHANGE` to it, and a `GetMessageW` loop on the same thread runs it. The `windows` 0.61 crate was already declared; this adds the features `Win32_Foundation`, `Win32_Graphics_Gdi` (for `WNDCLASSEXW`), `Win32_System_LibraryLoader`, `Win32_System_RemoteDesktop` and `Win32_UI_WindowsAndMessaging`.
- **Linux.** It uses `GetSessionByPID(own pid)`, falling back to `/org/freedesktop/login1/session/auto` for a process started outside a session. One thread iterates `receive_property_changed::<bool>("LockedHint")` and another `receive_signal("Lock")`.
- **macOS:** no watcher. The platform is not a target.
- **The decision is pure.** `should_lock(with_session, vault_open)` and `event_from_wts(code)` are tested on every platform. The WTS codes are spelled as numbers there, and compile-time asserts in the Windows module pin them to the crate's constants.
- **Settings shows when it cannot work.** `LockStatus::session_watch` is `session_watch::watching()`. On a machine with no watcher (macOS, Linux without logind, a failed registration) the "Lock with the session" row is disabled and says so.

## Consequences

- A session event while the lock is off, or already locked, does nothing. That keeps the watcher harmless on every install where nobody turned the lock on.
- `lock_app` runs from a non-UI thread through the async runtime, the same path the idle watcher takes. Nothing here touches a Tauri window.
- The Linux path is compiled by CI (Ubuntu) but was not run by hand when it was written; the maintainer's machine is Windows. Report a desktop where it does not fire.
