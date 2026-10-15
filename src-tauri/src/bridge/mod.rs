//! Local IPC bridge between the desktop app and the `huginndb-mcp` sidecar.
//!
//! # Why
//!
//! The sidecar is a separate OS process with its own `AppState` and its own
//! pools, and there is **one sidecar per MCP client**. A developer running the
//! desktop app plus Claude Code plus Claude Desktop therefore has three
//! independent connection budgets against the same database, none of which can
//! see the others — the last remaining way HuginnDB's footprint could surprise
//! someone after the per-server budgets landed ([`crate::db::endpoint`]).
//!
//! When the bridge is enabled and the desktop app is running, the sidecar stops
//! opening pools altogether and forwards its data-path calls here. The app
//! becomes the single owner of every HuginnDB connection on the machine: one
//! budget, one place to see it, one place to cap it. As a side effect that is
//! worth as much as the budget, MCP-driven reads and writes show up in the
//! app's Console in real time, instead of only in `mcp-audit.log`.
//!
//! When the app is *not* running, the sidecar falls back to opening its own
//! pools exactly as before. Nothing about the MCP surface changes either way.
//!
//! # Transport, and why it isn't a Unix socket
//!
//! Loopback TCP on an OS-assigned port, with a token. A Unix domain socket
//! would give peer credentials for free on Linux/macOS — but HuginnDB's primary
//! platform is Windows, where the equivalent is a named pipe with a completely
//! different API that cannot be compiled or tested from a Unix CI box. Shipping
//! the strong path only where it can be tested, and an untested `#[cfg(windows)]`
//! branch on the platform most users are on, is the wrong trade: this project
//! has already been burnt twice by Windows-only build paths (see ADRs #20 and #21).
//! One transport, identical everywhere, testable
//! everywhere.
//!
//! # Security posture
//!
//! * **Off by default** (`connections.mcpBridge`). A listening socket that
//!   fronts every database the user has saved is not something to enable behind
//!   someone's back, however narrow the exposure.
//! * **Bound to `127.0.0.1`**, never `0.0.0.0` — nothing off-machine can reach
//!   it.
//! * **Token-gated.** Every request carries a per-run random token; a mismatch
//!   is refused and the connection dropped. The token lives in
//!   [`DISCOVERY_FILE`] alongside the port, written `0600` on Unix, so another
//!   user on the same machine can reach the port but cannot authenticate.
//! * **The write policy is re-checked here**, not trusted from the caller. The
//!   sidecar already enforces [`crate::state::McpWritePolicy`] before it sends,
//!   but this is a privileged surface and a second, independent check is what
//!   keeps a bug (or anything else that finds the token) from writing to a
//!   connection the user marked read-only.
//!
//! What it does *not* defend against: another process running as the same user.
//! That process can already read `profiles.json`, and the OS keychain is
//! typically unlocked for the logged-in session — the bridge is not a new
//! capability for an attacker who is already you.

/// Sidecar half. Only the `huginndb-mcp` build has a use for it, and gating it
/// keeps the desktop app's build free of dead code for a client it never runs.
#[cfg(feature = "mcp")]
pub mod client;
pub mod exec;
pub mod protocol;
pub mod server;

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Discovery file inside the platform config dir. Holds the port and token a
/// sidecar needs to reach a running app.
///
/// Named per [`crate::app_identity::APP_DIR`]'s directory, so a canary build's
/// bridge and a stable build's bridge never collide (ADR #26).
const DISCOVERY_FILE: &str = "mcp-bridge.json";

/// What the desktop app publishes so a sidecar can find it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// Loopback port the app is listening on.
    pub port: u16,
    /// Shared secret for this run. Regenerated on every start, so a stale file
    /// from a crashed run cannot authenticate against a new one.
    pub token: String,
    /// The app's process id, recorded for diagnostics only — liveness is
    /// decided by whether the port actually accepts, never by probing a pid
    /// (which can be recycled).
    pub pid: u32,
}

/// Path of the discovery file.
pub fn discovery_path() -> AppResult<PathBuf> {
    let dir = dirs::config_dir()
        .ok_or_else(|| AppError::NotFound("platform config dir".into()))?
        .join(crate::app_identity::APP_DIR);
    Ok(dir.join(DISCOVERY_FILE))
}

/// Publish `discovery` for sidecars to find.
///
/// Written `0600` on Unix: the token is the only thing standing between another
/// local user and every database this app can reach, and the loopback port is
/// reachable by anyone on the machine.
pub fn publish(discovery: &Discovery) -> AppResult<()> {
    let path = discovery_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(discovery)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Set after writing rather than via `OpenOptions::mode`, so the
        // permissions are corrected even when the file already existed with
        // looser ones from an older build.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Remove the discovery file. Best-effort: a missing file is success, since the
/// only thing that matters is that no sidecar is left pointing at a port that
/// nothing is listening on.
pub fn unpublish() {
    if let Ok(path) = discovery_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// Read the published discovery, if any.
///
/// Only the sidecar half reads this, so it is dead code in a normal
/// `pnpm tauri:build` — the same gating pattern as `McpWritePolicy`'s helpers
/// before the bridge needed them app-side.
///
/// A malformed or absent file is `None`, not an error: "no app is running" is
/// the normal case for a sidecar started before the desktop app, and it must
/// fall back silently rather than fail a tool call.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn read_discovery() -> Option<Discovery> {
    let path = discovery_path().ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}
