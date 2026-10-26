//! Locking the app when the operating system's session locks (ADR #119).
//!
//! Someone who presses Win+L before walking away has already said what they
//! want; making them also lock HuginnDB, or wait out its idle timeout, leaves
//! the gap the app lock exists to close — an unlocked HuginnDB behind a locked
//! Windows session is one password away for whoever knows *that* password (a
//! colleague, IT). So when the session locks, so does the app.
//!
//! - **Windows:** a message-only window on its own thread, registered with
//!   `WTSRegisterSessionNotification`. `WTS_SESSION_LOCK` (Win+L, the screen
//!   saver's lock, a policy) and a console or Remote Desktop *disconnect* both
//!   lock: closing an RDP client leaves the session running and unlocked,
//!   which is the same walk-away in another shape.
//! - **Linux:** logind over D-Bus. The session's `LockedHint` turning true is
//!   what GNOME, KDE and most lockers set; the `Lock` signal is what
//!   `loginctl lock-session` sends. Either locks.
//! - **macOS:** nothing yet; the platform is not a target.
//!
//! Each watcher only reports the event. Whether to act — the preference is on
//! and the vault is open — is decided in one place, [`on_event`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use crate::state::AppState;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Whether a watcher is running in this process. A system without one (macOS,
/// a Linux machine without logind) reports `false`, and Settings says so.
static WATCHING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    /// The session locked.
    Locked,
    /// The session lost its console or its Remote Desktop client.
    Disconnected,
}

/// Whether the session lock is being watched on this machine.
pub fn watching() -> bool {
    WATCHING.load(Ordering::SeqCst)
}

/// Start watching. Called once from `setup`.
pub fn spawn(app: AppHandle) {
    if APP.set(app).is_err() {
        return;
    }
    platform::spawn();
}

/// The one decision: lock when the user wants it and there is something open
/// to lock. A session event while the lock is off, or already locked, does
/// nothing.
fn should_lock(with_session: bool, vault_open: bool) -> bool {
    with_session && vault_open
}

fn on_event(event: SessionEvent) {
    let Some(app) = APP.get() else { return };
    let state = app.state::<AppState>();
    let chosen = state.prefs.read().lock.with_session;
    let with_session = crate::policy::app_lock(state.inner()).with_session(chosen);
    let vault_open = crate::vault::with(|v, env| v.mode(env) == crate::vault::Mode::Unlocked);
    if !should_lock(with_session, vault_open) {
        return;
    }
    eprintln!("[session-watch] {event:?}: locking HuginnDB");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::app_lock::lock_app(&app).await;
    });
}

/// `WM_WTSSESSION_CHANGE`'s `wParam`, as far as the lock cares.
#[cfg_attr(not(windows), allow(dead_code))]
fn event_from_wts(code: u32) -> Option<SessionEvent> {
    // WTS_CONSOLE_DISCONNECT = 2, WTS_REMOTE_DISCONNECT = 4,
    // WTS_SESSION_LOCK = 7. Spelled as numbers so the mapping is testable on
    // every platform; the Windows module asserts they match the constants.
    match code {
        7 => Some(SessionEvent::Locked),
        2 | 4 => Some(SessionEvent::Disconnected),
        _ => None,
    }
}

#[cfg(windows)]
mod platform {
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
        HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_WTSSESSION_CHANGE, WNDCLASSEXW,
        WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK,
    };

    const _: () = assert!(WTS_SESSION_LOCK == 7);
    const _: () = assert!(WTS_CONSOLE_DISCONNECT == 2);
    const _: () = assert!(WTS_REMOTE_DISCONNECT == 4);

    pub fn spawn() {
        let started = std::thread::Builder::new()
            .name("session-watch".into())
            .spawn(|| {
                if let Err(e) = run() {
                    super::WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
                    eprintln!("[session-watch] not watching the Windows session: {e}");
                }
            });
        if let Err(e) = started {
            eprintln!("[session-watch] could not start: {e}");
        }
    }

    /// A message-only window: never shown, no taskbar entry, and the one
    /// thing `WTSRegisterSessionNotification` needs to deliver
    /// `WM_WTSSESSION_CHANGE`. On its own thread with its own message loop,
    /// so nothing here depends on Tauri's event loop or its windows.
    fn run() -> windows::core::Result<()> {
        unsafe {
            let instance = GetModuleHandleW(None)?;
            let class = w!("HuginnDBSessionWatch");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                lpszClassName: class,
                ..Default::default()
            };
            if RegisterClassExW(&wc) == 0 {
                return Err(windows::core::Error::from_win32());
            }
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            )?;
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)?;
            super::WATCHING.store(true, std::sync::atomic::Ordering::SeqCst);
            let mut msg = MSG::default();
            // 0 is WM_QUIT and -1 an error; either ends the loop.
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_WTSSESSION_CHANGE {
            if let Some(event) = super::event_from_wts(wparam.0 as u32) {
                super::on_event(event);
            }
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::OwnedObjectPath;

    const LOGIN1: &str = "org.freedesktop.login1";

    pub fn spawn() {
        let started = std::thread::Builder::new()
            .name("session-watch".into())
            .spawn(|| {
                if let Err(e) = run() {
                    super::WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
                    eprintln!("[session-watch] not watching the logind session: {e}");
                }
            });
        if let Err(e) = started {
            eprintln!("[session-watch] could not start: {e}");
        }
    }

    /// This process's logind session: the one it was started in, or the
    /// caller's "auto" session when it was started outside one (a systemd
    /// user service).
    fn session(conn: &Connection) -> zbus::Result<Proxy<'static>> {
        let manager = Proxy::new(
            conn,
            LOGIN1,
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )?;
        let path: OwnedObjectPath = match manager.call("GetSessionByPID", &(std::process::id(),)) {
            Ok(path) => path,
            Err(_) => OwnedObjectPath::try_from("/org/freedesktop/login1/session/auto")?,
        };
        Proxy::new(conn, LOGIN1, path, "org.freedesktop.login1.Session")
    }

    fn run() -> zbus::Result<()> {
        let conn = Connection::system()?;
        let hint = session(&conn)?;
        let signal = session(&conn)?;
        // `loginctl lock-session` and some lockers send the `Lock` signal;
        // GNOME and KDE set `LockedHint`. One thread for each stream.
        std::thread::Builder::new()
            .name("session-watch-lock".into())
            .spawn(move || match signal.receive_signal("Lock") {
                Ok(stream) => {
                    for _ in stream {
                        super::on_event(super::SessionEvent::Locked);
                    }
                }
                Err(e) => eprintln!("[session-watch] no logind Lock signal: {e}"),
            })
            .map_err(|e| zbus::Error::Failure(e.to_string()))?;
        super::WATCHING.store(true, std::sync::atomic::Ordering::SeqCst);
        for change in hint.receive_property_changed::<bool>("LockedHint") {
            if change.get().unwrap_or(false) {
                super::on_event(super::SessionEvent::Locked);
            }
        }
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    pub fn spawn() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_on_session_lock_and_on_disconnect_only() {
        assert_eq!(event_from_wts(7), Some(SessionEvent::Locked));
        assert_eq!(event_from_wts(2), Some(SessionEvent::Disconnected));
        assert_eq!(event_from_wts(4), Some(SessionEvent::Disconnected));
        // Unlock, logon, connect, remote control: nothing to do.
        for code in [1, 3, 5, 6, 8, 9] {
            assert_eq!(event_from_wts(code), None, "code {code}");
        }
    }

    #[test]
    fn locks_only_when_wanted_and_open() {
        assert!(should_lock(true, true));
        assert!(!should_lock(false, true), "the preference is off");
        assert!(
            !should_lock(true, false),
            "locked already, or the lock is off"
        );
    }
}
