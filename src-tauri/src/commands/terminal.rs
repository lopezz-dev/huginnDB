//! The terminal panel's commands. See [`crate::terminal`] for the sessions
//! themselves.
//!
//! Two ways in, deliberately separate:
//!
//! - [`terminal_open_shell`] starts the user's own shell. It touches no
//!   database and carries no credential — it is the terminal they could open
//!   from the start menu, docked — so the managed policy has nothing to say
//!   about it (`none` in `guard::HUMAN_POLICY`).
//! - [`terminal_open_mongosh`] starts `mongosh` signed in *as a connection*,
//!   and inside it anything goes: arbitrary JavaScript, every collection,
//!   every write. That is free text with every verb, so it is guarded as
//!   exactly that (`guard::mongosh`): refused under a rule that limits which
//!   relations may be seen, or that withholds any write or DDL. A person who
//!   holds the password can always run their own `mongosh` — the guard's
//!   module docs say so — but HuginnDB will not hand its credentials to one.
//!
//! Both refuse while the panel is switched off in Settings, so the switch is
//! a real off rather than a hidden icon.

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use crate::terminal::{self, Owner, TerminalEvent, TerminalRegistry};

/// What the panel needs to know before offering anything: which shell a
/// plain terminal would start, and whether `mongosh` can be found.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEnvironment {
    /// `pwsh`, `powershell`, `bash`, `zsh` … or `None` when the configured
    /// override does not exist.
    pub shell: Option<String>,
    pub shell_path: Option<String>,
    /// Why the shell cannot be started, when it cannot.
    pub shell_error: Option<String>,
    pub mongosh_path: Option<String>,
    /// `mongosh --version`, when it answered.
    pub mongosh_version: Option<String>,
    /// Why `mongosh` cannot be started, when it cannot — "not found" with the
    /// download link, or a configured path that does not exist.
    pub mongosh_error: Option<String>,
    /// Whether the `mongosh` in use is the copy HuginnDB downloaded, as
    /// opposed to one the user installed.
    pub mongosh_managed: bool,
    /// The version of HuginnDB's own copy, read from its directory name — no
    /// process is started for it. Present when one is installed, whether or
    /// not it is the one in use.
    pub mongosh_managed_version: Option<String>,
    /// There is no `mongosh` anywhere it looks and none is configured: the
    /// case the **Download** button fixes. A configured path that does not
    /// exist is not this.
    pub mongosh_missing: bool,
    /// MongoDB publishes a build for this machine that HuginnDB can unpack,
    /// so the download is on offer at all.
    pub mongosh_downloadable: bool,
    /// Why the managed policy does not let this person download it, when it
    /// does not (`allowToolDownloads`). The interface hides the download and
    /// says so; the commands refuse regardless.
    pub mongosh_download_blocked: Option<String>,
    /// A download is running right now, in any window. A window that opened
    /// (or reloaded) after it started cannot see its progress, only this.
    pub mongosh_downloading: bool,
}

fn require_enabled(state: &AppState) -> AppResult<()> {
    if state.prefs.read().terminal.enabled {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "the terminal is switched off in Settings → Terminal".into(),
        ))
    }
}

/// Wrap a channel as a session sink. A send that fails means the webview
/// went away (a reload, a closed window); the session is cleaned up by the
/// window hook or by `terminal_close`, so there is nothing to do here.
fn sink(channel: Channel<TerminalEvent>) -> terminal::session::Sink {
    std::sync::Arc::new(move |event| {
        let _ = channel.send(event);
    })
}

#[tauri::command]
pub async fn terminal_environment(
    state: State<'_, AppState>,
    installer: State<'_, terminal::download::Installer>,
) -> AppResult<TerminalEnvironment> {
    let (shell_override, mongosh_override) = {
        let prefs = state.prefs.read();
        (
            prefs.terminal.shell_path.clone(),
            prefs.terminal.mongosh_path.clone(),
        )
    };
    let (shell, shell_path, shell_error) = match terminal::shell::resolve(&shell_override) {
        Ok(choice) => (
            Some(choice.label()),
            Some(choice.program.to_string_lossy().into_owned()),
            None,
        ),
        Err(e) => (None, None, Some(e.to_string())),
    };
    let (mongosh_path, mongosh_version, mongosh_error) =
        match terminal::mongosh::locate(&mongosh_override) {
            Ok(path) => {
                let version = terminal::mongosh::version(&path).await;
                (Some(path.to_string_lossy().into_owned()), version, None)
            }
            Err(e) => (None, None, Some(e.to_string())),
        };
    let mongosh_managed = mongosh_path
        .as_deref()
        .is_some_and(|p| terminal::download::is_downloaded(std::path::Path::new(p)));
    Ok(TerminalEnvironment {
        shell,
        shell_path,
        shell_error,
        mongosh_path,
        mongosh_version,
        mongosh_missing: mongosh_error.is_some() && mongosh_override.trim().is_empty(),
        mongosh_error,
        mongosh_managed,
        mongosh_managed_version: terminal::download::downloaded_version(),
        mongosh_downloadable: terminal::download::target().is_some(),
        mongosh_download_blocked: crate::commands::guard::tool_download(state.inner())
            .err()
            .map(|e| match e {
                AppError::InvalidInput(reason) => reason,
                other => other.to_string(),
            }),
        mongosh_downloading: installer.is_running(),
    })
}

/// The newest stable `mongosh` MongoDB offers this machine, for Settings to
/// compare with the copy HuginnDB installed. One request to the feed; the
/// caller decides when that is worth making.
#[tauri::command]
pub async fn terminal_mongosh_latest_version(state: State<'_, AppState>) -> AppResult<String> {
    require_enabled(state.inner())?;
    crate::commands::guard::tool_download(state.inner())?;
    terminal::download::latest_version().await
}

/// Download, verify and install the latest stable `mongosh` into HuginnDB's
/// own data directory, reporting progress on `on_event`. `None` means the user
/// cancelled ([`terminal_mongosh_cancel_download`]); nothing is left behind.
///
/// Which build, from where and against which checksum is decided in
/// `terminal::download` — the interface can ask for this and for nothing more
/// (ADR #88's rule for the theme registry, applied here). It touches no
/// database and carries no credential, but it does fetch and later run an
/// executable from the internet, so a managed policy has a say
/// (`guard::tool_download`, the role's `allowToolDownloads`); it also refuses
/// while the terminal is switched off.
#[tauri::command]
pub async fn terminal_mongosh_download(
    state: State<'_, AppState>,
    installer: State<'_, terminal::download::Installer>,
    on_event: Channel<terminal::download::InstallEvent>,
) -> AppResult<Option<terminal::download::Installed>> {
    require_enabled(state.inner())?;
    crate::commands::guard::tool_download(state.inner())?;
    let root = terminal::download::root()
        .ok_or_else(|| AppError::Terminal("no data directory available".into()))?;
    // Released when this future ends — by finishing, failing, panicking or
    // being dropped — so the installer cannot stay taken.
    let claim = installer.begin()?;
    terminal::download::install_latest(&root, claim.token(), &|event| {
        let _ = on_event.send(event);
    })
    .await
}

/// Whether a download is running — in any window. For a window that cannot
/// see its progress (it opened or reloaded after the download began) to show
/// "in progress" instead of offering the button, and to notice when it ends.
#[tauri::command]
pub fn terminal_mongosh_download_running(
    installer: State<'_, terminal::download::Installer>,
) -> bool {
    installer.is_running()
}

/// Stop the download in progress, if there is one. Quiet when there is not:
/// the button that sends it can race the download finishing.
#[tauri::command]
pub fn terminal_mongosh_cancel_download(installer: State<'_, terminal::download::Installer>) {
    installer.cancel();
}

#[tauri::command]
pub fn terminal_open_shell(
    window: tauri::Window,
    state: State<'_, AppState>,
    terminals: State<'_, TerminalRegistry>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> AppResult<String> {
    require_enabled(state.inner())?;
    let shell_override = state.prefs.read().terminal.shell_path.clone();
    let choice = terminal::shell::resolve(&shell_override)?;
    let mut cmd = portable_pty::CommandBuilder::new(&choice.program);
    cmd.args(&choice.args);
    terminal::prepare(&mut cmd);
    terminals.spawn(
        cmd,
        cols,
        rows,
        Owner {
            window: window.label().to_string(),
            connection_id: None,
        },
        None,
        sink(on_event),
    )
}

/// Start `mongosh` signed in as the open connection `connection_id` — a
/// top-level connection, not a per-database view — switched to `database`
/// when one is given.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn terminal_open_mongosh(
    window: tauri::Window,
    state: State<'_, AppState>,
    terminals: State<'_, TerminalRegistry>,
    connection_id: String,
    database: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> AppResult<String> {
    require_enabled(state.inner())?;
    crate::commands::guard::mongosh(state.inner(), &connection_id)?;
    if let Some(db) = database.as_deref().filter(|d| !d.is_empty()) {
        crate::commands::guard::database(state.inner(), &connection_id, db)?;
    }
    let state = state.inner();

    // The open pool is the source of truth for how to sign in: its password
    // and its tunnel. Requiring one also means the panel never dials a
    // server the explorer has not.
    match state.pool_for(&connection_id) {
        Ok(DbPool::Mongo(_)) => {}
        Ok(_) => {
            return Err(AppError::InvalidInput(
                "mongosh is only for MongoDB connections".into(),
            ))
        }
        Err(_) => {
            return Err(AppError::NotConnected(format!(
                "connect to {connection_id} before opening mongosh on it"
            )))
        }
    }
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == connection_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {connection_id}")))?;
    let profile = crate::credentials::effective_profile(&state.policy, &profile);
    let cached = state
        .session_secrets
        .read()
        .get(&connection_id)
        .and_then(|s| s.password.clone());
    let password = match cached {
        Some(pw) => pw,
        None => crate::commands::connection::resolve_password(&profile)?,
    };
    let tunnel_port = state.connections.read().tunnel_port(&connection_id);
    let uri = terminal::mongosh::launch_uri(&profile, &password, tunnel_port)?;

    let mongosh_override = state.prefs.read().terminal.mongosh_path.clone();
    let program = terminal::mongosh::locate(&mongosh_override)?;
    let mut cmd = terminal::mongosh::command(&program, &uri, database.as_deref());
    terminal::prepare(&mut cmd);
    terminals.spawn(
        cmd,
        cols,
        rows,
        Owner {
            window: window.label().to_string(),
            connection_id: Some(connection_id),
        },
        terminal::mongosh::startup_answer(),
        sink(on_event),
    )
}

/// Keystrokes and pastes. Async and off the runtime: a child that is not
/// reading its input blocks the write until it does.
#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TerminalRegistry>().write(&id, data.as_bytes())
    })
    .await
    .map_err(|e| AppError::Terminal(e.to_string()))?
}

#[tauri::command]
pub fn terminal_resize(
    terminals: State<'_, TerminalRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    terminals.resize(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(terminals: State<'_, TerminalRegistry>, id: String) {
    terminals.close(&id);
}

/// Close every session the calling window has open. The panel calls it once
/// when it first mounts: a webview reload keeps the window (so the window hook
/// never fires) but loses every channel, which would leave the previous
/// page's shells running with nobody to show them to.
#[tauri::command]
pub fn terminal_close_window_sessions(
    window: tauri::Window,
    terminals: State<'_, TerminalRegistry>,
) -> usize {
    terminals.close_window(window.label())
}
