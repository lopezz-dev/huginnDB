//! Desktop-app side of the MCP bridge: the listener that serves a sidecar's
//! data-path calls out of the app's own pools.
//!
//! See [`crate::bridge`] for why this exists and what it is and isn't allowed
//! to trust. The short version: the app becomes the single owner of every
//! HuginnDB connection on the machine, and MCP activity becomes visible in the
//! Console instead of only in `mcp-audit.log`.

use crate::bridge::protocol::{BridgeRequest, BridgeResponse, Hello, HelloAck, PROTOCOL_VERSION};
use crate::bridge::{publish, unpublish, Discovery};
#[cfg(test)]
use crate::db::sql::StmtClass;
use crate::db::sql::Verbs;
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, LogEntry, LogKind, LogSink};
use crate::state::{AppState, McpWritePolicy};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// Owns the running listener. Dropping it stops the accept loop and removes the
/// discovery file, so a sidecar started afterwards falls back to local pools
/// rather than dialling a port nothing is listening on.
pub struct BridgeHandle {
    cancel: CancellationToken,
    /// The port actually bound, surfaced in Settings so a user debugging a
    /// firewall prompt can see what HuginnDB opened.
    pub port: u16,
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        unpublish();
    }
}

/// Bind a loopback listener, publish the discovery file, and start serving.
///
/// Port `0` asks the OS for a free one — a fixed port would collide with a
/// second HuginnDB install (stable + canary side by side, which
/// `crate::app_identity` explicitly supports) and there is nothing for a
/// sidecar to hardcode anyway, since it reads the port from the discovery file.
pub async fn start(app: AppHandle) -> AppResult<BridgeHandle> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().to_string();
    publish(&Discovery {
        port,
        token: token.clone(),
        pid: std::process::id(),
    })?;

    log_bus::broadcast(
        &app,
        LogEntry::new(LogKind::Connection)
            .message(format!("mcp bridge: listening on 127.0.0.1:{port}")),
    );

    let cancel = CancellationToken::new();
    let cancel_loop = cancel.clone();
    let token = Arc::new(token);
    tauri::async_runtime::spawn(async move {
        // Consecutive `accept()` failures, reset by every success. Drives the
        // backoff below; see [`accept_backoff`] for why the loop cannot simply
        // retry.
        let mut failures: u32 = 0;
        loop {
            let accepted = tokio::select! {
                _ = cancel_loop.cancelled() => return,
                accepted = listener.accept() => accepted,
            };
            let (stream, _peer) = match accepted {
                Ok(pair) => {
                    failures = 0;
                    pair
                }
                Err(e) => {
                    failures = failures.saturating_add(1);
                    // Say something the first time, and once more if it is
                    // clearly not clearing up. Not every time: a listener stuck
                    // in this state would otherwise flood the Console with the
                    // same line forever, which is its own denial of service.
                    if failures == 1 || failures == PERSISTENT_ACCEPT_FAILURES {
                        log_bus::broadcast(
                            &app,
                            LogEntry::new(LogKind::Connection).error(format!(
                                "mcp bridge: accept failed ({failures}\u{d7}): {e}"
                            )),
                        );
                    }
                    let delay = accept_backoff(failures);
                    if !delay.is_zero() {
                        tokio::select! {
                            _ = cancel_loop.cancelled() => return,
                            _ = tokio::time::sleep(delay) => {}
                        }
                    }
                    continue;
                }
            };
            let app = app.clone();
            let token = Arc::clone(&token);
            let cancel_conn = cancel_loop.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = cancel_conn.cancelled() => {}
                    _ = serve_connection(app, stream, token) => {}
                }
            });
        }
    });

    Ok(BridgeHandle { cancel, port })
}

/// Longest the accept loop waits between retries once failures persist.
///
/// A second is short enough that the bridge recovers promptly when whatever
/// was wrong clears, and long enough that a permanently broken listener costs
/// nothing measurable.
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);

/// Consecutive failures after which the loop says so a second time. Reached in
/// well under a second at the delays below, so the message lands while the
/// user is still looking at whatever they just did.
const PERSISTENT_ACCEPT_FAILURES: u32 = 10;

/// How long to wait before calling `accept()` again after `consecutive`
/// failures in a row.
///
/// The loop used to `continue` unconditionally, on the stated grounds that "a
/// failed accept is transient". That is true of the common case — a client
/// that vanished mid-handshake — and for it this function still returns zero,
/// so nothing about that path changes. It is emphatically *not* true of
/// descriptor exhaustion (`EMFILE`/`ENFILE`), which is the textbook reason
/// `accept()` fails repeatedly and which cannot clear until something
/// unrelated closes a handle. Retrying that instantly is an unbounded hot loop
/// on a runtime worker: one core at 100%, indefinitely, with the error value
/// dropped on the floor so nothing anywhere says why.
///
/// The ramp is deliberately blind to the error kind. Classifying `io::Error`
/// portably is fiddly (the resource-exhaustion errnos have no stable
/// `ErrorKind`), and guessing wrong in the direction of "this one is transient"
/// reinstates exactly the bug. Instead the first few retries are immediate, so
/// the genuinely transient case is untouched, and anything that keeps failing
/// ramps to [`ACCEPT_BACKOFF_MAX`] within a handful of iterations.
fn accept_backoff(consecutive: u32) -> Duration {
    match consecutive {
        0..=3 => Duration::ZERO,
        4..=6 => Duration::from_millis(10),
        7..=9 => Duration::from_millis(100),
        _ => ACCEPT_BACKOFF_MAX,
    }
}

/// Decide whether to accept a client's opening frame.
///
/// Extracted so the refusal rules — the only thing standing between the token
/// file and every database the user has saved — are exercised by tests rather
/// than only by a running app. Version is checked *before* the token so a
/// mismatched build gets a diagnosable message instead of a bare "bad token".
fn handshake_refusal(hello: &Hello, token: &str) -> Option<String> {
    if hello.protocol_version != PROTOCOL_VERSION {
        return Some(format!(
            "protocol version mismatch (app speaks {PROTOCOL_VERSION}, client speaks {})",
            hello.protocol_version
        ));
    }
    if hello.token != token {
        return Some("bad token".to_string());
    }
    None
}

/// Bring the listener's state in line with the `connections.mcpBridge`
/// preference: start it if it should be running and isn't, stop it if it
/// shouldn't and is.
///
/// Idempotent, so both the startup hook and `update_preferences` can call it
/// unconditionally without either needing to know what the other did. Stopping
/// is just dropping the handle — [`BridgeHandle::drop`] cancels the accept loop
/// and removes the discovery file, so a sidecar that reconnects afterwards
/// falls back to its own pools instead of dialling a dead port.
pub async fn reconcile(app: &AppHandle) {
    let want = app.state::<AppState>().prefs.read().connections.mcp_bridge;
    let running = app.state::<AppState>().mcp_bridge.lock().is_some();
    if want == running {
        return;
    }
    if !want {
        // Take the handle out of the state *before* dropping it, so the lock is
        // not held while `Drop` touches the filesystem.
        let handle = app.state::<AppState>().mcp_bridge.lock().take();
        drop(handle);
        log_bus::broadcast(
            app,
            LogEntry::new(LogKind::Connection).message("mcp bridge: stopped"),
        );
        return;
    }
    match start(app.clone()).await {
        Ok(handle) => {
            *app.state::<AppState>().mcp_bridge.lock() = Some(handle);
        }
        Err(e) => {
            log_bus::broadcast(
                app,
                LogEntry::new(LogKind::Connection)
                    .message("mcp bridge: failed to start")
                    .error(e.to_string()),
            );
        }
    }
}

/// One client connection: handshake, then requests until it goes away.
async fn serve_connection(app: AppHandle, stream: TcpStream, token: Arc<String>) {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    // --- handshake ---
    let Ok(Some(first)) = lines.next_line().await else {
        return;
    };
    let hello: Hello = match serde_json::from_str(&first) {
        Ok(h) => h,
        Err(_) => return,
    };
    let refusal = handshake_refusal(&hello, token.as_str());
    let refused = refusal.is_some();
    let ack = HelloAck {
        protocol_version: PROTOCOL_VERSION,
        error: refusal,
    };
    if write_line(&mut write_half, &ack).await.is_err() || refused {
        // A refused handshake ends the connection: there is no state to keep
        // and nothing useful a caller could do next.
        return;
    }

    // What this client may reach. Advisory with respect to a *hostile*
    // token-holder — it would simply declare everything — but it keeps an
    // honest sidecar honest, and the per-connection write policy checked below
    // is the authoritative gate either way.
    let exposure = if hello.defer_exposure {
        Exposure::FromProfiles
    } else {
        Exposure::Declared(hello.allowed.into_iter().collect())
    };

    // --- request loop ---
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<BridgeRequest>(&line) {
            Ok(request) => handle(&app, &request, &exposure).await,
            Err(e) => BridgeResponse::err(format!("malformed request: {e}")),
        };
        if write_line(&mut write_half, &response).await.is_err() {
            return;
        }
    }
}

async fn write_line<T: serde::Serialize>(
    write_half: &mut tokio::net::tcp::OwnedWriteHalf,
    value: &T,
) -> std::io::Result<()> {
    let mut buf = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    buf.push(b'\n');
    write_half.write_all(&buf).await
}

/// Dispatch one request, converting the result to the wire form.
async fn handle(app: &AppHandle, request: &BridgeRequest, exposure: &Exposure) -> BridgeResponse {
    let start = Instant::now();
    match dispatch(app, request, exposure).await {
        Ok(value) => {
            log_served(app, request, start, None);
            BridgeResponse::ok(value)
        }
        Err(e) => {
            let message = e.to_string();
            log_served(app, request, start, Some(&message));
            BridgeResponse::err(message)
        }
    }
}

/// Mirror every served call into the Console.
///
/// This is the visibility half of the bridge's value: an MCP client browsing
/// or writing to a database shows up in the same panel as the user's own
/// queries, live, rather than only in `mcp-audit.log` after the fact.
/// Broadcast, not targeted — there is no originating window.
fn log_served(app: &AppHandle, request: &BridgeRequest, start: Instant, error: Option<&str>) {
    let mut entry = LogEntry::new(LogKind::Connection)
        .connection_id(connection_id_of(request))
        .message(format!("mcp: {}", request.label()))
        .duration_ms(start.elapsed().as_millis() as u64);
    if let Some(e) = error {
        entry = entry.error(e);
    }
    log_bus::broadcast(app, entry);
}

pub(crate) fn connection_id_of(request: &BridgeRequest) -> String {
    use BridgeRequest::*;
    match request {
        EnsureConnected { connection_id }
        | IsMongo { connection_id }
        | ListDatabases { connection_id }
        | ListTables { connection_id }
        | ServerVersion { connection_id }
        | ListUsers { connection_id }
        | ListPrivileges { connection_id, .. }
        | PulseHealth { connection_id }
        | PulseMetrics { connection_id, .. }
        | PulseTopQueries { connection_id }
        | PulseExplain { connection_id, .. }
        | PulseStorage { connection_id }
        | PulseSessions { connection_id }
        | PulseIndexUsage { connection_id }
        | ResolveMongoTarget { connection_id, .. }
        | GetTableStructure { connection_id, .. }
        | ListIndexes { connection_id, .. }
        | RunStatement { connection_id, .. }
        | RunWriteBatch { connection_id, .. }
        | FetchTableData { connection_id, .. }
        | InsertRow { connection_id, .. }
        | UpdateCell { connection_id, .. }
        | DeleteRows { connection_id, .. }
        | GetViewDefinition { connection_id, .. }
        | PreviewViewChange { connection_id, .. }
        | ApplyViewChange { connection_id, .. }
        | DropView { connection_id, .. }
        | CreateMongoIndex { connection_id, .. }
        | DropMongoIndex { connection_id, .. } => connection_id.clone(),
    }
}

/// Profile id whose write policy governs a request, when it is a write.
///
/// Always the *profile*, never the resolved pool: for Mongo the connection id
/// may be the synthetic `<id>::db::<name>` view, which is not a key in
/// `profiles.json`, so a policy lookup against it would miss and — because
/// `McpWritePolicy` defaults to `ReadOnly` — silently refuse a write the user
/// had actually allowed. (The reverse mistake would be worse; this is the same
/// reasoning the sidecar's own `require_class` records.)
fn policy_id_of(request: &BridgeRequest) -> Option<&str> {
    use BridgeRequest::*;
    match request {
        RunStatement { policy_id, .. }
        | RunWriteBatch { policy_id, .. }
        | FetchTableData { policy_id, .. }
        | InsertRow { policy_id, .. }
        | UpdateCell { policy_id, .. }
        | DeleteRows { policy_id, .. }
        | PreviewViewChange { policy_id, .. }
        | ApplyViewChange { policy_id, .. }
        | DropView { policy_id, .. }
        | CreateMongoIndex { policy_id, .. }
        | DropMongoIndex { policy_id, .. } => Some(policy_id),
        _ => None,
    }
}

/// What a request does, or `None` when it needs no policy at all.
///
/// Split out of [`check_policy`] so it can be tested: this and the sidecar's
/// own `require_verbs` are the only two places in the product that decide
/// what a structured operation needs, and getting it wrong here is not a
/// compile error.
///
/// Each structured write names its own verb — `InsertRow` inserts,
/// `UpdateCell` updates, `DeleteRows` deletes — rather than the one
/// `DataWrite` tier they shared, so a policy that grants the writes separately
/// can tell them apart. The per-connection MCP policy grants all three
/// together (`McpWritePolicy::verbs`), so for it nothing changes.
fn verbs_of_request(request: &BridgeRequest) -> Option<Verbs> {
    match request {
        // Driver-aware on purpose: the SQL keyword heuristic alone reports
        // every mongosh statement as a write, which refused a `read-only`
        // MongoDB connection its own reads and, once the grammar grew DDL,
        // would have let a `data` one drop a collection. One classifier, shared
        // with the sidecar's own check — see `crate::db::classify`.
        BridgeRequest::RunStatement { sql, .. } => Some(crate::db::classify::verbs_of(sql)),
        // Whatever any of the writes does, through the same classifier.
        BridgeRequest::RunWriteBatch { writes, .. } => {
            Some(crate::commands::write_batch::verbs_of_writes(writes))
        }
        BridgeRequest::FetchTableData { .. } => Some(Verbs::SELECT),
        BridgeRequest::InsertRow { .. } => Some(Verbs::INSERT),
        BridgeRequest::UpdateCell { .. } => Some(Verbs::UPDATE),
        BridgeRequest::DeleteRows { .. } => Some(Verbs::DELETE),
        // A dry run builds statements and executes nothing.
        BridgeRequest::PreviewViewChange { .. } => Some(Verbs::SELECT),
        // A view is schema, so creating, redefining or dropping one is the same
        // tier `db::sql::classify` already assigns to the `CREATE OR REPLACE
        // VIEW` / `DROP VIEW` a caller could write by hand through
        // `run_query`. Anything lower would let a `data` connection reach
        // through these requests what `run_query` refuses it.
        BridgeRequest::ApplyViewChange { .. } | BridgeRequest::DropView { .. } => Some(Verbs::DDL),
        // An index is schema. `db.c.createIndex(…)` through `run_query` is
        // DDL (see `MongoOp::verbs`), so anything lower here would hand a
        // `data` connection through a tool exactly what the statement path
        // denies it — the privilege escalation the view tools' tier argument
        // was forced by.
        BridgeRequest::CreateMongoIndex { .. } | BridgeRequest::DropMongoIndex { .. } => {
            Some(Verbs::DDL)
        }
        _ => None,
    }
}

/// The tier a request needs — [`verbs_of_request`] seen through
/// [`Verbs::class`]. Kept for the tests that pin tiers, which are the
/// characterisation that the verb split changed nothing.
#[cfg(test)]
fn class_of(request: &BridgeRequest) -> Option<StmtClass> {
    verbs_of_request(request).map(Verbs::class)
}

/// Re-check the connection's write policy, from disk, for a mutating call.
///
/// Not trusting the sidecar's own check is the point: this is a privileged
/// surface reachable by anything holding the token, and read-only must mean
/// read-only however the request got here. Read fresh from `profiles.json` for
/// the same reason the sidecar does — so a policy changed in Settings → MCP
/// takes effect without restarting anything.
///
/// **Two consumers.** This module serves the sidecar; [`crate::ai::exec`] calls
/// it for the in-app assistant's tool calls, which arrive over an entirely
/// different transport and are built from a different catalogue but land on the
/// same [`BridgeRequest`] enum. That is the whole reason the check lives on the
/// request rather than at either entry point — and it is why the AI catalogue
/// keeps its own exhaustive mapping instead of extending `verbs_of_request`'s
/// `_ => None` (convention #49).
pub(crate) fn check_policy(state: &AppState, request: &BridgeRequest) -> AppResult<()> {
    let Some(policy_id) = policy_id_of(request) else {
        return Ok(());
    };
    let Some(needed) = verbs_of_request(request) else {
        return Ok(());
    };
    let policy = crate::store::load_profiles()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == policy_id))
        .map(|p| p.mcp_write)
        .or_else(|| {
            state
                .profiles
                .read()
                .iter()
                .find(|p| p.id == policy_id)
                .map(|p| p.mcp_write)
        })
        .unwrap_or(McpWritePolicy::ReadOnly);
    if policy.allows(needed) {
        return Ok(());
    }
    Err(AppError::InvalidInput(format!(
        "connection {policy_id:?} has MCP write policy {:?}, which does not permit this operation",
        policy.label()
    )))
}

/// [`LogSink`] that mirrors a write's own log entry into every Console.
struct BridgeSink<'a> {
    app: &'a AppHandle,
}

impl LogSink for BridgeSink<'_> {
    fn log(&self, entry: LogEntry) {
        log_bus::broadcast(self.app, entry);
    }
}

/// What a connected sidecar is allowed to reach.
///
/// Two sources, and which one applies is the client's to declare at handshake
/// (see [`crate::bridge::protocol::Hello::defer_exposure`]).
enum Exposure {
    /// The client pinned its own `--connections` list. Enforce exactly it, for
    /// the whole session — an argument the user typed is not something a later
    /// change in the app should widen.
    Declared(HashSet<String>),
    /// The client deferred to the app: authorize against
    /// `ConnectionProfile::mcp_exposed`, read **live on every request**.
    ///
    /// Live is the point. The handshake happens once and an MCP client holds
    /// its sidecar for days, so a snapshot would mean a connection ticked in
    /// Settings → MCP stayed unreachable until the user restarted the client —
    /// the same staleness that made `--connections` worth removing. The app
    /// owns `profiles.json` and keeps it in memory, so this costs a read lock,
    /// not a disk read.
    FromProfiles,
}

impl Exposure {
    fn admits(&self, state: &AppState, id: &str) -> bool {
        match self {
            Exposure::Declared(ids) => ids.contains(id),
            Exposure::FromProfiles => state
                .profiles
                .read()
                .iter()
                .any(|p| p.id == id && p.mcp_exposed),
        }
    }
}

async fn dispatch(
    app: &AppHandle,
    request: &BridgeRequest,
    exposure: &Exposure,
) -> AppResult<Value> {
    let state = app.state::<AppState>();
    let state = state.inner();

    // The check covers the connection being reached *and* the profile whose
    // policy governs it; for a Mongo view those differ, and only checking one
    // would leave a gap.
    let target = connection_id_of(request);
    // Same fold the rest of the app uses, rather than a local `split` — this is
    // the connector's access check, so the two must not be able to disagree
    // about what "the profile behind this id" means.
    let root = crate::state::parent_connection_id(&target).to_string();
    if !exposure.admits(state, &root) {
        return Err(AppError::InvalidInput(format!(
            "connection {root:?} is not exposed to this MCP client"
        )));
    }
    check_policy(state, request)?;

    // Opening a pool is the one call that has to go through the *app's* own
    // path rather than the shared executor: `connect_inner` reserves the
    // endpoint budget, caches the session secrets for any per-database view
    // that follows, and logs the connect to the Console where the user can see
    // what the connector did.
    //
    // `PoolOrigin::Bridge` is what keeps that pool releasable. No window shows
    // it — the frontend deliberately does not listen for `connection-opened`,
    // since a new window must not adopt another's live connections — so nobody
    // will ever disconnect it, and until the marker existed the app's reaper
    // skipped it as "a connection the user opened". See ADR #67.
    if let BridgeRequest::EnsureConnected { connection_id } = request {
        // The one request `bridge::exec::execute` never sees, so the policy
        // is applied here: a connection the AI's role cannot reach is not
        // even opened.
        crate::policy::enforce(state, request)?;
        crate::commands::connection::connect_inner(
            app,
            state,
            None,
            connection_id,
            None,
            None,
            crate::state::PoolOrigin::Bridge,
        )
        .await?;
        return Ok(Value::Null);
    }
    crate::commands::connection::ensure_database_view(app, state, None, &target).await;
    crate::bridge::exec::execute(state, &BridgeSink { app }, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- accept-loop backoff -------------------------------------------------
    //
    // The loop used to `continue` on any failed `accept()`, on the stated
    // grounds that such a failure is transient. Descriptor exhaustion is not,
    // and the result was an unbounded hot loop on a runtime worker with the
    // error dropped on the floor. These pin both halves of the trade: the
    // transient case stays instant, and the persistent one cannot burn a core.

    #[test]
    fn a_lone_transient_failure_still_retries_immediately() {
        // A client that vanished mid-handshake is the common case and must not
        // pay a delay — the next connection is probably already queued.
        assert_eq!(accept_backoff(1), Duration::ZERO);
        assert_eq!(accept_backoff(2), Duration::ZERO);
        assert_eq!(accept_backoff(3), Duration::ZERO);
    }

    #[test]
    fn a_persistent_failure_reaches_the_cap_and_stays_there() {
        assert_eq!(
            accept_backoff(PERSISTENT_ACCEPT_FAILURES),
            ACCEPT_BACKOFF_MAX
        );
        assert_eq!(accept_backoff(1_000), ACCEPT_BACKOFF_MAX);
        assert_eq!(accept_backoff(u32::MAX), ACCEPT_BACKOFF_MAX);
    }

    #[test]
    fn the_backoff_never_decreases() {
        let mut prev = Duration::ZERO;
        for n in 0..40 {
            let d = accept_backoff(n);
            assert!(d >= prev, "backoff went backwards at {n}: {d:?} < {prev:?}");
            prev = d;
        }
    }

    #[test]
    fn the_hot_window_is_bounded_to_a_few_spins() {
        // The whole point: however long the failure lasts, only a bounded
        // number of iterations run back-to-back before the loop starts
        // sleeping. Anything else is a core at 100% for as long as it lasts.
        let spins = (0..).take_while(|n| accept_backoff(*n).is_zero()).count();
        assert!(
            spins <= 8,
            "too many instant retries before backing off: {spins}"
        );
    }

    #[test]
    fn the_total_wait_before_the_cap_stays_under_a_second() {
        // A listener that recovers on its own should not be left idle for
        // noticeably longer than the cap itself.
        let ramp: Duration = (1..PERSISTENT_ACCEPT_FAILURES).map(accept_backoff).sum();
        assert!(ramp < ACCEPT_BACKOFF_MAX, "ramp too slow: {ramp:?}");
    }

    fn hello(version: u32, token: &str) -> Hello {
        Hello {
            protocol_version: version,
            token: token.into(),
            allowed: vec![],
            defer_exposure: false,
        }
    }

    #[test]
    fn a_matching_handshake_is_accepted() {
        assert!(handshake_refusal(&hello(PROTOCOL_VERSION, "secret"), "secret").is_none());
    }

    #[test]
    fn a_wrong_token_is_refused() {
        // The whole security model: the port is reachable by any local process,
        // and this is what stops one that cannot read the 0600 token file.
        let refusal = handshake_refusal(&hello(PROTOCOL_VERSION, "guess"), "secret");
        assert_eq!(refusal.as_deref(), Some("bad token"));
    }

    #[test]
    fn a_version_mismatch_is_refused_before_the_token_is_considered() {
        // Diagnosability: a sidecar built before a protocol change should be
        // told that, not handed "bad token" to chase. Checked with a *correct*
        // token so the ordering is what the assertion pins.
        let refusal = handshake_refusal(&hello(PROTOCOL_VERSION + 1, "secret"), "secret");
        assert!(
            refusal
                .as_deref()
                .is_some_and(|r| r.contains("protocol version mismatch")),
            "got {refusal:?}"
        );
    }

    fn view_change(preview: bool) -> BridgeRequest {
        let (connection_id, policy_id) = ("c".to_string(), "c".to_string());
        let (schema, name) = (None, "v".to_string());
        let query = "SELECT 1".to_string();
        if preview {
            BridgeRequest::PreviewViewChange {
                connection_id,
                policy_id,
                schema,
                name,
                query,
                rename_from: None,
                view_on: None,
            }
        } else {
            BridgeRequest::ApplyViewChange {
                connection_id,
                policy_id,
                schema,
                name,
                query,
                rename_from: None,
                view_on: None,
            }
        }
    }

    #[test]
    fn managing_a_view_is_classified_as_ddl() {
        // A view is schema. `db::sql::classify` already sends the `CREATE OR
        // REPLACE VIEW` / `DROP VIEW` a caller could write by hand through
        // `run_query` to `StmtClass::Ddl`, so classifying these lower would let
        // a `data` connection reach through them exactly what `run_query`
        // refuses it — a privilege escalation introduced by a new request
        // rather than a convenience.
        assert_eq!(class_of(&view_change(false)), Some(StmtClass::Ddl));
        assert_eq!(
            class_of(&BridgeRequest::DropView {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                view: "v".into(),
            }),
            Some(StmtClass::Ddl)
        );
    }

    #[test]
    fn previewing_a_view_change_is_a_read() {
        // It builds statements and executes nothing, so it is available on a
        // read-only connection.
        assert_eq!(class_of(&view_change(true)), Some(StmtClass::Read));
    }

    #[test]
    fn reading_a_view_definition_needs_no_policy() {
        assert_eq!(
            class_of(&BridgeRequest::GetViewDefinition {
                connection_id: "c".into(),
                schema: None,
                view: "v".into(),
            }),
            None
        );
    }

    #[test]
    fn a_data_policy_does_not_admit_view_management() {
        // The assertion that has to be answered before anyone "simplifies" the
        // tier: a view is not row data, and `data` must not reach it.
        for policy in [McpWritePolicy::ReadOnly, McpWritePolicy::Data] {
            assert!(
                !policy.allows(Verbs::DDL),
                "{} must not admit view management",
                policy.label()
            );
        }
        assert!(McpWritePolicy::Full.allows(Verbs::DDL));
    }

    /// The app-side half of the escalation guard. `class_of` used to derive a
    /// `RunStatement`'s tier with the SQL-only classifier, which reports *every*
    /// mongosh statement as `DataWrite` — so `db.c.drop()` would have passed a
    /// `data` connection's re-check even after the sidecar tiered it correctly.
    #[test]
    fn class_of_reads_mongo_statements_with_the_mongo_classifier() {
        let run = |sql: &str| {
            class_of(&BridgeRequest::RunStatement {
                connection_id: "c".into(),
                policy_id: "p".into(),
                sql: sql.into(),
            })
        };
        assert_eq!(run("db.users.find({})"), Some(StmtClass::Read));
        assert_eq!(
            run("db.users.insertOne({a: 1})"),
            Some(StmtClass::DataWrite)
        );
        assert_eq!(run("db.users.drop()"), Some(StmtClass::Ddl));
        assert_eq!(run("db.users.createIndex({a: 1})"), Some(StmtClass::Ddl));
        assert_eq!(
            run("db.users.renameCollection(\"clients\")"),
            Some(StmtClass::Ddl)
        );
        // SQL is untouched.
        assert_eq!(run("SELECT 1"), Some(StmtClass::Read));
        assert_eq!(run("DROP TABLE t"), Some(StmtClass::Ddl));
    }

    /// `run_writes` reaches the app as one request carrying several statements.
    /// It must be policy-checked at all, and needs what its strictest write
    /// needs — both decided in `_ => None` matches, so neither is a compile
    /// error.
    #[test]
    fn a_write_batch_is_policy_checked_as_its_strictest_write() {
        use crate::commands::write_batch::BatchWrite;
        let batch = |sqls: &[&str]| BridgeRequest::RunWriteBatch {
            connection_id: "c".into(),
            policy_id: "p".into(),
            writes: sqls
                .iter()
                .map(|s| BatchWrite {
                    sql: s.to_string(),
                    expect_rows: None,
                })
                .collect(),
        };
        let rows = batch(&["UPDATE t SET a = 1 WHERE id = 1", "db.t.insertOne({a: 1})"]);
        assert_eq!(policy_id_of(&rows), Some("p"));
        assert_eq!(class_of(&rows), Some(StmtClass::DataWrite));
        assert!(!McpWritePolicy::ReadOnly.allows(verbs_of_request(&rows).unwrap()));
        assert!(McpWritePolicy::Data.allows(verbs_of_request(&rows).unwrap()));
        // The executor refuses a schema change in the list, but the policy
        // must not rely on it: a `data` connection is refused before that.
        let ddl = batch(&["UPDATE t SET a = 1 WHERE id = 1", "DROP TABLE t"]);
        assert_eq!(class_of(&ddl), Some(StmtClass::Ddl));
        // An empty list is not a free pass.
        assert_eq!(class_of(&batch(&[])), Some(StmtClass::DataWrite));
    }

    /// The two index variants must be `Ddl` and must be policy-checked at all —
    /// both of those live in `_ => None` matches, so neither is a compile error.
    #[test]
    fn index_management_is_policy_checked_ddl() {
        let create = BridgeRequest::CreateMongoIndex {
            connection_id: "c".into(),
            policy_id: "p".into(),
            collection: "users".into(),
            spec: crate::db::mongo::indexes::NewMongoIndexSpec {
                keys: "{a: 1}".into(),
                name: None,
                unique: false,
                sparse: false,
                hidden: false,
                expire_after_seconds: None,
                partial_filter_expression: None,
                collation: None,
                weights: None,
                default_language: None,
                extra_options: None,
            },
        };
        let drop = BridgeRequest::DropMongoIndex {
            connection_id: "c".into(),
            policy_id: "p".into(),
            collection: "users".into(),
            name: "a_1".into(),
        };
        for request in [&create, &drop] {
            assert_eq!(
                class_of(request),
                Some(StmtClass::Ddl),
                "{} must be Ddl, or a `data` connection reaches it",
                request.label()
            );
            assert_eq!(
                policy_id_of(request),
                Some("p"),
                "{} must be policy-checked",
                request.label()
            );
            assert!(request.is_mutating(), "{}", request.label());
        }
        // Distinct Console labels, like preview-vs-apply.
        assert_ne!(create.label(), drop.label());
    }

    /// The structured writes used to share one `DataWrite` tier, which is all
    /// the per-connection policy could tell apart. A managed policy grants them
    /// separately, so each has to name its own verb — and the `data` policy,
    /// which grants all three, must still admit every one of them.
    #[test]
    fn structured_writes_name_their_own_verb() {
        let insert = BridgeRequest::InsertRow {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            table: "t".into(),
            pk_column: None,
            values: serde_json::json!({"a": 1}),
        };
        let update = BridgeRequest::UpdateCell {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            table: "t".into(),
            pk_columns: vec!["id".into()],
            pk_values: vec![serde_json::json!(1)],
            column: "a".into(),
            value: Some("2".into()),
            column_type: None,
        };
        let delete = BridgeRequest::DeleteRows {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            table: "t".into(),
            pk_columns: vec!["id".into()],
            pk_value_rows: vec![vec![serde_json::json!(1)]],
        };
        for (request, verb) in [
            (&insert, Verbs::INSERT),
            (&update, Verbs::UPDATE),
            (&delete, Verbs::DELETE),
        ] {
            assert_eq!(verbs_of_request(request), Some(verb));
            assert!(McpWritePolicy::Data.allows(verb));
            assert!(!McpWritePolicy::ReadOnly.allows(verb));
        }
    }
}
