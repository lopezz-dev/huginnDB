//! MongoDB driver support.
//!
//! MongoDB's document model diverges sharply from the SQL drivers, so all of
//! its logic lives here rather than being woven into the SQL command paths. The
//! command layer keeps thin `DbPool::Mongo(_)` arms that delegate to this
//! module:
//!
//! * [`query`]  — execute `mongosh`-style statements + collection CRUD, shaped
//!   into the SQL-shaped DTOs the frontend already consumes.
//! * [`aggregation`] — pipeline preview + the view editor's create/alter path
//!   (`{create|collMod, viewOn, pipeline}`), MongoDB's answer to `CREATE VIEW`.
//! * [`schema`] — introspection (databases, collections, inferred fields,
//!   indexes). MongoDB is schemaless, so field lists are *sampled*.
//! * [`indexes`] — the index manager's catalogue + create/hide/recreate/drop.
//!   Separate from [`schema`]'s `list_indexes`, which is deliberately lossy to
//!   fit the SQL explorer's DTO; see that module's own doc comment.
//! * [`shell`]  — a bounded parser for `db.coll.method(...)` statements.
//! * [`values`] — BSON ⇄ JSON conversion (display + round-trip).
//!
//! [`open_pool`] builds the client from a connection URI (the primary input,
//! covering Atlas `mongodb+srv://`, replica sets, and URI options) or from the
//! discrete profile fields, and gates SSH tunnelling to single-host
//! `mongodb://` URIs (an SRV record resolves to several hosts, which the
//! single-port tunnel model can't represent — see the roadmap).

pub mod aggregation;
pub mod indexes;
pub mod pulse;
pub mod query;
pub mod schema;
pub mod shell;
pub mod values;

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, MongoConn};
use mongodb::event::cmap::CmapEvent;
use mongodb::event::EventHandler;
use mongodb::options::{ClientOptions, Credential, ServerAddress};
use mongodb::Client;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// URL-encode a component for use inside a `mongodb://` URI.
fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Open a MongoDB client for `profile`.
///
/// Returns the same `(DbPool, Option<SshTunnelHandle>)` shape as the SQL
/// [`crate::db::pool::open_pool`] so the connection lifecycle code is uniform.
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
    limits: crate::db::pool::PoolLimits,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    // Primary input is the connection string; fall back to assembling one from
    // the discrete fields when it is absent.
    let uri = match profile
        .connection_string
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(cs) => cs.to_string(),
        None => {
            let db = if profile.database.is_empty() {
                String::new()
            } else {
                format!("/{}", profile.database)
            };
            // Append `?authSource=…` when the profile pins one (CLI
            // `--auth-source`). Without it, auth defaults to the connection's
            // database — the exact gap that made URI-less Mongo logins fail.
            let query = match profile.auth_source.as_deref().map(str::trim) {
                Some(src) if !src.is_empty() => format!("?authSource={}", enc(src)),
                _ => String::new(),
            };
            // `effective_port` rather than the raw field: a URI-less profile
            // with no port (CLI `--host` without `--port`, or a dialog profile
            // whose port box was left blank) used to assemble
            // `mongodb://host:0/db`, which the driver rejects outright.
            let port = profile.effective_port();
            if profile.username.is_empty() {
                format!("mongodb://{}:{}{}{}", profile.host, port, db, query)
            } else {
                format!(
                    "mongodb://{}:{}@{}:{}{}{}",
                    enc(&profile.username),
                    enc(password),
                    profile.host,
                    port,
                    db,
                    query
                )
            }
        }
    };

    let is_srv = uri.starts_with("mongodb+srv://");
    let mut options = ClientOptions::parse(&uri).await?;
    // Fail fast in the UI instead of waiting out the 30 s default.
    options.server_selection_timeout = Some(Duration::from_secs(8));
    options.app_name = Some("HuginnDB".to_string());

    // Bound the driver's own pool to the same budget the SQL drivers get.
    //
    // Without this the `mongodb` crate's default applies: `maxPoolSize` 100
    // **per host**, so a three-node replica set was a ceiling of 300 sockets
    // from one connection — a 20x divergence from the SQL drivers' five, by
    // omission rather than by decision. It rarely bit on a self-hosted server
    // (whose own limit is high) but it is exactly what trips an Atlas tier cap,
    // and it turns a replica-set failover into a connection storm.
    //
    // `min_pool_size(0)` matches `min_connections(0)` on the sqlx side: an
    // untouched client should decay to nothing rather than hold a floor. Note
    // this budget is per *client*, and a per-database "view"
    // (`resolve_mongo_database_view`) reuses the parent's client rather than
    // building another — so unlike the SQL drivers, browsing N databases here
    // costs nothing extra.
    options.max_pool_size = Some(limits.max_connections);
    options.min_pool_size = Some(0);
    options.max_idle_time = Some(crate::db::pool::IDLE_TIMEOUT);

    // Count the pooled connections ourselves: the driver has no public pool
    // size, and the Settings footprint needs the real number next to the
    // reservation. CMAP events cover pooled connections only — the driver's
    // own server monitors are on top, one or two per host, and not counted.
    let sockets = Arc::new(AtomicU32::new(0));
    let counter = Arc::clone(&sockets);
    options.cmap_event_handler = Some(EventHandler::callback(move |event| match event {
        CmapEvent::ConnectionCreated(_) => {
            counter.fetch_add(1, Ordering::Relaxed);
        }
        CmapEvent::ConnectionClosed(_) => {
            // Saturating: a close for a connection created before the handler
            // existed cannot happen today, but must never wrap to four billion.
            let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            });
        }
        _ => {}
    }));

    // Inject a keychain-sourced password when the URI carried none (URI-primary
    // mode where the secret is stored separately rather than embedded). The
    // credential builder is type-state, so we take any existing credential (or
    // an all-default one) and mutate its optional fields rather than chaining.
    if !password.is_empty() {
        let mut cred = options
            .credential
            .take()
            .unwrap_or_else(|| Credential::builder().build());
        if cred.password.is_none() {
            cred.password = Some(password.to_string());
        }
        if cred.username.is_none() && !profile.username.is_empty() {
            cred.username = Some(profile.username.clone());
        }
        // Honour an explicit authSource when the URI didn't carry one (e.g. a
        // profile that stores `auth_source` but a bare `mongodb://…` URI).
        if cred.source.is_none() {
            if let Some(src) = profile.auth_source.as_deref().map(str::trim) {
                if !src.is_empty() {
                    cred.source = Some(src.to_string());
                }
            }
        }
        options.credential = Some(cred);
    }

    // SSH tunnel: supported only for a single-host `mongodb://` URI. An SRV URI
    // resolves to several hosts via DNS, which the single-port tunnel can't
    // represent; a multi-host seed list has the same problem.
    let mut handle: Option<SshTunnelHandle> = None;
    if let Some(tunnel) = profile.ssh_tunnel.as_ref() {
        if is_srv {
            return Err(AppError::InvalidInput(
                "SSH tunnelling is not supported for mongodb+srv:// connections (SRV resolves to \
                 multiple hosts). Use a direct mongodb://host:port URI to tunnel."
                    .into(),
            ));
        }
        if options.hosts.len() != 1 {
            return Err(AppError::InvalidInput(
                "SSH tunnelling requires a single-host mongodb://host:port URI; this connection \
                 lists multiple hosts."
                    .into(),
            ));
        }
        let (remote_host, remote_port) = match &options.hosts[0] {
            ServerAddress::Tcp { host, port } => (host.clone(), port.unwrap_or(27017)),
            other => {
                return Err(AppError::InvalidInput(format!(
                    "SSH tunnelling is not supported for this host type: {other}"
                )))
            }
        };
        let h =
            ssh::open_tunnel(tunnel, ssh_secret, &remote_host, remote_port, known_hosts).await?;
        // Point the driver at the local tunnel endpoint and force a direct
        // connection so topology discovery doesn't try to reach the real host.
        options.hosts = vec![ServerAddress::Tcp {
            host: "127.0.0.1".to_string(),
            port: Some(h.local_port),
        }];
        options.direct_connection = Some(true);
        options.repl_set_name = None;
        handle = Some(h);
    }

    // The connection's default database (URI path or explicit field), used as
    // the "current db" for `db.coll.…` statements until the user picks another.
    let database = options.default_database.clone().or_else(|| {
        if profile.database.is_empty() {
            None
        } else {
            Some(profile.database.clone())
        }
    });

    let client = Client::with_options(options)?;
    let conn = MongoConn {
        client,
        database,
        sockets,
    };
    // Fail fast on an unreachable host or bad credentials, instead of surfacing
    // the failure on the first schema read. `Client::with_options` is *lazy* —
    // it parses, validates and spawns the driver's monitor tasks without ever
    // touching the network — so without this MongoDB was the one driver of five
    // whose `connect` could not fail: the sqlx pools probe in
    // `db::pool::connect_probed` and SQL Server pings in `mssql::open_pool`,
    // both for exactly this reason. What made it more than a latency
    // difference is that `useSchema.refresh` swallows its error onto the slice
    // rather than rethrowing, so `connectAndWarm` went on to report
    // "Connected" for a server that had never answered. See ADR #68.
    //
    // Bounded by the `server_selection_timeout` set above, and it is the same
    // `ping` "Test connection" has always run through `db::pool::smoke_test` —
    // which is the evidence that `admin.ping` is reachable wherever a profile
    // works at all.
    schema::ping(&conn).await?;
    Ok((DbPool::Mongo(conn), handle))
}
