//! Build-flavor introspection for the frontend.
//!
//! The React bundle is byte-for-byte identical between the stable and canary
//! builds — the only thing that differs is the Cargo `canary` feature and the
//! Tauri config overlay (`tauri.canary.conf.json`). That means the frontend
//! has no compile-time way to know which flavor it is running inside; it must
//! ask the backend at runtime. This command is that channel.
//!
//! It exists so the UI can make it *unmistakable* that you are in the sandbox
//! canary build (separate, isolated on-disk state — see
//! `crate::app_identity::APP_DIR` and ADR #26) rather than your
//! real stable install, since the two are otherwise visually identical once
//! you are inside the window.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFlavor {
    /// True when compiled with `--features canary` (the sandbox build).
    pub canary: bool,
    /// Human-facing product name for this flavor: `"HuginnDB Canary"` for the
    /// canary build, `"HuginnDB"` otherwise. Mirrors the `productName` in the
    /// active Tauri config so the frontend can render a matching label without
    /// hardcoding the branch.
    pub product_name: &'static str,
    /// The on-disk state directory name this build reads/writes
    /// (`crate::app_identity::APP_DIR`). Surfaced so the sandbox indicator can
    /// tell the user exactly which isolated dir their state lives in.
    pub state_dir: &'static str,
}

/// Report the running build's flavor. Cheap, synchronous, no state — resolved
/// entirely from compile-time `cfg`.
#[tauri::command]
pub fn get_app_flavor() -> AppFlavor {
    AppFlavor {
        canary: cfg!(feature = "canary"),
        product_name: if cfg!(feature = "canary") {
            "HuginnDB Canary"
        } else {
            "HuginnDB"
        },
        state_dir: crate::app_identity::APP_DIR,
    }
}
