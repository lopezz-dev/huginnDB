//! The data-path executor both sides of the MCP bridge run.
//!
//! One [`BridgeRequest`] in, one JSON value out, against whichever `AppState`
//! owns the pools. The desktop app calls this to serve a sidecar; the sidecar
//! calls it directly when there is no app to serve it.
//!
//! Sharing it is the point. The alternative — the server dispatching one way
//! and the sidecar's local fallback another — is two transcriptions of the same
//! fifteen calls that would drift the moment either side gained an argument,
//! and the drift would only show up when the app happened not to be running.

use crate::bridge::protocol::BridgeRequest;
use crate::error::{AppError, AppResult};
use crate::log_bus::LogSink;
use crate::state::AppState;
use serde_json::Value;

/// Execute one request against `state`.
///
/// `EnsureConnected` is **not** handled here — see the arm's comment. Every
/// caller must intercept it first.
pub async fn execute(
    state: &AppState,
    sink: &dyn LogSink,
    request: &BridgeRequest,
) -> AppResult<Value> {
    use BridgeRequest::*;
    // Every caller of this function acts for an AI, so this is where the
    // organization's policy binds it — before anything is read. See
    // `crate::policy` for the paths that do not come through here.
    crate::policy::enforce(state, request)?;
    let value = match request {
        EnsureConnected { .. } => {
            // Opening a pool differs per side — the app goes through
            // `connect_inner` (endpoint reservation, keepalive, cross-window
            // event), the sidecar through its own `ensure_connected`. Both
            // callers handle this variant before delegating here, so reaching
            // it means a new call site forgot to. An error rather than a panic:
            // this function is driven by network input.
            return Err(AppError::InvalidInput(
                "ensure_connected must be handled by the caller".into(),
            ));
        }
        ResolveMongoTarget {
            connection_id,
            database,
        } => {
            let id = crate::commands::connection::resolve_mongo_database_view(
                state,
                connection_id,
                database,
            )
            .await?;
            Value::String(id)
        }
        IsMongo { connection_id } => Value::Bool(matches!(
            state.connections.read().get(connection_id),
            Some(crate::state::DbPool::Mongo(_))
        )),
        // Metadata reads get the same `with_timeout_for` ceiling their GUI
        // command counterparts do (`commands::schema`/`structure`) — this is
        // the *other* caller of these `_inner` functions (see the module docs),
        // so without its own wrap here a half-dead socket would hang an MCP
        // tool call indefinitely even though the desktop command for the same
        // operation fails fast. `_for`, not the bare default: the ceiling is a
        // per-connection setting on the profile, and `profiles.json` is the one
        // thing the app and the sidecar genuinely share, so an MCP client
        // against a slow server inherits the user's answer for free.
        // Filtered on the typed list, before it is serialised: what the
        // policy hides, the AI does not get to know the name of.
        ListDatabases { connection_id } => serde_json::to_value(crate::policy::filter_databases(
            state,
            connection_id,
            crate::error::with_timeout_for(
                state,
                connection_id,
                "list_databases",
                crate::commands::schema::list_databases_inner(state, connection_id),
            )
            .await?,
        ))?,
        ListTables { connection_id } => serde_json::to_value(crate::policy::filter_tables(
            state,
            connection_id,
            crate::error::with_timeout_for(
                state,
                connection_id,
                "list_tables",
                crate::commands::schema::list_tables_inner(state, connection_id),
            )
            .await?,
        ))?,
        // `describe_relation_inner`, not `get_table_structure_inner`: the reply
        // gains an optional `view` key when the relation is a view. The
        // *request* shape is unchanged, and bridge payloads are opaque
        // `Value`s, so this needs no `PROTOCOL_VERSION` bump and both mismatched
        // app/sidecar pairings degrade cleanly — one omits the key, the other
        // passes it through.
        GetTableStructure {
            connection_id,
            schema,
            table,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "get_table_structure",
                crate::commands::structure::describe_relation_inner(
                    state,
                    connection_id,
                    schema.clone(),
                    table.clone(),
                ),
            )
            .await?,
        )?,
        ListIndexes {
            connection_id,
            schema,
            table,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "list_indexes",
                // The detailed reader: this request is reached only by the MCP
                // connector's `list_indexes` tool (the explorer calls the Tauri
                // command directly), and a client that may *write* an index has
                // to be able to read one back losslessly.
                crate::commands::schema::list_indexes_detailed_inner(
                    state,
                    connection_id,
                    schema.clone(),
                    table.clone(),
                ),
            )
            .await?,
        )?,
        ServerVersion { connection_id } => Value::String(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "server_version",
                crate::commands::schema::server_version_inner(state, connection_id),
            )
            .await?,
        ),
        ListUsers { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "list_users",
                crate::commands::schema::list_users_inner(state, connection_id),
            )
            .await?,
        )?,
        ListPrivileges {
            connection_id,
            user,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "list_privileges",
                crate::commands::schema::list_privileges_inner(state, connection_id, user.clone()),
            )
            .await?,
        )?,
        PulseHealth { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_health",
                crate::commands::pulse::pulse_health_inner(state, connection_id),
            )
            .await?,
        )?,
        PulseMetrics {
            connection_id,
            metric,
            since_ms,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_metrics",
                crate::commands::pulse::pulse_metrics_inner(
                    state,
                    connection_id,
                    metric,
                    *since_ms,
                ),
            )
            .await?,
        )?,
        PulseTopQueries { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_top_queries",
                crate::commands::pulse::pulse_top_queries_inner(state, connection_id),
            )
            .await?,
        )?,
        PulseExplain {
            connection_id,
            sample,
            mode,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_explain",
                crate::commands::pulse::pulse_explain_inner(state, connection_id, sample, *mode),
            )
            .await?,
        )?,
        PulseStorage { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_storage",
                crate::commands::pulse::pulse_storage_inner(state, connection_id),
            )
            .await?,
        )?,
        PulseSessions { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_sessions",
                crate::commands::pulse::pulse_sessions_inner(state, connection_id),
            )
            .await?,
        )?,
        // The registry of AI reads in flight (ADR #142). In memory and
        // instant, so no timeout wrapper; no database is touched — a stop
        // reaches the read through its own future, which closes its session.
        ListReads { connection_id } => serde_json::to_value(state.runs.ai_reads(connection_id))?,
        CancelRead {
            connection_id,
            query_id,
        } => serde_json::to_value(serde_json::json!({
            "query_id": query_id,
            "result": state.runs.stop_ai_read(connection_id, query_id),
        }))?,
        PulseIndexUsage { connection_id } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "pulse_index_usage",
                crate::commands::pulse::pulse_index_usage_inner(state, connection_id),
            )
            .await?,
        )?,
        // Every caller of this function acts for an AI, so a statement
        // classified as a read runs where the database itself refuses a write
        // — the second barrier behind the text classifier. See
        // `execute_read_bounded` for what it does and does not cover.
        //
        // A read is also bounded, by the connection's MCP timeout, and stopped
        // on the server when it passes or when this future is dropped — the
        // bridge drops it when the sidecar hangs up (ADR #134). A person's
        // read from the editor stays unbounded; this is the AI's.
        //
        // How long is the caller's to ask — the sidecar asks for what is left
        // of its MCP call's budget — and this side's to cap (ADR #140).
        RunStatement {
            connection_id,
            policy_id,
            sql,
            timeout_secs,
            query_id,
        } => {
            let is_read =
                crate::db::classify::classify_statement(sql) == crate::db::sql::StmtClass::Read;
            if is_read {
                let query_id = query_id
                    .clone()
                    .unwrap_or_else(crate::commands::query::mint_read_id);
                let (timeout, gate) = read_limits(state, policy_id, *timeout_secs);
                serde_json::to_value(
                    crate::commands::query::execute_read_bounded(
                        sink,
                        state,
                        crate::commands::query::AiReadOrder {
                            connection_id,
                            profile_id: policy_id,
                            sql,
                            timeout,
                            query_id: &query_id,
                            gate: &gate,
                        },
                    )
                    .await?,
                )?
            } else {
                serde_json::to_value(
                    crate::commands::query::execute_with_state(sink, state, connection_id, sql)
                        .await?,
                )?
            }
        }
        // Bounded by the call's timeout under the connection's own ceiling,
        // resolved here against this side's profiles rather than taken from
        // the request — the write policy's reasoning. The executor cancels a
        // statement that runs past it and never lets the COMMIT be the thing
        // cut off, so a timeout always comes back with a known outcome.
        RunWriteBatch {
            connection_id,
            policy_id,
            writes,
            timeout_secs,
        } => serde_json::to_value(
            crate::commands::write_batch::execute_write_batch_inner(
                sink,
                state,
                connection_id,
                writes,
                timeout_for(state, policy_id, *timeout_secs),
            )
            .await?,
        )?,
        RunScript {
            connection_id,
            policy_id,
            sql,
            transaction,
            max_rows,
            timeout_secs,
        } => serde_json::to_value(
            crate::commands::script::execute_script_inner(
                sink,
                state,
                connection_id,
                sql,
                *transaction,
                *max_rows,
                timeout_for(state, policy_id, *timeout_secs),
            )
            .await?,
        )?,
        FetchTableData {
            connection_id,
            schema,
            table,
            limit,
            offset,
            with_count,
            ..
        } => serde_json::to_value(
            crate::commands::query::fetch_table_data_inner(
                sink,
                state,
                crate::commands::query::TableQuery {
                    connection_id: connection_id.clone(),
                    schema: schema.clone(),
                    table: table.clone(),
                    limit: *limit,
                    offset: *offset,
                    order: Vec::new(),
                    filter: Default::default(),
                    projection: None,
                    collation: None,
                    hint: None,
                    // The bridge's own `with_count` is an `Option<bool>` on
                    // the wire; `None` kept the pre-struct default of "count".
                    with_count: with_count.unwrap_or(true),
                    // Whole documents: trimming is the grid's, not the AI's.
                    trim_above: None,
                },
            )
            .await?,
        )?,
        InsertRow {
            connection_id,
            schema,
            table,
            pk_column,
            values,
            ..
        } => {
            crate::commands::query::insert_row_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_column.clone(),
                serde_json::from_value(values.clone())?,
            )
            .await?
        }
        UpdateCell {
            connection_id,
            schema,
            table,
            pk_columns,
            pk_values,
            column,
            value,
            column_type,
            ..
        } => Value::from(
            crate::commands::query::update_cell_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_columns.clone(),
                pk_values.clone(),
                column.clone(),
                value.clone(),
                column_type.clone(),
            )
            .await?,
        ),
        DeleteRows {
            connection_id,
            schema,
            table,
            pk_columns,
            pk_value_rows,
            ..
        } => Value::from(
            crate::commands::query::delete_rows_inner(
                sink,
                state,
                connection_id.clone(),
                schema.clone(),
                table.clone(),
                pk_columns.clone(),
                pk_value_rows.clone(),
            )
            .await?,
        ),
        GetViewDefinition {
            connection_id,
            schema,
            view,
        } => serde_json::to_value(
            crate::error::with_timeout_for(
                state,
                connection_id,
                "get_view_definition",
                crate::commands::view::get_any_view_definition_inner(
                    state,
                    connection_id,
                    schema.clone(),
                    view,
                ),
            )
            .await?,
        )?,
        // One arm for both: the two differ only in whether the change is
        // executed, and that is carried by the *variant* rather than a field
        // (see `BridgeRequest::PreviewViewChange`), so it is read from the
        // discriminant here and nowhere else.
        //
        // No timeout wrapper on the apply, matching every other write arm above:
        // a DDL statement can legitimately outlast the introspection ceiling, and
        // timing out a write is the worst available outcome — the statement may
        // already have landed. The preview shares the arm and executes nothing,
        // so it needs none either.
        PreviewViewChange {
            connection_id,
            schema,
            name,
            query,
            rename_from,
            view_on,
            ..
        }
        | ApplyViewChange {
            connection_id,
            schema,
            name,
            query,
            rename_from,
            view_on,
            ..
        } => serde_json::to_value(
            crate::commands::view::save_any_view_inner(
                sink,
                state,
                &crate::commands::view::ViewSaveRequest {
                    connection_id: connection_id.clone(),
                    schema: schema.clone(),
                    name: name.clone(),
                    query: query.clone(),
                    rename_from: rename_from.clone(),
                    view_on: view_on.clone(),
                    preview: matches!(request, PreviewViewChange { .. }),
                },
            )
            .await?,
        )?,
        DropView {
            connection_id,
            schema,
            view,
            ..
        } => {
            crate::commands::view::drop_view_inner(
                sink,
                state,
                connection_id,
                schema.clone(),
                view,
            )
            .await?;
            // A genuine success carrying no payload; `OkWrapper` is what keeps
            // this distinguishable from "empty reply" on the wire
            // (`PROTOCOL_VERSION: 2`).
            Value::Null
        }
        CreateMongoIndex {
            connection_id,
            collection,
            spec,
            ..
        } => {
            crate::commands::mongo_indexes::create_mongo_index_inner(
                sink,
                state,
                &crate::commands::mongo_indexes::CreateIndexArgs {
                    connection_id: connection_id.clone(),
                    collection: collection.clone(),
                    spec: spec.clone(),
                },
            )
            .await?;
            Value::Null
        }
        DropMongoIndex {
            connection_id,
            collection,
            name,
            ..
        } => {
            crate::commands::mongo_indexes::drop_mongo_index_inner(
                sink,
                state,
                connection_id,
                collection,
                name,
            )
            .await?;
            Value::Null
        }
    };
    Ok(value)
}

/// The timeout a `run_script` / `run_writes` gets on this side: what it asked
/// for, under the ceiling the profile sets. A read (`run_query`) asks for
/// nothing, so it gets the default under the same ceiling.
///
/// Read fresh from `profiles.json`, falling back to the in-memory copy, like
/// the sidecar's write policy: on the sidecar's own path that copy is the one
/// loaded at startup, and a ceiling raised in Settings → MCP since must apply
/// to the next call without restarting the MCP client. In the app the two are
/// the same list.
pub(crate) fn timeout_for(
    state: &AppState,
    policy_id: &str,
    requested: Option<u32>,
) -> crate::state::McpTimeout {
    let profiles = fresh_profiles(state);
    crate::state::mcp_timeout(profiles.iter().find(|p| p.id == policy_id), requested)
}

/// An AI read's two limits, from one read of the profiles: its time
/// ([`timeout_for`]'s rule) and its connection's gate on reads at once
/// (ADR #141), both fresh so a change in Settings → MCP applies to the next
/// read.
fn read_limits(
    state: &AppState,
    policy_id: &str,
    requested: Option<u32>,
) -> (crate::state::McpTimeout, crate::commands::query::ReadGate) {
    let profiles = fresh_profiles(state);
    let profile = profiles.iter().find(|p| p.id == policy_id);
    let gate = state
        .read_gates
        .gate(policy_id, crate::state::mcp_concurrent_reads(profile));
    (crate::state::mcp_timeout(profile, requested), gate)
}

/// `profiles.json` as it is now, else this process's copy — see
/// [`timeout_for`].
fn fresh_profiles(state: &AppState) -> Vec<crate::state::ConnectionProfile> {
    crate::store::load_profiles().unwrap_or_else(|_| state.profiles.read().clone())
}
