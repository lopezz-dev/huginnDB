//! The `WHERE` of a browse: the column filters, the search box, and the
//! hand-written expression (`TableFilter::raw`), turned into one clause and its
//! binds by [`build_filter_clause_at`]. `commands::bulk` builds its `UPDATE`'s
//! `WHERE` from the same code, which is why most of it is `pub(crate)`.

use super::write::json_to_string;
use crate::db::sql::{BindTypes, Dialect};
use crate::error::{AppError, AppResult};
use crate::state::DbPool;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

/// Comparison operator accepted by [`ColumnFilter`].
///
/// The set is intentionally closed so we can map each variant to a fixed
/// SQL fragment without going through user-supplied strings. All variants
/// except `IsNull` / `IsNotNull` consume the filter's bound `value`; the
/// frontend advanced-filter builder (#66) only *offers* the type-appropriate
/// subset per column, but the backend accepts any op on any column: the
/// textual value is coerced by the engine (MySQL, SQLite, SQL Server) or cast
/// to the column's type in the SQL (Postgres, ADR #129).
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

    pub(super) fn validate(&self) -> AppResult<()> {
        validate_filters(&self.filters)
    }

    /// Whether some filter binds a value compared against its column, so the
    /// clause needs the column types on Postgres. The pattern matches, the
    /// search box and `IS [NOT] NULL` compare text or nothing.
    pub(super) fn compares_values(&self) -> bool {
        self.filters.iter().any(|f| match f.op {
            FilterOp::Eq
            | FilterOp::Ne
            | FilterOp::Gt
            | FilterOp::Gte
            | FilterOp::Lt
            | FilterOp::Lte
            | FilterOp::Between
            | FilterOp::In
            | FilterOp::NotIn => true,
            FilterOp::Contains
            | FilterOp::NotContains
            | FilterOp::StartsWith
            | FilterOp::EndsWith
            | FilterOp::IsNull
            | FilterOp::IsNotNull => false,
        })
    }

    /// The column types [`Self::clause`] needs on `qt`: a catalogue read on
    /// Postgres when some filter compares a value, and nothing — no round
    /// trip — otherwise, so an unfiltered browse costs what it always did.
    pub(crate) async fn bind_types(&self, pool: &DbPool, qt: &str) -> AppResult<BindTypes> {
        if self.compares_values() {
            crate::db::exec::bind_types(pool, qt).await
        } else {
            Ok(BindTypes::default())
        }
    }

    /// The `WHERE` clause and its binds for `dialect`, placeholders from 1,
    /// with the expression (validated) ANDed on the end.
    ///
    /// The expression goes on **its own lines inside its own parentheses**:
    /// the parentheses keep an `OR` in it from escaping the `AND` that binds it
    /// to the chips, and the line breaks keep a trailing `-- comment` from
    /// commenting out the `ORDER BY` / `LIMIT` that follow it.
    ///
    /// `types` casts the compared values on Postgres (ADR #129); see
    /// [`Self::bind_types`] for where it comes from.
    pub(crate) fn clause(
        &self,
        dialect: Dialect,
        types: &BindTypes,
    ) -> AppResult<(String, Vec<Option<String>>)> {
        let (built, binds, _) = build_filter_clause_at(
            1,
            dialect,
            &self.filters,
            self.needle(),
            &self.search_columns,
            types,
        );
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

/// Escape a user-supplied LIKE pattern so `%` and `_` lose their special
/// meaning. The resulting fragment is intended to be used with
/// `LIKE/ILIKE ... ESCAPE '\'`.
pub(super) fn escape_like(input: &str) -> String {
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
///
/// Untyped: the tests' shorthand for [`build_filter_clause_at`] from 1. The
/// browse goes through [`TableFilter::clause`], which carries the types.
#[cfg(test)]
pub(super) fn build_filter_clause(
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> (String, Vec<Option<String>>) {
    let (clause, binds, _) = build_filter_clause_at(
        1,
        dialect,
        filters,
        search,
        search_columns,
        &BindTypes::default(),
    );
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
///
/// `types` casts each value compared against a column to that column's type on
/// Postgres (ADR #129); the pattern matches compare text with text and take no
/// cast. Pass [`BindTypes::default`] on every other dialect.
pub(crate) fn build_filter_clause_at(
    start_at: usize,
    dialect: Dialect,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
    types: &BindTypes,
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
    // The same, for a value compared against `column` itself.
    let typed = |next: &mut usize, column: &str| -> String {
        let ph = dialect.typed_placeholder(*next, types.of(column));
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
                let ph = typed(&mut next_placeholder, &f.column);
                parts.push(format!("{col} {sym} {ph}"));
                binds.push(json_to_string(&f.value));
            }
            FilterOp::Between => {
                let ph1 = typed(&mut next_placeholder, &f.column);
                let ph2 = typed(&mut next_placeholder, &f.column);
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
                        .map(|_| typed(&mut next_placeholder, &f.column))
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
