//! MongoDB index-manager commands.
//!
//! The Mongo counterpart of what [`crate::commands::structure`] does for the
//! SQL drivers, and split out for the same reason
//! [`crate::commands::aggregation`] is: there is nothing here to diff into DDL.
//! An index is created, hidden, replaced or dropped through a run-command, and
//! `apply_structure_change` rejects MongoDB outright.
//!
//! Two conventions carry over from the aggregation editor and matter:
//!
//! * **Documents cross as source text.** Index keys, partial filters,
//!   collations and text weights arrive exactly as the user typed them and are
//!   parsed in Rust (ADR #33). The frontend never parses BSON.
//! * **Every command rejects a non-MongoDB connection up front**, so a
//!   mis-routed call fails with a sentence rather than a type error deep in a
//!   driver.
//!
//! Creating and dropping an index **is** reachable over the MCP connector
//! (`create_index` / `drop_index`, both at the `full` tier — an index is
//! schema). Hiding and replacing are not: `collMod` reaches `hidden` and
//! nothing else, and a replace is a drop plus a create, which an AI client can
//! express as those two calls with the intermediate state visible to it. Both
//! MCP-reachable verbs go through the `_inner` cores below so a write is logged
//! whether it arrived from the UI, the bridge, or the connector's own pool —
//! a write core that does not take a [`LogSink`] is invisible in
//! `mcp-audit.log` (convention #49).

use crate::db::mongo::indexes::{self, MongoIndexInfo, NewMongoIndexSpec};
use crate::error::AppResult;
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::AppState;
use serde::Deserialize;
use std::time::Instant;
use tauri::State;

/// Message for the non-MongoDB case of [`AppState::mongo_for`]. Named here
/// rather than templated in the helper because the useful half is the
/// pointer to this feature's SQL equivalent.
const MONGO_ONLY: &str =
    "the index manager is MongoDB-only; SQL indexes are edited in the structure editor";

/// A collection's indexes, with their sizes and usage counters when the
/// connection's role can read them.
#[tauri::command]
pub async fn list_mongo_indexes(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
) -> AppResult<Vec<MongoIndexInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::read(state.inner(), &connection_id, None, &collection)?;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    indexes::list_indexes(&conn, &collection).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndexArgs {
    pub connection_id: String,
    pub collection: String,
    pub spec: NewMongoIndexSpec,
}

#[tauri::command]
pub async fn create_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: CreateIndexArgs,
) -> AppResult<()> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &args.connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &args.connection_id,
        None,
        &args.collection,
        crate::db::sql::Verbs::DDL,
    )?;
    create_mongo_index_inner(&sink, state.inner(), &args).await
}

/// Sink-taking core of [`create_mongo_index`], shared with the MCP bridge.
pub async fn create_mongo_index_inner(
    sink: &dyn LogSink,
    state: &AppState,
    args: &CreateIndexArgs,
) -> AppResult<()> {
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    let start = Instant::now();
    let res = indexes::create_index(&conn, &args.collection, &args.spec).await;
    log_index_write(sink, &args.connection_id, "create index", start, &res);
    res
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecreateIndexArgs {
    pub connection_id: String,
    pub collection: String,
    /// The index being replaced. Dropped only after the new spec parses.
    pub original_name: String,
    pub spec: NewMongoIndexSpec,
}

/// Replace an index. MongoDB cannot alter one in place, so this is a drop
/// followed by a create — destructive, and the UI confirms it first.
#[tauri::command]
pub async fn recreate_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: RecreateIndexArgs,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &args.connection_id,
        None,
        &args.collection,
        crate::db::sql::Verbs::DDL,
    )?;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    indexes::recreate_index(&conn, &args.collection, &args.original_name, &args.spec).await
}

#[tauri::command]
pub async fn drop_mongo_index(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    name: String,
) -> AppResult<()> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::DDL,
    )?;
    drop_mongo_index_inner(&sink, state.inner(), &connection_id, &collection, &name).await
}

/// Sink-taking core of [`drop_mongo_index`], shared with the MCP bridge.
pub async fn drop_mongo_index_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    collection: &str,
    name: &str,
) -> AppResult<()> {
    let conn = state.mongo_for(connection_id, MONGO_ONLY)?;
    let start = Instant::now();
    let res = indexes::drop_index(&conn, collection, name).await;
    log_index_write(sink, connection_id, "drop index", start, &res);
    res
}

/// One Console/audit line per index write.
///
/// The statement slot carries a `(mongo …)` label rather than a run-command
/// document, matching what `drop_view_inner` does for its Mongo branch: there
/// is no SQL text to show, and the audit log's job is to record that the write
/// happened and whether it succeeded.
fn log_index_write(
    sink: &dyn LogSink,
    connection_id: &str,
    what: &str,
    start: Instant,
    res: &AppResult<()>,
) {
    log_sql_sink(
        sink,
        connection_id,
        "mongodb",
        &format!("(mongo {what})"),
        start,
        None,
        res.as_ref().err().map(|e| e.to_string()).as_deref(),
    );
}

/// Hide or unhide an index — the reversible rehearsal for dropping it.
#[tauri::command]
pub async fn set_mongo_index_hidden(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    name: String,
    hidden: bool,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::DDL,
    )?;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    indexes::set_index_hidden(&conn, &collection, &name, hidden).await
}
