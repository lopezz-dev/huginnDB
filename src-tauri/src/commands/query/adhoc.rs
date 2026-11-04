//! Statements the user types: one ([`execute_with_state`]) or a whole batch
//! ([`execute_batch_inner`]), shared by the GUI commands, the MCP connector and
//! the AI panel's bridge. Holds the ad-hoc row caps (ADR #127) and the
//! read-only barrier a read runs behind.

use crate::db::session::{failure_text, fetch_capped, Session};
use crate::db::sql::is_read_only;
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink, SqlLog};
use crate::state::{AppState, DbPool};
// Brought into scope for `<&Pool>::execute(&str)` / `<&mut Conn>::execute(&str)`
// in the ad-hoc DML paths. Passing a `&str` (no bound arguments) runs through
// sqlx's text/simple-query protocol — the unprepared path — whereas
// `sqlx::query(sql)` always prepares. Inherent `Query::execute` calls elsewhere
// are unaffected (inherent methods win over the trait).
use super::types::{column_meta, stmt_preview, with_meta, BatchResult, QueryResult, StmtOutcome};
use sqlx::Executor as _;
use std::time::Instant;

/// Shared implementation used by [`execute_query`] and the headless MCP
/// `run_query` tool. Takes a borrowed [`AppState`] and a [`LogSink`] so it
/// can run without a Tauri `State` guard or `AppHandle` — the GUI passes a
/// `TauriSink`, the MCP binary a `NoopSink`.
///
/// Emits a SQL [`LogEntry`] after every execution path (write, read, and
/// error) so the Console panel sees the same statement the engine ran.
pub(crate) async fn execute_with_state(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    execute_adhoc(sink, state, connection_id, sql, false).await
}

/// [`execute_with_state`] for a statement that has been classified as a read,
/// run so that **the database** refuses it if the classification was wrong.
///
/// The tier a statement needs is decided from its text (`db::classify`), and
/// text can hide a write: a CTE carrying a `DELETE`, an `EXPLAIN ANALYZE`, a
/// function with side effects called from a `SELECT`. Every one of those was
/// classified as a read at some point, and a read-only MCP connection or the AI
/// panel then ran it. This is the second barrier, for the callers that act for
/// an AI (`bridge::exec`): the read runs inside a read-only transaction on
/// PostgreSQL and MySQL and with `PRAGMA query_only` on SQLite, so a
/// misclassified write fails on the server instead of executing.
///
/// What it does not cover, said plainly: SQL Server has no read-only
/// transaction, and runs as before; MongoDB has no such mode either, and relies
/// on its classifier alone. On MySQL a DDL statement commits the transaction
/// implicitly before running, so there the barrier stops DML but not DDL — which
/// the classifier's DDL-first check has to catch.
///
/// Refuses outright a statement that is not even shaped like a read.
pub(crate) async fn execute_read_with_state(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    execute_adhoc(sink, state, connection_id, sql, true).await
}

pub(super) async fn execute_adhoc(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
    read_only: bool,
) -> AppResult<QueryResult> {
    let pool = state.pool_for(connection_id)?;
    let driver = pool.driver_name();
    let start = Instant::now();

    // MongoDB: parse + run the mongosh-style statement in the mongo module,
    // which classifies read vs write itself and shapes the result.
    if let DbPool::Mongo(conn) = &pool {
        let result = crate::db::mongo::query::execute(conn, sql).await;
        return SqlLog::new(sink, connection_id, driver)
            .outcome(sql, start, result, |r| r.rows_affected);
    }

    if !is_read_only(sql) {
        if read_only {
            return Err(AppError::InvalidInput(
                "this statement is not a read, and was sent to be run as one".into(),
            ));
        }
        // Ad-hoc, hand-typed DML/DDL runs through the **unprepared** simple-query
        // protocol (`raw_sql`), not the prepared/binary protocol that
        // `sqlx::query(...)` uses. The editor never binds parameters, so there's
        // nothing to prepare — and MySQL's prepared protocol rejects or
        // mishandles a whole family of statements a CLI client runs without
        // complaint (the recurring BIT / integer-literal and "command not
        // supported in the prepared statement protocol" errors). The simple
        // protocol parses the statement exactly like the server's CLI would, so
        // what the user types is what executes. We only need `rows_affected`
        // here, so there's no result-set decoding to worry about. SELECTs keep
        // the prepared path below (their typed decoding is unaffected).
        //
        // Passing the bare `&str` to `Executor::execute` is what selects the
        // unprepared protocol: a `&str` carries no bound arguments, and sqlx
        // sends argument-less queries via the simple-query (text) protocol.
        let rows_affected = try_sql_sink!(
            sink,
            connection_id,
            driver,
            sql,
            start,
            match &pool {
                DbPool::Postgres(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                DbPool::Mysql(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                DbPool::Sqlite(p) => p
                    .execute(sql)
                    .await
                    .map(|r| r.rows_affected())
                    .map_err(AppError::from),
                // `tiberius` has only the unprepared path for parameterless
                // SQL, which is exactly what the editor needs here.
                DbPool::MsSql(p) => p.execute_simple(sql).await,
                DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
            }
        );
        log_sql_sink(
            sink,
            connection_id,
            driver,
            sql,
            start,
            Some(rows_affected),
            None,
        );
        return Ok(QueryResult::affected(
            rows_affected,
            start.elapsed().as_millis() as u64,
        ));
    }

    let ((columns, data), truncated) = match pool {
        DbPool::Postgres(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                fetch_capped_alone(&p, read_only.then_some("BEGIN READ ONLY"), sql).await
            );
            (with_meta(crate::db::values::pg_result(&rows)), truncated)
        }
        DbPool::Mysql(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                fetch_capped_alone(&p, read_only.then_some("START TRANSACTION READ ONLY"), sql)
                    .await
            );
            (with_meta(crate::db::values::mysql_result(&rows)), truncated)
        }
        DbPool::Sqlite(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                if read_only {
                    fetch_sqlite_query_only(&p, sql).await
                } else {
                    fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
                }
            );
            (
                with_meta(crate::db::values::sqlite_result(&rows)),
                truncated,
            )
        }
        DbPool::MsSql(p) => {
            // A T-SQL batch can return several result sets; the grid shows one,
            // so take the first non-empty one (a `SELECT` preceded by e.g. a
            // `SET NOCOUNT ON` would otherwise look empty).
            let (sets, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                p.query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS).await
            );
            let rows = sets.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
            (
                with_meta(crate::db::mssql::schema::decode_rows(&rows)),
                truncated,
            )
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    let result = QueryResult::rows(columns, data, start.elapsed().as_millis() as u64)
        .with_truncated(truncated);
    log_sql_sink(
        sink,
        connection_id,
        driver,
        sql,
        start,
        Some(result.rows_affected),
        None,
    );
    Ok(result)
}

/// Tauri-independent core of [`execute_batch`], shared with the headless MCP
/// write path. Takes a borrowed [`AppState`] and a [`LogSink`] instead of a
/// Tauri `State`/`AppHandle`.
pub(crate) async fn execute_batch_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    statements: Vec<String>,
) -> AppResult<BatchResult> {
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::query::execute_batch(conn, &statements, sink, &connection_id)
            .await;
    }

    let mut outcomes: Vec<StmtOutcome> = Vec::with_capacity(statements.len());
    let mut total_affected: u64 = 0;
    // Rows already retained across the whole batch — see
    // `MAX_BATCH_RESULT_ROWS` for why the budget is shared rather than
    // per statement.
    let mut rows_kept: usize = 0;

    // One session for the whole batch: the user's own `BEGIN`/`COMMIT`, a
    // MySQL `USE`, temp tables and `SET`s carry from one statement to the
    // next. Returned to the pool afterwards, like any other borrow — unless the
    // user left a transaction open, which `Session` cannot see (it only tracks
    // the ones it opened) and which is the user's to close, as in a CLI.
    let acquire_start = Instant::now();
    let mut session = try_sql_sink!(
        sink,
        &connection_id,
        driver,
        "(batch)",
        acquire_start,
        Session::acquire(&pool).await
    );

    let log = SqlLog::new(sink, &connection_id, driver);
    for (index, raw) in statements.iter().enumerate() {
        let sql = raw.trim();
        if sql.is_empty() {
            continue;
        }
        let is_select = is_read_only(sql);
        let start = Instant::now();
        let outcome: AppResult<(u64, Vec<QueryResult>)> = if is_select {
            session.fetch(sql, MAX_ADHOC_QUERY_ROWS).await.map(|sets| {
                // Every set the statement returned, not just the first: one
                // T-SQL statement can return several, and keeping one of them
                // was a silent discard back when there was only ever one grid
                // to put it in.
                let mut results = Vec::with_capacity(sets.len());
                let mut ra = 0u64;
                for set in sets {
                    let mut rows = set.rows;
                    // `rows_affected` counts what the statement produced,
                    // before the batch budget sheds any of it — the summary
                    // would otherwise report a SELECT that returned nothing.
                    ra += rows.len() as u64;
                    let over_budget = shed_to_batch_budget(&mut rows, &mut rows_kept);
                    // No `row_types`: SQL, so the catalog column type is the
                    // hint the editor needs, and per-cell BSON type trees are
                    // MongoDB's alone (ADR #29).
                    results.push(
                        QueryResult::rows(
                            column_meta(set.columns),
                            rows,
                            start.elapsed().as_millis() as u64,
                        )
                        .with_truncated(set.truncated || over_budget),
                    );
                }
                (ra, results)
            })
        } else {
            // Through the unprepared protocol — see `Session::exec`.
            session.exec(sql).await.map(|ra| (ra, Vec::new()))
        };
        match outcome {
            Ok((ra, results)) => {
                total_affected += ra;
                log.ok(sql, start, ra);
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(sql),
                    rows_affected: ra,
                    is_select,
                    error: None,
                    results,
                });
            }
            Err(e) => {
                let msg = failure_text(&e);
                log.err(sql, start, &msg);
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(sql),
                    rows_affected: 0,
                    is_select,
                    error: Some(msg),
                    results: Vec::new(),
                });
                break;
            }
        }
    }

    Ok(BatchResult {
        statements: outcomes,
        total_affected,
    })
}

/// Upper bound on how many rows an ad-hoc query (the editor's `execute_query`/
/// `execute_batch`, and MongoDB's `find`/`aggregate` shell statements) keeps
/// from a SELECT/find result.
///
/// Unlike [`fetch_table_data`], which always appends its own `LIMIT`/`OFFSET`,
/// text the user typed carries no such bound — a `SELECT * FROM big_table
/// WHERE rarely_true` returns however many rows the table has. Every SQL
/// driver here used to hand that straight to `fetch_all`/`tiberius::
/// into_results`, which buffer the *entire* result set in memory before
/// returning, and `DataGrid` then rendered every one of those rows into the
/// DOM — a non-selective query over a large table reliably took down the
/// whole app with an out-of-memory crash (no timeout ever ran, because the
/// "Run" button's clock is cosmetic and never cancels the driver call). Rows
/// past the cap are never kept, so backend memory stays bounded regardless of
/// how many rows the query matches — and since ADR #127 they are not read
/// either when nothing else needs the connection: a lone ad-hoc read closes
/// its connection (SQL Server: its session) at the first row past the cap
/// instead of draining the rest, and a Mongo cursor is simply dropped early,
/// which is a supported operation. A batch or script, whose session carries
/// state into its next statement, still has the rest drained so the session
/// survives.
pub const MAX_ADHOC_QUERY_ROWS: usize = 50_000;

/// Upper bound on how many rows **one batch run** keeps in total, across every
/// statement in it.
///
/// [`MAX_ADHOC_QUERY_ROWS`] bounds a single statement, and that was the whole
/// story while a batch returned one result set: the last SELECT's, and nothing
/// else. Now that every statement carries its own, the per-statement cap alone
/// would mean a ten-SELECT script is ten times the ceiling — 500 000 rows over
/// IPC, held in the frontend, with the same out-of-memory ending the
/// per-statement cap exists to prevent.
///
/// So the budget is shared rather than multiplied: a batch keeps the same
/// 50 000 rows one statement may, handed out in statement order. A statement
/// that runs into the remaining budget keeps the rows that fit and is marked
/// [`QueryResult::truncated`], exactly as it would be for overrunning the
/// per-statement cap — the flag means "rows past what you see were discarded"
/// either way, and the UI already says so. What it does *not* touch is
/// [`StmtOutcome::rows_affected`], which keeps counting what the statement
/// actually produced: shedding rows from the grid must not make the summary
/// report a SELECT that returned nothing.
pub const MAX_BATCH_RESULT_ROWS: usize = MAX_ADHOC_QUERY_ROWS;

/// The invariant the shared budget exists to hold, checked when the crate is
/// compiled rather than when its tests are run: if these ever diverge upward,
/// N statements are N times the ceiling the per-statement cap is there to
/// enforce, which is the bug the shared budget was introduced to prevent. A
/// `const` assertion is the right severity for a bound the whole
/// out-of-memory argument above rests on — it fails the build, not a test.
const _: () = assert!(MAX_BATCH_RESULT_ROWS <= MAX_ADHOC_QUERY_ROWS);

/// Trim `rows` to whatever of a batch's [`MAX_BATCH_RESULT_ROWS`] budget is
/// left, advancing `kept` by what survived. Returns `true` when rows were
/// shed, which every caller folds into [`QueryResult::truncated`].
///
/// Three drivers do this and all three must agree, which is the whole reason
/// it is a function: the budget is only a bound if nobody forgets to charge
/// their rows against it.
pub(crate) fn shed_to_batch_budget<T>(rows: &mut Vec<T>, kept: &mut usize) -> bool {
    let keep = MAX_BATCH_RESULT_ROWS.saturating_sub(*kept);
    let over = rows.len() > keep;
    if over {
        rows.truncate(keep);
    }
    *kept += rows.len();
    over
}

/// [`fetch_capped`] for one ad-hoc read, on a connection of its own that is
/// **closed** rather than drained when the result overflows the cap.
///
/// Closing is what makes stopping early worth anything over the network
/// drivers: handed back to the pool, the connection would read every row past
/// the cap before its next use anyway. Dropping the socket stops the server
/// sending them instead. Nothing is lost by it — the read was this
/// connection's only job, and it is detached from the pool so the pool's size
/// stays honest.
///
/// With `begin` (`BEGIN READ ONLY` / `START TRANSACTION READ ONLY` — see
/// [`execute_read_with_state`]) the read runs inside a transaction that is
/// always rolled back: explicitly when the connection is kept, by the server
/// when it is closed. A failed rollback closes the connection too, so it never
/// goes back to the pool inside a transaction; the read's own outcome is what
/// is returned either way, being the one that says what happened.
pub(super) async fn fetch_capped_alone<DB>(
    pool: &sqlx::Pool<DB>,
    begin: Option<&'static str>,
    sql: &str,
) -> Result<(Vec<DB::Row>, bool), sqlx::Error>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    use sqlx::Executor;
    let mut conn = pool.acquire().await?;
    if let Some(begin) = begin {
        // A bare `&str` goes through the unprepared protocol, which MySQL
        // needs for transaction control — see `execute_adhoc`'s write path.
        conn.execute(begin).await?;
    }
    let fetched = fetch_capped(&mut *conn, sql, MAX_ADHOC_QUERY_ROWS).await;
    if matches!(fetched, Ok((_, true))) {
        drop(conn.detach());
        return fetched;
    }
    if begin.is_some() && conn.execute("ROLLBACK").await.is_err() {
        conn.close_on_drop();
    }
    fetched
}

/// SQLite's counterpart of [`fetch_capped_alone`]'s read-only transaction:
/// `PRAGMA query_only`
/// refuses every write, DDL included, on the connection it is set on.
///
/// It is a per-connection setting, so the one thing that must not happen is
/// handing the connection back to the pool still in that mode — the user's own
/// next write from the editor would fail for no visible reason. If switching it
/// off fails, the connection is closed instead of being returned.
pub(super) async fn fetch_sqlite_query_only(
    pool: &sqlx::SqlitePool,
    sql: &str,
) -> Result<(Vec<sqlx::sqlite::SqliteRow>, bool), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut *conn)
        .await?;
    let fetched = fetch_capped(&mut *conn, sql, MAX_ADHOC_QUERY_ROWS).await;
    if sqlx::query("PRAGMA query_only = OFF")
        .execute(&mut *conn)
        .await
        .is_err()
    {
        conn.close_on_drop();
    }
    fetched
}

/// The batch runner's shape: the row budget every driver charges against, and
/// the DTO the frontend builds its result panels from.
///
/// `execute_batch_inner` itself needs a live pool, so what is testable without
/// one is exactly what these cover — which is also where the interesting bugs
/// are: a budget one driver forgets to charge, and a field serde drops at the
/// IPC boundary (gotcha #14) because nobody declared it on both sides.
#[cfg(test)]
mod read_barrier_tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// One connection, so the test sees the very connection the barrier used
    /// when it checks that `query_only` was switched back off.
    async fn sqlite_pool(name: &str) -> sqlx::SqlitePool {
        let path = std::env::temp_dir().join(format!("huginndb_read_barrier_{name}.db"));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn a_write_that_reaches_the_barrier_is_refused_by_sqlite() {
        let pool = sqlite_pool("refused").await;
        // As if the classifier had let it through as a read.
        let err = fetch_sqlite_query_only(&pool, "DELETE FROM t RETURNING id").await;
        assert!(err.is_err(), "query_only must refuse the delete");
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "the row must still be there");
    }

    #[tokio::test]
    async fn the_connection_goes_back_to_the_pool_writable() {
        let pool = sqlite_pool("restored").await;
        let (rows, _) = fetch_sqlite_query_only(&pool, "SELECT id FROM t")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        // The pool's only connection is the one the read used.
        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(&pool)
            .await
            .expect("the user's own write must not inherit query_only");
    }

    /// `n` rows, without a table.
    fn series(n: usize) -> String {
        format!(
            "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < {n}) \
             SELECT i FROM s"
        )
    }

    /// ADR #127: the read stops at the first row past the cap, and the
    /// connection it stopped on still serves the next statement — the batch
    /// and script runners keep using it.
    #[tokio::test]
    async fn fetch_capped_stops_at_the_cap_and_leaves_the_connection_usable() {
        let pool = sqlite_pool("capped").await;
        let mut conn = pool.acquire().await.unwrap();

        let (rows, truncated) = fetch_capped(&mut *conn, &series(10), 3).await.unwrap();
        assert_eq!((rows.len(), truncated), (3, true));

        let (rows, truncated) = fetch_capped(&mut *conn, &series(3), 3).await.unwrap();
        assert_eq!(
            (rows.len(), truncated),
            (3, false),
            "exactly the cap is whole"
        );

        // A spent batch budget: nothing kept, and the flag still tells.
        let (rows, truncated) = fetch_capped(&mut *conn, &series(2), 0).await.unwrap();
        assert_eq!((rows.len(), truncated), (0, true));

        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(&mut *conn)
            .await
            .expect("a write after an early stop must not find the read still open");
    }

    /// An overflowing lone read closes its connection instead of returning
    /// it: on a one-connection pool, the next acquire must still succeed,
    /// which it only does if the connection was detached rather than leaked.
    #[tokio::test]
    async fn an_overflowing_lone_read_gives_its_slot_back() {
        let pool = sqlite_pool("alone").await;
        let (rows, truncated) = fetch_capped_alone(&pool, None, &series(MAX_ADHOC_QUERY_ROWS + 1))
            .await
            .unwrap();
        assert_eq!((rows.len(), truncated), (MAX_ADHOC_QUERY_ROWS, true));
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t")
            .fetch_one(&pool)
            .await
            .expect("the pool must open a new connection in the closed one's place");
        assert_eq!(n, 1);

        let (rows, truncated) = fetch_capped_alone(&pool, None, &series(5)).await.unwrap();
        assert_eq!((rows.len(), truncated), (5, false));
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use crate::commands::query::ColumnMeta;
    use serde_json::Value;

    fn rows(n: usize) -> Vec<u8> {
        vec![0u8; n]
    }

    #[test]
    fn a_batch_within_budget_keeps_every_row() {
        let mut kept = 0usize;
        let mut first = rows(10);
        let mut second = rows(20);
        assert!(!shed_to_batch_budget(&mut first, &mut kept));
        assert!(!shed_to_batch_budget(&mut second, &mut kept));
        assert_eq!((first.len(), second.len(), kept), (10, 20, 30));
    }

    #[test]
    fn the_statement_that_crosses_the_budget_keeps_what_fits() {
        // The point of a *shared* budget: the second statement is not refused,
        // it is served with what is left. Its own cap is untouched.
        let mut kept = MAX_BATCH_RESULT_ROWS - 5;
        let mut data = rows(20);
        assert!(shed_to_batch_budget(&mut data, &mut kept));
        assert_eq!(data.len(), 5);
        assert_eq!(kept, MAX_BATCH_RESULT_ROWS);
    }

    #[test]
    fn a_statement_after_the_budget_is_spent_keeps_nothing_and_says_so() {
        let mut kept = MAX_BATCH_RESULT_ROWS;
        let mut data = rows(20);
        assert!(shed_to_batch_budget(&mut data, &mut kept));
        assert!(data.is_empty());
        // `saturating_sub`, not a subtraction: overshooting the budget must not
        // panic in release *or* wrap into an enormous allowance in debug.
        assert_eq!(kept, MAX_BATCH_RESULT_ROWS);
    }

    #[test]
    fn an_exactly_full_statement_is_not_marked_truncated() {
        let mut kept = 0usize;
        let mut data = rows(MAX_BATCH_RESULT_ROWS);
        assert!(!shed_to_batch_budget(&mut data, &mut kept));
        assert_eq!(data.len(), MAX_BATCH_RESULT_ROWS);
    }

    #[test]
    fn a_statement_outcome_serialises_its_result_sets() {
        let outcome = StmtOutcome {
            index: 0,
            preview: "SELECT 1".into(),
            rows_affected: 1,
            is_select: true,
            error: None,
            results: vec![QueryResult::rows(
                vec![ColumnMeta {
                    name: "n".into(),
                    data_type: "int".into(),
                }],
                vec![vec![Value::from(1)]],
                3,
            )],
        };
        let json = serde_json::to_value(&outcome).unwrap();
        // `results`, not `result`: the field the frontend destructures, and
        // the reason it is a list is SQL Server, whose one statement can
        // return several sets.
        assert_eq!(json["results"].as_array().unwrap().len(), 1);
        assert_eq!(json["results"][0]["rows"][0][0], 1);
        assert_eq!(json["rows_affected"], 1);
    }

    #[test]
    fn a_write_and_a_failure_both_serialise_an_empty_result_list() {
        for outcome in [
            StmtOutcome {
                index: 1,
                preview: "UPDATE t SET a = 1".into(),
                rows_affected: 7,
                is_select: false,
                error: None,
                results: Vec::new(),
            },
            StmtOutcome {
                index: 2,
                preview: "SELECT boom".into(),
                rows_affected: 0,
                is_select: true,
                error: Some("no such column: boom".into()),
                results: Vec::new(),
            },
        ] {
            let json = serde_json::to_value(&outcome).unwrap();
            // An empty array rather than a missing key: the UI decides "does
            // this statement get a panel?" by asking the list its length.
            assert_eq!(json["results"].as_array().unwrap().len(), 0);
        }
    }

    #[test]
    fn a_batch_result_carries_only_the_statements_and_the_tally() {
        let batch = BatchResult {
            statements: Vec::new(),
            total_affected: 0,
        };
        let json = serde_json::to_value(&batch).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        // `last_result` is gone on purpose: with a result set on every
        // statement it was a second full copy of the largest payload in the
        // batch, crossing IPC for a consumer that no longer exists.
        assert_eq!(keys, vec!["statements", "total_affected"]);
    }
}
