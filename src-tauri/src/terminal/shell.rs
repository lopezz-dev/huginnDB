//! Which shell a plain terminal starts, and finding programs on `PATH`.
//!
//! Resolved when a session opens, not when the app starts: installing
//! PowerShell 7 or changing `$SHELL` should take effect on the next terminal,
//! not the next launch.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// What a plain terminal runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellChoice {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl ShellChoice {
    /// A short name for the panel's tab: `pwsh`, `powershell`, `bash`, `zsh`.
    pub fn label(&self) -> String {
        self.program
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".into())
    }
}

/// Find `name` in the directories of a `PATH`-style variable. On Windows a
/// bare name is also tried with `.exe`, which is how every program this module
/// looks for is installed.
pub fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    let candidates: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(path).find_map(|dir| {
        candidates
            .iter()
            .map(|c| dir.join(c))
            .find(|full| full.is_file())
    })
}

/// The shell to start: the user's override if set, else the platform default.
pub fn resolve(override_path: &str) -> AppResult<ShellChoice> {
    let override_path = override_path.trim();
    if !override_path.is_empty() {
        let program = PathBuf::from(override_path);
        if !program.is_file() {
            return Err(AppError::Terminal(format!(
                "the shell set in Settings → Terminal does not exist: {override_path}"
            )));
        }
        // No arguments: whoever picked the program knows how it wants to be
        // started, and guessing a `-NoLogo` for something that is not
        // PowerShell would break it.
        return Ok(ShellChoice {
            program,
            args: Vec::new(),
        });
    }
    #[cfg(windows)]
    {
        let path = std::env::var_os("PATH");
        Ok(windows_default(
            find_on_path("pwsh", path.as_deref()),
            std::env::var("SystemRoot").ok().as_deref(),
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(unix_default(
            std::env::var("SHELL").ok().as_deref(),
            cfg!(target_os = "macos"),
            |p| p.is_file(),
        ))
    }
}

/// PowerShell 7 when it is installed (it is what Windows Terminal and VS Code
/// default to), else the Windows PowerShell every Windows has. By full path
/// where it can be: `SystemRoot` is where it lives whatever `PATH` says.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_default(pwsh: Option<PathBuf>, system_root: Option<&str>) -> ShellChoice {
    let program = pwsh.unwrap_or_else(|| match system_root {
        Some(root) => Path::new(root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        None => PathBuf::from("powershell.exe"),
    });
    ShellChoice {
        program,
        args: vec!["-NoLogo".into()],
    }
}

/// `$SHELL` when it names a real file, else `bash`, else `sh`. A login shell
/// on macOS only: a GUI app there does not inherit the login `PATH`, and
/// Terminal.app starts every shell as a login one for that reason; on Linux an
/// interactive shell already reads `.bashrc`, as VS Code assumes.
#[cfg_attr(windows, allow(dead_code))]
fn unix_default(
    shell_env: Option<&str>,
    macos: bool,
    exists: impl Fn(&Path) -> bool,
) -> ShellChoice {
    let from_env = shell_env
        .map(str::trim)
        .filter(|s| s.starts_with('/'))
        .map(PathBuf::from)
        .filter(|p| exists(p));
    let program = from_env
        .or_else(|| Some(PathBuf::from("/bin/bash")).filter(|p| exists(p)))
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    ShellChoice {
        program,
        args: if macos { vec!["-l".into()] } else { Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_prefers_powershell_7_and_falls_back_by_full_path() {
        let pwsh = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert_eq!(
            windows_default(Some(pwsh.clone()), Some(r"C:\Windows")).program,
            pwsh
        );
        let fallback = windows_default(None, Some(r"C:\Windows"));
        assert!(fallback.program.ends_with("powershell.exe"));
        assert!(fallback.program.starts_with(r"C:\Windows"));
        assert_eq!(fallback.args, ["-NoLogo"]);
        assert_eq!(fallback.label(), "powershell");
        assert_eq!(
            windows_default(None, None).program,
            PathBuf::from("powershell.exe")
        );
    }

    #[test]
    fn unix_uses_shell_when_it_exists_then_bash_then_sh() {
        let all = |_: &Path| true;
        let none = |_: &Path| false;
        let only_bash = |p: &Path| p == Path::new("/bin/bash");

        let zsh = unix_default(Some("/usr/bin/zsh"), false, all);
        assert_eq!(zsh.program, PathBuf::from("/usr/bin/zsh"));
        assert_eq!(zsh.label(), "zsh");
        assert!(zsh.args.is_empty());

        // A `$SHELL` naming a removed shell, or a relative one, is skipped.
        assert_eq!(
            unix_default(Some("/usr/bin/fish"), false, only_bash).program,
            PathBuf::from("/bin/bash")
        );
        assert_eq!(
            unix_default(Some("zsh"), false, only_bash).program,
            PathBuf::from("/bin/bash")
        );
        assert_eq!(
            unix_default(None, false, none).program,
            PathBuf::from("/bin/sh")
        );
    }

    #[test]
    fn macos_starts_a_login_shell() {
        assert_eq!(unix_default(Some("/bin/zsh"), true, |_| true).args, ["-l"]);
    }

    #[test]
    fn an_override_that_does_not_exist_is_refused() {
        let err = resolve("/nonexistent/huginndb-shell").unwrap_err();
        assert!(err.to_string().contains("does not exist"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn path_lookup_finds_a_program_and_skips_missing_dirs() {
        let path = std::env::join_paths(["/nonexistent-dir", "/bin", "/usr/bin"]).unwrap();
        let sh = find_on_path("sh", Some(&path)).expect("sh is on every Unix");
        assert!(sh.ends_with("sh"));
        assert!(find_on_path("huginndb-no-such-program", Some(&path)).is_none());
        assert!(find_on_path("sh", None).is_none());
    }
}
