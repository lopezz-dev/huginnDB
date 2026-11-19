//! Pulse commands — server health, and later the per-view reads behind it.
//!
//! Same shape as [`crate::commands::schema`]: a thin `#[tauri::command]`
//! wrapper that resolves the database view and applies the standard timeout,
//! over an `_inner` core that dispatches on the pool. The core is separate so
//! the MCP bridge can call it without a `Window` (see [`crate::bridge::exec`]).

use tauri::State;

use crate::db::sql::StmtClass;
use crate::error::{AppError, AppResult};
use crate::pulse::{
    ExplainMode, ExplainPlan, IndexUsage, PulseHealth, PulseHistoryPoint, PulseHistorySeries,
    SessionRow, StorageItem, TopQuery,
};
use crate::state::{AppState, DbPool};

/// A driver Pulse does not read yet.
///
/// Returned rather than an empty snapshot on purpose: an empty snapshot is
/// indistinguishable from a server answering zero to everything, and the panel
/// would render a wall of `0`s for a connection it simply cannot measure. The
/// frontend turns this into an explicit "not supported yet" state, the same
/// call the Security panel makes for SQLite's absent user model.
fn unsupported(driver: &str) -> AppError {
    AppError::UnsupportedDriver(format!(
        "Pulse does not read {driver} statistics yet — MySQL and MongoDB only"
    ))
}

pub async fn pulse_health_inner(state: &AppState, connection_id: &str) -> AppResult<PulseHealth> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::health(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::pulse::health(&conn).await,
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// One read of a connection's vital signs. See [`crate::pulse`].
#[tauri::command]
pub async fn pulse_health(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<PulseHealth> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_health",
        pulse_health_inner(state.inner(), &connection_id),
    )
    .await
}

/// How many rows each on-demand read returns.
///
/// One number for both surfaces: the compact panel shows the first three and
/// the expanded window shows the rest, so a second round trip when someone
/// widens the panel would be a round trip spent on data already in hand.
const DETAIL_LIMIT: u32 = 20;

pub async fn pulse_top_queries_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<TopQuery>> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::top_queries(&p, DETAIL_LIMIT).await,
        DbPool::Mongo(conn) => {
            crate::db::mongo::pulse::top_queries(&conn, DETAIL_LIMIT as usize).await
        }
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// Guard shared by both engines' `EXPLAIN`, applied once here rather than in
/// either driver module so a second call site (the MCP `pulse_explain` tool,
/// still to come) inherits it for free instead of having to remember it.
///
/// `classify_statement` already picks the right grammar from the text itself
/// (SQL vs `db.…` shell syntax), so one check covers both engines. Two things
/// beyond "is this a read": a statement that is itself `EXPLAIN`/`ANALYZE`
/// would either nest uselessly or — for `ANALYZE`, which actually *runs* the
/// statement to gather real timings — defeat the entire point of a read-only
/// preview; and a stray `;` could smuggle a second statement past the
/// read-only check, since `classify_statement` only looks at the first
/// keyword.
fn validate_explain_target(sql: &str) -> AppResult<()> {
    if crate::db::classify::classify_statement(sql) != StmtClass::Read {
        return Err(AppError::InvalidInput(
            "pulse_explain only accepts a read-only statement".into(),
        ));
    }
    let head: String = sql
        .trim_start()
        .chars()
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if head.starts_with("explain") || head.starts_with("analyze") {
        return Err(AppError::InvalidInput(
            "pulse_explain refuses a statement that is itself EXPLAIN/ANALYZE".into(),
        ));
    }
    if sql.trim().trim_end_matches(';').contains(';') {
        return Err(AppError::InvalidInput(
            "pulse_explain accepts a single statement".into(),
        ));
    }
    Ok(())
}

/// `mode` is decided here, once, for both engines: MySQL's executed form
/// (`EXPLAIN ANALYZE`) answers in a text tree on MySQL and a different
/// statement (`ANALYZE FORMAT=JSON`) on MariaDB, so it is refused by name
/// rather than half-supported — the MCP tool's description says so too.
pub async fn pulse_explain_inner(
    state: &AppState,
    connection_id: &str,
    sample: &str,
    mode: ExplainMode,
) -> AppResult<ExplainPlan> {
    validate_explain_target(sample)?;
    match state.pool_for(connection_id)? {
        DbPool::Mysql(_) if mode == ExplainMode::Execution => Err(AppError::InvalidInput(
            "pulse_explain's execution mode is MongoDB-only; MySQL answers with its plan".into(),
        )),
        DbPool::Mysql(p) => crate::db::mysql::pulse::explain(&p, sample).await,
        DbPool::Mongo(conn) => crate::db::mongo::pulse::explain(&conn, sample, mode).await,
        // The estimated plan only: SQL Server's actual plan (`STATISTICS XML`)
        // runs the statement, which a read through `run_query` already does.
        DbPool::MsSql(_) if mode == ExplainMode::Execution => Err(AppError::InvalidInput(
            "pulse_explain's execution mode is MongoDB-only; SQL Server answers with its \
             estimated plan"
                .into(),
        )),
        DbPool::MsSql(p) => crate::db::mssql::explain::estimated_plan(&p, sample).await,
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
    }
}

pub async fn pulse_storage_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<StorageItem>> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::storage(&p, DETAIL_LIMIT as usize).await,
        DbPool::Mongo(conn) => crate::db::mongo::pulse::storage(&conn, DETAIL_LIMIT as usize).await,
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// The statements this server has spent the most time on.
///
/// On demand, never sampled: it reads `performance_schema`, which is the most
/// expensive statement Pulse issues, and it answers a question nobody asks
/// every five seconds.
#[tauri::command]
pub async fn pulse_top_queries(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<TopQuery>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_top_queries",
        pulse_top_queries_inner(state.inner(), &connection_id),
    )
    .await
}

/// The connection's biggest relations. On demand, for the same reason.
#[tauri::command]
pub async fn pulse_storage(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<StorageItem>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_storage",
        pulse_storage_inner(state.inner(), &connection_id),
    )
    .await
}
pub async fn pulse_sessions_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<SessionRow>> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::sessions(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::pulse::sessions(&conn).await,
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// Every session or operation currently open on the server. On demand, never
/// sampled — a live snapshot is only meaningful at the instant someone asks
/// for it, unlike the digest table or the storage ranking, which are useful
/// even fifteen minutes stale.
#[tauri::command]
pub async fn pulse_sessions(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<SessionRow>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_sessions",
        pulse_sessions_inner(state.inner(), &connection_id),
    )
    .await
}

pub async fn pulse_index_usage_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<IndexUsage>> {
    match state.pool_for(connection_id)? {
        DbPool::Mysql(p) => crate::db::mysql::pulse::index_usage(&p, DETAIL_LIMIT).await,
        DbPool::Mongo(conn) => {
            crate::db::mongo::pulse::index_usage(&conn, DETAIL_LIMIT as usize).await
        }
        DbPool::Postgres(_) => Err(unsupported("PostgreSQL")),
        DbPool::Sqlite(_) => Err(unsupported("SQLite")),
        DbPool::MsSql(_) => Err(unsupported("SQL Server")),
    }
}

/// Index usage across the connection's biggest relations, least-read first.
/// On demand, for the same reason as [`pulse_storage`] — it is a ranking, not
/// a live rate, and reading it does not get cheaper by polling it.
#[tauri::command]
pub async fn pulse_index_usage(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<IndexUsage>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_index_usage",
        pulse_index_usage_inner(state.inner(), &connection_id),
    )
    .await
}

/// The plan the server would use for one statement from a Consultas row,
/// without running it. `sample` is always one of that row's own
/// [`TopQuery::sample`] values in practice — the panel never lets the user
/// type one in — but the guard applies regardless of who calls this, so a
/// future MCP `pulse_explain` tool can dispatch straight to
/// [`pulse_explain_inner`] without re-deriving it.
#[tauri::command]
pub async fn pulse_explain(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    sample: String,
) -> AppResult<ExplainPlan> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    // A plan is read from text the person supplies, so it is free SQL too.
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::commands::guard::free_sql(state.inner(), &connection_id, &sample)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "pulse_explain",
        // The panel only ever shows the plan; executing a statement to
        // explain it is something the MCP caller has to ask for by name.
        pulse_explain_inner(state.inner(), &connection_id, &sample, ExplainMode::Plan),
    )
    .await
}

/// One metric's stored history for `connection_id`, oldest first, from
/// `pulse.db`. Named for what it reads (`pulse_metrics_inner`) rather than
/// for the Tauri command below, so the MCP `pulse_metrics` tool (a
/// different name, same read) dispatches straight to it — the same split
/// `list_indexes_detailed_inner` already has from its own MCP tool name.
///
/// Deliberately does **not** call `ensure_view`/`pool_for`: history is
/// exactly the thing that is still useful once a connection is closed, so
/// requiring a live pool to read it back would defeat half the point of
/// persisting it.
pub async fn pulse_metrics_inner(
    state: &AppState,
    connection_id: &str,
    metric: &str,
    since_ms: i64,
) -> AppResult<PulseHistorySeries> {
    let kind = crate::pulse::spec(metric)
        .map(|s| s.kind)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown Pulse metric: {metric}")))?;
    let points = state
        .pulse_store
        .range(connection_id, metric, since_ms)
        .await?
        .into_iter()
        .map(|(ts_ms, value)| PulseHistoryPoint { ts_ms, value })
        .collect();
    Ok(PulseHistorySeries { kind, points })
}

#[tauri::command]
pub async fn pulse_history(
    state: State<'_, AppState>,
    connection_id: String,
    metric: String,
    since_ms: i64,
) -> AppResult<PulseHistorySeries> {
    // Read from the local history rather than the server, but it is the same
    // monitoring data the live panel shows.
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    pulse_metrics_inner(state.inner(), &connection_id, &metric, since_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_accepts_a_plain_read() {
        assert!(validate_explain_target("SELECT * FROM orders WHERE id = 1").is_ok());
        assert!(validate_explain_target("db.orders.find({status: \"A\"})").is_ok());
    }

    #[test]
    fn explain_refuses_a_write() {
        assert!(validate_explain_target("UPDATE orders SET status = 'x'").is_err());
        assert!(validate_explain_target("db.orders.deleteOne({})").is_err());
    }

    #[test]
    fn explain_refuses_nesting_explain_or_analyze() {
        assert!(validate_explain_target("EXPLAIN SELECT 1").is_err());
        assert!(validate_explain_target("ANALYZE SELECT 1").is_err());
    }

    #[test]
    fn explain_refuses_a_smuggled_second_statement() {
        assert!(validate_explain_target("SELECT 1; DROP TABLE t").is_err());
        // A single trailing terminator is fine.
        assert!(validate_explain_target("SELECT 1;").is_ok());
    }
}
