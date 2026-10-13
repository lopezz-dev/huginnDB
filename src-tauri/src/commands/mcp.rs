//! MCP connector introspection.
//!
//! The `huginndb-mcp` binary lives in its own workspace crate (see
//! `mcp-server/` and gotcha #20 in `CLAUDE.md`) and ships as a Tauri
//! `externalBin` sidecar — installed side-by-side with the main executable,
//! never started by the desktop app for itself (an AppImage's `--mcp` hands
//! the whole process over to it, see `crate::mcp_launcher`). This command
//! only resolves *how a client should start it* so the Settings → MCP panel
//! can show the user a ready-to-use command instead of sending them hunting
//! through the install directory.

use crate::error::AppResult;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct McpConnectorInfo {
    /// The command an MCP client runs: the `huginndb-mcp` sidecar, or — in an
    /// AppImage, whose mount path changes on every launch — the `.AppImage`
    /// file itself. See [`crate::mcp_launcher`].
    pub binary_path: String,
    /// Arguments that go right after `binary_path`, before anything the user
    /// adds. Empty except for an AppImage, where it is `["--mcp"]`.
    pub args: Vec<String>,
    /// Whether the connector is actually there to be run. False in `tauri dev`
    /// / an unbundled `cargo run` — the sidecar is only staged in a
    /// packaged install (or a manual `cargo build -p huginndb-mcp --release`
    /// followed by `pnpm tauri:build`).
    pub available: bool,
}

/// Resolve how a client should start the connector. Tauri stages
/// `externalBin` binaries next to the main executable, so that is where the
/// sidecar is looked for; what a client is *given* differs only for an
/// AppImage ([`crate::mcp_launcher::resolve`]).
#[tauri::command]
pub fn get_mcp_connector_info() -> AppResult<McpConnectorInfo> {
    let launch = crate::mcp_launcher::resolve();
    // Both halves must exist: in an AppImage the sidecar is inside the mount
    // and the program is the image file next to it on the real filesystem.
    let available = launch.sidecar.is_file() && launch.program.is_file();
    Ok(McpConnectorInfo {
        binary_path: launch.program.to_string_lossy().into_owned(),
        args: launch.args,
        available,
    })
}

/// Best-effort check for whether the `huginndb-mcp` sidecar is currently
/// running — i.e. some external MCP client (Claude Code, Cursor, Antigravity,
/// ...) has spawned it and may be relying on it right now. The desktop app
/// never starts or stops this process itself (see gotcha #20/#23 in
/// CLAUDE.md), so the only signal available is asking the OS's own process
/// list — there is no IPC channel to the sidecar to ask it directly.
///
/// Used by the update flow to warn the user before installing: the Windows
/// NSIS installer hook (`windows/hooks.nsi`) force-kills this process
/// unconditionally so the update can overwrite it, and previously did so
/// silently. Shells out to the platform's own process-listing tool rather
/// than pulling in a process-inspection crate, to keep the dependency tree
/// small. Any failure to run the check (missing tool, unexpected output)
/// degrades to `false` — an update should never be blocked by an inconclusive
/// check, only warned when the sidecar is positively detected.
#[tauri::command]
pub fn is_mcp_sidecar_running() -> bool {
    crate::updater::process::is_running("huginndb-mcp", None)
}

/// How [`register_with_claude_code`] ended.
///
/// Four outcomes rather than a bool, because three of them need a different
/// sentence from the user's point of view and only one of them is a bug worth
/// showing raw output for.
#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeCodeOutcome {
    /// Registered. The user restarts nothing; `claude` picks it up per session.
    Added,
    /// A server called `huginndb` was already registered, so nothing changed.
    /// Not an error: it is what a second click looks like.
    AlreadyRegistered,
    /// The `claude` CLI is not on this machine's `PATH`. The panel falls back
    /// to the copyable command.
    CliNotFound,
    /// It ran and refused. `detail` carries what it said.
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeRegistration {
    pub outcome: ClaudeCodeOutcome,
    /// Whatever the CLI printed, trimmed. Empty unless the outcome is `Failed`.
    pub detail: String,
}

/// Locate an executable on `PATH`, the way a shell would.
///
/// Resolving it ourselves rather than handing the bare name to
/// [`std::process::Command`] buys two things on Windows: `PATHEXT`, without
/// which `claude.cmd` is invisible to `CreateProcess`, and the ability to pass
/// the sidecar path as a plain argv entry instead of quoting it into a
/// `cmd /C` string — and that path routinely contains spaces
/// (`C:\Program Files\...`).
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![]
    };
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Register the bundled sidecar with the Claude Code CLI, so the user does not
/// have to copy a path into a terminal.
///
/// Runs exactly the command the panel displays —
/// `claude mcp add huginndb -s user -- <command> [<args>]` — and nothing else.
/// It is reversible with `claude mcp remove huginndb`, and it writes only to
/// the CLI's own config: the button click is the confirmation, so nothing prompts
/// again.
///
/// No `tauri-plugin-shell`. That plugin exists to let the *frontend* spawn
/// processes, which this codebase does not do anyway — all I/O lives in Rust
/// commands — so it would add a dependency and a capability surface to buy
/// nothing. Same call [`is_mcp_sidecar_running`] above already made.
///
/// `async` with a timeout because a blocking `output()` in a Tauri command
/// occupies an async runtime thread, and this shells out to a Node CLI whose
/// startup is not instant.
#[tauri::command]
pub async fn register_with_claude_code() -> AppResult<ClaudeCodeRegistration> {
    let info = get_mcp_connector_info()?;
    let Some(cli) = find_in_path("claude") else {
        return Ok(ClaudeCodeRegistration {
            outcome: ClaudeCodeOutcome::CliNotFound,
            detail: String::new(),
        });
    };

    let run = tokio::process::Command::new(cli)
        .args([
            "mcp",
            "add",
            "huginndb",
            "-s",
            "user",
            "--",
            info.binary_path.as_str(),
        ])
        .args(&info.args)
        .output();
    let out = match tokio::time::timeout(std::time::Duration::from_secs(30), run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Ok(ClaudeCodeRegistration {
                outcome: ClaudeCodeOutcome::Failed,
                detail: e.to_string(),
            })
        }
        Err(_) => {
            return Ok(ClaudeCodeRegistration {
                outcome: ClaudeCodeOutcome::Failed,
                detail: "the claude CLI did not answer within 30s".into(),
            })
        }
    };

    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(ClaudeCodeRegistration {
        outcome: classify_claude_output(out.status.success(), &said),
        detail: said.trim().chars().take(600).collect(),
    })
}

/// Decide what the CLI's exit status and output mean.
///
/// Split out so the "already there" case — the one a second click produces, and
/// the one that must not be shown as a failure — is testable without a `claude`
/// binary on the machine running the tests.
fn classify_claude_output(success: bool, said: &str) -> ClaudeCodeOutcome {
    if success {
        return ClaudeCodeOutcome::Added;
    }
    let lower = said.to_lowercase();
    if lower.contains("already exists") || lower.contains("already configured") {
        ClaudeCodeOutcome::AlreadyRegistered
    } else {
        ClaudeCodeOutcome::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_click_is_not_reported_as_a_failure() {
        // `claude mcp add` exits non-zero when the name is taken, which is what
        // clicking the button twice looks like. Showing that as an error would
        // send the user hunting for a problem that does not exist.
        assert_eq!(
            classify_claude_output(false, "MCP server huginndb already exists in user config"),
            ClaudeCodeOutcome::AlreadyRegistered
        );
        assert_eq!(
            classify_claude_output(false, "EACCES: permission denied"),
            ClaudeCodeOutcome::Failed
        );
        assert_eq!(classify_claude_output(true, ""), ClaudeCodeOutcome::Added);
    }

    #[test]
    fn find_in_path_resolves_a_real_executable() {
        // Whatever the platform, *something* on PATH resolves; this pins down
        // that the walk works rather than always returning None.
        let probe = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(find_in_path(probe).is_some(), "{probe} should be on PATH");
        assert!(find_in_path("huginndb-definitely-not-a-real-binary").is_none());
    }
}
