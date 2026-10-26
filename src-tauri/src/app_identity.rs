//! Build-time app identity for the persistence layer.
//!
//! This module is the single source of truth for the on-disk directory name
//! HuginnDB writes all of its state into (`profiles.json`, `prefs.json`,
//! `tab_state.json`, `known_hosts.json`, the MCP audit log). Every module that
//! resolves a path under the platform config base aliases [`APP_DIR`] from
//! here instead of hardcoding `"HuginnDB"`.
//!
//! ## Why it's build-aware
//!
//! A **canary** build (compiled with `--features canary`, paired with
//! `tauri.canary.conf.json` for a separate bundle identifier and updater feed)
//! points [`APP_DIR`] at a *different* directory so it can be installed and run
//! side-by-side with the stable release. This lets a maintainer dogfood a
//! pre-release — including changes that perform destructive, one-way on-disk
//! migrations (e.g. the tab-state v2→v3 migration, ADR #8) —
//! without ever touching the production install's state. See `docs/CANARY.md`
//! and ADR #26.
//!
//! ## What is deliberately *not* split
//!
//! The OS-keychain service (`crate::keychain::SERVICE`, `io.huginndb.app`) is
//! intentionally shared between the stable and canary builds — it is NOT
//! keyed off the `canary` feature. The whole point of the canary is to test
//! against *real production connection profiles*, so it must be able to read
//! the passwords the stable build already stored. Splitting the keychain too
//! would force the user to re-enter every password in the canary, defeating
//! the purpose. State on disk is isolated; credentials in the keychain are
//! shared, read-only in practice (the canary only writes to the keychain when
//! the user explicitly adds/edits/removes a profile inside it).

/// Directory name, under the platform config base
/// ([`dirs::config_dir`]), that holds every HuginnDB state file.
///
/// - Stable build: `"HuginnDB"`.
/// - Canary build (`--features canary`): `"HuginnDB-Canary"`, fully isolated
///   from the stable install's state.
#[cfg(feature = "canary")]
pub const APP_DIR: &str = "HuginnDB-Canary";

/// See the `canary` variant above.
#[cfg(not(feature = "canary"))]
pub const APP_DIR: &str = "HuginnDB";

/// Directory, under the same config base, that holds the app lock's vault
/// (`vault.json`) — **the same for every build**, canary included.
///
/// The one deliberate exception to [`APP_DIR`], and for the reason
/// `crate::keychain::SERVICE` is one: the vault is where the keychain's
/// entries go while the lock is on. A canary with its own vault would find
/// the shared keychain emptied by the stable build, ask for each password
/// again, and store the answers back in the keychain in the clear. See
/// ADR #118.
pub const KEYSTORE_DIR: &str = "HuginnDB";

/// Set in a **debug** build to keep the app lock's secrets away from the real
/// ones: the vault moves to [`SANDBOX_KEYSTORE_DIR`] and the keychain to
/// `crate::keychain::SANDBOX_SERVICE`. The stable and canary builds share both
/// on purpose (ADR #118), so trying the lock in a dev build without this would
/// move the maintainer's real connection passwords out from under the
/// installed app. Compiled out of release builds.
#[cfg(debug_assertions)]
pub const LOCK_SANDBOX_ENV: &str = "HUGINNDB_LOCK_SANDBOX";

#[cfg(debug_assertions)]
const SANDBOX_KEYSTORE_DIR: &str = "HuginnDB-LockSandbox";

/// Whether this debug build was started with [`LOCK_SANDBOX_ENV`]. Always
/// `false` in a release build.
pub fn lock_sandboxed() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os(LOCK_SANDBOX_ENV).is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// The keystore directory this process uses: [`KEYSTORE_DIR`], unless a
/// debug build is sandboxed.
pub fn keystore_dir() -> &'static str {
    #[cfg(debug_assertions)]
    if lock_sandboxed() {
        return SANDBOX_KEYSTORE_DIR;
    }
    KEYSTORE_DIR
}
