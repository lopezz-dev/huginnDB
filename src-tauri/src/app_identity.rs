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
