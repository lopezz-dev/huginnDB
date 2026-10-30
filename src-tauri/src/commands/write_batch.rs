//! A list of row writes run as one transaction — the executor behind the MCP
//! connector's `run_writes` tool.
//!
//! # Why it exists
//!
//! An agent changing a handful of rows used to spend one `run_write` per row
//! and then re-read each row to check the write had landed: a model turn per
//! statement, each one paying again for the whole conversation so far. That is
//! what an agent driving UI tests against a configuration table did, and it is
//! where the tokens went. `run_writes` takes the whole list in one call and
//! leaves the database with either all of it applied or none of it, so there is
//! nothing half-done to go and inspect.
//!
//! # The promise, and what keeps it
//!
//! * **One session, one transaction.** A [`Session`] held for the whole list,
//!   with the transaction opened by [`Session::begin`]. A session dropped
//!   before its transaction ended — any early return, a failed `ROLLBACK`, the
//!   caller's future cancelled between two writes — is closed rather than
//!   pooled, so the server rolls back and every path unwinds. The same on all
//!   four drivers: `sqlx::Transaction` gave PostgreSQL, MySQL and SQLite that
//!   guarantee, and SQL Server's `BEGIN`/`COMMIT TRANSACTION` statements on a
//!   held session (ADR #31) did not have it between two writes.
//! * **Row writes only.** DDL is refused: MySQL commits implicitly around every
//!   schema change, so a list carrying one could not be atomic there whatever
//!   this code did. A schema change goes through `run_write`, on its own.
//! * **No transaction control in the list.** A `COMMIT` among the writes would
//!   make everything before it permanent. [`check_writes`] runs here, on the side
//!   that executes, and not only in the sidecar that sent the list.
//! * **One statement per entry**, so that check sees every statement.
//! * **No MySQL executable comments.** `/*! … */` is a comment to every
//!   classifier here and code to MySQL, so `/*! COMMIT */` would slip a
//!   `COMMIT` past the check above.
//! * **`expect_rows`** turns "the `UPDATE` matched nothing" — the usual reason an
//!   agent re-reads — into a rollback and a message saying which write and how
//!   many rows it did touch.
//!
//! MongoDB is the exception. A multi-document transaction needs a replica set,
//! and the shell grammar runs each statement on its own, so there the writes run
//! in order and stop at the first failure, the reply says `atomic: false`, and an
//! error says which writes had already been applied.
//!
//! On MySQL the atomicity is only as real as the table's storage engine: InnoDB
//! honours it, MyISAM commits every statement.

use crate::db::session::{failure_text, Session};
use crate::db::sql::{StmtClass, Verbs};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink, SqlLog};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Most writes one call may carry.
///
/// A bound on how long one transaction holds its locks on the user's server,
/// more than on the size of the request: fifty row writes is more than any
/// configuration change needs, and a model that wants more is better told to
/// split them than allowed to hold a transaction open for a bulk load.
pub const MAX_WRITES: usize = 50;

/// One write in a batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchWrite {
    /// One `INSERT` / `UPDATE` / `DELETE`, or a MongoDB insert, update, replace
    /// or delete.
    pub sql: String,
    /// The number of rows this write has to affect. Any other count rolls the
    /// whole batch back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_rows: Option<u64>,
}

/// What a batch that went through reports.
///
/// A batch that did not go through is an error instead, never a reply with a
/// flag in it: the sidecar's audit line is written from whether the call
/// failed, and a rolled-back batch recorded as `ok` would be a lie in the one
/// file that exists to tell the truth about writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteBatchResult {
    /// `true` when the writes ran inside one transaction. `false` only on
    /// MongoDB.
    pub atomic: bool,
    /// Rows each write affected, in order.
    pub rows_affected: Vec<u64>,
    pub total_affected: u64,
}

/// Everything a batch does, for the policy checks: the union over its writes,
/// through the same classifier `run_write` uses.
///
/// An empty list needs every row write, for the reason
/// [`crate::db::sql::verbs`] gives for empty text — the executor refuses it
/// anyway, and an authorisation answer must not be the permissive one because
/// the input was degenerate.
pub fn verbs_of_writes(writes: &[BatchWrite]) -> Verbs {
    if writes.is_empty() {
        return Verbs::WRITES;
    }
    writes
        .iter()
        .map(|w| crate::db::classify::verbs_of(&w.sql))
        .fold(Verbs::NONE, |all, one| all | one)
}

/// Refuse a list the transaction could not keep its promise for.
///
/// Each refusal names the entry and the fix, because it is read by a model at
/// the moment it decides what to do next (gotcha #74): a message that only says
/// "invalid" produces a retry of the same list.
pub fn check_writes(writes: &[BatchWrite]) -> AppResult<()> {
    if writes.is_empty() {
        return Err(AppError::InvalidInput(
            "run_writes needs at least one write".into(),
        ));
    }
    if writes.len() > MAX_WRITES {
        return Err(AppError::InvalidInput(format!(
            "run_writes takes at most {MAX_WRITES} writes per call ({} given). Split them \
             into several calls.",
            writes.len()
        )));
    }
    for (i, write) in writes.iter().enumerate() {
        let sql = write.sql.trim();
        let parts = crate::db::sql::split_statements(sql);
        if parts.is_empty() {
            return Err(AppError::InvalidInput(format!("writes[{i}] is empty")));
        }
        if parts.len() > 1 {
            return Err(AppError::InvalidInput(format!(
                "writes[{i}] holds {} statements. Give each statement its own entry.",
                parts.len()
            )));
        }
        // `/*!` is MySQL's, `/*M!` MariaDB's. Anywhere in the entry, not only
        // in front: the text inside runs, and the classifiers never read it.
        if sql.contains("/*!") || sql.contains("/*M!") {
            return Err(AppError::InvalidInput(format!(
                "writes[{i}] holds a MySQL executable comment (`/*! … */`), which runs as \
                 code but is invisible to the checks run_writes makes. Write it out plainly."
            )));
        }
        if crate::db::sql::is_session_statement(sql) {
            return Err(AppError::InvalidInput(format!(
                "writes[{i}] is transaction or session control. run_writes opens and commits \
                 the transaction itself — leave it out."
            )));
        }
        match crate::db::classify::classify_statement(sql) {
            StmtClass::DataWrite => {}
            StmtClass::Read => {
                return Err(AppError::InvalidInput(format!(
                    "writes[{i}] only reads. Put it in `verify`, which runs after the commit, \
                     or use run_query."
                )));
            }
            StmtClass::Ddl => {
                return Err(AppError::InvalidInput(format!(
                    "writes[{i}] changes the schema. run_writes takes row writes only — MySQL \
                     commits around every schema change, so the batch could not be atomic. \
                     Run it on its own with run_write."
                )));
            }
        }
        if crate::db::classify::is_unfiltered_write(sql) {
            return Err(AppError::InvalidInput(format!(
                "writes[{i}] is an UPDATE/DELETE with no predicate. Add one — `WHERE 1=1` on \
                 SQL, or `{{_id: {{$exists: true}}}}` on MongoDB, if you really mean every row."
            )));
        }
    }
    Ok(())
}

/// The refusal for a write whose row count is not the one it promised, or
/// `None` when it kept its promise or made none.
fn missed_expectation(index: usize, write: &BatchWrite, affected: u64) -> Option<String> {
    match write.expect_rows {
        Some(expected) if expected != affected => Some(format!(
            "writes[{index}] affected {affected} rows, expected {expected}"
        )),
        _ => None,
    }
}

const ROLLED_BACK: &str = "The transaction was rolled back; nothing was changed.";

/// Run `writes` against `connection_id` as one transaction.
///
/// `sink` gets one entry per statement as it runs, then a closing `COMMIT` or
/// `ROLLBACK` entry — so `mcp-audit.log` never shows a row count for a write
/// without also showing whether it stayed.
pub(crate) async fn execute_write_batch_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    writes: &[BatchWrite],
) -> AppResult<WriteBatchResult> {
    check_writes(writes)?;
    let pool = state.pool_for(connection_id)?;
    let driver = pool.driver_name();
    let batch_start = Instant::now();

    let closing = |sql: &str, error: Option<&str>| {
        log_sql_sink(sink, connection_id, driver, sql, batch_start, None, error);
    };

    if let DbPool::Mongo(conn) = &pool {
        return execute_mongo(sink, conn, connection_id, driver, writes).await;
    }
    // The statements `sqlx::Transaction` sent for the three `sqlx` drivers,
    // and the ones this path always sent for SQL Server.
    let (begin, commit, rollback) = match pool {
        DbPool::MsSql(_) => (
            "BEGIN TRANSACTION",
            "COMMIT TRANSACTION",
            "ROLLBACK TRANSACTION",
        ),
        _ => ("BEGIN", "COMMIT", "ROLLBACK"),
    };

    let mut session = Session::acquire(&pool).await?;
    session.begin(begin).await?;
    let log = SqlLog::new(sink, connection_id, driver);
    let mut affected = Vec::with_capacity(writes.len());
    for (i, write) in writes.iter().enumerate() {
        let sql = write.sql.trim();
        let start = Instant::now();
        let failure = match session.exec(sql).await {
            Ok(n) => {
                log.ok(sql, start, n);
                affected.push(n);
                missed_expectation(i, write, n)
            }
            Err(e) => {
                let msg = failure_text(&e);
                log.err(sql, start, &msg);
                Some(format!("writes[{i}] failed: {msg}"))
            }
        };
        if let Some(reason) = failure {
            // The rollback's own failure is not worth reporting over the
            // reason it was issued for: the session is then dropped with its
            // transaction still open, which closes it, and the server rolls
            // back regardless.
            let _ = session.end(rollback).await;
            closing("ROLLBACK", Some(&reason));
            return Err(AppError::InvalidInput(format!("{reason}. {ROLLED_BACK}")));
        }
    }
    if let Err(e) = session.end(commit).await {
        let msg = format!("COMMIT failed: {}", failure_text(&e));
        closing("COMMIT", Some(&msg));
        // Best effort, as before on SQL Server; on the others a failed COMMIT
        // has already ended the transaction, and this is a harmless no-op.
        let _ = session.end(rollback).await;
        return Err(AppError::InvalidInput(format!(
            "{msg}. The server did not keep the writes."
        )));
    }
    closing("COMMIT", None);
    Ok(WriteBatchResult {
        atomic: true,
        total_affected: affected.iter().sum(),
        rows_affected: affected,
    })
}

/// MongoDB's half: the writes in order, stopping at the first that fails or
/// misses its `expect_rows`, with no transaction to undo the ones before it.
async fn execute_mongo(
    sink: &dyn LogSink,
    conn: &crate::state::MongoConn,
    connection_id: &str,
    driver: &str,
    writes: &[BatchWrite],
) -> AppResult<WriteBatchResult> {
    let log = SqlLog::new(sink, connection_id, driver);
    let mut affected = Vec::with_capacity(writes.len());
    for (i, write) in writes.iter().enumerate() {
        let sql = write.sql.trim();
        let start = Instant::now();
        let (applied, reason) = match crate::db::mongo::query::execute(conn, sql).await {
            Ok(r) => {
                let n = r.rows_affected;
                log.ok(sql, start, n);
                affected.push(n);
                // This write ran: it is among the ones left in place.
                (i + 1, missed_expectation(i, write, n))
            }
            Err(e) => {
                let msg = e.to_string();
                log.err(sql, start, &msg);
                (i, Some(format!("writes[{i}] failed: {msg}")))
            }
        };
        if let Some(reason) = reason {
            let left = match applied {
                0 => "nothing was changed".to_string(),
                1 => "writes[0] was applied and is still in place".to_string(),
                n => format!(
                    "writes[0]..writes[{}] were applied and are still in place",
                    n - 1
                ),
            };
            return Err(AppError::InvalidInput(format!(
                "{reason}. MongoDB runs these without a transaction: {left}; the rest did not run."
            )));
        }
    }
    Ok(WriteBatchResult {
        atomic: false,
        total_affected: affected.iter().sum(),
        rows_affected: affected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_bus::LogEntry;
    use crate::state::ActivePool;
    use parking_lot::Mutex;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn w(sql: &str) -> BatchWrite {
        BatchWrite {
            sql: sql.into(),
            expect_rows: None,
        }
    }

    fn expect(sql: &str, n: u64) -> BatchWrite {
        BatchWrite {
            sql: sql.into(),
            expect_rows: Some(n),
        }
    }

    fn refusal(writes: &[BatchWrite]) -> String {
        check_writes(writes).unwrap_err().to_string()
    }

    #[test]
    fn a_list_the_transaction_cannot_keep_is_refused_by_entry() {
        assert!(refusal(&[]).contains("at least one"));
        let many: Vec<_> = (0..=MAX_WRITES)
            .map(|_| w("DELETE FROM t WHERE id = 1"))
            .collect();
        assert!(refusal(&many).contains("at most"));

        let ok = w("UPDATE t SET a = 1 WHERE id = 1");
        let case = |bad: &str| refusal(&[ok.clone(), w(bad)]);
        assert!(
            case("UPDATE t SET a = 1 WHERE id = 1; DELETE FROM t WHERE id = 2")
                .contains("writes[1] holds 2 statements")
        );
        for control in [
            "COMMIT",
            "begin",
            "ROLLBACK;",
            "END",
            "SAVEPOINT s",
            "SET x = 1",
            // A comment in front used to hide them: the COMMIT ran inside the
            // transaction and made the writes before it permanent.
            "/* note */ COMMIT",
            "-- note\nCOMMIT",
            "/* a */ -- b\n  SET autocommit = 1",
        ] {
            assert!(
                case(control).contains("writes[1] is transaction or session control"),
                "{control}"
            );
        }
        for hidden in [
            "/*! COMMIT */",
            "/*!40000 COMMIT */",
            "UPDATE t SET a = 1 WHERE id = 1 /*!, b = 2 */",
            "/*M! COMMIT */",
        ] {
            assert!(
                case(hidden).contains("writes[1] holds a MySQL executable comment"),
                "{hidden}"
            );
        }
        assert!(case("SELECT * FROM t").contains("writes[1] only reads"));
        assert!(case("db.t.find({})").contains("writes[1] only reads"));
        assert!(case("ALTER TABLE t ADD c INT").contains("writes[1] changes the schema"));
        assert!(case("db.t.drop()").contains("writes[1] changes the schema"));
        assert!(case("DELETE FROM t").contains("writes[1] is an UPDATE/DELETE with no predicate"));
        assert!(case("db.t.deleteMany({})").contains("no predicate"));
        assert!(case("   ").contains("writes[1] is empty"));

        assert!(check_writes(&[ok, w("INSERT INTO t (a) VALUES (1);")]).is_ok());
    }

    #[test]
    fn a_batch_needs_what_any_of_its_writes_needs() {
        assert_eq!(verbs_of_writes(&[]), Verbs::WRITES);
        let v = verbs_of_writes(&[
            w("INSERT INTO t (a) VALUES (1)"),
            w("DELETE FROM t WHERE a = 2"),
        ]);
        assert!(v.contains(Verbs::INSERT) && v.contains(Verbs::DELETE));
        assert!(!v.contains(Verbs::UPDATE));
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<LogEntry>>);
    impl LogSink for Recorder {
        fn log(&self, entry: LogEntry) {
            self.0.lock().push(entry);
        }
    }

    async fn sqlite_state(name: &str) -> (AppState, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "huginndb-write-batch-{name}-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE cfg (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cfg VALUES ('a', '1'), ('b', '1')")
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::new();
        state
            .connections
            .write()
            .insert("c".into(), ActivePool::bare(DbPool::Sqlite(pool)));
        (state, path)
    }

    async fn values(state: &AppState) -> Vec<(String, String)> {
        let Ok(DbPool::Sqlite(p)) = state.pool_for("c") else {
            unreachable!()
        };
        sqlx::query_as("SELECT k, v FROM cfg ORDER BY k")
            .fetch_all(&p)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn every_write_lands_together() {
        let (state, path) = sqlite_state("commit").await;
        let sink = Recorder::default();
        let out = execute_write_batch_inner(
            &sink,
            &state,
            "c",
            &[
                expect("UPDATE cfg SET v = '2' WHERE k = 'a'", 1),
                w("INSERT INTO cfg VALUES ('c', '3')"),
                w("DELETE FROM cfg WHERE k = 'b'"),
            ],
        )
        .await
        .unwrap();
        assert!(out.atomic);
        assert_eq!(out.rows_affected, vec![1, 1, 1]);
        assert_eq!(out.total_affected, 3);
        assert_eq!(
            values(&state).await,
            vec![("a".into(), "2".into()), ("c".into(), "3".into())]
        );
        let log = sink.0.lock();
        assert_eq!(log.len(), 4, "one entry per write, then the COMMIT");
        assert_eq!(log[3].sql.as_deref(), Some("COMMIT"));
        assert!(log[3].error.is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_failing_write_takes_the_ones_before_it_back() {
        let (state, path) = sqlite_state("fail").await;
        let sink = Recorder::default();
        let err = execute_write_batch_inner(
            &sink,
            &state,
            "c",
            &[
                w("UPDATE cfg SET v = '9' WHERE k = 'a'"),
                // Primary key clash.
                w("INSERT INTO cfg VALUES ('b', 'x')"),
                w("DELETE FROM cfg WHERE k = 'a'"),
            ],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("writes[1] failed"), "{err}");
        assert!(err.contains("rolled back"), "{err}");
        assert_eq!(
            values(&state).await,
            vec![("a".into(), "1".into()), ("b".into(), "1".into())],
            "the first write must not have survived the second's failure"
        );
        let log = sink.0.lock();
        assert_eq!(log.len(), 3, "the two that ran, then the ROLLBACK");
        assert_eq!(log[2].sql.as_deref(), Some("ROLLBACK"));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_write_that_matches_the_wrong_number_of_rows_rolls_back() {
        let (state, path) = sqlite_state("expect").await;
        let err = execute_write_batch_inner(
            &Recorder::default(),
            &state,
            "c",
            &[
                expect("UPDATE cfg SET v = '5' WHERE k = 'a'", 1),
                // A typo in the key: the statement succeeds and touches nothing,
                // which is what an agent otherwise re-reads to find out.
                expect("UPDATE cfg SET v = '5' WHERE k = 'bb'", 1),
            ],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("writes[1] affected 0 rows, expected 1"),
            "{err}"
        );
        assert_eq!(
            values(&state).await,
            vec![("a".into(), "1".into()), ("b".into(), "1".into())]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn the_executor_checks_the_list_itself() {
        // The sidecar checks first, but the app must not rely on it: the
        // bridge is reachable by anything holding the token.
        let (state, path) = sqlite_state("check").await;
        let err = execute_write_batch_inner(
            &Recorder::default(),
            &state,
            "c",
            &[w("UPDATE cfg SET v = '7' WHERE k = 'a'"), w("COMMIT")],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("transaction or session control"), "{err}");
        assert_eq!(values(&state).await[0], ("a".into(), "1".into()));
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_commented_commit_cannot_split_the_batch() {
        // Found by hand against a canary build: the COMMIT ran inside the
        // transaction, the first write stayed, and the reply to the later
        // missed `expect_rows` said nothing had changed.
        let (state, path) = sqlite_state("commented-commit").await;
        let err = execute_write_batch_inner(
            &Recorder::default(),
            &state,
            "c",
            &[
                expect("UPDATE cfg SET v = '7' WHERE k = 'a'", 1),
                w("/* c */ COMMIT"),
                expect("UPDATE cfg SET v = '7' WHERE k = 'nope'", 1),
            ],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("writes[1] is transaction or session control"),
            "{err}"
        );
        assert_eq!(values(&state).await[0], ("a".into(), "1".into()));
        let _ = std::fs::remove_file(&path);
    }
}
