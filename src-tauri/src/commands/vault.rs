//! The app lock's commands: status, unlocking, and turning the lock on, off or
//! over (ADR #118).
//!
//! The master password crosses the IPC boundary only to be checked or sealed
//! here, and is never stored or echoed. Argon2 takes a third of a second, so
//! every command that derives a key runs on the blocking pool.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_lock::{self, LockStatus};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::vault::{self, Unlock};

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Vault(format!("the vault task failed: {e}")))?
}

/// Where the lock stands. Open while locked: it is what the wall asks first.
///
/// Re-reads the vault into the gate first. The vault can change under a
/// running app (another build sharing it, files deleted), and the answer must
/// not say "off" while the gate still refuses — or the reverse. Opening the
/// gate here grants nothing a restart would not.
#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> LockStatus {
    app_lock::sync_gate(state.inner());
    app_lock::status(state.inner())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockAnswer {
    pub opened: bool,
    /// Consecutive wrong passwords so far.
    pub failures: u32,
    /// The wait before another attempt is even considered.
    pub retry_after_ms: u64,
}

fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Unlock with the master password. Open while locked. Nothing reconnects:
/// the interface mounts afresh and opens only what the person opens.
#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: String) -> AppResult<UnlockAnswer> {
    let answer = blocking(move || vault::unlock(&password)).await?;
    let answer = match answer {
        Unlock::Opened => UnlockAnswer {
            opened: true,
            failures: 0,
            retry_after_ms: 0,
        },
        Unlock::Wrong {
            failures,
            retry_after,
        } => UnlockAnswer {
            opened: false,
            failures,
            retry_after_ms: millis(retry_after),
        },
        Unlock::TooSoon { retry_after } => UnlockAnswer {
            opened: false,
            failures: 0,
            retry_after_ms: millis(retry_after),
        },
    };
    if answer.opened {
        app_lock::announce(&app).await;
    }
    Ok(answer)
}

/// Lock now — the shortcut, the menu, the idle watcher's own path.
#[tauri::command]
pub async fn vault_lock(app: AppHandle) -> AppResult<()> {
    if !crate::vault::with(|v, env| v.mode(env) == vault::Mode::Unlocked) {
        return Err(AppError::InvalidInput("the app lock is not on".into()));
    }
    app_lock::lock_app(&app).await;
    Ok(())
}

/// Count activity toward the idle timeout. The interface calls it at most
/// every thirty seconds, from any window.
#[tauri::command]
pub fn vault_activity() {
    crate::vault::with(|v, _| v.touch(std::time::Instant::now()));
}

/// Turn the lock on, moving every secret out of the keychain. Returns how many
/// moved. The interface has already shown the "a forgotten password loses the
/// secrets" confirmation; this is where it becomes true.
#[tauri::command]
pub async fn vault_enable(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> AppResult<usize> {
    let accounts = app_lock::known_accounts(state.inner());
    let moved = blocking(move || vault::with(|v, env| v.enable(env, &password, &accounts))).await?;
    app_lock::announce(&app).await;
    Ok(moved)
}

/// Turn the lock off, putting every secret back in the keychain as it was.
/// Asks for the master password again: an unlocked app left unattended must
/// not be one click from undoing the lock.
#[tauri::command]
pub async fn vault_disable(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> AppResult<usize> {
    // The organization may require the lock; a policy that cannot be read
    // keeps the lock that is there (ADR #120). Settings shows the switch
    // locked, but the refusal is here.
    let policy = crate::policy::app_lock(state.inner());
    if !policy.may_disable {
        return Err(AppError::InvalidInput(match policy.role {
            Some(role) => format!(
                "your organization's HuginnDB policy requires the app lock for the role \
                 \"{role}\" (appLock.required), so it cannot be turned off"
            ),
            None => "your organization's HuginnDB policy cannot be read right now, so the app \
                     lock stays on until it can"
                .into(),
        }));
    }
    let moved = blocking(move || vault::with(|v, env| v.disable(env, &password))).await?;
    app_lock::announce(&app).await;
    Ok(moved)
}

#[tauri::command]
pub async fn vault_change_password(current: String, next: String) -> AppResult<()> {
    blocking(move || vault::with(|v, env| v.change_password(env, &current, &next))).await
}

/// Forget every secret and start a new, empty vault under `password`. Open
/// while locked — it is the way out of a forgotten password — because it
/// reveals nothing: the connections stay and ask for their passwords again.
#[tauri::command]
pub async fn vault_reset(app: AppHandle, password: String) -> AppResult<()> {
    blocking(move || vault::with(|v, env| v.reset(env, &password))).await?;
    app_lock::announce(&app).await;
    Ok(())
}
