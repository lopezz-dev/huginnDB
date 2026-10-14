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

/// How [`register_with_claude_code`] or [`update_claude_code_registration`]
/// ended.
///
/// Several outcomes rather than a bool, because most of them need a different
/// sentence from the user's point of view and only one of them is a bug worth
/// showing raw output for.
#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeCodeOutcome {
    /// Registered. The user restarts nothing; `claude` picks it up per session.
    Added,
    /// A server called `huginndb` was already registered and points where this
    /// install would point, so nothing changed. Not an error: it is what a
    /// second click looks like.
    AlreadyRegistered,
    /// A server called `huginndb` was already registered as this connector, but
    /// at a command this install would not register — an AppImage mount from
    /// an earlier launch, an install that moved. Nothing changed; the panel
    /// offers [`update_claude_code_registration`].
    Stale,
    /// The stale registration was replaced.
    Updated,
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
/// When the name is already taken it says *which* way: still pointing here
/// ([`ClaudeCodeOutcome::AlreadyRegistered`]), or at a command this install
/// would no longer register ([`ClaudeCodeOutcome::Stale`]). The second used to
/// be reported as the first, which told a user whose AppImage registration had
/// died with its mount that there was nothing to change.
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

    let mut add = vec!["mcp", "add", SERVER_NAME, "-s", "user", "--"];
    add.push(info.binary_path.as_str());
    add.extend(info.args.iter().map(String::as_str));
    let (success, said) = match run_claude(&cli, &add).await {
        Ok(ran) => ran,
        Err(detail) => return Ok(failed(detail)),
    };
    let outcome = match classify_claude_output(success, &said) {
        ClaudeCodeOutcome::AlreadyRegistered
            if matches!(
                read_claude_code_status(&info),
                ClaudeCodeStatus::Stale { .. }
            ) =>
        {
            ClaudeCodeOutcome::Stale
        }
        other => other,
    };
    Ok(ClaudeCodeRegistration {
        outcome,
        detail: said.trim().chars().take(600).collect(),
    })
}

/// What Claude Code has registered as `huginndb`, against what this install
/// would register. Read when Settings → MCP opens, so a registration that went
/// stale is visible before anyone clicks anything.
///
/// Reads Claude Code's config file and does not run the CLI. `claude mcp get`
/// would be the public interface, but it prints text rather than JSON, joins
/// the arguments with spaces, and health-checks the server — it would start
/// the very connector it is asked about every time this panel opened. Only
/// *reading* goes around the CLI; every change still goes through it.
#[tauri::command]
pub fn get_claude_code_registration() -> AppResult<ClaudeCodeStatus> {
    Ok(read_claude_code_status(&get_mcp_connector_info()?))
}

/// Replace a stale `huginndb` registration with this install's command.
///
/// `claude mcp` has no update verb, so this is a `remove` followed by an `add`,
/// both scoped to `user` as the original `add` was. Arguments the user added
/// after the connector's own (`--connections`, `--read-only`, …) are kept: a
/// registration pinned to two connections stays pinned to them.
///
/// Only acts on [`ClaudeCodeStatus::Stale`], re-read here rather than trusted
/// from the panel, so a server under the same name that is not this connector
/// is never touched. If the `add` fails after the `remove` succeeded, the old
/// registration is put back: a dead path the user can see beats no entry at
/// all, which looks like it was never there.
#[tauri::command]
pub async fn update_claude_code_registration() -> AppResult<ClaudeCodeRegistration> {
    let info = get_mcp_connector_info()?;
    // Never trade a stale entry for one that points at nothing: a dev build
    // has no connector staged next to it.
    if !info.available {
        return Ok(failed("this build has no MCP connector to register".into()));
    }
    let registered = match registration_in(&claude_config()) {
        Ok(Some(registered)) => registered,
        _ => {
            return Ok(failed(
                "Claude Code has no huginndb server this panel can read".into(),
            ))
        }
    };
    let Some(command_line) = replacement(&registered, &info) else {
        return Ok(match classify(Some(&registered), &info, |_| true) {
            ClaudeCodeStatus::Current => ClaudeCodeRegistration {
                outcome: ClaudeCodeOutcome::AlreadyRegistered,
                detail: String::new(),
            },
            _ => failed(format!(
                "the huginndb server in Claude Code ({}) is not this connector, so it was \
                 left as it is",
                display_command(&registered.command, &registered.args)
            )),
        });
    };
    let Some(cli) = find_in_path("claude") else {
        return Ok(ClaudeCodeRegistration {
            outcome: ClaudeCodeOutcome::CliNotFound,
            detail: String::new(),
        });
    };

    match run_claude(&cli, &["mcp", "remove", SERVER_NAME, "-s", "user"]).await {
        Ok((true, _)) => {}
        Ok((false, said)) => return Ok(failed(said)),
        Err(detail) => return Ok(failed(detail)),
    }
    let add = |line: Vec<String>| {
        let mut args: Vec<String> = ["mcp", "add", SERVER_NAME, "-s", "user", "--"]
            .map(String::from)
            .to_vec();
        args.extend(line);
        args
    };
    let added = run_claude_owned(&cli, add(command_line)).await;
    match added {
        Ok((true, _)) => Ok(ClaudeCodeRegistration {
            outcome: ClaudeCodeOutcome::Updated,
            detail: String::new(),
        }),
        Ok((false, said)) | Err(said) => {
            let mut old = vec![registered.command.clone()];
            old.extend(registered.args.clone());
            let restored = matches!(run_claude_owned(&cli, add(old)).await, Ok((true, _)));
            Ok(failed(if restored {
                format!("{} (the previous registration was put back)", said.trim())
            } else {
                format!(
                    "{} (the previous registration could not be put back: {})",
                    said.trim(),
                    display_command(&registered.command, &registered.args)
                )
            }))
        }
    }
}

/// The name every registration this panel makes goes under.
const SERVER_NAME: &str = "huginndb";

fn failed(detail: String) -> ClaudeCodeRegistration {
    ClaudeCodeRegistration {
        outcome: ClaudeCodeOutcome::Failed,
        detail: detail.trim().chars().take(600).collect(),
    }
}

/// Run the `claude` CLI once: whether it succeeded, and what it printed. `Err`
/// when it could not be run or did not answer in time.
async fn run_claude(cli: &std::path::Path, args: &[&str]) -> Result<(bool, String), String> {
    let run = tokio::process::Command::new(cli).args(args).output();
    match tokio::time::timeout(std::time::Duration::from_secs(30), run).await {
        Ok(Ok(out)) => Ok((
            out.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        )),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("the claude CLI did not answer within 30s".into()),
    }
}

async fn run_claude_owned(
    cli: &std::path::Path,
    args: Vec<String>,
) -> Result<(bool, String), String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_claude(cli, &args).await
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

/// What Claude Code has registered as `huginndb`, against what this install
/// would register. Mirrors `ClaudeCodeStatus` in `src/types.ts`.
#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case", tag = "state")]
pub enum ClaudeCodeStatus {
    /// Nothing under that name in Claude Code's user scope.
    Missing,
    /// Registered, and pointing where this install would point.
    Current,
    /// Registered as this connector, at a command this install would not
    /// register. `registered` is that command line; `gone` says its program no
    /// longer exists — the AppImage case, whose mount is removed on exit.
    Stale { registered: String, gone: bool },
    /// Registered under the name, but not recognisably as this connector — a
    /// wrapper script, `npx`, something else entirely. Left alone.
    Custom { registered: String },
    /// Could not tell: no connector to compare with (a dev build), or a config
    /// file that would not parse. Treated as "say nothing".
    Unknown,
}

/// The one registration this panel cares about, as Claude Code stores it.
#[derive(Debug, PartialEq, Eq)]
struct Registered {
    command: String,
    args: Vec<String>,
}

/// Claude Code's config file: `$CLAUDE_CONFIG_DIR/.claude.json` when that is
/// set, `~/.claude.json` otherwise — where `claude mcp add -s user` writes.
/// The CLI this app spawns inherits the same environment, so both always
/// agree on which file it is.
fn claude_config() -> Option<String> {
    let path = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir).join(".claude.json"),
        None => dirs::home_dir()?.join(".claude.json"),
    };
    std::fs::read_to_string(path).ok()
}

/// The user-scope `huginndb` entry in a Claude Code config. `Ok(None)` when
/// there is none (or no file at all); `Err` when the file is there but is not
/// something this understands — its format is Claude Code's, not ours.
fn registration_in(config: &Option<String>) -> Result<Option<Registered>, ()> {
    let Some(text) = config else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| ())?;
    let Some(entry) = value.get("mcpServers").and_then(|s| s.get(SERVER_NAME)) else {
        return Ok(None);
    };
    let command = entry.get("command").and_then(|c| c.as_str()).ok_or(())?;
    let args = match entry.get("args") {
        None => Vec::new(),
        Some(args) => args
            .as_array()
            .ok_or(())?
            .iter()
            .map(|a| a.as_str().map(str::to_string).ok_or(()))
            .collect::<Result<_, _>>()?,
    };
    Ok(Some(Registered {
        command: command.to_string(),
        args,
    }))
}

/// The arguments the user added after this connector's own, when `registered`
/// is recognisably this connector: the sidecar run directly, or an AppImage
/// run with `--mcp`. `None` for anything else.
fn user_args(registered: &Registered) -> Option<&[String]> {
    let name = std::path::Path::new(&registered.command)
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    if name == "huginndb-mcp" || name == "huginndb-mcp.exe" {
        return Some(&registered.args);
    }
    let is_image = name.ends_with(".appimage");
    match registered.args.split_first() {
        Some((first, rest)) if is_image && first == crate::mcp_launcher::FLAG => Some(rest),
        _ => None,
    }
}

/// Whether two command paths name the same program. Case-insensitive on
/// Windows, where the filesystem is.
fn same_program(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The pure decision behind [`ClaudeCodeStatus`]. `exists` is injected so the
/// "its program is gone" half is testable without the filesystem.
fn classify(
    registered: Option<&Registered>,
    info: &McpConnectorInfo,
    exists: impl Fn(&str) -> bool,
) -> ClaudeCodeStatus {
    let Some(registered) = registered else {
        return ClaudeCodeStatus::Missing;
    };
    let line = display_command(&registered.command, &registered.args);
    if user_args(registered).is_none() {
        return ClaudeCodeStatus::Custom { registered: line };
    }
    let current = same_program(&registered.command, &info.binary_path)
        && registered.args.starts_with(&info.args);
    if current {
        ClaudeCodeStatus::Current
    } else {
        ClaudeCodeStatus::Stale {
            gone: !exists(&registered.command),
            registered: line,
        }
    }
}

fn read_claude_code_status(info: &McpConnectorInfo) -> ClaudeCodeStatus {
    if !info.available {
        return ClaudeCodeStatus::Unknown;
    }
    match registration_in(&claude_config()) {
        Ok(registered) => classify(registered.as_ref(), info, |p| {
            std::path::Path::new(p).exists()
        }),
        Err(()) => ClaudeCodeStatus::Unknown,
    }
}

/// The command line to register in place of a stale `registered`: this
/// install's command and arguments, then whatever the user had added. `None`
/// unless `registered` is stale.
fn replacement(registered: &Registered, info: &McpConnectorInfo) -> Option<Vec<String>> {
    if !matches!(
        classify(Some(registered), info, |_| true),
        ClaudeCodeStatus::Stale { .. }
    ) {
        return None;
    }
    let mut line = vec![info.binary_path.clone()];
    line.extend(info.args.iter().cloned());
    line.extend(user_args(registered)?.iter().cloned());
    Some(line)
}

/// A command line for a person to read: space-joined, with any part that
/// contains whitespace quoted.
fn display_command(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(|part| {
            if part.chars().any(char::is_whitespace) {
                format!("\"{part}\"")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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

    // --- a registration that went stale -------------------------------------

    const MOUNT_SIDECAR: &str = "/tmp/.mount_HuginnAbC/usr/bin/huginndb-mcp";
    const IMAGE: &str = "/home/me/Apps/HuginnDB.AppImage";

    fn appimage_install() -> McpConnectorInfo {
        McpConnectorInfo {
            binary_path: IMAGE.into(),
            args: vec!["--mcp".into()],
            available: true,
        }
    }

    fn registered(command: &str, args: &[&str]) -> Registered {
        Registered {
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn config(entry: &str) -> Option<String> {
        Some(format!(
            r#"{{"numStartups": 3, "mcpServers": {{"huginndb": {entry}}}}}"#
        ))
    }

    #[test]
    fn the_user_scope_entry_is_read_as_claude_code_stores_it() {
        let got = registration_in(&config(
            r#"{"type": "stdio", "command": "/x/huginndb-mcp", "args": ["--connections", "a,b"], "env": {}}"#,
        ));
        assert_eq!(
            got,
            Ok(Some(registered(
                "/x/huginndb-mcp",
                &["--connections", "a,b"]
            )))
        );
        // No `args` at all is a registration with none.
        assert_eq!(
            registration_in(&config(r#"{"command": "/x/huginndb-mcp"}"#)),
            Ok(Some(registered("/x/huginndb-mcp", &[])))
        );
        // No file, or no entry under the name: nothing registered.
        assert_eq!(registration_in(&None), Ok(None));
        assert_eq!(
            registration_in(&Some(
                r#"{"mcpServers": {"other": {"command": "x"}}}"#.into()
            )),
            Ok(None)
        );
        // A file that is not what this expects is "can't tell", not "missing".
        assert_eq!(registration_in(&Some("{not json".into())), Err(()));
        assert_eq!(registration_in(&config(r#"{"command": 42}"#)), Err(()));
    }

    #[test]
    fn a_registration_left_in_a_dead_appimage_mount_is_stale() {
        // The reported case: registered before the AppImage fix, from a mount
        // that was removed when the app closed.
        let old = registered(MOUNT_SIDECAR, &[]);
        assert_eq!(
            classify(Some(&old), &appimage_install(), |_| false),
            ClaudeCodeStatus::Stale {
                registered: MOUNT_SIDECAR.into(),
                gone: true,
            }
        );
        assert_eq!(
            replacement(&old, &appimage_install()),
            Some(vec![IMAGE.to_string(), "--mcp".to_string()])
        );
    }

    #[test]
    fn arguments_the_user_added_survive_the_update() {
        let pinned = registered(MOUNT_SIDECAR, &["--connections", "a,b", "--read-only"]);
        assert_eq!(
            replacement(&pinned, &appimage_install()),
            Some(
                [IMAGE, "--mcp", "--connections", "a,b", "--read-only"]
                    .map(String::from)
                    .to_vec()
            )
        );
        // An AppImage that was moved: its own `--mcp` is not carried twice.
        let moved = registered("/old/place/HuginnDB.AppImage", &["--mcp", "--read-only"]);
        assert_eq!(
            replacement(&moved, &appimage_install()),
            Some([IMAGE, "--mcp", "--read-only"].map(String::from).to_vec())
        );
    }

    #[test]
    fn a_registration_that_already_points_here_is_current() {
        let info = appimage_install();
        for args in [&["--mcp"][..], &["--mcp", "--connections", "a"][..]] {
            let reg = registered(IMAGE, args);
            assert_eq!(
                classify(Some(&reg), &info, |_| true),
                ClaudeCodeStatus::Current
            );
            assert_eq!(replacement(&reg, &info), None);
        }
        // A plain install, registered as its sidecar.
        let deb = McpConnectorInfo {
            binary_path: "/usr/bin/huginndb-mcp".into(),
            args: vec![],
            available: true,
        };
        let reg = registered("/usr/bin/huginndb-mcp", &[]);
        assert_eq!(
            classify(Some(&reg), &deb, |_| true),
            ClaudeCodeStatus::Current
        );
    }

    #[test]
    fn a_server_under_the_name_that_is_not_this_connector_is_left_alone() {
        let wrapper = registered("npx", &["some-other-mcp"]);
        assert_eq!(
            classify(Some(&wrapper), &appimage_install(), |_| true),
            ClaudeCodeStatus::Custom {
                registered: "npx some-other-mcp".into()
            }
        );
        assert_eq!(replacement(&wrapper, &appimage_install()), None);
        // An AppImage without `--mcp` is the app, not the connector.
        let app = registered(IMAGE, &[]);
        assert!(matches!(
            classify(Some(&app), &appimage_install(), |_| true),
            ClaudeCodeStatus::Custom { .. }
        ));
        assert_eq!(
            classify(None, &appimage_install(), |_| true),
            ClaudeCodeStatus::Missing
        );
    }

    #[test]
    fn a_command_line_quotes_only_what_needs_it() {
        assert_eq!(
            display_command(
                r"C:\Program Files\HuginnDB\huginndb-mcp.exe",
                &["--connections".into(), "a,b".into()]
            ),
            r#""C:\Program Files\HuginnDB\huginndb-mcp.exe" --connections a,b"#
        );
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
