//! How an MCP client should start the connector on this install.
//!
//! On every packaged format but one, the `huginndb-mcp` sidecar sits next to
//! the main executable at a path that stays put, so that path *is* the
//! command an MCP client is given. The exception is the **AppImage**: the
//! runtime mounts the image under a fresh `/tmp/.mount_HuginnXXXXXX` every
//! time it starts and unmounts it on exit, so `current_exe()`'s directory is
//! a path that stops existing the moment the app closes. Registering it — as
//! Settings → MCP and its "Add to Claude Code" button used to — gave the
//! client a connector that worked exactly until the app was closed or
//! restarted.
//!
//! The one path an AppImage has that does survive is the image file itself,
//! which the runtime reports in `$APPIMAGE` (and which the in-app updater
//! replaces in place, so it survives updates too). So the client is pointed
//! at that file with [`FLAG`], and the main executable, started inside a
//! fresh mount, hands the process over to the sidecar next to it before
//! anything else runs ([`run_if_requested`]). Copying the sidecar out to a
//! fixed location was the alternative and the worse one: the copy would go
//! stale on every update — the problem `mcp::delegate` exists to solve for the
//! `.mcpb` — and would run outside the image, without the libraries it
//! bundles.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// First argument that turns the desktop executable into the MCP connector.
/// A flag rather than a bare word, like the `--update` family, because every
/// other argument this executable understands is one.
pub const FLAG: &str = "--mcp";

/// The sidecar's file name, as Tauri stages `externalBin` (no target triple).
pub const SIDECAR: &str = if cfg!(windows) {
    "huginndb-mcp.exe"
} else {
    "huginndb-mcp"
};

/// What an MCP client's config should say.
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    /// The `command`: the sidecar itself, or the AppImage that contains it.
    pub program: PathBuf,
    /// Arguments that must precede anything the user adds (`--connections`,
    /// `--read-only`, …). Empty except for an AppImage.
    pub args: Vec<String>,
    /// Where the sidecar is in *this* process's view of the filesystem —
    /// inside the current mount for an AppImage. Only used to say whether a
    /// connector is bundled at all; never handed to a client.
    pub sidecar: PathBuf,
}

/// Resolve [`Launch`] for the running process.
pub fn resolve() -> Launch {
    let exe = std::env::current_exe().ok();
    let sidecar = exe
        .as_deref()
        .and_then(Path::parent)
        .map(|dir| dir.join(SIDECAR))
        .unwrap_or_else(|| SIDECAR.into());
    let image = if cfg!(target_os = "linux") {
        exe.as_deref().and_then(|exe| {
            appimage(
                std::env::var_os("APPIMAGE").as_deref(),
                std::env::var_os("APPDIR").as_deref(),
                exe,
            )
        })
    } else {
        None
    };
    launch_for(sidecar, image)
}

/// The pure half of [`resolve`].
fn launch_for(sidecar: PathBuf, image: Option<PathBuf>) -> Launch {
    match image {
        Some(image) => Launch {
            program: image,
            args: vec![FLAG.to_string()],
            sidecar,
        },
        None => Launch {
            program: sidecar.clone(),
            args: Vec::new(),
            sidecar,
        },
    }
}

/// The AppImage this process was started from, if it was.
///
/// `$APPIMAGE` alone is not proof: the runtime exports it to the whole process
/// tree, so a `.deb` install launched from a terminal that some other AppImage
/// opened inherits a value naming an unrelated image. Requiring this
/// executable to live under `$APPDIR` — the mount that same runtime created —
/// ties the variable to *this* process.
fn appimage(image: Option<&OsStr>, appdir: Option<&OsStr>, exe: &Path) -> Option<PathBuf> {
    let image = image.filter(|v| !v.is_empty())?;
    let appdir = appdir.filter(|v| !v.is_empty())?;
    exe.starts_with(Path::new(appdir))
        .then(|| PathBuf::from(image))
}

/// `HuginnDB.AppImage --mcp [args…]`: replace this process with the sidecar.
///
/// Runs first thing in [`crate::run`], before Tauri, a window or a single byte
/// on stdout — which belongs to the JSON-RPC channel the MCP client opened.
/// `exec` rather than spawn-and-wait: the sidecar keeps this PID and the
/// stdio the client handed over, the AppImage runtime keeps the mount alive
/// for exactly as long as it runs, and the environment the runtime prepared
/// (`LD_LIBRARY_PATH` into the image) carries over unchanged.
///
/// Returns only when the first argument is not [`FLAG`]. When it is and the
/// sidecar cannot be started, the process exits non-zero instead of falling
/// through: opening the desktop window in answer to an MCP client would be
/// the worst possible failure mode.
#[cfg(unix)]
pub fn run_if_requested() {
    use std::os::unix::process::CommandExt;

    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(FLAG)) {
        return;
    }
    let sidecar = resolve().sidecar;
    let err = std::process::Command::new(&sidecar).args(args).exec();
    eprintln!(
        "[huginndb] could not start the MCP connector at {}: {err}",
        sidecar.display()
    );
    std::process::exit(127);
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/tmp/.mount_HuginnAbC123/usr/bin/huginndb";
    const MOUNT: &str = "/tmp/.mount_HuginnAbC123";
    const IMAGE: &str = "/home/me/Apps/HuginnDB.AppImage";

    #[test]
    fn an_appimage_is_registered_by_its_image_not_its_mount() {
        let image = appimage(
            Some(OsStr::new(IMAGE)),
            Some(OsStr::new(MOUNT)),
            Path::new(EXE),
        );
        assert_eq!(image, Some(PathBuf::from(IMAGE)));

        let launch = launch_for(
            PathBuf::from(format!("{MOUNT}/usr/bin/huginndb-mcp")),
            image,
        );
        assert_eq!(launch.program, PathBuf::from(IMAGE));
        assert_eq!(launch.args, vec![FLAG.to_string()]);
        // The mount path is still known — to check the bundle — but it is not
        // what a client gets.
        assert!(launch.sidecar.starts_with(MOUNT));
    }

    #[test]
    fn an_inherited_appimage_variable_does_not_claim_another_install() {
        // A `.deb` install started from a shell some AppImage opened.
        let got = appimage(
            Some(OsStr::new(IMAGE)),
            Some(OsStr::new(MOUNT)),
            Path::new("/usr/bin/huginndb"),
        );
        assert_eq!(got, None);
    }

    #[test]
    fn missing_or_empty_variables_mean_no_appimage() {
        let exe = Path::new(EXE);
        assert_eq!(appimage(None, Some(OsStr::new(MOUNT)), exe), None);
        assert_eq!(appimage(Some(OsStr::new(IMAGE)), None, exe), None);
        assert_eq!(
            appimage(Some(OsStr::new("")), Some(OsStr::new(MOUNT)), exe),
            None
        );
        assert_eq!(
            appimage(Some(OsStr::new(IMAGE)), Some(OsStr::new("")), exe),
            None
        );
    }

    #[test]
    fn every_other_install_registers_the_sidecar_with_no_arguments() {
        let sidecar = PathBuf::from("/usr/bin/huginndb-mcp");
        let launch = launch_for(sidecar.clone(), None);
        assert_eq!(launch.program, sidecar);
        assert!(launch.args.is_empty());
    }

    #[test]
    fn the_flag_is_not_one_the_startup_parser_already_means_something_by() {
        // `--mcp` reaches `parse_args` only on a platform where
        // `run_if_requested` is not compiled in, and there it must be inert.
        let parsed = crate::parse_args(&[FLAG.to_string()]);
        assert!(parsed.connect_profile.is_none());
        assert!(parsed.adhoc_host.is_none());
        assert!(parsed.adhoc_connection_string.is_none());
    }
}
