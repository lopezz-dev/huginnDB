//! Hand the MCP session to the connector installed next to the desktop app.
//!
//! The `.mcpb` bundle Claude Desktop installs carries its own copy of
//! `huginndb-mcp` and runs it from the client's extensions folder. Updating
//! HuginnDB replaces the copy next to `huginndb.exe`, never that one, so
//! without this the extension kept serving the version it was installed with
//! — including, for a bundle older than 1.29, a connector that does not know
//! the managed policy exists. The fix is for every copy that is *not* the
//! installed one to launch the installed one and step aside: the extension is
//! installed once, and updates arrive with the app.
//!
//! It always delegates when an installed copy exists, without comparing
//! versions. What matters is that the connector matches the app that writes
//! `profiles.json` and reads the policy, not which of two binaries is newer.
//!
//! Runs before anything else in `huginndb-mcp`'s `main`: no state loaded, no
//! policy read, and nothing written to stdout, which is the JSON-RPC channel
//! the child inherits.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Where the installed connector is, when the default location is not wanted.
/// Set but empty, it turns delegation off and this copy serves the session.
pub const PATH_ENV: &str = "HUGINNDB_MCP_PATH";

/// Set on the child so that a copy which has already been delegated to never
/// delegates again, whatever its own lookup finds.
pub const DELEGATED_ENV: &str = "HUGINNDB_MCP_DELEGATED";

/// The stable app's `productName` (`tauri.conf.json`), which names both its
/// install folder and its uninstall key. Stable on purpose, not keyed off the
/// `canary` feature: the connector inside the `.mcpb` is always a stable build
/// (ADR #26), and a canary install is not what it should hand over to.
#[cfg_attr(not(windows), allow(dead_code))]
const PRODUCT_NAME: &str = "HuginnDB";

/// Run the installed connector in this process's place, if there is one that
/// is not this very binary. Returns the child's exit code for `main` to exit
/// with, or `None` when this copy should serve the session itself.
pub fn run_installed_if_any() -> Option<i32> {
    let current = std::env::current_exe().ok()?;
    let target = pick(
        std::env::var_os(PATH_ENV).as_deref(),
        std::env::var_os(DELEGATED_ENV).is_some(),
        &candidates(),
        &current,
        |p| p.is_file(),
        same_file,
    )?;

    // stderr only: the client shows it in its server log, and stdout belongs
    // to the protocol.
    eprintln!(
        "[huginndb-mcp] handing over to the installed connector at {}",
        target.display()
    );
    // Inherited stdio: the child speaks MCP to the client directly and this
    // process only waits. When the client closes the pipes the child sees EOF
    // and exits; when the installer kills the connector (`hooks.nsi` matches
    // by image name) both copies go, and the client sees the server end.
    match std::process::Command::new(&target)
        .args(std::env::args_os().skip(1))
        .env(DELEGATED_ENV, "1")
        .status()
    {
        Ok(status) => Some(status.code().unwrap_or(1)),
        Err(e) => {
            // The installed copy is there but would not start (blocked by
            // AppLocker, half-written by an install in progress, ...). Serving
            // the session from this copy beats failing the client.
            eprintln!(
                "[huginndb-mcp] could not start {} ({e}); serving from this copy instead",
                target.display()
            );
            None
        }
    }
}

/// The decision, kept pure so every branch is testable without a registry or
/// an installed app.
///
/// * Already delegated: never again.
/// * `HUGINNDB_MCP_PATH` set: it is the only candidate. Empty means "do not
///   delegate"; a path that is missing or is this binary means the same.
/// * Otherwise the first candidate that exists, unless it is this binary —
///   the installed copy launched directly, or from a client configured with
///   its path, serves the session itself.
fn pick(
    override_path: Option<&OsStr>,
    already_delegated: bool,
    candidates: &[PathBuf],
    current_exe: &Path,
    is_file: impl Fn(&Path) -> bool,
    same_file: impl Fn(&Path, &Path) -> bool,
) -> Option<PathBuf> {
    if already_delegated {
        return None;
    }
    let found = match override_path {
        Some(path) if path.is_empty() => return None,
        Some(path) => Some(PathBuf::from(path)).filter(|p| is_file(p)),
        None => candidates.iter().find(|p| is_file(p)).cloned(),
    }?;
    (!same_file(&found, current_exe)).then_some(found)
}

/// Both paths name the same file. Canonicalised when possible, so a short
/// 8.3 name or a different letter case is not mistaken for another copy.
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Where the installed connector can be, most authoritative first.
#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    const EXE: &str = "huginndb-mcp.exe";
    let mut out = Vec::new();
    // The installer records where it put the app. Only locating a binary is
    // at stake here, so HKCU is fine (unlike the policy, ADR #94): whoever
    // can write this key can also edit the client's own server config.
    if let Some(dir) = registered_install_dir() {
        out.push(dir.join(EXE));
    }
    // NSIS's per-user default (`installMode` is `currentUser`, gotcha #23).
    if let Some(local) = dirs::data_local_dir() {
        out.push(local.join(PRODUCT_NAME).join(EXE));
    }
    out
}

#[cfg(not(windows))]
fn candidates() -> Vec<PathBuf> {
    // `.deb` / `.rpm` installs are not updated in place by the updater, so a
    // bundle delegating to them would buy nothing. The bundle serves itself.
    Vec::new()
}

/// `InstallLocation` from the uninstall key the NSIS installer writes. The
/// value is stored quoted (`"C:\Users\...\HuginnDB"`), so the quotes go.
#[cfg(windows)]
fn registered_install_dir() -> Option<PathBuf> {
    let key = format!(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
        PRODUCT_NAME
    );
    let raw = windows_registry::CURRENT_USER
        .open(key)
        .and_then(|k| k.get_string("InstallLocation"))
        .ok()?;
    let dir = raw.trim().trim_matches('"');
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn exists<'a>(files: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |p| files.iter().any(|f| Path::new(f) == p)
    }

    fn by_path(a: &Path, b: &Path) -> bool {
        a == b
    }

    const EXTENSION: &str = "/ext/huginndb-mcp";
    const INSTALLED: &str = "/app/huginndb-mcp";
    const DEFAULT: &str = "/local/huginndb-mcp";

    fn candidates() -> Vec<PathBuf> {
        vec![PathBuf::from(INSTALLED), PathBuf::from(DEFAULT)]
    }

    #[test]
    fn the_extension_copy_hands_over_to_the_installed_one() {
        let got = pick(
            None,
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[INSTALLED, DEFAULT]),
            by_path,
        );
        assert_eq!(got, Some(PathBuf::from(INSTALLED)));
    }

    #[test]
    fn a_missing_candidate_falls_through_to_the_next() {
        let got = pick(
            None,
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[DEFAULT]),
            by_path,
        );
        assert_eq!(got, Some(PathBuf::from(DEFAULT)));
    }

    #[test]
    fn without_an_installed_copy_the_extension_serves_itself() {
        let got = pick(
            None,
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[]),
            by_path,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn the_installed_copy_never_delegates_to_itself() {
        let got = pick(
            None,
            false,
            &candidates(),
            Path::new(INSTALLED),
            exists(&[INSTALLED, DEFAULT]),
            by_path,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn a_delegated_child_never_delegates_again() {
        let got = pick(
            None,
            true,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[INSTALLED, DEFAULT]),
            by_path,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn the_override_is_the_only_candidate() {
        let custom = OsString::from("/custom/huginndb-mcp");
        let got = pick(
            Some(&custom),
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&["/custom/huginndb-mcp", INSTALLED]),
            by_path,
        );
        assert_eq!(got, Some(PathBuf::from("/custom/huginndb-mcp")));

        // Pointing at nothing does not fall back to the default lookup.
        let got = pick(
            Some(&custom),
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[INSTALLED]),
            by_path,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn an_empty_override_turns_delegation_off() {
        let empty = OsString::new();
        let got = pick(
            Some(&empty),
            false,
            &candidates(),
            Path::new(EXTENSION),
            exists(&[INSTALLED, DEFAULT]),
            by_path,
        );
        assert_eq!(got, None);
    }

    #[test]
    fn product_name_matches_the_stable_bundle() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(conf["productName"], PRODUCT_NAME);
    }

    #[test]
    fn same_file_sees_through_a_relative_spelling() {
        let dir = std::env::temp_dir();
        let file = dir.join(format!("huginndb-delegate-{}", std::process::id()));
        std::fs::write(&file, b"").unwrap();
        let dotted = dir.join(".").join(file.file_name().unwrap());
        assert!(same_file(&file, &dotted));
        assert!(!same_file(&file, &dir));
        std::fs::remove_file(&file).unwrap();
    }
}
