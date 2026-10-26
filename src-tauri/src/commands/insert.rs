//! Insert rows into a SQL table from pasted JSON text.
//!
//! The SQL counterpart of [`crate::commands::query::insert_documents`], and the
//! answer to a different gap than the one that command closes.
//!
//! `insert_documents` exists because a MongoDB collection is schemaless: the
//! grid's column set is sampled from one page of documents, so a field the
//! sample did not show could not be typed at all. That argument genuinely does
//! not carry over — a SQL table has a column set the server enforces, and
//! there is nothing free-form document text can express that
//! [`crate::commands::query::insert_row`] cannot.
//!
//! What SQL is missing is **bulk**. `insert_row` is one row per call, so
//! "paste these forty rows" has no path at all short of hand-writing an
//! `INSERT` in the query editor. That is `ROADMAP.md`'s open item #1, and it is
//! what this module is: one object, or an array of them, becomes **one**
//! multi-row `INSERT` inside **one** transaction.
//!
//! Three constraints shape everything below.
//!
//! **Keys are not column names until the catalogue says so.** A JSON key is
//! user input; `quote_ident` is documented as catalog-only (convention #4). So the
//! keys are matched against [`list_columns_inner`] and what reaches the SQL is
//! the *catalogue's* spelling, never the pasted one. An unmatched key is a
//! refusal that names it, not a column invented on the spot.
//!
//! **Values bind as text** (ADR #5), so the coercion here is JSON → `String`
//! and the driver casts. The one thing text alone cannot get right is a
//! boolean, and the catalogue is what settles it — see [`coerce_value`].
//!
//! **Parse before touching the server.** Everything that can be rejected is
//! rejected while the pool is still untouched, so a typo is a message rather
//! than a half-applied insert. That is `insert_documents`' rule and it matters
//! more here, where one call can be thousands of rows.

use serde::Serialize;
use serde_json::{Map, Value};
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::commands::schema::{list_columns_inner, ColumnInfo};
use crate::db::sql::Dialect;
use crate::db::{exec, mssql, mysql};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::{AppState, DbPool};

/// Upper bound on how many rows one paste may carry, whatever its width.
///
/// Same spirit as [`crate::commands::query::MAX_IN_VALUES`]: the ceiling is not
/// really the engine, it is that a runaway paste becomes an unbounded statement
/// and a frozen window, and a refusal naming the limit is a better ending than
/// either.
pub const MAX_INSERT_ROWS: usize = 10_000;

/// Bind-parameter ceiling for one statement, per engine.
///
/// Exhaustive on purpose (ADR #30): a fifth dialect has to choose a number
/// here rather than inheriting Postgres's by way of a `_ =>` arm.
const fn max_binds(dialect: Dialect) -> usize {
    match dialect {
        // Both wire protocols count parameters in a u16.
        Dialect::Postgres => 65_535,
        Dialect::Mysql => 65_535,
        // `SQLITE_MAX_VARIABLE_NUMBER`, which defaults to 32766 from SQLite
        // 3.32 onwards; the bundled build is well past that.
        Dialect::Sqlite => 32_766,
        // TDS refuses at 2100. The headroom is for the clauses a statement may
        // grow later, and costs one extra chunk on a very wide paste.
        Dialect::MsSql => 2_000,
    }
}

/// One target column, always sourced from the catalogue.
///
/// `data_type` being the catalogue's and never the frontend's is what lets this
/// path skip the conditional catalogue round-trip `insert_row` and
/// `apply_bulk_update` both carry: their type hint comes from whatever schema
/// cache the caller had on hand, so they have to fall back when it is missing.
/// Here it is right by construction, and the MySQL `BIT` and SQL Server binary
/// cases come out correct for free.
#[derive(Debug, Clone)]
pub(crate) struct InsertColumn {
    pub name: String,
    pub data_type: Option<String>,
}

/// Optional per-engine primary-key recovery. `Default` is a plain `INSERT`.
///
/// Modelled as a struct rather than a suffix string because the two engines
/// disagree about *where* the clause goes: Postgres appends `RETURNING`, while
/// SQL Server's `OUTPUT INSERTED.<pk>` sits between the column list and
/// `VALUES`.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct InsertClauses<'a> {
    pub output_inserted: Option<&'a str>,
    pub returning: Option<&'a str>,
}

/// A built statement and the flat bind list that goes with it.
#[derive(Debug)]
pub(crate) struct InsertStatement {
    pub sql: String,
    pub binds: Vec<Option<String>>,
}

/// Build one `INSERT` covering every row in `rows`.
///
/// Pure: no pool, no state, no catalogue lookup — the caller has resolved all
/// of that already, which is what makes the whole per-dialect matrix testable
/// without a database.
///
/// `qt` must already be qualified (`Dialect::qualify_defaulted`), and every row
/// must have `columns.len()` values in `columns` order; the caller guarantees
/// both, so this stays total rather than returning a `Result` nothing could act
/// on.
///
/// The placeholder counter runs **continuously across rows** rather than
/// restarting per tuple, because Postgres's `$n` and SQL Server's `@Pn` number
/// the whole statement's bind list. (SQL Server's is a capital `P`; a lowercase
/// one is not an alias, and `PooledClient` requires the documented spelling.)
pub(crate) fn build_insert_statement(
    dialect: Dialect,
    qt: &str,
    columns: &[InsertColumn],
    rows: &[Vec<Option<String>>],
    clauses: InsertClauses<'_>,
) -> InsertStatement {
    let quoted_cols: Vec<String> = columns
        .iter()
        .map(|c| dialect.quote_ident(&c.name))
        .collect();

    let mut binds: Vec<Option<String>> = Vec::with_capacity(rows.len() * columns.len());
    let mut next = 1usize;
    let mut tuples: Vec<String> = Vec::with_capacity(rows.len());

    for row in rows {
        let mut cells: Vec<String> = Vec::with_capacity(columns.len());
        for (col, value) in columns.iter().zip(row) {
            let ph = dialect.placeholder(next);
            next += 1;
            // The type decision is per *column*; the placeholder and the bind
            // it wraps are per *cell*, so a BIT column is cast in every tuple
            // and not just the first.
            match dialect {
                Dialect::Mysql if col.data_type.as_deref().is_some_and(mysql::is_bit_type) => {
                    binds.push(value.as_deref().map(mysql::normalize_bit_value));
                    cells.push(mysql::bit_cast(&ph));
                }
                Dialect::MsSql => {
                    binds.push(value.clone());
                    cells.push(mssql::binary_convert(col.data_type.as_deref(), &ph));
                }
                Dialect::Postgres | Dialect::Mysql | Dialect::Sqlite => {
                    binds.push(value.clone());
                    cells.push(ph);
                }
            }
        }
        tuples.push(format!("({})", cells.join(", ")));
    }

    let output = clauses
        .output_inserted
        .map(|pk| format!(" OUTPUT INSERTED.{pk}"))
        .unwrap_or_default();
    let returning = clauses
        .returning
        .map(|pk| format!(" RETURNING {pk}"))
        .unwrap_or_default();

    InsertStatement {
        sql: format!(
            "INSERT INTO {qt} ({}){output} VALUES {}{returning}",
            quoted_cols.join(", "),
            tuples.join(", "),
        ),
        binds,
    }
}

/// How many rows one statement may carry before it exceeds the engine's bind
/// ceiling.
///
/// `Err` when a single row already blows the cap: that is a table wider than
/// the engine's parameter limit, which chunking cannot fix and which deserves
/// to say so rather than failing later with a driver error nobody can read.
fn rows_per_statement(dialect: Dialect, n_columns: usize) -> AppResult<usize> {
    let cap = max_binds(dialect);
    let per = cap / n_columns.max(1);
    if per == 0 {
        return Err(AppError::InvalidInput(format!(
            "insert: {n_columns} columns is more than this engine allows in one \
             statement ({cap} bind parameters) — insert fewer columns at a time"
        )));
    }
    Ok(per)
}

/// A human word for what a JSON value is, for the refusal messages.
///
/// The counterpart of `db::mongo::values::bson_type_name`, and the reason the
/// messages below can say "found a string" instead of echoing the text back.
fn json_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Parse the pasted text into one or more JSON objects.
///
/// Accepts an object or an array of objects and refuses everything else. The
/// message style is [`crate::db::mongo::query::parse_insert_source`]'s — always
/// name the offending index — though the parser is not: that one reads the
/// relaxed mongosh grammar, this one is strict JSON, because a SQL table has
/// no `ObjectId(…)` to be lenient about.
pub(crate) fn parse_rows_source(source: &str) -> AppResult<Vec<Map<String, Value>>> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "insert: nothing to insert (the text is empty)".into(),
        ));
    }
    let parsed: Value = serde_json::from_str(trimmed)
        // serde's own message carries the line and column, which is the whole
        // value of surfacing it rather than saying "invalid JSON".
        .map_err(|e| AppError::InvalidInput(format!("insert: not valid JSON — {e}")))?;

    let rows = match parsed {
        Value::Object(o) => {
            if o.is_empty() {
                return Err(AppError::InvalidInput(
                    "insert: the object has no columns".into(),
                ));
            }
            vec![o]
        }
        Value::Array(items) => {
            if items.is_empty() {
                return Err(AppError::InvalidInput(
                    "insert: the array is empty, so there is nothing to insert".into(),
                ));
            }
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.into_iter().enumerate() {
                match item {
                    Value::Object(o) if !o.is_empty() => out.push(o),
                    Value::Object(_) => {
                        return Err(AppError::InvalidInput(format!(
                            "insert: item {i} of the array has no columns"
                        )))
                    }
                    other => {
                        return Err(AppError::InvalidInput(format!(
                            "insert: item {i} of the array is {}, not an object",
                            json_type_name(&other)
                        )))
                    }
                }
            }
            out
        }
        other => {
            return Err(AppError::InvalidInput(format!(
                "insert: expected an object or an array of objects, found {}",
                json_type_name(&other)
            )))
        }
    };

    if rows.len() > MAX_INSERT_ROWS {
        return Err(AppError::InvalidInput(format!(
            "insert: {} rows exceeds the {MAX_INSERT_ROWS}-row limit for one paste",
            rows.len()
        )));
    }
    Ok(rows)
}

/// Map the pasted keys onto real catalogue columns.
///
/// Pure — the caller does the `list_columns_inner` round trip — so the gate
/// this implements is unit-testable without a database.
///
/// Matching is case-insensitive and the **catalogue's** spelling is what ends
/// up in the statement: that is the convention #4 gate, and it also means a paste
/// from a tool that upper-cases its keys works instead of being a puzzle.
///
/// Column *order* comes from the catalogue too, and that is not a preference.
/// `serde_json` is built without `preserve_order`, so a `Value::Object` is a
/// `BTreeMap` and its key order is alphabetical rather than what the user
/// typed — "keep the paste's order" is not an option that exists. Catalogue
/// order also matches what the grid shows and makes the SQL deterministic.
pub(crate) fn resolve_columns(
    catalog: &[ColumnInfo],
    rows: &[Map<String, Value>],
) -> AppResult<Vec<InsertColumn>> {
    // Every row must name the same columns; a multi-row VALUES list cannot say
    // anything else, and the two ways of pretending otherwise are both worse
    // than refusing — see the module docs on the alternatives.
    let first: Vec<&str> = {
        let mut k: Vec<&str> = rows[0].keys().map(String::as_str).collect();
        k.sort_unstable();
        k
    };
    for (i, row) in rows.iter().enumerate().skip(1) {
        let mut keys: Vec<&str> = row.keys().map(String::as_str).collect();
        keys.sort_unstable();
        if keys != first {
            let added: Vec<&str> = keys
                .iter()
                .copied()
                .filter(|k| !first.contains(k))
                .collect();
            let missing: Vec<&str> = first
                .iter()
                .copied()
                .filter(|k| !keys.contains(k))
                .collect();
            let mut diff = Vec::new();
            if !added.is_empty() {
                diff.push(format!("adds: {}", added.join(", ")));
            }
            if !missing.is_empty() {
                diff.push(format!("missing: {}", missing.join(", ")));
            }
            return Err(AppError::InvalidInput(format!(
                "insert: row {i} has a different column set than row 0 (row 0: {} — row {i} {}). \
                 Every row must name the same columns; split the paste, or add the missing keys \
                 explicitly (use null for a SQL NULL)",
                first.join(", "),
                diff.join(", ")
            )));
        }
    }

    // Resolve each pasted key once, against the catalogue.
    let mut resolved: Vec<InsertColumn> = Vec::with_capacity(first.len());
    for key in &first {
        let hit = catalog
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(key))
            .ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "insert: this table has no column \"{key}\" (its columns are: {})",
                    catalog
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        resolved.push(InsertColumn {
            name: hit.name.clone(),
            data_type: Some(hit.data_type.clone()),
        });
    }

    // Re-order into catalogue order.
    let rank = |name: &str| {
        catalog
            .iter()
            .position(|c| c.name == name)
            .unwrap_or(usize::MAX)
    };
    resolved.sort_by_key(|c| rank(&c.name));
    Ok(resolved)
}

/// True when `data_type` names a column the engine stores as a boolean.
///
/// Covers Postgres `bool`/`boolean`, SQL Server and MySQL `bit`, and MySQL's
/// `tinyint(1)`, which is what its own `BOOLEAN` alias expands to. Reuses
/// [`mysql::is_bit_type`] rather than repeating the `BIT` prefix test.
fn is_boolean_column(data_type: Option<&str>) -> bool {
    let Some(t) = data_type else { return false };
    let lower = t.trim().to_ascii_lowercase();
    lower.starts_with("bool") || lower == "tinyint(1)" || mysql::is_bit_type(t)
}

/// Turn one JSON value into the textual bind for `column`.
///
/// `Null` → `None` → SQL `NULL`, which is
/// [`crate::commands::query`]'s own convention for the delete path; strings
/// pass through unquoted; numbers and nested values render as their JSON.
///
/// **Booleans branch on the catalogue type, not on the dialect**, and the
/// reason is the case a dialect branch could not cover. `"1"`/`"0"` is in fact
/// accepted by all four engines' boolean inputs — Postgres's boolean parser
/// takes them, MySQL wants digits, and SQL Server's `bit` *rejects* `'true'` —
/// so the dialect never needs asking. What does need asking is the opposite
/// direction: a JSON `true` destined for a `text` column has to be stored as
/// `"true"`, not as `1`. Only the column's own type knows that, and we are
/// already holding it.
///
/// One caveat worth knowing rather than working around: `serde_json` is built
/// without `arbitrary_precision`, so an integer past `i64`/`u64` arrives as an
/// `f64` and renders in exponent form (`1e30`), which SQL Server's `decimal`
/// conversion rejects. Paste such a value as a JSON *string*. Enabling the
/// feature would change `Value::Number` semantics for every path in the app,
/// the MongoDB ones included, which is far too wide a blast radius for this.
pub(crate) fn coerce_value(v: &Value, column: &InsertColumn) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if is_boolean_column(column.data_type.as_deref()) {
            (if *b { "1" } else { "0" }).to_string()
        } else {
            b.to_string()
        }),
        // Compact JSON, which is what a `json`/`jsonb`/MySQL `JSON`/`nvarchar`
        // column wants, and a readable literal anywhere else.
        other => Some(other.to_string()),
    }
}

/// What [`insert_rows`] reports back.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowsSummary {
    /// Rows the server reported as inserted, summed across statements.
    pub inserted: u64,
    /// Statements the paste was split into — 1 unless a bind ceiling was hit.
    pub statements: usize,
    /// Columns actually written, in the order they appear in the statement.
    pub columns: Vec<String>,
}

/// Insert one or more rows into `schema.table` from pasted JSON text.
///
/// Refused on MongoDB, which has [`crate::commands::query::insert_documents`]
/// for the same gesture and a grammar this strict parser would reject.
///
/// **No generated ids come back, deliberately.** The four engines cannot agree
/// on what a multi-row insert's ids even are: MySQL's `last_insert_id()`
/// reports only the *first*, SQL Server's `SCOPE_IDENTITY()` only the last, and
/// only Postgres's `RETURNING` would hand over all of them. An honest count
/// beats one id out of five hundred. [`InsertClauses`] is the hook if per-row
/// ids are ever wanted on the two engines that can — but that asymmetry should
/// be a decision someone makes, not a side effect.
// Flat argument list is the IPC surface — same note as `insert_documents`.
#[tauri::command]
pub async fn insert_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    source: String,
) -> AppResult<InsertRowsSummary> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
    )?;
    // The columns a paste writes are its keys. Parsing here as well as in the
    // core keeps the policy out of `insert_rows_inner` (ADR #95); the text is
    // a paste, so reading it twice costs nothing worth a second signature.
    let rows = parse_rows_source(&source)?;
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
        rows.iter().flat_map(|r| r.keys()),
    )?;
    insert_rows_inner(&sink, state.inner(), connection_id, schema, table, source).await
}

/// Tauri-independent core of [`insert_rows`].
pub(crate) async fn insert_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: String,
    schema: Option<String>,
    table: String,
    source: String,
) -> AppResult<InsertRowsSummary> {
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::UnsupportedDriver(
            "insert_rows: pasting JSON rows is SQL-only — for MongoDB use the \
             document dialog, which takes the same text as documents"
                .into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;

    // Everything below this line up to `execute_params_in_tx` is validation,
    // and it all happens before the pool is written to.
    let rows = parse_rows_source(&source)?;

    // The catalogue read is the validation gate, not an optimisation, so its
    // failure propagates. `apply_bulk_update` degrades to an empty catalogue
    // here on purpose — it only wants type hints — but an empty catalogue in
    // this path would report every column in the paste as unknown.
    let catalog = list_columns_inner(state, &connection_id, schema.clone(), table.clone()).await?;
    let columns = resolve_columns(&catalog, &rows)?;

    let values: Vec<Vec<Option<String>>> = rows
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|col| {
                    // `resolve_columns` matched case-insensitively, so find the
                    // key the same way rather than assuming the paste used the
                    // catalogue's spelling.
                    row.iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(&col.name))
                        .and_then(|(_, v)| coerce_value(v, col))
                })
                .collect()
        })
        .collect();

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let per = rows_per_statement(dialect, columns.len())?;
    let batches: Vec<(String, Vec<Option<String>>)> = values
        .chunks(per)
        .map(|chunk| {
            let built =
                build_insert_statement(dialect, &qt, &columns, chunk, InsertClauses::default());
            (built.sql, built.binds)
        })
        .collect();

    let start = Instant::now();
    let result = exec::execute_params_in_tx(&pool, &batches).await;

    // One Console line, not one per chunk: the transaction is a single unit of
    // work, and N entries would read as N independently-committed statements.
    let logged = if batches.len() == 1 {
        batches[0].0.clone()
    } else {
        format!(
            "{}\n/* + {} more statements in the same transaction ({} rows total) */",
            batches[0].0,
            batches.len() - 1,
            values.len()
        )
    };
    match &result {
        Ok(affected) => log_sql_sink(
            sink,
            &connection_id,
            driver,
            &logged,
            start,
            Some(affected.iter().sum()),
            None,
        ),
        Err(e) => log_sql_sink(
            sink,
            &connection_id,
            driver,
            &logged,
            start,
            None,
            Some(&e.to_string()),
        ),
    }

    Ok(InsertRowsSummary {
        inserted: result?.iter().sum(),
        statements: batches.len(),
        columns: columns.into_iter().map(|c| c.name).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> InsertColumn {
        InsertColumn {
            name: name.to_string(),
            data_type: Some(data_type.to_string()),
        }
    }

    fn cat(specs: &[(&str, &str)]) -> Vec<ColumnInfo> {
        specs
            .iter()
            .map(|(name, data_type)| ColumnInfo {
                name: name.to_string(),
                data_type: data_type.to_string(),
                nullable: true,
                is_primary_key: false,
                referenced_schema: None,
                referenced_table: None,
                referenced_column: None,
            })
            .collect()
    }

    fn v(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    fn rows_of(src: &str) -> Vec<Map<String, Value>> {
        parse_rows_source(src).expect("should parse")
    }

    // ── The statement builder: placeholder shapes ────────────────────────────

    #[test]
    fn postgres_numbers_placeholders_continuously_across_rows() {
        let cols = vec![col("a", "text"), col("b", "text")];
        let rows = vec![
            vec![v("1"), v("2")],
            vec![v("3"), v("4")],
            vec![v("5"), v("6")],
        ];
        let built = build_insert_statement(
            Dialect::Postgres,
            "\"public\".\"t\"",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert_eq!(
            built.sql,
            "INSERT INTO \"public\".\"t\" (\"a\", \"b\") VALUES ($1, $2), ($3, $4), ($5, $6)"
        );
        assert_eq!(built.binds.len(), 6);
        assert_eq!(built.binds[0], v("1"));
        assert_eq!(built.binds[5], v("6"));
    }

    #[test]
    fn mysql_and_sqlite_use_bare_question_marks() {
        let cols = vec![col("a", "text"), col("b", "text")];
        let rows = vec![vec![v("1"), v("2")], vec![v("3"), v("4")]];
        for (dialect, qt, expected) in [
            (
                Dialect::Mysql,
                "`t`",
                "INSERT INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)",
            ),
            (
                Dialect::Sqlite,
                "\"t\"",
                "INSERT INTO \"t\" (\"a\", \"b\") VALUES (?, ?), (?, ?)",
            ),
        ] {
            let built = build_insert_statement(dialect, qt, &cols, &rows, InsertClauses::default());
            assert_eq!(built.sql, expected, "{dialect:?}");
            assert_eq!(built.binds.len(), 4, "{dialect:?}");
        }
    }

    /// The capital `P` is not cosmetic: `Dialect::placeholder` emits `@P1` and
    /// `PooledClient::query_rows` requires that spelling.
    #[test]
    fn sql_server_numbers_placeholders_with_a_capital_p() {
        let cols = vec![col("a", "int"), col("b", "int")];
        let rows = vec![vec![v("1"), v("2")], vec![v("3"), v("4")]];
        let built = build_insert_statement(
            Dialect::MsSql,
            "[dbo].[t]",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert_eq!(
            built.sql,
            "INSERT INTO [dbo].[t] ([a], [b]) VALUES (@P1, @P2), (@P3, @P4)"
        );
    }

    /// The regression gate for folding `insert_row_inner` onto this builder:
    /// a one-row call with no clauses must produce what that path produces
    /// today, byte for byte.
    #[test]
    fn a_single_row_builds_the_plain_insert_row_statement() {
        let cols = vec![col("a", "text"), col("b", "text")];
        let rows = vec![vec![v("x"), None]];
        let built = build_insert_statement(
            Dialect::Postgres,
            "\"public\".\"t\"",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert_eq!(
            built.sql,
            "INSERT INTO \"public\".\"t\" (\"a\", \"b\") VALUES ($1, $2)"
        );
        assert_eq!(built.binds, vec![v("x"), None]);
    }

    // ── Per-driver type handling ─────────────────────────────────────────────

    /// The type decision is per column but the cast is per cell, so a second
    /// row must be cast too — that is the bug this shape exists to avoid.
    #[test]
    fn a_mysql_bit_column_is_cast_in_every_row_tuple() {
        let cols = vec![col("flag", "bit(1)"), col("name", "varchar(20)")];
        let rows = vec![vec![v("true"), v("a")], vec![v("false"), v("b")]];
        let built = build_insert_statement(
            Dialect::Mysql,
            "`t`",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert_eq!(
            built.sql,
            "INSERT INTO `t` (`flag`, `name`) VALUES (CAST(? AS UNSIGNED), ?), \
             (CAST(? AS UNSIGNED), ?)"
        );
        // `normalize_bit_value` turns the words into digits; the plain column
        // beside it is untouched.
        assert_eq!(built.binds, vec![v("1"), v("a"), v("0"), v("b")]);
    }

    #[test]
    fn a_null_into_a_mysql_bit_column_stays_null() {
        let cols = vec![col("flag", "BIT")];
        let rows = vec![vec![None]];
        let built = build_insert_statement(
            Dialect::Mysql,
            "`t`",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert!(built.sql.contains("CAST(? AS UNSIGNED)"), "{}", built.sql);
        assert_eq!(built.binds, vec![None]);
    }

    #[test]
    fn a_sql_server_binary_column_is_converted_per_row() {
        let cols = vec![col("blob", "varbinary"), col("name", "nvarchar")];
        let rows = vec![vec![v("0x4A"), v("a")], vec![v("0x2B"), v("b")]];
        let built = build_insert_statement(
            Dialect::MsSql,
            "[t]",
            &cols,
            &rows,
            InsertClauses::default(),
        );
        assert_eq!(
            built.sql,
            "INSERT INTO [t] ([blob], [name]) VALUES \
             (CONVERT(varbinary(max), @P1, 1), @P2), (CONVERT(varbinary(max), @P3, 1), @P4)"
        );
    }

    #[test]
    fn identifiers_are_quoted_per_dialect() {
        let cols = vec![col("we\"ird", "text")];
        let rows = vec![vec![v("x")]];
        for (dialect, qt, expected_col) in [
            (Dialect::Postgres, "\"t\"", "\"we\"\"ird\""),
            (Dialect::Mysql, "`t`", "`we\"ird`"),
            (Dialect::MsSql, "[t]", "[we\"ird]"),
        ] {
            let built = build_insert_statement(dialect, qt, &cols, &rows, InsertClauses::default());
            assert!(
                built.sql.contains(expected_col),
                "{dialect:?}: {}",
                built.sql
            );
        }
    }

    // ── Clauses (the surface the insert_row refactor will use) ───────────────

    #[test]
    fn postgres_returning_is_appended() {
        let cols = vec![col("a", "text")];
        let rows = vec![vec![v("x")]];
        let built = build_insert_statement(
            Dialect::Postgres,
            "\"t\"",
            &cols,
            &rows,
            InsertClauses {
                returning: Some("\"id\""),
                ..Default::default()
            },
        );
        assert_eq!(
            built.sql,
            "INSERT INTO \"t\" (\"a\") VALUES ($1) RETURNING \"id\""
        );
    }

    /// T-SQL puts `OUTPUT INSERTED` *between* the column list and `VALUES`,
    /// which is why the clauses are a struct and not a suffix string.
    #[test]
    fn sql_server_output_inserted_sits_before_values() {
        let cols = vec![col("a", "int")];
        let rows = vec![vec![v("1")]];
        let built = build_insert_statement(
            Dialect::MsSql,
            "[t]",
            &cols,
            &rows,
            InsertClauses {
                output_inserted: Some("[id]"),
                ..Default::default()
            },
        );
        assert_eq!(
            built.sql,
            "INSERT INTO [t] ([a]) OUTPUT INSERTED.[id] VALUES (@P1)"
        );
    }

    // ── Chunking ─────────────────────────────────────────────────────────────

    #[test]
    fn sql_server_chunks_a_wide_paste_and_postgres_does_not() {
        assert_eq!(rows_per_statement(Dialect::MsSql, 20).unwrap(), 100);
        assert_eq!(rows_per_statement(Dialect::Postgres, 20).unwrap(), 3276);
        assert_eq!(rows_per_statement(Dialect::Sqlite, 1).unwrap(), 32_766);
    }

    #[test]
    fn a_row_wider_than_the_parameter_cap_is_refused_by_name() {
        let err = rows_per_statement(Dialect::MsSql, 2500).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("2500 columns"), "{msg}");
        assert!(msg.contains("2000"), "{msg}");
    }

    /// The invariant that matters more than the exact chunk size: no chunk may
    /// exceed the cap, and none may split a row down the middle.
    #[test]
    fn a_chunk_never_splits_a_row_and_never_exceeds_the_cap() {
        for dialect in [
            Dialect::Postgres,
            Dialect::Mysql,
            Dialect::Sqlite,
            Dialect::MsSql,
        ] {
            for n_columns in [1usize, 3, 20, 137] {
                let per = rows_per_statement(dialect, n_columns).unwrap();
                let cols: Vec<InsertColumn> = (0..n_columns)
                    .map(|i| col(&format!("c{i}"), "text"))
                    .collect();
                let all: Vec<Vec<Option<String>>> = vec![vec![v("x"); n_columns]; (per * 2) + 1];
                for chunk in all.chunks(per) {
                    let built = build_insert_statement(
                        dialect,
                        "\"t\"",
                        &cols,
                        chunk,
                        InsertClauses::default(),
                    );
                    assert_eq!(
                        built.binds.len() % n_columns,
                        0,
                        "{dialect:?}/{n_columns}: chunk split a row"
                    );
                    assert!(
                        built.binds.len() <= max_binds(dialect),
                        "{dialect:?}/{n_columns}: chunk of {} binds over the cap",
                        built.binds.len()
                    );
                }
            }
        }
    }

    // ── Parsing ──────────────────────────────────────────────────────────────

    #[test]
    fn a_single_object_is_one_row_and_an_array_is_many() {
        assert_eq!(rows_of(r#"{"a": 1}"#).len(), 1);
        assert_eq!(rows_of(r#"[{"a": 1}, {"a": 2}, {"a": 3}]"#).len(), 3);
    }

    #[test]
    fn empty_text_an_empty_array_and_an_empty_object_are_all_refused() {
        for src in ["", "   \n ", "[]", "{}"] {
            assert!(parse_rows_source(src).is_err(), "{src:?} should be refused");
        }
    }

    #[test]
    fn a_scalar_at_the_top_level_names_what_it_found() {
        let msg = parse_rows_source("42").unwrap_err().to_string();
        assert!(msg.contains("a number"), "{msg}");
        let msg = parse_rows_source(r#""hi""#).unwrap_err().to_string();
        assert!(msg.contains("a string"), "{msg}");
    }

    #[test]
    fn a_non_object_array_item_names_its_index() {
        let msg = parse_rows_source(r#"[{"a":1},{"a":2},7]"#)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("item 2"), "{msg}");
        assert!(msg.contains("a number"), "{msg}");
    }

    /// serde's message carries the position, which is the whole reason it is
    /// surfaced instead of a flat "invalid JSON".
    #[test]
    fn invalid_json_keeps_serdes_line_and_column() {
        let msg = parse_rows_source("{\"a\": 1,\n \"b\" 2}")
            .unwrap_err()
            .to_string();
        assert!(msg.contains("line 2"), "{msg}");
    }

    #[test]
    fn more_rows_than_the_cap_are_refused() {
        let body = (0..MAX_INSERT_ROWS + 1)
            .map(|i| format!("{{\"a\":{i}}}"))
            .collect::<Vec<_>>()
            .join(",");
        let msg = parse_rows_source(&format!("[{body}]"))
            .unwrap_err()
            .to_string();
        assert!(msg.contains(&MAX_INSERT_ROWS.to_string()), "{msg}");
    }

    // ── Column resolution ────────────────────────────────────────────────────

    #[test]
    fn a_heterogeneous_row_names_the_row_and_both_sides_of_the_difference() {
        let catalog = cat(&[("a", "text"), ("b", "text"), ("c", "text")]);
        let rows = rows_of(r#"[{"a":1,"b":2},{"a":1,"c":3}]"#);
        let msg = resolve_columns(&catalog, &rows).unwrap_err().to_string();
        assert!(msg.contains("row 1"), "{msg}");
        assert!(msg.contains("adds: c"), "{msg}");
        assert!(msg.contains("missing: b"), "{msg}");
    }

    #[test]
    fn the_same_keys_in_a_different_order_are_accepted() {
        let catalog = cat(&[("a", "text"), ("b", "text")]);
        let rows = rows_of(r#"[{"a":1,"b":2},{"b":3,"a":4}]"#);
        let cols = resolve_columns(&catalog, &rows).unwrap();
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    #[test]
    fn an_unknown_key_is_refused_and_the_valid_columns_are_listed() {
        let catalog = cat(&[("id", "int"), ("email", "text")]);
        let rows = rows_of(r#"{"id":1,"emial":"x"}"#);
        let msg = resolve_columns(&catalog, &rows).unwrap_err().to_string();
        assert!(msg.contains("\"emial\""), "{msg}");
        assert!(msg.contains("id, email"), "{msg}");
    }

    /// The convention #4 gate: what reaches `quote_ident` is the catalogue's
    /// spelling, never the pasted key.
    #[test]
    fn keys_match_case_insensitively_and_the_catalogue_spelling_wins() {
        let catalog = cat(&[("id", "int")]);
        let rows = rows_of(r#"{"ID":1}"#);
        let cols = resolve_columns(&catalog, &rows).unwrap();
        assert_eq!(cols[0].name, "id");

        let values = vec![vec![v("1")]];
        let built = build_insert_statement(
            Dialect::Postgres,
            "\"t\"",
            &cols,
            &values,
            InsertClauses::default(),
        );
        assert!(built.sql.contains("(\"id\")"), "{}", built.sql);
    }

    /// `serde_json` is a BTreeMap here, so key order is alphabetical anyway —
    /// the catalogue is the only order that means anything.
    #[test]
    fn column_order_follows_the_catalogue_not_the_json() {
        let catalog = cat(&[("b", "text"), ("a", "text")]);
        let rows = rows_of(r#"{"a":1,"b":2}"#);
        let cols = resolve_columns(&catalog, &rows).unwrap();
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
    }

    #[test]
    fn the_catalogue_data_type_rides_along_so_bit_handling_needs_no_hint() {
        let catalog = cat(&[("flag", "bit(1)")]);
        let rows = rows_of(r#"{"flag":true}"#);
        let cols = resolve_columns(&catalog, &rows).unwrap();
        assert_eq!(cols[0].data_type.as_deref(), Some("bit(1)"));
    }

    // ── Coercion ─────────────────────────────────────────────────────────────

    #[test]
    fn json_null_binds_a_sql_null() {
        assert_eq!(coerce_value(&Value::Null, &col("a", "text")), None);
    }

    #[test]
    fn a_boolean_into_a_boolean_column_becomes_one_or_zero() {
        // All four engines take digits for their boolean input; SQL Server's
        // `bit` is the one that outright rejects 'true'.
        for t in ["boolean", "bool", "bit", "BIT(1)", "tinyint(1)"] {
            assert_eq!(
                coerce_value(&Value::Bool(true), &col("f", t)),
                v("1"),
                "{t}"
            );
            assert_eq!(
                coerce_value(&Value::Bool(false), &col("f", t)),
                v("0"),
                "{t}"
            );
        }
    }

    /// The case a dialect branch could not have covered.
    #[test]
    fn a_boolean_into_a_text_column_stays_true_or_false() {
        for t in ["text", "varchar(20)", "nvarchar(max)", "json"] {
            assert_eq!(
                coerce_value(&Value::Bool(true), &col("f", t)),
                v("true"),
                "{t}"
            );
        }
    }

    #[test]
    fn a_nested_value_is_bound_as_compact_json() {
        let nested: Value = serde_json::from_str(r#"{"k": [1, 2]}"#).unwrap();
        assert_eq!(
            coerce_value(&nested, &col("doc", "jsonb")),
            v(r#"{"k":[1,2]}"#)
        );
    }

    #[test]
    fn numbers_and_strings_keep_their_json_rendering() {
        let parsed: Map<String, Value> =
            match serde_json::from_str(r#"{"i":1,"f":1.5,"s":"x"}"#).unwrap() {
                Value::Object(o) => o,
                _ => unreachable!(),
            };
        assert_eq!(coerce_value(&parsed["i"], &col("i", "int")), v("1"));
        assert_eq!(coerce_value(&parsed["f"], &col("f", "numeric")), v("1.5"));
        // A string passes through unquoted — the bind carries it, not the SQL.
        assert_eq!(coerce_value(&parsed["s"], &col("s", "text")), v("x"));
    }
}
