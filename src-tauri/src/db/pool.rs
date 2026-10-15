//! Pool construction and connection URL assembly.
//!
//! These helpers are kept driver-agnostic: callers describe what they want
//! via a [`ConnectionProfile`] + password and receive back a typed
//! [`DbPool`].
//!
//! When the profile carries an [`SshTunnel`] config, [`open_pool`] first
//! brings up the tunnel via [`crate::db::ssh::open_tunnel`] and points the
//! resulting `sqlx` URL at the local listener instead of the remote host.
//! The returned [`SshTunnelHandle`] must be kept alive for as long as the
//! pool — callers normally store it in [`crate::state::ActivePool`]
//! alongside the pool itself.

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, Driver};
use sqlx::Connection;
use std::time::Duration;

/// Default **total** budget for one server endpoint.
///
/// The unit changed in 1.13.0. This used to be the ceiling for a single pool,
/// which meant three profiles pointing at one Postgres box each got their own
/// independent five and nothing anywhere could see the total. It is now the
/// whole allowance HuginnDB will spend against a server, shared by every
/// profile and every database view that reaches it — see
/// [`crate::db::endpoint`].
///
/// Ten leaves room for a top-level connection at its full
/// [`TOP_LEVEL_REQUEST`] plus a couple of database views, which is what
/// ordinary browsing actually uses. Overridable globally
/// (`connections.maxConnections`) and per profile
/// ([`ConnectionProfile::max_connections`]).
pub const DEFAULT_ENDPOINT_BUDGET: u32 = 10;

/// What a top-level pool asks for when the budget is comfortable.
///
/// Kept conservative because HuginnDB is a single-user desktop client; we
/// don't expect more than a couple of in-flight queries at once. The actual
/// grant may be smaller — see [`top_level_request`].
pub const TOP_LEVEL_REQUEST: u32 = 5;

/// Default ceiling for a **synthetic per-database child** pool
/// (`<parent>::db::<name>`, see `commands::connection::open_database_view`).
///
/// Deliberately much smaller than [`TOP_LEVEL_REQUEST`], because these are the
/// pools that *multiply*: one per database the user browses, against the same
/// server. Five apiece is how a twelve-database server turned into a ceiling of
/// sixty-five backends from a single window. A child pool serves schema
/// introspection and one grid at a time; two is enough for that, and still
/// above [`MIN_MAX_CONNECTIONS`].
pub const DEFAULT_CHILD_MAX_CONNECTIONS: u32 = 2;

/// Floor for any server-backed pool that will be used interactively.
///
/// Not cosmetic: `commands::query::run_batch` holds one connection checked out
/// for the whole of a multi-statement batch (so `BEGIN`/`SET`/`COMMIT` share a
/// session), and a background schema refresh that lands during a long batch
/// would deadlock against a single-connection pool waiting on
/// [`ACQUIRE_TIMEOUT`]. Two is the smallest pool that stays usable, so a
/// budget with only one slot left refuses rather than handing out a pool that
/// can deadlock.
pub const MIN_MAX_CONNECTIONS: u32 = 2;

/// Sanity ceiling on a user-supplied budget. Past this the user wants a
/// server-side pooler, not a bigger desktop client.
pub const MAX_MAX_CONNECTIONS: u32 = 64;

/// SQLite is single-file and benefits from a small pool to avoid lock
/// contention on writes. Not metered: there is no server to run out.
const MAX_CONNECTIONS_SQLITE: u32 = 1;

/// How long an idle connection may sit in a pool before it is closed.
///
/// Was implicit (`sqlx`'s 10-minute default) until connection pressure became
/// a reported problem; stated here so the value is reviewable, and shortened
/// so a pool the user has stopped touching gives its sockets back to the
/// server within a coffee break rather than twice that.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Hard cap on a single connection's age, regardless of activity. Bounds the
/// damage from a server-side session that has quietly gone bad (a stale
/// prepared-statement cache, a rotated credential, a failed-over replica) and
/// gives load balancers a chance to rebalance.
pub const MAX_LIFETIME: Duration = Duration::from_secs(1800);

/// How long a caller waits for a free slot before failing.
///
/// Two different failures share this bound, and they are *not* the same error:
///
/// * `acquire()` on an established pool giving up waiting for a slot is
///   classified into [`crate::error::AppError::TooManyConnections`] (see
///   `sqlx_connection_limit_detail`), so exhausting our *own* pool reports the
///   same actionable error as the server refusing us.
/// * Opening a pool is bounded by the same value in [`connect_probed`], and
///   there a timeout means the endpoint never answered — reported as
///   [`crate::error::AppError::OperationTimedOut`], because a server we never
///   reached is not a server that is full. See ADR #66.
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a connection held **for the MCP connector** may sit idle before it
/// is closed.
///
/// One value on purpose, shared by the two paths that can be holding such a
/// connection: the sidecar's own reaper (`mcp::POOL_IDLE_TTL`) when it opened
/// the pool itself, and the desktop app's [`crate::pool_reaper`] (through
/// `connections.bridgeIdleTtlSecs`, which defaults to this) when the bridge
/// opened it on the sidecar's behalf. Those two diverging — five minutes in one
/// mode, forever in the other — *was* ADR #67, so the default is derived
/// here rather than written down twice.
pub const MCP_IDLE_TTL: Duration = Duration::from_secs(300);

/// Default ceiling for a single read-only introspection call (metadata
/// listing, the keepalive ping) — never for a data query, whose runtime is the
/// user's own SQL, not ours to bound. See [`crate::error::with_timeout_for`].
///
/// Was a hard constant until a SQL Server holding several hundred databases
/// took longer than this to answer `list_databases` and the tree reported a
/// connection that had just opened in under a second as unresponsive. Twenty
/// is a reasonable guess about a server we have never seen; it is not a fact,
/// so it is now the *default* behind
/// [`crate::prefs::ConnectionPrefs::operation_timeout_secs`] and
/// [`crate::state::ConnectionProfile::operation_timeout_secs`]. Resolve it
/// with [`operation_timeout`] rather than reading it directly.
pub const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(20);

/// Floor for a user-supplied introspection timeout.
///
/// Not zero, and not one: below a few seconds the timeout stops describing an
/// unresponsive connection and starts describing an ordinary round trip to a
/// server on the other side of a VPN, which turns every tree expansion into a
/// failure the user cannot diagnose.
pub const MIN_OPERATION_TIMEOUT_SECS: u32 = 5;

/// Sanity ceiling on a user-supplied introspection timeout.
///
/// Ten minutes. The point of the bound is that a genuinely dead socket is
/// discovered at all; past this the UI is indistinguishable from hung, and the
/// honest answer is that the server needs looking at rather than a bigger
/// number here.
pub const MAX_OPERATION_TIMEOUT_SECS: u32 = 600;

/// The introspection timeout in force for `profile`: its own override when it
/// has one, else the global preference. Clamped into the supported range, so a
/// hand-edited `0` in `profiles.json` cannot make every metadata call fail
/// instantly.
///
/// Twin of [`endpoint_budget`], and deliberately shaped the same way: both
/// answer "what did the user say about *this server*, and what do we do when
/// they said something impossible".
pub fn operation_timeout(profile: &ConnectionProfile, preference: u32) -> Duration {
    preference_timeout(profile.operation_timeout_secs.unwrap_or(preference))
}

/// The same clamp with no profile to consult — for an ad-hoc CLI connection,
/// which has no stored profile to carry an override.
pub fn preference_timeout(secs: u32) -> Duration {
    Duration::from_secs(u64::from(
        secs.clamp(MIN_OPERATION_TIMEOUT_SECS, MAX_OPERATION_TIMEOUT_SECS),
    ))
}

/// The server budget in force for `profile`: its own override when it has one,
/// else the global preference. Clamped into the supported range, so a
/// hand-edited `0` in `profiles.json` can't make a connection unopenable.
pub fn endpoint_budget(profile: &ConnectionProfile, preference: u32) -> u32 {
    profile
        .max_connections
        .unwrap_or(preference)
        .clamp(MIN_MAX_CONNECTIONS, MAX_MAX_CONNECTIONS)
}

/// How many connections a top-level pool should ask for against a server whose
/// total allowance is `budget`.
///
/// Leaves `child_request` behind so that opening a connection does not, by
/// itself, make the first database view unopenable. Without this a profile
/// pinned to a tight budget would have its parent pool swallow the lot and
/// every `open_database_view` would fail — a confusing way to spend a limit the
/// user set to be helpful. Never drops below [`MIN_MAX_CONNECTIONS`]: when the
/// budget genuinely cannot fit both, the parent wins and the view reports the
/// exhaustion honestly.
pub fn top_level_request(budget: u32, child_request: u32) -> u32 {
    budget
        .saturating_sub(child_request)
        .clamp(MIN_MAX_CONNECTIONS, TOP_LEVEL_REQUEST)
}

/// Resolved sizing for one pool.
///
/// Constructed from an [`crate::db::endpoint::EndpointGrant`] rather than from
/// a constant, so a pool is never larger than the share of its server it was
/// actually granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolLimits {
    pub max_connections: u32,
}

impl PoolLimits {
    /// Size a pool to what the endpoint granted it.
    pub fn granted(amount: u32) -> Self {
        Self {
            max_connections: amount,
        }
    }

    /// Limits for a short-lived pool that only has to prove the credentials
    /// work ("Test connection"). One connection, one `SELECT 1`, then closed —
    /// so it is reserved with a floor of one rather than
    /// [`MIN_MAX_CONNECTIONS`]: nothing interactive runs against it, so it
    /// cannot deadlock, and "Test" is a button users press repeatedly while
    /// fixing a typo against the very server they are struggling to get into.
    pub fn probe() -> Self {
        Self { max_connections: 1 }
    }
}

impl Default for PoolLimits {
    fn default() -> Self {
        Self::granted(TOP_LEVEL_REQUEST)
    }
}

/// URL-encode arbitrary bytes so they are safe inside a connection URL.
fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Build the `sqlx`-compatible connection URL for `profile`.
///
/// `host`/`port` are passed explicitly so callers using an SSH tunnel can
/// substitute `127.0.0.1:<local-port>` without mutating the profile.
/// For SQLite the `database` field is interpreted as a file path; for the
/// server-backed drivers it is the catalog/schema name plus host info.
pub fn build_url(profile: &ConnectionProfile, password: &str, host: &str, port: u16) -> String {
    let user = url_encode(&profile.username);
    let pwd = url_encode(password);

    match profile.driver {
        Driver::Postgres => {
            // A blank `database` is a legitimate user choice: "connect to the
            // server, then let me pick a database from the schema tree".
            // Postgres requires SOME database at connect time though, so we
            // fall back to the always-present `postgres` maintenance DB. The
            // schema tree later spawns per-DB synthetic pools (see
            // `open_database_view`) once the user expands a specific
            // database node.
            let db = if profile.database.is_empty() {
                "postgres"
            } else {
                profile.database.as_str()
            };
            // Make the SSL toggle explicit. With no `sslmode`, sqlx defaults
            // to `prefer`, which still sends a Postgres SSLRequest and
            // negotiates TLS — and that negotiation blows up against servers
            // (or poolers) that don't speak it ("unexpected response from
            // SSLRequest"). `disable` skips the SSLRequest entirely and goes
            // straight to a plaintext startup, which is what an unchecked SSL
            // box should mean.
            format!(
                "postgres://{user}:{pwd}@{host}:{port}/{db}{ssl}",
                ssl = if profile.ssl {
                    "?sslmode=require"
                } else {
                    "?sslmode=disable"
                },
            )
        }
        Driver::Mysql => {
            // MySQL accepts a URL with no database path. Leaving it blank
            // means the session starts without a default `DATABASE()` set;
            // listing/querying is then driven by per-DB synthetic pools.
            let path = if profile.database.is_empty() {
                String::new()
            } else {
                format!("/{}", profile.database)
            };
            // Same rationale as Postgres above: be explicit so an unchecked
            // SSL box means "no TLS" instead of sqlx's `PREFERRED` default
            // (which negotiates TLS and can trip the same way).
            format!(
                "mysql://{user}:{pwd}@{host}:{port}{path}{ssl}",
                ssl = if profile.ssl {
                    "?ssl-mode=REQUIRED"
                } else {
                    "?ssl-mode=DISABLED"
                },
            )
        }
        Driver::Sqlite => format!("sqlite://{}", profile.database),
        // MongoDB does not use this SQL-URL builder; its client is constructed
        // in `crate::db::mongo::open_pool`, which `open_pool` delegates to before
        // ever reaching here. Returning the raw connection string keeps the
        // match total without inventing a meaningless SQL URL.
        Driver::Mongo => profile.connection_string.clone().unwrap_or_default(),
        // Same story for SQL Server: `tiberius` is configured through a
        // `Config` builder in `crate::db::mssql::open_pool`, not a URL.
        Driver::MsSql => String::new(),
    }
}

/// Open a fresh pool for `profile`, using `password` for authentication.
///
/// If the profile carries an SSH tunnel configuration, the tunnel is
/// opened first and the `sqlx` URL is pointed at the local listener.
/// `ssh_secret` is forwarded to the SSH layer (password or key passphrase).
///
/// The returned [`DbPool`] wraps the underlying driver-specific pool; the
/// optional [`SshTunnelHandle`] is the owner of the tunnel and must be kept
/// alive for the pool's lifetime. The caller normally stashes both in
/// [`crate::state::ActivePool`].
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
    limits: PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    open_pool_routed(
        profile,
        password,
        TunnelRoute::Dial(ssh_secret),
        known_hosts,
        limits,
    )
    .await
}

/// How a pool for a tunnelled profile reaches its server.
///
/// Ignored for a profile with no SSH tunnel.
pub enum TunnelRoute {
    /// Bring up a tunnel of the pool's own, authenticating with this secret.
    /// The returned [`SshTunnelHandle`] owns it.
    Dial(Option<String>),
    /// Dial the local port of a tunnel that is already up — a per-database
    /// view riding its parent connection's tunnel. Nothing is opened and no
    /// handle is returned; the parent keeps the tunnel alive, and every
    /// teardown path closes views before their parent for exactly this reason.
    Through(u16),
}

/// [`open_pool`] with the tunnel decision made by the caller.
///
/// Exists for `open_database_view`. A per-database view used to dial an SSH
/// tunnel of its own, so every database expanded on a tunnelled connection
/// cost a full SSH handshake and authentication before its first query, and
/// held a second session open to the bastion for as long as the view lived.
/// Its parent's tunnel already reaches the same `host:port`, and each
/// connection through it gets its own `direct-tcpip` channel, so a view now
/// goes [`TunnelRoute::Through`] the parent's local port instead.
pub async fn open_pool_routed(
    profile: &ConnectionProfile,
    password: &str,
    route: TunnelRoute,
    known_hosts: SharedKnownHosts,
    limits: PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    // MongoDB has its own connection model (URI / SRV / tunnel rules) and is
    // built entirely in the mongo module. Its per-database views reuse the
    // parent's client and never come through here, so only `Dial` reaches it.
    if matches!(profile.driver, Driver::Mongo) {
        let TunnelRoute::Dial(ssh_secret) = route else {
            return Err(AppError::InvalidInput(
                "a MongoDB pool cannot share another pool's SSH tunnel".into(),
            ));
        };
        return crate::db::mongo::open_pool(profile, password, ssh_secret, known_hosts, limits)
            .await;
    }
    // SQL Server likewise builds its own client (and its own session pool, since
    // `tiberius` has none). It *does* tunnel over SSH, so unlike the Mongo arm
    // this one still goes through `db::ssh` — inside `mssql::open_pool`, which
    // owns the tunnel-vs-named-instance interaction.
    if matches!(profile.driver, Driver::MsSql) {
        return crate::db::mssql::open_pool(profile, password, route, known_hosts, limits).await;
    }

    // SQLite is a local file; tunnels don't apply. For network drivers,
    // bring the tunnel up first so we know which local port to target.
    //
    // `effective_port`, not `profile.port`: a profile saved with a blank port
    // means "the driver's default", and that has to be resolved before either
    // branch — the tunnel's *remote* port is as much a real port as the one
    // the URL names.
    let remote_port = profile.effective_port();
    let (host, port, handle): (String, u16, Option<SshTunnelHandle>) = if let (
        Some(tunnel),
        false,
    ) = (
        profile.ssh_tunnel.as_ref(),
        matches!(profile.driver, Driver::Sqlite),
    ) {
        match route {
            TunnelRoute::Dial(ssh_secret) => {
                let h =
                    ssh::open_tunnel(tunnel, ssh_secret, &profile.host, remote_port, known_hosts)
                        .await?;
                ("127.0.0.1".to_string(), h.local_port, Some(h))
            }
            TunnelRoute::Through(local_port) => ("127.0.0.1".to_string(), local_port, None),
        }
    } else {
        (profile.host.clone(), remote_port, None)
    };

    let url = build_url(profile, password, &host, port);
    let what = endpoint_label(profile, &host, port);
    let pool = match profile.driver {
        Driver::Postgres => {
            DbPool::Postgres(connect_probed(&url, &what, limits.max_connections).await?)
        }
        Driver::Mysql => DbPool::Mysql(connect_probed(&url, &what, limits.max_connections).await?),
        // MongoDB and SQL Server are handled by the early returns at the top of
        // this function.
        Driver::Mongo => unreachable!("mongo handled by db::mongo::open_pool"),
        Driver::MsSql => unreachable!("sql server handled by db::mssql::open_pool"),
        // SQLite is a local file: no server to run out of connections, and a
        // second writer only buys lock contention. Fixed at one, tuned the
        // same way so an abandoned tab doesn't hold the file handle open. Goes
        // through the same probe as the network drivers so a missing or
        // unreadable file is reported as itself rather than as a pool timeout.
        Driver::Sqlite => {
            DbPool::Sqlite(connect_probed(&url, &what, MAX_CONNECTIONS_SQLITE).await?)
        }
    };
    Ok((pool, handle))
}

/// Apply the shared sizing/lifetime policy to any driver's `PoolOptions`.
///
/// Generic over the driver so the four call sites above cannot drift apart —
/// which they previously had room to, since each set `max_connections` and
/// nothing else and inherited four separate implicit `sqlx` defaults.
///
/// `min_connections(0)` is stated rather than inherited because it is the
/// single most important value here: it is what lets an untouched pool decay
/// to zero sockets instead of holding a floor open against a server other
/// tools are competing for.
fn tuned<DB>(
    options: sqlx::pool::PoolOptions<DB>,
    max_connections: u32,
) -> sqlx::pool::PoolOptions<DB>
where
    DB: sqlx::Database,
{
    options
        .max_connections(max_connections)
        .min_connections(0)
        .idle_timeout(Some(IDLE_TIMEOUT))
        .max_lifetime(Some(MAX_LIFETIME))
        .acquire_timeout(ACQUIRE_TIMEOUT)
        // Replaces sqlx's own health check rather than adding to it; see
        // `check_before_use`.
        .test_before_acquire(false)
        .before_acquire(|conn, _meta| Box::pin(check_before_use(conn)))
}

/// How long the check a pooled connection passes on its way out of the pool
/// may take before that connection is thrown away.
///
/// sqlx's own check (`test_before_acquire`) pings every connection it hands
/// out, which is right, but it has **no timeout of its own**. A socket a NAT
/// had silently dropped (no FIN, no RST) never answered the ping, so the
/// checkout waited out the whole [`ACQUIRE_TIMEOUT`] — thirty seconds — and
/// then failed as `PoolTimedOut`, which [`crate::error::AppError`] reports as
/// *too many connections*. A query after a coffee break looked like a full
/// server. Now a check that does not answer within this bound discards that
/// one connection, and the pool simply opens a fresh one.
///
/// **Every** checkout is still checked. Skipping the check for a connection
/// used in the last thirty seconds was tried and measured behind an SSH
/// tunnel: it saved about 12 ms a query, and it handed out connections that
/// had died with the tunnel's session a moment earlier — the next query failed
/// outright instead of being given a fresh connection. Not a trade worth making
/// in a release whose point is fewer surprise disconnections.
pub const STALE_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// The check a connection passes on its way out of the pool. `Err` makes sqlx
/// close it hard and try another (or open a new one); see
/// `sqlx_core::pool::inner::check_idle_conn`.
async fn check_before_use<C>(conn: &mut C) -> Result<bool, sqlx::Error>
where
    C: sqlx::Connection,
{
    bounded_check(STALE_CHECK_TIMEOUT, conn.ping()).await
}

/// [`check_before_use`]'s verdict on one ping, bounded. A parameter rather
/// than [`STALE_CHECK_TIMEOUT`] directly so the timeout branch is testable in
/// milliseconds — the same shape, for the same reason, as `bounded_connect`.
async fn bounded_check(
    bound: Duration,
    ping: impl std::future::Future<Output = Result<(), sqlx::Error>>,
) -> Result<bool, sqlx::Error> {
    match tokio::time::timeout(bound, ping).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "an idle pooled connection did not answer its health check",
        ))),
    }
}

/// What the user needs to see named when a pool cannot be opened: the driver
/// and the address actually dialled.
///
/// Takes the resolved `host`/`port` rather than reading them off `profile`,
/// because behind an SSH tunnel the pool dials `127.0.0.1:<local-port>` and
/// saying so is the difference between "the tunnel is up but the database
/// isn't listening on the far side" and "the tunnel never came up".
fn endpoint_label(profile: &ConnectionProfile, host: &str, port: u16) -> String {
    format!("{} at {host}:{port}", profile.driver.wire_name())
}

/// The one wording every open-time reachability failure ends with.
///
/// Deliberately word-for-word the message `crate::db::mssql`'s
/// `bound_by_acquire_timeout` already produces: SQL Server is the driver that
/// had to solve this first (it has no pool, so no `acquire_timeout` knob), and
/// it arrived at the honest phrasing. The other drivers now say the same thing
/// for the same condition instead of each inventing its own.
fn unreachable_message(what: &str, bound: Duration) -> String {
    format!(
        "connecting to {what} took longer than {}s — the host may be unreachable, or something \
         between here and it is silently dropping the connection",
        bound.as_secs()
    )
}

/// One connect attempt, bounded, whose error is whatever actually happened.
///
/// `bound` is a parameter rather than [`ACQUIRE_TIMEOUT`] directly so the
/// timeout branch is testable in milliseconds instead of needing a real
/// thirty-second wait — the same shape, for the same reason, as
/// `mssql::bound_by_acquire_timeout`.
async fn bounded_connect<T>(
    bound: Duration,
    what: &str,
    fut: impl std::future::Future<Output = Result<T, sqlx::Error>>,
) -> AppResult<T> {
    match tokio::time::timeout(bound, fut).await {
        Ok(Ok(v)) => Ok(v),
        // Straight through `From<sqlx::Error>`: a genuine limit refusal is
        // still a limit refusal here, carrying the server's own message.
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(AppError::OperationTimedOut(unreachable_message(
            what, bound,
        ))),
    }
}

/// Prove the endpoint is reachable with one un-pooled connection, then hand
/// back a **lazy** pool.
///
/// This shape exists because `sqlx`'s eager `PoolOptions::connect` cannot say
/// why it failed. Its `PoolInner::connect` retries everything it deems
/// transient — an `Io` error whose kind is `ConnectionRefused` ("an IO error
/// while connecting is assumed to be the system starting up"), and a `Database`
/// error whose `is_transient_in_connect_phase()` holds, which on Postgres is
/// `53300` (`too_many_connections`) and `57P03` — with backoff until the
/// acquire deadline, and then returns `sqlx::Error::PoolTimedOut`, **discarding
/// the cause**. Since [`crate::error::AppError`]'s conversion reads that
/// variant as a connection-limit refusal, a typo'd port used to reach the user
/// as "too many connections", thirty seconds late, offering "release idle
/// pools" — for a server that was not full and had never answered. See gotcha
/// #66.
///
/// A single direct connection has no retry loop, so its error is the real one:
/// a refused connect fails immediately, a wrong password stays a wrong
/// password, a genuine `53300` arrives as a `Database` error and is still
/// classified as a limit refusal *with the server's own message*, and only a
/// host that silently drops packets reaches the timeout.
///
/// `connect_lazy` rather than `connect` for the pool itself is what makes the
/// fix structural instead of a second classification: after this, the open path
/// cannot produce `PoolTimedOut` at all, so that variant means exactly one
/// thing everywhere it is still handled — `acquire()` starving on a pool that
/// already exists. It also keeps the total at one handshake, where probing and
/// then connecting eagerly would cost two.
async fn connect_probed<DB>(
    url: &str,
    what: &str,
    max_connections: u32,
) -> AppResult<sqlx::Pool<DB>>
where
    DB: sqlx::Database,
{
    let probe = bounded_connect(
        ACQUIRE_TIMEOUT,
        what,
        <DB::Connection as sqlx::Connection>::connect(url),
    )
    .await?;
    // Best effort: the probe has already answered the question, and a close
    // that fails leaves one session the server reaps on its own. Failing the
    // whole connect over it would be the wrong verdict.
    let _ = probe.close().await;
    Ok(tuned(sqlx::pool::PoolOptions::<DB>::new(), max_connections).connect_lazy(url)?)
}

/// Whether a pool owns the driver resources behind it, or borrows them from
/// another pool.
///
/// Only MongoDB makes the distinction observable, and it is load-bearing there:
/// a synthetic per-database view (`resolve_mongo_database_view`) reuses the
/// *parent's* `mongodb::Client` and only re-tags the target database. Shutting
/// that client down to "close the view" would tear down the parent connection
/// the user is still using — and the idle-pool reaper sweeps views by age
/// without knowing which driver they belong to, so it would do exactly that,
/// silently, five minutes after the user last touched a Mongo database.
///
/// The SQL drivers own their pools outright (a view has its own pool, and
/// possibly its own SSH tunnel), so both variants close them the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolOwnership {
    /// A top-level connection, or a standalone throwaway pool. Closing it
    /// releases everything underneath.
    Owned,
    /// A synthetic `<parent>::db::<name>` view. Closing it must not touch
    /// resources shared with the parent.
    BorrowedView,
}

impl PoolOwnership {
    /// Classify by connection id: anything carrying the synthetic `::db::`
    /// infix is a per-database view. Used by the sweep paths, which work from
    /// ids rather than from how a pool was created.
    pub fn for_id(id: &str) -> Self {
        if crate::state::is_database_view(id) {
            Self::BorrowedView
        } else {
            Self::Owned
        }
    }
}

/// Close `pool` gracefully, waiting for its connections to actually go away.
///
/// Dropping a `sqlx::Pool` is *not* equivalent: `Drop` cannot await, so it can
/// only signal the pool closed and let the sockets be torn down whenever the
/// runtime gets to them. The difference is invisible on a healthy LAN — the
/// server sees the FIN and reaps the backend — and very visible everywhere the
/// user is actually complaining: behind a connection pooler, through an SSH
/// tunnel, or during a burst where HuginnDB closes and reopens pools back to
/// back (`disconnect` → `connect` on a reconnect, or an environment switch
/// tearing down every pool before restoring the next environment's). There,
/// the old sessions can still be attached when the new ones ask for slots, and
/// the user's connection budget is transiently doubled at the worst moment.
///
/// `drop_database` already reached this conclusion in isolation and did the
/// awaited close by hand; this is that reasoning applied everywhere.
///
/// Bounded by `timeout`, because a pool whose server has gone away can take
/// the full TCP timeout to close and no teardown path should block on that.
/// A timed-out close falls back to the drop behaviour, which is what we had
/// before — never worse.
pub async fn close_pool(pool: &DbPool, ownership: PoolOwnership, timeout: Duration) {
    let closing = async {
        match pool {
            DbPool::Postgres(p) => p.close().await,
            DbPool::Mysql(p) => p.close().await,
            DbPool::Sqlite(p) => p.close().await,
            // The Mongo driver owns its own pooling; `shutdown` drains the
            // in-flight operations and closes the sockets. `clone` because it
            // consumes the client, and clones are cheap `Arc` handles — which
            // is precisely the hazard: a per-database view holds a clone of the
            // *parent's* client, so shutting it down here would close the
            // connection the user still has open. See [`PoolOwnership`].
            DbPool::Mongo(conn) => {
                if ownership == PoolOwnership::Owned {
                    conn.client.clone().shutdown().await
                }
            }
            // Unlike Mongo, a SQL Server per-database view owns its own
            // sessions: `open_database_view` clones the profile with the
            // database substituted and opens a second `MsSqlPool`, sharing
            // nothing with the parent. So both ownerships close.
            DbPool::MsSql(p) => p.close().await,
        }
    };
    let _ = tokio::time::timeout(timeout, closing).await;
}

/// Default budget for [`close_pool`]. Long enough for a healthy server to
/// acknowledge, short enough that a dead one doesn't stall a disconnect.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `SELECT 1` against a freshly opened pool to verify credentials.
///
/// Opened with [`PoolLimits::probe`] — a credentials check needs exactly one
/// connection, and "Test" is a button users press repeatedly while fixing a
/// typo, so it must not cost five slots a go on the server they're already
/// struggling to get into.
///
/// The pool is closed explicitly (rather than left to `Drop`) and any
/// associated SSH tunnel torn down, so the test leaves nothing behind — see
/// [`close_pool`].
pub async fn smoke_test(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
) -> AppResult<()> {
    let (pool, _handle) = open_pool(
        profile,
        password,
        ssh_secret,
        known_hosts,
        PoolLimits::probe(),
    )
    .await?;
    // The probe pool is ours alone, so it is closed whether or not the ping
    // succeeded — hence the result is held rather than `?`-ed.
    let result = crate::db::exec::ping(&pool).await;
    close_pool(&pool, PoolOwnership::Owned, CLOSE_TIMEOUT).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The routing that keeps a Mongo per-database view from shutting down its
    /// parent's shared client. The consequence itself isn't unit-testable
    /// without a live deployment — `Client::shutdown` only becomes observable
    /// on the next operation — so this pins the classification every sweep path
    /// depends on instead.
    #[test]
    fn ownership_is_derived_from_the_synthetic_view_infix() {
        assert_eq!(
            PoolOwnership::for_id("6f1a-…-profile"),
            PoolOwnership::Owned
        );
        assert_eq!(
            PoolOwnership::for_id("6f1a-…-profile::db::analytics"),
            PoolOwnership::BorrowedView
        );
        // A database whose *name* contains the infix still resolves correctly:
        // the id is `<parent>::db::<name>`, so any match at all means a view.
        assert_eq!(
            PoolOwnership::for_id("p::db::weird::db::name"),
            PoolOwnership::BorrowedView
        );
    }

    /// The half of ADR #66 that is unit-testable without a server: a host
    /// that never answers must not be reported as a server that is full, and
    /// must not carry the marker the frontend keys "release idle pools" off.
    ///
    /// Bounded in milliseconds via `bounded_connect`'s parameter rather than
    /// the real [`ACQUIRE_TIMEOUT`] — the same trick, for the same reason, as
    /// `mssql::bound_by_acquire_timeout`'s own test.
    #[tokio::test]
    async fn a_host_that_never_answers_times_out_instead_of_reporting_a_limit() {
        let e = bounded_connect(
            Duration::from_millis(20),
            "mysql at db.internal:3306",
            std::future::pending::<Result<(), sqlx::Error>>(),
        )
        .await
        .expect_err("a pending connect must not resolve");
        assert!(
            !e.is_too_many_connections(),
            "a server we never reached is not a server that is full"
        );
        assert!(matches!(e, AppError::OperationTimedOut(_)));
        let rendered = e.to_string();
        assert!(rendered.contains("mysql at db.internal:3306"));
        assert!(rendered.contains("may be unreachable"));
    }

    /// The other side of the same coin: the probe reports driver errors as
    /// themselves, so a genuine limit refusal — which MySQL sends pre-auth,
    /// before there is a structured `DatabaseError` to downcast — still reaches
    /// the user as a limit refusal, in the server's own words.
    #[tokio::test]
    async fn a_real_limit_refusal_survives_the_probe_with_the_servers_wording() {
        let e = bounded_connect(
            Duration::from_secs(30),
            "mysql at db.internal:3306",
            std::future::ready(Err::<(), _>(sqlx::Error::Protocol(
                "ERROR 1040 (08004): Too many connections".into(),
            ))),
        )
        .await
        .expect_err("the driver said no");
        assert!(e.is_too_many_connections());
        assert!(e.to_string().contains("Too many connections"));
    }

    /// A refused connect is not a timeout and must not be dressed as one — it
    /// is the case that used to cost the user thirty seconds of sqlx retries.
    #[tokio::test]
    async fn a_refused_connect_stays_an_io_error() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "connection refused");
        let e = bounded_connect(
            Duration::from_secs(30),
            "postgres at 127.0.0.1:5432",
            std::future::ready(Err::<(), _>(sqlx::Error::Io(io))),
        )
        .await
        .expect_err("nothing was listening");
        assert!(!e.is_too_many_connections());
        assert!(matches!(e, AppError::Database(_)));
    }

    /// A pooled connection whose socket a NAT dropped silently never answers
    /// its check. That must cost the one connection, in seconds — not the whole
    /// thirty-second acquire, reported as a server with no connections left.
    #[tokio::test]
    async fn a_connection_that_never_answers_its_check_is_discarded_not_waited_on() {
        let e = bounded_check(
            Duration::from_millis(20),
            std::future::pending::<Result<(), sqlx::Error>>(),
        )
        .await
        .expect_err("a silent connection must be rejected");
        // `Io`, so sqlx closes it hard and opens another, and so it can never
        // be read as a connection-limit refusal.
        assert!(matches!(e, sqlx::Error::Io(ref io) if io.kind() == std::io::ErrorKind::TimedOut));
        assert!(!AppError::from(e).is_too_many_connections());
    }

    #[tokio::test]
    async fn a_connection_that_answers_is_handed_out_and_a_broken_one_is_not() {
        assert!(
            bounded_check(Duration::from_secs(5), std::future::ready(Ok(())))
                .await
                .unwrap()
        );
        let refused = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        assert!(bounded_check(
            Duration::from_secs(5),
            std::future::ready(Err(sqlx::Error::Io(refused)))
        )
        .await
        .is_err());
    }

    /// The real hook, end to end, against a live connection.
    #[tokio::test]
    async fn the_hook_passes_a_live_connection() {
        use sqlx::Connection;
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:")
            .await
            .unwrap();
        assert!(check_before_use(&mut conn).await.unwrap());
    }

    /// SQL Server solved this first and its wording is the one the user has
    /// already seen; the other drivers must not invent a second one.
    #[test]
    fn the_unreachable_wording_names_the_endpoint_and_the_bound() {
        let m = unreachable_message("mysql at 10.0.0.9:3306", ACQUIRE_TIMEOUT);
        assert!(m.contains("mysql at 10.0.0.9:3306"));
        assert!(m.contains(&ACQUIRE_TIMEOUT.as_secs().to_string()));
    }

    #[test]
    fn the_endpoint_label_names_the_address_actually_dialled() {
        // Behind a tunnel the pool dials loopback, and saying so is the whole
        // point — the profile's own host never appears here.
        let p = crate::testkit::profile("p");
        assert_eq!(
            endpoint_label(&p, "127.0.0.1", 54321),
            format!("{} at 127.0.0.1:54321", p.driver.wire_name())
        );
    }

    fn profile(max_connections: Option<u32>) -> ConnectionProfile {
        ConnectionProfile {
            max_connections,
            ..crate::testkit::profile("p")
        }
    }

    #[test]
    fn the_profile_override_beats_the_global_preference() {
        assert_eq!(endpoint_budget(&profile(Some(3)), 10), 3);
        assert_eq!(endpoint_budget(&profile(None), 10), 10);
    }

    #[test]
    fn budgets_are_clamped_into_a_usable_range() {
        // Below the floor a batch holding a connection would deadlock the next
        // acquire, so a hand-edited 0/1 is raised rather than honoured.
        assert_eq!(endpoint_budget(&profile(Some(0)), 10), MIN_MAX_CONNECTIONS);
        assert_eq!(
            endpoint_budget(&profile(Some(9_000)), 10),
            MAX_MAX_CONNECTIONS
        );
    }

    fn timed(secs: Option<u32>) -> ConnectionProfile {
        ConnectionProfile {
            operation_timeout_secs: secs,
            ..crate::testkit::profile("p")
        }
    }

    #[test]
    fn the_profile_timeout_beats_the_global_preference() {
        // Same precedence as the budget above, for the same reason: how long a
        // server takes to answer is a fact about that server.
        assert_eq!(operation_timeout(&timed(Some(90)), 20).as_secs(), 90);
        assert_eq!(operation_timeout(&timed(None), 45).as_secs(), 45);
        assert_eq!(
            operation_timeout(&timed(None), DEFAULT_OPERATION_TIMEOUT.as_secs() as u32),
            DEFAULT_OPERATION_TIMEOUT
        );
    }

    #[test]
    fn timeouts_are_clamped_into_a_usable_range() {
        // A hand-edited 0 would fail every metadata call instantly and look
        // exactly like a dead server, so it is raised rather than honoured.
        assert_eq!(
            operation_timeout(&timed(Some(0)), 20).as_secs(),
            u64::from(MIN_OPERATION_TIMEOUT_SECS)
        );
        assert_eq!(
            operation_timeout(&timed(Some(u32::MAX)), 20).as_secs(),
            u64::from(MAX_OPERATION_TIMEOUT_SECS)
        );
        // The preference is clamped too — it reaches the same function.
        assert_eq!(
            operation_timeout(&timed(None), 1).as_secs(),
            u64::from(MIN_OPERATION_TIMEOUT_SECS)
        );
    }

    #[test]
    fn a_top_level_pool_leaves_room_for_a_database_view() {
        // Comfortable budget: the parent takes its full request and half the
        // server's allowance is still free for views.
        assert_eq!(top_level_request(10, 2), TOP_LEVEL_REQUEST);
        // Tight budget: the parent gives ground so the first view can open at
        // all, which is the case that used to fail confusingly.
        assert_eq!(top_level_request(4, 2), 2);
        assert_eq!(top_level_request(6, 2), 4);
    }

    #[test]
    fn a_top_level_pool_never_shrinks_below_the_floor() {
        // No budget can fit both a usable parent and a usable view here; the
        // parent wins and the view reports the exhaustion honestly rather than
        // the parent becoming deadlock-prone to make room.
        assert_eq!(top_level_request(2, 2), MIN_MAX_CONNECTIONS);
        assert_eq!(top_level_request(3, 2), MIN_MAX_CONNECTIONS);
    }
}
