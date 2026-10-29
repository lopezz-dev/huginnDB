//! View editor commands: read a view's definition, and preview / apply the
//! `CREATE VIEW` / `CREATE OR REPLACE VIEW` / rename / drop DDL built by
//! [`crate::db::view_ddl`]. Mirrors [`crate::commands::structure`]'s
//! introspect → preview → apply shape, but for views instead of tables.
//!
//! The per-driver catalog SQL that reads a stored definition lives with its
//! driver (`db::<driver>::schema::view_definition`), per ADR #43;
//! this module only dispatches to it.
//!
//! MongoDB has no `CREATE VIEW` equivalent (its "views" are read-only
//! aggregation-pipeline collections, edited via `collMod`/`createView` — a
//! fundamentally different model), so every command here rejects it up
//! front, matching [`crate::commands::structure`]'s existing Mongo guard.

use crate::db::sql::{Dialect, Relation};
use crate::db::view_ddl::{build_view_ddl, ViewDefinition};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink, TauriSink};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// Read a view's definition, or `None` when that name is not a view.
///
/// Borrowed-state core, shared by [`get_view_definition`] and by
/// [`save_any_view_inner`] — which needs it to work out whether it is creating a
/// view or replacing one, rather than making its caller supply the original.
///
/// SQL drivers only: MongoDB's "views" are stored pipelines with no `SELECT`
/// body to put in a [`ViewDefinition`], and are reached through
/// [`get_any_view_definition_inner`] instead.
///
/// The `schema` each arm reports back is the one it actually queried, not the
/// argument: Postgres resolves an omitted schema to `public`, MySQL echoes what
/// it was given (an empty one means "the session's current database", which has
/// no name to report), and SQLite has only `main`. That matters beyond
/// cosmetics — [`crate::db::view_ddl::build_view_ddl`] reads a differing schema as a *move*, so a
/// caller that round-trips this value through `desired` gets no spurious
/// rename.
pub async fn view_definition_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    view: &str,
) -> AppResult<Option<ViewDefinition>> {
    let pool = state.pool_for(connection_id)?;
    // `Dialect::try_of` is what rejects MongoDB, whose views are stored
    // pipelines and belong to the aggregation editor.
    Dialect::try_of(&pool)?;
    let (schema, query) = match &pool {
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or_else(|| "public".into());
            let query =
                crate::db::postgres::schema::view_definition(p, Some(&schema), view).await?;
            (Some(schema), query)
        }
        DbPool::Mysql(p) => {
            let query =
                crate::db::mysql::schema::view_definition(p, schema.as_deref(), view).await?;
            (schema, query)
        }
        DbPool::Sqlite(p) => {
            let query = crate::db::sqlite::schema::view_definition(p, None, view).await?;
            (None, query)
        }
        DbPool::MsSql(p) => {
            let query =
                crate::db::mssql::schema::view_definition(p, schema.as_deref(), view).await?;
            (schema, query)
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected by Dialect::try_of above"),
    };
    Ok(query.map(|query| ViewDefinition {
        schema,
        name: view.to_string(),
        query,
    }))
}

/// The header options an edit of `original` has to keep — SQL Server's
/// `WITH SCHEMABINDING` / `VIEW_METADATA`, which `ALTER VIEW` would otherwise
/// drop (see `db::view_ddl::build_view_ddl`). Empty for a new view and on
/// every other driver.
async fn header_options(
    pool: &DbPool,
    original: Option<&ViewDefinition>,
) -> AppResult<Vec<&'static str>> {
    match (pool, original) {
        (DbPool::MsSql(p), Some(o)) => {
            crate::db::mssql::schema::view_options(p, o.schema.as_deref(), &o.name).await
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn get_view_definition(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<ViewDefinition> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::read(state.inner(), &connection_id, schema.as_deref(), &view)?;
    let limit = crate::error::connection_timeout(state.inner(), &connection_id);
    crate::error::with_timeout_secs(limit, "get_view_definition", async move {
        let label = match schema.as_deref() {
            Some(s) if !s.is_empty() => format!("view {s}.{view}"),
            _ => format!("view {view}"),
        };
        view_definition_inner(state.inner(), &connection_id, schema, &view)
            .await?
            .ok_or(AppError::NotFound(label))
    })
    .await
}

/// A view's body, in whichever of the product's two view models the driver
/// uses.
///
/// One flat struct rather than an enum because its only consumer is an AI client
/// reading JSON: which fields are present says which model answered, and a
/// tagged union would make that a second thing to explain. SQL drivers fill
/// `query`; MongoDB fills `view_on` and `pipeline`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewBody {
    /// The view body — a bare `SELECT`, with no `CREATE VIEW ... AS` wrapper.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// MongoDB: the collection (or view) the pipeline reads from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_on: Option<String>,
    /// MongoDB: the stored pipeline as source text, in the same relaxed
    /// `mongosh` syntax that would create it — `ObjectId(...)` constructors
    /// included. Rendered through `bson_to_shell_text`, never the display
    /// converter, so it can be handed straight back to `save_view`
    /// (ADR #33).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
}

/// A view's body on any driver, or `None` when the name is not a view.
///
/// The MongoDB counterpart of [`view_definition_inner`], folded into one call so
/// a caller describing an arbitrary relation does not have to know which of the
/// two view models it is about to meet. `None` covers "that is a table", "that
/// is a collection" and "nothing by that name" alike: this is asked *about* a
/// relation whose kind the caller may not know yet, so absence is an answer
/// rather than a failure.
pub async fn get_any_view_definition_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    view: &str,
) -> AppResult<Option<ViewBody>> {
    if let DbPool::Mongo(conn) = &state.pool_for(connection_id)? {
        return Ok(
            match crate::db::mongo::aggregation::view_presence(conn, view).await? {
                crate::db::mongo::aggregation::ViewPresence::View(def) => Some(ViewBody {
                    query: None,
                    view_on: Some(def.view_on),
                    pipeline: Some(def.pipeline),
                }),
                _ => None,
            },
        );
    }
    Ok(view_definition_inner(state, connection_id, schema, view)
        .await?
        .map(|def| ViewBody {
            query: Some(def.query),
            view_on: None,
            pipeline: None,
        }))
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreview {
    pub statements: Vec<String>,
    pub drop_and_recreate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewChangeArgs {
    pub connection_id: String,
    #[serde(default)]
    pub original: Option<ViewDefinition>,
    pub desired: ViewDefinition,
}

#[tauri::command]
pub async fn preview_view_change(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: ViewChangeArgs,
) -> AppResult<ViewPreview> {
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    // A view's body is a query the person wrote, and can read any relation: free SQL (D3).
    crate::commands::guard::read(
        state.inner(),
        &args.connection_id,
        args.desired.schema.as_deref(),
        &args.desired.name,
    )?;
    crate::commands::guard::free_read(state.inner(), &args.connection_id)?;
    let pool = state.pool_for(&args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let options = header_options(&pool, args.original.as_ref()).await?;
    let (statements, drop_and_recreate) =
        build_view_ddl(dialect, args.original.as_ref(), &args.desired, &options)?;
    Ok(ViewPreview {
        statements,
        drop_and_recreate,
    })
}

#[tauri::command]
pub async fn apply_view_change(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: ViewChangeArgs,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &args.connection_id).await;
    // DDL on the view as it will be and, for a rename, as it was. A view's body is a query the person wrote, and can read any relation: free SQL (D3).
    crate::commands::guard::relation(
        state.inner(),
        &args.connection_id,
        args.desired.schema.as_deref(),
        &args.desired.name,
        crate::db::sql::Verbs::DDL,
    )?;
    if let Some(original) = &args.original {
        crate::commands::guard::relation(
            state.inner(),
            &args.connection_id,
            original.schema.as_deref(),
            &original.name,
            crate::db::sql::Verbs::DDL,
        )?;
    }
    crate::commands::guard::free_read(state.inner(), &args.connection_id)?;
    let pool = state.pool_for(&args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let options = header_options(&pool, args.original.as_ref()).await?;
    let (statements, _) = build_view_ddl(dialect, args.original.as_ref(), &args.desired, &options)?;

    // Wrapped on Postgres so a rename plus a body change cannot half-apply; see
    // `db::exec::execute_all` for the per-engine policy.
    crate::db::exec::execute_all(&pool, &statements).await?;
    Ok(())
}

/// One create / redefine / rename request, whichever driver serves it.
///
/// A struct rather than a flat argument list because the flat form would be
/// eight parameters with the sink, and because both the previewing and the
/// applying caller must pass the identical set — the same reasoning
/// `commands::bulk::build_update_statement` records. `preview` living *in* the
/// request is what makes "what you previewed is what runs" structural: there is
/// one path, and the flag only decides whether it stops before executing.
#[derive(Debug, Clone)]
pub struct ViewSaveRequest {
    pub connection_id: String,
    pub schema: Option<String>,
    /// The view's name after this call.
    pub name: String,
    /// SQL: the view body, a bare `SELECT`. MongoDB: the pipeline as source
    /// text.
    pub query: String,
    /// The view's *current* name, when this call also renames it.
    pub rename_from: Option<String>,
    /// MongoDB only: the collection the pipeline reads from. Inherited from the
    /// existing view when redefining one.
    pub view_on: Option<String>,
    /// Build the change without executing it.
    pub preview: bool,
}

/// What a [`ViewSaveRequest`] did, or would do.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewChangeOutcome {
    /// `false` for a preview.
    pub applied: bool,
    /// The statements, in order. Empty on MongoDB, whose change is a
    /// run-command rather than SQL — inventing SQL-shaped strings for an engine
    /// that does not speak it would be worse than saying nothing.
    pub statements: Vec<String>,
    /// `true` when the change is applied by dropping and recreating rather than
    /// replacing in place (always so on SQLite). Surfaced because a caller
    /// should be able to say so before agreeing to it.
    pub drop_and_recreate: bool,
    /// MongoDB only: the pipeline as it would be *stored*, re-rendered from the
    /// parsed BSON. Doubles as a round-trip check — an `ObjectId(...)` that came
    /// back as a bare string here would be a view that matches nothing
    /// (ADR #33).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    /// MongoDB only: `true` when this creates the view (`createView`), `false`
    /// when it redefines an existing one (`collMod`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creates: Option<bool>,
}

/// Create, redefine or rename a view, on any driver.
///
/// The request carries only the view's name and its new body: this function
/// reads the current definition itself to decide between a create and a
/// replace, and to build the `original` [`crate::db::view_ddl::build_view_ddl`] diffs against. That
/// division of labour is the point — a caller (in particular an AI client over
/// MCP) supplying a synthesised `original` is how a rename becomes a silent
/// redefinition, and it is the reason `docs/MCP_CONNECTOR_ROADMAP.md` deferred a
/// structure-editor tool. A `ViewDefinition` is `{schema, name, query}`, so
/// there is nothing here for a caller to get subtly wrong.
pub async fn save_any_view_inner(
    sink: &dyn LogSink,
    state: &AppState,
    req: &ViewSaveRequest,
) -> AppResult<ViewChangeOutcome> {
    let pool = state.pool_for(&req.connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return save_mongo_view_inner(sink, conn, &req.connection_id, req).await;
    }
    let dialect = Dialect::try_of(&pool)?;

    let current_name = req.rename_from.as_deref().unwrap_or(&req.name);
    let original =
        view_definition_inner(state, &req.connection_id, req.schema.clone(), current_name).await?;
    if req.rename_from.is_some() && original.is_none() {
        // Renaming something that isn't there is a mistake worth naming. The
        // alternative — falling through to a create under the new name — would
        // quietly do something else entirely.
        return Err(AppError::NotFound(format!("view {current_name}")));
    }

    let desired = ViewDefinition {
        // Always the schema `original` was read under, never a different one.
        // `build_view_ddl` treats a differing schema as part of `renamed`, but
        // the Postgres arm then emits `ALTER VIEW ... RENAME TO`, which cannot
        // move a view between schemas (that needs `SET SCHEMA`) — so a
        // cross-schema move is deliberately not expressible here rather than
        // expressible and wrong.
        schema: original
            .as_ref()
            .and_then(|o| o.schema.clone())
            .or_else(|| req.schema.clone()),
        name: req.name.clone(),
        query: req.query.clone(),
    };
    let options = header_options(&pool, original.as_ref()).await?;
    let (statements, drop_and_recreate) =
        build_view_ddl(dialect, original.as_ref(), &desired, &options)?;

    if req.preview {
        return Ok(ViewChangeOutcome {
            applied: false,
            statements,
            drop_and_recreate,
            pipeline: None,
            creates: None,
        });
    }

    let start = Instant::now();
    // Wrapped on Postgres so a rename plus a body change cannot half-apply; see
    // `db::exec::execute_all` for the per-engine policy. MySQL commits each DDL
    // statement implicitly, so a rename there is not atomic with the redefine.
    let res = crate::db::exec::execute_all(&pool, &statements).await;
    log_sql_sink(
        sink,
        &req.connection_id,
        pool.driver_name(),
        &statements.join("; "),
        start,
        None,
        res.as_ref().err().map(|e| e.to_string()).as_deref(),
    );
    res?;
    Ok(ViewChangeOutcome {
        applied: true,
        statements,
        drop_and_recreate,
        pipeline: None,
        creates: None,
    })
}

/// The MongoDB half of [`save_any_view_inner`]: `createView` or `collMod`.
///
/// The pipeline crosses every boundary as **source text** and is parsed only
/// here, by the one parser the product has (`db::mongo::shell` via
/// `parse_pipeline_text`). A structured pipeline would need a second JSON→BSON
/// converter and would turn `ObjectId("...")` into a string, leaving a view that
/// silently matches nothing — ADR #33.
async fn save_mongo_view_inner(
    sink: &dyn LogSink,
    conn: &crate::state::MongoConn,
    connection_id: &str,
    req: &ViewSaveRequest,
) -> AppResult<ViewChangeOutcome> {
    use crate::db::mongo::aggregation::{
        parse_pipeline_text, reject_write_stages, view_presence, ViewPresence,
    };

    if req.rename_from.is_some() {
        return Err(AppError::InvalidInput(
            "MongoDB cannot rename a view: `renameCollection` does not apply to one. Create the \
             new view from the same pipeline and drop the old one."
                .into(),
        ));
    }

    let stages = parse_pipeline_text(&req.query)?;
    // Also enforced inside `aggregation::save_view`; repeated here so a
    // *preview* refuses a write stage too, rather than reporting a pipeline it
    // would then decline to store.
    reject_write_stages(&stages)?;

    let supplied_view_on = req
        .view_on
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (creates, view_on) = match view_presence(conn, &req.name).await? {
        ViewPresence::View(existing) => (
            false,
            supplied_view_on
                .map(str::to_string)
                .unwrap_or(existing.view_on),
        ),
        ViewPresence::Absent => (
            true,
            supplied_view_on.map(str::to_string).ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "creating the MongoDB view `{}` needs `view_on` — the collection its \
                     pipeline reads from",
                    req.name
                ))
            })?,
        ),
        // `collMod` would fail on a collection anyway, but with a server error
        // that reads as a bug rather than as "you named the wrong thing".
        ViewPresence::Collection => {
            return Err(AppError::InvalidInput(format!(
                "`{}` is a collection, not a view — refusing to redefine it as one.",
                req.name
            )))
        }
    };

    let pipeline = crate::db::mongo::values::pipeline_to_shell_text(&stages);
    if req.preview {
        return Ok(ViewChangeOutcome {
            applied: false,
            statements: Vec::new(),
            drop_and_recreate: false,
            pipeline: Some(pipeline),
            creates: Some(creates),
        });
    }

    let start = Instant::now();
    let label = if creates {
        "(mongo createView)"
    } else {
        "(mongo collMod)"
    };
    let res =
        crate::db::mongo::aggregation::save_view(conn, &req.name, &view_on, stages, creates).await;
    log_sql_sink(
        sink,
        connection_id,
        "mongodb",
        label,
        start,
        None,
        res.as_ref().err().map(|e| e.to_string()).as_deref(),
    );
    res?;
    Ok(ViewChangeOutcome {
        applied: true,
        statements: Vec::new(),
        drop_and_recreate: false,
        pipeline: Some(pipeline),
        creates: Some(creates),
    })
}

/// Drop a view. Borrowed-state core of [`drop_view`].
///
/// MongoDB is the one driver whose views this module can otherwise not touch —
/// but *dropping* one needs no DDL at all (a view lives in the same namespace as
/// a collection), so it is handled here rather than forcing every caller to pick
/// a different command per driver. `aggregation::drop_view` checks that the name
/// really is a view before dropping anything; on the SQL drivers the engine does
/// that for us, since `DROP VIEW` against a table errors on all four.
pub async fn drop_view_inner(
    sink: &dyn LogSink,
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    view: &str,
) -> AppResult<()> {
    let pool = state.pool_for(connection_id)?;
    let start = Instant::now();
    if let DbPool::Mongo(conn) = &pool {
        let res = crate::db::mongo::aggregation::drop_view(conn, view).await;
        log_sql_sink(
            sink,
            connection_id,
            "mongodb",
            "(mongo drop view)",
            start,
            None,
            res.as_ref().err().map(|e| e.to_string()).as_deref(),
        );
        return res;
    }
    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), view);
    let sql = format!("DROP VIEW {qt}");
    // Dropping a view is plain, portable DDL on every SQL driver. MongoDB took
    // the branch above.
    let res = crate::db::exec::execute(&pool, &sql).await;
    log_sql_sink(
        sink,
        connection_id,
        pool.driver_name(),
        &sql,
        start,
        res.as_ref().ok().copied(),
        res.as_ref().err().map(|e| e.to_string()).as_deref(),
    );
    res.map(|_| ())
}

// ---------------------------------------------------------------------------
// Rename / drop
// ---------------------------------------------------------------------------

/// Rename a view. Postgres uses `ALTER VIEW ... RENAME TO`; MySQL treats
/// views and tables as the same namespace so `RENAME TABLE` works; SQLite
/// likewise accepts `ALTER TABLE ... RENAME TO` for a view.
///
/// SQL Server goes through the view editor's builder instead, because a bare
/// `sp_rename` leaves the old name inside the stored definition: it renames
/// and then re-issues the body with `ALTER VIEW`, in one transaction
/// (`db::view_ddl::build_view_ddl`).
#[tauri::command]
pub async fn rename_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
    new_name: String,
) -> AppResult<()> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "rename_view: new_name must not be empty".into(),
        ));
    }
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &view,
        crate::db::sql::Verbs::DDL,
    )?;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        new_name.trim(),
        crate::db::sql::Verbs::DDL,
    )?;
    let pool = state.pool_for(&connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    if dialect == Dialect::MsSql {
        let original = view_definition_inner(state.inner(), &connection_id, schema, &view)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("view {view}")))?;
        let desired = ViewDefinition {
            name: new_name.trim().to_string(),
            ..original.clone()
        };
        let options = header_options(&pool, Some(&original)).await?;
        let (statements, _) = build_view_ddl(dialect, Some(&original), &desired, &options)?;
        return crate::db::exec::execute_all(&pool, &statements).await;
    }
    let sql = dialect.rename_stmt(schema.as_deref(), &view, new_name.trim(), Relation::View)?;
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}

#[tauri::command]
pub async fn drop_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &view,
        crate::db::sql::Verbs::DDL,
    )?;
    let sink = TauriSink::new(&app, window.label());
    drop_view_inner(&sink, state.inner(), &connection_id, schema, &view).await
}
