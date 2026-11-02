//! `run_script` against a real SQL Server.
//!
//! `#[ignore]`d because they need a server: point the variables below at a
//! throwaway database (every run drops and recreates its own table) and run
//!
//! ```text
//! cargo test --features mcp mssql_live -- --ignored --nocapture
//! ```
//!
//! * `HUGINNDB_TEST_MSSQL_HOST` — `host`, `host,port` or `HOST\INSTANCE`
//! * `HUGINNDB_TEST_MSSQL_DB` — the database (default `tempdb`)
//! * `HUGINNDB_TEST_MSSQL_USER` / `HUGINNDB_TEST_MSSQL_PASSWORD` — SQL login;
//!   leave the user unset for Windows authentication
//!
//! They exist because what the unit tests beside `run_script` cannot show is
//! the server's side of a `GO` batch: that a `DECLARE`d variable reaches the
//! next statement of its batch and not the next batch, and that a `THROW` in
//! the middle of one leaves nothing behind.

use serde_json::json;

use crate::commands::script::{execute_script_inner, ScriptResult};
use crate::log_bus::{LogEntry, LogSink};
use crate::state::{ActivePool, AppState, ConnectionProfile, DbPool, Driver};

const TABLE: &str = "huginndb_script_live";

struct Quiet;
impl LogSink for Quiet {
    fn log(&self, _: LogEntry) {}
}

async fn state() -> Option<AppState> {
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
    let state = AppState::new();
    state
        .connections
        .write()
        .insert("c".into(), ActivePool::bare(pool));
    let setup = format!(
        "DROP TABLE IF EXISTS dbo.{TABLE};\nCREATE TABLE dbo.{TABLE} (k INT PRIMARY KEY, v INT NOT NULL);"
    );
    run(&state, &setup, false).await.unwrap();
    Some(state)
}

async fn run(state: &AppState, sql: &str, transaction: bool) -> Result<ScriptResult, String> {
    run_within(
        state,
        sql,
        transaction,
        crate::state::DEFAULT_MCP_TIMEOUT_SECS,
    )
    .await
}

/// [`run`] with a timeout of `secs` that the call asked for and the
/// connection allows.
async fn run_within(
    state: &AppState,
    sql: &str,
    transaction: bool,
    secs: u32,
) -> Result<ScriptResult, String> {
    let timeout = crate::state::McpTimeout {
        secs,
        requested: Some(secs),
        cap: secs,
    };
    execute_script_inner(&Quiet, state, "c", sql, transaction, 100, timeout)
        .await
        .map_err(|e| e.to_string())
}

async fn rows(state: &AppState) -> Vec<(i32, i32)> {
    let Ok(DbPool::MsSql(p)) = state.pool_for("c") else {
        unreachable!()
    };
    p.query_all(&format!("SELECT k, v FROM dbo.{TABLE} ORDER BY k"), &[])
        .await
        .unwrap()
        .iter()
        .map(|r| {
            (
                r.get::<i32, _>(0).unwrap_or_default(),
                r.get::<i32, _>(1).unwrap_or_default(),
            )
        })
        .collect()
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn mssql_live_a_variable_lives_for_its_whole_batch() {
    let Some(state) = state().await else { return };
    let script = format!(
        "DECLARE @i INT = 0, @total INT = 0;
WHILE @i < 5
BEGIN
    SET @i = @i + 1;
    IF @i % 2 = 1
    BEGIN
        INSERT INTO dbo.{TABLE} (k, v) VALUES (@i, @i * 10);
        SET @total = @total + @i;
    END
END;
MERGE INTO dbo.{TABLE} AS t USING (SELECT 100 AS k, @total AS v) AS s ON t.k = s.k
WHEN NOT MATCHED THEN INSERT (k, v) VALUES (s.k, s.v);
SELECT @i AS i, @total AS total;"
    );
    let out = run(&state, &script, true).await.unwrap();
    assert_eq!(out.uncounted_batches, 1);
    assert_eq!(out.results.len(), 1, "{out:?}");
    assert_eq!(out.results[0].result.rows, vec![vec![json!(5), json!(9)]]);
    assert_eq!(
        rows(&state).await,
        vec![(1, 10), (3, 30), (5, 50), (100, 9)]
    );
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn mssql_live_a_variable_does_not_cross_a_go() {
    let Some(state) = state().await else { return };
    let script = format!(
        "DECLARE @k INT = 1;
INSERT INTO dbo.{TABLE} (k, v) VALUES (@k, 1);
GO
INSERT INTO dbo.{TABLE} (k, v) VALUES (@k, 2);"
    );
    let err = run(&state, &script, true).await.unwrap_err();
    assert!(err.contains("@k"), "{err}");
    // Line 4 of the file, where the second batch reads the variable.
    assert!(err.contains("line 4"), "{err}");
    assert!(err.contains("rolled back"), "{err}");
    assert!(rows(&state).await.is_empty());
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn mssql_live_an_error_mid_batch_takes_everything_back() {
    let Some(state) = state().await else { return };
    // A first batch that succeeds, then a THROW between two writes of the
    // second: nothing of either may stay.
    let throw = format!(
        "CREATE TABLE #seen (k INT);
INSERT INTO dbo.{TABLE} (k, v) VALUES (1, 1);
GO
INSERT INTO dbo.{TABLE} (k, v) VALUES (2, 2);
THROW 50000, 'stop here', 1;
INSERT INTO dbo.{TABLE} (k, v) VALUES (3, 3);"
    );
    let err = run(&state, &throw, true).await.unwrap_err();
    assert!(err.contains("stop here") && err.contains("line 5"), "{err}");
    assert!(err.contains("rolled back"), "{err}");
    assert!(rows(&state).await.is_empty());

    // A constraint error, which without XACT_ABORT would let the batch carry
    // on to the INSERT after it.
    let duplicate = format!(
        "INSERT INTO dbo.{TABLE} (k, v) VALUES (1, 1);
INSERT INTO dbo.{TABLE} (k, v) VALUES (1, 2);
INSERT INTO dbo.{TABLE} (k, v) VALUES (3, 3);"
    );
    let err = run(&state, &duplicate, true).await.unwrap_err();
    assert!(err.contains("rolled back"), "{err}");
    assert!(rows(&state).await.is_empty());

    // TRY/CATCH that re-throws: the same clean rollback.
    let caught = format!(
        "BEGIN TRY
    INSERT INTO dbo.{TABLE} (k, v) VALUES (1, 1);
    INSERT INTO dbo.{TABLE} (k, v) VALUES (1, 2);
END TRY
BEGIN CATCH
    THROW;
END CATCH;"
    );
    let err = run(&state, &caught, true).await.unwrap_err();
    assert!(err.contains("rolled back"), "{err}");
    assert!(rows(&state).await.is_empty());

    // The session was closed, never pooled: the next script starts clean.
    let out = run(
        &state,
        &format!("INSERT INTO dbo.{TABLE} (k, v) VALUES (7, 7);"),
        true,
    )
    .await
    .unwrap();
    assert_eq!(out.total_affected, 1);
    assert_eq!(rows(&state).await, vec![(7, 7)]);
}

/// A statement past its timeout is cancelled on the server, and what the
/// error says about the work is what the table shows afterwards (ADR #130).
///
/// Whether the server acknowledged the Attention or the session had to be
/// closed (tiberius 0.13 — gotcha #132), what counts is what is left, read
/// from another session: the read waits on the cancelled one's locks, so it
/// sees the final state. Its own table, so it cannot race the tests above
/// over theirs.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_MSSQL_HOST"]
async fn mssql_live_a_statement_past_its_timeout_is_cancelled_on_the_server() {
    use std::time::{Duration, Instant};
    let Some(state) = state().await else { return };
    let Ok(DbPool::MsSql(raw)) = state.pool_for("c") else {
        unreachable!()
    };
    raw.execute_simple(
        "DROP TABLE IF EXISTS dbo.hdb_timeout_probe; CREATE TABLE dbo.hdb_timeout_probe (k int)",
    )
    .await
    .unwrap();
    let count = || async {
        raw.scalar("SELECT COUNT(*) FROM dbo.hdb_timeout_probe", &[])
            .await
            .unwrap()
            .unwrap()
    };
    let cut = |sql: &'static str, transaction: bool| {
        let state = &state;
        async move {
            let started = Instant::now();
            let err = run_within(state, sql, transaction, 2).await.unwrap_err();
            assert!(
                started.elapsed() < Duration::from_secs(9),
                "the statement was waited out instead of cancelled: {err}"
            );
            assert!(err.contains("ran out of time after 2 s"), "{err}");
            eprintln!("{err}");
            err
        }
    };

    // In run_script's own transaction: everything goes.
    let err = cut(
        "INSERT INTO dbo.hdb_timeout_probe VALUES (1);\nWAITFOR DELAY '00:00:10';",
        true,
    )
    .await;
    assert!(err.contains("nothing was committed"), "{err}");
    assert_eq!(count().await, 0);

    // As written: the statement before stays, the WAITFOR is stopped.
    let err = cut(
        "INSERT INTO dbo.hdb_timeout_probe VALUES (2);\nWAITFOR DELAY '00:00:10';",
        false,
    )
    .await;
    assert!(err.contains("undone"), "{err}");
    assert!(err.contains("before it changed stays"), "{err}");
    assert_eq!(count().await, 1);

    // As written, inside the script's own transaction, which neither an
    // Attention nor the cancel ends by itself.
    let err = cut(
        "BEGIN TRANSACTION;\nINSERT INTO dbo.hdb_timeout_probe VALUES (3);\n\
         WAITFOR DELAY '00:00:10';",
        false,
    )
    .await;
    assert!(err.contains("transaction the script had opened"), "{err}");
    assert_eq!(count().await, 1);

    // The case the verdict has to be right about: one long INSERT … SELECT
    // with no transaction around it, cut off while it is still writing. A
    // server that went on and finished it would commit ten million rows; one
    // that aborts on the cancel leaves none of them.
    cut(
        "INSERT INTO dbo.hdb_timeout_probe SELECT TOP (10000000) 4 \
         FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c;",
        false,
    )
    .await;
    assert_eq!(
        count().await,
        1,
        "the cut-off INSERT … SELECT must not stay"
    );

    raw.execute_simple("DROP TABLE dbo.hdb_timeout_probe")
        .await
        .unwrap();
}
