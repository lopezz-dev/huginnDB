//! The rest of a browse's SQL: the projection, `FROM` (with its index hint),
//! collation and `ORDER BY`, and the page statement they assemble into — which
//! `fetch_table_data`, the query panel's *Result* line and its *Explain* all
//! build through [`sql_page_statement`], so the three cannot describe different
//! statements. Also reading an `EXPLAIN`'s answer into the plan the panel shows.

use super::types::{SortSpec, TableQuery};
use crate::db::sql::{BindTypes, Dialect};
use crate::error::{AppError, AppResult};
use crate::state::DbPool;
use serde::Deserialize;

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
///
/// `types` comes from [`page_bind_types`]; it is a separate step because this
/// one stays pure.
pub(super) fn sql_page_statement(
    dialect: Dialect,
    q: &TableQuery,
    types: &BindTypes,
) -> AppResult<(String, Vec<Option<String>>)> {
    let order_clause = order_by_clause(dialect, &q.order, nonblank(&q.collation))?;
    let select = select_list(dialect, q.projection.as_ref())?;
    let (where_clause, binds) = q.filter.clause(dialect, types)?;
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

/// The column types [`sql_page_statement`] casts its filter values to — on the
/// relation exactly as that statement names it.
pub(super) async fn page_bind_types(
    pool: &DbPool,
    dialect: Dialect,
    q: &TableQuery,
) -> AppResult<BindTypes> {
    let qt = dialect.qualify_defaulted(q.schema.as_deref(), &q.table);
    q.filter.bind_types(pool, &qt).await
}

/// The `EXPLAIN` form each SQL engine reads a plan with **without running the
/// statement**. SQL Server's plan needs `SET SHOWPLAN_XML ON` in a batch of its
/// own, which the single-statement executor cannot issue, so it is refused with
/// that reason rather than approximated.
pub(super) fn explain_prefix(dialect: Dialect) -> AppResult<&'static str> {
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
pub(super) fn plan_from_rows(
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
