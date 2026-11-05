//! The reads an AI runs (`run_query`, `run_queries`, the AI panel's
//! `run_query` tool), bounded by a deadline and stopped **on the server** when
//! it passes, or when whoever asked stops waiting (ADR #134).
//!
//! It is also the read-only barrier of ADR #93: the read runs inside a
//! read-only transaction on PostgreSQL and MySQL and with `PRAGMA query_only`
//! on SQLite, so a write the text classifier missed — a CTE carrying a
//! `DELETE`, a function with side effects called from a `SELECT` — fails on
//! the server instead of executing. SQL Server has no read-only transaction
//! and MongoDB no such mode; they rely on the classifier alone. On MySQL a DDL
//! statement commits the transaction implicitly before running, so there the
//! barrier stops DML but not DDL, which the classifier's DDL-first check has
//! to catch.
//!
//! A person's read from the editor (`super::execute_with_state`) stays
//! unbounded on purpose: the person is watching it and can stop it. An AI's
//! read used to have no limit either. When the MCP client gave up (Claude
//! Desktop does after 60 s), nothing told the app, and the statement went on
//! loading the server. Against a client's production
//! SQL Server that was a `GROUP BY` on a bad plan, still running long after
//! the AI had been told "Request timed out", until someone ran `KILL` by hand.
//!
//! Two things stop a read here:
//!
//! - **The deadline**: the connection's MCP timeout (`state::mcp_timeout`,
//!   300 s unless the connection sets a lower ceiling), resolved against this
//!   side's profiles by `bridge::exec`.
//! - **The caller going away**: this future being dropped. The bridge drops it
//!   when the sidecar hangs up (`bridge::server`), and the sidecar drops its
//!   call when the MCP client cancels the request (`mcp::McpServer`).
//!
//! Either way, the statement is stopped where it runs, and its session never
//! goes back to the pool. Closing the socket is not enough on its own: SQL
//! Server aborts the request of a client that disconnects (gotcha #132), but
//! PostgreSQL and MySQL only notice a vanished client when they next write to
//! it, which a `GROUP BY` does not do until it has finished. So those two learn
//! the session's id before the statement runs, and a second connection cancels
//! it by id (`pg_cancel_backend`, `KILL QUERY`). MongoDB gets a `maxTimeMS`,
//! because dropping a driver future does not stop the operation either.

use std::time::{Duration, Instant};

use sqlx::pool::PoolConnection;
use sqlx::{Executor as _, Row as _};

use super::types::{with_meta, QueryResult};
use super::MAX_ADHOC_QUERY_ROWS;
use crate::db::session::fetch_capped;
use crate::db::sql::is_read_only;
use crate::error::{AppError, AppResult};
use crate::log_bus::{LogSink, SqlLog};
use crate::state::{AppState, DbPool, McpTimeout};

/// How long telling the server to stop a statement may take — reaching a free
/// connection and sending the cancel — before the attempt is given up. The
/// session has been closed by then, so giving up only loses the confirmation.
const KILL_WAIT: Duration = Duration::from_secs(10);

/// How long SQL Server is given to acknowledge an Attention before the session
/// is closed instead. Shorter than `db::session`'s wait for a script: a read
/// has no transaction to roll back afterwards, so the acknowledgement buys
/// nothing but a nicer sentence, and with tiberius 0.13 it does not come
/// anyway (gotcha #132).
const MSSQL_CANCEL_WAIT: Duration = Duration::from_secs(5);

/// What MongoDB is given past its own `maxTimeMS` before the client stops
/// waiting: the server's limit is the one that stops the work, and its error
/// is the clearer answer, so it gets the chance to arrive first.
const MONGO_GRACE: Duration = Duration::from_secs(5);

/// Run `sql`, which the caller has classified as a read, behind the read-only
/// barrier and the ad-hoc row cap (ADR #127), stopped on the server after
/// `timeout` or as soon as this future is dropped.
///
/// Refuses outright a statement that is not even shaped like a read.
pub(crate) async fn execute_read_bounded(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    sql: &str,
    timeout: McpTimeout,
) -> AppResult<QueryResult> {
    let pool = state.pool_for(connection_id)?;
    let log = SqlLog::new(sink, connection_id, pool.driver_name());
    let start = Instant::now();
    let limit = Duration::from_secs(u64::from(timeout.secs));
    let deadline = tokio::time::Instant::now() + limit;

    if let DbPool::Mongo(conn) = &pool {
        let run = crate::db::mongo::query::execute_within(conn, sql, Some(limit));
        let result = match tokio::time::timeout_at(deadline + MONGO_GRACE, run).await {
            Ok(Err(e)) if crate::db::mongo::query::is_max_time_expired(&e) => Err(timed_out(
                timeout,
                "MongoDB stopped it at its maxTimeMS; nothing was changed — it was a read.",
            )),
            Ok(result) => result,
            Err(_) => Err(timed_out(
                timeout,
                "MongoDB did not answer, though the operation carried a maxTimeMS that makes \
                 the server stop it by itself.",
            )),
        };
        return log.outcome(sql, start, result, |r| r.rows_affected);
    }

    if !is_read_only(sql) {
        return Err(AppError::InvalidInput(
            "this statement is not a read, and was sent to be run as one".into(),
        ));
    }

    let result = read_sql(&pool, sql, timeout, deadline)
        .await
        .map(|(meta, truncated)| {
            let (columns, rows) = meta;
            QueryResult::rows(columns, rows, start.elapsed().as_millis() as u64)
                .with_truncated(truncated)
        });
    log.outcome(sql, start, result, |r| r.rows_affected)
}

/// Column metadata and rows, as `with_meta` shapes them.
type Shaped = (Vec<super::types::ColumnMeta>, Vec<Vec<serde_json::Value>>);

/// The SQL half of [`execute_read_bounded`]: one dedicated session per read,
/// the read-only barrier, and a stop on the server when the deadline passes or
/// the future is dropped.
async fn read_sql(
    pool: &DbPool,
    sql: &str,
    timeout: McpTimeout,
    deadline: tokio::time::Instant,
) -> AppResult<(Shaped, bool)> {
    use crate::db::values::{mysql_result, pg_result, sqlite_result};
    let acquire_late = || {
        timed_out(
            timeout,
            "No connection came free before it ran out of time.",
        )
    };
    match pool {
        DbPool::Postgres(p) => {
            let mut conn = tokio::time::timeout_at(deadline, p.acquire())
                .await
                .map_err(|_| acquire_late())??;
            // One round trip: the simple-query protocol runs both, and the pid
            // is what a second connection needs to cancel this one.
            let pid: i64 = conn
                .fetch_one("BEGIN READ ONLY; SELECT pg_backend_pid()::int8")
                .await?
                .try_get(0)?;
            let kill = Kill {
                pool: pool.clone(),
                sql: format!("SELECT pg_cancel_backend({pid})"),
            };
            let (rows, truncated) = fetch_killable(conn, kill, sql, timeout, deadline).await?;
            Ok((with_meta(pg_result(&rows)), truncated))
        }
        DbPool::Mysql(p) => {
            let mut conn = tokio::time::timeout_at(deadline, p.acquire())
                .await
                .map_err(|_| acquire_late())??;
            // Two round trips rather than a multi-statement one: a proxy in
            // front of the server may not pass multi-statements through.
            conn.execute("START TRANSACTION READ ONLY").await?;
            let id: i64 = conn
                .fetch_one("SELECT CAST(CONNECTION_ID() AS SIGNED)")
                .await?
                .try_get(0)?;
            let kill = Kill {
                pool: pool.clone(),
                sql: format!("KILL QUERY {id}"),
            };
            let (rows, truncated) = fetch_killable(conn, kill, sql, timeout, deadline).await?;
            Ok((with_meta(mysql_result(&rows)), truncated))
        }
        DbPool::Sqlite(p) => {
            let conn = tokio::time::timeout_at(deadline, p.acquire())
                .await
                .map_err(|_| acquire_late())??;
            let mut flight = InFlight::new(conn, None);
            sqlx::query("PRAGMA query_only = ON")
                .execute(flight.conn())
                .await?;
            let fetched = tokio::time::timeout_at(
                deadline,
                fetch_capped(flight.conn(), sql, MAX_ADHOC_QUERY_ROWS),
            )
            .await;
            let Ok(fetched) = fetched else {
                drop(flight);
                return Err(timed_out(
                    timeout,
                    "SQLite cannot stop a statement once it is running: it finishes in the \
                     background, on a connection taken out of the pool, and changes nothing.",
                ));
            };
            let mut conn = flight.land();
            if sqlx::query("PRAGMA query_only = OFF")
                .execute(&mut *conn)
                .await
                .is_err()
            {
                conn.close_on_drop();
            }
            let (rows, truncated) = fetched?;
            Ok((with_meta(sqlite_result(&rows)), truncated))
        }
        DbPool::MsSql(p) => {
            use crate::db::mssql::Overflow;
            let mut client = tokio::time::timeout_at(deadline, p.acquire())
                .await
                .map_err(|_| acquire_late())??;
            // Dropped mid-read, a `PooledClient` was never judged healthy, so
            // it is closed rather than pooled — and SQL Server aborts the
            // request of a client that disconnects (gotcha #132). That is the
            // whole of the cancel when this future is dropped.
            let fetched = tokio::time::timeout_at(
                deadline,
                client.simple_query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS, Overflow::Close),
            )
            .await;
            let Ok(fetched) = fetched else {
                client.close_on_drop();
                let verdict = if client.cancel(MSSQL_CANCEL_WAIT).await {
                    "SQL Server acknowledged the cancel and stopped it; nothing was changed — \
                     it was a read."
                } else {
                    "The session was closed, and SQL Server stops the request of a client \
                     that disconnects; nothing was changed — it was a read."
                };
                return Err(timed_out(timeout, verdict));
            };
            let (sets, truncated) = fetched?;
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

/// Read `sql` on `conn`, already inside its read-only transaction, until
/// `deadline`; past it, or if this future is dropped, close the session and
/// have `kill` stop the statement on the server.
///
/// The tail is `fetch_capped_alone`'s (ADR #127): an overflowing result closes
/// the session instead of draining it, and a kept one is rolled back.
async fn fetch_killable<DB>(
    conn: PoolConnection<DB>,
    kill: Kill,
    sql: &str,
    timeout: McpTimeout,
    deadline: tokio::time::Instant,
) -> AppResult<(Vec<DB::Row>, bool)>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    let mut flight = InFlight::new(conn, Some(kill));
    let fetched = tokio::time::timeout_at(
        deadline,
        fetch_capped(flight.conn(), sql, MAX_ADHOC_QUERY_ROWS),
    )
    .await;
    let Ok(fetched) = fetched else {
        let kill = flight.kill.take();
        // Closed first: whatever the cancel says, this session is done.
        drop(flight);
        let verdict = match kill {
            Some(kill) => match kill.run().await {
                Ok(()) => format!(
                    "The server was told to stop it ({}) and the session was closed; nothing \
                     was changed — it was a read.",
                    kill.sql
                ),
                Err(e) => format!(
                    "Telling the server to stop it ({}) failed: {e}. The session was closed; \
                     the server may run the statement until it next writes to the client.",
                    kill.sql
                ),
            },
            None => "The session was closed.".to_string(),
        };
        return Err(timed_out(timeout, &verdict));
    };
    let mut conn = flight.land();
    if matches!(fetched, Ok((_, true))) {
        drop(conn.detach());
        return Ok(fetched?);
    }
    if conn.execute("ROLLBACK").await.is_err() {
        conn.close_on_drop();
    }
    Ok(fetched?)
}

/// A statement's session while the statement runs: dropped before it
/// [`lands`](Self::land), it is taken out of the pool and closed — never handed
/// to the next borrower mid-statement, which `sqlx` would otherwise do once
/// its on-release ping had waited for the statement to end — and its
/// [`Kill`], if any, is sent from a task of its own.
struct InFlight<DB: sqlx::Database> {
    conn: Option<PoolConnection<DB>>,
    kill: Option<Kill>,
}

impl<DB: sqlx::Database> InFlight<DB> {
    fn new(conn: PoolConnection<DB>, kill: Option<Kill>) -> Self {
        Self {
            conn: Some(conn),
            kill,
        }
    }

    fn conn(&mut self) -> &mut DB::Connection {
        self.conn
            .as_mut()
            .expect("an InFlight holds its connection until it lands")
    }

    /// The statement finished: keep the session, and drop the cancel.
    fn land(mut self) -> PoolConnection<DB> {
        self.kill = None;
        self.conn.take().expect("an InFlight lands once")
    }
}

impl<DB: sqlx::Database> Drop for InFlight<DB> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            // Detached, not `close_on_drop`: closing through the pool would
            // first wait for the statement to finish.
            drop(conn.detach());
        }
        if let Some(kill) = self.kill.take() {
            kill.spawn();
        }
    }
}

/// The statement that stops another session's statement, and the pool to send
/// it from.
struct Kill {
    pool: DbPool,
    sql: String,
}

impl Kill {
    /// Send it, from whichever connection of the pool is free.
    async fn run(&self) -> AppResult<()> {
        let send = async {
            match &self.pool {
                DbPool::Postgres(p) => p.execute(self.sql.as_str()).await.map(|_| ()),
                DbPool::Mysql(p) => p.execute(self.sql.as_str()).await.map(|_| ()),
                _ => Ok(()),
            }
        };
        match tokio::time::timeout(KILL_WAIT, send).await {
            Ok(sent) => sent.map_err(AppError::from),
            Err(_) => Err(AppError::OperationTimedOut(format!(
                "no answer within {} s",
                KILL_WAIT.as_secs()
            ))),
        }
    }

    /// [`Self::run`] from a task of its own, for a caller that is being
    /// dropped and cannot wait for it. Nobody is left to tell how it went.
    fn spawn(self) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = self.run().await;
            });
        }
    }
}

/// What these reads say when they run out of time: what happened to the
/// statement, and what to do instead of running it again.
fn timed_out(timeout: McpTimeout, verdict: &str) -> AppError {
    AppError::InvalidInput(format!(
        "the read was cancelled: it ran out of time after {} s. {verdict} {READ_TIMEOUT_HINT}",
        timeout.secs
    ))
}

/// The end of every timeout error from [`execute_read_bounded`].
///
/// Not `script::TIMEOUT_HINT`: a read takes no `timeout_seconds`. And the
/// advice matters more than the knob — a read that runs this long usually has
/// a bad plan, and running it again only loads the server a second time.
const READ_TIMEOUT_HINT: &str = "Do not run it again as it is: look at its plan first \
     (EXPLAIN, or pulse_explain) and make it cheaper — a narrower filter, an index, a \
     different join. A read gets this connection's MCP timeout, which only the user can \
     change (HuginnDB → Settings → MCP).";

/// SQLite, in a file: the barrier, and what a deadline or a dropped caller
/// leaves behind. A slow read without burning CPU is a read waiting on a lock:
/// another connection holds `BEGIN EXCLUSIVE` in rollback-journal mode, and
/// the read sits in SQLite's busy handler until the deadline or the drop.
/// The network drivers' kill by id needs a live server — `mssql_live_tests`
/// and the manual checks the PR records.
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use sqlx::ConnectOptions as _;

    fn options(name: &str) -> SqliteConnectOptions {
        let path = std::env::temp_dir().join(format!("huginndb_bounded_read_{name}.db"));
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete)
            .busy_timeout(Duration::from_secs(5))
    }

    /// One connection, so a test sees the very connection the read used —
    /// or, when the read must not give it back, that the pool opened another.
    async fn pool(name: &str) -> DbPool {
        let path = std::env::temp_dir().join(format!("huginndb_bounded_read_{name}.db"));
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
        DbPool::Sqlite(pool)
    }

    fn sqlite(pool: &DbPool) -> &sqlx::SqlitePool {
        match pool {
            DbPool::Sqlite(p) => p,
            _ => unreachable!(),
        }
    }

    fn seconds(secs: u32) -> McpTimeout {
        McpTimeout {
            secs,
            requested: None,
            cap: secs,
        }
    }

    fn deadline(secs: u64) -> tokio::time::Instant {
        tokio::time::Instant::now() + Duration::from_secs(secs)
    }

    /// A connection outside the pool holding the write lock, so readers wait.
    async fn lock(name: &str) -> sqlx::SqliteConnection {
        let mut locker = options(name).connect().await.unwrap();
        locker.execute("BEGIN EXCLUSIVE").await.unwrap();
        locker
    }

    async fn rows_in_t(pool: &DbPool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(sqlite(pool))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_write_that_reaches_the_barrier_is_refused_by_sqlite() {
        let pool = pool("refused").await;
        // As if the classifier had let it through as a read.
        let err = read_sql(&pool, "DELETE FROM t RETURNING id", seconds(5), deadline(5)).await;
        assert!(err.is_err(), "query_only must refuse the delete");
        assert_eq!(rows_in_t(&pool).await, 1, "the row must still be there");
    }

    #[tokio::test]
    async fn the_connection_goes_back_to_the_pool_writable() {
        let pool = pool("restored").await;
        let ((_, rows), _) = read_sql(&pool, "SELECT id FROM t", seconds(5), deadline(5))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        // The pool's only connection is the one the read used.
        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(sqlite(&pool))
            .await
            .expect("the user's own write must not inherit query_only");
    }

    /// Past its deadline the read comes back with what happened to it and
    /// what to do instead, and its session does not go back to the pool: on a
    /// one-connection pool, the next statement gets a fresh connection, not
    /// the one still waiting inside the cancelled read with `query_only` on.
    #[tokio::test]
    async fn a_read_past_its_deadline_is_cancelled_and_its_session_closed() {
        let pool = pool("deadline").await;
        let mut locker = lock("deadline").await;

        let started = Instant::now();
        let err = read_sql(&pool, "SELECT id FROM t", seconds(1), deadline(1))
            .await
            .expect_err("the read waits on the lock past its deadline");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "stopped at the deadline, not at SQLite's busy timeout"
        );
        let message = err.to_string();
        assert!(message.contains("ran out of time after 1 s"), "{message}");
        assert!(message.contains("Do not run it again"), "{message}");

        locker.execute("ROLLBACK").await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(sqlite(&pool))
            .await
            .expect("a fresh, writable connection in the cancelled one's place");
        assert_eq!(rows_in_t(&pool).await, 2);
    }

    /// The caller going away — the bridge dropping the read when the sidecar
    /// hangs up — leaves the pool as the deadline does.
    #[tokio::test]
    async fn a_dropped_read_does_not_hand_its_session_to_the_next_borrower() {
        let pool = pool("dropped").await;
        let mut locker = lock("dropped").await;

        let read = read_sql(&pool, "SELECT id FROM t", seconds(30), deadline(30));
        assert!(
            tokio::time::timeout(Duration::from_millis(300), read)
                .await
                .is_err(),
            "the read is still waiting on the lock when it is dropped"
        );

        locker.execute("ROLLBACK").await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (2)")
            .execute(sqlite(&pool))
            .await
            .expect("a fresh, writable connection in the dropped one's place");
    }
}
