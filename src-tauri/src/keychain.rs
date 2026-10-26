//! OS-keychain integration.
//!
//! Wraps the [`keyring`] crate behind a small, app-specific API so the rest
//! of the codebase never has to know which native keystore is in use.
//! On Windows the backend is the Credential Manager; on Linux the freedesktop
//! Secret Service (libsecret/gnome-keyring/KWallet); on macOS the Keychain.
//!
//! Connection passwords are stored under a single service (`SERVICE`) keyed
//! by a per-profile "account" string. The account is derived by the caller
//! via [`crate::state::ConnectionProfile::keyring_account`].
//!
//! With the app lock on (`crate::vault`), the same accounts live in the
//! encrypted vault instead, and these functions route there; see ADR #118.

use crate::error::{AppError, AppResult};

/// Service identifier registered with the OS keychain.
///
/// All HuginnDB credentials share this service so they show up grouped in
/// platform credential managers and can be cleanly removed if a user
/// uninstalls the application.
///
/// Intentionally **not** build-aware (unlike [`crate::app_identity::APP_DIR`],
/// which isolates the on-disk state of a canary build): a canary shares this
/// service with the stable install on purpose, so it can dogfood against the
/// production connection passwords without the user re-entering them. See the
/// `crate::app_identity` module docs.
pub const SERVICE: &str = "io.huginndb.app";

/// The service a debug build sandboxed with
/// `crate::app_identity::LOCK_SANDBOX_ENV` uses instead of [`SERVICE`].
#[cfg(debug_assertions)]
const SANDBOX_SERVICE: &str = "io.huginndb.lock-sandbox";

fn service() -> &'static str {
    #[cfg(debug_assertions)]
    if crate::app_identity::lock_sandboxed() {
        return SANDBOX_SERVICE;
    }
    SERVICE
}

/// The OS keychain itself, beneath the app lock.
///
/// Only [`crate::vault`] calls these. Everything else goes through the
/// functions below, which ask the vault where a secret lives: with the app
/// lock on, the keychain no longer holds them and these must not be reached
/// around it (ADR #118).
pub(crate) mod os {
    use crate::error::{AppError, AppResult};
    use keyring::Entry;

    fn entry(account: &str) -> AppResult<Entry> {
        Entry::new(super::service(), account).map_err(AppError::from)
    }

    pub fn set(account: &str, password: &str) -> AppResult<()> {
        entry(account)?.set_password(password)?;
        Ok(())
    }

    pub fn get(account: &str) -> AppResult<Option<String>> {
        match entry(account)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(e)),
        }
    }

    pub fn delete(account: &str) -> AppResult<()> {
        match entry(account)?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e)),
        }
    }
}

/// Persist `password` for `account`. Overwrites any previous value.
///
/// With the app lock on it lands in the vault, never the keychain; locked, it
/// is refused with [`AppError::Locked`].
pub fn set_password(account: &str, password: &str) -> AppResult<()> {
    crate::vault::with(|v, env| v.set(env, account, password))
}

/// Read the password for `account`, returning `Ok(None)` if no entry exists.
///
/// Locked, this is [`AppError::Locked`] — never `Ok(None)`, which callers read
/// as "no password needed" or "ask for one" (and the answer would then be
/// stored around the vault).
pub fn get_password(account: &str) -> AppResult<Option<String>> {
    crate::vault::with(|v, env| v.get(env, account))
}

/// Delete the entry for `account`, succeeding if it didn't exist.
pub fn delete_password(account: &str) -> AppResult<()> {
    crate::vault::with(|v, env| v.delete(env, account))
}

/// Like [`get_password`] but returns a typed error when the entry is absent.
///
/// Useful in flows where a missing password is unambiguously a setup
/// problem rather than an optional state.
pub fn require_password(account: &str) -> AppResult<String> {
    get_password(account)?.ok_or_else(|| AppError::MissingPassword(account.to_string()))
}
