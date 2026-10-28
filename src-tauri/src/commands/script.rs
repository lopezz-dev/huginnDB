//! A whole SQL script run on one pinned session — the executor behind the MCP
//! connector's `run_script` tool (ADR #121).
//!
//! # Why it exists
//!
//! Every other statement the connector runs takes whichever pooled connection
//! is free. That is right for a lone `SELECT` and wrong for a migration: a
//! `CREATE TEMPORARY TABLE` (or a T-SQL `#staging`) made by one call lives in a
//! session the next call is unlikely to get, a `SET` is gone just as fast, and
//! the reads that check a step can never see a temp table at all. An assistant
//! asked to run a migration through HuginnDB concluded, reasonably, that it
//! "does not support temporary tables or batches" and rewrote the script into
//! single statements full of CTEs. This module makes that conclusion false:
//! one call, one session, every statement in order on it.
//!
//! # The promise, and what keeps it
//!
//! * **One session for the whole script, closed afterwards.** The connection is
//!   never handed back to the pool, so temp tables, `SET`s, a `USE` and any
//!   transaction the script left open die with it instead of surfacing in the
//!   next grid page somebody opens on the same pool. One extra connect per
//!   script is the price, and it is the right one.
//! * **One transaction by default.** `BEGIN` before the first statement,
//!   `COMMIT` after the last, `ROLLBACK` at the first failure. Transaction
//!   control inside the script is refused in this mode, for the reason
//!   `run_writes` refuses it: a `COMMIT` in the middle would make everything
//!   before it permanent. With `transaction: false` the script runs as written,
//!   its own `BEGIN`/`COMMIT` included, and a failure leaves what ran in place.
//! * **MySQL commits around schema changes**, so in transaction mode a
//!   persistent DDL statement (or `LOCK TABLES`) is refused there rather than
//!   silently splitting the transaction. `CREATE/DROP TEMPORARY TABLE` does not
//!   commit on MySQL and is allowed.
//! * **Every check sees what MySQL executes.** A `/*! … */` executable comment
//!   is code to MySQL and a comment to every classifier here, and dumps are
//!   full of them. Rather than refuse dumps outright (what `run_writes` does
//!   for one-statement entries), each statement is checked and classified as
//!   written *and* with those comments unwrapped, and needs the union.
//! * **The tier is the script's.** No special case for temporary objects: a
//!   `CREATE TEMPORARY TABLE` is DDL and needs `full`, as it does through
//!   `run_write`. A script that only reads is refused — `run_queries` runs
//!   those inside the read-only transaction every AI read gets (ADR #93), and
//!   this tool does not.
//!
//! MongoDB is refused: its shell grammar has no session-scoped objects and no
//! multi-statement script to pin, and `run_writes` already runs a list of
//! MongoDB writes in order.

use crate::commands::query::{ColumnMeta, QueryResult};
use crate::db::sql::{skip_leading_noise, Verbs};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use sqlx::Executor as _;
use std::borrow::Cow;
use std::time::Instant;

/// Most statements one script may carry.
///
/// Generous on purpose — a migration is many small statements — but finite, so
/// a runaway generated file is refused before it holds a transaction open for
/// an hour. Bigger loads split into several calls.
pub const MAX_STATEMENTS: usize = 10_000;

/// Largest script, in bytes, whether sent inline or read from a file.
pub const MAX_SCRIPT_BYTES: usize = 16 * 1024 * 1024;

/// One statement of a script, with the line it starts on (1-based) so a
/// failure can point into a file the model never read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptStatement<'a> {
    pub sql: &'a str,
    pub line: usize,
}

/// Split `text` into statements: on `;` outside literals and comments (the
/// same lexer every classifier here uses), and on T-SQL's `GO` batch separator —
/// a line holding nothing but `GO`, which no engine here accepts as SQL, so
/// treating it as a separator everywhere changes no script that could run.
///
/// `GO <count>` is not a separator; the server refuses it, which is the honest
/// answer for a client feature this does not implement.
pub fn split_script(text: &str) -> Vec<ScriptStatement<'_>> {
    let mut chunks = Vec::new();
    let (mut start, mut pos) = (0usize, 0usize);
    for line in text.split_inclusive('\n') {
        if line.trim().eq_ignore_ascii_case("go") {
            chunks.push(&text[start..pos]);
            start = pos + line.len();
        }
        pos += line.len();
    }
    chunks.push(&text[start..]);

    // Line numbers counted incrementally: statements come out in order, and
    // recounting from the top for each one is quadratic on a 16 MB file.
    let (mut counted_to, mut line) = (0usize, 1usize);
    chunks
        .into_iter()
        .flat_map(crate::db::sql::split_statements)
        .map(|sql| {
            // Every piece is a subslice of `text`: `split_statements` only
            // trims and slices what it is given.
            let offset = sql.as_ptr() as usize - text.as_ptr() as usize;
            line += text.as_bytes()[counted_to..offset]
                .iter()
                .filter(|b| **b == b'\n')
                .count();
            counted_to = offset;
            ScriptStatement { sql, line }
        })
        .collect()
}

/// `sql` with every MySQL / MariaDB executable comment (`/*! … */`,
/// `/*!40101 … */`, `/*M!100100 … */`) replaced by its contents — the text
/// MySQL actually runs. Borrowed unchanged when there is none.
///
/// Version gates are ignored: the contents are assumed to run, which is the
/// strict direction for a check.
pub fn unwrap_executable_comments(sql: &str) -> Cow<'_, str> {
    if !sql.contains("/*!") && !sql.contains("/*M!") {
        return Cow::Borrowed(sql);
    }
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    loop {
        let at = [rest.find("/*!"), rest.find("/*M!")]
            .into_iter()
            .flatten()
            .min();
        let Some(at) = at else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..at]);
        out.push(' ');
        let body = &rest[at + 2..];
        let body = body.strip_prefix('M').unwrap_or(body);
        let body = body[1..].trim_start_matches(|c: char| c.is_ascii_digit());
        match body.find("*/") {
            Some(end) => {
                out.push_str(&body[..end]);
                out.push(' ');
                rest = &body[end + 2..];
            }
            None => {
                out.push_str(body);
                break;
            }
        }
    }
    Cow::Owned(out)
}

/// The lowercased head of what a statement executes, comments skipped.
fn head_of(visible: &str) -> String {
    skip_leading_noise(visible).to_ascii_lowercase()
}

/// Whether a statement has nothing to execute — only comments. Skipped rather
/// than sent: MySQL answers an empty query with an error.
fn is_blank(visible: &str) -> bool {
    skip_leading_noise(visible)
        .trim()
        .trim_end_matches(';')
        .is_empty()
}

/// Whether a statement opens, ends or marks a transaction, or switches
/// autocommit — what this executor owns in transaction mode. `USE`, `SET`
/// (other than autocommit) and `LOCK` are session state the script may set.
fn is_transaction_control(head: &str) -> bool {
    if head.starts_with("set ") {
        return head.contains("autocommit") || head.contains("implicit_transactions");
    }
    crate::db::sql::is_session_statement(head)
        && !head.starts_with("use ")
        && !head.starts_with("lock ")
        && !head.starts_with("unlock ")
}

/// Whether MySQL commits implicitly around this statement, which in
/// transaction mode would make everything before it permanent.
fn commits_implicitly_on_mysql(visible: &str, head: &str) -> bool {
    let temporary = head.starts_with("create temporary ") || head.starts_with("drop temporary ");
    (crate::db::sql::is_ddl(visible) && !temporary)
        || head.starts_with("lock ")
        || head.starts_with("unlock ")
}

/// Everything a script does, for the policy checks: the union over its
/// statements, each read as written and as MySQL executes it.
///
/// Nothing to run needs every row write, the rule
/// [`crate::db::sql::verbs`] applies to empty text.
pub fn verbs_of_script(text: &str) -> Verbs {
    let statements = split_script(text);
    if statements.is_empty() {
        return Verbs::WRITES;
    }
    statements
        .iter()
        .map(|st| {
            crate::db::classify::verbs_of(st.sql)
                | crate::db::classify::verbs_of(&unwrap_executable_comments(st.sql))
        })
        .fold(Verbs::NONE, |all, one| all | one)
}

/// `statements[i] (line n: preview)` — how every message names a statement.
fn name(index: usize, st: &ScriptStatement<'_>) -> String {
    format!(
        "statements[{index}] (line {}: {})",
        st.line,
        crate::commands::query::stmt_preview(st.sql)
    )
}

/// Refuse a script this executor could not run as promised. Driver-free, so
/// the sidecar runs it before opening a pool; the executor runs it again.
///
/// Each refusal names the statement and the fix — it is read by a model
/// deciding what to do next (gotcha #74).
pub fn check_script(statements: &[ScriptStatement<'_>], transaction: bool) -> AppResult<()> {
    if statements.is_empty() {
        return Err(AppError::InvalidInput(
            "run_script needs at least one statement".into(),
        ));
    }
    if statements.len() > MAX_STATEMENTS {
        return Err(AppError::InvalidInput(format!(
            "run_script takes at most {MAX_STATEMENTS} statements per call ({} given). Split \
             the script into several calls.",
            statements.len()
        )));
    }
    let mut writes = false;
    for (i, st) in statements.iter().enumerate() {
        let visible = unwrap_executable_comments(st.sql);
        if is_blank(&visible) {
            continue;
        }
        let head = head_of(&visible);
        if crate::db::mongo::shell::looks_like_mongo(st.sql) {
            return Err(AppError::InvalidInput(format!(
                "{} is a MongoDB statement. run_script runs SQL scripts; use run_writes for a \
                 list of MongoDB writes.",
                name(i, st)
            )));
        }
        if head.starts_with("delimiter") {
            return Err(AppError::InvalidInput(format!(
                "{} is the mysql client's DELIMITER command, not SQL. Send a routine whose body \
                 holds `;` on its own through run_write instead.",
                name(i, st)
            )));
        }
        if transaction && is_transaction_control(&head) {
            return Err(AppError::InvalidInput(format!(
                "{} is transaction control, and run_script already wraps the script in one \
                 transaction. Leave it out, or pass `transaction: false` to run the script's \
                 own BEGIN/COMMIT.",
                name(i, st)
            )));
        }
        if crate::db::classify::is_unfiltered_write(st.sql)
            || crate::db::classify::is_unfiltered_write(&visible)
        {
            return Err(AppError::InvalidInput(format!(
                "{} is an UPDATE/DELETE with no predicate. Add one (`WHERE 1=1` if you really \
                 mean every row).",
                name(i, st)
            )));
        }
        writes |= crate::db::classify::classify_statement(st.sql)
            != crate::db::sql::StmtClass::Read
            || crate::db::classify::classify_statement(&visible) != crate::db::sql::StmtClass::Read;
    }
    if !writes {
        return Err(AppError::InvalidInput(
            "this script only reads. Use run_queries, which runs reads in a read-only \
             transaction and needs no write permission."
                .into(),
        ));
    }
    Ok(())
}

/// One result set a statement of the script returned.
#[derive(Debug, Serialize, Deserialize)]
pub struct ScriptRows {
    /// Index of the statement in the script, as error messages count them.
    pub statement: usize,
    pub line: usize,
    #[serde(flatten)]
    pub result: QueryResult,
}

/// What a script that went through reports. A script that did not is an
/// error instead, for the reason [`crate::commands::write_batch::WriteBatchResult`]
/// gives: the audit line is written from whether the call failed.
#[derive(Debug, Serialize, Deserialize)]
pub struct ScriptResult {
    /// Whether the script ran inside one transaction this executor opened.
    pub transaction: bool,
    /// Statements executed (comment-only ones are not counted).
    pub statements: usize,
    /// Rows the writes affected, summed. Per-statement counts are left out on
    /// purpose: on a migration they are thousands of numbers nobody reads.
    pub total_affected: u64,
    /// Result sets, from the statements that returned rows, in order. They
    /// share one `max_rows` budget across the script.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<ScriptRows>,
}

const ROLLED_BACK: &str = "The transaction was rolled back; nothing was changed.";

/// Run `script` against `connection_id` on one session.
///
/// `max_rows` bounds the rows kept across every read in the script. `sink`
/// gets one entry per statement as it runs, plus `BEGIN` / `COMMIT` /
/// `ROLLBACK` entries in transaction mode, so `mcp-audit.log` shows whether
/// the writes it lists stayed.
pub(crate) async fn execute_script_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    script: &str,
    transaction: bool,
    max_rows: usize,
) -> AppResult<ScriptResult> {
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "the script is {} bytes; run_script takes at most {MAX_SCRIPT_BYTES}",
            script.len()
        )));
    }
    let statements = split_script(script);
    check_script(&statements, transaction)?;
    let pool = state.pool_for(connection_id)?;
    let driver = pool.driver_name();
    if matches!(pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "run_script runs SQL scripts and this is a MongoDB connection. Use run_writes for \
             a list of MongoDB writes."
                .into(),
        ));
    }
    if transaction && matches!(pool, DbPool::Mysql(_)) {
        for (i, st) in statements.iter().enumerate() {
            let visible = unwrap_executable_comments(st.sql);
            if commits_implicitly_on_mysql(&visible, &head_of(&visible)) {
                return Err(AppError::InvalidInput(format!(
                    "{} makes MySQL commit implicitly, which would split the transaction \
                     run_script opens. Pass `transaction: false` to run the script as \
                     written (temporary tables are fine either way).",
                    name(i, st)
                )));
            }
        }
    }
    let (begin, commit, rollback) = match pool {
        DbPool::Mysql(_) => ("START TRANSACTION", "COMMIT", "ROLLBACK"),
        DbPool::MsSql(_) => (
            "BEGIN TRANSACTION",
            "COMMIT TRANSACTION",
            "ROLLBACK TRANSACTION",
        ),
        _ => ("BEGIN", "COMMIT", "ROLLBACK"),
    };
    let script_start = Instant::now();
    let closing = |sql: &str, error: Option<&str>| {
        log_sql_sink(sink, connection_id, driver, sql, script_start, None, error);
    };

    // One loop, two ways to hold a session. `$exec` runs a statement for its
    // row count, `$fetch` runs a read and yields its non-empty result sets as
    // `(columns, rows, truncated)`; both read the statement through `$sql` and
    // `$fetch` the remaining row budget through `$cap`.
    macro_rules! drive {
        (|$sql:ident, $cap:ident| exec: $exec:expr, fetch: $fetch:expr) => {{
            if transaction {
                let $sql = begin;
                $exec?;
                closing(begin, None);
            }
            let mut left = max_rows;
            let mut ran = 0usize;
            let mut total_affected = 0u64;
            let mut results = Vec::new();
            for (i, st) in statements.iter().enumerate() {
                if is_blank(&unwrap_executable_comments(st.sql)) {
                    continue;
                }
                let $sql = st.sql;
                let $cap = left;
                let start = Instant::now();
                let outcome: AppResult<u64> = if crate::db::sql::is_read_only($sql) {
                    let fetched: AppResult<
                        Vec<(Vec<ColumnMeta>, Vec<Vec<serde_json::Value>>, bool)>,
                    > = $fetch;
                    fetched.map(|sets| {
                        let mut produced = 0u64;
                        for (columns, mut rows, truncated) in sets {
                            produced += rows.len() as u64;
                            let over = rows.len() > left;
                            rows.truncate(left);
                            left -= rows.len();
                            results.push(ScriptRows {
                                statement: i,
                                line: st.line,
                                result: QueryResult::rows(
                                    columns,
                                    rows,
                                    start.elapsed().as_millis() as u64,
                                )
                                .with_truncated(truncated || over),
                            });
                        }
                        produced
                    })
                } else {
                    $exec.map(|n| {
                        total_affected += n;
                        n
                    })
                };
                match outcome {
                    Ok(n) => {
                        log_sql_sink(sink, connection_id, driver, $sql, start, Some(n), None);
                        ran += 1;
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        log_sql_sink(sink, connection_id, driver, $sql, start, None, Some(&msg));
                        let reason = format!("{} failed: {msg}", name(i, st));
                        if transaction {
                            // Best effort: the session is closed right after,
                            // which rolls back whatever this did not.
                            let $sql = rollback;
                            let _ = $exec;
                            closing(rollback, Some(&reason));
                            return Err(AppError::InvalidInput(format!("{reason}. {ROLLED_BACK}")));
                        }
                        let left_in_place = match ran {
                            0 => "nothing ran before it".to_string(),
                            1 => "the 1 statement before it ran and stays applied".to_string(),
                            n => format!("the {n} statements before it ran and stay applied"),
                        };
                        return Err(AppError::InvalidInput(format!(
                            "{reason}. No transaction was requested: {left_in_place}; the rest \
                             did not run."
                        )));
                    }
                }
            }
            if transaction {
                let $sql = commit;
                if let Err(e) = $exec {
                    let msg = format!("COMMIT failed: {e}");
                    closing(commit, Some(&msg));
                    return Err(AppError::InvalidInput(format!(
                        "{msg}. The server did not keep the script's changes."
                    )));
                }
                closing(commit, None);
            }
            ScriptResult {
                transaction,
                statements: ran,
                total_affected,
                results,
            }
        }};
    }

    // The session is closed when its guard drops, on every path out of here —
    // see the module docs for why it never goes back to the pool.
    macro_rules! sqlx_script {
        ($p:expr, $decode:path) => {{
            let mut conn = $p.acquire().await?;
            conn.close_on_drop();
            drive!(|stmt, cap| exec: (&mut *conn)
                .execute(stmt)
                .await
                .map(|r| r.rows_affected())
                .map_err(AppError::from),
            fetch: crate::commands::query::fetch_capped(&mut *conn, stmt, cap)
                .await
                .map(|(rows, truncated)| {
                    let (columns, data) = $decode(&rows);
                    if columns.is_empty() {
                        Vec::new()
                    } else {
                        vec![(columns, data, truncated)]
                    }
                })
                .map_err(AppError::from))
        }};
    }

    Ok(match &pool {
        DbPool::Postgres(p) => sqlx_script!(p, crate::commands::query::pg_result),
        DbPool::Mysql(p) => sqlx_script!(p, crate::commands::query::mysql_result),
        DbPool::Sqlite(p) => sqlx_script!(p, crate::commands::query::sqlite_result),
        DbPool::MsSql(p) => {
            let mut c = p.acquire().await?;
            c.close_on_drop();
            drive!(|stmt, cap| exec: c.simple_execute(stmt).await,
            fetch: c.simple_query_sets_capped(stmt, cap).await.map(|(sets, truncated)| {
                sets.into_iter()
                    .filter(|rows| !rows.is_empty())
                    .map(|rows| {
                        let (columns, data) = crate::db::mssql::schema::decode_rows(&rows);
                        let columns = columns
                            .into_iter()
                            .map(|(name, data_type)| ColumnMeta { name, data_type })
                            .collect();
                        (columns, data, truncated)
                    })
                    .collect()
            }))
        }
        DbPool::Mongo(_) => unreachable!("refused above"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_bus::LogEntry;
    use crate::state::ActivePool;
    use parking_lot::Mutex;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn refusal(script: &str, transaction: bool) -> String {
        check_script(&split_script(script), transaction)
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn a_script_splits_on_semicolons_and_go_lines_and_knows_its_lines() {
        let text = "CREATE TABLE #t (a INT)\nGO\nINSERT INTO #t VALUES (1); -- one\n\
                    INSERT INTO #t VALUES ('a;b');\n\ngo\n  SELECT * FROM #t";
        let got: Vec<_> = split_script(text)
            .into_iter()
            .map(|s| (s.line, s.sql))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, "CREATE TABLE #t (a INT)"),
                (3, "INSERT INTO #t VALUES (1)"),
                (3, "-- one\nINSERT INTO #t VALUES ('a;b')"),
                (7, "SELECT * FROM #t"),
            ]
        );
        // A `GO` that is not alone on its line is SQL, not a separator.
        assert_eq!(split_script("SELECT 1 AS go\nGO 5").len(), 1);
    }

    #[test]
    fn executable_comments_are_read_as_mysql_runs_them() {
        assert_eq!(unwrap_executable_comments("SELECT 1"), "SELECT 1");
        assert_eq!(
            unwrap_executable_comments("/*!40101 SET NAMES utf8 */").trim(),
            "SET NAMES utf8"
        );
        assert_eq!(
            unwrap_executable_comments("/*M!100100 COMMIT */").trim(),
            "COMMIT"
        );
        assert_eq!(unwrap_executable_comments("/*! COMMIT").trim(), "COMMIT");
        // A dump's version-gated statement needs what its body needs.
        assert!(verbs_of_script("/*!40000 DROP TABLE t */").contains(Verbs::DDL));
    }

    #[test]
    fn a_script_the_executor_cannot_keep_its_promise_for_is_refused() {
        assert!(refusal("  ;  ", true).contains("at least one"));
        let many = "DELETE FROM t WHERE a = 1;".repeat(MAX_STATEMENTS + 1);
        assert!(refusal(&many, true).contains("at most"));
        assert!(refusal("SELECT 1; SELECT 2", true).contains("only reads"));
        assert!(refusal("db.t.insertOne({a: 1})", true).contains("MongoDB"));
        assert!(refusal("DELIMITER $$\nINSERT INTO t VALUES (1)", true).contains("DELIMITER"));
        assert!(refusal("INSERT INTO t VALUES (1);\nDELETE FROM t", true).contains("no predicate"));
        for control in [
            "COMMIT",
            "BEGIN",
            "/* c */ ROLLBACK",
            "/*!40000 COMMIT */",
            "SET autocommit = 1",
            "SAVEPOINT s",
            "START TRANSACTION",
        ] {
            let script = format!("INSERT INTO t VALUES (1);\n{control};");
            let err = refusal(&script, true);
            assert!(err.contains("statements[1] (line 2"), "{control}: {err}");
            assert!(err.contains("transaction control"), "{control}: {err}");
            // Without a transaction of ours, the script's own runs.
            assert!(
                check_script(&split_script(&script), false).is_ok(),
                "{control}"
            );
        }
        // Session state the script may set, and comment-only statements.
        assert!(check_script(
            &split_script(
                "USE shop; SET NAMES utf8mb4; /*!40101 SET SQL_MODE='' */; -- end\n\
                 CREATE TEMPORARY TABLE s (a INT); INSERT INTO s VALUES (1); -- tail"
            ),
            true
        )
        .is_ok());
    }

    #[test]
    fn mysql_statements_that_commit_are_named() {
        let st = |sql: &str| {
            let v = unwrap_executable_comments(sql);
            commits_implicitly_on_mysql(&v, &head_of(&v))
        };
        assert!(st("CREATE TABLE t (a INT)"));
        assert!(st("/*!40000 ALTER TABLE t DISABLE KEYS */"));
        assert!(st("LOCK TABLES t WRITE"));
        assert!(!st("CREATE TEMPORARY TABLE t (a INT)"));
        assert!(!st("DROP TEMPORARY TABLE IF EXISTS t"));
        assert!(!st("INSERT INTO t VALUES (1)"));
    }

    #[test]
    fn a_temporary_table_needs_what_any_schema_change_needs() {
        // Decided, not overlooked (ADR #121): the tier does not look at whether
        // the object is temporary.
        assert!(verbs_of_script("CREATE TEMPORARY TABLE s (a INT)").contains(Verbs::DDL));
        assert!(verbs_of_script("CREATE TABLE #s (a INT)").contains(Verbs::DDL));
        let rows = verbs_of_script("INSERT INTO t VALUES (1); UPDATE t SET a = 2 WHERE a = 1");
        assert!(rows.contains(Verbs::INSERT) && rows.contains(Verbs::UPDATE));
        assert!(!rows.contains(Verbs::DDL));
        assert_eq!(verbs_of_script(""), Verbs::WRITES);
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<LogEntry>>);
    impl LogSink for Recorder {
        fn log(&self, entry: LogEntry) {
            self.0.lock().push(entry);
        }
    }

    /// A file-backed SQLite pool of one connection, so "the same session"
    /// cannot be an accident of the pool handing the same one back: the
    /// script's session is closed, and the next query gets a fresh one.
    async fn sqlite_state(name: &str) -> (AppState, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("huginndb-script-{name}-{}.db", std::process::id()));
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
        sqlx::query("CREATE TABLE dest (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
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

    async fn dest(state: &AppState) -> Vec<(String, i64)> {
        let Ok(DbPool::Sqlite(p)) = state.pool_for("c") else {
            unreachable!()
        };
        sqlx::query_as("SELECT k, v FROM dest ORDER BY k")
            .fetch_all(&p)
            .await
            .unwrap()
    }

    const MIGRATION: &str = "\
        CREATE TEMP TABLE staging (k TEXT, v INTEGER);\n\
        INSERT INTO staging VALUES ('a', 1), ('b', 2), ('c', 3);\n\
        UPDATE staging SET v = v * 10 WHERE k <> 'c';\n\
        INSERT INTO dest SELECT k, v FROM staging;\n\
        SELECT count(*) AS n FROM staging;\n\
        SELECT k, v FROM dest ORDER BY k;";

    #[tokio::test]
    async fn a_temp_table_lives_for_the_whole_script_and_dies_with_it() {
        let (state, path) = sqlite_state("temp").await;
        let sink = Recorder::default();
        let out = execute_script_inner(&sink, &state, "c", MIGRATION, true, 100)
            .await
            .unwrap();
        assert!(out.transaction);
        assert_eq!(out.statements, 6);
        assert_eq!(out.total_affected, 3 + 2 + 3);
        assert_eq!(out.results.len(), 2);
        assert_eq!((out.results[0].statement, out.results[0].line), (4, 5));
        assert_eq!(out.results[1].result.rows.len(), 3);
        assert_eq!(
            dest(&state).await,
            vec![("a".into(), 10), ("b".into(), 20), ("c".into(), 3)]
        );
        {
            let log = sink.0.lock();
            assert_eq!(log.first().and_then(|e| e.sql.as_deref()), Some("BEGIN"));
            assert_eq!(log.last().and_then(|e| e.sql.as_deref()), Some("COMMIT"));
        }
        // The session was closed, not pooled: the temp table is gone.
        let Ok(DbPool::Sqlite(p)) = state.pool_for("c") else {
            unreachable!()
        };
        let Err(err) = sqlx::query("SELECT * FROM staging").fetch_all(&p).await else {
            panic!("the temp table outlived the script's session");
        };
        let err = err.to_string();
        assert!(err.contains("no such table"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_failing_statement_takes_the_whole_script_back() {
        let (state, path) = sqlite_state("fail").await;
        let script = "INSERT INTO dest VALUES ('a', 1);\n\
                      CREATE TEMP TABLE s (k TEXT);\n\
                      INSERT INTO dest VALUES ('a', 2);";
        let err = execute_script_inner(&Recorder::default(), &state, "c", script, true, 100)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("statements[2] (line 3"), "{err}");
        assert!(err.contains("rolled back"), "{err}");
        assert!(dest(&state).await.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn without_a_transaction_the_script_runs_as_written() {
        let (state, path) = sqlite_state("no-tx").await;
        // The script's own transaction control runs, on the same session.
        let script = "BEGIN; INSERT INTO dest VALUES ('a', 1); COMMIT;\n\
                      INSERT INTO dest VALUES ('a', 2);";
        let err = execute_script_inner(&Recorder::default(), &state, "c", script, false, 100)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("the 3 statements before it ran and stay applied"),
            "{err}"
        );
        assert_eq!(dest(&state).await, vec![("a".into(), 1)]);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn reads_share_one_row_budget() {
        let (state, path) = sqlite_state("budget").await;
        let script = "INSERT INTO dest VALUES ('a', 1), ('b', 2), ('c', 3);\n\
                      SELECT * FROM dest; SELECT * FROM dest;";
        let out = execute_script_inner(&Recorder::default(), &state, "c", script, true, 4)
            .await
            .unwrap();
        assert_eq!(out.results[0].result.rows.len(), 3);
        assert!(!out.results[0].result.truncated);
        assert_eq!(out.results[1].result.rows.len(), 1);
        assert!(out.results[1].result.truncated);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn the_executor_checks_the_script_itself() {
        let (state, path) = sqlite_state("check").await;
        let err = execute_script_inner(
            &Recorder::default(),
            &state,
            "c",
            "INSERT INTO dest VALUES ('a', 1); COMMIT;",
            true,
            100,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("transaction control"), "{err}");
        assert!(dest(&state).await.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
