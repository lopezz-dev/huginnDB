//! Common error type returned from every Tauri command.
//!
//! Errors are serialised to the frontend as plain strings via the manual
//! [`Serialize`] impl below; the frontend renders them to the user as-is.
//! Wrapping native error types here (instead of returning `String`
//! directly) keeps Rust call sites idiomatic and allows future structured
//! error reporting without changing the wire format.

use serde::Serialize;
use thiserror::Error;

/// The error type every Tauri command returns. Each variant maps to one
/// failure domain; the `#[error(...)]` prefix is what the user actually sees,
/// so keep those messages actionable.
#[derive(Debug, Error)]
pub enum AppError {
    /// SQL driver or pool failure surfaced by `sqlx`.
    ///
    /// Deliberately **not** `#[from]`: the manual `From<sqlx::Error>` impl
    /// below classifies connection-limit failures into
    /// [`Self::TooManyConnections`] first. Routing every `?` through that one
    /// conversion is what makes the classification exhaustive — a `#[from]`
    /// here would silently bypass it at any call site that didn't opt in.
    #[error("database error: {0}")]
    Database(sqlx::Error),

    /// MongoDB driver, command, or BSON failure surfaced by the `mongodb` crate.
    /// Same reasoning as [`Self::Database`] for the manual conversion.
    ///
    /// **Renders the `kind` alone, not the whole error.** `mongodb::error::Error`'s
    /// own `Display` is
    /// `"Kind: {kind}, labels: {labels:?}, source: {source:?}, server response: {server_response:?}"`,
    /// and `RawDocumentBuf`'s `Debug` is a **hex dump of its bytes** — so every
    /// Mongo *command* error used to end with a hex encoding of the entire
    /// server reply, in a string the user reads. `labels` and `source` are
    /// empty in almost every case the user sees; the `kind` is the whole
    /// sentence. See ADR #68.
    ///
    /// Only the *rendering* narrows: `From<mongodb::error::Error>` below still
    /// scans the full `to_string()` for the connection-limit needles, because
    /// there the extra text can only help. Do not "unify" the two.
    #[error("mongodb error: {}", .0.kind)]
    Mongo(mongodb::error::Error),

    /// The server refused the connection because it is at its connection
    /// limit (Postgres `53300`/`53400`, MySQL `1040`/`1203`), or the driver's
    /// own pool timed out waiting for a slot.
    ///
    /// Split out of [`Self::Database`] / [`Self::Mongo`] because it is the one
    /// driver failure the *client* can act on: HuginnDB knows how many pools
    /// it is holding and can offer to release them. The frontend keys its
    /// "close idle pools and retry" affordance — and the circuit breaker that
    /// stops the schema explorer's cross-database fan-out from re-firing
    /// against an already-saturated server — off this variant, matched via the
    /// [`TOO_MANY_CONNECTIONS_TAG`] marker the message carries.
    #[error("{TOO_MANY_CONNECTIONS_TAG}: {0}")]
    TooManyConnections(String),

    /// SQL Server (TDS) failure surfaced by the `tiberius` crate. Kept separate
    /// from [`Self::Database`] because SQL Server does not go through `sqlx`
    /// (see [`crate::db::mssql`]); its `Server` variant already carries the
    /// server's own message and number, which is what the user needs to see.
    #[error("sql server error: {0}")]
    MsSql(#[from] tiberius::error::Error),

    /// OS keychain failure (Credential Manager / libsecret / Keychain).
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    /// Filesystem I/O failure when reading or writing profile metadata.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialisation failure for persisted profiles.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// A caller-provided argument failed validation.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A command was invoked against a profile that has no live connection.
    #[error("not connected: {0}")]
    NotConnected(String),

    /// Lookup failure for a profile, password, or other addressable resource.
    #[error("not found: {0}")]
    NotFound(String),

    /// A connection needs a password the keychain does not hold (the payload
    /// is the keychain account). Its own variant because it is the one
    /// connect failure the app can finish for the user: the frontend matches
    /// [`MISSING_PASSWORD_TAG`] and asks for the password instead of showing
    /// an error — which is what a person's first connect with their own
    /// database user always meets (`crate::credentials`).
    #[error("{MISSING_PASSWORD_TAG} for keychain account {0}")]
    MissingPassword(String),

    /// A network operation exceeded its allotted budget. Most likely the
    /// underlying socket died silently — a NAT/firewall dropping an idle
    /// connection without a FIN/RST — rather than the server refusing
    /// anything, so nothing else in this enum fits: no driver error was ever
    /// raised, the call simply never came back.
    #[error("operation timed out: {0}")]
    OperationTimedOut(String),

    /// The connection's driver does not support the requested operation (e.g.
    /// view editing against MongoDB). Distinct from [`Self::InvalidInput`]:
    /// the argument was well-formed, the *backend* can't honour it.
    #[error("unsupported driver: {0}")]
    UnsupportedDriver(String),

    /// SSH transport, authentication, or channel failure surfaced by `russh`.
    #[error("ssh error: {0}")]
    Ssh(String),

    /// Import/export error (format validation, encryption, decryption).
    #[error("transfer error: {0}")]
    Transfer(String),

    /// Outbound HTTP failure surfaced by `reqwest` (in-app issue reporter).
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    /// The AI panel's inference endpoint refused, or answered something the
    /// stream reader could not use.
    ///
    /// Its own variant rather than [`Self::Network`] or [`Self::InvalidInput`]
    /// because the panel has to tell three failures apart, and only this one is
    /// about the *endpoint*: a model that is unreachable or returns a 4xx is a
    /// configuration problem the user fixes in Settings → AI, a tool call with
    /// a bad table name is the model's mistake to retry, and a driver error is
    /// the database's. [`Self::Network`] cannot carry the first: `reqwest`
    /// raises no error for an HTTP status, and a refusal streamed as a frame
    /// after a `200` raises none at all.
    #[error("inference error: {0}")]
    Inference(String),

    /// An extension registry (Open VSX) was unreachable, or answered with a
    /// status rather than a body.
    ///
    /// Its own variant rather than [`Self::Network`] for the same reason
    /// [`Self::Inference`] is: `reqwest` raises no error for an HTTP status,
    /// so a `503` — which this registry returns intermittently, often enough
    /// that retries are a requirement rather than politeness — produces a
    /// perfectly successful `Response` that the caller must still treat as a
    /// failure. It also separates "the theme registry is having a bad
    /// afternoon", which the user can only wait out, from a malformed
    /// package, which is [`Self::InvalidInput`] and will never succeed.
    #[error("registry error: {0}")]
    Registry(String),

    /// A pseudo-terminal could not be opened, written to or resized, or the
    /// program it was asked to run (`mongosh`, a shell) could not be found or
    /// started. `portable-pty` reports through `anyhow`, so the cause arrives
    /// already rendered.
    #[error("terminal error: {0}")]
    Terminal(String),

    /// Tauri window-management failure (e.g. creating a new window).
    #[error("window error: {0}")]
    Window(#[from] tauri::Error),

    /// A failure the desktop app reported over the MCP bridge, carried to the
    /// sidecar's client **verbatim**.
    ///
    /// The payload is not a detail to be prefixed: it is already a rendered
    /// [`AppError`] — `bridge::server::handle` serialises the app-side error
    /// with its `Display`, variant prefix included. Wrapping it in any other
    /// variant (it used to be [`Self::InvalidInput`]) prints that prefix a
    /// second time, so a policy refusal read `invalid input: invalid input:
    /// …` through the bridge and `invalid input: …` on the sidecar's own
    /// no-app path. Rendering it unchanged is what makes the two paths read
    /// the same, and it keeps the [`TOO_MANY_CONNECTIONS_TAG`] /
    /// [`MISSING_PASSWORD_TAG`] markers at the start of the string, where a
    /// matcher expects them.
    ///
    /// Only constructed by the MCP sidecar, hence the allowance in builds
    /// without the `mcp` feature.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    #[error("{0}")]
    Bridged(String),
}

/// Stable marker prefixed to every [`AppError::TooManyConnections`] message.
///
/// Errors cross the IPC boundary as plain strings (see the [`Serialize`] impl
/// below), so this is the only thing the frontend can match on. Changing it
/// breaks `isTooManyConnections` in `src/lib/db/driver.ts` — keep the two in
/// sync.
pub const TOO_MANY_CONNECTIONS_TAG: &str = "too many connections";

/// Stable marker every [`AppError::MissingPassword`] message starts with. The
/// same text `require_password` has always produced, so nothing that already
/// read it changes. Matched by `isMissingPassword` in `src/lib/db/driver.ts`;
/// keep the two in sync.
pub const MISSING_PASSWORD_TAG: &str = "no stored password";

/// Message of the [`AppError::Transfer`] raised when the user closes the native
/// save dialog instead of picking a file.
///
/// Not an error the user should see: five export commands return it, and every
/// caller has to tell it apart from a real failure so it can stay quiet.
/// Crosses the IPC boundary as a plain string like everything else, so it is
/// matched by substring — see `isExportCancelled` in `src/lib/db/driver.ts`,
/// and keep the two in sync.
pub const EXPORT_CANCELLED: &str = "export cancelled";

/// Substrings that identify a connection-limit refusal in a driver's own
/// message. Checked case-insensitively as a fallback for the drivers whose
/// structured error codes don't cleanly single the condition out.
///
/// MySQL is the reason this list exists: `ER_CON_COUNT_ERROR` (1040) reports
/// SQLSTATE `08004`, which is the generic "server rejected the connection",
/// and `ER_TOO_MANY_USER_CONNECTIONS` (1203) reports `42000`, which is the
/// generic syntax/access class — neither is specific enough to match on. The
/// error *numbers* are, and we check those first via a downcast; the text
/// check then covers the pre-auth path, where the failure can arrive before
/// there is a structured `DatabaseError` at all.
const TOO_MANY_CONNECTIONS_NEEDLES: &[&str] = &[
    // Postgres, and MySQL/MariaDB, which phrase it identically ("Too many
    // connections") — one entry covers both, and this list used to carry it
    // twice under two comments as if they were different strings.
    "too many connections",
    "remaining connection slots are reserved",
    // MySQL / MariaDB
    "max_user_connections",
    // Generic pooler phrasing (pgbouncer: "no more connections allowed")
    "no more connections allowed",
];

/// Whether `message` looks like a connection-limit refusal.
fn message_signals_connection_limit(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    TOO_MANY_CONNECTIONS_NEEDLES
        .iter()
        .any(|needle| lowered.contains(needle))
}

/// Classify a `sqlx` error as a connection-limit refusal, returning the detail
/// to surface when it is one.
///
/// Postgres is matched on SQLSTATE, which is unambiguous: `53300`
/// (`too_many_connections`) and `53400` (`configuration_limit_exceeded`).
/// MySQL is matched on the driver error number, since its SQLSTATE isn't
/// specific (see [`TOO_MANY_CONNECTIONS_NEEDLES`]). Everything else falls back
/// to the message scan, which also covers `PoolTimedOut` — our *own* pool
/// giving up waiting, which is the same class of problem from the user's point
/// of view even though no server said so.
///
/// That last arm is only sound for `acquire()` on an **established** pool.
/// While a pool is being *created* `sqlx` also reports `PoolTimedOut` for a
/// server it never reached, having retried and discarded the real error — so
/// `crate::db::pool::open_pool` classifies its own failures through
/// `pool::open_time_error` instead of reaching here. See ADR #66.
fn sqlx_connection_limit_detail(error: &sqlx::Error) -> Option<String> {
    if let sqlx::Error::Database(db) = error {
        if matches!(db.code().as_deref(), Some("53300") | Some("53400")) {
            return Some(db.message().to_string());
        }
        if let Some(my) = db.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
            if matches!(my.number(), 1040 | 1203) {
                return Some(db.message().to_string());
            }
        }
        if message_signals_connection_limit(db.message()) {
            return Some(db.message().to_string());
        }
        return None;
    }
    let rendered = error.to_string();
    if message_signals_connection_limit(&rendered) {
        return Some(rendered);
    }
    // Our own pool ran out of slots waiting for one to free up. Not the
    // server's limit, but the user-facing remedy is identical: fewer pools, or
    // a bigger ceiling. Reaching this means an `acquire()` on a pool that
    // already exists — the open path never gets here (see the note above).
    if matches!(error, sqlx::Error::PoolTimedOut) {
        return Some(
            "HuginnDB's own connection pool timed out waiting for a free slot".to_string(),
        );
    }
    None
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        match sqlx_connection_limit_detail(&error) {
            Some(detail) => AppError::TooManyConnections(detail),
            None => AppError::Database(error),
        }
    }
}

impl From<mongodb::error::Error> for AppError {
    fn from(error: mongodb::error::Error) -> Self {
        // The driver has no dedicated "server is full" error kind we can match
        // structurally; a saturated deployment surfaces either as a
        // wait-queue timeout on the client pool or as a server-selection
        // failure whose message carries the reason. The text scan covers both.
        let rendered = error.to_string();
        if message_signals_connection_limit(&rendered) || rendered.contains("wait queue timeout") {
            return AppError::TooManyConnections(rendered);
        }
        AppError::Mongo(error)
    }
}

impl AppError {
    /// Whether this error is the connection-limit refusal callers may want to
    /// react to (release idle pools, stop retrying) rather than just report.
    pub fn is_too_many_connections(&self) -> bool {
        matches!(self, AppError::TooManyConnections(_))
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Shorthand for `Result<T, AppError>`.
pub type AppResult<T> = Result<T, AppError>;

/// Run `fut`, turning a stall past `limit` into an
/// [`AppError::OperationTimedOut`] instead of hanging forever.
///
/// Reserved for read-only introspection (metadata listing, the keepalive
/// ping) that is fast by nature — a data query the user typed can legitimately
/// run long, so query/bulk/dump paths never wrap their work in this.
///
/// **There is deliberately no default-taking wrapper.** There used to be one,
/// applying a hard 20 s to every caller, and it was the whole bug: the limit is
/// a property of the server being called, so a function that cannot see which
/// server that is cannot choose it correctly. Every caller either knows the
/// connection ([`with_timeout_for`]) or has resolved the limit already.
///
/// The message names the fix, not just the failure. A bare "took longer than
/// 20s" reads as a broken connection — which is exactly the wrong conclusion
/// when the connection is fine and the server is merely large — and leaves the
/// user with nothing to do about it. Same rule as ADR #77: text a person
/// acts on has to say what the action is.
pub async fn with_timeout_secs<T>(
    limit: std::time::Duration,
    what: &str,
    fut: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result,
        Err(_) => Err(AppError::OperationTimedOut(format!(
            "{what} took longer than {}s — the connection may be unresponsive.              If this server is simply slow or very large, raise \"Operation timeout\"              in its connection settings.",
            limit.as_secs()
        ))),
    }
}

/// [`with_timeout_secs`] honouring what the user said about *this* connection:
/// the profile's own `operation_timeout_secs`, else the global preference.
///
/// **`connection_id` may be a synthetic per-database view id**
/// (`<parent>::db::<name>`), which no profile is stored under. It is resolved
/// through [`crate::state::parent_connection_id`] first, so a database view
/// inherits its parent's ceiling instead of silently falling back to the
/// default — the views are where most metadata calls actually happen.
pub async fn with_timeout_for<T>(
    state: &crate::state::AppState,
    connection_id: &str,
    what: &str,
    fut: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    with_timeout_secs(connection_timeout(state, connection_id), what, fut).await
}

/// The introspection ceiling in force for `connection_id`. Falls back to the
/// preference-only value when no profile matches, which is the case for an
/// ad-hoc CLI connection.
pub fn connection_timeout(
    state: &crate::state::AppState,
    connection_id: &str,
) -> std::time::Duration {
    let preference = state.prefs.read().connections.operation_timeout_secs;
    let root = crate::state::parent_connection_id(connection_id);
    let profiles = state.profiles.read();
    match profiles.iter().find(|p| p.id == root) {
        Some(profile) => crate::db::pool::operation_timeout(profile, preference),
        None => crate::db::pool::preference_timeout(preference),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tag is the only thing the frontend can match on (errors cross IPC
    /// as strings), so `isTooManyConnections` in `src/lib/db/driver.ts` breaks
    /// silently if the `Display` shape ever changes. Pin it here.
    #[test]
    fn the_connection_limit_tag_prefixes_the_rendered_message() {
        let rendered = AppError::TooManyConnections("server said so".into()).to_string();
        assert!(rendered.starts_with(TOO_MANY_CONNECTIONS_TAG));
        assert!(rendered.to_ascii_lowercase().contains("server said so"));
    }

    #[test]
    fn the_needle_scan_recognises_what_each_server_actually_says() {
        // Postgres' own wording, and MySQL's, which differ only in case.
        assert!(message_signals_connection_limit(
            "FATAL: sorry, too many connections already"
        ));
        assert!(message_signals_connection_limit("Too many connections"));
        assert!(message_signals_connection_limit(
            "FATAL: remaining connection slots are reserved for non-replication superuser \
             connections"
        ));
        assert!(message_signals_connection_limit(
            "User huginn already has more than 'max_user_connections' active connections"
        ));
        // pgbouncer, which is neither server but sits in front of one.
        assert!(message_signals_connection_limit(
            "ERROR: no more connections allowed (max_client_conn)"
        ));
    }

    #[test]
    fn an_ordinary_failure_is_not_read_as_a_connection_limit() {
        assert!(!message_signals_connection_limit(
            "password authentication failed for user \"huginn\""
        ));
        assert!(!message_signals_connection_limit(
            "Connection refused (os error 111)"
        ));
    }

    /// The `acquire()` contract: waiting past `ACQUIRE_TIMEOUT` for a slot in a
    /// pool that already exists *is* a connection-limit problem, and the
    /// blanket conversion must keep saying so. `db::pool::open_time_error`
    /// covers the other producer of this variant — see ADR #66 and the test
    /// beside it.
    #[test]
    fn a_pool_acquire_timeout_stays_classified_as_a_connection_limit() {
        let error: AppError = sqlx::Error::PoolTimedOut.into();
        assert!(error.is_too_many_connections());
        assert!(error.to_string().contains("free slot"));
    }

    /// The message the user actually reads. `mongodb::error::Error`'s own
    /// `Display` appends `labels`, `source` and a `Debug` of the server reply —
    /// and that last one is hex-encoded, so a Mongo command error used to drag
    /// a dump of the whole reply into a tree row. See ADR #68.
    #[test]
    fn a_mongo_error_renders_its_kind_and_nothing_else() {
        // The one `ErrorKind` constructible from outside the driver crate:
        // `impl<E> From<E> for Error where ErrorKind: From<E>`, plus
        // `From<std::io::ErrorKind> for ErrorKind`.
        let mongo: mongodb::error::Error = std::io::ErrorKind::ConnectionRefused.into();
        let rendered = AppError::Mongo(mongo).to_string();
        assert!(rendered.starts_with("mongodb error: "));
        for noise in ["Kind:", "labels:", "source:", "server response:"] {
            assert!(
                !rendered.contains(noise),
                "{noise:?} is driver bookkeeping, not something to show a user: {rendered}"
            );
        }
    }

    #[test]
    fn an_io_failure_is_left_as_a_database_error() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "connection refused");
        let error: AppError = sqlx::Error::Io(io).into();
        assert!(!error.is_too_many_connections());
        assert!(matches!(error, AppError::Database(_)));
    }

    /// The bridge carries an app-side error as its rendered string, and the
    /// sidecar rewraps it in `Bridged`. The rewrap must add nothing: a remote
    /// `invalid input: X` surfaces as `invalid input: X`, and the markers the
    /// frontend and callers match on stay at the start of the message.
    #[test]
    fn a_bridged_error_renders_the_remote_message_unchanged() {
        assert_eq!(
            AppError::Bridged("invalid input: X".into()).to_string(),
            "invalid input: X"
        );
        for original in [
            AppError::InvalidInput("X".into()),
            AppError::NotFound("profile abc".into()),
            AppError::TooManyConnections("server said so".into()),
            AppError::MissingPassword("abc::huginn".into()),
        ] {
            let wire = original.to_string();
            assert_eq!(AppError::Bridged(wire.clone()).to_string(), wire);
        }
    }
}
