//! One borrowed session on any SQL pool, for the paths that run several
//! statements in order and need them to share it.
//!
//! [`crate::db::exec`] runs one statement on whichever connection the pool
//! hands out. Three commands cannot work that way, because what one statement
//! leaves behind is what the next one runs against — an explicit transaction,
//! a `#temp` table, a `SET`, a MySQL `USE`:
//!
//! - the query editor's batch (`commands::query::execute_batch_inner`);
//! - the MCP `run_script` tool (`commands::script`);
//! - the MCP `run_writes` tool (`commands::write_batch`).
//!
//! Each of them used to carry its own `drive!` macro, written once against
//! `sqlx`'s `Executor` and once more against `tiberius`, so the same
//! acquire / run / decode / log loop existed five times in three files.
//! [`Session`] is the part they share: hold one session, run a statement on it
//! for its row count ([`Session::exec`]) or for its rows ([`Session::fetch`]),
//! and open or close a transaction on it. What stays with each caller is its
//! policy: stop or roll back on failure, how the row budget is shared, which
//! row counts it promised.
//!
//! **A transaction never outlives its session.** [`Session::begin`] marks the
//! session as inside one, and only a successful [`Session::end`] clears that.
//! A session dropped while the mark is set — a failed `ROLLBACK`, a failed
//! `COMMIT`, or the caller's future cancelled between two statements — is
//! closed instead of returned to the pool, so the server rolls the
//! transaction back and nobody else borrows a connection with one open.
//! `sqlx`'s own `Transaction` does this for its pools; this does it for all
//! four drivers, SQL Server included.
//!
//! MongoDB has no place here, as in [`crate::db::exec`]: every caller
//! dispatches it before acquiring a session.

use serde_json::Value;
use sqlx::pool::PoolConnection;
use sqlx::{MySql, Postgres, Sqlite};

use crate::db::mssql::{Overflow, PooledClient};
use crate::error::{AppError, AppResult};
use crate::state::DbPool;

/// One result set, decoded: the column `(name, type)` pairs, the rows as JSON,
/// and whether rows past the cap were left out.
///
/// The untyped column pairs for the reason `db::values::pg_result` gives:
/// `ColumnMeta` lives in `commands::query`, which `db/` does not depend on.
#[derive(Debug)]
pub struct RowSet {
    pub columns: Vec<(String, String)>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

/// A session borrowed from a SQL pool for a sequence of statements.
pub struct Session {
    conn: Conn,
    /// Set by [`Self::begin`] and cleared by a successful [`Self::end`]; a
    /// session dropped while it is set is closed, never pooled.
    in_tx: bool,
}

enum Conn {
    Postgres(PoolConnection<Postgres>),
    Mysql(PoolConnection<MySql>),
    Sqlite(PoolConnection<Sqlite>),
    /// Boxed: a TDS client is over a kilobyte, twenty times a `sqlx` handle.
    MsSql(Box<PooledClient>),
}

/// Run `$body` with `$c` bound to the `sqlx` connection of whichever of the
/// three pools this is, or `$mssql` for SQL Server. A macro because the three
/// connection types share an API but no trait we can name at a signature.
macro_rules! on_conn {
    ($conn:expr, |$c:ident| $body:expr, |$m:ident| $mssql:expr) => {
        match $conn {
            Conn::Postgres($c) => $body,
            Conn::Mysql($c) => $body,
            Conn::Sqlite($c) => $body,
            Conn::MsSql($m) => $mssql,
        }
    };
}

impl Session {
    /// Borrow one session from `pool`.
    pub async fn acquire(pool: &DbPool) -> AppResult<Self> {
        let conn = match pool {
            DbPool::Postgres(p) => Conn::Postgres(p.acquire().await?),
            DbPool::Mysql(p) => Conn::Mysql(p.acquire().await?),
            DbPool::Sqlite(p) => Conn::Sqlite(p.acquire().await?),
            DbPool::MsSql(p) => Conn::MsSql(Box::new(p.acquire().await?)),
            DbPool::Mongo(_) => unreachable!("MongoDB is dispatched before a SQL session"),
        };
        Ok(Self { conn, in_tx: false })
    }

    /// Close the session when it drops instead of returning it to the pool —
    /// for a caller whose statements may leave state (`#temp` tables, `SET`
    /// options) that the next borrower must not inherit.
    pub fn close_on_drop(&mut self) {
        on_conn!(&mut self.conn, |c| c.close_on_drop(), |m| m.close_on_drop())
    }

    /// Run `sql` for its side effect and return the rows it affected.
    ///
    /// Through the unprepared (simple-query) protocol on every driver: the
    /// text is whatever the user or the AI wrote, binds nothing, and MySQL's
    /// prepared protocol refuses a whole family of statements a CLI client
    /// runs without complaint. Passing a bare `&str` to `Executor::execute` is
    /// what selects it on `sqlx`.
    pub async fn exec(&mut self, sql: &str) -> AppResult<u64> {
        use sqlx::Executor;
        on_conn!(
            &mut self.conn,
            |c| Ok((&mut **c).execute(sql).await?.rows_affected()),
            |m| m.simple_execute(sql).await
        )
    }

    /// Run a read and return its result sets, keeping at most `cap` rows of
    /// each.
    ///
    /// The rows past the cap are drained, never left on the wire: the session
    /// runs another statement after this one (ADR #127). A `sqlx` driver
    /// always answers with exactly one set, empty or not; SQL Server answers
    /// with the sets that carry rows, since one T-SQL statement can return
    /// several and a `SET NOCOUNT ON` returns an empty one first.
    pub async fn fetch(&mut self, sql: &str, cap: usize) -> AppResult<Vec<RowSet>> {
        use crate::db::values::{mysql_result, pg_result, sqlite_result};
        Ok(match &mut self.conn {
            Conn::Postgres(c) => vec![decoded(fetch_capped(&mut **c, sql, cap).await?, pg_result)],
            Conn::Mysql(c) => vec![decoded(
                fetch_capped(&mut **c, sql, cap).await?,
                mysql_result,
            )],
            Conn::Sqlite(c) => vec![decoded(
                fetch_capped(&mut **c, sql, cap).await?,
                sqlite_result,
            )],
            Conn::MsSql(m) => {
                let (sets, truncated) = m
                    .simple_query_sets_capped(sql, cap, Overflow::Drain)
                    .await?;
                sets.into_iter()
                    .filter(|rows| !rows.is_empty())
                    .map(|rows| {
                        let (columns, rows) = crate::db::mssql::schema::decode_rows(&rows);
                        RowSet {
                            columns,
                            rows,
                            truncated,
                        }
                    })
                    .collect()
            }
        })
    }

    /// Open a transaction with `sql` (`BEGIN`, `START TRANSACTION`,
    /// `BEGIN TRANSACTION` — the caller knows its dialect). From here until a
    /// successful [`Self::end`], dropping the session closes it.
    pub async fn begin(&mut self, sql: &str) -> AppResult<()> {
        // Marked before running: a `BEGIN` cut off mid-flight leaves the
        // server's state unknown, and unknown is treated as open.
        self.in_tx = true;
        self.exec(sql).await?;
        Ok(())
    }

    /// Close the transaction with `sql` (`COMMIT` or `ROLLBACK`). Only when it
    /// succeeds is the session trusted to go back to the pool again.
    pub async fn end(&mut self, sql: &str) -> AppResult<()> {
        self.exec(sql).await?;
        self.in_tx = false;
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.in_tx {
            self.close_on_drop();
        }
    }
}

/// What `db::values::*_result` returns: column `(name, type)` pairs and rows.
type Decoded = (Vec<(String, String)>, Vec<Vec<Value>>);

/// A `sqlx` decode's `(columns, rows)` and the fetch's truncation flag, as one
/// [`RowSet`].
fn decoded<R>((rows, truncated): (Vec<R>, bool), decode: fn(&[R]) -> Decoded) -> RowSet {
    let (columns, rows) = decode(&rows);
    RowSet {
        columns,
        rows,
        truncated,
    }
}

/// Stream `sql` and keep only the first `cap` rows, **stopping** at the first
/// row past them — see `commands::query::MAX_ADHOC_QUERY_ROWS` and ADR #127.
/// Returns `(rows, truncated)`.
///
/// What the server still has to send is not read here. A connection the
/// caller goes on using (a [`Session`]) is drained by sqlx itself before its
/// next statement, so session state survives and the cost is what draining
/// here used to be. A caller with no further use for the connection closes it
/// instead and never pays for the rest at all —
/// `commands::query::fetch_capped_alone`.
pub async fn fetch_capped<'q, 'c, DB, E>(
    executor: E,
    sql: &'q str,
    cap: usize,
) -> Result<(Vec<DB::Row>, bool), sqlx::Error>
where
    DB: sqlx::Database,
    E: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    use futures_util::TryStreamExt;
    let mut stream = sqlx::query(sql).fetch(executor);
    let mut rows = Vec::new();
    while let Some(row) = stream.try_next().await? {
        if rows.len() == cap {
            return Ok((rows, true));
        }
        rows.push(row);
    }
    Ok((rows, false))
}

/// The text a statement's failure is reported with in a batch summary.
///
/// The batch has always shown a `sqlx` failure in the driver's own words,
/// without [`AppError::Database`]'s `database error:` prefix — that prefix
/// says which layer failed, and in a list of statements every entry is the
/// database's. Everything else renders as it always has.
pub fn failure_text(e: &AppError) -> String {
    match e {
        AppError::Database(inner) => inner.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DbPool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A one-connection pool, so "the next borrower" is always the same
    /// connection unless the session closed it.
    async fn pool(name: &str) -> DbPool {
        let path = std::env::temp_dir().join(format!("huginndb_session_{name}.db"));
        let _ = std::fs::remove_file(&path);
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&p)
            .await
            .unwrap();
        DbPool::Sqlite(p)
    }

    async fn count(pool: &DbPool) -> i64 {
        let DbPool::Sqlite(p) = pool else {
            unreachable!()
        };
        sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(p)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn exec_and_fetch_share_the_session() {
        let pool = pool("shared").await;
        let mut s = Session::acquire(&pool).await.unwrap();
        s.exec("CREATE TEMP TABLE tmp (a INTEGER)").await.unwrap();
        assert_eq!(
            s.exec("INSERT INTO tmp VALUES (1), (2), (3)")
                .await
                .unwrap(),
            3
        );
        let sets = s.fetch("SELECT a FROM tmp ORDER BY a", 2).await.unwrap();
        assert_eq!(sets.len(), 1, "a sqlx driver answers with one set");
        assert_eq!(sets[0].columns[0].0, "a");
        assert_eq!(sets[0].rows.len(), 2);
        assert!(sets[0].truncated);
    }

    #[tokio::test]
    async fn an_empty_read_is_still_one_set() {
        let pool = pool("empty").await;
        let mut s = Session::acquire(&pool).await.unwrap();
        let sets = s.fetch("SELECT id FROM t", 10).await.unwrap();
        assert_eq!(sets.len(), 1);
        assert!(sets[0].rows.is_empty() && !sets[0].truncated);
    }

    #[tokio::test]
    async fn a_session_dropped_inside_a_transaction_is_closed_and_rolled_back() {
        let pool = pool("dropped").await;
        {
            let mut s = Session::acquire(&pool).await.unwrap();
            s.begin("BEGIN").await.unwrap();
            s.exec("INSERT INTO t (id) VALUES (1)").await.unwrap();
            // Dropped without `end`: as if the caller's future were cancelled.
        }
        assert_eq!(count(&pool).await, 0, "the insert must not survive");
        // And the pool's only connection is usable, not stuck in a transaction.
        let mut s = Session::acquire(&pool).await.unwrap();
        s.begin("BEGIN")
            .await
            .expect("no transaction may still be open");
        s.end("ROLLBACK").await.unwrap();
    }

    #[tokio::test]
    async fn a_committed_session_goes_back_to_the_pool() {
        let pool = pool("committed").await;
        {
            let mut s = Session::acquire(&pool).await.unwrap();
            s.exec("CREATE TEMP TABLE marker (a INTEGER)")
                .await
                .unwrap();
            s.begin("BEGIN").await.unwrap();
            s.exec("INSERT INTO t (id) VALUES (1)").await.unwrap();
            s.end("COMMIT").await.unwrap();
        }
        assert_eq!(count(&pool).await, 1);
        // The temp table is per connection: still there means it was pooled.
        let mut s = Session::acquire(&pool).await.unwrap();
        s.exec("INSERT INTO marker VALUES (1)")
            .await
            .expect("an ended session is returned, not closed");
    }

    #[test]
    fn a_batch_failure_reads_in_the_drivers_own_words() {
        let e = AppError::Database(sqlx::Error::RowNotFound);
        assert_eq!(failure_text(&e), sqlx::Error::RowNotFound.to_string());
        let other = AppError::InvalidInput("x".into());
        assert_eq!(failure_text(&other), other.to_string());
    }
}
