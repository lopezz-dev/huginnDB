//! A block pasted into the grid — from a spreadsheet, another grid, any
//! tab-separated text — written as **one** unit (ADR #114).
//!
//! The grid works out what the block means: which existing cells it changes,
//! which new rows its overflow adds, and which cells it cannot write (a key, a
//! column the policy locks). This command is handed the result: a list of cell
//! writes, each addressed by its row's full primary key, and a list of new
//! rows. It writes them all inside one transaction or none of them, because a
//! paste that half-lands leaves a table in a state nobody typed.
//!
//! The statements are the ones a single cell edit and a single row insert
//! already run — [`update_cell_statement`] and [`build_insert_statement`] — so
//! the paste cannot drift from them on quoting, placeholders, MySQL's `BIT`
//! cast or SQL Server's binary `CONVERT`. Each one must touch at most one row,
//! the same assertion `update_cell` makes, kept across the whole list.
//!
//! MongoDB keeps the promise only where the deployment runs transactions (a
//! replica set or `mongos`); a standalone server is written in order and stops
//! at the first failure, and the grid says so before the paste is applied.
//!
//! Not exposed to the AI: like `insert_rows` (ADR #84), it answers a person's
//! paste, and the MCP connector has `run_writes` for batches.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::commands::insert::{build_insert_statement, InsertClauses, InsertColumn};
use crate::commands::query::{update_cell_statement, RowValue};
use crate::db::exec;
use crate::db::mysql;
use crate::db::sql::{Dialect, Verbs};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::{AppState, DbPool};

/// The most writes one paste may carry. A guard against a clipboard holding
/// far more than anyone meant to paste — a transaction that size holds its
/// locks for as long as it takes — not a limit anyone should meet by intent.
pub const MAX_PASTE_WRITES: usize = 5_000;

/// One existing cell a paste changes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellWrite {
    /// The row's primary key, in `PasteArgs::pk_columns` order.
    pub pk_values: Vec<Value>,
    pub column: String,
    pub value: Option<String>,
    /// The column's type, for the same special binding a cell edit uses.
    #[serde(default)]
    pub column_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteArgs {
    pub connection_id: String,
    pub schema: Option<String>,
    pub table: String,
    /// The table's full primary key; every `updates[i].pk_values` follows it.
    #[serde(default)]
    pub pk_columns: Vec<String>,
    #[serde(default)]
    pub updates: Vec<CellWrite>,
    /// New rows, from the part of the block below the last row on screen.
    #[serde(default)]
    pub inserts: Vec<Vec<RowValue>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteSummary {
    pub updated: u64,
    pub inserted: u64,
    /// Whether it ran as one transaction — false only on a MongoDB server
    /// without transactions.
    pub atomic: bool,
}

/// Write a pasted block: `updates` to existing rows, `inserts` as new ones,
/// all or nothing.
///
/// Guarded per verb and per column: the cells need `update` on the table and
/// on each column they write, the new rows `insert` on both (ADR #113).
#[tauri::command]
pub async fn apply_paste(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: PasteArgs,
) -> AppResult<PasteSummary> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &args.connection_id).await;
    let (id, schema, table) = (&args.connection_id, args.schema.as_deref(), &args.table);
    if !args.updates.is_empty() {
        crate::commands::guard::relation(state.inner(), id, schema, table, Verbs::UPDATE)?;
        crate::commands::guard::columns(
            state.inner(),
            id,
            schema,
            table,
            Verbs::UPDATE,
            args.updates.iter().map(|u| &u.column),
        )?;
    }
    if !args.inserts.is_empty() {
        crate::commands::guard::relation(state.inner(), id, schema, table, Verbs::INSERT)?;
        crate::commands::guard::columns(
            state.inner(),
            id,
            schema,
            table,
            Verbs::INSERT,
            args.inserts.iter().flatten().map(|v| &v.column),
        )?;
    }
    apply_paste_inner(&sink, state.inner(), args).await
}

/// What [`apply_paste_inner`] refuses before touching the server.
fn validate(args: &PasteArgs) -> AppResult<()> {
    let writes = args.updates.len() + args.inserts.len();
    if writes == 0 {
        return Err(AppError::InvalidInput("paste: nothing to write".into()));
    }
    if writes > MAX_PASTE_WRITES {
        return Err(AppError::InvalidInput(format!(
            "paste: {writes} writes is more than one paste may carry ({MAX_PASTE_WRITES})"
        )));
    }
    if !args.updates.is_empty() && args.pk_columns.is_empty() {
        return Err(AppError::InvalidInput(
            "paste: changing existing rows needs the table's primary key".into(),
        ));
    }
    if let Some(bad) = args
        .updates
        .iter()
        .find(|u| u.pk_values.len() != args.pk_columns.len())
    {
        return Err(AppError::InvalidInput(format!(
            "paste: the write to {:?} names {} key values for a {}-column key",
            bad.column,
            bad.pk_values.len(),
            args.pk_columns.len()
        )));
    }
    if args.inserts.iter().any(|row| row.is_empty()) {
        return Err(AppError::InvalidInput(
            "paste: a new row has no values".into(),
        ));
    }
    Ok(())
}

/// The statements a SQL paste runs, in order: the cell writes, then the new
/// rows. Pure, for the tests. `bit_columns` are the MySQL `BIT` columns the
/// catalogue reported, for writes that arrived without a type.
fn paste_statements(
    dialect: Dialect,
    args: &PasteArgs,
    bit_columns: &std::collections::HashSet<String>,
) -> Vec<(String, Vec<Option<String>>)> {
    let is_mysql = dialect == Dialect::Mysql;
    let is_bit = |column: &str, column_type: Option<&str>| {
        is_mysql && (column_type.is_some_and(mysql::is_bit_type) || bit_columns.contains(column))
    };
    let mut out = Vec::with_capacity(args.updates.len() + args.inserts.len());

    // A cell edit qualifies the table as `update_cell` does, a new row as
    // `insert_row` does — the two differ on whether a missing schema takes the
    // dialect's default, and each must match its single-write counterpart.
    let qt_update = dialect.qualify(args.schema.as_deref(), &args.table);
    for u in &args.updates {
        out.push(update_cell_statement(
            dialect,
            &qt_update,
            &u.column,
            u.column_type.as_deref(),
            is_bit(&u.column, u.column_type.as_deref()),
            &args.pk_columns,
            u.value.clone(),
            &u.pk_values,
        ));
    }

    let qt_insert = dialect.qualify_defaulted(args.schema.as_deref(), &args.table);
    for row in &args.inserts {
        let columns: Vec<InsertColumn> = row
            .iter()
            .map(|rv| InsertColumn {
                name: rv.column.clone(),
                data_type: rv
                    .column_type
                    .clone()
                    .or_else(|| bit_columns.contains(&rv.column).then(|| "BIT".to_string())),
            })
            .collect();
        let values = [row.iter().map(|v| v.value.clone()).collect::<Vec<_>>()];
        let built = build_insert_statement(
            dialect,
            &qt_insert,
            &columns,
            &values,
            InsertClauses::default(),
        );
        out.push((built.sql, built.binds));
    }
    out
}

/// Tauri-independent core of [`apply_paste`].
pub(crate) async fn apply_paste_inner(
    sink: &dyn LogSink,
    state: &AppState,
    args: PasteArgs,
) -> AppResult<PasteSummary> {
    validate(&args)?;
    let pool = state.pool_for(&args.connection_id)?;
    let driver = pool.driver_name();
    let connection_id = args.connection_id.clone();
    let start = Instant::now();

    if let DbPool::Mongo(conn) = &pool {
        let null = Value::Null;
        let sets: Vec<_> = args
            .updates
            .iter()
            .map(|u| crate::db::mongo::query::PasteSet {
                // The key of a document is its `_id`, the first and only one.
                id: u.pk_values.first().unwrap_or(&null),
                field: &u.column,
                value: u.value.as_deref(),
                type_hint: u.column_type.as_deref(),
            })
            .collect();
        let logged = format!(
            "(mongo paste: {} field(s) set, {} document(s) added)",
            sets.len(),
            args.inserts.len()
        );
        let res =
            crate::db::mongo::query::apply_paste(conn, &args.table, &sets, &args.inserts).await;
        return match res {
            Ok(o) => {
                log_sql_sink(
                    sink,
                    &connection_id,
                    driver,
                    &logged,
                    start,
                    Some(o.updated + o.inserted),
                    None,
                );
                Ok(PasteSummary {
                    updated: o.updated,
                    inserted: o.inserted,
                    atomic: o.atomic,
                })
            }
            Err(e) => {
                log_sql_sink(
                    sink,
                    &connection_id,
                    driver,
                    &logged,
                    start,
                    None,
                    Some(&e.to_string()),
                );
                Err(e)
            }
        };
    }

    let dialect = Dialect::try_of(&pool)?;
    // Same fallback as `insert_row` and `update_cell`: a write without a type
    // hint must still bind a MySQL `BIT` as a number (issue #15). Only paid for
    // when some write lacks one.
    let untyped = args.updates.iter().any(|u| u.column_type.is_none())
        || args
            .inserts
            .iter()
            .flatten()
            .any(|v| v.column_type.is_none());
    let bit_columns = if dialect == Dialect::Mysql && untyped {
        crate::commands::schema::list_columns_inner(
            state,
            &connection_id,
            args.schema.clone(),
            args.table.clone(),
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
    let batches = paste_statements(dialect, &args, &bit_columns);

    let result = exec::execute_params_in_tx_at_most_one(&pool, &batches, "paste").await;

    // One Console line for the whole transaction, as `insert_rows` writes:
    // N entries would read as N independently-committed statements.
    let logged = if batches.len() == 1 {
        batches[0].0.clone()
    } else {
        format!(
            "{}\n/* + {} more statements in the same transaction ({} cell(s), {} new row(s)) */",
            batches[0].0,
            batches.len() - 1,
            args.updates.len(),
            args.inserts.len()
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
    let affected = result?;
    let (cells, rows) = affected.split_at(args.updates.len());
    Ok(PasteSummary {
        updated: cells.iter().sum(),
        inserted: rows.iter().sum(),
        atomic: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn write(pk: i64, column: &str, value: Option<&str>) -> CellWrite {
        CellWrite {
            pk_values: vec![Value::from(pk)],
            column: column.into(),
            value: value.map(str::to_string),
            column_type: Some("varchar".into()),
        }
    }

    fn rv(column: &str, value: &str) -> RowValue {
        RowValue {
            column: column.into(),
            value: Some(value.into()),
            column_type: Some("varchar".into()),
        }
    }

    fn args(updates: Vec<CellWrite>, inserts: Vec<Vec<RowValue>>) -> PasteArgs {
        PasteArgs {
            connection_id: "c".into(),
            schema: Some("dbo".into()),
            table: "pedidos".into(),
            pk_columns: vec!["id".into()],
            updates,
            inserts,
        }
    }

    #[test]
    fn cells_then_rows_each_as_its_single_write_counterpart_builds_it() {
        let a = args(
            vec![write(1, "estado", Some("Cerrado")), write(2, "obs", None)],
            vec![vec![rv("cliente", "Ruiz"), rv("estado", "Abierto")]],
        );
        let s = paste_statements(Dialect::MsSql, &a, &HashSet::new());
        assert_eq!(s.len(), 3);
        assert_eq!(
            s[0].0,
            "UPDATE [dbo].[pedidos] SET [estado] = @P1 WHERE [id] = @P2"
        );
        assert_eq!(s[0].1, vec![Some("Cerrado".into()), Some("1".into())]);
        // A NULL travels as a NULL bind, not as the text "NULL".
        assert_eq!(s[1].1, vec![None, Some("2".into())]);
        assert_eq!(
            s[2].0,
            "INSERT INTO [dbo].[pedidos] ([cliente], [estado]) VALUES (@P1, @P2)"
        );

        let pg = paste_statements(Dialect::Postgres, &a, &HashSet::new());
        assert_eq!(
            pg[0].0,
            r#"UPDATE "dbo"."pedidos" SET "estado" = $1 WHERE "id" = $2"#
        );
    }

    #[test]
    fn a_mysql_bit_without_a_type_is_still_cast() {
        let mut w = write(1, "flag", Some("true"));
        w.column_type = None;
        let a = args(vec![w], Vec::new());
        let bits: HashSet<String> = ["flag".to_string()].into();
        let s = paste_statements(Dialect::Mysql, &a, &bits);
        assert!(s[0].0.contains("CAST(? AS UNSIGNED)"), "{}", s[0].0);
        assert_eq!(s[0].1[0], Some("1".into()));
    }

    #[test]
    fn what_cannot_be_written_is_refused_before_the_server() {
        assert!(validate(&args(Vec::new(), Vec::new())).is_err());
        let mut no_key = args(vec![write(1, "estado", None)], Vec::new());
        no_key.pk_columns.clear();
        assert!(validate(&no_key)
            .unwrap_err()
            .to_string()
            .contains("primary key"));
        let mut short = write(1, "estado", None);
        short.pk_values.clear();
        assert!(validate(&args(vec![short], Vec::new())).is_err());
        assert!(validate(&args(Vec::new(), vec![Vec::new()])).is_err());
        let many = (0..=MAX_PASTE_WRITES as i64)
            .map(|i| write(i, "estado", None))
            .collect();
        assert!(validate(&args(many, Vec::new()))
            .unwrap_err()
            .to_string()
            .contains("more than one paste"));
    }
}
