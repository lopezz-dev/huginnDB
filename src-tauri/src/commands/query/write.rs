//! Row writes from the grid: `UPDATE` of one cell, `DELETE` of rows addressed
//! by primary key, and `INSERT` of one row (MongoDB documents included). The
//! statement builders are pure and `pub(crate)` so `commands::paste` plans a
//! pasted block with exactly the statements these commands would run.

use super::types::RowValue;
use crate::commands::insert::{build_insert_statement, InsertClauses, InsertColumn};
use crate::commands::schema::list_columns_inner;
use crate::db::mysql;
use crate::db::sql::{BindTypes, Dialect};
use crate::db::values::pg_value;
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink, SqlLog};
use crate::state::{AppState, DbPool};
use serde_json::Value;
use std::time::Instant;

/// The `UPDATE` one cell write runs, and its binds: `column` set on the row
/// whose primary key is `pk_values`. Shared by [`update_cell`] and the
/// multi-cell paste (`commands::paste`), so the two cannot drift on quoting,
/// placeholder numbering, MySQL's `BIT` cast or SQL Server's binary
/// `CONVERT`.
///
/// `qt` is the already-qualified table; `bit_cast` is whether `column` is a
/// MySQL `BIT`, which the caller decides because it may need the catalogue.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_statement(
    dialect: Dialect,
    qt: &str,
    column: &str,
    column_type: Option<&str>,
    bit_cast: bool,
    pk_columns: &[String],
    value: Option<String>,
    pk_values: &[Value],
    types: &BindTypes,
) -> (String, Vec<Option<String>>) {
    let col_id = dialect.quote_ident(column);
    // SET uses placeholder #1; the PK predicate consumes #2..=#N+1 on the
    // dialects that number their placeholders.
    let where_clause = pk_columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{} = {}",
                dialect.quote_ident(c),
                dialect.typed_placeholder(i + 2, types.of(c))
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let set_placeholder = if bit_cast {
        mysql::bit_cast(&dialect.placeholder(1))
    } else if dialect == Dialect::MsSql {
        // The same "text literal, wrong coercion" problem MySQL BIT has, for
        // SQL Server's binary family — see `db::mssql::binary_convert`.
        crate::db::mssql::binary_convert(column_type, &dialect.placeholder(1))
    } else {
        dialect.typed_placeholder(1, types.of(column))
    };
    let sql = format!("UPDATE {qt} SET {col_id} = {set_placeholder} WHERE {where_clause}");
    let effective_value = if bit_cast {
        value.as_deref().map(mysql::normalize_bit_value)
    } else {
        value
    };
    let mut binds = Vec::with_capacity(pk_values.len() + 1);
    binds.push(effective_value);
    binds.extend(pk_values.iter().map(json_to_string));
    (sql, binds)
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
        return SqlLog::new(sink, &connection_id, driver).outcome(
            "(mongo update)",
            start,
            res,
            |n| *n,
        );
    }

    let dialect = Dialect::try_of(&pool)?;
    // `schema` is consumed below to build `qt`; keep a copy for the catalog
    // fallback further down (only actually read when `column_type` is absent).
    let schema_for_catalog = schema.clone();

    let qt = dialect.qualify(schema.as_deref(), &table);

    // The cell value travels as a textual literal (ADR #5) and MySQL coerces
    // it to the column type server-side. That coercion is wrong for
    // MySQL `BIT`: binding the string "1" makes MySQL store the ASCII byte
    // 0x31 (the character '1') rather than the integer 1, so editing a BIT
    // cell silently wrote garbage. Wrapping the placeholder in
    // `CAST(? AS UNSIGNED)` forces numeric interpretation of the literal,
    // and `CAST(NULL AS UNSIGNED)` is still NULL so the set-NULL path is
    // unaffected. Only MySQL needs this; SQLite takes the text as it is, and
    // Postgres gets its own cast below (ADR #129).
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
    // Postgres only, and not optional: without the casts every non-text key
    // or value fails `smallint = text` (ADR #129).
    let types = crate::db::exec::bind_types(&pool, &qt).await?;
    let (sql, binds) = update_cell_statement(
        dialect,
        &qt,
        &column,
        column_type.as_deref(),
        bit_cast,
        &pk_columns,
        value,
        &pk_values,
        &types,
    );

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

/// Coerce a JSON scalar to its textual SQL bind form. `null` becomes `None`
/// so the driver writes a SQL `NULL` rather than the four-byte string
/// `"null"`.
pub(super) fn json_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Tauri-independent core of [`delete_rows`], shared with the headless MCP
/// `delete_rows` write tool.
/// `DELETE FROM qt WHERE (pk…) IN ((…), …)` and its binds, one tuple per row.
///
/// Pure, like [`update_cell_statement`], so the SQL each dialect gets is
/// testable without a pool. `pk_value_rows` must already be arity-checked.
/// `types` casts each key value on Postgres (ADR #129).
pub(crate) fn delete_rows_statement(
    dialect: Dialect,
    qt: &str,
    pk_columns: &[String],
    pk_value_rows: &[Vec<Value>],
    types: &BindTypes,
) -> (String, Vec<Option<String>>) {
    let lhs = pk_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut counter = 0usize;
    let tuples = pk_value_rows
        .iter()
        .map(|row| {
            // Row values sit in `pk_columns` order, which names each one's type.
            let placeholders = pk_columns
                .iter()
                .take(row.len())
                .map(|c| {
                    counter += 1;
                    dialect.typed_placeholder(counter, types.of(c))
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
    (sql, binds)
}

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
        return SqlLog::new(sink, &connection_id, driver).outcome(
            "(mongo delete)",
            start,
            res,
            |n| *n,
        );
    }

    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let types = crate::db::exec::bind_types(&pool, &qt).await?;
    let (sql, binds) = delete_rows_statement(dialect, &qt, &pk_columns, &pk_value_rows, &types);

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
        return SqlLog::new(sink, &connection_id, driver).outcome(
            "(mongo insert)",
            start,
            res,
            |_| 1,
        );
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
    // Postgres's casts, from its catalogue (ADR #129); empty elsewhere.
    let types = crate::db::exec::bind_types(&pool, &qt).await?;
    let plain = build_insert_statement(
        dialect,
        &qt,
        &insert_columns,
        &one_row,
        InsertClauses::default(),
        &types,
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
                        &types,
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
                &types,
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
