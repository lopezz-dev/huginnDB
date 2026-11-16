//! "Everything, from the server…": a read the person ran, run again and every
//! row of it streamed to a file (ADR #137).
//!
//! Offered by the query tab only where the grid cannot be exported whole —
//! a result cut at the row cap (ADR #127). So this is the one path that reads
//! an ad-hoc statement **without** the cap, and it never holds the rows: each
//! one is decoded and handed to the [`RowWriter`] as it arrives, and the
//! writer is the file's `BufWriter`.
//!
//! **Reads only.** The statement must be a read by its class (`db::classify`,
//! ADR #54) and fetchable (`is_read_only`), and it runs inside ADR #93's
//! read-only barrier as an AI's read does: a read-only transaction on
//! PostgreSQL and MySQL, `PRAGMA query_only` on SQLite. A write the text
//! classifier missed then fails on the server instead of running a second
//! time, unseen, behind an export. SQL Server has no such mode and relies on
//! the classifier, as `super::bounded` does. MongoDB is refused: its
//! statements run through `db::mongo::query`, which shapes a whole result and
//! has no row-by-row path yet.
//!
//! The command, its policy checks and the save dialog are
//! `commands::dump::export_query_rows`.

use std::io::Write;

use futures_util::TryStreamExt;
use sqlx::pool::PoolConnection;
use sqlx::{Column as _, Executor as _, Row as _};

use crate::db::result_export::RowWriter;
use crate::db::sql::{is_read_only, StmtClass};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};

/// Refuse a statement that is not a read before anything runs or any file is
/// created.
pub(crate) fn check_exportable(pool: &DbPool, sql: &str) -> AppResult<()> {
    if matches!(pool, DbPool::Mongo(_)) {
        return Err(AppError::UnsupportedDriver(
            "exporting every row from the server is not available for MongoDB yet; export the \
             rows shown instead"
                .into(),
        ));
    }
    if !is_read_only(sql) || crate::db::classify::classify_statement(sql) != StmtClass::Read {
        return Err(AppError::InvalidInput(
            "only a read can be exported from the server: this statement changes data or \
             schema, and exporting it would run it again"
                .into(),
        ));
    }
    Ok(())
}

/// Run `sql` on `connection_id` and write every row of it with `writer`.
/// Returns the output and how many rows were written.
pub(crate) async fn export_rows_inner<W: Write>(
    state: &AppState,
    connection_id: &str,
    sql: &str,
    mut writer: RowWriter<W>,
) -> AppResult<(W, u64)> {
    let pool = state.pool_for(connection_id)?;
    check_exportable(&pool, sql)?;
    stream_read_only(&pool, sql, &mut writer).await?;
    writer.finish()
}

/// The barrier and the stream, per driver.
async fn stream_read_only<W: Write>(
    pool: &DbPool,
    sql: &str,
    writer: &mut RowWriter<W>,
) -> AppResult<()> {
    use crate::db::values::{
        mysql_columns, mysql_value, pg_columns, pg_value, sqlite_columns, sqlite_value,
    };
    match pool {
        DbPool::Postgres(p) => {
            let conn = p.acquire().await?;
            barrier(
                conn,
                "BEGIN READ ONLY",
                "ROLLBACK",
                sql,
                writer,
                pg_columns,
                pg_value,
            )
            .await
        }
        DbPool::Mysql(p) => {
            let conn = p.acquire().await?;
            barrier(
                conn,
                "START TRANSACTION READ ONLY",
                "ROLLBACK",
                sql,
                writer,
                mysql_columns,
                mysql_value,
            )
            .await
        }
        DbPool::Sqlite(p) => {
            let conn = p.acquire().await?;
            barrier(
                conn,
                "PRAGMA query_only = ON",
                "PRAGMA query_only = OFF",
                sql,
                writer,
                sqlite_columns,
                sqlite_value,
            )
            .await
        }
        DbPool::MsSql(p) => {
            let mut client = p.acquire().await?;
            let names = client
                .simple_query_each(sql, |row| {
                    if !writer.has_begun() {
                        writer.begin(
                            crate::db::mssql::values::mssql_columns(row)
                                .into_iter()
                                .map(|(name, _)| name)
                                .collect(),
                        )?;
                    }
                    let values: Vec<_> = (0..row.columns().len())
                        .map(|i| crate::db::mssql::values::mssql_value(row, i))
                        .collect();
                    writer.row(&values)
                })
                .await?;
            if !writer.has_begun() {
                writer.begin(names)?;
            }
            Ok(())
        }
        DbPool::Mongo(_) => unreachable!("refused by check_exportable"),
    }
}

/// Enter the barrier with `enter`, stream, and leave it with `leave`. The
/// session goes back to the pool only once it has left the barrier: a failed
/// `leave` closes it, and a stream that failed mid-way (the file, the server)
/// detaches it, since it may still be mid-response.
async fn barrier<DB, W: Write>(
    mut conn: PoolConnection<DB>,
    enter: &str,
    leave: &str,
    sql: &str,
    writer: &mut RowWriter<W>,
    columns: fn(&DB::Row) -> Vec<(String, String)>,
    value: fn(&DB::Row, usize) -> serde_json::Value,
) -> AppResult<()>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    (&mut *conn).execute(enter).await?;
    let streamed = stream(&mut conn, sql, writer, columns, value).await;
    if streamed.is_err() {
        drop(conn.detach());
        return streamed;
    }
    if (&mut *conn).execute(leave).await.is_err() {
        conn.close_on_drop();
    }
    streamed
}

/// Every row of `sql`, one at a time. An empty result still gets its header,
/// from the statement's description, since there is no row to read it from.
async fn stream<DB, W: Write>(
    conn: &mut DB::Connection,
    sql: &str,
    writer: &mut RowWriter<W>,
    columns: fn(&DB::Row) -> Vec<(String, String)>,
    value: fn(&DB::Row, usize) -> serde_json::Value,
) -> AppResult<()>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    {
        let mut rows = sqlx::query(sql).fetch(&mut *conn);
        while let Some(row) = rows.try_next().await? {
            if !writer.has_begun() {
                writer.begin(columns(&row).into_iter().map(|(name, _)| name).collect())?;
            }
            let values: Vec<_> = (0..row.columns().len()).map(|i| value(&row, i)).collect();
            writer.row(&values)?;
        }
    }
    if !writer.has_begun() {
        let described = (&mut *conn).describe(sql).await?;
        writer.begin(
            described
                .columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect(),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::result_export::{ResultFormat, SqlExportTarget};
    use crate::db::sql::Dialect;
    use crate::state::ActivePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// One connection, so the test sees the very connection the export used
    /// when it checks that `query_only` was switched back off.
    async fn state(name: &str) -> (AppState, sqlx::SqlitePool) {
        let path = std::env::temp_dir().join(format!("huginndb_export_rows_{name}.db"));
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
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')")
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

    fn csv() -> RowWriter<Vec<u8>> {
        RowWriter::new(Vec::new(), ResultFormat::Csv, Dialect::Sqlite, None).unwrap()
    }

    async fn rows_in_t(pool: &sqlx::SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM t")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Past the ad-hoc cap: every row reaches the file, which is the reason
    /// this path exists.
    #[tokio::test]
    async fn more_than_the_row_cap_reaches_the_file() {
        let (state, _pool) = state("many").await;
        let n = crate::commands::query::MAX_ADHOC_QUERY_ROWS + 1_000;
        let sql = format!(
            "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < {n}) \
             SELECT i FROM s"
        );
        let (out, rows) = export_rows_inner(&state, "c", &sql, csv()).await.unwrap();
        assert_eq!(rows as usize, n);
        let text = String::from_utf8(out).unwrap();
        // The header, then one line per row.
        assert_eq!(text.matches("\r\n").count(), n + 1);
        assert!(text.ends_with(&format!("\r\n{n}\r\n")));
    }

    #[tokio::test]
    async fn a_write_is_refused_before_it_runs() {
        let (state, pool) = state("write").await;
        for sql in [
            "DELETE FROM t",
            "UPDATE t SET name = 'x'",
            "WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d",
            "DROP TABLE t",
        ] {
            let err = export_rows_inner(&state, "c", sql, csv())
                .await
                .unwrap_err();
            assert!(err.to_string().contains("only a read"), "{sql}: {err}");
        }
        assert_eq!(rows_in_t(&pool).await, 2, "nothing ran");
    }

    /// The barrier itself, for a write that reached it — as if the classifier
    /// had let it through: SQLite refuses it, and the pool's one connection
    /// comes back writable.
    #[tokio::test]
    async fn the_barrier_refuses_a_write_that_reaches_it_and_comes_off() {
        let (state, pool) = state("barrier").await;
        let DbPool::Sqlite(_) = state.pool_for("c").unwrap() else {
            unreachable!()
        };
        let mut w = csv();
        let err = stream_read_only(
            &state.pool_for("c").unwrap(),
            "DELETE FROM t RETURNING id",
            &mut w,
        )
        .await;
        assert!(err.is_err(), "query_only must refuse the delete");
        assert_eq!(rows_in_t(&pool).await, 2);

        let (_, rows) = export_rows_inner(&state, "c", "SELECT id FROM t", csv())
            .await
            .unwrap();
        assert_eq!(rows, 2);
        sqlx::query("INSERT INTO t (id, name) VALUES (3, 'c')")
            .execute(&pool)
            .await
            .expect("the person's next write must not inherit query_only");
    }

    /// An empty result still writes its header, read from the statement.
    #[tokio::test]
    async fn an_empty_result_still_has_its_header() {
        let (state, _pool) = state("empty").await;
        let (out, rows) = export_rows_inner(&state, "c", "SELECT id, name FROM t WHERE 0", csv())
            .await
            .unwrap();
        assert_eq!(rows, 0);
        assert_eq!(String::from_utf8(out).unwrap(), "\u{FEFF}id,name\r\n");
    }

    #[tokio::test]
    async fn a_sql_export_inserts_into_the_target() {
        let (state, _pool) = state("sql").await;
        let target = SqlExportTarget {
            table: "t".into(),
            columns: vec![Some("id".into()), None],
        };
        let w =
            RowWriter::new(Vec::new(), ResultFormat::Sql, Dialect::Sqlite, Some(target)).unwrap();
        let (out, _) = export_rows_inner(&state, "c", "SELECT id, id * 2 AS twice FROM t", w)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "INSERT INTO \"t\" (\"id\") VALUES (1);\nINSERT INTO \"t\" (\"id\") VALUES (2);\n"
        );
    }
}
