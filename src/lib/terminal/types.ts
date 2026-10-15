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
}

/** What a terminal tab runs. */
export type TerminalKind = "shell" | "mongosh";
