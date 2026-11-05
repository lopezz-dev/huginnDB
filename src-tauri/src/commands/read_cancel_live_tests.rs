//! An AI's read, stopped on a real server (ADR #134).
//!
//! What the SQLite tests beside `execute_read_bounded` cannot show is the
//! server's side: that a statement past its deadline, or whose caller went
//! away, is **no longer running there**. Closing the socket is not proof of
//! that — PostgreSQL and MySQL go on with a statement that sends nothing until
//! it ends — so each test asks the server's own activity view, from another
//! connection, whether the statement is still alive.
//!
//! `#[ignore]`d because they need servers. Set any of the variables below and
//! run
//!
//! ```text
//! cargo test --features mcp read_cancel_live -- --ignored --nocapture
//! ```
//!
//! * `HUGINNDB_TEST_PG_URL` — `postgres://…`, as for `pg_live_tests`
//! * `HUGINNDB_TEST_MYSQL_URL` — `mysql://…` (MySQL or MariaDB)
//! * `HUGINNDB_TEST_MSSQL_HOST` (+ `_DB`, `_USER`, `_PASSWORD`), as for
//!   `mssql_live_tests`; the login needs `VIEW SERVER STATE` to look
//!   at `sys.dm_exec_requests`
//!
//! A test whose variable is unset passes without doing anything, so one
//! server is enough to run the others' file.

use std::time::Duration;

use serde_json::json;

use crate::commands::query::execute_read_bounded;
use crate::log_bus::{LogEntry, LogSink};
use crate::state::{ActivePool, AppState, ConnectionProfile, DbPool, Driver, McpTimeout};

/// In every probe statement, so the activity view can find it.
const MARK: &str = "huginndb_cancel_probe";

struct Quiet;
impl LogSink for Quiet {
    fn log(&self, _: LogEntry) {}
}

fn state_with(pool: DbPool) -> AppState {
    let state = AppState::new();
    state
        .connections
        .write()
        .insert("c".into(), ActivePool::bare(pool));
    state
}

fn seconds(secs: u32) -> McpTimeout {
    McpTimeout {
        secs,
        requested: None,
        cap: secs,
    }
}

/// How each server says whether the probe is still running, asked from a
/// connection of the test's own.
enum Watch {
    Postgres(sqlx::PgPool),
    Mysql(sqlx::MySqlPool),
    MsSql(crate::db::mssql::MsSqlPool),
}

impl Watch {
    async fn probe_is_running(&self) -> bool {
        match self {
            Watch::Postgres(p) => {
                sqlx::query_scalar::<_, i64>(&format!(
                    "SELECT COUNT(*) FROM pg_stat_activity \
                 WHERE state = 'active' AND pid <> pg_backend_pid() \
                   AND query LIKE '%{MARK}%'"
                ))
                .fetch_one(p)
                .await
                .unwrap()
                    > 0
            }
            Watch::Mysql(p) => {
                sqlx::query_scalar::<_, i64>(&format!(
                    "SELECT COUNT(*) FROM information_schema.processlist \
                 WHERE id <> CONNECTION_ID() AND command = 'Query' \
                   AND info LIKE '%{MARK}%'"
                ))
                .fetch_one(p)
                .await
                .unwrap()
                    > 0
            }
            Watch::MsSql(p) => {
                p.scalar(
                    &format!(
                        "SELECT CAST(COUNT(*) AS BIGINT) FROM sys.dm_exec_requests r \
                         CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t \
                         WHERE r.session_id <> @@SPID AND t.text LIKE '%{MARK}%'"
                    ),
                    &[],
                )
                .await
                .unwrap()
                .unwrap_or(0)
                    > 0
            }
        }
    }

    /// Wait up to ten seconds for the probe to be gone: a cancel is
    /// asynchronous on every server, and closing a socket more so.
    async fn assert_probe_stops(&self, what: &str) {
        for _ in 0..50 {
            if !self.probe_is_running().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("{what}: the statement is still running on the server");
    }
}

/// Start the probe in a task of its own, and wait until the server shows it
/// running — without that, "no longer running" would prove nothing.
async fn start(
    pool: DbPool,
    watch: &Watch,
    slow: &str,
    secs: u32,
) -> tokio::task::JoinHandle<crate::error::AppResult<crate::commands::query::QueryResult>> {
    let state = state_with(pool);
    let slow = slow.to_string();
    let read = tokio::spawn(async move {
        execute_read_bounded(&Quiet, &state, "c", &slow, seconds(secs)).await
    });
    for _ in 0..20 {
        if watch.probe_is_running().await {
            return read;
        }
        assert!(!read.is_finished(), "the probe ended before it was seen");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the probe never showed up in the server's activity view");
}

/// Past its deadline: the error says it was cancelled, and the server agrees.
async fn deadline_stops_it(pool: DbPool, watch: Watch, slow: &str) {
    let read = start(pool, &watch, slow, 3).await;
    let err = read
        .await
        .unwrap()
        .expect_err("the probe runs far past three seconds");
    let message = err.to_string();
    eprintln!("deadline: {message}");
    assert!(message.contains("ran out of time after 3 s"), "{message}");
    watch.assert_probe_stops("after the deadline").await;
}

/// The caller gone — the bridge dropping the read when the sidecar hangs up,
/// the sidecar dropping it when the MCP client cancels: the server stops it.
async fn drop_stops_it(pool: DbPool, watch: Watch, slow: &str) {
    let read = start(pool, &watch, slow, 120).await;
    read.abort();
    assert!(read.await.unwrap_err().is_cancelled());
    watch.assert_probe_stops("after the caller went away").await;
}

async fn pg() -> Option<(DbPool, Watch)> {
    let url = std::env::var("HUGINNDB_TEST_PG_URL").ok()?;
    let open = || async {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("HUGINNDB_TEST_PG_URL is set but the server is unreachable")
    };
    Some((
        DbPool::Postgres(open().await),
        Watch::Postgres(open().await),
    ))
}

async fn mysql() -> Option<(DbPool, Watch)> {
    let url = std::env::var("HUGINNDB_TEST_MYSQL_URL").ok()?;
    let open = || async {
        sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("HUGINNDB_TEST_MYSQL_URL is set but the server is unreachable")
    };
    Some((DbPool::Mysql(open().await), Watch::Mysql(open().await)))
}

async fn mssql_pool() -> Option<crate::db::mssql::MsSqlPool> {
    let host = std::env::var("HUGINNDB_TEST_MSSQL_HOST").ok()?;
    let (host, port) = match host.split_once(',') {
        Some((h, p)) => (h.to_string(), p.trim().parse().expect("a numeric port")),
        None => (host, 0),
    };
    let user = std::env::var("HUGINNDB_TEST_MSSQL_USER").ok();
    let profile: ConnectionProfile = serde_json::from_value(json!({
        "id": "live",
        "name": "live",
        "driver": serde_json::to_value(Driver::MsSql).unwrap(),
        "host": host,
        "port": port,
        "database": std::env::var("HUGINNDB_TEST_MSSQL_DB").unwrap_or_else(|_| "tempdb".into()),
        "username": user.clone().unwrap_or_default(),
        "mssql": {
            "trust_server_certificate": true,
            "auth": if user.is_some() { "sql" } else { "windows" },
        },
    }))
    .unwrap();
    let password = std::env::var("HUGINNDB_TEST_MSSQL_PASSWORD").unwrap_or_default();
    let (pool, _) = crate::db::mssql::open_pool(
        &profile,
        &password,
        crate::db::pool::TunnelRoute::Dial(None),
        Default::default(),
        crate::db::pool::PoolLimits::granted(2),
    )
    .await
    .expect("HUGINNDB_TEST_MSSQL_HOST is set but the server is unreachable");
    match pool {
        DbPool::MsSql(p) => Some(p),
        _ => unreachable!("open_pool opens a SQL Server pool"),
    }
}

async fn mssql() -> Option<(DbPool, Watch)> {
    Some((
        DbPool::MsSql(mssql_pool().await?),
        Watch::MsSql(mssql_pool().await?),
    ))
}

/// A statement that sends nothing until it ends: the case a closed socket
/// does not stop on PostgreSQL and MySQL.
fn pg_slow() -> String {
    format!("SELECT pg_sleep(60) AS {MARK}")
}

fn mysql_slow() -> String {
    format!("SELECT SLEEP(60) AS {MARK}")
}

/// No `WAITFOR` in a `SELECT`: a cross join big enough to run for minutes,
/// counted, so it too sends nothing until it ends — the DECOCER shape. The
/// filter is what makes it slow: a bare `COUNT_BIG(*)` of a cross join is
/// answered from the inputs' row counts without visiting a row.
fn mssql_slow() -> String {
    format!(
        "SELECT COUNT_BIG(*) AS {MARK} FROM sys.all_objects a \
         CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c \
         WHERE CHECKSUM(a.object_id, b.object_id, c.object_id) = 7"
    )
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn read_cancel_live_pg_deadline() {
    if let Some((pool, watch)) = pg().await {
        deadline_stops_it(pool, watch, &pg_slow()).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn read_cancel_live_pg_dropped() {
    if let Some((pool, watch)) = pg().await {
        drop_stops_it(pool, watch, &pg_slow()).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MYSQL_URL"]
async fn read_cancel_live_mysql_deadline() {
    if let Some((pool, watch)) = mysql().await {
        deadline_stops_it(pool, watch, &mysql_slow()).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MYSQL_URL"]
async fn read_cancel_live_mysql_dropped() {
    if let Some((pool, watch)) = mysql().await {
        drop_stops_it(pool, watch, &mysql_slow()).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn read_cancel_live_mssql_deadline() {
    if let Some((pool, watch)) = mssql().await {
        deadline_stops_it(pool, watch, &mssql_slow()).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn read_cancel_live_mssql_dropped() {
    if let Some((pool, watch)) = mssql().await {
        drop_stops_it(pool, watch, &mssql_slow()).await;
    }
}
