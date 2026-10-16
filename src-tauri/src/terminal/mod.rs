//! The terminal panel's backend: pseudo-terminal sessions running either the
//! user's shell or `mongosh` signed in as a MongoDB connection.
//!
//! The frontend renders with xterm.js and never starts a process itself
//! (architecture invariant: the interface does no I/O of its own). It opens a
//! session through `commands::terminal`, receives output on a
//! `tauri::ipc::Channel`, and sends keystrokes and resizes back by session id.
//!
//! - [`session`] — the PTY sessions and their registry.
//! - [`shell`] — which shell a plain terminal starts.
//! - [`mongosh`] — finding `mongosh` and the URI it signs in with.
//! - [`answer`] — answering a question a child asks at startup, unseen.
//! - [`utf8`] — decoding output read in arbitrary chunks.

pub mod answer;
pub mod download;
pub mod mongosh;
pub mod session;
pub mod shell;
mod utf8;

pub use session::{Owner, TerminalEvent, TerminalRegistry};

use portable_pty::CommandBuilder;

/// What every session's environment gets on top of the app's own: the
/// terminal type xterm.js emulates, so programs pick their colours and
/// line-editing accordingly, and a `TERM_PROGRAM` a shell profile can test.
/// The working directory is the user's home, as in any new terminal window —
/// the app's own working directory is wherever it happened to be launched.
pub fn prepare(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "HuginnDB");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
}
