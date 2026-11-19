//! An AI's read, and a person's run, stopped on a real server (ADRs #134,
//! #137).
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
        let gate = state.read_gates.gate("c", 1);
        execute_read_bounded(&Quiet, &state, "c", &slow, seconds(secs), "q-live", &gate)
            .await
            .map(|read| read.result)
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
    // What the model is told must match what the server then shows: a read
    // reported `cancelled` that is still in the activity view would send it
    // to run the next heavy read on top of this one (ADR #140).
    let detail = err.detail().expect("a read's timeout carries its detail");
    assert_eq!(detail["state"], "cancelled", "{detail}");
    assert_eq!(detail["query_id"], "q-live");
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

// ---------------------------------------------------------------------------
// A person's Stop (ADR #137): `cancel_query` on a run `execute_query` /
// `execute_batch` started with a `run_id`. Same probes, same activity views;
// what changes is who stops it (the registry, not a deadline) and that writes
// are stopped too, with an outcome that says whether they applied.
//
//   cargo test --features mcp stop_live -- --ignored --nocapture
// ---------------------------------------------------------------------------

use crate::commands::query::{execute_batch_stoppable, execute_stoppable};
use crate::error::{AppError, StopOutcome};

/// A table of the test's own for the write probes, emptied first.
const PROBE_TABLE: &str = "huginndb_stop_probe";

/// Start `sql` as a person's run `id` in a task, and wait until the server
/// shows the probe running.
async fn start_run(
    state: std::sync::Arc<AppState>,
    watch: &Watch,
    sql: String,
) -> tokio::task::JoinHandle<crate::error::AppResult<crate::commands::query::QueryResult>> {
    let run = state.runs.start("live".into()).unwrap();
    let task = tokio::spawn(async move {
        let signal = run.signal();
        let result = execute_stoppable(&Quiet, &state, "c", &sql, &signal).await;
        drop(run);
        result
    });
    for _ in 0..20 {
        if watch.probe_is_running().await {
            return task;
        }
        assert!(!task.is_finished(), "the probe ended before it was seen");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the probe never showed up in the server's activity view");
}

fn outcome_of(e: &AppError) -> StopOutcome {
    match e {
        AppError::Stopped { outcome, .. } => *outcome,
        other => panic!("expected a stop, got {other}"),
    }
}

/// Stop a running read: the error is a stop that applied nothing, the
/// registry forgets the run, and the server agrees it is gone.
async fn stop_stops_a_read(pool: DbPool, watch: Watch, slow: &str) {
    let state = std::sync::Arc::new(state_with(pool));
    let runs = state.runs.clone();
    let task = start_run(state.clone(), &watch, slow.to_string()).await;
    assert!(runs.stop("live"));
    let err = task.await.unwrap().expect_err("the probe was stopped");
    eprintln!("stop (read): {err}");
    assert_eq!(outcome_of(&err), StopOutcome::NotApplied);
    watch.assert_probe_stops("after Stop").await;
    assert_eq!(runs.len(), 0);
    assert!(!runs.stop("live"), "a stopped run is not found again");
}

/// Stop a running write, and check what the outcome claims against the table.
async fn stop_stops_a_write(pool: DbPool, watch: Watch, write: &str, expected: StopOutcome) {
    crate::db::exec::execute(&pool, &format!("DELETE FROM {PROBE_TABLE}"))
        .await
        .unwrap();
    let state = std::sync::Arc::new(state_with(pool.clone()));
    let runs = state.runs.clone();
    let task = start_run(state.clone(), &watch, write.to_string()).await;
    assert!(runs.stop("live"));
    let err = task.await.unwrap().expect_err("the probe was stopped");
    eprintln!("stop (write): {err}");
    assert_eq!(outcome_of(&err), expected);
    watch.assert_probe_stops("after Stop").await;
    let (_, rows) =
        crate::db::exec::query_rows(&pool, &format!("SELECT COUNT(*) FROM {PROBE_TABLE}"), &[])
            .await
            .unwrap();
    assert_eq!(
        rows[0][0].as_i64(),
        Some(0),
        "the stopped insert left nothing behind"
    );
}

async fn probe_table(pool: &DbPool) {
    crate::db::exec::execute(
        pool,
        &format!("CREATE TABLE IF NOT EXISTS {PROBE_TABLE} (x INT)"),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn stop_live_pg_read() {
    if let Some((pool, watch)) = pg().await {
        stop_stops_a_read(pool, watch, &pg_slow()).await;
    }
}

/// PostgreSQL answers the cancel with the statement's failure, and a
/// statement in autocommit is atomic: certainly not applied.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn stop_live_pg_write() {
    if let Some((pool, watch)) = pg().await {
        probe_table(&pool).await;
        let write = format!("INSERT INTO {PROBE_TABLE} SELECT 1 FROM pg_sleep(60) /* {MARK} */");
        stop_stops_a_write(pool, watch, &write, StopOutcome::NotApplied).await;
    }
}

/// A batch inside its own transaction, stopped at its third statement: the
/// session is closed, so the server rolls the insert before it back.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn stop_live_pg_batch_rolls_its_transaction_back() {
    if let Some((pool, watch)) = pg().await {
        probe_table(&pool).await;
        crate::db::exec::execute(&pool, &format!("DELETE FROM {PROBE_TABLE}"))
            .await
            .unwrap();
        let state = std::sync::Arc::new(state_with(pool.clone()));
        let runs = state.runs.clone();
        let run = runs.start("batch".into()).unwrap();
        let statements = vec![
            "BEGIN".to_string(),
            format!("INSERT INTO {PROBE_TABLE} VALUES (1)"),
            pg_slow(),
        ];
        let task = tokio::spawn({
            let state = state.clone();
            async move {
                let signal = run.signal();
                execute_batch_stoppable(&Quiet, &state, "c".into(), statements, Some(&signal)).await
            }
        });
        for _ in 0..20 {
            if watch.probe_is_running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(runs.stop("batch"));
        let batch = task.await.unwrap().unwrap();
        let stop = batch.stopped.expect("the batch says it was stopped");
        eprintln!("stop (batch): {:?}", batch.statements.last().unwrap().error);
        assert_eq!(stop.index, 2);
        watch.assert_probe_stops("after Stop").await;
        for _ in 0..50 {
            let (_, rows) = crate::db::exec::query_rows(
                &pool,
                &format!("SELECT COUNT(*) FROM {PROBE_TABLE}"),
                &[],
            )
            .await
            .unwrap();
            if rows[0][0].as_i64() == Some(0) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("the batch's transaction was not rolled back");
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MYSQL_URL"]
async fn stop_live_mysql_read() {
    if let Some((pool, watch)) = mysql().await {
        stop_stops_a_read(pool, watch, &mysql_slow()).await;
    }
}

/// MySQL answers `KILL QUERY` with the statement's failure too, but the app
/// cannot know the table's engine, so the outcome stays "may have applied";
/// on InnoDB the table must still be empty.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MYSQL_URL"]
async fn stop_live_mysql_write() {
    if let Some((pool, watch)) = mysql().await {
        probe_table(&pool).await;
        let write = format!("INSERT INTO {PROBE_TABLE} SELECT SLEEP(60) /* {MARK} */");
        stop_stops_a_write(pool, watch, &write, StopOutcome::MayHaveApplied).await;
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn stop_live_mssql_read() {
    if let Some((pool, watch)) = mssql().await {
        stop_stops_a_read(pool, watch, &mssql_slow()).await;
    }
}
