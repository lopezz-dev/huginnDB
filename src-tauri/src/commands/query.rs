//! Query execution and table-data commands.
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

use crate::commands::insert::{build_insert_statement, InsertClauses, InsertColumn};
use crate::commands::schema::list_columns_inner;
use crate::db::mysql;
use crate::db::sql::{is_read_only, Dialect};
use crate::db::values::{
    mysql_columns, mysql_value, pg_columns, pg_value, sqlite_columns, sqlite_value,
};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use serde_json::Value;
// Brought into scope for `<&Pool>::execute(&str)` / `<&mut Conn>::execute(&str)`
// in the ad-hoc DML paths. Passing a `&str` (no bound arguments) runs through
// sqlx's text/simple-query protocol — the unprepared path — whereas
// `sqlx::query(sql)` always prepares. Inherent `Query::execute` calls elsewhere
// are unaffected (inherent methods win over the trait).
use sqlx::Executor as _;
use std::collections::HashSet;
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

/// Comparison operator accepted by [`ColumnFilter`].
///
/// The set is intentionally closed so we can map each variant to a fixed
/// SQL fragment without going through user-supplied strings. All variants
/// except `IsNull` / `IsNotNull` consume the filter's bound `value`; the
/// frontend advanced-filter builder (#66) only *offers* the type-appropriate
/// subset per column, but the backend accepts any op on any column and lets
/// the driver coerce the textual literal.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    /// `LIKE %v%` (case-insensitive via `ILIKE` on Postgres).
    Contains,
    /// `NOT LIKE %v%`.
    NotContains,
    /// `LIKE v%`.
    StartsWith,
    /// `LIKE %v`.
    EndsWith,
    /// `>` / `>=` / `<` / `<=` — numeric/date comparisons; the value is bound
    /// and the driver casts it to the column type.
    Gt,
    Gte,
    Lt,
    Lte,
    /// `BETWEEN v1 AND v2` (inclusive). Consumes both `value` and `value2`.
    Between,
    /// `IN (v1, v2, …)` / `NOT IN (…)`. The only ops that read the filter's
    /// `values` list instead of `value`/`value2`; driven by the data grid's
    /// "filter by the selected rows" action (#114).
    In,
    NotIn,
    IsNull,
    IsNotNull,
}

/// The predicate half of a table browse: the structured column filters (the
/// grid's chips) plus the free-text needle and the columns it searches.
///
/// These three travelled together as three separate parameters through
/// `fetch_table_data`, `count_table_rows`, `export_table_rows`, their `_inner`
/// cores and four MongoDB entry points — always all three, always in that
/// order, always `Option`-wrapped and immediately unwrapped to the same
/// defaults on the other side. Splitting a needle from the columns it applies
/// to silently searches nothing, so they are one value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    #[serde(default)]
    pub filters: Vec<ColumnFilter>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub search_columns: Vec<String>,
    /// A hand-written predicate, ANDed with everything above — the query
    /// panel's *expression*. Its language is the connection's: a `WHERE`
    /// fragment on SQL (see [`validate_raw_where`]), a filter document on
    /// MongoDB (see `db::mongo::query::predicate_doc`).
    ///
    /// ANDed rather than replacing the structured filters on purpose: the
    /// chips stay a bijection with the panel's condition rows, and nothing has
    /// to be translated between the two forms — a translation that is lossy in
    /// both directions (not every document is a flat AND list, and not every
    /// condition a user can type survives being re-rendered).
    #[serde(default)]
    pub raw: Option<String>,
}

impl TableFilter {
    /// The committed needle, or `None` when it is absent *or empty*. An empty
    /// string is not a predicate — treating it as one turns `LIKE '%%'` into a
    /// reason to skip the fast catalog estimate in [`count_table_rows_inner`].
    pub fn needle(&self) -> Option<&str> {
        self.search.as_deref().filter(|s| !s.is_empty())
    }

    /// The expression, or `None` when it is absent *or blank* — the same
    /// "an empty string is not a predicate" rule as [`Self::needle`].
    pub fn raw_text(&self) -> Option<&str> {
        self.raw.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// True when this selects the whole relation. Only then may a count be
    /// served from the engine's statistics rather than an exact `COUNT(*)`.
    pub fn is_unfiltered(&self) -> bool {
        self.filters.is_empty() && self.needle().is_none() && self.raw_text().is_none()
    }

    fn validate(&self) -> AppResult<()> {
        validate_filters(&self.filters)
    }

    /// The `WHERE` clause and its binds for `dialect`, placeholders from 1,
    /// with the expression (validated) ANDed on the end.
    ///
    /// The expression goes on **its own lines inside its own parentheses**:
    /// the parentheses keep an `OR` in it from escaping the `AND` that binds it
    /// to the chips, and the line breaks keep a trailing `-- comment` from
    /// commenting out the `ORDER BY` / `LIMIT` that follow it.
    pub(crate) fn clause(&self, dialect: Dialect) -> AppResult<(String, Vec<Option<String>>)> {
        let (built, binds) =
            build_filter_clause(dialect, &self.filters, self.needle(), &self.search_columns);
        let Some(raw) = self.raw_text() else {
            return Ok((built, binds));
        };
        validate_raw_where(raw)?;
        let expr = format!("(\n{raw}\n)");
        if built.is_empty() {
            Ok((format!(" WHERE {expr}"), binds))
        } else {
            Ok((format!("{built} AND {expr}"), binds))
        }
    }
}

/// Refuse a SQL expression that would not stay *one condition*.
///
/// The expression is the user's own text on the user's own connection — the
/// query editor next door runs anything at all, so this is not a security
/// boundary and does not pretend to be one. What it guards is the statement
/// the expression is spliced into. It rejects four shapes, each of which
/// would turn "filter this browse" into something else:
///
/// - a `;` outside a string or comment, which ends the `SELECT` and starts a
///   second statement;
/// - unbalanced parentheses, which would let part of the expression escape
///   the parentheses that AND it to the chips (`a = 1) OR (1 = 1`);
/// - an unterminated string, quoted identifier or `/* comment`, which would
///   swallow the `ORDER BY` and `LIMIT` after it.
///
/// A `-- comment` is allowed: [`TableFilter::clause`] ends the expression
/// with a line break.
pub(crate) fn validate_raw_where(raw: &str) -> AppResult<()> {
    let bad = |why: &str| Err(AppError::InvalidInput(format!("expression: {why}")));
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    let mut depth: i64 = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\'' | '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return bad("a string or quoted name is never closed"),
                        // A doubled quote is an escaped one, in every dialect.
                        Some(&ch)
                            if ch == close && chars.get(i + 1) == Some(&close) && c != '[' =>
                        {
                            i += 2;
                        }
                        Some(&ch) if ch == close => break,
                        Some(_) => i += 1,
                    }
                }
            }
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '/' if next == Some('*') => {
                i += 2;
                loop {
                    match (chars.get(i), chars.get(i + 1)) {
                        (Some('*'), Some('/')) => {
                            i += 1;
                            break;
                        }
                        (None, _) => return bad("a /* comment is never closed"),
                        _ => i += 1,
                    }
                }
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return bad("a ) closes more than was opened");
                }
            }
            ';' => return bad("a ; would end the statement — write one condition"),
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return bad("a ( is never closed");
    }
    Ok(())
}

/// Render `sql` with its bind placeholders replaced by SQL literals, for
/// **display only** — the query panel's *Result* line and "Open in editor".
/// What runs is always the parameterised statement.
///
/// Placeholders are found by scanning, not by text replacement, so a `?` or a
/// `$1` inside a quoted identifier or a string literal is left alone. Values
/// are the binds' text form (every browse bind is a string), quoted with the
/// dialect's escaping; the engine coerces them against the column exactly as
/// it coerces the bound parameter.
pub(crate) fn inline_binds(dialect: Dialect, sql: &str, binds: &[Option<String>]) -> String {
    let literal = |i: usize| -> String {
        match binds.get(i) {
            Some(Some(v)) => {
                let mut v = v.replace('\'', "''");
                if matches!(dialect, Dialect::Mysql) {
                    v = v.replace('\\', "\\\\");
                }
                format!("'{v}'")
            }
            _ => "NULL".to_string(),
        }
    };
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    let mut sequential = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                out.push(c);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == close {
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '?' if matches!(dialect, Dialect::Mysql | Dialect::Sqlite) => {
                out.push_str(&literal(sequential));
                sequential += 1;
                i += 1;
            }
            '$' if matches!(dialect, Dialect::Postgres)
                && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) =>
            {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                let n: usize = chars[start..end]
                    .iter()
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
                out.push_str(&literal(n.saturating_sub(1)));
                i = end;
            }
            '@' if matches!(dialect, Dialect::MsSql)
                && chars.get(i + 1) == Some(&'P')
                && chars.get(i + 2).is_some_and(|d| d.is_ascii_digit()) =>
            {
                let start = i + 2;
                let mut end = start;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                let n: usize = chars[start..end]
                    .iter()
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
                out.push_str(&literal(n.saturating_sub(1)));
                i = end;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// The page statement a SQL browse runs, and its binds — shared by
/// [`fetch_table_data_inner`] and [`describe_table_query`], so the query
/// panel's *Result* line is built by the code that builds what executes and
/// cannot drift from it.
fn sql_page_statement(
    dialect: Dialect,
    q: &TableQuery,
) -> AppResult<(String, Vec<Option<String>>)> {
    let order_clause = order_by_clause(dialect, &q.order, nonblank(&q.collation))?;
    let select = select_list(dialect, q.projection.as_ref())?;
    let (where_clause, binds) = q.filter.clause(dialect)?;
    let qt = dialect.qualify_defaulted(q.schema.as_deref(), &q.table);
    let from = from_clause(dialect, &qt, nonblank(&q.hint))?;
    // LIMIT/OFFSET stay inline (they are integers we already parsed), so the
    // filter binds are the only binds in the statement. The clause itself is
    // dialect-specific: T-SQL has no LIMIT and its OFFSET/FETCH form requires
    // an ORDER BY, which `paginate` supplies when the user hasn't sorted.
    let page = dialect.paginate(q.limit, q.offset, !order_clause.is_empty());
    Ok((
        format!("SELECT {select} FROM {from}{where_clause}{order_clause}{page}"),
        binds,
    ))
}

/// The `EXPLAIN` form each SQL engine reads a plan with **without running the
/// statement**. SQL Server's plan needs `SET SHOWPLAN_XML ON` in a batch of its
/// own, which the single-statement executor cannot issue, so it is refused with
/// that reason rather than approximated.
fn explain_prefix(dialect: Dialect) -> AppResult<&'static str> {
    match dialect {
        Dialect::Postgres => Ok("EXPLAIN (FORMAT JSON) "),
        Dialect::Mysql => Ok("EXPLAIN FORMAT=JSON "),
        Dialect::Sqlite => Ok("EXPLAIN QUERY PLAN "),
        Dialect::MsSql => Err(AppError::UnsupportedDriver(
            "explain: SQL Server's plan needs SHOWPLAN in a batch of its own, which the \
             query panel cannot issue yet"
                .into(),
        )),
    }
}

/// Turn the rows an `EXPLAIN` returned into the plan the panel renders.
///
/// PostgreSQL and MySQL answer with one JSON document in one cell — decoded
/// already on PostgreSQL (`json` column), as text on MySQL — so that cell *is*
/// the plan. SQLite's `EXPLAIN QUERY PLAN` answers with rows
/// (`id, parent, notused, detail`), kept as one object per step, which is the
/// tree the sqlite3 shell draws.
fn plan_from_rows(
    dialect: Dialect,
    columns: &[(String, String)],
    rows: Vec<Vec<serde_json::Value>>,
) -> serde_json::Value {
    use serde_json::Value;
    match dialect {
        Dialect::Sqlite => Value::Array(
            rows.into_iter()
                .map(|r| {
                    let mut step = serde_json::Map::new();
                    for (i, (name, _)) in columns.iter().enumerate() {
                        if name == "notused" {
                            continue;
                        }
                        step.insert(name.clone(), r.get(i).cloned().unwrap_or(Value::Null));
                    }
                    Value::Object(step)
                })
                .collect(),
        ),
        _ => match rows.into_iter().next().and_then(|r| r.into_iter().next()) {
            Some(Value::String(text)) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
            Some(v) => v,
            None => Value::Null,
        },
    }
}

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
    let (sql, binds) = sql_page_statement(dialect, &query)?;
    let (columns, rows) =
        crate::db::exec::query_rows(&pool, &format!("{prefix}{sql}"), &binds).await?;
    Ok(crate::pulse::ExplainPlan {
        raw: plan_from_rows(dialect, &columns, rows),
    })
}

/// What the query panel's *Result* line shows: the statement a browse would
/// run, in the language of the connection's own editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPreview {
    pub text: String,
    /// `"sql"` or `"mongodb"` — which editor "Open in editor" should expect.
    pub language: &'static str,
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
    let (sql, binds) = sql_page_statement(dialect, &query)?;
    Ok(QueryPreview {
        text: inline_binds(dialect, &sql, &binds),
        language: "sql",
    })
}

/// Which fields a browse returns — the query panel's *Projection* row.
///
/// `None`, or an empty `fields` list, means every field: the absent value is
/// the one every caller that predates projection sends, so it must keep meaning
/// what `SELECT *` meant.
///
/// `exclude` is MongoDB's: `{ a: 0 }` leaves `a` out and keeps the rest. SQL
/// has no `SELECT * EXCEPT` in any of the four dialects, and rewriting one into
/// a column list needs the catalog, which the frontend already holds — so a SQL
/// browse only ever receives an inclusion list, and an exclusion reaching it is
/// rejected rather than guessed at (see [`select_list`]).
///
/// The key columns are the caller's business, not this type's. The grid
/// addresses a row by its primary key (and a document by its `_id`) for every
/// edit, so the frontend always includes them; a headless caller asking for a
/// partial row it will not edit is entitled to one.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub exclude: bool,
}

impl Projection {
    /// The projection that actually narrows anything, or `None` for "all
    /// fields" however it was spelled.
    pub fn narrowing(p: Option<&Projection>) -> Option<&Projection> {
        p.filter(|p| !p.fields.is_empty())
    }
}

/// The `SELECT` list for a SQL browse: the quoted projected columns, or `*`.
pub(crate) fn select_list(dialect: Dialect, projection: Option<&Projection>) -> AppResult<String> {
    match Projection::narrowing(projection) {
        None => Ok("*".to_string()),
        Some(p) if p.exclude => Err(AppError::InvalidInput(
            "an exclusion projection is MongoDB-only; a SQL browse takes the list of columns to return"
                .into(),
        )),
        Some(p) => Ok(p
            .fields
            .iter()
            .map(|c| dialect.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")),
    }
}

/// An optional text field of the browse, trimmed, or `None` when blank.
pub(crate) fn nonblank(o: &Option<String>) -> Option<&str> {
    o.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// ` COLLATE <name>` for a SQL sort key, or `""` for none.
///
/// A collation cannot be a bind parameter in any of the four dialects, so the
/// name is interpolated — which is why each dialect gets the narrowest spelling
/// it accepts. PostgreSQL names are identifiers (`"es-ES-x-icu"`, `"C"`) and go
/// through [`Dialect::quote_ident`]; MySQL and SQL Server names are bare words
/// (`utf8mb4_spanish_ci`, `Latin1_General_CI_AS`) and must be exactly that;
/// SQLite has three built-in collations and nothing else to name.
pub(crate) fn collate_clause(dialect: Dialect, collation: Option<&str>) -> AppResult<String> {
    let Some(name) = collation else {
        return Ok(String::new());
    };
    let word = |n: &str| n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    match dialect {
        Dialect::Postgres => Ok(format!(" COLLATE {}", dialect.quote_ident(name))),
        Dialect::Sqlite => {
            let upper = name.to_ascii_uppercase();
            if matches!(upper.as_str(), "BINARY" | "NOCASE" | "RTRIM") {
                Ok(format!(" COLLATE {upper}"))
            } else {
                Err(AppError::InvalidInput(
                    "collation: SQLite has BINARY, NOCASE and RTRIM".into(),
                ))
            }
        }
        Dialect::Mysql | Dialect::MsSql if word(name) => Ok(format!(" COLLATE {name}")),
        Dialect::Mysql | Dialect::MsSql => Err(AppError::InvalidInput(format!(
            "collation: `{name}` is not a collation name (letters, digits and _ only)"
        ))),
    }
}

/// The `FROM` target of a SQL browse, with the index hint when there is one.
///
/// Every engine but PostgreSQL has a syntax for it — MySQL's `FORCE INDEX`,
/// SQLite's `INDEXED BY`, SQL Server's `WITH (INDEX(…))` — and each makes the
/// statement **fail** rather than silently ignore a missing index, which is
/// the honest behaviour for a control the user set on purpose. PostgreSQL's
/// planner takes no hints without an extension, so a hint there is refused
/// with that reason instead of being dropped.
pub(crate) fn from_clause(dialect: Dialect, qt: &str, hint: Option<&str>) -> AppResult<String> {
    let Some(index) = hint else {
        return Ok(qt.to_string());
    };
    let q = dialect.quote_ident(index);
    match dialect {
        Dialect::Postgres => Err(AppError::InvalidInput(
            "index hint: PostgreSQL has no index hints; its planner chooses on its own".into(),
        )),
        Dialect::Mysql => Ok(format!("{qt} FORCE INDEX ({q})")),
        Dialect::Sqlite => Ok(format!("{qt} INDEXED BY {q}")),
        Dialect::MsSql => Ok(format!("{qt} WITH (INDEX({q}))")),
    }
}

/// The multi-level `ORDER BY` for a SQL browse, or `""` when unsorted.
/// Identifiers are quoted; only the ASC/DESC keyword and the validated
/// collation (see [`collate_clause`]) are interpolated.
pub(crate) fn order_by_clause(
    dialect: Dialect,
    order: &[SortSpec],
    collation: Option<&str>,
) -> AppResult<String> {
    if order.is_empty() {
        return Ok(String::new());
    }
    let collate = collate_clause(dialect, collation)?;
    let parts: Vec<String> = order
        .iter()
        .map(|s| {
            let dir = if s.desc { "DESC" } else { "ASC" };
            format!("{}{collate} {dir}", dialect.quote_ident(&s.column))
        })
        .collect();
    Ok(format!(" ORDER BY {}", parts.join(", ")))
}

/// A table plus a predicate over it, with no paging — what
/// [`count_table_rows`] and `export_table_rows` address.
///
/// `order` and `projection` are the browse's *shape*. The export reads them so
/// "export query results" writes what the grid shows, in the order it shows
/// it; the count ignores both, since neither changes how many rows match.
///
/// `filter` is `#[serde(flatten)]`ed, so the IPC payload stays the flat object
/// the frontend already sent (`{ connectionId, schema, table, filters, search,
/// searchColumns }`); only the Rust side gained the grouping.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableScan {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    #[serde(flatten)]
    pub filter: TableFilter,
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(default)]
    pub projection: Option<Projection>,
    /// See [`TableQuery::collation`]. Read by the export (its order) and by the
    /// MongoDB count, where a collation changes which documents match.
    #[serde(default)]
    pub collation: Option<String>,
    /// See [`TableQuery::hint`]. Read by the export.
    #[serde(default)]
    pub hint: Option<String>,
}

/// One page of a table browse: a [`TableScan`]'s address and predicate, plus
/// the ordering, the window and whether to count.
///
/// Declared as one struct rather than embedding [`TableScan`] because a
/// doubly-flattened payload is harder to read than the nine fields it stands
/// for, and this is the shape the frontend types mirror (see `TableQuery` in
/// `src/types.ts` — a field missing on either side is silently dropped by
/// serde, gotcha #14, which is what the round-trip test at the
/// bottom of this module pins down).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub limit: i64,
    pub offset: i64,
    /// Ordered multi-column sort; `order[0]` is the primary key.
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(flatten)]
    pub filter: TableFilter,
    /// Fields to return; `None` is every field. See [`Projection`].
    #[serde(default)]
    pub projection: Option<Projection>,
    /// The query panel's *Collation*. SQL: a collation **name**, applied to
    /// every `ORDER BY` key (see [`collate_clause`]). MongoDB: a collation
    /// **document** (`{ locale: 'es', strength: 1 }`), which the server applies
    /// to the filter and the sort alike. Blank is none.
    #[serde(default)]
    pub collation: Option<String>,
    /// The query panel's *Index (hint)*: the name of an index the planner must
    /// use. See [`from_clause`] for the per-dialect syntax, and for PostgreSQL,
    /// which has none. Blank is none.
    #[serde(default)]
    pub hint: Option<String>,
    /// Whether to run the companion `SELECT COUNT(*)`. The GUI passes `false`
    /// when only the sort/offset/page changed (the total cannot have moved)
    /// and reuses its cached total, saving a round trip per interaction; the
    /// headless MCP `browse_table` tool wants the inline count. Defaults to
    /// `true` when the key is absent, which is the pre-struct behaviour of
    /// `Option<bool>::unwrap_or(true)`.
    #[serde(default = "with_count_default")]
    pub with_count: bool,
}

fn with_count_default() -> bool {
    true
}

/// One column-level predicate applied by [`fetch_table_data`].
///
/// Multiple filters are AND-composed. Identifiers are always quoted via
/// [`Dialect::quote_ident`]; values are sent as binds, never interpolated into the
/// SQL string.
#[derive(Debug, Deserialize, Clone)]
pub struct ColumnFilter {
    pub column: String,
    pub op: FilterOp,
    /// Bound value. Always `None` for `IsNull` / `IsNotNull`; coerced
    /// through [`json_to_string`] for `Eq` / `Ne`.
    #[serde(default)]
    pub value: Value,
    /// Second bound value, only consumed by `Between` (the range's upper
    /// bound). Ignored by every other op.
    #[serde(default)]
    pub value2: Value,
    /// Value list, only consumed by `In` / `NotIn`. Ignored by every other op.
    /// Capped at [`MAX_IN_VALUES`] by [`validate_filters`] before any SQL is
    /// built.
    #[serde(default)]
    pub values: Vec<Value>,
}

/// One level of an `ORDER BY` clause built by [`fetch_table_data`].
///
/// The frontend sends an ordered list (`order[0]` is the primary sort key,
/// `order[1]` the tie-breaker, …) so the data browser can sort by several
/// columns at once. Identifiers are quoted via [`Dialect::quote_ident`]; only the
/// `ASC`/`DESC` keyword is interpolated, derived from the boolean.
#[derive(Debug, Deserialize, Clone)]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// One column/value pair used to build an INSERT statement.
///
/// We use parallel positional encoding (`Vec<RowValue>`) instead of a
/// `HashMap` so column order is preserved verbatim from the frontend —
/// otherwise we cannot pair columns with their placeholders deterministically.
/// `Serialize` as well, for the same reason as [`QueryResult`]: the bridge
/// carries these to whichever process owns the pool.
#[derive(Debug, Serialize, Deserialize)]
pub struct RowValue {
    pub column: String,
    /// Always a string or `null`. The cell editor and `RowEditor` dialog
    /// produce text only; drivers cast textual literals to the target type.
    pub value: Option<String>,
    /// Raw `data_type` string from `ColumnMeta` (e.g. `"BIT"` for MySQL BIT
    /// columns). Used to detect columns that need special binding (see
    /// `insert_row`'s MySQL BIT handling). `None` when the frontend has no
    /// type information (safe default: no special handling).
    ///
    /// Spelled `columnType` on the wire, with `column_type` accepted as an
    /// alias. Tauri renames a command's *top-level* arguments from camelCase
    /// but leaves the fields of a nested struct to serde, and a `RowValue`
    /// always arrives nested (`values: Vec<RowValue>`, `setValues: …`). The
    /// frontend sends `columnType`, so without the rename serde dropped it as
    /// an unknown field and every hint read as `None`: a MongoDB insert or
    /// duplicate wrote each field as a string (`string_to_bson`'s fallback
    /// arm), SQL Server lost its binary `CONVERT`, and MySQL only kept `BIT`
    /// working because of the catalogue fallback in `insert_row_inner`.
    #[serde(default, rename = "columnType", alias = "column_type")]
    pub column_type: Option<String>,
}

/// Result set returned to the frontend.
///
/// `Deserialize` as well as `Serialize` since the MCP bridge sends this back
/// across a process boundary: the sidecar re-reads it to apply its `--max-rows`
/// cap before handing it to the model.
#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    /// Columns of the result set, in order.
    pub columns: Vec<ColumnMeta>,
    /// One inner `Vec` per row, with values aligned to `columns`.
    pub rows: Vec<Vec<Value>>,
    /// Number of rows affected (`UPDATE`/`DELETE`/`INSERT`) or returned
    /// (`SELECT`).
    pub rows_affected: u64,
    /// Wall-clock time of the round-trip in milliseconds.
    pub elapsed_ms: u64,
    /// For [`fetch_table_data`] only: the total row count of the table
    /// (so the UI can show "1–100 of 12,345").
    pub total: Option<u64>,
    /// `true` when the driver returned more rows than [`MAX_ADHOC_QUERY_ROWS`]
    /// and the excess was discarded rather than sent to the frontend. Only
    /// ever set on a hand-typed SELECT with no `LIMIT`/`TOP`/`.limit()` of its
    /// own — [`fetch_table_data`] always paginates server-side and never
    /// truncates.
    #[serde(default)]
    pub truncated: bool,
    /// MongoDB only: the per-cell BSON *type* structure mirroring `rows`, one
    /// inner `Vec` per row aligned to `columns` (see
    /// [`crate::db::mongo::values::bson_type_tree`]).
    ///
    /// The SQL drivers leave this `None`: their column types are uniform per
    /// column and already carried by [`ColumnMeta::data_type`]. MongoDB's are
    /// not — a field's type is a property of the individual document, and
    /// nested fields have no `ColumnMeta` at all — so the document list view
    /// would otherwise have to guess a type from the (deliberately lossy)
    /// display JSON and would rewrite a `Long` as an `Int` on the first edit.
    ///
    /// Skipped when absent so a SQL result's payload is byte-identical to what
    /// it was before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_types: Option<Vec<Vec<Value>>>,
}

impl QueryResult {
    /// A result set. `rows_affected` is the row *count* — every read-shaped
    /// caller set it that way, and the nine struct literals this replaces
    /// each restated the relationship (usually as `data.len() as u64` on the
    /// line above `rows: data`, which only works because the field order puts
    /// it first).
    ///
    /// `total`, `truncated` and `row_types` start at their neutral values and
    /// are added by the three builder methods below, so a caller only mentions
    /// the ones it actually has. That is the point of these: a new field on
    /// [`QueryResult`] is one edit here instead of nine, and — the part a
    /// compiler would not have caught — a field a caller *forgets* to set now
    /// gets the same neutral value as everywhere else rather than whatever the
    /// author assumed.
    pub fn rows(columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>, elapsed_ms: u64) -> Self {
        Self {
            rows_affected: rows.len() as u64,
            columns,
            rows,
            elapsed_ms,
            total: None,
            truncated: false,
            row_types: None,
        }
    }

    /// A write's affected-row count, with no result set.
    pub fn affected(rows_affected: u64, elapsed_ms: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            elapsed_ms,
            total: None,
            truncated: false,
            row_types: None,
        }
    }

    /// The relation's total row count, for the browse footer's "1–100 of N".
    pub fn with_total(mut self, total: Option<u64>) -> Self {
        self.total = total;
        self
    }

    /// Mark the rows as having been cut at [`MAX_ADHOC_QUERY_ROWS`].
    pub fn with_truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }

    /// MongoDB's per-cell BSON type trees (ADR #29). Must stay cell-aligned
    /// with `rows`.
    pub fn with_row_types(mut self, row_types: Vec<Vec<Value>>) -> Self {
        self.row_types = Some(row_types);
        self
    }
}

/// Column descriptor in a [`QueryResult`]. `Deserialize` for the same reason
/// as its parent — it crosses the MCP bridge.
#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

/// Result of [`count_table_rows`]: the row total for the current predicate
/// plus whether it is an engine-provided *estimate* (fast, approximate)
/// rather than an exact `COUNT(*)`.
///
/// The count is served separately from the data page (see
/// [`fetch_table_data`], which the GUI now always calls with
/// `with_count = false`) so the grid can paint its first rows immediately —
/// on a multi-million-row table the exact `COUNT(*)` used to gate that first
/// paint. When the whole table is browsed (no filters, no search) we skip the
/// count entirely and return the planner/catalog estimate, which is O(1);
/// any predicate forces an exact count (still off the render's critical path).
#[derive(Debug, Serialize)]
pub struct CountResult {
    pub total: u64,
    /// `true` when `total` came from a statistics estimate (`reltuples` on
    /// Postgres, `information_schema.TABLE_ROWS` on MySQL,
    /// `estimatedDocumentCount` on MongoDB) instead of an exact count. The
    /// frontend renders an estimate as `~N`.
    pub estimated: bool,
}

/// Per-statement outcome inside a [`BatchResult`].
///
/// `preview` is a single-line, length-capped echo of the statement (so the
/// UI can label each row of the summary without re-sending the SQL). On a
/// failing statement `error` carries the driver message and the batch stops
/// there — later statements never run, mirroring how a paste of `;`-delimited
/// queries would abort at the first failure in a `psql`/`mysql` session.
///
/// `results` carries whatever the statement *returned*. It is a `Vec` rather
/// than an `Option` because one T-SQL statement can legitimately produce
/// several result sets, and the batch runner used to keep the first non-empty
/// one and discard the rest — "a panel per thing that returns rows" has to
/// mean all of them to be true. The SQL and MongoDB drivers push zero or one.
#[derive(Debug, Serialize)]
pub struct StmtOutcome {
    pub index: usize,
    pub preview: String,
    pub rows_affected: u64,
    pub is_select: bool,
    pub error: Option<String>,
    /// Result sets this statement produced, in the order the driver returned
    /// them. Empty for a write, for a failure, and for a read whose rows were
    /// all shed by [`MAX_BATCH_RESULT_ROWS`].
    pub results: Vec<QueryResult>,
}

/// Result of running a batch of statements via [`execute_batch`].
///
/// Every statement's own result sets travel in its [`StmtOutcome`]. There is
/// deliberately no `last_result` alongside them any more: it used to be how
/// the single grid got its rows, and once each statement carries its own it
/// would be a second, full copy of the largest payload in the batch crossing
/// the IPC boundary for nothing. The one consumer that read it is the query
/// tab, rewritten in the same change; `ImportSqlDialog` and the MCP write path
/// only ever read `statements`/`total_affected`.
#[derive(Debug, Serialize)]
pub struct BatchResult {
    pub statements: Vec<StmtOutcome>,
    pub total_affected: u64,
}

/// One-line, length-capped echo of a statement for the batch summary.
fn stmt_preview(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 {
        let head: String = one_line.chars().take(117).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// Decode a Postgres result set into `(columns, rows)`. Shared by
/// [`execute_with_state`] and [`execute_batch`] so the two paths can never
/// drift in how they map driver rows to JSON values.
/// Map `db::exec::query_rows`'s untyped `(name, type_name)` pairs into the
/// serialisable DTO. The pairs stop at the `db/` boundary (see `query_rows`);
/// this is the one place that crosses them over.
fn column_meta(pairs: Vec<(String, String)>) -> Vec<ColumnMeta> {
    pairs
        .into_iter()
        .map(|(name, data_type)| ColumnMeta { name, data_type })
        .collect()
}

fn pg_result(rows: &[sqlx::postgres::PgRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            pg_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| pg_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Decode a MySQL result set into `(columns, rows)`. See [`pg_result`].
fn mysql_result(rows: &[sqlx::mysql::MySqlRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            mysql_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| mysql_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Decode a SQLite result set into `(columns, rows)`. See [`pg_result`].
fn sqlite_result(rows: &[sqlx::sqlite::SqliteRow]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    use sqlx::Row;
    let columns = rows
        .first()
        .map(|r| {
            sqlite_columns(r)
                .into_iter()
                .map(|(name, data_type)| ColumnMeta { name, data_type })
                .collect()
        })
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| sqlite_value(r, i)).collect())
        .collect();
    (columns, data)
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

async fn execute_adhoc(
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
        match &result {
            Ok(r) => log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                Some(r.rows_affected),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return result;
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
                if read_only {
                    fetch_in_read_only_tx(&p, "BEGIN READ ONLY", sql).await
                } else {
                    fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
                }
            );
            (pg_result(&rows), truncated)
        }
        DbPool::Mysql(p) => {
            let (rows, truncated) = try_sql_sink!(
                sink,
                connection_id,
                driver,
                sql,
                start,
                if read_only {
                    fetch_in_read_only_tx(&p, "START TRANSACTION READ ONLY", sql).await
                } else {
                    fetch_capped(&p, sql, MAX_ADHOC_QUERY_ROWS).await
                }
            );
            (mysql_result(&rows), truncated)
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
            (sqlite_result(&rows), truncated)
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
            let (cols, data) = crate::db::mssql::schema::decode_rows(&rows);
            (
                (
                    cols.into_iter()
                        .map(|(name, data_type)| ColumnMeta { name, data_type })
                        .collect::<Vec<_>>(),
                    data,
                ),
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

    // Drive every statement over a single borrowed connection `$conn`,
    // decoding SELECT result sets with the driver-specific `$decode`. Pushes
    // one `StmtOutcome` per statement and breaks on the first error.
    macro_rules! drive {
        ($conn:expr, $decode:path) => {{
            for (index, raw) in statements.iter().enumerate() {
                let sql = raw.trim();
                if sql.is_empty() {
                    continue;
                }
                let is_select = is_read_only(sql);
                let start = Instant::now();
                if is_select {
                    match fetch_capped(&mut *$conn, sql, MAX_ADHOC_QUERY_ROWS).await {
                        Ok((rows, truncated)) => {
                            let (columns, mut data) = $decode(&rows);
                            // `rows_affected` counts what the statement
                            // produced, before the batch budget sheds any of
                            // it — the summary would otherwise report a
                            // SELECT that returned nothing.
                            let ra = data.len() as u64;
                            total_affected += ra;
                            log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
                            let over_budget = shed_to_batch_budget(&mut data, &mut rows_kept);
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: ra,
                                is_select: true,
                                error: None,
                                results: vec![QueryResult::rows(
                                    columns,
                                    data,
                                    start.elapsed().as_millis() as u64,
                                )
                                .with_truncated(truncated || over_budget)],
                            });
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            log_sql_sink(
                                sink,
                                &connection_id,
                                driver,
                                sql,
                                start,
                                None,
                                Some(&msg),
                            );
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: 0,
                                is_select: true,
                                error: Some(msg),
                                results: Vec::new(),
                            });
                            break;
                        }
                    }
                } else {
                    // Non-SELECT statements run through the unprepared simple-query
                    // protocol — see the rationale in `execute_with_state`. The
                    // prepared/binary protocol rejects or mishandles statements a
                    // CLI client accepts (notably MySQL BIT / integer-literal DML),
                    // and an ad-hoc editor binds no parameters, so there's nothing
                    // to prepare. Passing the bare `&str` to `Executor::execute`
                    // (no bound arguments) is what selects the text protocol. Only
                    // `rows_affected` is consumed here.
                    match (&mut *$conn).execute(sql).await {
                        Ok(r) => {
                            let ra = r.rows_affected();
                            total_affected += ra;
                            log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: ra,
                                is_select: false,
                                error: None,
                                results: Vec::new(),
                            });
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            log_sql_sink(
                                sink,
                                &connection_id,
                                driver,
                                sql,
                                start,
                                None,
                                Some(&msg),
                            );
                            outcomes.push(StmtOutcome {
                                index,
                                preview: stmt_preview(sql),
                                rows_affected: 0,
                                is_select: false,
                                error: Some(msg),
                                results: Vec::new(),
                            });
                            break;
                        }
                    }
                }
            }
        }};
    }

    // Same loop for SQL Server, over one pooled TDS session. It cannot share
    // `drive!` because that macro is written against `sqlx::query` and an
    // `Executor`; everything else about the shape (per-statement outcome, break
    // on first error, remember the last SELECT) is identical.
    macro_rules! drive_mssql {
        ($client:expr) => {{
            for (index, raw) in statements.iter().enumerate() {
                let sql = raw.trim();
                if sql.is_empty() {
                    continue;
                }
                let is_select = is_read_only(sql);
                let start = Instant::now();
                let outcome: AppResult<(u64, Vec<QueryResult>)> = if is_select {
                    $client
                        .simple_query_sets_capped(sql, MAX_ADHOC_QUERY_ROWS)
                        .await
                        .map(|(sets, truncated)| {
                            // Every non-empty set, not just the first. A single
                            // T-SQL statement can return several, and keeping
                            // one of them was a silent discard back when there
                            // was only ever one grid to put it in.
                            let mut results = Vec::new();
                            let mut ra = 0u64;
                            for rows in sets.into_iter().filter(|s| !s.is_empty()) {
                                let (cols, mut data) = crate::db::mssql::schema::decode_rows(&rows);
                                ra += data.len() as u64;
                                let over_budget = shed_to_batch_budget(&mut data, &mut rows_kept);
                                // No `row_types`: SQL, so the catalog column type is
                                // the hint the editor needs, and per-cell BSON type
                                // trees are MongoDB's alone (ADR #29).
                                results.push(
                                    QueryResult::rows(
                                        cols.into_iter()
                                            .map(|(name, data_type)| ColumnMeta { name, data_type })
                                            .collect(),
                                        data,
                                        start.elapsed().as_millis() as u64,
                                    )
                                    .with_truncated(truncated || over_budget),
                                );
                            }
                            (ra, results)
                        })
                } else {
                    $client.simple_execute(sql).await.map(|ra| (ra, Vec::new()))
                };
                match outcome {
                    Ok((ra, results)) => {
                        total_affected += ra;
                        log_sql_sink(sink, &connection_id, driver, sql, start, Some(ra), None);
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
                        let msg = e.to_string();
                        log_sql_sink(sink, &connection_id, driver, sql, start, None, Some(&msg));
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
        }};
    }

    let acquire_start = Instant::now();
    match &pool {
        DbPool::Postgres(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, pg_result);
        }
        DbPool::Mysql(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, mysql_result);
        }
        DbPool::Sqlite(p) => {
            let mut conn = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive!(conn, sqlite_result);
        }
        DbPool::MsSql(p) => {
            let mut client = try_sql_sink!(
                sink,
                &connection_id,
                driver,
                "(batch)",
                acquire_start,
                p.acquire().await
            );
            drive_mssql!(client);
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    }

    Ok(BatchResult {
        statements: outcomes,
        total_affected,
    })
}

/// Escape a user-supplied LIKE pattern so `%` and `_` lose their special
/// meaning. The resulting fragment is intended to be used with
/// `LIKE/ILIKE ... ESCAPE '\'`.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out
}

/// Upper bound on how many values a single `In` / `NotIn` filter may carry.
///
/// Every value becomes one bind, so an unbounded list turns into an unbounded
/// statement: engines have their own placeholder ceilings (Postgres tops out at
/// 65535 binds per statement, SQLite's `SQLITE_MAX_VARIABLE_NUMBER` defaults far
/// lower) and the failure mode is an opaque driver error rather than anything the
/// user can act on. 1000 is comfortably above any plausible manual selection in
/// the grid and far below every engine limit.
pub const MAX_IN_VALUES: usize = 1000;

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
/// past the cap are still drained off the wire (SQL: to leave the pooled
/// session/connection at a clean protocol boundary instead of mid-response;
/// Mongo: the cursor is simply dropped early, which is a supported operation)
/// — they're discarded, not merely deferred, so backend memory stays bounded
/// regardless of how many rows the query actually matches.
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

/// Stream `sql` and keep only the first `cap` rows, still draining (and
/// discarding) anything past that so the connection is left at a clean
/// protocol boundary rather than mid-response — see [`MAX_ADHOC_QUERY_ROWS`].
/// Returns `(rows, truncated)`.
async fn fetch_capped<'q, 'c, DB, E>(
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
    let mut truncated = false;
    while let Some(row) = stream.try_next().await? {
        if rows.len() < cap {
            rows.push(row);
        } else {
            truncated = true;
        }
    }
    Ok((rows, truncated))
}

/// [`fetch_capped`] inside a transaction opened with `begin` (`BEGIN READ
/// ONLY` / `START TRANSACTION READ ONLY`), always rolled back — see
/// [`execute_read_with_state`]. The rollback runs whether or not the read
/// failed, so the connection goes back to the pool outside any transaction;
/// the read's own error wins over a failed rollback, being the one that says
/// what went wrong.
async fn fetch_in_read_only_tx<DB>(
    pool: &sqlx::Pool<DB>,
    begin: &'static str,
    sql: &str,
) -> Result<(Vec<DB::Row>, bool), sqlx::Error>
where
    DB: sqlx::Database,
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
    for<'a> <DB as sqlx::Database>::Arguments<'a>: sqlx::IntoArguments<'a, DB>,
{
    let mut tx = pool.begin_with(begin).await?;
    let fetched = fetch_capped(&mut *tx, sql, MAX_ADHOC_QUERY_ROWS).await;
    let rolled_back = tx.rollback().await;
    let rows = fetched?;
    rolled_back?;
    Ok(rows)
}

/// SQLite's counterpart of [`fetch_in_read_only_tx`]: `PRAGMA query_only`
/// refuses every write, DDL included, on the connection it is set on.
///
/// It is a per-connection setting, so the one thing that must not happen is
/// handing the connection back to the pool still in that mode — the user's own
/// next write from the editor would fail for no visible reason. If switching it
/// off fails, the connection is closed instead of being returned.
async fn fetch_sqlite_query_only(
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

/// Reject filter payloads that would build pathological or invalid SQL.
///
/// Called from [`fetch_table_data_inner`] rather than from the `#[tauri::command]`
/// wrapper, so it guards every caller of the shared core — today that's the GUI
/// command (the only one that sends filters; the MCP `browse_table` tool passes
/// `None`), and tomorrow anything else built on it.
///
/// `pub(crate)` because the browse path is no longer the only one that takes a
/// filter list: `commands::bulk` feeds the very same `build_filter_clause` from
/// its own `BulkUpdateArgs`, and while it was private the 1000-value cap went
/// unenforced on exactly the route where a pathological list costs the most —
/// an `UPDATE`'s `WHERE`, not a paginated `SELECT`'s.
pub(crate) fn validate_filters(filters: &[ColumnFilter]) -> AppResult<()> {
    for f in filters {
        if matches!(f.op, FilterOp::In | FilterOp::NotIn) && f.values.len() > MAX_IN_VALUES {
            return Err(AppError::InvalidInput(format!(
                "filter on {:?}: {} values exceeds the {MAX_IN_VALUES}-value limit for IN/NOT IN",
                f.column,
                f.values.len()
            )));
        }
    }
    Ok(())
}

/// Build the `WHERE` fragment + bind list for a set of column filters
/// plus an optional free-text `search` applied across `search_columns`.
///
/// Returns `(clause, binds)`. `clause` is either `""` or starts with a
/// leading space `" WHERE ..."`. The search predicate is appended as a
/// single OR group AND-composed with the column filters. Search values
/// are escaped against LIKE metacharacters and case-folded by the SQL
/// engine (`ILIKE` on Postgres, default `LIKE` on MySQL/SQLite).
fn build_filter_clause(
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>) {
    let (clause, binds, _) = build_filter_clause_at(1, dialect, filters, search, search_columns);
    (clause, binds)
}

/// Same as [`build_filter_clause`], but starting the positional placeholder
/// counter at `start_at` instead of always at 1, and returning the counter's
/// final value alongside the usual `(clause, binds)`.
///
/// Needed when a `WHERE` built from this function is appended after a `SET`
/// clause that already consumed some placeholders (bulk update, see
/// `crate::commands::bulk`): Postgres numbers placeholders globally per
/// statement, so the `WHERE` must continue the `SET`'s counter rather than
/// restart at `$1`. MySQL/SQLite's `?` doesn't care about the number, so the
/// threading is harmless there too.
pub(crate) fn build_filter_clause_at(
    start_at: usize,
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>, usize) {
    let mut binds: Vec<Option<String>> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut next_placeholder: usize = start_at;

    // Next positional placeholder for this dialect, advancing the counter.
    let placeholder = |next: &mut usize| -> String {
        let ph = dialect.placeholder(*next);
        *next += 1;
        ph
    };
    let like_kw = dialect.like_kw();
    let cast_to = dialect.cast_to_text();
    let escape = dialect.like_escape_clause();

    for f in filters {
        let col = dialect.quote_ident(&f.column);
        match f.op {
            FilterOp::IsNull => parts.push(format!("{col} IS NULL")),
            FilterOp::IsNotNull => parts.push(format!("{col} IS NOT NULL")),
            FilterOp::Eq
            | FilterOp::Ne
            | FilterOp::Gt
            | FilterOp::Gte
            | FilterOp::Lt
            | FilterOp::Lte => {
                let sym = match f.op {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Gt => ">",
                    FilterOp::Gte => ">=",
                    FilterOp::Lt => "<",
                    FilterOp::Lte => "<=",
                    // Unreachable: the arm above admits only those six. Listed
                    // by name rather than `_` so that adding a `FilterOp` is a
                    // compile error here instead of silently inheriting `<=`.
                    FilterOp::Contains
                    | FilterOp::NotContains
                    | FilterOp::StartsWith
                    | FilterOp::EndsWith
                    | FilterOp::Between
                    | FilterOp::In
                    | FilterOp::NotIn
                    | FilterOp::IsNull
                    | FilterOp::IsNotNull => {
                        unreachable!("non-comparison op in the comparison arm")
                    }
                };
                let ph = placeholder(&mut next_placeholder);
                parts.push(format!("{col} {sym} {ph}"));
                binds.push(json_to_string(&f.value));
            }
            FilterOp::Between => {
                let ph1 = placeholder(&mut next_placeholder);
                let ph2 = placeholder(&mut next_placeholder);
                parts.push(format!("{col} BETWEEN {ph1} AND {ph2}"));
                binds.push(json_to_string(&f.value));
                binds.push(json_to_string(&f.value2));
            }
            FilterOp::In | FilterOp::NotIn => {
                let negated = matches!(f.op, FilterOp::NotIn);
                // Deduplicate on the *bound* representation while preserving the
                // order the values arrived in: selecting 40 rows that share a
                // value must produce one placeholder, not 40. NULL is pulled out
                // separately — no `IN` list can ever match it.
                let mut seen: HashSet<String> = HashSet::new();
                let mut bound: Vec<Option<String>> = Vec::new();
                let mut has_null = false;
                for v in &f.values {
                    match json_to_string(v) {
                        None => has_null = true,
                        Some(s) => {
                            if seen.insert(s.clone()) {
                                bound.push(Some(s));
                            }
                        }
                    }
                }

                if bound.is_empty() {
                    // `IN ()` is a syntax error on every engine. A list that is
                    // empty (or NULL-only) can only arrive from a hand-built
                    // payload, since the UI always sends the selected values —
                    // but emit a valid degenerate predicate rather than dropping
                    // the filter, because dropping it would silently widen the
                    // result set to the whole table, the opposite of the ask.
                    if has_null {
                        let kw = if negated { "IS NOT NULL" } else { "IS NULL" };
                        parts.push(format!("{col} {kw}"));
                    } else {
                        parts.push(if negated { "1 = 1" } else { "1 = 0" }.to_string());
                    }
                } else {
                    let list = bound
                        .iter()
                        .map(|_| placeholder(&mut next_placeholder))
                        .collect::<Vec<_>>()
                        .join(", ");
                    // SQL's three-valued logic makes NULL the whole subtlety
                    // here, and it cuts in opposite directions per op:
                    //
                    // * `IN` + NULL selected → `col IN (…)` is never true for a
                    //   NULL column, so the NULL rows the user explicitly picked
                    //   would vanish. Add `OR col IS NULL`.
                    // * `NOT IN` + NULL selected → nothing to add: NULL was kept
                    //   out of the list, and `NULL NOT IN (…)` evaluates to NULL
                    //   (not true), so NULL rows are already excluded — which is
                    //   exactly what "exclude these" asked for.
                    // * `NOT IN` without NULL selected → the classic trap. NULL
                    //   rows would be dropped by 3VL even though the user never
                    //   asked to exclude them. Add `OR col IS NULL` to keep them.
                    if negated {
                        if has_null {
                            parts.push(format!("{col} NOT IN ({list})"));
                        } else {
                            parts.push(format!("({col} NOT IN ({list}) OR {col} IS NULL)"));
                        }
                    } else if has_null {
                        parts.push(format!("({col} IN ({list}) OR {col} IS NULL)"));
                    } else {
                        parts.push(format!("{col} IN ({list})"));
                    }
                    binds.extend(bound);
                }
            }
            FilterOp::Contains
            | FilterOp::NotContains
            | FilterOp::StartsWith
            | FilterOp::EndsWith => {
                // Substring / prefix / suffix match. Cast the column to text so
                // the pattern match works on non-text columns too, and escape
                // the user value's LIKE metacharacters before wrapping it in
                // the position wildcards.
                let raw = json_to_string(&f.value).unwrap_or_default();
                let escaped = escape_like(&raw);
                let (pattern, kw) = match f.op {
                    FilterOp::Contains => (format!("%{escaped}%"), like_kw),
                    FilterOp::NotContains => (format!("%{escaped}%"), "NOT LIKE"),
                    FilterOp::StartsWith => (format!("{escaped}%"), like_kw),
                    FilterOp::EndsWith => (format!("%{escaped}"), like_kw),
                    // Unreachable, and spelled out for the same reason as the
                    // comparison arm above: a new `FilterOp` must not quietly
                    // become a suffix match.
                    FilterOp::Eq
                    | FilterOp::Ne
                    | FilterOp::Gt
                    | FilterOp::Gte
                    | FilterOp::Lt
                    | FilterOp::Lte
                    | FilterOp::Between
                    | FilterOp::In
                    | FilterOp::NotIn
                    | FilterOp::IsNull
                    | FilterOp::IsNotNull => {
                        unreachable!("non-pattern op in the pattern arm")
                    }
                };
                // `NOT LIKE` has no case-insensitive keyword form; on Postgres
                // fold both sides to lower() so "not contains" stays
                // case-insensitive like the positive matches.
                let ph = placeholder(&mut next_placeholder);
                if dialect.not_like_needs_lower() && matches!(f.op, FilterOp::NotContains) {
                    parts.push(format!(
                        "lower(CAST({col} AS {cast_to})) NOT LIKE lower({ph}){escape}"
                    ));
                } else {
                    parts.push(format!("CAST({col} AS {cast_to}) {kw} {ph}{escape}"));
                }
                binds.push(Some(pattern));
            }
        }
    }

    if let Some(q) = search {
        if !q.is_empty() && !search_columns.is_empty() {
            // Reuses the `like_kw` / `cast_to` / `escape` bindings hoisted above.
            let pattern = format!("%{}%", escape_like(q));
            let mut or_parts: Vec<String> = Vec::new();
            for col in search_columns {
                let qcol = dialect.quote_ident(col);
                let ph = placeholder(&mut next_placeholder);
                or_parts.push(format!("CAST({qcol} AS {cast_to}) {like_kw} {ph}{escape}"));
                binds.push(Some(pattern.clone()));
            }
            if !or_parts.is_empty() {
                parts.push(format!("({})", or_parts.join(" OR ")));
            }
        }
    }

    if parts.is_empty() {
        return (String::new(), binds, next_placeholder);
    }
    (
        format!(" WHERE {}", parts.join(" AND ")),
        binds,
        next_placeholder,
    )
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

/// Tauri-independent core of [`fetch_table_data`], reused by the headless MCP
/// `browse_table` tool. Takes a borrowed [`AppState`] and a [`LogSink`] (a
/// `TauriSink` in the GUI, a `NoopSink` under MCP) instead of the Tauri
/// `State` guard + `AppHandle`.
pub(crate) async fn fetch_table_data_inner(
    sink: &dyn LogSink,
    state: &AppState,
    query: TableQuery,
) -> AppResult<QueryResult> {
    query.filter.validate()?;
    let pool = state.pool_for(&query.connection_id)?;

    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let result = crate::db::mongo::query::fetch_collection_data(conn, &query).await;
        let sql_text = crate::db::mongo::query::describe_find(&query);
        let connection_id = &query.connection_id;
        match &result {
            Ok(r) => log_sql_sink(
                sink,
                connection_id,
                "mongodb",
                &sql_text,
                start,
                Some(r.rows.len() as u64),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                connection_id,
                "mongodb",
                &sql_text,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return result;
    }

    let driver = pool.driver_name();
    let dialect = Dialect::try_of(&pool)?;

    let (data_sql, where_binds) = sql_page_statement(dialect, &query)?;
    let TableQuery {
        connection_id,
        schema,
        table,
        filter,
        projection,
        with_count,
        ..
    } = query;
    let (where_clause, _) = filter.clause(dialect)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let count_sql = format!("SELECT COUNT(*) FROM {qt}{where_clause}");

    let start = Instant::now();
    // One dispatch, in `db::exec`. The PG arm here used to be a verbatim
    // re-inlining of `pg_result`, which already existed 200 lines above.
    let (raw_columns, data) = try_sql_sink!(
        sink,
        &connection_id,
        driver,
        &data_sql,
        start,
        crate::db::exec::query_rows(&pool, &data_sql, &where_binds).await
    );
    let columns = column_meta(raw_columns);
    let elapsed_ms = start.elapsed().as_millis() as u64;
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &data_sql,
        start,
        Some(data.len() as u64),
        None,
    );

    // The COUNT companion is skipped when the caller already knows the total
    // (only sort/offset/page changed). This halves the round trips for the
    // common case of paging through or re-sorting a large result set.
    let total: Option<u64> = if with_count {
        let count_start = Instant::now();
        let raw_count: Option<i64> = try_sql_sink!(
            sink,
            &connection_id,
            driver,
            &count_sql,
            count_start,
            crate::db::exec::scalar_i64(&pool, &count_sql, &where_binds).await
        );
        let total = raw_count.map(|n| n as u64);
        log_sql_sink(
            sink,
            &connection_id,
            driver,
            &count_sql,
            count_start,
            total,
            None,
        );
        total
    } else {
        None
    };

    // An empty page carries no rows for the per-driver decode to read column
    // metadata from, so `columns` came back empty above — which left the grid
    // with no headers and no way to begin an insert on an empty table (issue
    // #27). Fall back to the catalog definition so an empty table still shows
    // its full structure. Only pays the extra introspection query when the
    // page is genuinely empty; a failed lookup degrades to the old empty list.
    //
    // Under a projection the fallback is narrowed to it, in the projection's
    // order — an empty page must still show the columns the user asked for,
    // not the whole table.
    let columns = if columns.is_empty() {
        list_columns_inner(state, &connection_id, schema, table)
            .await
            .map(|cols| {
                // Slots, so each projected column can be taken by value in
                // the projection's order without cloning the catalog.
                let mut all: Vec<Option<ColumnMeta>> = cols
                    .into_iter()
                    .map(|c| {
                        Some(ColumnMeta {
                            name: c.name,
                            data_type: c.data_type,
                        })
                    })
                    .collect();
                match Projection::narrowing(projection.as_ref()) {
                    Some(p) => p
                        .fields
                        .iter()
                        .filter_map(|f| {
                            all.iter_mut()
                                .find(|c| c.as_ref().is_some_and(|c| &c.name == f))
                                .and_then(Option::take)
                        })
                        .collect(),
                    None => all.into_iter().flatten().collect(),
                }
            })
            .unwrap_or_default()
    } else {
        columns
    };

    Ok(QueryResult::rows(columns, data, elapsed_ms).with_total(total))
}

/// Count the rows of `schema.table` for the current predicate.
///
/// Split out of [`fetch_table_data`] so the count never gates the data
/// page's first paint (see [`CountResult`]). When the whole table is browsed
/// (no filters, no search) it returns the engine's O(1) statistics estimate;
/// with any predicate it runs an exact `COUNT(*)` — still off the render's
/// critical path because the frontend fires it as a separate request.
#[tauri::command]
pub async fn count_table_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    query: TableScan,
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
    count_table_rows_inner(&sink, state.inner(), query).await
}

/// Tauri-independent core of [`count_table_rows`].
pub(crate) async fn count_table_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    query: TableScan,
) -> AppResult<CountResult> {
    // `order`, `projection` and `hint` do not change how many rows match. A
    // collation does on MongoDB (it is part of the match there); on SQL it
    // only ever reaches the ORDER BY, so the SQL count ignores it.
    let TableScan {
        connection_id,
        schema,
        table,
        filter,
        collation,
        ..
    } = query;
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    // "Unfiltered" == the whole relation: no column filters AND no committed
    // search. Only then may we serve the fast catalog estimate; any predicate
    // forces an exact count of the matching subset.
    let unfiltered = filter.is_unfiltered();

    // MongoDB: estimatedDocumentCount (O(1) metadata read) when unfiltered,
    // exact countDocuments over the filter otherwise.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::count_collection(
            conn,
            &table,
            &filter,
            nonblank(&collation),
            unfiltered,
        )
        .await;
        let label = if unfiltered {
            "(mongo estimatedDocumentCount)"
        } else {
            "(mongo countDocuments)"
        };
        match &res {
            Ok(c) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                label,
                start,
                Some(c.total),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                label,
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;

    // Whole-table browse: try the engine estimate first. `try_estimate`
    // returns `None` when no usable estimate exists (SQLite always; a
    // never-analyzed Postgres/MySQL table) so we fall through to an exact
    // count rather than reporting a bogus `~0`.
    if unfiltered {
        if let Some(total) = try_estimate(
            sink,
            &pool,
            driver,
            &connection_id,
            schema.as_deref(),
            &table,
        )
        .await
        {
            return Ok(CountResult {
                total,
                estimated: true,
            });
        }
    }

    // Exact count: predicate present, or no estimate available.
    let (where_clause, where_binds) = filter.clause(dialect)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let count_sql = format!("SELECT COUNT(*) FROM {qt}{where_clause}");

    let start = Instant::now();
    let raw_count: Option<i64> = try_sql_sink!(
        sink,
        &connection_id,
        driver,
        &count_sql,
        start,
        crate::db::exec::scalar_i64(&pool, &count_sql, &where_binds).await
    );
    let total = raw_count.unwrap_or(0).max(0) as u64;
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &count_sql,
        start,
        Some(total),
        None,
    );
    Ok(CountResult {
        total,
        estimated: false,
    })
}

/// Fast, approximate whole-table row count read from engine statistics.
///
/// Returns `None` when no usable estimate exists so the caller falls back to
/// an exact `COUNT(*)`:
///
/// * **Postgres** — `pg_class.reltuples` (the planner's row estimate).
///   `-1` means "never analyzed" on PG 14+, and older PG reports `0` for the
///   same state, so we treat any non-positive value as "no estimate".
/// * **MySQL** — `information_schema.TABLES.TABLE_ROWS`, cast to signed so
///   sqlx decodes the `BIGINT UNSIGNED` column as `i64`. This is InnoDB's
///   estimate (exact for MyISAM); `NULL`/`0` (views, or stale stats on a
///   freshly-created table) is treated as "no estimate".
/// * **SQLite** — always `None`: there is no cheap, reliable row estimate,
///   and the file is local so an exact `COUNT(*)` is acceptable.
///
/// A driver error (or a missing relation) also degrades to `None` rather than
/// failing the whole request; the exact-count fallback surfaces any real
/// error to the user with the actual failing SQL.
async fn try_estimate(
    sink: &dyn LogSink,
    pool: &DbPool,
    driver: &str,
    connection_id: &str,
    schema: Option<&str>,
    table: &str,
) -> Option<u64> {
    match pool {
        DbPool::Postgres(p) => {
            // `::regclass` resolves the (optionally schema-qualified) quoted
            // name to the relation's OID, so the estimate is bound to the same
            // table the data query reads.
            let schema = schema.unwrap_or("public");
            let regclass = format!(
                "{}.{}",
                Dialect::Postgres.quote_ident(schema),
                Dialect::Postgres.quote_ident(table)
            );
            let sql = "SELECT reltuples::bigint FROM pg_class WHERE oid = $1::regclass";
            let start = Instant::now();
            let est: Option<i64> = sqlx::query_scalar::<_, i64>(sql)
                .bind(&regclass)
                .fetch_optional(p)
                .await
                .unwrap_or(None);
            log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                est.map(|v| v.max(0) as u64),
                None,
            );
            est.filter(|&v| v > 0).map(|v| v as u64)
        }
        DbPool::Mysql(p) => {
            let sql = "SELECT CAST(TABLE_ROWS AS SIGNED) FROM information_schema.TABLES \
                       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?";
            let start = Instant::now();
            let est: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(sql)
                .bind(schema)
                .bind(table)
                .fetch_optional(p)
                .await
                .unwrap_or(None)
                .flatten();
            log_sql_sink(
                sink,
                connection_id,
                driver,
                sql,
                start,
                est.map(|v| v.max(0) as u64),
                None,
            );
            // 0 is ambiguous (genuinely empty vs stale stats on a new InnoDB
            // table) — confirm it with an exact count rather than showing ~0.
            est.filter(|&v| v > 0).map(|v| v as u64)
        }
        DbPool::MsSql(p) => {
            // `sys.dm_db_partition_stats` is the SQL Server equivalent of
            // `reltuples`: maintained by the engine, no scan. It needs VIEW
            // DATABASE STATE, and the helper returns `None` when that is
            // missing — same "fall through to an exact count" contract.
            crate::db::mssql::schema::estimate_rows(p, schema, table).await
        }
        // No cheap estimate; caller does an exact COUNT(*).
        DbPool::Sqlite(_) => None,
        DbPool::Mongo(_) => None,
    }
}

/// Update one column of one row in `schema.table`, addressed by the
/// full primary key.
///
/// The new value is always sent as `Option<String>` because the cell
/// editor produces text. Drivers cast textual literals to the column type
/// automatically. NULLs are conveyed by passing `None`.
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

/// Tauri-independent core of [`update_cell`], shared with the headless MCP
/// `update_cell` write tool. Takes a borrowed [`AppState`] and a [`LogSink`]
/// (a `TauriSink` in the GUI) instead of a Tauri `State`/`AppHandle`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_cell_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_values: Vec<Value>,
    column: String,
    value: Option<String>,
    column_type: Option<String>,
) -> AppResult<u64> {
    if pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "update_cell: no primary-key columns supplied".into(),
        ));
    }
    if pk_columns.len() != pk_values.len() {
        return Err(AppError::InvalidInput(format!(
            "update_cell: pk_columns/pk_values arity mismatch ({} vs {})",
            pk_columns.len(),
            pk_values.len()
        )));
    }

    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: update one field of the document addressed by `_id` ($set). The
    // PK is always `_id`, so the first pk value is the id; `column_type` is the
    // field's inferred BSON type used to coerce the textual cell value.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let id = pk_values.first().cloned().unwrap_or(Value::Null);
        let res = crate::db::mongo::query::update_cell(
            conn,
            &table,
            &id,
            &column,
            value.as_deref(),
            column_type.as_deref(),
        )
        .await;
        match &res {
            Ok(n) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo update)",
                start,
                Some(*n),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo update)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    // `schema` is consumed below to build `qt`; keep a copy for the catalog
    // fallback further down (only actually read when `column_type` is absent).
    let schema_for_catalog = schema.clone();

    let qt = dialect.qualify(schema.as_deref(), &table);
    let col_id = dialect.quote_ident(&column);

    // SET uses placeholder #1; the PK predicate consumes #2..=#N+1 on the
    // dialects that number their placeholders.
    let where_clause = pk_columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{} = {}",
                dialect.quote_ident(c),
                dialect.placeholder(i + 2)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    // The cell value travels as a textual literal (ADR #5) and drivers
    // coerce it to the column type server-side. That coercion is wrong for
    // MySQL `BIT`: binding the string "1" makes MySQL store the ASCII byte
    // 0x31 (the character '1') rather than the integer 1, so editing a BIT
    // cell silently wrote garbage. Wrapping the placeholder in
    // `CAST(? AS UNSIGNED)` forces numeric interpretation of the literal,
    // and `CAST(NULL AS UNSIGNED)` is still NULL so the set-NULL path is
    // unaffected. Only MySQL needs this; PG/SQLite cast textual literals to
    // their bit/blob types correctly on their own.
    let is_mysql = dialect == Dialect::Mysql;
    // Same fallback as `insert_row`: if the frontend's `column_type` hint is
    // missing (stale/unloaded schema cache), fall back to a catalog lookup
    // rather than silently binding a MySQL BIT column as plain text (issue #15).
    let catalog_bit_cast = is_mysql
        && column_type.is_none()
        && list_columns_inner(state, &connection_id, schema_for_catalog, table.clone())
            .await
            .map(|cols| {
                cols.iter()
                    .any(|c| c.name == column && mysql::is_bit_type(&c.data_type))
            })
            .unwrap_or(false);
    let bit_cast =
        is_mysql && (column_type.as_deref().is_some_and(mysql::is_bit_type) || catalog_bit_cast);
    let set_placeholder = if bit_cast {
        mysql::bit_cast(&dialect.placeholder(1))
    } else if dialect == Dialect::MsSql {
        // The same "text literal, wrong coercion" problem MySQL BIT has, for
        // SQL Server's binary family — see `db::mssql::binary_convert`.
        crate::db::mssql::binary_convert(column_type.as_deref(), &dialect.placeholder(1))
    } else {
        dialect.placeholder(1)
    };
    let sql = format!("UPDATE {qt} SET {col_id} = {set_placeholder} WHERE {where_clause}");
    let effective_value: Option<String> = if bit_cast {
        value.as_deref().map(mysql::normalize_bit_value)
    } else {
        value
    };
    let pk_strs: Vec<Option<String>> = pk_values.iter().map(json_to_string).collect();

    // Wrap the UPDATE in a transaction so a stray multi-row hit can be
    // rolled back atomically. With a correctly-introspected PRIMARY KEY
    // constraint `rows_affected > 1` is impossible, but the cell-save
    // path used to corrupt data silently when only the first PK column
    // was sent on composite-PK tables — this is the belt-and-braces
    // assertion that catches any future regression of that family.
    let start = Instant::now();
    // The guard, the rollback and SQL Server's statement-based transaction all
    // live in `db::exec::in_tx_expect_at_most_one` — see its doc for the bug it
    // exists to catch.
    let mut binds = Vec::with_capacity(pk_strs.len() + 1);
    binds.push(effective_value);
    binds.extend(pk_strs);
    let res = crate::db::exec::in_tx_expect_at_most_one(&pool, &sql, &binds, "update_cell").await;
    let affected = try_sql_sink!(sink, &connection_id, driver, &sql, start, res);
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &sql,
        start,
        Some(affected),
        None,
    );
    Ok(affected)
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
    match &res {
        Ok(n) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo unset)",
            start,
            Some(*n),
            None,
        ),
        Err(e) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo unset)",
            start,
            None,
            Some(&e.to_string()),
        ),
    }
    res
}

/// Coerce a JSON scalar to its textual SQL bind form. `null` becomes `None`
/// so the driver writes a SQL `NULL` rather than the four-byte string
/// `"null"`.
fn json_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
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

/// Tauri-independent core of [`delete_rows`], shared with the headless MCP
/// `delete_rows` write tool.
pub(crate) async fn delete_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_columns: Vec<String>,
    pk_value_rows: Vec<Vec<Value>>,
) -> AppResult<u64> {
    if pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "delete_rows: no primary-key columns supplied".into(),
        ));
    }
    if pk_value_rows.is_empty() {
        return Ok(0);
    }
    let arity = pk_columns.len();
    for (i, row) in pk_value_rows.iter().enumerate() {
        if row.len() != arity {
            return Err(AppError::InvalidInput(format!(
                "delete_rows: row #{i} has {} values, expected {arity}",
                row.len()
            )));
        }
    }

    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: delete by `_id` ({_id: {$in: [...]}}). Each pk tuple is a single
    // `_id` value.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let ids: Vec<Value> = pk_value_rows
            .iter()
            .map(|r| r.first().cloned().unwrap_or(Value::Null))
            .collect();
        let res = crate::db::mongo::query::delete_rows(conn, &table, &ids).await;
        match &res {
            Ok(n) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo delete)",
                start,
                Some(*n),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo delete)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let lhs = pk_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut counter = 0usize;
    let tuples = pk_value_rows
        .iter()
        .map(|row| {
            let placeholders = row
                .iter()
                .map(|_| {
                    counter += 1;
                    dialect.placeholder(counter)
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("({placeholders})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    // For arity==1 wrap the LHS in parentheses too — `(c) IN ((?), (?))`
    // is valid across all three drivers and keeps a single code path.
    let sql = format!("DELETE FROM {qt} WHERE ({lhs}) IN ({tuples})");
    let binds: Vec<Option<String>> = pk_value_rows
        .iter()
        .flat_map(|row| row.iter().map(json_to_string))
        .collect();

    let start = Instant::now();
    let affected = try_sql_sink!(
        sink,
        &connection_id,
        driver,
        &sql,
        start,
        crate::db::exec::execute_params(&pool, &sql, &binds).await
    );
    log_sql_sink(
        sink,
        &connection_id,
        driver,
        &sql,
        start,
        Some(affected),
        None,
    );
    Ok(affected)
}

/// Insert one row into `schema.table`.
///
/// `values` carries the columns the caller wants to populate; any column
/// omitted will fall back to the database default. Bound values are sent
/// as text and cast by the driver, matching [`update_cell`]'s semantics.
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
    match &res {
        Ok(_) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo insert)",
            start,
            Some(count),
            None,
        ),
        Err(e) => log_sql_sink(
            &sink,
            &connection_id,
            driver,
            "(mongo insert)",
            start,
            None,
            Some(&e.to_string()),
        ),
    }
    res
}

/// Tauri-independent core of [`insert_row`], shared with the headless MCP
/// `insert_row` write tool.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_row_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: Option<String>,
    values: Vec<RowValue>,
) -> AppResult<Value> {
    if values.is_empty() {
        return Err(AppError::InvalidInput(
            "insert_row: no columns supplied".into(),
        ));
    }
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: insert one document built from the column/value pairs; returns
    // the generated `_id`.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::insert_row(conn, &table, &values).await;
        match &res {
            Ok(_) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo insert)",
                start,
                Some(1),
                None,
            ),
            Err(e) => log_sql_sink(
                sink,
                &connection_id,
                driver,
                "(mongo insert)",
                start,
                None,
                Some(&e.to_string()),
            ),
        }
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    let is_mysql = dialect == Dialect::Mysql;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);

    // The frontend supplies `column_type` from whatever schema-cache/query-result
    // metadata it has on hand at commit time; if that's stale or hasn't loaded
    // yet, a MySQL BIT column can arrive with `column_type: None`, in which case
    // the branch below would silently bind it as plain text and MySQL rejects
    // the literal with "Data too long for column" (issue #15). Only pay for a
    // catalog round-trip when at least one value actually lacks a type hint —
    // the common case (frontend metadata present) skips this entirely.
    let catalog_bit_columns: std::collections::HashSet<String> =
        if is_mysql && values.iter().any(|v| v.column_type.is_none()) {
            list_columns_inner(state, &connection_id, schema.clone(), table.clone())
                .await
                .map(|cols| {
                    cols.into_iter()
                        .filter(|c| c.data_type.trim().to_ascii_uppercase().starts_with("BIT"))
                        .map(|c| c.name)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            std::collections::HashSet::new()
        };

    // The statement itself is built by `commands::insert`'s shared builder, the
    // same one the bulk JSON path uses, so the two cannot drift on identifier
    // quoting, placeholder numbering, MySQL's `BIT` cast or SQL Server's binary
    // `CONVERT`. This is one row, so it hands it a one-element slice.
    //
    // The type each column carries stays *hint-first* here, unlike the bulk
    // path's catalogue-only typing: the frontend's `RowValue::column_type` is
    // what lets the hot cell-commit path skip a catalogue round trip, and
    // `catalog_bit_columns` above is the fallback for when it is missing. A
    // column the catalogue reported as `BIT` is spelled as such so the builder's
    // own `is_bit_type` test sees it.
    let insert_columns: Vec<InsertColumn> = values
        .iter()
        .map(|rv| InsertColumn {
            name: rv.column.clone(),
            data_type: rv.column_type.clone().or_else(|| {
                catalog_bit_columns
                    .contains(&rv.column)
                    .then(|| "BIT".to_string())
            }),
        })
        .collect();
    let one_row = [values.iter().map(|v| v.value.clone()).collect::<Vec<_>>()];
    let plain = build_insert_statement(
        dialect,
        &qt,
        &insert_columns,
        &one_row,
        InsertClauses::default(),
    );
    let binds = plain.binds;
    let base_sql = plain.sql;

    // Each driver arm yields (final SQL string, Result<(rows_affected, returned_pk), _>).
    // Postgres optionally tacks on RETURNING to recover the generated PK;
    // MySQL/SQLite use `last_insert_*` instead.
    let start = Instant::now();
    let (sql_used, outcome): (String, AppResult<(Option<u64>, Value)>) = match pool {
        DbPool::Postgres(p) => {
            let sql = match &pk_column {
                Some(pk) => {
                    build_insert_statement(
                        dialect,
                        &qt,
                        &insert_columns,
                        &one_row,
                        InsertClauses {
                            returning: Some(&dialect.quote_ident(pk)),
                            ..Default::default()
                        },
                    )
                    .sql
                }
                None => base_sql,
            };
            let mut q = sqlx::query(&sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = if pk_column.is_some() {
                q.fetch_all(&p)
                    .await
                    .map(|rows| {
                        let returned = rows.first().map(|r| pg_value(r, 0)).unwrap_or(Value::Null);
                        (Some(rows.len() as u64), returned)
                    })
                    .map_err(AppError::from)
            } else {
                q.execute(&p)
                    .await
                    .map(|r| (Some(r.rows_affected()), Value::Null))
                    .map_err(AppError::from)
            };
            (sql, outcome)
        }
        DbPool::Mysql(p) => {
            // No separate statement any more: the builder emitted this
            // dialect's `CAST(? AS UNSIGNED)` and normalised the matching bind
            // when it built `base_sql`.
            let mut q = sqlx::query(&base_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = q
                .execute(&p)
                .await
                .map(|r| {
                    let id = r.last_insert_id();
                    let returned = if id == 0 {
                        Value::Null
                    } else {
                        Value::from(id)
                    };
                    (Some(r.rows_affected()), returned)
                })
                .map_err(AppError::from);
            (base_sql, outcome)
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&base_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let outcome = q
                .execute(&p)
                .await
                .map(|r| (Some(r.rows_affected()), Value::from(r.last_insert_rowid())))
                .map_err(AppError::from);
            (base_sql, outcome)
        }
        DbPool::MsSql(p) if pk_column.is_none() => {
            let outcome = p
                .execute_params(&base_sql, &binds)
                .await
                .map(|n| (Some(n), Value::Null));
            (base_sql, outcome)
        }
        DbPool::MsSql(p) => {
            // Guarded by the arm above, so the PK is present here.
            let pk = pk_column.as_deref().unwrap_or_default();
            // `OUTPUT INSERTED.<pk>` is the closest thing T-SQL has to
            // `RETURNING`, and unlike `SCOPE_IDENTITY()` it also recovers a
            // non-identity generated key (a `uniqueidentifier` defaulting to
            // `newid()`, a sequence default). It is rejected outright on a
            // table carrying triggers (error 334), so that one case falls back
            // to `SCOPE_IDENTITY()` — which only knows about IDENTITY columns,
            // but a trigger-bearing table is exactly where that is the
            // conventional answer anyway.
            let output_sql = build_insert_statement(
                dialect,
                &qt,
                &insert_columns,
                &one_row,
                InsertClauses {
                    output_inserted: Some(&dialect.quote_ident(pk)),
                    ..Default::default()
                },
            )
            .sql;
            match p.query_all(&output_sql, &binds).await {
                Ok(rows) => {
                    let returned = rows
                        .first()
                        .map(|r| crate::db::mssql::values::mssql_value(r, 0))
                        .unwrap_or(Value::Null);
                    (output_sql, Ok((Some(rows.len() as u64), returned)))
                }
                Err(e) if crate::db::mssql::is_output_clause_conflict(&e) => {
                    let fallback_sql =
                        format!("{base_sql}; SELECT CAST(SCOPE_IDENTITY() AS bigint) AS [id]");
                    let outcome = p.query_all(&fallback_sql, &binds).await.map(|rows| {
                        let returned = rows
                            .first()
                            .map(|r| crate::db::mssql::values::mssql_value(r, 0))
                            .unwrap_or(Value::Null);
                        (Some(1), returned)
                    });
                    (fallback_sql, outcome)
                }
                Err(e) => (output_sql, Err(e)),
            }
        }
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };

    let (rows, returned) = try_sql_sink!(sink, &connection_id, driver, &sql_used, start, outcome);
    log_sql_sink(sink, &connection_id, driver, &sql_used, start, rows, None);
    Ok(returned)
}

/// One row in an FK dropdown payload.
#[derive(Debug, Serialize)]
pub struct FkOption {
    pub value: String,
    pub label: Option<String>,
}

/// Page of FK options. `has_more` is true when more matching rows exist
/// beyond `limit`; the caller can switch from client-side filtering to a
/// server-side search request when this is set.
#[derive(Debug, Serialize)]
pub struct FkOptionsPage {
    pub options: Vec<FkOption>,
    pub has_more: bool,
}

/// Render a `serde_json::Value` as the stringified form the cell editor
/// uses for `update_cell` and `insert_row`. Numbers, bools and strings go
/// through as-is; nulls become an empty string (callers should drop the
/// row entirely before reaching here, but we guard for safety).
fn value_to_dropdown_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Auto-pick the first non-PK column whose `data_type` looks like a text
/// type (text / varchar / char / citext / name / clob). Case-insensitive.
fn pick_label_column(cols: &[crate::commands::schema::ColumnInfo]) -> Option<String> {
    const TEXT_HINTS: &[&str] = &["text", "varchar", "char", "citext", "name", "clob"];
    cols.iter()
        .filter(|c| !c.is_primary_key)
        .find(|c| {
            let t = c.data_type.to_lowercase();
            TEXT_HINTS.iter().any(|h| t.contains(h))
        })
        .map(|c| c.name.clone())
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

    // Catalog validation. Failing here means the target was dropped or
    // moved out from under us; the frontend treats this as "fall back to
    // plain input".
    let cols =
        list_columns_inner(state.inner(), &connection_id, schema.clone(), table.clone()).await?;
    if cols.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: target table {table} has no columns or is inaccessible",
        )));
    }
    if !cols.iter().any(|c| c.name == key_column) {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: key column {key_column} not found on {table}",
        )));
    }

    let label_col: Option<String> = match label_column {
        Some(name) if cols.iter().any(|c| c.name == name) => Some(name),
        Some(_) => None, // caller-specified but missing; ignore
        None => pick_label_column(&cols),
    };

    let pool = state.pool_for(&connection_id)?;
    // MongoDB has no foreign keys; the FK combobox is not offered for it.
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "foreign-key lookups are not supported on MongoDB".into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let key_id = dialect.quote_ident(&key_column);
    let label_id = label_col.as_ref().map(|c| dialect.quote_ident(c));

    // Projection: key first, label second (when present).
    let projection = match &label_id {
        Some(l) => format!("{key_id} AS k, {l} AS lbl"),
        None => format!("{key_id} AS k"),
    };

    let search_term = search.as_deref().filter(|s| !s.is_empty());
    let mut binds: Vec<Option<String>> = Vec::new();
    let where_clause = if let Some(term) = search_term {
        let pattern = format!("%{}%", escape_like(term));
        let like_kw = dialect.like_kw();
        let cast_to = dialect.cast_to_text();
        let escape = dialect.like_escape_clause();
        let ph1 = dialect.placeholder(1);
        let ph2 = dialect.placeholder(2);
        let mut parts = vec![format!(
            "CAST({key_id} AS {cast_to}) {like_kw} {ph1}{escape}"
        )];
        binds.push(Some(pattern.clone()));
        if let Some(l) = &label_id {
            parts.push(format!("CAST({l} AS {cast_to}) {like_kw} {ph2}{escape}"));
            binds.push(Some(pattern));
        }
        format!(" WHERE {}", parts.join(" OR "))
    } else {
        String::new()
    };

    // Request limit+1 so we can detect has_more without a second COUNT(*).
    let fetch_limit = limit.max(0).saturating_add(1);
    // There is always an `ORDER BY`, so T-SQL's OFFSET/FETCH needs no filler.
    let page = dialect.paginate(fetch_limit, 0, true);
    let sql = format!("SELECT {projection} FROM {qt}{where_clause} ORDER BY {key_id}{page}");

    // The four arms differed only in which `*_value` decoder they called, so
    // this now goes through `db::exec::query_rows` and reads the two decoded
    // columns positionally. `projection` puts the key first and the optional
    // label second, which is what makes the indices safe.
    let (_cols, rows) = crate::db::exec::query_rows(&pool, &sql, &binds).await?;
    let mut options: Vec<FkOption> = rows
        .into_iter()
        .map(|row| {
            let value = value_to_dropdown_string(row.first().unwrap_or(&Value::Null));
            let label = if label_id.is_some() {
                match row.get(1) {
                    Some(Value::Null) | None => None,
                    Some(other) => Some(value_to_dropdown_string(other)),
                }
            } else {
                None
            };
            FkOption { value, label }
        })
        .collect();

    let has_more = options.len() as i64 > limit;
    if has_more {
        options.truncate(limit.max(0) as usize);
    }
    Ok(FkOptionsPage { options, has_more })
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use serde_json::json;

    fn f(column: &str, op: FilterOp, value: serde_json::Value) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op,
            value,
            value2: json!(null),
            values: Vec::new(),
        }
    }

    fn between(column: &str, value: serde_json::Value, value2: serde_json::Value) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op: FilterOp::Between,
            value,
            value2,
            values: Vec::new(),
        }
    }

    /// `In` / `NotIn` filter over an explicit value list.
    fn in_list(column: &str, op: FilterOp, values: Vec<serde_json::Value>) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op,
            value: json!(null),
            value2: json!(null),
            values,
        }
    }

    #[test]
    fn advanced_ops_build_expected_postgres_sql() {
        let filters = vec![
            f("name", FilterOp::Contains, json!("ab")),
            f("age", FilterOp::Gt, json!(5)),
            f("code", FilterOp::StartsWith, json!("x")),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        // Postgres: ILIKE for contains/starts_with, TEXT cast, $N placeholders.
        assert!(
            clause.contains(r#"CAST("name" AS TEXT) ILIKE $1 ESCAPE"#),
            "{clause}"
        );
        assert!(clause.contains(r#""age" > $2"#), "{clause}");
        assert!(
            clause.contains(r#"CAST("code" AS TEXT) ILIKE $3 ESCAPE"#),
            "{clause}"
        );
        assert_eq!(
            binds,
            vec![
                Some("%ab%".to_string()),
                Some("5".to_string()),
                Some("x%".to_string()),
            ]
        );
    }

    #[test]
    fn advanced_ops_build_expected_mysql_sql() {
        let filters = vec![
            f("name", FilterOp::EndsWith, json!("z")),
            f("qty", FilterOp::Lte, json!(10)),
            f("note", FilterOp::NotContains, json!("skip")),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        // MySQL: LIKE / NOT LIKE, CHAR cast, `?` placeholders, doubled escape.
        assert!(clause.contains("CAST(`name` AS CHAR) LIKE ?"), "{clause}");
        assert!(clause.contains("`qty` <= ?"), "{clause}");
        assert!(
            clause.contains("CAST(`note` AS CHAR) NOT LIKE ?"),
            "{clause}"
        );
        assert_eq!(
            binds,
            vec![
                Some("%z".to_string()),
                Some("10".to_string()),
                Some("%skip%".to_string()),
            ]
        );
    }

    #[test]
    fn between_builds_expected_postgres_sql() {
        let filters = vec![between("age", json!(18), json!(65))];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""age" BETWEEN $1 AND $2"#), "{clause}");
        assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
    }

    #[test]
    fn between_builds_expected_mysql_and_sqlite_sql() {
        let filters = vec![between("age", json!(18), json!(65))];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        assert!(clause.contains("`age` BETWEEN ? AND ?"), "{clause}");
        assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
    }

    #[test]
    fn null_ops_take_no_bind() {
        let filters = vec![
            f("a", FilterOp::IsNull, json!(null)),
            f("b", FilterOp::IsNotNull, json!(null)),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""a" IS NULL"#), "{clause}");
        assert!(clause.contains(r#""b" IS NOT NULL"#), "{clause}");
        assert!(binds.is_empty());
    }

    #[test]
    fn in_builds_one_placeholder_per_value() {
        let filters = vec![in_list(
            "id",
            FilterOp::In,
            vec![json!(1), json!(2), json!(3)],
        )];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""id" IN ($1, $2, $3)"#), "{clause}");
        assert_eq!(
            binds,
            vec![
                Some("1".to_string()),
                Some("2".to_string()),
                Some("3".to_string())
            ]
        );
    }

    #[test]
    fn in_uses_question_marks_on_mysql() {
        let filters = vec![in_list("id", FilterOp::In, vec![json!(1), json!(2)])];
        let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
        assert!(clause.contains("`id` IN (?, ?)"), "{clause}");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn in_deduplicates_repeated_values() {
        // Selecting many rows that share a value must not fan out into one
        // placeholder per row.
        let filters = vec![in_list(
            "status",
            FilterOp::In,
            vec![json!("a"), json!("b"), json!("a"), json!("a")],
        )];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""status" IN ($1, $2)"#), "{clause}");
        assert_eq!(
            binds,
            vec![Some("a".to_string()), Some("b".to_string())],
            "order of first appearance must be preserved"
        );
    }

    #[test]
    fn in_with_a_null_value_adds_an_is_null_branch() {
        // `col IN (…)` is never true for a NULL column, so a selected NULL row
        // would silently disappear from its own filter without this.
        let filters = vec![in_list("x", FilterOp::In, vec![json!(1), json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(
            clause.contains(r#"("x" IN ($1) OR "x" IS NULL)"#),
            "{clause}"
        );
        assert_eq!(binds, vec![Some("1".to_string())]);
    }

    #[test]
    fn not_in_without_null_keeps_null_rows_visible() {
        // The classic NOT IN trap: 3VL would drop NULL rows the user never asked
        // to exclude.
        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1)])];
        let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(
            clause.contains(r#"("x" NOT IN ($1) OR "x" IS NULL)"#),
            "{clause}"
        );
    }

    #[test]
    fn not_in_with_null_excludes_null_rows() {
        // Here the user *did* pick NULL, so 3VL's own exclusion is the wanted
        // behaviour and no extra branch is emitted.
        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1), json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" NOT IN ($1)"#), "{clause}");
        assert!(!clause.contains("IS NULL"), "{clause}");
        assert_eq!(binds, vec![Some("1".to_string())]);
    }

    #[test]
    fn empty_in_list_matches_nothing_instead_of_emitting_invalid_sql() {
        // `IN ()` is a syntax error everywhere. Dropping the filter would be
        // worse than a never-true predicate: it would widen the result set to
        // the whole table.
        let filters = vec![in_list("x", FilterOp::In, vec![])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains("1 = 0"), "{clause}");
        assert!(!clause.contains("IN ()"), "{clause}");
        assert!(binds.is_empty());
    }

    #[test]
    fn null_only_in_list_degrades_to_is_null() {
        let filters = vec![in_list("x", FilterOp::In, vec![json!(null)])];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" IS NULL"#), "{clause}");
        assert!(binds.is_empty());

        let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(null)])];
        let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""x" IS NOT NULL"#), "{clause}");
    }

    #[test]
    fn in_placeholders_stay_in_step_with_other_filters() {
        // The `$N` counter is shared across every filter; an `IN` list consuming
        // several numbers must not desync the ones that follow it.
        let filters = vec![
            f("a", FilterOp::Eq, json!("x")),
            in_list("b", FilterOp::In, vec![json!(1), json!(2)]),
            f("c", FilterOp::Gt, json!(9)),
        ];
        let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
        assert!(clause.contains(r#""a" = $1"#), "{clause}");
        assert!(clause.contains(r#""b" IN ($2, $3)"#), "{clause}");
        assert!(clause.contains(r#""c" > $4"#), "{clause}");
        assert_eq!(binds.len(), 4);
    }

    #[test]
    fn oversize_in_list_is_rejected() {
        let values: Vec<serde_json::Value> = (0..=MAX_IN_VALUES).map(|i| json!(i)).collect();
        let filters = vec![in_list("id", FilterOp::In, values)];
        assert!(validate_filters(&filters).is_err());

        let values: Vec<serde_json::Value> = (0..MAX_IN_VALUES).map(|i| json!(i)).collect();
        let filters = vec![in_list("id", FilterOp::In, values)];
        assert!(validate_filters(&filters).is_ok());
    }

    // --- IPC payload shape -------------------------------------------------
    //
    // `TableQuery` / `TableScan` are the wire contract with `src/types.ts`, and
    // serde drops any key the Rust struct does not declare — silently, before
    // the value is ever read (gotcha #14). These pin the exact JSON
    // the frontend sends. `withCount: false` in particular is load-bearing:
    // lose it and every page fetch silently reacquires the `COUNT(*)` that
    // issue #77 moved off the render path.

    #[test]
    fn table_query_deserialises_the_payload_the_grid_sends() {
        let q: TableQuery = serde_json::from_value(json!({
            "connectionId": "c1",
            "schema": "public",
            "table": "album",
            "limit": 100,
            "offset": 200,
            "order": [{ "column": "title", "desc": true }],
            "filters": [{ "column": "id", "op": "gt", "value": 3 }],
            "search": "needle",
            "searchColumns": ["title", "artist"],
            "withCount": false,
        }))
        .unwrap();

        assert_eq!(q.connection_id, "c1");
        assert_eq!(q.schema.as_deref(), Some("public"));
        assert_eq!(q.table, "album");
        assert_eq!((q.limit, q.offset), (100, 200));
        assert_eq!(q.order.len(), 1);
        assert!(q.order[0].desc);
        assert_eq!(q.filter.filters.len(), 1);
        assert_eq!(q.filter.needle(), Some("needle"));
        assert_eq!(q.filter.search_columns, vec!["title", "artist"]);
        assert!(!q.with_count);
    }

    #[test]
    fn table_query_defaults_match_the_option_unwraps_it_replaced() {
        // Every optional key absent: what `browse_table` over MCP sends, and
        // what the `Option<_>::unwrap_or_default()` chain used to produce.
        let q: TableQuery = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "album",
            "limit": 50,
            "offset": 0,
        }))
        .unwrap();

        assert!(q.schema.is_none());
        assert!(q.order.is_empty());
        assert!(q.filter.is_unfiltered());
        // `with_count` defaulted to `true`, not `false` — the old code read
        // `with_count.unwrap_or(true)`.
        assert!(q.with_count);
    }

    #[test]
    fn table_scan_deserialises_the_count_payload() {
        let q: TableScan = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "album",
            "filters": [],
            "searchColumns": [],
        }))
        .unwrap();

        assert_eq!(q.table, "album");
        assert!(q.filter.is_unfiltered());
    }

    #[test]
    fn table_query_carries_the_projection_the_grid_sends() {
        let q: TableQuery = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "device",
            "limit": 100,
            "offset": 0,
            "projection": { "fields": ["id", "code"] },
        }))
        .unwrap();
        let p = q
            .projection
            .expect("projection dropped at the IPC boundary");
        assert_eq!(p.fields, vec!["id", "code"]);
        // `exclude` absent is an inclusion — the only kind SQL takes.
        assert!(!p.exclude);
    }

    #[test]
    fn table_scan_carries_the_export_s_order_and_projection() {
        let q: TableScan = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "device",
            "order": [{ "column": "ts", "desc": true }],
            "projection": { "fields": ["ts"], "exclude": false },
        }))
        .unwrap();
        assert_eq!(q.order.len(), 1);
        assert_eq!(q.projection.unwrap().fields, vec!["ts"]);

        // The count payload, which sends neither, still parses.
        let count: TableScan = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "device",
        }))
        .unwrap();
        assert!(count.order.is_empty());
        assert!(count.projection.is_none());
    }

    #[test]
    fn select_list_quotes_projected_columns_and_defaults_to_star() {
        assert_eq!(select_list(Dialect::Postgres, None).unwrap(), "*");
        assert_eq!(
            select_list(Dialect::Postgres, Some(&Projection::default())).unwrap(),
            "*"
        );
        let p = Projection {
            fields: vec!["id".into(), "atn id".into()],
            exclude: false,
        };
        assert_eq!(
            select_list(Dialect::Postgres, Some(&p)).unwrap(),
            r#""id", "atn id""#
        );
        assert_eq!(
            select_list(Dialect::Mysql, Some(&p)).unwrap(),
            "`id`, `atn id`"
        );
    }

    #[test]
    fn select_list_rejects_an_exclusion_rather_than_guessing() {
        let p = Projection {
            fields: vec!["configuration".into()],
            exclude: true,
        };
        assert!(select_list(Dialect::Sqlite, Some(&p)).is_err());
    }

    #[test]
    fn order_by_clause_keeps_precedence_and_quotes() {
        assert_eq!(order_by_clause(Dialect::Postgres, &[], None).unwrap(), "");
        let order = vec![
            SortSpec {
                column: "ts".into(),
                desc: true,
            },
            SortSpec {
                column: "code".into(),
                desc: false,
            },
        ];
        assert_eq!(
            order_by_clause(Dialect::Postgres, &order, None).unwrap(),
            r#" ORDER BY "ts" DESC, "code" ASC"#
        );
        // A collation lands on every key, in the dialect's spelling.
        assert_eq!(
            order_by_clause(Dialect::Postgres, &order, Some("es-ES-x-icu")).unwrap(),
            r#" ORDER BY "ts" COLLATE "es-ES-x-icu" DESC, "code" COLLATE "es-ES-x-icu" ASC"#
        );
    }

    #[test]
    fn collate_clause_takes_only_what_each_dialect_can_name() {
        assert_eq!(
            collate_clause(Dialect::Mysql, Some("utf8mb4_spanish_ci")).unwrap(),
            " COLLATE utf8mb4_spanish_ci"
        );
        assert_eq!(
            collate_clause(Dialect::MsSql, Some("Latin1_General_CI_AS")).unwrap(),
            " COLLATE Latin1_General_CI_AS"
        );
        assert_eq!(
            collate_clause(Dialect::Sqlite, Some("nocase")).unwrap(),
            " COLLATE NOCASE"
        );
        // Interpolated, so anything that is not a bare name is refused.
        assert!(collate_clause(Dialect::Mysql, Some("utf8mb4_bin; DROP")).is_err());
        assert!(collate_clause(Dialect::Sqlite, Some("es_ES")).is_err());
        // PostgreSQL names are identifiers, so quoting makes any of them safe.
        assert_eq!(
            collate_clause(Dialect::Postgres, Some("a\"b")).unwrap(),
            r#" COLLATE "a""b""#
        );
        assert_eq!(collate_clause(Dialect::Postgres, None).unwrap(), "");
    }

    #[test]
    fn from_clause_spells_the_hint_per_dialect_and_refuses_it_on_postgres() {
        assert_eq!(
            from_clause(Dialect::Mysql, "`t`", Some("idx_code")).unwrap(),
            "`t` FORCE INDEX (`idx_code`)"
        );
        assert_eq!(
            from_clause(Dialect::Sqlite, "\"t\"", Some("idx_code")).unwrap(),
            "\"t\" INDEXED BY \"idx_code\""
        );
        assert_eq!(
            from_clause(Dialect::MsSql, "[t]", Some("idx_code")).unwrap(),
            "[t] WITH (INDEX([idx_code]))"
        );
        assert!(from_clause(Dialect::Postgres, "\"t\"", Some("idx_code")).is_err());
        assert_eq!(
            from_clause(Dialect::Postgres, "\"t\"", None).unwrap(),
            "\"t\""
        );
    }

    #[test]
    fn table_query_carries_collation_and_hint() {
        let q: TableQuery = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "t",
            "limit": 10,
            "offset": 0,
            "collation": "utf8mb4_bin",
            "hint": " idx_code ",
        }))
        .unwrap();
        assert_eq!(nonblank(&q.collation), Some("utf8mb4_bin"));
        assert_eq!(nonblank(&q.hint), Some("idx_code"));
    }

    // --- The query panel's Explain -----------------------------------------

    #[test]
    fn explain_never_runs_the_statement_and_refuses_sql_server() {
        // None of the three prefixes executes: ANALYZE is what would.
        for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite] {
            let p = explain_prefix(d).unwrap();
            assert!(p.starts_with("EXPLAIN"), "{p}");
            assert!(!p.contains("ANALYZE"), "{p}");
        }
        assert!(explain_prefix(Dialect::MsSql).is_err());
    }

    #[test]
    fn plan_from_rows_reads_each_engine_s_answer() {
        let one = |v: serde_json::Value| vec![vec![v]];
        let col = vec![("QUERY PLAN".to_string(), "json".to_string())];
        // PostgreSQL: the json cell, decoded or not.
        assert_eq!(
            plan_from_rows(Dialect::Postgres, &col, one(json!([{ "Plan": {} }]))),
            json!([{ "Plan": {} }])
        );
        // MySQL: JSON as text.
        assert_eq!(
            plan_from_rows(Dialect::Mysql, &col, one(json!("{\"query_block\":{}}"))),
            json!({ "query_block": {} })
        );
        // SQLite: one step per row, without the unused column.
        let cols = vec![
            ("id".to_string(), "int".to_string()),
            ("parent".to_string(), "int".to_string()),
            ("notused".to_string(), "int".to_string()),
            ("detail".to_string(), "text".to_string()),
        ];
        let rows = vec![vec![json!(2), json!(0), json!(0), json!("SCAN t")]];
        assert_eq!(
            plan_from_rows(Dialect::Sqlite, &cols, rows),
            json!([{ "id": 2, "parent": 0, "detail": "SCAN t" }])
        );
    }

    // --- The query panel's expression ------------------------------------

    fn with_raw(raw: &str) -> TableFilter {
        TableFilter {
            raw: Some(raw.to_string()),
            ..TableFilter::default()
        }
    }

    #[test]
    fn a_blank_expression_is_not_a_predicate() {
        assert!(with_raw("   ").is_unfiltered());
        assert!(!with_raw("qty > 3").is_unfiltered());
    }

    #[test]
    fn the_expression_is_anded_on_its_own_lines() {
        let f = TableFilter {
            filters: vec![ColumnFilter {
                column: "code".into(),
                op: FilterOp::Eq,
                value: json!("A"),
                value2: Value::Null,
                values: Vec::new(),
            }],
            raw: Some("qty > 3 OR qty IS NULL -- note".into()),
            ..TableFilter::default()
        };
        let (clause, binds) = f.clause(Dialect::Postgres).unwrap();
        assert_eq!(
            clause,
            " WHERE \"code\" = $1 AND (\nqty > 3 OR qty IS NULL -- note\n)"
        );
        assert_eq!(binds.len(), 1);

        let (alone, _) = with_raw("qty > 3").clause(Dialect::Mysql).unwrap();
        assert_eq!(alone, " WHERE (\nqty > 3\n)");
    }

    #[test]
    fn validate_raw_where_rejects_what_would_leave_the_condition() {
        for bad in [
            "1 = 1; DROP TABLE t",
            "a = 1) OR (1 = 1",
            "(a = 1",
            "name = 'unterminated",
            "a = 1 /* never closed",
            "\"unterminated",
        ] {
            assert!(validate_raw_where(bad).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn validate_raw_where_accepts_what_only_looks_dangerous() {
        for good in [
            "note = 'a; b'",
            "note = 'it''s (fine'",
            "\"odd;name\" = 1",
            "a = 1 -- trailing ; comment",
            "a = 1 /* ; ( */ AND b = 2",
            "[weird)name] = 1",
            "(a = 1 OR b = 2) AND c IN (1, 2)",
        ] {
            assert!(validate_raw_where(good).is_ok(), "rejected: {good}");
        }
    }

    #[test]
    fn inline_binds_replaces_placeholders_but_not_inside_quotes() {
        let binds = vec![Some("it's".to_string()), None];
        assert_eq!(
            inline_binds(Dialect::Postgres, "a = $1 AND \"$2x\" = $2", &binds),
            "a = 'it''s' AND \"$2x\" = NULL"
        );
        assert_eq!(
            inline_binds(Dialect::Sqlite, "a = ? AND b = '?' AND c = ?", &binds),
            "a = 'it''s' AND b = '?' AND c = NULL"
        );
        assert_eq!(
            inline_binds(Dialect::MsSql, "a = @P1", &binds),
            "a = 'it''s'"
        );
        // MySQL treats a backslash as an escape inside a string literal.
        let bs = vec![Some("C:\\tmp".to_string())];
        assert_eq!(
            inline_binds(Dialect::Mysql, "p = ?", &bs),
            "p = 'C:\\\\tmp'"
        );
    }

    #[test]
    fn table_query_carries_the_expression() {
        let q: TableQuery = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "t",
            "limit": 10,
            "offset": 0,
            "raw": "qty > 3",
        }))
        .unwrap();
        assert_eq!(q.filter.raw_text(), Some("qty > 3"));
    }

    #[test]
    fn an_empty_search_string_is_not_a_predicate() {
        // The grid clears its search box to `""`, not to `undefined`. Treating
        // that as a needle would build `LIKE '%%'` and, worse, disqualify the
        // whole-table fast count estimate.
        let q: TableScan = serde_json::from_value(json!({
            "connectionId": "c1",
            "table": "album",
            "search": "",
        }))
        .unwrap();

        assert_eq!(q.filter.needle(), None);
        assert!(q.filter.is_unfiltered());
    }
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
}

#[cfg(test)]
mod row_value_tests {
    use super::*;
    use serde_json::json;

    /// The shape `src/lib/tauri.ts` actually sends. Tauri does not rename the
    /// fields of a nested struct, so this is the spelling that has to work.
    #[test]
    fn row_value_reads_the_frontends_camel_case_type_hint() {
        let rv: RowValue = serde_json::from_value(
            json!({ "column": "atnId", "value": "5", "columnType": "long" }),
        )
        .unwrap();
        assert_eq!(rv.column_type.as_deref(), Some("long"));
    }

    #[test]
    fn row_value_still_accepts_the_snake_case_spelling() {
        let rv: RowValue =
            serde_json::from_value(json!({ "column": "b", "value": "1", "column_type": "BIT" }))
                .unwrap();
        assert_eq!(rv.column_type.as_deref(), Some("BIT"));
    }

    /// The bridge serializes a `RowValue` in one process and deserializes it
    /// in another, so the hint must survive its own round trip.
    #[test]
    fn row_value_type_hint_survives_a_serde_round_trip() {
        let rv = RowValue {
            column: "ts".into(),
            value: Some("1790338189273".into()),
            column_type: Some("long".into()),
        };
        let back: RowValue = serde_json::from_value(serde_json::to_value(&rv).unwrap()).unwrap();
        assert_eq!(back.column_type.as_deref(), Some("long"));
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

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
