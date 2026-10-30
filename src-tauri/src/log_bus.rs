//! Structured log bus.
//!
//! Every command that touches the database (query execution, table-data
//! paging, cell edits, row inserts/deletes, connection lifecycle) emits a
//! [`LogEntry`] through this module. The frontend listens for the
//! `huginndb://log` Tauri event and renders the entries in the Console
//! panel — analogous to HeidiSQL's SQL log.
//!
//! Design rules:
//!
//! * Emission is fire-and-forget. A failure inside `emit()` must never
//!   propagate up and break the originating DB operation. We swallow
//!   the error silently — at worst the user loses an entry from a
//!   debugging panel.
//! * Entries are flat (no enums in the wire payload) so the TypeScript
//!   side can mirror them with a single interface and no discriminator
//!   parsing.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Tauri event name the frontend subscribes to.
pub const LOG_EVENT: &str = "huginndb://log";

/// Monotonic id source so each entry is uniquely addressable in the
/// frontend store even when two events share the same millisecond.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Coarse-grained kind of operation being logged. Stays as a string on
/// the wire to keep the TS type trivial.
#[derive(Debug, Clone, Copy)]
pub enum LogKind {
    /// A SQL statement was sent to the engine.
    Sql,
    /// A connection lifecycle event (open / close / smoke-test).
    Connection,
    /// One step of the AI panel's agent loop: what it was offered, what it
    /// called, and how much came back. Its own kind so the Console can filter
    /// to it — a user auditing what the assistant did should not have to read
    /// past their own statements to do it.
    Ai,
}

impl LogKind {
    fn as_str(self) -> &'static str {
        match self {
            LogKind::Sql => "sql",
            LogKind::Connection => "connection",
            LogKind::Ai => "ai",
        }
    }
}

/// One log line shipped to the frontend.
///
/// Every field except `id`, `timestamp_ms`, and `kind` is optional —
/// connection events have no SQL, SQL events have no `message`, errors
/// populate `error` and leave `rows_affected` empty, etc.
#[derive(Debug, Serialize, Clone)]
pub struct LogEntry {
    pub id: u64,
    pub timestamp_ms: u64,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LogEntry {
    /// Build an entry with id + timestamp pre-filled. Use the builder-style
    /// setters below to populate the rest.
    pub fn new(kind: LogKind) -> Self {
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_ms(),
            kind: kind.as_str(),
            connection_id: None,
            driver: None,
            sql: None,
            message: None,
            duration_ms: None,
            rows_affected: None,
            error: None,
        }
    }

    pub fn connection_id(mut self, v: impl Into<String>) -> Self {
        self.connection_id = Some(v.into());
        self
    }

    pub fn driver(mut self, v: impl Into<String>) -> Self {
        self.driver = Some(v.into());
        self
    }

    pub fn sql(mut self, v: impl Into<String>) -> Self {
        self.sql = Some(v.into());
        self
    }

    pub fn message(mut self, v: impl Into<String>) -> Self {
        self.message = Some(v.into());
        self
    }

    pub fn duration_ms(mut self, v: u64) -> Self {
        self.duration_ms = Some(v);
        self
    }

    pub fn rows_affected(mut self, v: u64) -> Self {
        self.rows_affected = Some(v);
        self
    }

    pub fn error(mut self, v: impl Into<String>) -> Self {
        self.error = Some(v.into());
        self
    }
}

/// Abstract destination for [`LogEntry`]s produced by the shared data path.
///
/// The GUI ships entries to a specific window over Tauri; the headless
/// `huginndb-mcp` binary has no window (nor an [`AppHandle`]) and simply
/// drops them. Threading a `&dyn LogSink` through the query/table-data
/// functions lets that path stop depending on Tauri directly, so the same
/// code runs under both the desktop app and the MCP server.
pub trait LogSink: Send + Sync {
    /// Record one entry. Fire-and-forget, like [`emit`] — an implementation
    /// must never fail the originating DB operation.
    fn log(&self, entry: LogEntry);
}

/// [`LogSink`] that emits to one window via [`emit`]. Used by the GUI's
/// `#[tauri::command]` wrappers, which have an [`AppHandle`] and the label of
/// the invoking window.
pub struct TauriSink<'a> {
    app: &'a AppHandle,
    window_label: String,
}

impl<'a> TauriSink<'a> {
    pub fn new(app: &'a AppHandle, window_label: &str) -> Self {
        Self {
            app,
            window_label: window_label.to_string(),
        }
    }
}

impl LogSink for TauriSink<'_> {
    fn log(&self, entry: LogEntry) {
        emit(self.app, &self.window_label, entry);
    }
}

/// Emit a SQL [`LogEntry`] through a [`LogSink`] after a statement finished.
///
/// The single logging path for every statement the app runs, whoever ran it:
/// a GUI command hands in a window-scoped [`TauriSink`], the headless
/// `huginndb-mcp` binary hands in a `NoopSink`, and the `_inner` cores they
/// share stay Tauri-independent because neither knows which it got.
///
/// It lives here, next to [`LogEntry`], rather than in `commands::query`
/// where it started, because `db::mongo::query` needs it too and the layers
/// below `commands` do not depend upward. That module and `commands::bulk`
/// each rebuilt the same six-field builder chain by hand, twice — once per arm
/// of an `Ok`/`Err` match. The six copies happened to agree; keeping them in
/// step was nobody's job, which is the problem, since a Console entry that
/// quietly stops carrying `rows_affected` or `duration_ms` looks like a
/// missing feature rather than a bug.
#[allow(clippy::too_many_arguments)]
pub(crate) fn log_sql_sink(
    sink: &dyn LogSink,
    connection_id: &str,
    driver: &str,
    sql: &str,
    start: std::time::Instant,
    rows_affected: Option<u64>,
    error: Option<&str>,
) {
    let mut entry = LogEntry::new(LogKind::Sql)
        .connection_id(connection_id)
        .driver(driver)
        .sql(sql)
        .duration_ms(start.elapsed().as_millis() as u64);
    if let Some(r) = rows_affected {
        entry = entry.rows_affected(r);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    sink.log(entry);
}

/// [`log_sql_sink`] with the three arguments that never change within one
/// command — where entries go, which connection, which driver — said once.
///
/// What it removes is the shape most call sites had: a `match &res` whose two
/// arms were the same seven-argument call, differing only in whether they
/// passed the row count or the error. [`Self::outcome`] is that match, and it
/// hands the result back, so the call site stays one expression.
#[derive(Clone, Copy)]
pub(crate) struct SqlLog<'a> {
    sink: &'a dyn LogSink,
    connection_id: &'a str,
    driver: &'a str,
}

impl<'a> SqlLog<'a> {
    pub(crate) fn new(sink: &'a dyn LogSink, connection_id: &'a str, driver: &'a str) -> Self {
        Self {
            sink,
            connection_id,
            driver,
        }
    }

    /// `sql` finished and produced or affected `rows`.
    pub(crate) fn ok(&self, sql: &str, start: std::time::Instant, rows: u64) {
        log_sql_sink(
            self.sink,
            self.connection_id,
            self.driver,
            sql,
            start,
            Some(rows),
            None,
        );
    }

    /// `sql` failed with `error`.
    pub(crate) fn err(&self, sql: &str, start: std::time::Instant, error: &str) {
        log_sql_sink(
            self.sink,
            self.connection_id,
            self.driver,
            sql,
            start,
            None,
            Some(error),
        );
    }

    /// Log `result` — the count `rows` reads from it on success, its error's
    /// text on failure — and return it untouched.
    pub(crate) fn outcome<T, E: std::fmt::Display>(
        &self,
        sql: &str,
        start: std::time::Instant,
        result: Result<T, E>,
        rows: impl FnOnce(&T) -> u64,
    ) -> Result<T, E> {
        match &result {
            Ok(v) => self.ok(sql, start, rows(v)),
            Err(e) => self.err(sql, start, &e.to_string()),
        }
        result
    }
}

/// [`LogSink`] that discards every entry. Used by the headless MCP binary,
/// which has no Console panel to feed — hence gated to the `mcp` feature.
#[cfg(feature = "mcp")]
pub struct NoopSink;

#[cfg(feature = "mcp")]
impl LogSink for NoopSink {
    fn log(&self, _entry: LogEntry) {}
}

/// Push an entry onto the bus, targeted at the window that triggered it.
///
/// Uses `emit_to` rather than a broadcast `emit`: every window (main or a
/// secondary "New window") mounts the same frontend and would otherwise all
/// receive — and independently render — every other window's Console
/// entries, making a secondary window look like a pointless copy of the
/// main one. Errors from the Tauri emitter are swallowed on purpose — see
/// the module-level note.
pub fn emit(app: &AppHandle, window_label: &str, entry: LogEntry) {
    let _ = app.emit_to(window_label, LOG_EVENT, entry);
}

/// Push an entry to every open window.
///
/// For entries with no single originating window — background tasks like
/// [`crate::keepalive`], which report on a connection shared by every
/// window that may be browsing it — broadcasting is correct: unlike a
/// command-triggered [`emit`], there's no "wrong" window to filter out.
pub fn broadcast(app: &AppHandle, entry: LogEntry) {
    let _ = app.emit(LOG_EVENT, entry);
}

/// Current wall-clock time in milliseconds since the Unix epoch.
/// Falls back to `0` on the (impossible-in-practice) error path so
/// callers never have to deal with a `Result` for a logging side-effect.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
