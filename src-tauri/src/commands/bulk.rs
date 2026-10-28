//! Bulk row/document update — apply a `$set`-shaped change to every row or
//! document matching a filter, in one round trip.
//!
//! The write path mirrors [`crate::commands::query::delete_rows`]'s dispatch
//! shape (Mongo handled first with an early return, the three SQL drivers
//! sharing one code path below) and the preview/apply split
//! [`crate::commands::structure::preview_structure_change`] /
//! `apply_structure_change` already established for DDL: both the count
//! shown before confirming and the write that actually runs are built by the
//! same statement-construction code ([`build_update_statement`] for SQL,
//! [`crate::db::mongo::query::describe_bulk_update`] for Mongo), so the two
//! can never diverge.
//!
//! Unlike `delete_rows` (always addressed by known primary keys), this
//! operates on an arbitrary filter the caller builds in the UI — the same
//! [`ColumnFilter`] shape [`crate::commands::query::fetch_table_data`]
//! already uses for the grid's advanced filter. An empty filter would
//! silently mean "every row", so `confirm_unfiltered` is a deliberate second
//! gate: the command refuses to run unless the caller supplied at least one
//! filter or explicitly acknowledged the unfiltered case.

use crate::commands::query::{
    build_filter_clause_at, count_table_rows_inner, validate_filters, ColumnFilter, CountMode,
    RowValue, TableFilter, TableScan,
};
use crate::commands::schema::list_columns_inner;
use crate::db::mysql;
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::log_bus::{self, log_sql_sink, LogSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdateArgs {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    /// AND-composed match condition. Empty means "every row/document" and is
    /// rejected unless `confirm_unfiltered` is set.
    #[serde(default)]
    pub filters: Vec<ColumnFilter>,
    /// Columns/fields to set, reusing the same shape `insert_row` takes.
    pub set_values: Vec<RowValue>,
    /// Deliberate override for running with `filters` empty (update every
    /// row/document). Defaults to `false` so a blank filter can't silently
    /// become a full-table update.
    #[serde(default)]
    pub confirm_unfiltered: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpdatePreview {
    /// Human-readable statement shown in the confirmation dialog — the
    /// `UPDATE ...` text for SQL, a `db.<collection>.updateMany(...)`-style
    /// line for Mongo. Informational only; never re-parsed.
    pub statement: String,
    /// Rows/documents matching the filter right now. May differ from what
    /// `apply_bulk_update` reports afterwards if the data changes between
    /// the two calls (a concurrent write) — the dialog labels this an
    /// estimate for that reason.
    pub affected_estimate: u64,
}

fn validate_args(args: &BulkUpdateArgs) -> AppResult<()> {
    if args.filters.is_empty() && !args.confirm_unfiltered {
        return Err(AppError::InvalidInput(
            "bulk update requires at least one filter, or confirm_unfiltered".into(),
        ));
    }
    if args.set_values.is_empty() {
        return Err(AppError::InvalidInput(
            "bulk update: no columns to set".into(),
        ));
    }
    // The same `MAX_IN_VALUES` cap the browse path enforces. This route shares
    // `build_filter_clause`, so an oversize `IN` list built the identical SQL
    // here — only inside an `UPDATE`'s `WHERE`, where a pathological predicate
    // is more expensive than in a paginated `SELECT`, and where it ran
    // unchecked until `validate_filters` was made reachable.
    validate_filters(&args.filters)?;
    Ok(())
}

/// Build the `UPDATE <qt> SET ... WHERE ...` statement + its binds for one
/// bulk update. Shared by [`preview_bulk_update`] (which only displays the
/// text) and [`apply_bulk_update`] (which executes it) via this single
/// function, so the two can never diverge.
///
/// Mirrors the per-value type handling `update_cell_inner`/`insert_row`
/// already have (gotcha #15 / ADR #31): a plain textual placeholder is wrong for a
/// MySQL `BIT` column (the literal `"0"` is stored as the ASCII byte, not the
/// integer) and for a SQL Server binary-family column (the implicit
/// nvarchar->varbinary conversion reinterprets the characters). This used to
/// be a bare placeholder for every column regardless of type, which is why a
/// bulk update setting a MySQL `BIT` column failed with "Data too long for
/// column" (issue mirrored from the single-cell-edit fix).
// Eight arguments because the catalog fallback needs `state`/`connection_id`
// on top of the statement's own inputs, and both callers must pass the exact
// same set or the previewed SQL and the executed SQL could diverge — which is
// the whole point of sharing this function. Same call the write paths in
// `commands::query` make, and allowed for the same reason.
#[allow(clippy::too_many_arguments)]
async fn build_update_statement(
    state: &AppState,
    connection_id: &str,
    schema: Option<&str>,
    table: &str,
    dialect: Dialect,
    qt: &str,
    filters: &[ColumnFilter],
    set_values: &[RowValue],
) -> (String, Vec<Option<String>>) {
    let is_mysql = dialect == Dialect::Mysql;

    // Same fallback as `insert_row`/`update_cell_inner`: only pay for a
    // catalog round-trip when at least one assigned column actually lacks a
    // type hint (a stale/unloaded frontend schema cache).
    let catalog_bit_columns: std::collections::HashSet<String> =
        if is_mysql && set_values.iter().any(|v| v.column_type.is_none()) {
            list_columns_inner(
                state,
                connection_id,
                schema.map(str::to_string),
                table.to_string(),
            )
            .await
            .map(|cols| {
                cols.into_iter()
                    .filter(|c| mysql::is_bit_type(&c.data_type))
                    .map(|c| c.name)
                    .collect()
            })
            .unwrap_or_default()
        } else {
            std::collections::HashSet::new()
        };

    let mut next = 1usize;
    let mut binds: Vec<Option<String>> = Vec::with_capacity(set_values.len());
    let set_parts: Vec<String> = set_values
        .iter()
        .map(|rv| {
            let col = dialect.quote_ident(&rv.column);
            let ph = dialect.placeholder(next);
            next += 1;
            let is_bit = is_mysql
                && (rv.column_type.as_deref().is_some_and(mysql::is_bit_type)
                    || catalog_bit_columns.contains(&rv.column));
            let (placeholder, value) = if is_bit {
                (
                    mysql::bit_cast(&ph),
                    rv.value.as_deref().map(mysql::normalize_bit_value),
                )
            } else if dialect == Dialect::MsSql {
                (
                    crate::db::mssql::binary_convert(rv.column_type.as_deref(), &ph),
                    rv.value.clone(),
                )
            } else {
                (ph, rv.value.clone())
            };
            binds.push(value);
            format!("{col} = {placeholder}")
        })
        .collect();
    let (where_clause, where_binds, _) = build_filter_clause_at(next, dialect, filters, None, &[]);
    binds.extend(where_binds);
    (
        format!("UPDATE {qt} SET {}{where_clause}", set_parts.join(", ")),
        binds,
    )
}

/// Preview a bulk update: how many rows/documents currently match
/// `args.filters`, plus the statement [`apply_bulk_update`] would run. Runs a
/// read-only count; never modifies data.
#[tauri::command]
pub async fn preview_bulk_update(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: BulkUpdateArgs,
) -> AppResult<BulkUpdatePreview> {
    validate_args(&args)?;
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    crate::commands::guard::read(
        state.inner(),
        &args.connection_id,
        args.schema.as_deref(),
        &args.table,
    )?;
    let pool = state.pool_for(&args.connection_id)?;

    let statement = if matches!(&pool, DbPool::Mongo(_)) {
        crate::db::mongo::query::describe_bulk_update(&args.table, &args.filters, &args.set_values)
    } else {
        let dialect = Dialect::try_of(&pool)?;
        let qt = dialect.qualify_defaulted(args.schema.as_deref(), &args.table);
        build_update_statement(
            state.inner(),
            &args.connection_id,
            args.schema.as_deref(),
            &args.table,
            dialect,
            &qt,
            &args.filters,
            &args.set_values,
        )
        .await
        .0
    };

    let sink = log_bus::TauriSink::new(&app, window.label());
    let affected_estimate = count_table_rows_inner(
        &sink,
        state.inner(),
        TableScan {
            connection_id: args.connection_id.clone(),
            schema: args.schema.clone(),
            table: args.table.clone(),
            filter: TableFilter {
                filters: args.filters.clone(),
                ..TableFilter::default()
            },
            order: Vec::new(),
            projection: None,
            collation: None,
            hint: None,
        },
        CountMode::Automatic,
    )
    .await?
    .total;

    Ok(BulkUpdatePreview {
        statement,
        affected_estimate,
    })
}

/// Apply a bulk update: `UPDATE ... SET ... WHERE ...` for the three SQL
/// drivers, `update_many` with a `$set` for MongoDB. Returns the number of
/// rows/documents actually modified.
#[tauri::command]
pub async fn apply_bulk_update(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: BulkUpdateArgs,
) -> AppResult<u64> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &args.connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &args.connection_id,
        args.schema.as_deref(),
        &args.table,
        crate::db::sql::Verbs::UPDATE,
    )?;
    crate::commands::guard::columns(
        state.inner(),
        &args.connection_id,
        args.schema.as_deref(),
        &args.table,
        crate::db::sql::Verbs::UPDATE,
        args.set_values.iter().map(|v| &v.column),
    )?;
    apply_bulk_update_inner(&sink, state.inner(), args).await
}

/// Tauri-independent core of [`apply_bulk_update`].
pub(crate) async fn apply_bulk_update_inner(
    sink: &dyn LogSink,
    state: &AppState,
    args: BulkUpdateArgs,
) -> AppResult<u64> {
    validate_args(&args)?;
    let pool = state.pool_for(&args.connection_id)?;
    let driver = pool.driver_name();

    // MongoDB: update_many over the same filter shape fetch_collection_data
    // already understands, with a $set built from set_values.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::bulk_update(
            conn,
            &args.table,
            &args.filters,
            &args.set_values,
        )
        .await;
        let (affected, failure) = match &res {
            Ok(n) => (Some(*n), None),
            Err(e) => (None, Some(e.to_string())),
        };
        log_sql_sink(
            sink,
            &args.connection_id,
            driver,
            "(mongo bulk update)",
            start,
            affected,
            failure.as_deref(),
        );
        return res;
    }

    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(args.schema.as_deref(), &args.table);
    let (sql, binds) = build_update_statement(
        state,
        &args.connection_id,
        args.schema.as_deref(),
        &args.table,
        dialect,
        &qt,
        &args.filters,
        &args.set_values,
    )
    .await;

    let start = Instant::now();
    let outcome = crate::db::exec::execute_params(&pool, &sql, &binds).await;

    let (affected, failure) = match &outcome {
        Ok(n) => (Some(*n), None),
        Err(e) => (None, Some(e.to_string())),
    };
    log_sql_sink(
        sink,
        &args.connection_id,
        driver,
        &sql,
        start,
        affected,
        failure.as_deref(),
    );
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rv(column: &str, value: &str, column_type: Option<&str>) -> RowValue {
        RowValue {
            column: column.to_string(),
            value: Some(value.to_string()),
            column_type: column_type.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn a_mysql_bit_column_is_cast_instead_of_bound_as_plain_text() {
        // Regression: a bulk update setting a BIT column with a bare
        // placeholder stored the literal's ASCII byte and MySQL rejected it
        // with "Data too long for column" — the exact failure this mirrors
        // the single-cell-edit fix (gotcha #15) for.
        let state = AppState::new();
        let set_values = vec![rv("enabled", "0", Some("BIT(1)"))];
        let (sql, binds) = build_update_statement(
            &state,
            "conn",
            None,
            "replicaConfig",
            Dialect::Mysql,
            "`replicaConfig`",
            &[],
            &set_values,
        )
        .await;
        assert!(sql.contains("CAST(? AS UNSIGNED)"), "{sql}");
        assert_eq!(binds, vec![Some("0".to_string())]);
    }

    #[tokio::test]
    async fn a_plain_mysql_column_keeps_a_bare_placeholder() {
        let state = AppState::new();
        let set_values = vec![rv("name", "hello", Some("VARCHAR(255)"))];
        let (sql, binds) = build_update_statement(
            &state,
            "conn",
            None,
            "t",
            Dialect::Mysql,
            "`t`",
            &[],
            &set_values,
        )
        .await;
        assert!(sql.contains("`name` = ?"), "{sql}");
        assert_eq!(binds, vec![Some("hello".to_string())]);
    }

    #[tokio::test]
    async fn a_sql_server_binary_column_is_wrapped_in_convert() {
        let state = AppState::new();
        let set_values = vec![rv("payload", "4A2B", Some("varbinary"))];
        let (sql, _binds) = build_update_statement(
            &state,
            "conn",
            None,
            "t",
            Dialect::MsSql,
            "[t]",
            &[],
            &set_values,
        )
        .await;
        assert!(sql.contains("CONVERT(varbinary(max)"), "{sql}");
    }

    fn args_with_filters(filters: Vec<ColumnFilter>) -> BulkUpdateArgs {
        BulkUpdateArgs {
            connection_id: "conn".into(),
            schema: None,
            table: "t".into(),
            filters,
            set_values: vec![rv("name", "x", None)],
            confirm_unfiltered: false,
        }
    }

    #[test]
    fn an_oversize_in_list_is_rejected_on_the_update_path_too() {
        // Mirrors `commands::query`'s `oversize_in_list_is_rejected`. The cap
        // lived in a private `validate_filters` that only the browse path
        // called, so the identical `IN (...)` predicate went unchecked here —
        // in an `UPDATE`'s `WHERE`, which is the more expensive of the two.
        use crate::commands::query::MAX_IN_VALUES;

        let over: Vec<serde_json::Value> =
            (0..=MAX_IN_VALUES).map(|i| serde_json::json!(i)).collect();
        let filter = ColumnFilter {
            column: "id".into(),
            op: crate::commands::query::FilterOp::In,
            value: serde_json::Value::Null,
            value2: serde_json::Value::Null,
            values: over,
        };
        assert!(validate_args(&args_with_filters(vec![filter])).is_err());

        let under: Vec<serde_json::Value> =
            (0..MAX_IN_VALUES).map(|i| serde_json::json!(i)).collect();
        let filter = ColumnFilter {
            column: "id".into(),
            op: crate::commands::query::FilterOp::In,
            value: serde_json::Value::Null,
            value2: serde_json::Value::Null,
            values: under,
        };
        assert!(validate_args(&args_with_filters(vec![filter])).is_ok());
    }
}
