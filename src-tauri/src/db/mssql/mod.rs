//! Microsoft SQL Server backend (TDS, via the `tiberius` crate).
//!
//! Structured like [`crate::db::mongo`]: everything driver-specific lives in
//! this module and the command layer keeps thin `DbPool::MsSql(_)` arms that
//! delegate here. The reason it needs its own module at all is that `sqlx`
//! dropped MSSQL after 0.6, so unlike Postgres/MySQL/SQLite there is no shared
//! `sqlx::Pool` / `sqlx::query` machinery to reuse.
//!
//! Two consequences shape the code below:
//!
//! 1. **`tiberius` has no connection pool.** Its [`tiberius::Client`] owns a
//!    single TDS session and every query takes `&mut self`. [`MsSqlPool`] is
//!    therefore a small pool of our own: a semaphore bounding concurrency, a
//!    stack of idle clients, lazy creation on demand, and a guard
//!    ([`PooledClient`]) that returns its client on drop — unless the query
//!    failed at the transport level, in which case the session is discarded
//!    rather than handed to the next caller in an undefined state.
//! 2. **The command layer never sees a `tiberius::Client`.** [`PooledClient`]
//!    exposes only the handful of shapes the callers actually need
//!    (`query_rows`, `execute`, `simple_query_sets`, `scalar_i64`), each of
//!    which classifies its own errors for the pool. That keeps the
//!    poison-on-transport-error decision in one place instead of at every call
//!    site, and keeps `tiberius` types out of `commands/`.
//!
//! Every value is bound as a nullable string, matching ADR #5: the cell
//! editor only ever produces text and the server coerces it to the column
//! type. That coercion is right for numbers, dates, `bit` and even
//! `uniqueidentifier`, but wrong for the binary family — see
//! [`binary_convert`].

pub mod schema;
pub mod values;

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, MsSqlAuth, MsSqlOptions};
use futures_util::TryStreamExt;
use std::sync::Arc;
use std::time::Instant;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// A live TDS session. `tiberius` speaks the `futures-io` traits, so the tokio
/// socket goes through `tokio_util`'s compatibility wrapper.
type MsSqlClient = Client<Compat<TcpStream>>;

/// Fallback bound on concurrent TDS sessions, used only when a caller opens a
/// pool without stating its limits.
///
/// The real number normally comes from [`crate::db::pool::PoolLimits`], i.e.
/// from what the server's endpoint budget granted this connection — a TDS
/// session is a real server-side connection and has to be counted like every
/// other driver's.
const DEFAULT_MAX_SESSIONS: usize = 4;

/// The TCP port a *default* SQL Server instance listens on.
///
/// A named instance normally gets a dynamic port instead — that is what the
/// SQL Browser exists to hand out. So a port other than this one, typed
/// alongside an instance name, is the user telling us the instance has a
/// static port, and that is exactly the value [`Reach::Browser`] falls back to
/// when the Browser doesn't answer.
const DEFAULT_PORT: u16 = 1433;

/// The UDP port the **SQL Server Browser** answers on.
///
/// Not a TCP port of the instance, and not interchangeable with
/// [`DEFAULT_PORT`]: the Browser is a separate service whose whole job is to
/// hand out the dynamic TCP port a *named* instance chose at startup.
///
/// It has to be stated here because `tiberius` reads the target of its
/// discovery datagram off the same `Config` as the TDS connection
/// (`connect_named` sends to `Config::get_addr()`), so a `Config` carrying the
/// instance's TCP port would send the lookup to the instance instead of to the
/// Browser — see [`connect_uncapped`].
const SQL_BROWSER_PORT: u16 = 1434;

/// How a TDS session reaches the server.
#[derive(Clone, Copy, Debug)]
enum Reach {
    /// Straight to the configured host:port — a default instance.
    Port,
    /// A named instance, whose port is discovered through the SQL Browser
    /// (UDP 1434). `fallback_port` is the static port the user typed, if any,
    /// tried when the Browser doesn't answer.
    Browser { fallback_port: Option<u16> },
}

/// The `DbPool::MsSql` payload: a cheaply clonable handle onto the shared pool.
#[derive(Clone)]
pub struct MsSqlPool {
    inner: Arc<Inner>,
}

struct Inner {
    /// Everything needed to open a *new* session, so the pool can grow lazily
    /// and replace sessions the server dropped.
    cfg: Config,
    /// How a new session reaches the server: straight to the configured port,
    /// or through the SQL Browser for a named instance.
    reach: Reach,
    /// Concurrency bound. A permit is held for as long as a caller holds a
    /// [`PooledClient`], so `max_sessions` callers can work at once and the
    /// rest queue.
    permits: Arc<Semaphore>,
    /// The permit count `permits` started with, so [`MsSqlPool::open_sessions`]
    /// can tell how many are checked out.
    max_sessions: usize,
    /// Sessions that are open but not in use, each stamped with the moment it
    /// was returned. Never longer than the permit count, because a permit is
    /// required to take one out.
    ///
    /// The stamp is what lets [`MsSqlPool::reap_idle`] apply the same
    /// [`crate::db::pool::IDLE_TIMEOUT`] the `sqlx` pools enforce for
    /// themselves: without it a connection the user opened once and forgot
    /// would hold TDS sessions against the server until the app closed, which
    /// is precisely the footprint this release set out to bound.
    idle: Mutex<Vec<(MsSqlClient, Instant)>>,
}

impl MsSqlPool {
    /// Sessions open against the server right now: the idle ones plus the ones
    /// checked out. For the connection footprint in Settings, so best effort —
    /// if the idle list is locked at this instant, only the checked-out ones
    /// are counted rather than waiting.
    pub fn open_sessions(&self) -> u32 {
        let checked_out = self
            .inner
            .max_sessions
            .saturating_sub(self.inner.permits.available_permits());
        let idle = self.inner.idle.try_lock().map(|v| v.len()).unwrap_or(0);
        u32::try_from(checked_out + idle).unwrap_or(u32::MAX)
    }

    /// Check out a session, opening a new one if none is idle.
    ///
    /// Waits for a permit when `MAX_SESSIONS` are already busy. The returned
    /// guard must be dropped (or awaited to completion) promptly — holding one
    /// across a long user interaction would starve the keepalive ping.
    pub async fn acquire(&self) -> AppResult<PooledClient> {
        let permit = self
            .inner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::NotConnected("SQL Server pool is closed".into()))?;

        let existing = {
            let mut idle = self.inner.idle.lock().await;
            drop_expired(&mut idle);
            idle.pop()
        };
        // The same rule `db::pool::check_before_use` applies to the sqlx
        // drivers: an idle session is checked, with its own timeout, before it
        // is handed out, and one that does not answer is replaced rather than
        // handed to a query that would fail on it — or, on a socket a NAT
        // dropped silently, hang on it. This pool had no check at all before.
        let client = match existing {
            Some((mut client, _)) => {
                let alive = tokio::time::timeout(crate::db::pool::STALE_CHECK_TIMEOUT, async {
                    let stream = client.simple_query("SELECT 1").await?;
                    stream.into_results().await
                })
                .await;
                match alive {
                    Ok(Ok(_)) => client,
                    _ => connect(&self.inner.cfg, self.inner.reach).await?,
                }
            }
            None => connect(&self.inner.cfg, self.inner.reach).await?,
        };
        Ok(PooledClient {
            inner: self.inner.clone(),
            client: Some(client),
            _permit: permit,
            healthy: false,
        })
    }

    /// Cheap liveness probe used by [`crate::keepalive`] and the connection
    /// smoke test.
    pub async fn ping(&self) -> AppResult<()> {
        let mut c = self.acquire().await?;
        let result = c.simple_query_sets("SELECT 1").await.map(|_| ());
        drop(c);
        // The keepalive is the only thing that reliably touches an idle
        // connection, so it doubles as the sweep that gives sessions the user
        // has stopped using back to the server. `acquire` reaps too, but a
        // pool nobody queries would never call it.
        self.reap_idle().await;
        result
    }

    /// Close sessions that have sat unused past
    /// [`crate::db::pool::IDLE_TIMEOUT`].
    pub async fn reap_idle(&self) {
        drop_expired(&mut *self.inner.idle.lock().await);
    }

    /// Close the pool: refuse new checkouts and drop every idle session.
    ///
    /// The `sqlx` drivers get this from `Pool::close`, and it is not
    /// cosmetic — `crate::db::pool::close_pool` is what makes a disconnect or
    /// an environment switch give its sockets back to the server *before* the
    /// replacement session is opened, instead of leaving that to `Drop` at an
    /// unspecified later point. Closing the semaphore also unblocks anything
    /// queued on `acquire`, which then reports `NotConnected` rather than
    /// waiting on a pool that will never serve it.
    ///
    /// Sessions currently checked out are not interrupted; each is dropped
    /// (not returned to `idle`) when its holder finishes, because
    /// `Semaphore::close` makes the return path unreachable for new callers
    /// and the idle stack is drained here.
    pub async fn close(&self) {
        self.inner.permits.close();
        self.inner.idle.lock().await.clear();
    }

    /// Drop every *idle* session while keeping the pool usable.
    ///
    /// The narrow case this exists for: `DROP DATABASE` against the database
    /// this pool is bound to. SQL Server refuses while any session is still in
    /// that database, and the caller's own idle sessions are the likeliest
    /// holders — so the drop runs on one checked-out session that has already
    /// moved itself to `master`, and this closes the rest.
    ///
    /// Unlike [`Self::close`] the semaphore stays open, so the pool reopens
    /// sessions on demand afterwards. That matters because the drop can fail
    /// (another client is in the database, the login lacks the permission) and
    /// a pool left permanently closed would turn a refused statement into a
    /// dead connection.
    pub async fn close_idle(&self) {
        self.inner.idle.lock().await.clear();
    }

    // --- one-shot conveniences -------------------------------------------
    //
    // Acquire, run, release. The command layer's `match &pool` arms are
    // expressions, so a two-step `acquire()?` + call would either need a `?`
    // that skips the surrounding Console logging or a nested match at every
    // site. These keep each arm a single expression, which is what the other
    // drivers' `sqlx` one-liners look like.

    /// Parameterised read.
    pub async fn query_all(&self, sql: &str, params: &[Option<String>]) -> AppResult<Vec<Row>> {
        self.acquire().await?.query_rows(sql, params).await
    }

    /// Parameterised write, returning rows affected.
    pub async fn execute_params(&self, sql: &str, params: &[Option<String>]) -> AppResult<u64> {
        self.acquire().await?.execute(sql, params).await
    }

    /// Unparameterised write (ad-hoc SQL from the editor), returning rows
    /// affected.
    pub async fn execute_simple(&self, sql: &str) -> AppResult<u64> {
        self.acquire().await?.simple_execute(sql).await
    }

    /// Unparameterised read returning every result set the batch produced,
    /// keeping only the first `cap` rows of each — see
    /// [`crate::commands::query::MAX_ADHOC_QUERY_ROWS`]. Returns whether any
    /// result set was truncated.
    pub async fn query_sets_capped(
        &self,
        sql: &str,
        cap: usize,
    ) -> AppResult<(Vec<Vec<Row>>, bool)> {
        self.acquire()
            .await?
            .simple_query_sets_capped(sql, cap)
            .await
    }

    /// Parameterised single-value read (the `COUNT(*)` shape).
    pub async fn scalar(&self, sql: &str, params: &[Option<String>]) -> AppResult<Option<i64>> {
        self.acquire().await?.scalar_i64(sql, params).await
    }
}

/// Drop every idle session older than [`crate::db::pool::IDLE_TIMEOUT`].
///
/// Dropping a `tiberius::Client` closes its socket, so this is the whole
/// mechanism — there is no `close()` to await, and nothing else holds the
/// session once it leaves the vector.
fn drop_expired(idle: &mut Vec<(MsSqlClient, Instant)>) {
    idle.retain(|(_, since)| since.elapsed() < crate::db::pool::IDLE_TIMEOUT);
}

/// A checked-out session. Derefs to nothing on purpose: callers go through the
/// methods below so every error is classified for the pool exactly once.
pub struct PooledClient {
    inner: Arc<Inner>,
    /// `None` only after [`Self::classify`] has decided this session is unusable.
    client: Option<MsSqlClient>,
    _permit: OwnedSemaphorePermit,
    /// Set only by [`Self::classify`], and only when the result proves the TDS
    /// stream is at a clean boundary (`Ok`, or the server rejecting the
    /// statement). Starts `false` so a guard dropped without ever completing a
    /// `classify` call — most notably one cancelled mid-`.await` by an external
    /// `tokio::time::timeout` — is discarded rather than handed to the next
    /// caller with the stream left mid-read.
    healthy: bool,
}

impl PooledClient {
    /// Run a parameterised statement and collect the first result set.
    ///
    /// Parameters are bound as nullable strings (see the module docs). `sql`
    /// must use `@P1..@Pn` placeholders, which is what
    /// [`crate::db::sql::Dialect::placeholder`] emits for this dialect.
    pub async fn query_rows(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> AppResult<Vec<Row>> {
        let borrowed: Vec<Option<&str>> = params.iter().map(|p| p.as_deref()).collect();
        let bound: Vec<&dyn tiberius::ToSql> =
            borrowed.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let client = self.client_mut()?;
        let result = async {
            let stream = client.query(sql, &bound).await?;
            stream.into_first_result().await
        }
        .await;
        self.classify(result)
    }

    /// Run a parameterised statement for its side effect, returning the total
    /// number of rows affected across every statement in the batch.
    pub async fn execute(&mut self, sql: &str, params: &[Option<String>]) -> AppResult<u64> {
        let borrowed: Vec<Option<&str>> = params.iter().map(|p| p.as_deref()).collect();
        let bound: Vec<&dyn tiberius::ToSql> =
            borrowed.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let client = self.client_mut()?;
        let result = client
            .execute(sql, &bound)
            .await
            .map(|r| r.rows_affected().iter().sum());
        self.classify(result)
    }

    /// Run SQL with no parameters and return *every* result set it produced.
    ///
    /// Used for the query editor, where the text is whatever the user typed and
    /// a single batch can legitimately return several result sets.
    pub async fn simple_query_sets(&mut self, sql: &str) -> AppResult<Vec<Vec<Row>>> {
        let client = self.client_mut()?;
        let result = async {
            let stream = client.simple_query(sql).await?;
            stream.into_results().await
        }
        .await;
        self.classify(result)
    }

    /// Same as [`Self::simple_query_sets`], but keeps only the first `cap`
    /// rows of each result set instead of collecting every row `tiberius`'s
    /// own `into_results()` would otherwise buffer — see
    /// [`crate::commands::query::MAX_ADHOC_QUERY_ROWS`].
    ///
    /// Rows past the cap are still read off the stream (just not stored):
    /// unlike dropping the stream early, this leaves the TDS session at the
    /// clean protocol boundary [`Self::classify`] requires to consider it
    /// reusable, rather than mid-response with unread bytes still in flight.
    /// Returns whether any result set was truncated.
    pub async fn simple_query_sets_capped(
        &mut self,
        sql: &str,
        cap: usize,
    ) -> AppResult<(Vec<Vec<Row>>, bool)> {
        let client = self.client_mut()?;
        let result = async {
            let mut stream = client.simple_query(sql).await?;
            let mut results: Vec<Vec<Row>> = Vec::new();
            let mut current: Option<Vec<Row>> = None;
            let mut truncated = false;
            while let Some(item) = stream.try_next().await? {
                match item {
                    tiberius::QueryItem::Row(row) => {
                        let rows = current.get_or_insert_with(Vec::new);
                        if rows.len() < cap {
                            rows.push(row);
                        } else {
                            truncated = true;
                        }
                    }
                    tiberius::QueryItem::Metadata(_) => {
                        results.push(current.take().unwrap_or_default());
                    }
                }
            }
            if let Some(rows) = current {
                results.push(rows);
            }
            Ok((results, truncated))
        }
        .await;
        self.classify(result)
    }

    /// Run SQL with no parameters for its side effect (row count only).
    pub async fn simple_execute(&mut self, sql: &str) -> AppResult<u64> {
        let client = self.client_mut()?;
        let result = client
            .execute(sql, &[])
            .await
            .map(|r| r.rows_affected().iter().sum());
        self.classify(result)
    }

    /// First column of the first row as an `i64` — the `COUNT(*)` shape.
    /// `None` when the query returned no rows or a NULL.
    pub async fn scalar_i64(
        &mut self,
        sql: &str,
        params: &[Option<String>],
    ) -> AppResult<Option<i64>> {
        let rows = self.query_rows(sql, params).await?;
        Ok(rows.first().and_then(values::first_i64))
    }

    fn client_mut(&mut self) -> AppResult<&mut MsSqlClient> {
        self.client.as_mut().ok_or_else(|| {
            AppError::NotConnected(
                "the SQL Server session was dropped after a transport error".into(),
            )
        })
    }

    /// Turn a `tiberius` result into an [`AppResult`], discarding the session
    /// when the failure means the TDS stream is no longer usable.
    ///
    /// A [`tiberius::error::Error::Server`] is the server rejecting a
    /// statement — syntax error, permission denied, constraint violation — and
    /// leaves the session perfectly healthy. Anything else (I/O, protocol,
    /// TLS, encoding) means we no longer know where we are in the stream, so
    /// reusing it would corrupt the *next* caller's query rather than this one.
    fn classify<T>(&mut self, result: tiberius::Result<T>) -> AppResult<T> {
        self.healthy = result_leaves_session_healthy(&result);
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                if !self.healthy {
                    self.client = None;
                }
                Err(AppError::MsSql(e))
            }
        }
    }
}

/// Whether a `tiberius` result leaves the TDS stream at a clean boundary safe
/// to hand to the next caller: success, or the server rejecting the statement
/// (syntax error, permission denied, constraint violation). Anything else —
/// I/O, protocol, TLS, encoding — means we no longer know where we are in the
/// stream, so the session must not be reused.
fn result_leaves_session_healthy<T>(result: &tiberius::Result<T>) -> bool {
    match result {
        Ok(_) => true,
        Err(e) => matches!(e, tiberius::error::Error::Server(_)),
    }
}

impl Drop for PooledClient {
    fn drop(&mut self) {
        // Only a session `classify` has proven is at a clean stream boundary
        // goes back to `idle` — anything else (including "never classified at
        // all", the cancelled-future case) is left to close with this guard.
        if self.healthy {
            if let Some(client) = self.client.take() {
                // `try_lock` cannot fail in practice (the lock is only ever held
                // for a push/pop), and dropping the session on contention is
                // strictly better than blocking in `Drop`.
                if let Ok(mut idle) = self.inner.idle.try_lock() {
                    idle.push((client, Instant::now()));
                }
            }
        }
    }
}

/// Wrap `placeholder` so a textual value lands correctly in a binary column,
/// or return it unchanged.
///
/// This is the SQL Server twin of the MySQL `BIT` problem (gotcha #15). Values
/// travel as text, and T-SQL's implicit nvarchar → `varbinary` conversion
/// reinterprets the *characters* of the string as bytes — so saving the
/// `0x4A2B` that [`values::mssql_value`] renders for a binary cell would store
/// the ASCII of `"0x4A2B"` rather than the two bytes it names. `CONVERT` with
/// style `1` is the form that parses a `0x`-prefixed hex string, which makes
/// the round-trip exact. `CONVERT(varbinary(max), NULL, 1)` is still NULL, so
/// the set-to-NULL path is unaffected.
///
/// `column_type` is the frontend's type hint (see `RowValue.columnType`). When
/// it is absent — a stale schema cache — the value is bound as plain text, the
/// same degradation the other drivers accept for their type-specific casts.
pub fn binary_convert(column_type: Option<&str>, placeholder: &str) -> String {
    let is_binary = column_type
        .map(|t| {
            let t = t.trim().to_ascii_lowercase();
            t.starts_with("varbinary")
                || t.starts_with("binary")
                || t == "image"
                || t == "timestamp"
                || t == "rowversion"
        })
        .unwrap_or(false);
    if is_binary {
        format!("CONVERT(varbinary(max), {placeholder}, 1)")
    } else {
        placeholder.to_string()
    }
}

/// Whether `e` is the server refusing an `OUTPUT` clause because the target
/// table has triggers (error 334).
///
/// `INSERT ... OUTPUT INSERTED.<pk>` is how [`crate::commands::query::insert_row`]
/// recovers a generated key, and it is the only form that works for
/// non-identity keys — but SQL Server rejects it outright on a table with any
/// enabled trigger, with no way to detect that up front short of querying
/// `sys.triggers` before every insert. Matching the specific error code lets
/// the caller fall back to `SCOPE_IDENTITY()` for exactly that case, without
/// swallowing genuine failures like a constraint violation.
pub fn is_output_clause_conflict(e: &AppError) -> bool {
    matches!(e, AppError::MsSql(tiberius::error::Error::Server(t)) if t.code() == 334)
}

/// Open one TDS session against `cfg`, bounded by [`crate::db::pool::ACQUIRE_TIMEOUT`].
///
/// The `sqlx`-backed drivers reach the same place by a different route:
/// `db::pool::connect_probed` bounds their one un-pooled connect attempt by
/// the same [`crate::db::pool::ACQUIRE_TIMEOUT`] and returns the same
/// `OperationTimedOut`. It has to do that explicitly — `.acquire_timeout(...)`
/// on the `PoolOptions` is *not* enough, because `sqlx`'s eager `connect()`
/// spends that budget retrying and then reports `PoolTimedOut`, which used to
/// be classified as a connection-limit refusal (ADR #66). `tiberius` has no
/// pool at all, and this function's own two network calls — a plain TCP
/// connect, and the SQL Browser's UDP round trip in [`Reach::Browser`] — have
/// no OS-level timeout of their own; a host that silently drops packets (a
/// firewall, a stopped Browser with no reachable fallback port) hangs them
/// indefinitely.
///
/// That indefinite hang is invisible everywhere a `list_tables`/`list_columns`
/// call is itself wrapped in [`crate::error::with_timeout_for`] — the schema
/// explorer's per-database view still has to reach this function on its
/// *first* access, from `commands::connection::ensure_database_view`, which
/// runs **before** the command layer's `with_timeout_for` wrapper. With no bound
/// here, opening a per-database view against an unreachable database left the
/// whole command — and the tree node's loading skeleton — stuck forever,
/// which is what made SQL Server the one driver whose schema explorer could
/// simply never finish loading, instead of failing with a clear timeout like
/// every other driver already does.
async fn connect(cfg: &Config, reach: Reach) -> AppResult<MsSqlClient> {
    bound_by_acquire_timeout(
        crate::db::pool::ACQUIRE_TIMEOUT,
        connect_uncapped(cfg, reach),
    )
    .await
}

/// [`connect`]'s timeout wrapper, with the bound taken as a parameter so the
/// timeout behaviour itself is unit-testable in milliseconds rather than
/// needing a real 30-second wait (see the test below).
async fn bound_by_acquire_timeout<T>(
    bound: std::time::Duration,
    fut: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    match tokio::time::timeout(bound, fut).await {
        Ok(result) => result,
        Err(_) => Err(AppError::OperationTimedOut(format!(
            "connecting to SQL Server took longer than {}s — the host may be \
             unreachable, or something between here and it is silently \
             dropping the connection",
            bound.as_secs()
        ))),
    }
}

/// The actual, unbounded connect attempt — see [`connect`] for why it is
/// always called through a timeout rather than directly.
async fn connect_uncapped(cfg: &Config, reach: Reach) -> AppResult<MsSqlClient> {
    let tcp = match reach {
        Reach::Port => TcpStream::connect(cfg.get_addr())
            .await
            .map_err(AppError::Io)?,
        // Resolves the instance's dynamic port through the SQL Browser
        // (UDP 1434) and connects to it.
        Reach::Browser { fallback_port } => {
            use tiberius::SqlBrowser;
            // `connect_named` sends its discovery datagram to
            // `Config::get_addr()` — *the config's own port* — and only then
            // rewrites the address with whatever the Browser replied. Handing
            // it the config we log in with therefore aimed the lookup at the
            // instance's TCP port, where nothing is listening for UDP, and
            // every named instance fell through to the static-port fallback
            // after a second of timeout. Discovery gets its own clone pointed
            // at the Browser; the login below still uses `cfg`, so the port it
            // carries continues to serve as the fallback target.
            match TcpStream::connect_named(&discovery_config(cfg)).await {
                Ok(tcp) => tcp,
                Err(browser_err) => {
                    // The Browser is a separate UDP service from the instance's
                    // own TCP port, and on an on-prem host it is routinely
                    // stopped or firewalled off while the instance itself is
                    // perfectly reachable on a static port. When the user has
                    // told us that port, try it before giving up:
                    // `instance_name` is only ever read by the Browser lookup,
                    // so the TDS login that follows is unaffected by having
                    // skipped it. A port left at the default (or left blank,
                    // which resolves to it) is *not* a signal — retrying 1433
                    // on a host whose UDP is being dropped would usually just
                    // pay a second connect timeout for nothing.
                    let Some(port) = fallback_port else {
                        return Err(AppError::MsSql(browser_err));
                    };
                    TcpStream::connect(cfg.get_addr()).await.map_err(|e| {
                        // Report *both* causes: told only about the port, the
                        // user has no way to tell a stopped Browser from a
                        // wrong port number.
                        AppError::Io(std::io::Error::other(format!(
                            "the SQL Server Browser did not answer on UDP 1434 \
                             ({browser_err}), and the static port {port} refused the \
                             connection too ({e}) — start the SQL Server Browser \
                             service, or set the instance's static TCP port here"
                        )))
                    })?
                }
            }
        }
    };
    tcp.set_nodelay(true)?;
    Ok(Client::connect(cfg.clone(), tcp.compat_write()).await?)
}

/// The config used to *ask the SQL Browser* where a named instance listens.
///
/// A copy of the login config with its port moved to [`SQL_BROWSER_PORT`].
/// `tiberius`' `connect_named` reads the datagram's destination off
/// `Config::get_addr()`, so this is the whole difference between a lookup that
/// reaches the Browser and one that is sent to the instance's TCP port and
/// times out — and the reason it is a named function rather than two lines
/// inline is so a test can state it.
fn discovery_config(cfg: &Config) -> Config {
    let mut discovery = cfg.clone();
    discovery.port(SQL_BROWSER_PORT);
    discovery
}

/// Split an SSMS-style `HOST\INSTANCE` into its two parts.
///
/// SQL Server Management Studio has a single "Server name" box, so that is the
/// form every SQL Server user has been trained to type — and pasting it into
/// either of our two fields used to fail, with an error that named neither
/// instances nor the Browser. In the host field the backslash made DNS
/// resolution fail; in the instance field it was handed to
/// [`Config::instance_name`] verbatim, and the Browser only ever reports the
/// bare instance name (`INSTANCE`, never `HOST\INSTANCE`), so nothing matched.
///
/// Precedence: a plain instance field wins over a suffix carried by the host
/// (the user filled the dedicated field in, so mean it), and a prefix on the
/// instance field is used as the host only when the host field is empty —
/// never overriding a host the caller already resolved, which is what keeps an
/// SSH tunnel's `127.0.0.1` substitution intact.
fn split_instance(host: &str, instance: Option<&str>) -> (String, Option<String>) {
    let clean = |s: &str| {
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    };
    let (host_prefix, host_suffix) = match host.split_once('\\') {
        Some((h, i)) => (clean(h), clean(i)),
        None => (clean(host), None),
    };
    let (inst_prefix, inst_name) = match instance.and_then(clean) {
        Some(raw) => match raw.split_once('\\') {
            Some((h, i)) => (clean(h), clean(i)),
            None => (None, clean(&raw)),
        },
        None => (None, None),
    };
    (
        host_prefix.or(inst_prefix).unwrap_or_default(),
        inst_name.or(host_suffix),
    )
}

/// Build the `tiberius` [`Config`] for `profile`.
///
/// `host`/`port`/`instance` are passed explicitly so an SSH tunnel can
/// substitute `127.0.0.1:<local-port>` without mutating the profile — same
/// contract as [`crate::db::pool::build_url`] — and so the `HOST\INSTANCE`
/// normalisation in [`split_instance`] happens once, in [`open_pool`], before
/// the tunnel decision that depends on it.
fn build_config(
    profile: &ConnectionProfile,
    password: &str,
    host: &str,
    port: u16,
    instance: Option<&str>,
) -> AppResult<(Config, Reach)> {
    let opts = profile.mssql.clone().unwrap_or_default();
    let mut cfg = Config::new();
    cfg.host(host);
    // Set even for a named instance, whose real port the Browser hands out and
    // `connect_named` substitutes: it is what `Reach::Browser`'s fallback
    // connects to when the Browser doesn't answer. Discovery itself does *not*
    // use this config — it gets a clone aimed at [`SQL_BROWSER_PORT`], because
    // `tiberius` would otherwise send the lookup here.
    cfg.port(port);
    // A blank database is a legitimate choice ("connect to the server, then let
    // me pick from the tree"); SQL Server falls back to the login's default
    // database, and the explorer opens per-database child pools from there.
    if !profile.database.is_empty() {
        cfg.database(&profile.database);
    }
    cfg.application_name("HuginnDB");

    let reach = match instance {
        Some(inst) => {
            cfg.instance_name(inst);
            Reach::Browser {
                // `port` is already resolved (`ConnectionProfile::effective_port`),
                // so a blank port arrives here as `DEFAULT_PORT` and is treated
                // as the non-signal it is.
                fallback_port: (port != DEFAULT_PORT).then_some(port),
            }
        }
        None => Reach::Port,
    };

    // Be explicit rather than relying on tiberius's default (`Required` when
    // built with TLS): an unchecked SSL box has to mean "no TLS", the same
    // rationale as the `sslmode`/`ssl-mode` handling for Postgres/MySQL.
    cfg.encryption(if profile.ssl {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::NotSupported
    });
    // Most on-prem instances present a self-signed certificate, so without this
    // toggle an encrypted connection simply cannot be established.
    if opts.trust_server_certificate {
        cfg.trust_cert();
    }

    cfg.authentication(auth_method(&opts, &profile.username, password)?);
    Ok((cfg, reach))
}

/// Translate the profile's auth mode into a `tiberius` [`AuthMethod`].
///
/// `AuthMethod::Windows` (NTLM with an explicit `DOMAIN\user` and password) is
/// `cfg(windows)`-gated inside tiberius, so on other platforms the mode is
/// refused with an actionable message instead of failing to compile. Integrated
/// / SSPI (log in as the current Windows user, no credentials typed) and Entra
/// ID tokens are deliberately not offered yet.
fn auth_method(opts: &MsSqlOptions, username: &str, password: &str) -> AppResult<AuthMethod> {
    match opts.auth {
        MsSqlAuth::Sql => Ok(AuthMethod::sql_server(username, password)),
        MsSqlAuth::Windows => {
            #[cfg(windows)]
            {
                Ok(AuthMethod::windows(username, password))
            }
            #[cfg(not(windows))]
            {
                let _ = (username, password);
                Err(AppError::UnsupportedDriver(
                    "Windows authentication for SQL Server is only available on Windows builds"
                        .into(),
                ))
            }
        }
    }
}

/// Open a pool for `profile`, bringing up its SSH tunnel first when configured.
///
/// Mirrors [`crate::db::mongo::open_pool`]'s signature so the connection
/// lifecycle in `commands::connection` stays uniform across drivers: the
/// returned [`SshTunnelHandle`] must outlive the pool.
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    route: crate::db::pool::TunnelRoute,
    known_hosts: SharedKnownHosts,
    limits: crate::db::pool::PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    // Normalise `HOST\INSTANCE` before anything else looks at either field:
    // the tunnel below is opened against the *host*, so a backslash left in it
    // would be tunnelled to a hostname that cannot resolve.
    let (server, instance) = split_instance(
        &profile.host,
        profile.mssql.as_ref().and_then(|o| o.instance.as_deref()),
    );
    // A named instance is resolved through the SQL Browser, which the tunnel
    // does not forward (it is a separate UDP service on 1434). Fail loudly
    // rather than silently connecting to the wrong port — and before opening
    // the tunnel, so the refusal doesn't cost an SSH handshake first.
    if instance.is_some() && profile.ssh_tunnel.is_some() {
        return Err(AppError::InvalidInput(
            "a named SQL Server instance cannot be reached through an SSH tunnel — \
             tunnel the instance's own TCP port and leave the instance name empty"
                .into(),
        ));
    }

    // A blank port means "the default instance's 1433" (see
    // `ConnectionProfile::effective_port`); resolve it once, before the tunnel
    // decision, so both branches dial the same number.
    let remote_port = profile.effective_port();
    let (host, port, handle) = match (profile.ssh_tunnel.as_ref(), route) {
        (Some(tunnel), crate::db::pool::TunnelRoute::Dial(ssh_secret)) => {
            let h = ssh::open_tunnel(tunnel, ssh_secret, &server, remote_port, known_hosts).await?;
            ("127.0.0.1".to_string(), h.local_port, Some(h))
        }
        // A per-database view riding its parent's tunnel: see
        // `db::pool::open_pool_routed`.
        (Some(_), crate::db::pool::TunnelRoute::Through(local_port)) => {
            ("127.0.0.1".to_string(), local_port, None)
        }
        (None, _) => (server, remote_port, None),
    };

    let (cfg, reach) = build_config(profile, password, &host, port, instance.as_deref())?;

    // Honour the grant the endpoint registry made for this server rather than
    // a constant of our own: a TDS session costs the server exactly what a
    // Postgres backend does, and a driver that sized itself was how the
    // footprint became unbounded in the first place (see `crate::db::pool`).
    let max_sessions = usize::try_from(limits.max_connections)
        .unwrap_or(DEFAULT_MAX_SESSIONS)
        .max(1);
    let pool = MsSqlPool {
        inner: Arc::new(Inner {
            cfg,
            reach,
            permits: Arc::new(Semaphore::new(max_sessions)),
            max_sessions,
            idle: Mutex::new(Vec::new()),
        }),
    };
    // Fail fast on bad credentials / unreachable host, like the `sqlx` pools'
    // eager `connect()` does, instead of surfacing the error on first query.
    pool.ping().await?;
    Ok((DbPool::MsSql(pool), handle))
}

// A per-database child pool for the multi-DB explorer needs no code here:
// `commands::connection::open_database_view` already clones the parent profile
// with `database` substituted and calls `crate::db::pool::open_pool` again,
// which lands back in this module. That path also reuses the parent's cached
// credentials and opens its own tunnel, exactly like the Postgres/MySQL case.

#[cfg(test)]
mod tests {
    use super::{
        binary_convert, bound_by_acquire_timeout, build_config, discovery_config,
        result_leaves_session_healthy, split_instance, Reach, DEFAULT_PORT, SQL_BROWSER_PORT,
    };
    use crate::state::{ConnectionProfile, Driver};

    fn mssql_profile() -> ConnectionProfile {
        ConnectionProfile {
            driver: Driver::MsSql,
            host: "SVRSQL3".into(),
            port: 0,
            ..crate::testkit::profile("p")
        }
    }

    /// The regression this pair of constants exists for: until 1.27.0 the
    /// Browser lookup was sent to whatever port the login config carried, so
    /// a named instance on the default port asked for its own location on TCP
    /// 1433 — where no UDP listener has ever been — and every named instance
    /// depended on the static-port fallback to connect at all.
    #[test]
    fn the_browser_lookup_goes_to_the_browser_not_to_the_instance() {
        let profile = mssql_profile();
        let (cfg, _) = build_config(&profile, "pw", "SVRSQL3", DEFAULT_PORT, Some("SQL2022"))
            .expect("sql login builds");
        assert_eq!(cfg.get_addr(), format!("SVRSQL3:{DEFAULT_PORT}"));
        assert_eq!(
            discovery_config(&cfg).get_addr(),
            format!("SVRSQL3:{SQL_BROWSER_PORT}")
        );
    }

    #[test]
    fn a_default_port_is_not_taken_for_a_static_instance_port() {
        // Retrying 1433 after the Browser went quiet buys a second timeout and
        // nothing else, so it is deliberately not offered as a fallback —
        // whether the user typed it or left the field blank.
        let profile = mssql_profile();
        let (_, reach) = build_config(&profile, "pw", "SVRSQL3", DEFAULT_PORT, Some("SQL2022"))
            .expect("sql login builds");
        assert!(matches!(
            reach,
            Reach::Browser {
                fallback_port: None
            }
        ));
    }

    #[test]
    fn a_port_typed_alongside_an_instance_becomes_its_static_fallback() {
        let profile = mssql_profile();
        let (_, reach) = build_config(&profile, "pw", "SVRSQL3", 1450, Some("SQL2022"))
            .expect("sql login builds");
        assert!(matches!(
            reach,
            Reach::Browser {
                fallback_port: Some(1450)
            }
        ));
    }

    #[test]
    fn no_instance_means_no_browser_round_trip() {
        let profile = mssql_profile();
        let (_, reach) =
            build_config(&profile, "pw", "SVRSQL3", DEFAULT_PORT, None).expect("sql login builds");
        assert!(matches!(reach, Reach::Port));
    }

    /// A SQL Server profile saved with a blank port dials 1433, not 0.
    #[test]
    fn a_blank_port_resolves_to_the_default_instance_port() {
        assert_eq!(mssql_profile().effective_port(), DEFAULT_PORT);
    }

    #[test]
    fn accepts_the_ssms_host_backslash_instance_form_in_either_field() {
        // Pasted whole into the host field.
        assert_eq!(
            split_instance("SRV\\INST", None),
            ("SRV".into(), Some("INST".into()))
        );
        // Pasted whole into the instance field.
        assert_eq!(
            split_instance("", Some("SRV\\INST")),
            ("SRV".into(), Some("INST".into()))
        );
        // Already split by hand — the shape the dialog's placeholder asks for.
        assert_eq!(
            split_instance("SRV", Some("INST")),
            ("SRV".into(), Some("INST".into()))
        );
    }

    #[test]
    fn an_explicit_instance_field_wins_over_a_suffix_on_the_host() {
        assert_eq!(
            split_instance("SRV\\ONE", Some("TWO")),
            ("SRV".into(), Some("TWO".into()))
        );
    }

    #[test]
    fn a_prefix_on_the_instance_field_never_overrides_a_resolved_host() {
        // The host argument is what an SSH tunnel substitutes; a stray prefix
        // in the instance field must not steer the connection away from it.
        assert_eq!(
            split_instance("127.0.0.1", Some("OTHER\\INST")),
            ("127.0.0.1".into(), Some("INST".into()))
        );
    }

    #[test]
    fn blank_and_default_instances_stay_none() {
        assert_eq!(split_instance("SRV", None), ("SRV".into(), None));
        assert_eq!(split_instance("SRV", Some("   ")), ("SRV".into(), None));
        // A trailing backslash is a default instance spelled clumsily, not an
        // instance named "".
        assert_eq!(split_instance("SRV\\", None), ("SRV".into(), None));
        assert_eq!(
            split_instance("  SRV  ", Some(" INST ")),
            ("SRV".into(), Some("INST".into()))
        );
    }

    #[test]
    fn a_successful_result_leaves_the_session_healthy() {
        assert!(result_leaves_session_healthy::<()>(&Ok(())));
    }

    #[test]
    fn a_transport_level_error_leaves_the_session_unhealthy() {
        // `Error::Server(TokenError)` (the other branch `classify` treats as
        // healthy) has no public constructor in `tiberius` — `TokenError`'s
        // fields are all `pub(crate)` there — so it can't be built from this
        // crate for a test. `Utf8` stands in for the whole non-`Server`
        // family (I/O, protocol, TLS, encoding): the predicate is a single
        // `matches!` arm, and every one of those variants takes the same
        // "unhealthy" branch.
        let result: tiberius::Result<()> = Err(tiberius::error::Error::Utf8);
        assert!(!result_leaves_session_healthy(&result));
    }

    #[test]
    fn wraps_only_binary_columns_in_a_hex_convert() {
        // The `0x…` text `mssql_value` produces for a binary cell has to be
        // parsed back as hex, not stored as the characters of the string.
        assert_eq!(
            binary_convert(Some("varbinary(max)"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
        assert_eq!(
            binary_convert(Some("BINARY(16)"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
        assert_eq!(
            binary_convert(Some("image"), "@P1"),
            "CONVERT(varbinary(max), @P1, 1)"
        );
    }

    #[test]
    fn leaves_every_other_type_to_the_implicit_conversion() {
        for t in [
            "int",
            "nvarchar(50)",
            "bit",
            "datetime2",
            "uniqueidentifier",
        ] {
            assert_eq!(binary_convert(Some(t), "@P1"), "@P1", "type {t}");
        }
        // No type hint (stale schema cache): bind as plain text rather than
        // guessing, matching the other drivers' degradation.
        assert_eq!(binary_convert(None, "@P1"), "@P1");
    }

    /// The regression this module exists for: a connect attempt that never
    /// resolves (a firewall silently dropping packets, a stopped SQL Browser
    /// with no reachable fallback port) used to hang forever, because neither
    /// a bare TCP connect nor `tiberius`'s handshake has a timeout of its
    /// own — unlike the `sqlx` pools, which get one for free from
    /// `PoolOptions::acquire_timeout`. `connect` (`super::connect`) now routes
    /// through this wrapper with the real `ACQUIRE_TIMEOUT`; this test proves
    /// the wrapper itself resolves instead of hanging, using a millisecond
    /// bound so it doesn't cost the suite 30 real seconds.
    #[tokio::test]
    async fn a_connect_that_never_resolves_times_out_instead_of_hanging_forever() {
        let result: crate::error::AppResult<()> =
            bound_by_acquire_timeout(std::time::Duration::from_millis(20), std::future::pending())
                .await;
        assert!(matches!(
            result,
            Err(crate::error::AppError::OperationTimedOut(_))
        ));
    }
}
