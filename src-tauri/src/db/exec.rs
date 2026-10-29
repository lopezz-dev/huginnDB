//! Running SQL on a [`DbPool`], whatever driver is behind it.
//!
//! [`crate::db::sql::Dialect`] owns every per-engine difference in the SQL
//! *text*. This module is its counterpart for *running* it — the piece that was
//! missing, which is why twelve call sites in `commands/` each wrote out the
//! same five-arm `match pool`, two of them byte-identical to each other.
//!
//! The arms are near-identical by construction, so there was never much to
//! choose between them: `sqlx`'s three pools share an API, and [`MsSqlPool`] was
//! deliberately built to expose the same surface (`query_all` /
//! `execute_params` / `execute_simple` / `scalar`), so its arm here is one line
//! in every function. What the duplication actually cost was the guarantee: a
//! new engine had to be threaded through twelve bodies, and a `_ =>` in any one
//! of them would have silently given it Postgres's behaviour (ADR #30).
//!
//! **MongoDB never reaches these functions.** It is not a SQL dialect; every
//! command dispatches it to [`crate::db::mongo`] before any SQL is built. A
//! `DbPool::Mongo` here is a programming error, and the `unreachable!` arms say
//! so rather than inventing a fallback — matching what the individual call sites
//! already did.
//!
//! Values cross as `Option<String>` end-to-end (ADR #5): the cell editor only
//! ever emits text and the drivers cast textual literals server-side. Anything
//! needing a per-driver cast around the placeholder (a MySQL `BIT`, a SQL Server
//! `varbinary`) builds that into the SQL *before* getting here.

use crate::error::{AppError, AppResult};
use crate::state::DbPool;

/// Bind `binds` positionally and run `sql`, on whichever pool this is.
///
/// Expands to the same `sqlx::query(...).bind(...).execute(...)` chain per pool
/// type. A macro rather than a generic function because `sqlx::query` returns a
/// different `Query<'_, DB, _>` for each database, and the three are not related
/// by a trait we can name here.
macro_rules! bind_all {
    ($sql:expr, $binds:expr, $pool:expr) => {{
        let mut q = sqlx::query($sql);
        for b in $binds {
            q = q.bind(b);
        }
        q
    }};
}

/// [`bind_all`] for the `query_scalar` flavour. A macro for the same reason, and
/// not a generic function: `query_scalar`'s bounds have to be discharged against
/// a concrete `Database`, and naming them all at a generic signature is more
/// code than the three lines it would save.
macro_rules! bind_all_scalar {
    ($sql:expr, $binds:expr) => {{
        let mut q = sqlx::query_scalar::<_, i64>($sql);
        for b in $binds {
            q = q.bind(b);
        }
        q
    }};
}

/// One lightweight liveness round-trip, on whichever pool this is.
///
/// The exception to the "no MongoDB here" rule above, and deliberately so: a
/// ping is not SQL, every driver has one, and the alternative was what the
/// tree actually had — [`crate::keepalive`]'s 3-minute heartbeat and
/// [`crate::db::pool`]'s connect probe each enumerating all five drivers, with
/// the probe's Mongo and SQL Server arms contorted into early returns because
/// they report through [`AppError`] rather than `sqlx::Error`. One function
/// erases that split: the probe's own job (close the pool afterwards) is the
/// only thing left at its call site.
pub async fn ping(pool: &DbPool) -> AppResult<()> {
    match pool {
        DbPool::Postgres(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mysql(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Sqlite(p) => sqlx::query("SELECT 1").execute(p).await.map(|_| ())?,
        DbPool::Mongo(conn) => crate::db::mongo::schema::ping(conn).await?,
        // Runs `SELECT 1` on a pooled session; a dead session is discarded by
        // the pool rather than handed to the next caller (see `db::mssql`).
        DbPool::MsSql(p) => p.ping().await?,
    };
    Ok(())
}

/// Run a parameterless statement, returning rows affected.
///
/// For DDL and other statements with no user values to bind — `TRUNCATE`,
/// `DROP TABLE`, `CREATE DATABASE`, a `sp_rename`. Identifiers in `sql` must
/// already be quoted through [`crate::db::sql::Dialect::quote_ident`] (and any
/// user-entered name validated first — see [`crate::db::ddl::validate_ident`]),
/// because DDL cannot bind an identifier as a parameter.
pub async fn execute(pool: &DbPool, sql: &str) -> AppResult<u64> {
    match pool {
        DbPool::Postgres(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Mysql(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Sqlite(p) => sqlx::query(sql)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.execute_simple(sql).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run a parameterised write, returning rows affected.
pub async fn execute_params(pool: &DbPool, sql: &str, binds: &[Option<String>]) -> AppResult<u64> {
    match pool {
        DbPool::Postgres(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all!(sql, binds, p)
            .execute(p)
            .await
            .map(|r| r.rows_affected())
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.execute_params(sql, binds).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run an ordered list of parameterised writes as one transaction, returning
/// the rows each one affected.
///
/// The counterpart of [`execute_all`] for statements that carry binds, and the
/// reason it cannot be a loop over [`execute_params`]: every batch has to land
/// on the **same connection inside the same transaction**, or a chunked
/// multi-row insert becomes atomic per chunk instead of per paste — which is
/// the one property the caller asked for.
///
/// `in_tx_expect_at_most_one` cannot be reused for this despite the shape: it
/// takes one statement, and it *rolls back* whenever more than one row is
/// affected, which is the exact opposite of what a bulk insert wants.
///
/// The three `sqlx` pools lean on `Transaction`'s rollback-on-drop, so a `?`
/// mid-list unwinds without an explicit branch. SQL Server takes a visibly
/// different arm for the reason ADR #31 gives — `tiberius` has no
/// transaction handle, so the boundaries are statements on a held session —
/// and it acquires **once**: `execute_params` takes a connection per call, so
/// building the loop out of it would scatter the chunks across sessions and
/// silently lose the transaction this function exists to provide.
///
/// One caveat the caller inherits: on MySQL the atomicity is only as real as
/// the table's storage engine. InnoDB honours it; MyISAM commits per statement
/// and there is nothing this function can do about that.
pub async fn execute_params_in_tx(
    pool: &DbPool,
    batches: &[(String, Vec<Option<String>>)],
) -> AppResult<Vec<u64>> {
    execute_params_in_tx_checked(pool, batches, |_, _| None).await
}

/// [`execute_params_in_tx`], refusing to commit when a statement touched more
/// than one row — the multi-cell paste (`commands::paste`), where every
/// statement addresses one row by its full key or inserts one row, and a
/// second row touched means the key was not one: the same assertion
/// [`in_tx_expect_at_most_one`] makes for a single cell, kept across a whole
/// list. `what` names the caller in the refusal.
pub async fn execute_params_in_tx_at_most_one(
    pool: &DbPool,
    batches: &[(String, Vec<Option<String>>)],
    what: &str,
) -> AppResult<Vec<u64>> {
    execute_params_in_tx_checked(pool, batches, |i, n| {
        (n > 1).then(|| {
            format!(
                "{what}: statement {} touched {n} rows instead of one (is the primary key \
                 complete?) — the transaction was rolled back, nothing was changed",
                i + 1
            )
        })
    })
    .await
}

/// The loop behind both: `check(index, rows_affected)` returning a reason
/// rolls the whole list back with it.
async fn execute_params_in_tx_checked(
    pool: &DbPool,
    batches: &[(String, Vec<Option<String>>)],
    check: impl Fn(usize, u64) -> Option<String>,
) -> AppResult<Vec<u64>> {
    if batches.is_empty() {
        return Ok(Vec::new());
    }

    macro_rules! sqlx_tx_all {
        ($p:expr) => {{
            let mut tx = $p.begin().await?;
            let mut affected = Vec::with_capacity(batches.len());
            for (i, (sql, binds)) in batches.iter().enumerate() {
                let n = bind_all!(sql.as_str(), binds, $p)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
                if let Some(reason) = check(i, n) {
                    // Dropping `tx` rolls it back.
                    return Err(AppError::InvalidInput(reason));
                }
                affected.push(n);
            }
            tx.commit().await?;
            Ok(affected)
        }};
    }

    match pool {
        DbPool::Postgres(p) => sqlx_tx_all!(p),
        DbPool::Mysql(p) => sqlx_tx_all!(p),
        DbPool::Sqlite(p) => sqlx_tx_all!(p),
        DbPool::MsSql(p) => {
            let mut c = p.acquire().await?;
            c.simple_execute("BEGIN TRANSACTION").await?;
            let mut affected = Vec::with_capacity(batches.len());
            for (i, (sql, binds)) in batches.iter().enumerate() {
                let refusal = match c.execute(sql, binds).await {
                    Ok(n) => match check(i, n) {
                        None => {
                            affected.push(n);
                            continue;
                        }
                        Some(reason) => AppError::InvalidInput(reason),
                    },
                    Err(e) => e,
                };
                // Best-effort unwind: if the rollback also fails the session
                // is already poisoned and `classify` will not return it to
                // the pool.
                let _ = c.simple_execute("ROLLBACK TRANSACTION").await;
                return Err(refusal);
            }
            c.simple_execute("COMMIT TRANSACTION").await?;
            Ok(affected)
        }
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run one parameterised write inside a transaction, refusing to commit if it
/// touched more than one row.
///
/// `what` names the caller in the refusal message (`"update_cell"`).
///
/// This is a belt-and-braces assertion, not a routine check: with a correctly
/// introspected `PRIMARY KEY` in the `WHERE` clause, more than one match is
/// impossible. It exists because the cell-save path once *did* corrupt data
/// silently — on a composite-PK table it sent only the first PK column, so the
/// UPDATE matched every row sharing that value and the user saw one cell change.
/// A rollback plus a loud error is what turns that family of bug from silent
/// corruption into a visible refusal.
///
/// SQL Server takes a visibly different arm on purpose (ADR #31): `tiberius`
/// has no transaction handle, so `BEGIN`/`COMMIT`/`ROLLBACK` are statements
/// issued on one held session rather than calls on a transaction object. That is
/// also why it cannot use the pool's one-shot helpers here.
pub async fn in_tx_expect_at_most_one(
    pool: &DbPool,
    sql: &str,
    binds: &[Option<String>],
    what: &str,
) -> AppResult<u64> {
    let too_many = |affected: u64| {
        AppError::InvalidInput(format!(
            "{what} refused: {affected} rows matched the supplied \
             primary key (composite PK incomplete?) — transaction rolled back"
        ))
    };

    macro_rules! sqlx_tx {
        ($p:expr) => {{
            let mut tx = $p.begin().await?;
            let affected = bind_all!(sql, binds, $p)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if affected > 1 {
                tx.rollback().await?;
                return Err(too_many(affected));
            }
            tx.commit().await?;
            Ok(affected)
        }};
    }

    match pool {
        DbPool::Postgres(p) => sqlx_tx!(p),
        DbPool::Mysql(p) => sqlx_tx!(p),
        DbPool::Sqlite(p) => sqlx_tx!(p),
        DbPool::MsSql(p) => {
            let mut c = p.acquire().await?;
            c.simple_execute("BEGIN TRANSACTION").await?;
            let affected = match c.execute(sql, binds).await {
                Ok(n) => n,
                Err(e) => {
                    // Best-effort unwind: if the rollback also fails the session
                    // is already poisoned and `classify` will not return it.
                    let _ = c.simple_execute("ROLLBACK TRANSACTION").await;
                    return Err(e);
                }
            };
            if affected > 1 {
                c.simple_execute("ROLLBACK TRANSACTION").await?;
                return Err(too_many(affected));
            }
            c.simple_execute("COMMIT TRANSACTION").await?;
            Ok(affected)
        }
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run an ordered list of DDL statements under this engine's transaction policy.
///
/// The policy is the whole reason this is not a loop over [`execute`], and it
/// differs per engine in a way that is a fact about the engine, not a choice:
///
/// * **Postgres** has transactional DDL, so the batch is wrapped. A failure
///   halfway through rolls back, and the table is never left half-altered.
/// * **MySQL** does not: every DDL statement carries an implicit commit, so
///   wrapping would be a lie. Statements run in order and a mid-sequence
///   failure can leave partial changes — surfaced by the error, after which the
///   editor re-reads the structure.
/// * **SQLite** *has* transactional DDL, but the 12-step table rebuild
///   `db::ddl::build_sqlite_rebuild` emits toggles `PRAGMA foreign_keys` around
///   the work, and that pragma is a no-op inside a transaction. So the list
///   manages its own boundaries and must be run verbatim.
/// * **SQL Server** has transactional DDL too — `sp_rename` included — so the
///   batch is wrapped, on one pinned session. `XACT_ABORT` makes any error
///   doom the transaction rather than leave it open around a half-applied
///   change. Each statement goes as a plain SQL batch (`simple_query_sets`),
///   not through `sp_executesql`: a transaction opened or closed inside an RPC
///   call trips SQL Server's "transaction count after EXECUTE" check (error
///   266), and several statements here `DECLARE` a variable, which is local to
///   its batch. The session is closed afterwards rather than pooled, so a
///   failure can never hand the next borrower an open transaction.
pub async fn execute_all(pool: &DbPool, statements: &[String]) -> AppResult<()> {
    match pool {
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            for stmt in statements {
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            for stmt in statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::Sqlite(p) => {
            for stmt in statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::MsSql(p) => {
            let mut c = p.acquire().await?;
            c.close_on_drop();
            c.simple_query_sets("SET XACT_ABORT ON; BEGIN TRANSACTION")
                .await?;
            for stmt in statements {
                if let Err(e) = c.simple_query_sets(stmt).await {
                    // Best effort: with XACT_ABORT the server has usually rolled
                    // back already, and the session is closed either way.
                    let _ = c
                        .simple_query_sets("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION")
                        .await;
                    return Err(e);
                }
            }
            c.simple_query_sets("COMMIT TRANSACTION").await?;
        }
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
    Ok(())
}

/// Run a parameterised read, returning `(columns, rows)`.
///
/// Columns come back as untyped `(name, type_name)` pairs rather than a
/// `ColumnMeta`: that DTO lives in `commands::query`, and `db/` must not depend
/// upward on `commands/`. `db::mssql::schema::decode_rows` already returned this
/// shape for the same reason, so one signature covers all four drivers and the
/// caller maps into whatever it serialises.
pub async fn query_rows(
    pool: &DbPool,
    sql: &str,
    binds: &[Option<String>],
) -> AppResult<(Vec<(String, String)>, Vec<Vec<serde_json::Value>>)> {
    use crate::db::values;
    match pool {
        DbPool::Postgres(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::pg_result(&rows))
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::mysql_result(&rows))
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all!(sql, binds, p)
            .fetch_all(p)
            .await
            .map(|rows| values::sqlite_result(&rows))
            .map_err(AppError::from),
        DbPool::MsSql(p) => p
            .query_all(sql, binds)
            .await
            .map(|rows| crate::db::mssql::schema::decode_rows(&rows)),
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

/// Run a parameterised query expected to yield a single `i64` — a `COUNT(*)`,
/// a `last_insert_id`, an estimated row count.
///
/// `None` when the query returned no row at all, which callers treat as "no
/// answer available" rather than zero: an estimate that is missing and an
/// estimate of nothing are different facts.
pub async fn scalar_i64(
    pool: &DbPool,
    sql: &str,
    binds: &[Option<String>],
) -> AppResult<Option<i64>> {
    match pool {
        DbPool::Postgres(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::Mysql(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::Sqlite(p) => bind_all_scalar!(sql, binds)
            .fetch_optional(p)
            .await
            .map_err(AppError::from),
        DbPool::MsSql(p) => p.scalar(sql, binds).await,
        DbPool::Mongo(_) => unreachable!("MongoDB is dispatched to db::mongo before any SQL"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A file-backed pool rather than `sqlite::memory:`, for the reason
    /// `mcp::tests` gives: an in-memory database is per-connection, so the
    /// schema would not be shared across the pool.
    async fn sqlite_pool(name: &str) -> DbPool {
        let path = std::env::temp_dir().join(format!("huginndb_exec_tx_{name}.db"));
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
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        DbPool::Sqlite(pool)
    }

    async fn count(pool: &DbPool) -> i64 {
        scalar_i64(pool, "SELECT COUNT(*) FROM t", &[])
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn every_batch_lands_and_the_affected_counts_come_back_in_order() {
        let pool = sqlite_pool("all").await;
        let batches = vec![
            (
                "INSERT INTO t (name) VALUES (?), (?)".to_string(),
                vec![Some("a".to_string()), Some("b".to_string())],
            ),
            (
                "INSERT INTO t (name) VALUES (?)".to_string(),
                vec![Some("c".to_string())],
            ),
            (
                "INSERT INTO t (name) VALUES (?), (?)".to_string(),
                vec![Some("d".to_string()), Some("e".to_string())],
            ),
        ];
        let affected = execute_params_in_tx(&pool, &batches).await.unwrap();
        assert_eq!(affected, vec![2u64, 1, 2]);
        assert_eq!(count(&pool).await, 5);
    }

    /// The property the whole function exists for: a chunked paste is atomic
    /// per *paste*, not per chunk. A loop over `execute_params` would leave the
    /// first two batches committed here.
    #[tokio::test]
    async fn a_failure_midway_leaves_nothing_behind() {
        let pool = sqlite_pool("rollback").await;
        let batches = vec![
            (
                "INSERT INTO t (name) VALUES (?)".to_string(),
                vec![Some("a".to_string())],
            ),
            (
                "INSERT INTO t (name) VALUES (?)".to_string(),
                vec![Some("b".to_string())],
            ),
            // NOT NULL violation.
            ("INSERT INTO t (name) VALUES (?)".to_string(), vec![None]),
        ];
        assert!(execute_params_in_tx(&pool, &batches).await.is_err());
        assert_eq!(count(&pool).await, 0);
    }

    /// The multi-cell paste's promise: a statement that touches a second row
    /// means its key was not one, and nothing of the list may stay — the
    /// statements before it included.
    #[tokio::test]
    async fn a_statement_touching_two_rows_rolls_the_whole_list_back() {
        let pool = sqlite_pool("at_most_one").await;
        execute_params_in_tx(
            &pool,
            &[(
                "INSERT INTO t (name) VALUES (?), (?)".to_string(),
                vec![Some("a".to_string()), Some("a".to_string())],
            )],
        )
        .await
        .unwrap();
        let batches = vec![
            (
                "INSERT INTO t (name) VALUES (?)".to_string(),
                vec![Some("b".to_string())],
            ),
            // `name` is not a key: two rows match.
            (
                "UPDATE t SET name = ? WHERE name = ?".to_string(),
                vec![Some("z".to_string()), Some("a".to_string())],
            ),
        ];
        let err = execute_params_in_tx_at_most_one(&pool, &batches, "paste")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("statement 2 touched 2 rows"), "{err}");
        assert_eq!(count(&pool).await, 2, "the insert before it was undone");
        assert_eq!(
            scalar_i64(&pool, "SELECT COUNT(*) FROM t WHERE name = 'z'", &[])
                .await
                .unwrap(),
            Some(0)
        );

        // One row per statement commits, and the counts come back in order.
        let ok = vec![
            (
                "UPDATE t SET name = ? WHERE id = ?".to_string(),
                vec![Some("y".to_string()), Some("1".to_string())],
            ),
            (
                "INSERT INTO t (name) VALUES (?)".to_string(),
                vec![Some("c".to_string())],
            ),
        ];
        assert_eq!(
            execute_params_in_tx_at_most_one(&pool, &ok, "paste")
                .await
                .unwrap(),
            vec![1, 1]
        );
        assert_eq!(count(&pool).await, 3);
    }

    #[tokio::test]
    async fn an_empty_batch_list_is_a_no_op() {
        let pool = sqlite_pool("empty").await;
        assert_eq!(
            execute_params_in_tx(&pool, &[]).await.unwrap(),
            Vec::<u64>::new()
        );
        assert_eq!(count(&pool).await, 0);
    }
}
