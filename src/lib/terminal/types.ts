/**
 * Wire types of the terminal panel — mirrors of `commands::terminal` and
 * `terminal::session` in the backend.
 */

/** `TerminalEvent` (Rust): any number of `output`s, then exactly one `exit`. */
export type TerminalEvent =
  | { kind: "output"; data: string }
  /** `code` is `null` when it could not be read (killed by a signal). */
  | { kind: "exit"; code: number | null };

/** `TerminalEnvironment` (Rust): what can be started on this machine. */
export interface TerminalEnvironment {
  /** `pwsh`, `powershell`, `bash`, `zsh` …; `null` when the configured
   *  override does not exist (see `shellError`). */
  shell: string | null;
  shellPath: string | null;
  shellError: string | null;
  mongoshPath: string | null;
  /** `mongosh --version`, when it answered. */
  mongoshVersion: string | null;
  /** Why `mongosh` cannot be started: not found (with the download link), or
   *  a configured path that does not exist. */
  mongoshError: string | null;
  /** The `mongosh` in use is the copy HuginnDB downloaded, not one the user
   *  installed. */
  mongoshManaged: boolean;
  /** Version of HuginnDB's own copy, when one is installed (whether or not
   *  it is the one in use). */
  mongoshManagedVersion: string | null;
  /** There is no `mongosh` anywhere it looks and no path is configured — what
   *  a download fixes. A configured path that does not exist is not this. */
  mongoshMissing: boolean;
  /** MongoDB publishes a build HuginnDB can unpack for this machine. */
  mongoshDownloadable: boolean;
}

/** `InstallEvent` (Rust): what a `mongosh` download reports, in order.
 *  `downloading` repeats; the others happen once. */
export type MongoshInstallEvent =
  | { kind: "checking" }
  | { kind: "downloading"; version: string; received: number; total: number | null }
  | { kind: "verifying" }
  | { kind: "extracting" };

/** `Installed` (Rust): a finished download. */
export interface MongoshInstalled {
  version: string;
  path: string;
}

/** What a terminal tab runs. */
export type TerminalKind = "shell" | "mongosh";
