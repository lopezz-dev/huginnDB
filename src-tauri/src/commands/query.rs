//! Query execution and table-data commands.
//!
//! This file holds the `#[tauri::command]` wrappers only — each one checks the
//! managed policy (ADR #95) and hands over to the shared core in a submodule:
//!
//! * [`types`]     — the request and response DTOs (`TableQuery`, `QueryResult`, …).
//! * [`filter`]    — column filters, the raw `WHERE`, and the clause they build.
//! * [`statement`] — the rest of a browse's SQL: projection, `FROM`, `ORDER BY`,
//!   the page statement, and reading its plan.
//! * [`adhoc`]     — statements the user types: one, or a batch.
//! * [`browse`]    — the table browser's page and its row count.
//! * [`write`]     — `UPDATE` / `DELETE` / `INSERT` of rows from the grid.
//! * [`fk`]        — the foreign-key dropdown's options.
//!
//! Entry points:
//!
//! * [`execute_query`]   — run an arbitrary SQL statement provided by the
//!   user. Branches between fetch and execute depending on whether the
//!   statement looks read-only.
//! * [`fetch_table_data`] — paginated SELECT over a known table, with
//!   optional sort + column filters. Backs the table-data browser tab.
//! * [`update_cell`]     — UPDATE one column of one row by primary key.
//!   Drives inline / cell-editor edits in the grid.
//! * [`delete_rows`]     — DELETE one or more rows addressed by primary key.
//! * [`insert_row`]      — INSERT one row from a list of column/value pairs.
//!   Used by both the "insert" and "duplicate" flows in the grid.

use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::log_bus::SqlLog;
use crate::state::{AppState, DbPool};
use serde_json::Value;
use std::time::Instant;
use tauri::{AppHandle, State};

/// Unwrap a `Result<_, sqlx::Error>` produced by a SQL call and, on failure,
/// emit a SQL log entry through the [`LogSink`] plus early-return the error
/// from the enclosing command — analogous to `?` with an extra side-effect.
///
/// We use a macro (rather than an `async fn` helper) for two reasons:
///
/// 1. The success branch needs to stay in the caller's control flow so
///    each driver arm can keep using its own bespoke row-decoding logic
///    (`pg_value` vs `mysql_value` vs `sqlite_value`).
/// 2. `return Err(...)` from inside an async closure would not exit the
///    outer function; a macro expands inline and does.
macro_rules! try_sql_sink {
    ($sink:expr, $cid:expr, $driver:expr, $sql:expr, $start:expr, $res:expr) => {
        match $res {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                log_sql_sink($sink, $cid, $driver, $sql, $start, None, Some(&msg));
                return Err(e.into());
            }
        }
    };
}

// The logic lives in submodules; this file keeps only the `#[tauri::command]`
// wrappers. They have to stay here: ADR #95's test
// (`guard::tests::every_command_that_touches_a_database_calls_the_guard`)
// reads `src/commands/{module}.rs` to check that each registered command calls
// the policy guard, so a wrapper moved into a submodule would fail it — or,
// worse, stop being looked at. Everything the submodules define is re-exported
// below, so `commands::query::X` keeps resolving for every caller in the crate.
//
// `try_sql_sink!` is defined above these declarations on purpose: a
// `macro_rules!` macro is visible only to the modules declared after it.
mod adhoc;
mod bounded;
mod browse;
mod filter;
mod fk;
mod statement;
mod types;
mod write;

#[cfg(test)]
mod bind_type_tests;
#[cfg(test)]
mod filter_tests;

pub(crate) use adhoc::*;
pub(crate) use bounded::*;
pub(crate) use browse::*;
pub(crate) use filter::*;
pub(crate) use fk::*;
pub(crate) use statement::*;
pub(crate) use types::*;
pub(crate) use write::*;

/// Read the plan the browse `query` would use, without running it — the
/// query panel's *Explain*.
///
/// SQL: the page statement [`sql_page_statement`] builds for the browse itself,
/// prefixed by [`explain_prefix`] and run with its **real binds** (not the
/// Result line's inlined literals), so the plan is the plan of what executes.
/// MongoDB: Pulse's `explain` over the Result line's shell statement, at
/// `queryPlanner` verbosity, which plans and does not execute.
#[tauri::command]
pub async fn explain_table_query(
    state: State<'_, AppState>,
    query: TableQuery,
) -> AppResult<crate::pulse::ExplainPlan> {
    query.filter.validate()?;
    // Reading the relation, and — on SQL — the panel's hand-written expression,
    // which can reach any other relation and is free SQL (`guard::raw_filter`).
    crate::commands::guard::read(
        state.inner(),
        &query.connection_id,
        query.schema.as_deref(),
        &query.table,
    )?;
    crate::commands::guard::raw_filter(state.inner(), &query.connection_id, &query.filter)?;
    let pool = state.pool_for(&query.connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        let text = crate::db::mongo::query::describe_find_shell(&query)?;
        return crate::db::mongo::pulse::explain(conn, &text).await;
    }
    let dialect = Dialect::try_of(&pool)?;
    let prefix = explain_prefix(dialect)?;
    let types = page_bind_types(&pool, dialect, &query).await?;
    let (sql, binds) = sql_page_statement(dialect, &query, &types)?;
    let (columns, rows) =
        crate::db::exec::query_rows(&pool, &format!("{prefix}{sql}"), &binds).await?;
    Ok(crate::pulse::ExplainPlan {
        raw: plan_from_rows(dialect, &columns, rows),
    })
}

/// Describe the browse `query` would run, without running it.
///
/// SQL: the page statement with its binds inlined as literals (display only,
/// see [`inline_binds`]). MongoDB: a `db.<coll>.find(…)` statement in the
/// shell grammar the query tab parses, so "Open in editor" produces something
/// that tab runs as written. Either way a bad expression surfaces here, as the
/// error the browse itself would return — which is how the panel shows it
/// before the user applies it.
#[tauri::command]
pub async fn describe_table_query(
    state: State<'_, AppState>,
    query: TableQuery,
) -> AppResult<QueryPreview> {
    query.filter.validate()?;
    // Reading the relation, and — on SQL — the panel's hand-written expression,
    // which can reach any other relation and is free SQL (`guard::raw_filter`).
    crate::commands::guard::read(
        state.inner(),
        &query.connection_id,
        query.schema.as_deref(),
        &query.table,
    )?;
    crate::commands::guard::raw_filter(state.inner(), &query.connection_id, &query.filter)?;
    let pool = state.pool_for(&query.connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        let text = crate::db::mongo::query::describe_find_shell(&query)?;
        return Ok(QueryPreview {
            text,
            language: "mongodb",
        });
    }
    let dialect = Dialect::try_of(&pool)?;
    let types = page_bind_types(&pool, dialect, &query).await?;
    let (sql, binds) = sql_page_statement(dialect, &query, &types)?;
    Ok(QueryPreview {
        text: inline_binds(dialect, &sql, &binds),
        language: "sql",
    })
}

/// Execute an arbitrary SQL statement on the connection identified by
/// `connection_id`.
#[tauri::command]
pub async fn execute_query(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::free_sql(state.inner(), &connection_id, &sql)?;
    execute_with_state(&sink, state.inner(), &connection_id, &sql).await
}

/// Run a batch of statements sequentially on a single pooled connection.
///
/// The frontend splits the editor buffer into individual statements (reusing
/// its `splitSql` lexer) and sends them here as a list. We run them **on one
/// acquired connection**, in order, so that session-scoped state carries
/// across the batch: an explicit `BEGIN`/`COMMIT`, a MySQL `USE db`, temp
/// tables, `SET`s, etc. Acquiring a fresh connection per statement (what
/// `execute_query` does) would scatter them across the pool and silently break
/// the user's own transaction control.
///
/// We deliberately do **not** open an implicit transaction around the batch:
/// atomicity stays in the user's hands (and now works, because it's one
/// connection). Execution stops at the first failing statement — its error is
/// recorded in the corresponding [`StmtOutcome`] and later statements are
/// skipped, matching how a `;`-delimited paste aborts in a CLI client. The
/// Every statement that returns rows carries its own result sets, so a script
/// of several SELECTs produces a panel each instead of only the last one.
///
/// This is also the path that fixes multi-statement Ctrl+Enter: a single
/// `sqlx::query` over a `;`-joined buffer goes through the *prepared* protocol,
/// which rejects multiple commands; running them one at a time does not.
#[tauri::command]
pub async fn execute_batch(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    statements: Vec<String>,
) -> AppResult<BatchResult> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::free_sql_batch(state.inner(), &connection_id, &statements)?;
    execute_batch_inner(&sink, state.inner(), connection_id, statements).await
}

/// Fetch one page of rows from `schema.table`.
///
/// Generates `SELECT * FROM <table> [WHERE ...] [ORDER BY ...] LIMIT ?
/// OFFSET ?` plus a companion `SELECT COUNT(*)` so the UI can render an
/// exact pagination footer. Identifiers are quoted with the
/// driver-appropriate helper; filter values are always bound, never
/// interpolated.
#[tauri::command]
pub async fn fetch_table_data(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    query: TableQuery,
) -> AppResult<QueryResult> {
    let sink =
        crate::commands::entry_sink(&app, &window, state.inner(), &query.connection_id).await;
    // Reading the relation, and — on SQL — the panel's hand-written expression,
    // which can reach any other relation and is free SQL (`guard::raw_filter`).
    crate::commands::guard::read(
        state.inner(),
        &query.connection_id,
        query.schema.as_deref(),
        &query.table,
    )?;
    crate::commands::guard::raw_filter(state.inner(), &query.connection_id, &query.filter)?;
    fetch_table_data_inner(&sink, state.inner(), query).await
}

/// Count the rows of `schema.table` for the current predicate.
///
/// Split out of [`fetch_table_data`] so the count never gates the data
/// page's first paint (see [`CountResult`]). When the whole table is browsed
/// (no filters, no search) it returns the engine's O(1) statistics estimate;
/// with any predicate it runs an exact `COUNT(*)` — still off the render's
/// critical path because the frontend fires it as a separate request.
///
/// `exact` is the grid's *exact count* action: it skips the estimate even on a
/// whole-relation browse and lifts MongoDB's ceiling — see [`CountMode`].
#[tauri::command]
pub async fn count_table_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    query: TableScan,
    exact: Option<bool>,
) -> AppResult<CountResult> {
    let sink =
        crate::commands::entry_sink(&app, &window, state.inner(), &query.connection_id).await;
    // Reading the relation, and — on SQL — the panel's hand-written expression,
    // which can reach any other relation and is free SQL (`guard::raw_filter`).
    crate::commands::guard::read(
        state.inner(),
        &query.connection_id,
        query.schema.as_deref(),
        &query.table,
    )?;
    crate::commands::guard::raw_filter(state.inner(), &query.connection_id, &query.filter)?;
    count_table_rows_inner(
        &sink,
        state.inner(),
        query,
        CountMode::of(exact.unwrap_or(false)),
    )
    .await
}

/// Update one column of one row in `schema.table`, addressed by the
/// full primary key.
///
/// The new value is always sent as `Option<String>` because the cell
/// editor produces text. MySQL, SQLite and SQL Server coerce it to the
/// column type; on Postgres the statement casts it, and the key values, to
/// their columns' types (ADR #129). NULLs are conveyed by passing `None`.
///
/// Composite primary keys are supported: `pk_columns` is the ordered list
/// of column names that participate in the PK, and `pk_values` is the
/// parallel list of values for the row being updated. The WHERE clause is
/// `c1 = ? AND c2 = ? AND …` so the UPDATE can only ever match the single
/// row identified by the full key. If the resulting `rows_affected` is
/// greater than 1 the call returns an error: that would mean the supplied
/// columns are not actually unique together (caller bug) and quietly
/// touching multiple rows is exactly the corruption this signature was
/// designed to prevent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_cell(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_values: Vec<Value>,
    column: String,
    value: Option<String>,
    column_type: Option<String>,
) -> AppResult<u64> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::UPDATE,
    )?;
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::UPDATE,
        [&column],
    )?;
    update_cell_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_columns,
        pk_values,
        column,
        value,
        column_type,
    )
    .await
}

/// Remove a field from one MongoDB document (`$unset`), addressed by `_id`.
///
/// The document list view's "delete field" action. MongoDB only: a SQL row has
/// a fixed column set, so removing a *field* from a single row has no meaning
/// there (setting it to NULL does, and that already goes through
/// [`update_cell`]) — the other drivers are rejected rather than silently
/// mapped onto something else.
///
/// `field` is a path (`"customData.format"`, `"tags.2"`), matching the way the
/// same list view addresses a nested field on the write side of
/// [`update_cell`].
#[tauri::command]
pub async fn unset_field(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    id_value: Value,
    field: String,
) -> AppResult<u64> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::UPDATE,
    )?;
    // Removing a field changes it, as setting one does.
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::UPDATE,
        [&field],
    )?;
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();
    let DbPool::Mongo(conn) = &pool else {
        return Err(AppError::InvalidInput(
            "unset_field is only supported for MongoDB".into(),
        ));
    };
    let start = Instant::now();
    let res = crate::db::mongo::query::unset_field(conn, &collection, &id_value, &field).await;
    SqlLog::new(&sink, &connection_id, driver).outcome("(mongo unset)", start, res, |n| *n)
}

/// Delete one or more rows from `schema.table` identified by their
/// (possibly composite) primary key.
///
/// `pk_columns` lists the columns that make up the PK in the order the
/// frontend captured them; `pk_value_rows` carries one tuple of values per
/// row to delete, parallel to `pk_columns`. The WHERE clause is built as
/// `(c1, c2, …) IN ((?, ?, …), …)` so the DELETE only ever touches rows
/// whose *full* key matches a supplied tuple — sending only the leading
/// PK column used to fan the DELETE out across every row sharing that
/// value (the same family of bug as the cell-save corruption that
/// motivated this signature change).
///
/// Returns the number of rows actually deleted; that should equal
/// `pk_value_rows.len()` when every key existed, and less if any did not.
// The argument list is the IPC surface, not a design choice: a `#[tauri::command]`
// receives flat named arguments from `invoke`, and `app`/`window`/`state` are
// injected by Tauri rather than passed by the caller. Collapsing these into a
// struct would change the shape the frontend calls with for no gain here. (The
// same allow on the `_inner` helpers below is a different matter — those are
// plain Rust functions and genuinely want a request struct.)
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn delete_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_value_rows: Vec<Vec<Value>>,
) -> AppResult<u64> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::DELETE,
    )?;
    delete_rows_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_columns,
        pk_value_rows,
    )
    .await
}

/// Insert one row into `schema.table`.
///
/// `values` carries the columns the caller wants to populate; any column
/// omitted will fall back to the database default. Bound values are sent
/// as text, matching [`update_cell`]'s semantics — cast to each column's
/// type in the SQL on Postgres (ADR #129).
///
/// When `pk_column` is provided on Postgres, the statement is suffixed
/// with `RETURNING <pk>` and the generated value is returned to the
/// frontend. MySQL/SQLite return the last insert id when available; if
/// neither path applies the response is `null`.
// Flat argument list is the IPC surface — see the note on `delete_rows`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn insert_row(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: Option<String>,
    values: Vec<RowValue>,
) -> AppResult<Value> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
    )?;
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
        values.iter().map(|v| &v.column),
    )?;
    insert_row_inner(
        &sink,
        state.inner(),
        connection_id,
        schema,
        table,
        pk_column,
        values,
    )
    .await
}

/// Insert one or more MongoDB documents written as source text.
///
/// The free-form counterpart to [`insert_row`]. That command takes
/// column/value pairs, which is the right shape for a SQL row and the wrong
/// one for a collection: the grid's column set is inferred from a sampled
/// page, so it describes what the documents it happened to read contain, not
/// what a document *may* contain. Through that path a field the sample did not
/// show could not be added at all.
///
/// MongoDB only, and refused elsewhere rather than approximated. A SQL table
/// has a column set the server will enforce, so there is nothing for free-form
/// document text to express there that [`insert_row`] cannot.
///
/// That argument is about *shape*, and it still holds — but it was never an
/// argument against pasting rows into a SQL table, which is a different want
/// and now has [`crate::commands::insert::insert_rows`]. What that command
/// adds is **bulk**: [`insert_row`] is one row per call, so an array of forty
/// had no path at all. It parses strict JSON rather than the mongosh grammar
/// this one accepts, and validates every key against the catalogue, both of
/// which are exactly the things a table's column set makes possible.
///
/// Audited through the same sink as every other write, so the insert appears
/// in the Console next to the statements around it.
#[tauri::command]
pub async fn insert_documents(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    source: String,
) -> AppResult<Value> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::INSERT,
    )?;
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();
    let DbPool::Mongo(conn) = &pool else {
        return Err(AppError::UnsupportedDriver(
            "insert_documents: writing a document as source text is MongoDB-only".into(),
        ));
    };

    // Parse before touching the server, so a typo is a message and not a
    // partially-applied insert.
    let documents = crate::db::mongo::query::parse_insert_source(&source)?;
    let count = documents.len() as u64;
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::INSERT,
        documents.iter().flat_map(|d| d.keys()),
    )?;

    let start = Instant::now();
    let res = crate::db::mongo::query::insert_documents(conn, &collection, documents).await;
    SqlLog::new(&sink, &connection_id, driver).outcome("(mongo insert)", start, res, |_| count)
}

/// Fetch a page of distinct primary-key values (with an optional human
/// label) from a foreign-key target table. Powers the inline FK combobox
/// in the data grid.
///
/// Identifiers are validated against the live catalog via
/// [`list_columns_inner`] before they reach [`Dialect::quote_ident`] — keeps us
/// aligned with the rule in `SECURITY.md` that `quote_ident` is only ever
/// applied to catalog-sourced names. The optional `search` is passed as a
/// bound LIKE/ILIKE pattern with escape handling.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_fk_options(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    key_column: String,
    label_column: Option<String>,
    search: Option<String>,
    limit: i64,
) -> AppResult<FkOptionsPage> {
    // Reopen a reaped child pool *before* the catalog lookup below — it goes
    // through `list_columns_inner`, which resolves the pool itself and would
    // otherwise fail with `NotConnected` before this function ever reaches
    // its own `pool_for` call further down.
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    // The options come from the key's *target* table — a relation other than
    // the one on screen, which the person must be able to read in its own right.
    crate::commands::guard::read(state.inner(), &connection_id, schema.as_deref(), &table)?;

    fetch_fk_options_inner(
        state.inner(),
        &connection_id,
        schema,
        table,
        key_column,
        label_column,
        search,
        limit,
    )
    .await
}
