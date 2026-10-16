//! Live pseudo-terminal sessions and the registry that owns them.
//!
//! One session is one child process (a shell, or `mongosh`) attached to one
//! PTY. The registry holds what the commands need to reach it afterwards —
//! the writer for keystrokes, the master for resizes, a killer for closing —
//! and two threads per session do the rest:
//!
//! - **the reader** turns the PTY's output into [`TerminalEvent::Output`]s and,
//!   once the stream ends, sends the one [`TerminalEvent::Exit`];
//! - **the waiter** blocks on the child and, when it exits, drops the session
//!   from the registry.
//!
//! The waiter is not redundant with the reader's end-of-stream. On Windows,
//! ConPTY keeps its output pipe open until the *pseudoconsole* is closed,
//! whether or not anything is still running in it, so the reader would block
//! forever after the shell exits. Dropping the master — which is what removing
//! the session does — closes the pseudoconsole, and that is what ends the
//! reader there. On Unix the reader sees end-of-stream on its own, because the
//! slave side is dropped right after spawning and the child held the last copy.
//!
//! Plain threads, not tokio tasks: every PTY call here is blocking, and two
//! long-lived threads per open terminal is the shape `portable-pty` is built
//! for.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::answer::{Answer, Answerer};
use super::utf8::Utf8Stream;
use crate::error::{AppError, AppResult};

/// What a session reports to the panel, in order: any number of `Output`s,
/// then exactly one `Exit`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// Text the child wrote, escape sequences included — xterm.js interprets
    /// them, this side never does.
    Output { data: String },
    /// The child exited. `code` is `None` when it could not be read (the
    /// process was killed by a signal, or waiting on it failed).
    Exit { code: Option<u32> },
}

/// Where a session's events go. A closure rather than a `tauri::ipc::Channel`
/// so the registry can be exercised in tests without a running app; the
/// command wraps its channel in one.
pub type Sink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

/// Who a session belongs to, so it can be closed along with them.
#[derive(Debug, Clone)]
pub struct Owner {
    /// The window that opened it. Closing that window closes its terminals —
    /// nothing else could ever show them again.
    pub window: String,
    /// The connection a `mongosh` session signed in to. Disconnecting closes
    /// it: it would otherwise outlive the SSH tunnel it may be riding, and
    /// keep a server session open for a connection the user just closed.
    pub connection_id: Option<String>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Shared so a write can happen without holding the registry's lock: a
    /// child that is not reading its input fills the PTY buffer, and a
    /// blocked write must not stall every other terminal with it.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    owner: Owner,
}

/// The output read from a PTY in one go. Large enough that a burst of
/// `printjson` output is a handful of IPC messages rather than hundreds.
const READ_CHUNK: usize = 8 * 1024;

/// How long the reader waits, after end-of-stream, for the waiter to report
/// the exit code before reporting the exit without one. Only reached when
/// output ends while the child is still alive (it closed its own stdout).
const EXIT_CODE_GRACE: Duration = Duration::from_secs(5);

/// Every open terminal session in the app, across windows. Managed as Tauri
/// state of its own rather than a field of `AppState`: nothing about a
/// database connection needs it, and the disconnect hook reaches it through
/// `try_state`.
#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        // A zero-sized PTY makes some programs divide by zero, and xterm.js
        // can report one for a panel that has not been laid out yet.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn pty_error(what: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Terminal(format!("{what}: {e}"))
}

impl TerminalRegistry {
    /// Start `command` in a new PTY of `cols`×`rows` and return the session id.
    ///
    /// `answer` is a question the child asks at startup that the session
    /// answers for it and keeps off the screen — see [`super::answer`].
    pub fn spawn(
        &self,
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        owner: Owner,
        answer: Option<Answer>,
        sink: Sink,
    ) -> AppResult<String> {
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|e| pty_error("could not open a pseudo-terminal", e))?;
        let program = command.get_argv().first().cloned().unwrap_or_default();
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| pty_error(&format!("could not start {}", program.to_string_lossy()), e))?;
        // The child holds its own copy now. Keeping ours would stop the
        // reader ever seeing end-of-stream on Unix.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| pty_error("could not read from the terminal", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| pty_error("could not write to the terminal", e))?;
        let killer = child.clone_killer();
        let writer = Arc::new(Mutex::new(writer));

        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().insert(
            id.clone(),
            Session {
                master: pair.master,
                writer: Arc::clone(&writer),
                killer,
                owner,
            },
        );

        // `None` until the waiter knows; then `Some(code)`.
        let exit: Arc<(Mutex<Option<Option<u32>>>, Condvar)> =
            Arc::new((Mutex::new(None), Condvar::new()));

        let waiter = {
            let exit = Arc::clone(&exit);
            let sessions = Arc::clone(&self.sessions);
            let id = id.clone();
            move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                *exit.0.lock() = Some(code);
                exit.1.notify_all();
                // See the module docs: on Windows this is what ends the reader.
                sessions.lock().remove(&id);
            }
        };
        let reader_loop = move || {
            let mut decoder = Utf8Stream::default();
            let mut answerer = answer.as_ref().map(Answerer::new);
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut text = decoder.push(&buf[..n]);
                        if let (Some(answerer), Some(answer)) = (answerer.as_mut(), answer) {
                            let step = answerer.push(&text);
                            if step.reply {
                                // Best effort: if the write fails the prompt
                                // simply waits for the user, as it did before.
                                let mut writer = writer.lock();
                                let _ = writer
                                    .write_all(answer.reply.as_bytes())
                                    .and_then(|()| writer.flush());
                            }
                            text = step.emit;
                        }
                        if !text.is_empty() {
                            sink(TerminalEvent::Output { data: text });
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    // EIO is how Linux reports "the other side hung up" on a
                    // PTY master; every error ends the stream the same way.
                    Err(_) => break,
                }
            }
            let mut tail = answerer.as_mut().map(Answerer::finish).unwrap_or_default();
            tail.push_str(&decoder.finish());
            if !tail.is_empty() {
                sink(TerminalEvent::Output { data: tail });
            }
            let code = {
                let mut known = exit.0.lock();
                if known.is_none() {
                    exit.1.wait_for(&mut known, EXIT_CODE_GRACE);
                }
                known.flatten()
            };
            sink(TerminalEvent::Exit { code });
        };

        let started = std::thread::Builder::new()
            .name("terminal-wait".into())
            .spawn(waiter)
            .and_then(|_| {
                std::thread::Builder::new()
                    .name("terminal-read".into())
                    .spawn(reader_loop)
            });
        if let Err(e) = started {
            self.close(&id);
            return Err(pty_error("could not start the terminal threads", e));
        }
        Ok(id)
    }

    /// Send keystrokes (or a paste) to the session's child.
    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let writer = self
            .sessions
            .lock()
            .get(id)
            .map(|s| Arc::clone(&s.writer))
            .ok_or_else(|| AppError::NotFound(format!("terminal session {id}")))?;
        let mut writer = writer.lock();
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|e| pty_error("could not write to the terminal", e))
    }

    /// Tell the child its window changed size (`SIGWINCH` on Unix).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("terminal session {id}")))?;
        session
            .master
            .resize(pty_size(cols, rows))
            .map_err(|e| pty_error("could not resize the terminal", e))
    }

    /// End a session: kill its child and drop the PTY. A no-op for a session
    /// that already ended on its own — the panel closes tabs of exited
    /// sessions too, and that must not read as an error.
    pub fn close(&self, id: &str) {
        let session = self.sessions.lock().remove(id);
        if let Some(mut session) = session {
            let _ = session.killer.kill();
        }
    }

    /// Close every session `matches` selects. Returns how many were closed.
    pub fn close_where(&self, matches: impl Fn(&Owner) -> bool) -> usize {
        let doomed: Vec<Session> = {
            let mut sessions = self.sessions.lock();
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| matches(&s.owner))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        let n = doomed.len();
        for mut session in doomed {
            let _ = session.killer.kill();
        }
        n
    }

    /// Close every session a window opened.
    pub fn close_window(&self, window: &str) -> usize {
        self.close_where(|o| o.window == window)
    }

    /// Close every `mongosh` session signed in to a connection.
    pub fn close_connection(&self, connection_id: &str) -> usize {
        self.close_where(|o| o.connection_id.as_deref() == Some(connection_id))
    }

    /// Close everything — on app exit.
    pub fn close_all(&self) -> usize {
        self.close_where(|_| true)
    }

    #[cfg(all(test, unix))]
    fn len(&self) -> usize {
        self.sessions.lock().len()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    fn owner(window: &str, connection_id: Option<&str>) -> Owner {
        Owner {
            window: window.into(),
            connection_id: connection_id.map(str::to_string),
        }
    }

    /// A sink that forwards to a channel the test reads from.
    fn sink() -> (Sink, mpsc::Receiver<TerminalEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |e| {
                let _ = tx.lock().send(e);
            }),
            rx,
        )
    }

    /// Everything up to and including the `Exit`, with the output joined.
    fn drain(rx: &mpsc::Receiver<TerminalEvent>) -> (String, Option<u32>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut out = String::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("the session never exited") {
                TerminalEvent::Output { data } => out.push_str(&data),
                TerminalEvent::Exit { code } => return (out, code),
            }
        }
    }

    fn sh(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[test]
    fn output_then_exit_code_arrive_and_the_session_is_dropped() {
        let registry = TerminalRegistry::default();
        let (sink, rx) = sink();
        registry
            .spawn(
                sh("printf 'año\\n'; exit 3"),
                80,
                24,
                owner("main", None),
                None,
                sink,
            )
            .unwrap();
        let (out, code) = drain(&rx);
        assert!(out.contains("año"), "got {out:?}");
        assert_eq!(code, Some(3));
        let deadline = Instant::now() + Duration::from_secs(5);
        while registry.len() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(registry.len(), 0, "the waiter removes an exited session");
    }

    #[test]
    fn input_reaches_the_child_through_a_real_tty() {
        let registry = TerminalRegistry::default();
        let (sink, rx) = sink();
        // `test -t 0` is what an interactive program checks before it shows a
        // prompt; piped stdio would fail it.
        let id = registry
            .spawn(
                sh("test -t 0 && echo tty; read line; echo \"got:$line\""),
                80,
                24,
                owner("main", None),
                None,
                sink,
            )
            .unwrap();
        registry.write(&id, b"hello\r").unwrap();
        let (out, code) = drain(&rx);
        assert!(out.contains("tty"), "got {out:?}");
        assert!(out.contains("got:hello"), "got {out:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn resize_is_seen_by_the_child() {
        let registry = TerminalRegistry::default();
        let (sink, rx) = sink();
        let id = registry
            .spawn(
                sh("read _; stty size"),
                80,
                24,
                owner("main", None),
                None,
                sink,
            )
            .unwrap();
        registry.resize(&id, 132, 40).unwrap();
        registry.write(&id, b"\r").unwrap();
        let (out, _) = drain(&rx);
        assert!(out.contains("40 132"), "got {out:?}");
    }

    #[test]
    fn closing_kills_the_child_and_still_reports_the_exit() {
        let registry = TerminalRegistry::default();
        let (sink, rx) = sink();
        let id = registry
            .spawn(sh("sleep 60"), 80, 24, owner("main", None), None, sink)
            .unwrap();
        registry.close(&id);
        let (_, _code) = drain(&rx);
        assert_eq!(registry.len(), 0);
        registry.close(&id); // already gone: a no-op, not a panic
        assert!(matches!(
            registry.write(&id, b"x"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn sessions_close_with_their_window_or_their_connection() {
        let registry = TerminalRegistry::default();
        let mut receivers = Vec::new();
        for o in [
            owner("main", Some("conn-a")),
            owner("main", None),
            owner("second", Some("conn-a")),
            owner("second", Some("conn-b")),
        ] {
            let (sink, rx) = sink();
            registry
                .spawn(sh("sleep 60"), 80, 24, o, None, sink)
                .unwrap();
            receivers.push(rx);
        }
        assert_eq!(registry.close_connection("conn-a"), 2);
        assert_eq!(registry.close_window("second"), 1, "conn-b's, in 'second'");
        assert_eq!(registry.close_all(), 1, "the plain shell in 'main'");
        for rx in &receivers {
            drain(rx);
        }
    }

    #[test]
    fn a_program_that_does_not_exist_is_an_error_not_a_session() {
        let registry = TerminalRegistry::default();
        let (sink, _rx) = sink();
        let err = registry
            .spawn(
                CommandBuilder::new("/nonexistent/huginndb-no-such-program"),
                80,
                24,
                owner("main", None),
                None,
                sink,
            )
            .unwrap_err();
        assert!(matches!(err, AppError::Terminal(_)), "{err}");
        assert_eq!(registry.len(), 0);
    }
}
