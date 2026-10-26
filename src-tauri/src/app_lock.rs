//! The app lock as the desktop app enforces it: which commands may run while
//! locked, what locking tears down, and the idle watcher.
//!
//! The vault (`crate::vault`) is what makes the lock hold — no secret can be
//! read without its key. This module is what keeps everything *else* behind
//! the wall: the connection list, restored tabs, environments, the AI panel,
//! Pulse's history. The interface's wall is only the face of it (ADR #96's
//! rule, applied to the lock): every command goes through [`gate`], and while
//! the app is locked anything not named in [`OPEN_WHILE_LOCKED`] is refused in
//! Rust before its body runs.
//!
//! **Refused by default.** ADR #95's `HUMAN_POLICY` asks every command to say
//! what it needs, and a test fails on one that does not. Here the default is
//! the refusal itself: a command added without a thought for the lock is
//! simply unavailable while locked. Forgetting can make the wall slightly too
//! high, never open a hole in it. See ADR #118.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::AppError;
use crate::state::{AppState, Driver};

/// Emitted to every window whenever the lock's state changes, carrying a
/// [`LockStatus`]. The main window answers a lock by reloading into the wall.
pub const CHANGED_EVENT: &str = "huginndb://lock-changed";

/// The commands that run while the app is locked: what the wall itself needs,
/// and nothing that reaches a database, a secret or restored state.
///
/// `vault_reset` is here on purpose. It destroys the secrets and never reveals
/// one, so the worst it hands a stranger at the wall is an app with no
/// passwords — the same thing deleting the config files would.
///
/// `vault_enable` is for the wall a policy puts up when it requires the lock
/// and there is no vault yet (ADR #120): setting the master password is the
/// only way past it. Behind an ordinary lock it refuses on its own — the lock
/// is already on.
pub const OPEN_WHILE_LOCKED: &[&str] = &[
    "vault_status",
    "vault_unlock",
    "vault_reset",
    "vault_enable",
];

/// Whether the dispatcher refuses. Mirrors `vault::is_locked()`, which reads
/// `vault.json` to answer, so that the check every IPC call makes costs an
/// atomic load rather than a file read. Starts closed: until `setup` has
/// asked the vault, nothing is let through.
static CLOSED: AtomicBool = AtomicBool::new(true);

pub fn gate_closed() -> bool {
    CLOSED.load(Ordering::SeqCst)
}

/// Whether the organization requires the lock and this machine has none yet:
/// the app waits behind the wall until a master password is set.
pub fn setup_required(state: &AppState) -> bool {
    crate::policy::app_lock(state).required
        && crate::vault::with(|v, env| v.mode(env) == crate::vault::Mode::Off)
}

/// Re-read the vault's answer — and the policy's demand — into the gate.
/// Called at startup and after anything that changes either.
pub fn sync_gate(state: &AppState) -> bool {
    let locked = crate::vault::is_locked() || setup_required(state);
    CLOSED.store(locked, Ordering::SeqCst);
    locked
}

/// Whether `command` is refused right now.
pub fn refuses(command: &str) -> bool {
    gate_closed() && !OPEN_WHILE_LOCKED.contains(&command)
}

/// Wrap the app's command handler so it refuses while locked. Applied once,
/// around `generate_handler!`, so no command can be registered outside it.
/// Plugin commands (window controls, the updater, dialogs) are routed by their
/// plugins and never reach it.
pub fn gate<R: Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if refuses(invoke.message.command()) {
            invoke.resolver.reject(AppError::Locked);
            return true;
        }
        handler(invoke)
    }
}

/// What the wall and Settings need to know. No secret, and nothing from
/// behind the wall: the interface language is here so the wall can speak it
/// without opening `get_preferences`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    /// `off`, `locked`, `unlocked`, `broken`, or `setup`: the organization
    /// requires the lock and there is no vault yet.
    pub mode: &'static str,
    /// Why the vault is broken, when it is.
    pub problem: Option<String>,
    /// The wait owed before the next unlock attempt.
    pub retry_after_ms: u64,
    pub idle_minutes: u32,
    /// Whether this machine reports its session locking (Windows, Linux with
    /// logind). Settings disables the "lock with the session" row without it.
    pub session_watch: bool,
    pub language: String,
    pub min_password_chars: usize,
    /// What the organization's policy asks of the lock (ADR #120).
    pub policy: crate::policy::LockPolicy,
}

pub fn status(state: &AppState) -> LockStatus {
    let (mode, retry_after) =
        crate::vault::with(|v, env| (v.mode(env), v.retry_after(Instant::now())));
    let policy = crate::policy::app_lock(state);
    let (mode, problem) = match mode {
        crate::vault::Mode::Off if policy.required => ("setup", None),
        crate::vault::Mode::Off => ("off", None),
        crate::vault::Mode::Locked => ("locked", None),
        crate::vault::Mode::Unlocked => ("unlocked", None),
        crate::vault::Mode::Broken(why) => ("broken", Some(why)),
    };
    let prefs = state.prefs.read();
    LockStatus {
        mode,
        problem,
        retry_after_ms: u64::try_from(retry_after.as_millis()).unwrap_or(u64::MAX),
        idle_minutes: policy.idle_minutes(prefs.lock.idle_minutes),
        session_watch: crate::session_watch::watching(),
        language: prefs.ui.language.clone(),
        min_password_chars: crate::vault::MIN_PASSWORD_CHARS,
        policy,
    }
}

/// Tell every window, and bring the MCP bridge in line: it is served only
/// while the app is unlocked, so a sidecar that finds no bridge falls back to
/// its own path, which refuses for the same reason (`mcp::Huginn::require_open`).
pub async fn announce(app: &AppHandle) {
    sync_gate(app.state::<AppState>().inner());
    crate::bridge::server::reconcile(app).await;
    let _ = app.emit(CHANGED_EVENT, status(app.state::<AppState>().inner()));
}

/// Lock now: drop the vault key, then take down everything that was opened
/// with it. Nothing reconnects on unlock except what the person opens.
pub async fn lock_app(app: &AppHandle) {
    crate::vault::with(|v, _| v.lock());
    CLOSED.store(true, Ordering::SeqCst);

    // Every window but the main one closes; the main one reloads into the
    // wall when it hears `CHANGED_EVENT`, which also empties the AI panel's
    // conversation (memory-only by design, spec decision D7).
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.destroy();
        }
    }
    app.state::<crate::terminal::TerminalRegistry>().close_all();

    let state = app.state::<AppState>();
    let state = state.inner();
    for cancel in state.ai_turns.read().values() {
        cancel.notify_waiters();
    }
    // Pools carry their SSH tunnels and keepalives with them (ADR #104), so
    // closing them stops both. Pulse's sampler only samples open connections.
    crate::commands::connection::close_all_pools(state, Duration::from_secs(3)).await;
    state.session_secrets.write().clear();
    *state.pending_cli_connect.write() = None;
    state.window_startup_intents.write().clear();
    state.detached_tab_intents.write().clear();
    state.pulse_window_intents.write().clear();

    announce(app).await;
}

/// Lock the app after `LockPrefs::idle_minutes` without activity in any
/// window. In the backend so the wall is not something a frozen or closed
/// window can keep down; the interface only reports activity
/// (`vault_activity`, throttled).
pub fn spawn_idle_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            if gate_closed() {
                continue;
            }
            // The person's choice, capped by the organization's (ADR #120).
            let state = app.state::<AppState>();
            let chosen = state.prefs.read().lock.idle_minutes;
            let minutes = crate::policy::app_lock(state.inner()).idle_minutes(chosen);
            if crate::vault::with(|v, _| v.idle_expired(Instant::now(), minutes)) {
                lock_app(&app).await;
            }
        }
    });
}

/// Every keychain account this app knows to hold a secret: what turning the
/// lock on moves into the vault.
///
/// The keychain cannot be listed, so this is reconstructed from what refers
/// to it — the same accounts `delete_profile`, `origins` and the AI settings
/// compute. A secret under an account nothing refers to any more (a crash, a
/// pre-1.0 build) is not moved, and is said so in ADR #118: nothing in the app
/// can read it either.
pub fn known_accounts(state: &AppState) -> Vec<String> {
    let mut accounts = Vec::new();
    for profile in state.profiles.read().iter() {
        if !matches!(profile.driver, Driver::Sqlite) {
            accounts.push(profile.keyring_account());
            let effective = crate::credentials::effective_profile(&state.policy, profile);
            accounts.push(effective.keyring_account());
        }
        if let Some(ssh) = profile.ssh_keyring_account() {
            accounts.push(ssh);
        }
    }
    for origin in &state.tab_state.read().origins {
        accounts.push(crate::commands::origins::passphrase_account(&origin.id));
    }
    let base_url = state.prefs.read().ai.base_url.clone();
    if let Ok(url) = reqwest::Url::parse(&base_url) {
        accounts.push(crate::ai::secrets::key_account(&url));
    }
    accounts.push(crate::commands::feedback::GITHUB_PAT_ACCOUNT.to_string());
    accounts.sort();
    accounts.dedup();
    accounts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::guard::tests::registered;
    use crate::commands::guard::HUMAN_POLICY;

    /// One test, not three: [`CLOSED`] is process-wide, and tests run in
    /// parallel.
    #[test]
    fn locked_only_the_wall_runs_and_unlocked_nothing_is_refused() {
        let registered = registered();
        let name = |qualified: &str| qualified.split_once("::").unwrap().1.to_string();

        CLOSED.store(true, Ordering::SeqCst);
        let mut open = Vec::new();
        for command in &registered {
            if !refuses(&name(command)) {
                open.push(name(command));
            }
        }
        open.sort();
        let mut expected: Vec<String> = OPEN_WHILE_LOCKED.iter().map(|s| s.to_string()).collect();
        expected.sort();
        assert_eq!(open, expected, "locked, exactly the wall's commands run");
        assert!(
            refuses("a_command_nobody_has_written_yet"),
            "unknown means refused"
        );

        CLOSED.store(false, Ordering::SeqCst);
        for command in &registered {
            assert!(!refuses(&name(command)), "{command} refused while unlocked");
        }
        CLOSED.store(true, Ordering::SeqCst);
    }

    #[test]
    fn every_command_open_while_locked_is_registered_and_touches_no_database() {
        let registered = registered();
        for open in OPEN_WHILE_LOCKED {
            let qualified = registered
                .iter()
                .find(|c| c.split_once("::").map(|(_, n)| n) == Some(*open))
                .unwrap_or_else(|| panic!("{open} is open while locked but not registered"));
            let category = HUMAN_POLICY
                .iter()
                .find(|(n, _)| n == qualified)
                .map(|(_, c)| *c);
            assert_eq!(
                category,
                Some("none"),
                "{qualified} runs while locked, so it must touch no database"
            );
        }
    }
}
