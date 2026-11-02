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
//! # SQL Server runs batches, not statements (ADR #131)
//!
//! On SQL Server the unit of execution is the `GO` batch, as in SSMS and
//! `sqlcmd`: each batch goes to the server whole, in one round trip. Splitting
//! it on `;` (what every other engine here gets) broke what T-SQL keeps per
//! batch — a `DECLARE`d variable did not reach the next statement, and an
//! `IF` / `WHILE` / `BEGIN … END` / `BEGIN TRY … END CATCH` holding a `;` was
//! cut into pieces the server refused. What lives on the session (`#temp`
//! tables, `SET`s, the transaction) still crosses batches; variables do not,
//! exactly as in SSMS.
//!
//! The checks do not follow the execution unit. Policy, transaction control
//! and the limits are still decided **per statement** ([`split_script`]), and
//! a batch needs the union of what its statements need — one DDL statement
//! makes the whole batch `full`. Because T-SQL needs no `;` between
//! statements and nests them inside control flow, a statement's verbs also
//! include every keyword in its code, not only its head ([`statement_verbs`]):
//! `SELECT 1 EXEC p` or `IF @x = 1 DROP TABLE t` is DDL, whatever it starts
//! with. That is stricter on every engine and never looser.
//!
//! In transaction mode SQL Server runs with `XACT_ABORT ON`, so any error —
//! a `THROW`, a constraint, a conversion — dooms the transaction and ends the
//! batch: nothing after it runs, and the guarded `ROLLBACK` cleans up. A
//! script that relies on catching an error and carrying on inside the
//! transaction has to pass `transaction: false`.
//!
//! MongoDB is refused: its shell grammar has no session-scoped objects and no
//! multi-statement script to pin, and `run_writes` already runs a list of
//! MongoDB writes in order.

use crate::commands::query::{column_meta, QueryResult};
use crate::db::session::Session;
use crate::db::sql::{skip_leading_noise, Verbs};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink, SqlLog};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
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
/// failure can point into a file the model never read, and the `GO` batch it
/// belongs to (0-based).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptStatement<'a> {
    pub sql: &'a str,
    pub line: usize,
    pub batch: usize,
}

/// `text` cut at T-SQL's `GO` batch separator — a line holding nothing but
/// `GO`, which no engine here accepts as SQL, so treating it as a separator
/// everywhere changes no script that could run. Every chunk is a subslice of
/// `text`, the separator lines left out.
///
/// `GO <count>` is not a separator; the server refuses it, which is the honest
/// answer for a client feature this does not implement.
fn go_batches(text: &str) -> Vec<&str> {
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
    chunks
}

/// Split `text` into statements: on `;` outside literals and comments (the
/// same lexer every classifier here uses), and on `GO` lines ([`go_batches`]).
pub fn split_script(text: &str) -> Vec<ScriptStatement<'_>> {
    // Line numbers counted incrementally: statements come out in order, and
    // recounting from the top for each one is quadratic on a 16 MB file.
    let (mut counted_to, mut line) = (0usize, 1usize);
    go_batches(text)
        .into_iter()
        .enumerate()
        .flat_map(|(batch, chunk)| {
            crate::db::sql::split_statements(chunk)
                .into_iter()
                .map(move |sql| (batch, sql))
        })
        .map(|(batch, sql)| {
            // Every piece is a subslice of `text`: `split_statements` only
            // trims and slices what it is given.
            let offset = sql.as_ptr() as usize - text.as_ptr() as usize;
            line += text.as_bytes()[counted_to..offset]
                .iter()
                .filter(|b| **b == b'\n')
                .count();
            counted_to = offset;
            ScriptStatement { sql, line, batch }
        })
        .collect()
}

/// What the executor sends to the server in one round trip: one statement,
/// or on SQL Server one whole `GO` batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Unit<'a> {
    sql: &'a str,
    /// Index of its first statement in [`split_script`]'s list.
    first: usize,
    /// Statements it holds, comment-only ones not counted.
    statements: usize,
    line: usize,
}

/// Group `statements` into what the executor runs: each statement on its own,
/// or with `whole_batches`, every `GO` batch as one unit — from its first
/// statement to the end of the batch, so a final `;` a `MERGE` needs, and
/// anything between the statements, is sent as written.
fn units<'a>(
    text: &'a str,
    statements: &[ScriptStatement<'a>],
    whole_batches: bool,
) -> Vec<Unit<'a>> {
    let runnable = statements
        .iter()
        .enumerate()
        .filter(|(_, st)| !is_blank(&unwrap_executable_comments(st.sql)));
    if !whole_batches {
        return runnable
            .map(|(first, st)| Unit {
                sql: st.sql,
                first,
                statements: 1,
                line: st.line,
            })
            .collect();
    }
    let batches = go_batches(text);
    let mut out: Vec<Unit<'a>> = Vec::new();
    for (i, st) in runnable {
        match out.last_mut() {
            Some(unit) if statements[unit.first].batch == st.batch => unit.statements += 1,
            _ => {
                let chunk = batches[st.batch];
                let from = st.sql.as_ptr() as usize - chunk.as_ptr() as usize;
                out.push(Unit {
                    sql: chunk[from..].trim_end(),
                    first: i,
                    statements: 1,
                    line: st.line,
                });
            }
        }
    }
    out
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

/// The words after `BEGIN` that make it open a transaction (T-SQL's
/// `BEGIN TRAN`, Postgres' `BEGIN ISOLATION LEVEL …`, SQLite's
/// `BEGIN IMMEDIATE`, …). Any other word after it opens a T-SQL block —
/// `BEGIN TRY`, or `BEGIN` before the block's first statement.
const BEGIN_OPENS_TRANSACTION: [&str; 11] = [
    "tran",
    "transaction",
    "work",
    "distributed",
    "isolation",
    "read",
    "not",
    "deferrable",
    "deferred",
    "immediate",
    "exclusive",
];

/// Whether the `BEGIN` followed by `next` opens a transaction. A bare one
/// does: that is Postgres', SQLite's and MySQL's spelling.
fn begin_opens_transaction(next: Option<&String>) -> bool {
    next.is_none_or(|w| BEGIN_OPENS_TRANSACTION.contains(&w.as_str()))
}

/// The T-SQL block depth after a statement whose code words are `words`,
/// starting from `depth`: a block `BEGIN` or a `CASE` opens one, an `END`
/// closes one.
///
/// Splitting on `;` cuts T-SQL blocks into pieces, and the piece that closes
/// one is often a bare `END` — which on Postgres is `COMMIT`. The depth is
/// what tells them apart without knowing the engine: an `END` with a block
/// open closes it.
fn block_depth_after(words: &[String], depth: usize) -> usize {
    words
        .iter()
        .enumerate()
        .fold(depth, |d, (i, w)| match w.as_str() {
            "begin" if !begin_opens_transaction(words.get(i + 1)) => d + 1,
            "case" => d + 1,
            "end" => d.saturating_sub(1),
            _ => d,
        })
}

/// Whether a statement opens, ends or marks a transaction, or switches
/// autocommit — what this executor owns in transaction mode. `USE`, `SET`
/// (other than autocommit) and `LOCK` are session state the script may set.
///
/// `words` are the statement's code words and `depth` the T-SQL block depth
/// before it ([`block_depth_after`]). A statement that is T-SQL control flow
/// — `IF`, `WHILE`, `ELSE`, a block `BEGIN`, an `END` that closes a block —
/// is not transaction control by its head, and is by any `COMMIT`,
/// `ROLLBACK`, `BEGIN TRAN` or `SAVE TRAN` inside it: `IF @@TRANCOUNT > 0
/// ROLLBACK` would end this executor's transaction just as a bare one does.
fn is_transaction_control(head: &str, words: &[String], depth: usize) -> bool {
    let control_flow = match words.first().map(String::as_str) {
        Some("if" | "while" | "else") => true,
        Some("begin") => !begin_opens_transaction(words.get(1)),
        Some("end") => depth > 0,
        _ => false,
    };
    if control_flow {
        return words.iter().enumerate().any(|(i, w)| {
            let next = words.get(i + 1).map(String::as_str);
            matches!(w.as_str(), "commit" | "rollback")
                || (w == "begin" && matches!(next, Some("tran" | "transaction" | "distributed")))
                || (w == "save" && matches!(next, Some("tran" | "transaction")))
        });
    }
    if head.starts_with("set ") {
        return head.contains("autocommit") || head.contains("implicit_transactions");
    }
    crate::db::sql::is_session_statement(head)
        && !head.starts_with("use ")
        && !head.starts_with("lock ")
        && !head.starts_with("unlock ")
}

/// Keywords that need `full` wherever they sit in a statement's code. T-SQL
/// needs no `;` between statements (`SELECT 1 EXEC p` is two) and nests
/// them in control flow (`IF @x = 1 DROP TABLE t`), so the head alone does
/// not say what a SQL Server batch does. Every word here is reserved in
/// T-SQL, so as a column or table name it is quoted and not a code word.
const DDL_ANYWHERE: [&str; 17] = [
    "create",
    "drop",
    "alter",
    "truncate",
    "exec",
    "execute",
    "grant",
    "revoke",
    "deny",
    "dbcc",
    "kill",
    "backup",
    "restore",
    "shutdown",
    "reconfigure",
    "checkpoint",
    "bulk",
];

/// The verbs a statement's code words carry beyond its head
/// ([`DDL_ANYWHERE`], and every row write by name). A batch's first statement
/// may also be a bare procedure call — `sp_rename 'a', 'b'` runs with no
/// `EXEC` there — so a leading `sp_` / `xp_` name, or `ENABLE` / `DISABLE
/// TRIGGER`, is DDL too.
fn verbs_in_code(words: &[String]) -> Verbs {
    let head = words.first().map(String::as_str).unwrap_or_default();
    let mut verbs = if head.starts_with("sp_")
        || head.starts_with("xp_")
        || matches!(head, "enable" | "disable")
    {
        Verbs::DDL
    } else {
        Verbs::NONE
    };
    for w in words {
        verbs = verbs
            | match w.as_str() {
                w if DDL_ANYWHERE.contains(&w) => Verbs::DDL,
                "insert" => Verbs::INSERT,
                "update" => Verbs::UPDATE,
                "delete" => Verbs::DELETE,
                "merge" => Verbs::WRITES,
                _ => Verbs::NONE,
            };
    }
    verbs
}

/// Everything one statement of a script does: what the classifier reads in
/// it, as written and as MySQL executes it, plus every keyword in its code
/// ([`verbs_in_code`]).
fn statement_verbs(sql: &str) -> Verbs {
    let visible = unwrap_executable_comments(sql);
    crate::db::classify::verbs_of(sql)
        | crate::db::classify::verbs_of(&visible)
        | verbs_in_code(&crate::db::sql::code_words(sql))
        | verbs_in_code(&crate::db::sql::code_words(&visible))
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
/// statements ([`statement_verbs`]). On SQL Server a `GO` batch runs whole,
/// so this union is also what each batch needs.
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
        .map(|st| statement_verbs(st.sql))
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
    // T-SQL block depth, per `GO` batch: a block cannot span one.
    let (mut batch, mut depth) = (0usize, 0usize);
    for (i, st) in statements.iter().enumerate() {
        let visible = unwrap_executable_comments(st.sql);
        if is_blank(&visible) {
            continue;
        }
        if st.batch != batch {
            (batch, depth) = (st.batch, 0);
        }
        let words = crate::db::sql::code_words(&visible);
        let depth_before = depth;
        depth = block_depth_after(&words, depth);
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
        if transaction && is_transaction_control(&head, &words, depth_before) {
            return Err(AppError::InvalidInput(format!(
                "{} is or holds transaction control, and run_script already wraps the script \
                 in one transaction. Leave it out (on SQL Server a THROW alone is enough: \
                 run_script rolls everything back), or pass `transaction: false` to run the \
                 script's own BEGIN/COMMIT/ROLLBACK.",
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
        writes |= statement_verbs(st.sql).class() != crate::db::sql::StmtClass::Read;
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
    /// Index of the statement in the script, as error messages count them. On
    /// SQL Server, the first statement of the `GO` batch that returned it.
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
    /// SQL Server only: `GO` batches of more than one statement. A plain T-SQL
    /// batch does not report its row counts (only `sp_executesql` does, and
    /// nothing a batch leaves on the session would survive that), so
    /// `total_affected` leaves these out.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub uncounted_batches: usize,
    /// Result sets, from the statements that returned rows, in order. They
    /// share one `max_rows` budget across the script.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<ScriptRows>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

const ROLLED_BACK: &str = "The transaction was rolled back; nothing was changed.";

/// How a message names a unit: as its statement, or a batch by the range of
/// statements it holds.
fn unit_name(unit: &Unit<'_>, statements: &[ScriptStatement<'_>]) -> String {
    if unit.statements == 1 {
        return name(unit.first, &statements[unit.first]);
    }
    format!(
        "the GO batch of statements[{}..] (line {}: {})",
        unit.first,
        unit.line,
        crate::commands::query::stmt_preview(statements[unit.first].sql)
    )
}

/// The file line SQL Server reports a failure at, when it says: its error
/// carries the line within the batch, and the batch was sent from its first
/// statement, which starts on `unit.line`.
fn server_line(e: &AppError, unit: &Unit<'_>) -> Option<usize> {
    match e {
        AppError::MsSql(tiberius::error::Error::Server(t)) if t.line() > 0 => {
            Some(unit.line + t.line() as usize - 1)
        }
        _ => None,
    }
}

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
    let mssql = matches!(pool, DbPool::MsSql(_));
    let (begin, commit, rollback) = match pool {
        DbPool::Mysql(_) => ("START TRANSACTION", "COMMIT", "ROLLBACK"),
        DbPool::MsSql(_) => (
            // `XACT_ABORT` so an error anywhere in a batch dooms the
            // transaction and ends the batch, instead of the server carrying
            // on with the statements after it (module docs).
            "SET XACT_ABORT ON; BEGIN TRANSACTION",
            "COMMIT TRANSACTION",
            // Guarded: an error may already have rolled it back, and a bare
            // ROLLBACK would then fail with 3903 and close the session.
            "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
        ),
        _ => ("BEGIN", "COMMIT", "ROLLBACK"),
    };
    let script_start = Instant::now();
    let closing = |sql: &str, error: Option<&str>| {
        log_sql_sink(sink, connection_id, driver, sql, script_start, None, error);
    };

    // The session is closed when it drops, on every path out of here — see
    // the module docs for why it never goes back to the pool.
    let log = SqlLog::new(sink, connection_id, driver);
    let mut session = Session::acquire(&pool).await?;
    session.close_on_drop();
    if transaction {
        session.begin(begin).await?;
        closing(begin, None);
    }
    let mut left = max_rows;
    let mut ran = 0usize;
    let mut total_affected = 0u64;
    let mut uncounted_batches = 0usize;
    let mut results = Vec::new();
    for unit in units(script, &statements, mssql) {
        let (i, st) = (unit.first, &statements[unit.first]);
        let sql = unit.sql;
        let start = Instant::now();
        // A batch of several statements is fetched whatever it holds: its
        // result sets come back, and its row counts cannot (`uncounted_batches`).
        let whole_batch = unit.statements > 1;
        uncounted_batches += usize::from(whole_batch);
        let outcome: AppResult<u64> = if whole_batch || crate::db::sql::is_read_only(st.sql) {
            // Capped at what is left of the script's budget, not the
            // per-statement ceiling: the rows past it would only be shed.
            session.fetch(sql, left).await.map(|sets| {
                let mut produced = 0u64;
                // A read that matched nothing decodes no columns, and has no
                // panel to show.
                for set in sets.into_iter().filter(|s| !s.columns.is_empty()) {
                    let mut rows = set.rows;
                    produced += rows.len() as u64;
                    let over = rows.len() > left;
                    rows.truncate(left);
                    left -= rows.len();
                    results.push(ScriptRows {
                        statement: i,
                        line: st.line,
                        result: QueryResult::rows(
                            column_meta(set.columns),
                            rows,
                            start.elapsed().as_millis() as u64,
                        )
                        .with_truncated(set.truncated || over),
                    });
                }
                produced
            })
        } else {
            session.exec(sql).await.inspect(|n| total_affected += n)
        };
        match outcome {
            Ok(n) => {
                log.ok(sql, start, n);
                ran += unit.statements;
            }
            Err(e) => {
                let msg = e.to_string();
                log.err(sql, start, &msg);
                let at = server_line(&e, &unit)
                    .map(|line| format!(" (SQL Server reports line {line} of the script)"))
                    .unwrap_or_default();
                let reason = format!("{} failed{at}: {msg}", unit_name(&unit, &statements));
                if transaction {
                    // Best effort: the session is closed right after, which
                    // rolls back whatever this did not.
                    let _ = session.end(rollback).await;
                    closing(rollback, Some(&reason));
                    return Err(AppError::InvalidInput(format!("{reason}. {ROLLED_BACK}")));
                }
                let left_in_place = match ran {
                    0 => "nothing ran before it".to_string(),
                    1 => "the 1 statement before it ran and stays applied".to_string(),
                    n => format!("the {n} statements before it ran and stay applied"),
                };
                // Without XACT_ABORT, SQL Server goes on with the rest of a
                // batch after most errors; only the batches after it are sure
                // not to have run.
                let rest = if whole_batch {
                    "the statements after the failing one in this batch may have run (SQL \
                     Server carries on after most errors unless XACT_ABORT is ON); the batches \
                     after it did not run"
                } else {
                    "the rest did not run"
                };
                return Err(AppError::InvalidInput(format!(
                    "{reason}. No transaction was requested: {left_in_place}; {rest}."
                )));
            }
        }
    }
    if transaction {
        if let Err(e) = session.end(commit).await {
            let msg = format!("COMMIT failed: {e}");
            closing(commit, Some(&msg));
            return Err(AppError::InvalidInput(format!(
                "{msg}. The server did not keep the script's changes."
            )));
        }
        closing(commit, None);
    }
    Ok(ScriptResult {
        transaction,
        statements: ran,
        total_affected,
        uncounted_batches,
        results,
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

    /// The T-SQL a migration engine writes: one batch whose variable is read
    /// by several statements, inside a loop and a branch.
    const TSQL_LOOP: &str = "\
CREATE TABLE #n (i INT);
GO
DECLARE @i INT = 0;
WHILE @i < 3
BEGIN
    SET @i = @i + 1;
    IF @i % 2 = 1
    BEGIN
        INSERT INTO #n VALUES (@i);
    END
END;
MERGE INTO #n AS t USING (SELECT @i AS i) AS s ON t.i = s.i
WHEN NOT MATCHED THEN INSERT (i) VALUES (s.i);
SELECT i FROM #n ORDER BY i;
GO
SELECT @i AS i;
";

    #[test]
    fn sql_server_runs_each_go_batch_whole() {
        let statements = split_script(TSQL_LOOP);
        assert_eq!(statements.first().map(|s| s.batch), Some(0));
        assert_eq!(statements.last().map(|s| (s.batch, s.line)), Some((2, 16)));
        let got = units(TSQL_LOOP, &statements, true);
        assert_eq!(got.len(), 3);
        assert_eq!((got[0].first, got[0].statements), (0, 1));
        // The loop batch goes as written, from its DECLARE to the MERGE's
        // closing `;` and the SELECT after it — never cut at a `;`.
        let batch = got[1];
        assert_eq!(batch.line, 3);
        assert!(
            batch.sql.starts_with("DECLARE @i INT = 0;"),
            "{}",
            batch.sql
        );
        assert!(
            batch.sql.ends_with("SELECT i FROM #n ORDER BY i;"),
            "{}",
            batch.sql
        );
        assert!(batch.sql.contains("VALUES (s.i);\nSELECT"), "{}", batch.sql);
        assert_eq!(batch.statements, statements.len() - 2);
        assert_eq!((got[2].first, got[2].line), (statements.len() - 1, 16));
        // Every other engine still runs statement by statement.
        let each = units(TSQL_LOOP, &statements, false);
        assert_eq!(each.len(), statements.len());
        assert!(each.iter().all(|u| u.statements == 1));
    }

    #[test]
    fn a_batch_needs_what_any_of_its_statements_needs() {
        use crate::state::McpWritePolicy;
        let needs_full = |sql: &str| {
            let verbs = verbs_of_script(sql);
            !McpWritePolicy::Data.allows(verbs) && McpWritePolicy::Full.allows(verbs)
        };
        // A mixed batch: the EXEC makes it `full`, with or without the `;`
        // T-SQL does not require, and hidden in control flow.
        assert!(needs_full("SELECT * FROM t;\nEXEC dbo.load;"));
        assert!(needs_full("SELECT * FROM t\nEXEC dbo.load"));
        assert!(needs_full("INSERT INTO t VALUES (1)\nDROP TABLE x"));
        assert!(needs_full("DECLARE @x INT = 1;\nIF @x = 1 DROP TABLE t;"));
        assert!(needs_full(
            "BEGIN TRY\n  UPDATE t SET a = 1 WHERE a = 0;\nEND TRY\n\
             BEGIN CATCH\n  EXEC sp_rename 't', 'u';\nEND CATCH"
        ));
        assert!(needs_full("sp_rename 't', 'u'"));
        assert!(needs_full("INSERT INTO t EXEC dbo.rows"));
        assert!(needs_full("IF 1 = 1 TRUNCATE TABLE t"));
        assert!(needs_full(
            "UPDATE t SET a = 1 WHERE a = 0\nDBCC CHECKIDENT ('t', RESEED, 0)"
        ));
        assert!(needs_full(TSQL_LOOP));
        // Names and literals that spell a keyword are not one.
        let rows = verbs_of_script(
            "DECLARE @drop INT = 1;\nINSERT INTO #exec SELECT [create], 'alter' FROM t \
             WHERE note <> 'drop table';",
        );
        assert!(!rows.contains(Verbs::DDL), "{rows:?}");
        assert!(McpWritePolicy::Data.allows(rows));
        // A row write hidden behind a head that reads still needs `data`.
        let hidden = verbs_of_script("SELECT 1\nDELETE FROM t WHERE a = 1");
        assert!(hidden.contains(Verbs::DELETE) && !McpWritePolicy::ReadOnly.allows(hidden));
    }

    #[test]
    fn t_sql_blocks_are_not_transaction_control() {
        // The loop, TRY/CATCH and THROW run inside run_script's transaction.
        assert!(check_script(&split_script(TSQL_LOOP), true).is_ok());
        let try_catch = "BEGIN TRY\n  INSERT INTO t VALUES (1);\n  INSERT INTO t VALUES (2);\n\
                         END TRY\nBEGIN CATCH\n  THROW;\nEND CATCH;";
        assert!(check_script(&split_script(try_catch), true).is_ok());
        let case = "UPDATE t SET a = CASE WHEN b = 1 THEN 2 ELSE 3 END WHERE c = 1;\n\
                    INSERT INTO t VALUES (1);";
        assert!(check_script(&split_script(case), true).is_ok());
        // Transaction control is refused wherever it hides.
        for script in [
            "INSERT INTO t VALUES (1);\nIF @@TRANCOUNT > 0 ROLLBACK;",
            "BEGIN TRY\n  INSERT INTO t VALUES (1);\nEND TRY\nBEGIN CATCH\n  \
             IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\n  THROW;\nEND CATCH",
            "INSERT INTO t VALUES (1);\nIF 1 = 1 BEGIN TRAN;",
            "WHILE 1 = 1\nBEGIN\n  INSERT INTO t VALUES (1);\n  COMMIT;\nEND",
            "INSERT INTO t VALUES (1);\nBEGIN TRANSACTION;",
            // Postgres' bare BEGIN and END are still COMMIT's relatives.
            "INSERT INTO t VALUES (1);\nBEGIN;",
            "INSERT INTO t VALUES (1);\nEND;",
            "INSERT INTO t VALUES (1);\nBEGIN ISOLATION LEVEL SERIALIZABLE;",
        ] {
            let err = refusal(script, true);
            assert!(err.contains("transaction control"), "{script}: {err}");
            assert!(
                check_script(&split_script(script), false).is_ok(),
                "{script}"
            );
        }
        // A block does not span a GO: the END after one is Postgres' COMMIT
        // as far as the checks know, which is the strict reading.
        assert!(refusal(
            "WHILE 1 = 0\nBEGIN\n  INSERT INTO t VALUES (1);\nGO\nEND;",
            true
        )
        .contains("transaction control"));
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
