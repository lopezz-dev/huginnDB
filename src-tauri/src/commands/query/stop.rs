//! A person's run, stopped **on the server** when they press Stop (ADR #137).
//!
//! The query tab names a run (`run_id`) and `cancel_query` fires its
//! [`StopSignal`] (`crate::runs`). This module is what makes that stop real
//! rather than cosmetic: each statement of the run is raced against the
//! signal, and when it fires the statement is stopped where it runs, with the
//! per-driver stop the AI's reads already use (`super::bounded`, ADR #134):
//!
//! - **PostgreSQL / MySQL:** the session's id is learnt before the statement
//!   runs, and on Stop a second connection sends `pg_cancel_backend` /
//!   `KILL QUERY`. The statement is then given [`STOP_GRACE`] to come back
//!   with the server's answer, which is what lets a stopped write say whether
//!   it applied.
//! - **SQL Server:** the session is closed, after an Attention that tiberius
//!   0.13 cannot see acknowledged (gotcha #132). SQL Server aborts the request
//!   of a client that disconnects.
//! - **SQLite:** nothing can interrupt a statement. The connection is detached
//!   from the pool and the statement finishes on it by itself.
//! - **MongoDB:** the operation and its cursor are dropped. Its server-side
//!   stop (`killOp`) is left for the MongoDB card.
//!
//! Whatever happened, the session **never goes back to the pool** after a
//! stop. So a batch's open transaction is rolled back by the server.
//!
//! The answer is an [`AppError::Stopped`], not a failure: its
//! [`StopOutcome`] says whether the statement certainly did not apply, or may
//! have — a cancel that raced the commit, SQLite, a write SQL Server or
//! MongoDB was not able to confirm. Its text says what happened in words.
//!
//! A run without an id takes the unstoppable paths unchanged
//! (`super::execute_with_state`, `super::execute_batch_inner`), which is also
//! what the MCP connector and the AI panel use: their reads have their own
//! deadline (ADR #134) and their writes must finish and be answered (ADR #130).

use std::future::Future;
use std::time::{Duration, Instant};

use sqlx::pool::PoolConnection;
use sqlx::{Executor as _, Row as _};

use super::bounded::{InFlight, Kill, MSSQL_CANCEL_WAIT};
use super::types::{with_meta, QueryResult};
use super::MAX_ADHOC_QUERY_ROWS;
use crate::db::session::{fetch_capped, Cancelled, MYSQL_SESSION_ID, POSTGRES_SESSION_ID};
use crate::db::sql::{is_read_only, StmtClass};
use crate::error::{AppError, AppResult, StopOutcome};
use crate::log_bus::{LogSink, SqlLog};
use crate::runs::StopSignal;
use crate::state::{AppState, DbPool};

/// How long a statement the server was told to stop is given to come back
/// with the server's answer. Past it the session is closed regardless, and a
/// write says it may have applied: without the answer the app cannot know.
const STOP_GRACE: Duration = Duration::from_secs(10);

/// What a statement raced against a person's Stop came to.
pub(crate) enum Raced<T> {
    /// It ended before a stop was asked for.
    Ended(AppResult<T>),
    /// A stop was asked for while it ran. `told` is how telling the server
    /// went; `ended` is what the statement came back with afterwards, if it
    /// came back within [`STOP_GRACE`].
    Stopped {
        told: Told,
        ended: Option<AppResult<T>>,
    },
}

/// How the server was told to stop a statement.
pub(crate) enum Told {
    /// There is nothing to send: the driver is stopped by closing its session
    /// (SQL Server), cannot be stopped (SQLite) or is not stopped by id here
    /// (MongoDB).
    Nothing,
    /// The kill was sent; the statement it is.
    Sent(String),
    /// Sending the kill failed: which statement, and why.
    Failed(String, AppError),
}

/// Run `work` until it ends or `stop` fires. On a stop, send `kill` if there
/// is one and give `work` [`STOP_GRACE`] to come back with the server's
/// answer; without a kill, drop `work` at once.
///
/// `work` runs on a session the caller holds and is dropped when this
/// returns, so the caller decides what becomes of that session — and after a
/// stop it must never go back to the pool.
pub(crate) async fn race<T>(
    work: impl Future<Output = AppResult<T>>,
    stop: &StopSignal,
    kill: Option<&Kill>,
) -> Raced<T> {
    tokio::pin!(work);
    tokio::select! {
        // A statement that ended as the stop arrived is reported as ended.
        biased;
        ended = &mut work => Raced::Ended(ended),
        () = stop.requested() => {
            let Some(kill) = kill else {
                return Raced::Stopped { told: Told::Nothing, ended: None };
            };
            let told = match kill.run().await {
                Ok(()) => Told::Sent(kill.sql.clone()),
                Err(e) => Told::Failed(kill.sql.clone(), e),
            };
            let ended = tokio::time::timeout(STOP_GRACE, &mut work).await.ok();
            Raced::Stopped { told, ended }
        }
    }
}

/// Which way a stopped statement was stopped, for the words that say so.
#[derive(Clone, Copy)]
pub(crate) enum StoppedBy<'a> {
    /// PostgreSQL or MySQL: by id from a second connection.
    Kill { told: &'a Told, mysql: bool },
    /// SQL Server: its session closed, after an Attention.
    MsSql(Cancelled),
    /// SQLite: not stopped at all; its connection detached.
    Sqlite,
    /// MongoDB: the operation and its cursor dropped.
    Mongo,
}

/// What a stopped statement left behind and what happened to it, in words:
/// the parts of an [`AppError::Stopped`], kept apart so a batch can add what
/// the stop did to the rest of it before it becomes the error.
#[derive(Debug)]
pub(crate) struct Stopped {
    pub outcome: StopOutcome,
    pub detail: String,
}

impl From<Stopped> for AppError {
    fn from(Stopped { outcome, detail }: Stopped) -> Self {
        AppError::Stopped { outcome, detail }
    }
}

/// The [`Stopped`] for a statement stopped `by` some means, which
/// `writes` (see [`writes`]) or only reads. `ended` is the error the
/// statement came back with after the stop, when it did.
///
/// A read never applies anything, whatever the stop managed: the outcome is
/// [`StopOutcome::NotApplied`]. A write certainly did not apply only when
/// PostgreSQL answered the kill with the statement's failure: a statement in
/// autocommit is atomic there. MySQL's answer is as clear, but a
/// non-transactional table keeps what the statement had already changed, so
/// it stays [`StopOutcome::MayHaveApplied`]; so does everything else.
pub(crate) fn stopped(by: StoppedBy<'_>, writes: bool, ended: Option<&AppError>) -> Stopped {
    let how = match by {
        StoppedBy::Kill { told, .. } => match (told, ended) {
            (Told::Sent(sql), Some(e)) => format!(
                "The server was told to stop it ({sql}) and stopped it: {}.",
                crate::db::session::failure_text(e)
            ),
            (Told::Sent(sql), None) => format!(
                "The server was told to stop it ({sql}) but did not answer within {} s; \
                 the session was closed.",
                STOP_GRACE.as_secs()
            ),
            (Told::Failed(sql, e), _) => format!(
                "Telling the server to stop it ({sql}) failed: {e}. The session was closed; \
                 the server may run the statement until it next writes to the client."
            ),
            (Told::Nothing, _) => "The session was closed.".to_string(),
        },
        StoppedBy::MsSql(Cancelled::Acknowledged) => {
            "SQL Server acknowledged the cancel and stopped it, and the session was closed."
                .to_string()
        }
        StoppedBy::MsSql(_) => "The session was closed, and SQL Server stops the request of a \
             client that disconnects."
            .to_string(),
        StoppedBy::Sqlite => "SQLite cannot stop a statement once it is running: it goes on, \
             on a connection taken out of the pool, until it ends by itself."
            .to_string(),
        StoppedBy::Mongo => "The app stopped waiting and dropped the operation and its cursor; \
             MongoDB was not told to stop it."
            .to_string(),
    };
    let answered = ended.is_some();
    let (outcome, then) = match by {
        _ if !writes => (
            StopOutcome::NotApplied,
            "Nothing was changed: it was a read.",
        ),
        StoppedBy::Kill {
            told: Told::Sent(_),
            mysql: false,
        } if answered => (
            StopOutcome::NotApplied,
            "PostgreSQL rolled the statement back: nothing of it was applied.",
        ),
        StoppedBy::Kill {
            told: Told::Sent(_),
            mysql: true,
        } if answered => (
            StopOutcome::MayHaveApplied,
            "On a transactional table (InnoDB) MySQL rolled the statement back; a \
             non-transactional one (MyISAM) keeps the rows it had already changed.",
        ),
        StoppedBy::Kill {
            told: Told::Sent(_),
            ..
        }
        | StoppedBy::MsSql(_) => (
            StopOutcome::MayHaveApplied,
            "If it was still running it was undone, but if it had already finished it stays \
             applied: check before running it again.",
        ),
        StoppedBy::Kill { .. } | StoppedBy::Sqlite | StoppedBy::Mongo => (
            StopOutcome::MayHaveApplied,
            "It may still complete and stay applied: check before running it again.",
        ),
    };
    Stopped {
        outcome,
        detail: format!("{how} {then}"),
    }
}

/// Whether `sql` may change something, by its class (ADR #54) rather than by
/// `is_read_only`, which also lets a `WITH … DELETE … RETURNING` through
/// because it returns rows.
pub(crate) fn writes(sql: &str) -> bool {
    crate::db::classify::classify_statement(sql) != StmtClass::Read
}

/// One statement a person typed, with a Stop: [`super::execute_with_state`]'s
/// twin for a run that has a `run_id`.
///
/// Each SQL driver runs it on a session of its own, as the lone ad-hoc read
/// already did (ADR #127) — PostgreSQL and MySQL so that a second connection
/// can stop it by its id, the others so that the session can be closed or
/// detached without taking anyone else's statement with it. The statements
/// sent are the same ones the unstoppable path sends, so a run behaves the
/// same whether or not it can be stopped; PostgreSQL and MySQL pay one round
/// trip more, to learn the session's id.
pub(crate) async fn execute_stoppable(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
    stop: &StopSignal,
) -> AppResult<QueryResult> {
    let pool = state.pool_for(connection_id)?;
    let log = SqlLog::new(sink, connection_id, pool.driver_name());
    let start = Instant::now();
    let writes = writes(sql);
    let elapsed = || start.elapsed().as_millis() as u64;

    let result = if let DbPool::Mongo(conn) = &pool {
        match race(crate::db::mongo::query::execute(conn, sql), stop, None).await {
            Raced::Ended(result) => result,
            Raced::Stopped { .. } => Err(stopped(StoppedBy::Mongo, writes, None).into()),
        }
    } else if is_read_only(sql) {
        read(&pool, sql, writes, stop)
            .await
            .map(|((columns, rows), truncated)| {
                QueryResult::rows(columns, rows, elapsed()).with_truncated(truncated)
            })
    } else {
        write(&pool, sql, writes, stop)
            .await
            .map(|n| QueryResult::affected(n, elapsed()))
    };
    log.outcome(sql, start, result, |r| r.rows_affected)
}

/// Column metadata and rows, as `with_meta` shapes them.
type Shaped = (Vec<super::types::ColumnMeta>, Vec<Vec<serde_json::Value>>);

/// The read half of [`execute_stoppable`]: what `super::execute_adhoc` sends
/// for a read, on a session that can be stopped.
async fn read(
    pool: &DbPool,
    sql: &str,
    writes: bool,
    stop: &StopSignal,
) -> AppResult<(Shaped, bool)> {
    use crate::db::values::{mysql_result, pg_result, sqlite_result};
    match pool {
        DbPool::Postgres(p) => {
            let mut conn = p.acquire().await?;
            let pid: i64 = conn.fetch_one(POSTGRES_SESSION_ID).await?.try_get(0)?;
            let kill = Kill::postgres(pool, pid);
            let (rows, truncated) = fetch(conn, Some(kill), sql, writes, stop, false).await?;
            Ok((with_meta(pg_result(&rows)), truncated))
        }
        DbPool::Mysql(p) => {
            let mut conn = p.acquire().await?;
            let id: i64 = conn.fetch_one(MYSQL_SESSION_ID).await?.try_get(0)?;
            let kill = Kill::mysql(pool, id);
            let (rows, truncated) = fetch(conn, Some(kill), sql, writes, stop, true).await?;
            Ok((with_meta(mysql_result(&rows)), truncated))
        }
        DbPool::Sqlite(p) => {
            let conn = p.acquire().await?;
            let (rows, truncated) = fetch(conn, None, sql, writes, stop, false).await?;
            Ok((with_meta(sqlite_result(&rows)), truncated))
        }
        DbPool::MsSql(p) => {
            use crate::db::mssql::Overflow;
            let mut client = p.acquire().await?;
            let raced = race(
                client.simple_query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS, Overflow::Close),
                stop,
                None,
            )
            .await;
            let (sets, truncated) = match raced {
                Raced::Ended(fetched) => fetched?,
                Raced::Stopped { .. } => {
                    client.close_on_drop();
                    let how = mssql_cancel(&mut client).await;
                    return Err(stopped(StoppedBy::MsSql(how), writes, None).into());
                }
            };
            // The first non-empty set, as the editor's read does.
            let rows = sets.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
            Ok((
                with_meta(crate::db::mssql::schema::decode_rows(&rows)),
                truncated,
            ))
        }
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched before the SQL drivers"),
    }
}

/// The write half of [`execute_stoppable`]: what `super::execute_adhoc` sends
/// for a write — the unprepared protocol, on every driver — on a session that
/// can be stopped. Returns the rows it affected.
async fn write(pool: &DbPool, sql: &str, writes: bool, stop: &StopSignal) -> AppResult<u64> {
    match pool {
        DbPool::Postgres(p) => {
            let mut conn = p.acquire().await?;
            let pid: i64 = conn.fetch_one(POSTGRES_SESSION_ID).await?.try_get(0)?;
            let mut flight = InFlight::new(conn, Some(Kill::postgres(pool, pid)));
            let conn = flight.conn.as_mut().expect("in flight");
            let raced = race(
                async { Ok(conn.execute(sql).await?.rows_affected()) },
                stop,
                flight.kill.as_ref(),
            )
            .await;
            settle(flight, raced, writes, false)
        }
        DbPool::Mysql(p) => {
            let mut conn = p.acquire().await?;
            let id: i64 = conn.fetch_one(MYSQL_SESSION_ID).await?.try_get(0)?;
            let mut flight = InFlight::new(conn, Some(Kill::mysql(pool, id)));
            let conn = flight.conn.as_mut().expect("in flight");
            let raced = race(
                async { Ok(conn.execute(sql).await?.rows_affected()) },
                stop,
                flight.kill.as_ref(),
            )
            .await;
            settle(flight, raced, writes, true)
        }
        DbPool::Sqlite(p) => {
            let mut flight = InFlight::new(p.acquire().await?, None);
            let conn = flight.conn.as_mut().expect("in flight");
            let raced = race(
                async { Ok(conn.execute(sql).await?.rows_affected()) },
                stop,
                None,
            )
            .await;
            settle(flight, raced, writes, false)
        }
        DbPool::MsSql(p) => {
            let mut client = p.acquire().await?;
            match race(client.simple_execute(sql), stop, None).await {
                Raced::Ended(result) => result,
                Raced::Stopped { .. } => {
                    client.close_on_drop();
                    let how = mssql_cancel(&mut client).await;
                    Err(stopped(StoppedBy::MsSql(how), writes, None).into())
                }
            }
        }
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched before the SQL drivers"),
    }
}

/// Read `sql` on `conn`, stoppable, with the lone read's tail (ADR #127): an
/// overflowing result closes the session instead of draining it.
async fn fetch<DB>(
    conn: PoolConnection<DB>,
    kill: Option<Kill>,
    sql: &str,
    writes: bool,
    stop: &StopSignal,
    mysql: bool,
) -> AppResult<(Vec<DB::Row>, bool)>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    let mut flight = InFlight::new(conn, kill);
    let conn = flight.conn.as_mut().expect("in flight");
    let raced = race(
        async {
            fetch_capped(&mut **conn, sql, MAX_ADHOC_QUERY_ROWS)
                .await
                .map_err(AppError::from)
        },
        stop,
        flight.kill.as_ref(),
    )
    .await;
    if let Raced::Ended(Ok((_, true))) = &raced {
        // Overflowed: closed rather than drained, as the lone read is.
        flight.kill = None;
        drop(flight.conn.take().map(PoolConnection::detach));
    }
    settle(flight, raced, writes, mysql)
}

/// What a `sqlx` statement raced against a Stop comes to, and what becomes of
/// its session: back to the pool only when it ended with no stop asked for.
///
/// A statement that came back with `Ok` after the stop finished before the
/// stop reached it: its result is the truth, and is returned as it is. Its
/// session is closed all the same.
fn settle<DB: sqlx::Database, T>(
    mut flight: InFlight<DB>,
    raced: Raced<T>,
    writes: bool,
    mysql: bool,
) -> AppResult<T> {
    match raced {
        Raced::Ended(result) => {
            if flight.conn.is_some() {
                drop(flight.land());
            }
            result
        }
        Raced::Stopped { told, ended } => {
            // Sent already, or nothing to send: the drop must not send it again.
            flight.kill = None;
            drop(flight);
            let by = if matches!(told, Told::Nothing) {
                StoppedBy::Sqlite
            } else {
                StoppedBy::Kill { told: &told, mysql }
            };
            match ended {
                Some(Ok(value)) => Ok(value),
                Some(Err(e)) => Err(stopped(by, writes, Some(&e)).into()),
                None => Err(stopped(by, writes, None).into()),
            }
        }
    }
}

/// Stop a SQL Server session whose statement was just dropped: an Attention
/// first, then closed either way (its guard is marked by the caller).
pub(crate) async fn mssql_cancel(client: &mut crate::db::mssql::PooledClient) -> Cancelled {
    if client.cancel(MSSQL_CANCEL_WAIT).await {
        Cancelled::Acknowledged
    } else {
        Cancelled::Disconnected
    }
}

/// SQLite, in a file: what a person's Stop leaves behind. A statement that
/// waits without burning CPU is one waiting on a lock another connection
/// holds, so it sits in SQLite's busy handler until it is stopped — the same
/// trick as `bounded::tests`. The network drivers' kill by id needs a live
/// server: `commands::stop_live_tests`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_bus::LogEntry;
    use crate::state::ActivePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use sqlx::ConnectOptions as _;
    use std::sync::Arc;

    struct Quiet;
    impl LogSink for Quiet {
        fn log(&self, _: LogEntry) {}
    }

    fn options(name: &str) -> SqliteConnectOptions {
        let path = std::env::temp_dir().join(format!("huginndb_stop_{name}.db"));
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete)
            .busy_timeout(Duration::from_secs(5))
    }

    /// One connection, so the test sees the very connection the run used —
    /// or, when the run must not give it back, that the pool opened another.
    async fn state(name: &str) -> (AppState, sqlx::SqlitePool) {
        let path = std::env::temp_dir().join(format!("huginndb_stop_{name}.db"));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options(name))
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
        let state = AppState::new();
        state
            .connections
            .write()
            .insert("c".into(), ActivePool::bare(DbPool::Sqlite(pool.clone())));
        (state, pool)
    }

    /// A connection outside the pool holding a lock: `EXCLUSIVE` keeps
    /// readers out, `IMMEDIATE` only writers.
    async fn lock(name: &str, how: &str) -> sqlx::SqliteConnection {
        let mut locker = options(name).connect().await.unwrap();
        locker.execute(how).await.unwrap();
        locker
    }

    async fn rows_in_t(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Press Stop on `id` after `ms`.
    async fn stop_after(runs: &Arc<crate::runs::RunRegistry>, id: &str, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        assert!(
            runs.stop(id),
            "the run is still in flight when Stop is pressed"
        );
    }

    fn outcome_of(e: &AppError) -> StopOutcome {
        match e {
            AppError::Stopped { outcome, .. } => *outcome,
            other => panic!("expected a stop, got {other}"),
        }
    }

    #[test]
    fn a_stop_renders_its_tag_and_outcome_first() {
        let e: AppError = Stopped {
            outcome: StopOutcome::MayHaveApplied,
            detail: "SQLite cannot stop it.".into(),
        }
        .into();
        assert_eq!(
            e.to_string(),
            "query stopped (may have applied): SQLite cannot stop it."
        );
    }

    #[tokio::test]
    async fn a_stopped_read_leaves_the_one_connection_pool_usable() {
        let (state, pool) = state("read").await;
        let mut locker = lock("read", "BEGIN EXCLUSIVE").await;

        let run = state.runs.start("r".into()).unwrap();
        let signal = run.signal();
        let started = Instant::now();
        let (result, ()) = tokio::join!(
            execute_stoppable(&Quiet, &state, "c", "SELECT id FROM t", &signal),
            stop_after(&state.runs, "r", 300),
        );
        drop(run);
        let err = result.expect_err("the read waits on the lock until it is stopped");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "stopped when asked, not at SQLite's busy timeout"
        );
        assert_eq!(outcome_of(&err), StopOutcome::NotApplied);
        let message = err.to_string();
        assert!(
            message.starts_with("query stopped (not applied): "),
            "{message}"
        );
        assert!(message.contains("it was a read"), "{message}");
        assert_eq!(state.runs.len(), 0, "the registry cleans up after itself");

        locker.execute("ROLLBACK").await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(&pool)
            .await
            .expect("a fresh, writable connection in the stopped one's place");
        assert_eq!(rows_in_t(&pool).await, 2);
    }

    /// SQLite cannot interrupt a statement: a stopped write is freed in the
    /// tab and says it may still apply — and here it does, once the lock it
    /// was waiting on goes away. That is the case the message is for.
    #[tokio::test]
    async fn a_stopped_sqlite_write_says_it_may_still_apply() {
        let (state, pool) = state("write").await;
        let mut locker = lock("write", "BEGIN IMMEDIATE").await;

        let run = state.runs.start("w".into()).unwrap();
        let signal = run.signal();
        let (result, ()) = tokio::join!(
            execute_stoppable(
                &Quiet,
                &state,
                "c",
                "INSERT INTO t (id) VALUES (2)",
                &signal
            ),
            stop_after(&state.runs, "w", 300),
        );
        let err = result.expect_err("the write waits on the lock until it is stopped");
        assert_eq!(outcome_of(&err), StopOutcome::MayHaveApplied);
        let message = err.to_string();
        assert!(
            message.starts_with("query stopped (may have applied): "),
            "{message}"
        );
        assert!(message.contains("may still complete"), "{message}");

        locker.execute("ROLLBACK").await.unwrap();
        // The pool still serves, on a new connection.
        assert!(rows_in_t(&pool).await >= 1);
        // And the detached statement goes on to apply by itself.
        let mut applied = false;
        for _ in 0..50 {
            if rows_in_t(&pool).await == 2 {
                applied = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(applied, "SQLite finished the stopped write on its own");
    }

    #[tokio::test]
    async fn a_run_nobody_stops_ends_as_it_always_did() {
        let (state, pool) = state("plain").await;
        let run = state.runs.start("p".into()).unwrap();
        let result = execute_stoppable(&Quiet, &state, "c", "SELECT id FROM t", &run.signal())
            .await
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        let result = execute_stoppable(
            &Quiet,
            &state,
            "c",
            "INSERT INTO t (id) VALUES (2)",
            &run.signal(),
        )
        .await
        .unwrap();
        assert_eq!(result.rows_affected, 1);
        drop(run);
        assert_eq!(state.runs.len(), 0);
        assert!(!state.runs.stop("p"), "a finished run is not found");
        assert_eq!(rows_in_t(&pool).await, 2);
    }

    /// A batch stopped at its second statement says so, carries the first
    /// statement's outcome, and runs nothing after it.
    #[tokio::test]
    async fn a_batch_stopped_halfway_reports_which_statement_it_stopped_at() {
        let (state, pool) = state("batch").await;
        let mut locker = lock("batch", "BEGIN IMMEDIATE").await;

        let run = state.runs.start("b".into()).unwrap();
        let signal = run.signal();
        let statements = vec![
            "SELECT id FROM t".to_string(),
            "INSERT INTO t (id) VALUES (2)".to_string(),
            "SELECT 3".to_string(),
        ];
        let (result, ()) = tokio::join!(
            super::super::execute_batch_stoppable(
                &Quiet,
                &state,
                "c".into(),
                statements,
                Some(&signal)
            ),
            stop_after(&state.runs, "b", 300),
        );
        let batch = result.expect("a stopped batch is a result, not an error");
        let stop = batch.stopped.expect("the batch says it was stopped");
        assert_eq!(stop.index, 1);
        assert_eq!(stop.outcome, StopOutcome::MayHaveApplied);
        assert_eq!(batch.statements.len(), 2, "nothing after the stop ran");
        assert!(batch.statements[0].error.is_none());
        let error = batch.statements[1].error.as_deref().unwrap();
        assert!(error.starts_with("query stopped"), "{error}");
        assert!(error.contains("did not run"), "{error}");
        assert!(error.contains("rolled back by the server"), "{error}");

        locker.execute("ROLLBACK").await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (3)")
            .execute(&pool)
            .await
            .expect("the batch's session was given up, not left holding the slot");
    }

    #[tokio::test]
    async fn a_stop_asked_between_statements_runs_nothing_more() {
        let (state, _pool) = state("between").await;
        let run = state.runs.start("x".into()).unwrap();
        let signal = run.signal();
        assert!(state.runs.stop("x"));
        let batch = super::super::execute_batch_stoppable(
            &Quiet,
            &state,
            "c".into(),
            vec!["SELECT 1".into(), "SELECT 2".into()],
            Some(&signal),
        )
        .await
        .unwrap();
        let stop = batch.stopped.unwrap();
        assert_eq!((stop.index, stop.outcome), (0, StopOutcome::NotApplied));
        assert_eq!(batch.statements.len(), 1);
    }

    #[test]
    fn a_write_is_certainly_not_applied_only_when_postgres_says_so() {
        let sent = Told::Sent("SELECT pg_cancel_backend(7)".into());
        let answer = AppError::InvalidInput("canceling statement due to user request".into());
        let pg = StoppedBy::Kill {
            told: &sent,
            mysql: false,
        };
        let mysql = StoppedBy::Kill {
            told: &sent,
            mysql: true,
        };
        let outcome = |s: Stopped| s.outcome;
        assert_eq!(
            outcome(stopped(pg, true, Some(&answer))),
            StopOutcome::NotApplied
        );
        assert_eq!(
            outcome(stopped(pg, true, None)),
            StopOutcome::MayHaveApplied
        );
        assert_eq!(
            outcome(stopped(mysql, true, Some(&answer))),
            StopOutcome::MayHaveApplied
        );
        assert_eq!(
            outcome(stopped(
                StoppedBy::MsSql(Cancelled::Disconnected),
                true,
                None
            )),
            StopOutcome::MayHaveApplied
        );
        assert_eq!(
            outcome(stopped(StoppedBy::Mongo, true, None)),
            StopOutcome::MayHaveApplied
        );
        for by in [
            pg,
            mysql,
            StoppedBy::Sqlite,
            StoppedBy::Mongo,
            StoppedBy::MsSql(Cancelled::Acknowledged),
        ] {
            assert_eq!(
                outcome(stopped(by, false, None)),
                StopOutcome::NotApplied,
                "a read never applies anything"
            );
        }
    }

    #[test]
    fn a_hidden_write_counts_as_a_write() {
        assert!(!writes("SELECT 1"));
        assert!(writes("UPDATE t SET a = 1"));
        // Fetched for its rows, but it deletes.
        assert!(writes(
            "WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d"
        ));
        assert!(writes("db.users.deleteMany({ a: 1 })"));
        assert!(!writes("db.users.find({})"));
    }
}
