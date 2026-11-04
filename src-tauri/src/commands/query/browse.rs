//! The table browser: one page of a relation ([`fetch_table_data_inner`]) and
//! its row count, exact or estimated ([`count_table_rows_inner`]).

use super::statement::{nonblank, page_bind_types, sql_page_statement, Projection};
use super::types::{
    column_meta, ColumnMeta, CountMode, CountResult, QueryResult, TableQuery, TableScan,
};
use crate::commands::schema::list_columns_inner;
use crate::db::sql::Dialect;
use crate::error::AppResult;
use crate::log_bus::{log_sql_sink, LogSink, SqlLog};
use crate::state::{AppState, DbPool};
use std::time::Instant;

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
        return SqlLog::new(sink, connection_id, "mongodb").outcome(
            &sql_text,
            start,
            result,
            |r| r.rows.len() as u64,
        );
    }

    let driver = pool.driver_name();
    let dialect = Dialect::try_of(&pool)?;

    let types = page_bind_types(&pool, dialect, &query).await?;
    let (data_sql, where_binds) = sql_page_statement(dialect, &query, &types)?;
    let TableQuery {
        connection_id,
        schema,
        table,
        filter,
        projection,
        with_count,
        ..
    } = query;
    let (where_clause, _) = filter.clause(dialect, &types)?;
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

/// Tauri-independent core of [`count_table_rows`].
pub(crate) async fn count_table_rows_inner(
    sink: &dyn LogSink,
    state: &AppState,
    query: TableScan,
    mode: CountMode,
) -> AppResult<CountResult> {
    // `order` and `projection` do not change how many rows match. A collation
    // does on MongoDB (it is part of the match there); on SQL it only ever
    // reaches the ORDER BY, so the SQL count ignores it. `hint` changes no
    // total either, but on MongoDB it picks the index the count walks — the
    // one the page is read through.
    let TableScan {
        connection_id,
        schema,
        table,
        filter,
        collation,
        hint,
        ..
    } = query;
    let pool = state.pool_for(&connection_id)?;
    let driver = pool.driver_name();

    // "Unfiltered" == the whole relation: no column filters AND no committed
    // search. Only then may the background count serve the fast catalog
    // estimate; any predicate — or the user asking for the exact figure —
    // forces an exact count of the matching subset.
    let estimate = mode.may_estimate(&filter);

    // MongoDB: estimatedDocumentCount (O(1) metadata read) when estimating,
    // exact countDocuments over the filter otherwise.
    if let DbPool::Mongo(conn) = &pool {
        let start = Instant::now();
        let res = crate::db::mongo::query::count_collection(
            conn,
            &table,
            &filter,
            nonblank(&collation),
            nonblank(&hint),
            mode,
        )
        .await;
        let label = if estimate {
            "(mongo estimatedDocumentCount)"
        } else {
            "(mongo countDocuments)"
        };
        return SqlLog::new(sink, &connection_id, driver).outcome(label, start, res, |c| c.total);
    }

    let dialect = Dialect::try_of(&pool)?;

    // Whole-table browse: try the engine estimate first. `try_estimate`
    // returns `None` when no usable estimate exists (SQLite always; a
    // never-analyzed Postgres/MySQL table) so we fall through to an exact
    // count rather than reporting a bogus `~0`.
    if estimate {
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

    // Exact count: predicate present, asked for, or no estimate available.
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let types = filter.bind_types(&pool, &qt).await?;
    let (where_clause, where_binds) = filter.clause(dialect, &types)?;
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
pub(super) async fn try_estimate(
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
