//! Settings → Policy: this machine's managed policy — where it was read from,
//! who this is, which role that makes them, and what each connection allows;
//! the grants a role needs; and the editor. See `crate::policy`.
//!
//! The view is read-only for everyone. The editor saves only where the share
//! accepts a real write from this machine: the policy is written by whoever
//! the share's permissions let write it, and the app never decides who that
//! is (`policy::editor`).

use crate::state::AppState;
use tauri::State;

/// The policy as it applies to this user on this machine, right now.
///
/// Synchronous: it reads two locks and no file — the policy was loaded by
/// `policy::install`'s thread, and the profiles are in memory.
#[tauri::command]
pub fn policy_status(state: State<'_, AppState>) -> crate::policy::PolicyStatus {
    crate::policy::status(state.inner())
}

/// What the app may offer the person using it on each connection — locked
/// controls read this. `connection_ids` may be profile ids or
/// `<parent>::db::<name>` view ids, since a rule can be about one database.
///
/// Advisory for the interface only: every command refuses on its own
/// (`commands::guard`), so a stale answer here can show a control that then
/// fails, never let one through.
#[tauri::command]
pub fn policy_access(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
) -> crate::policy::PolicyAccess {
    crate::policy::access(state.inner(), &connection_ids)
}

/// A relation, as `policy_relation_access` is asked about it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: Option<String>,
    pub name: String,
}

/// What the person may do on each of `relations`, in one call per listing or
/// tab rather than one per row. The globs, the deny-wins rule and the
/// MySQL/MongoDB schema-is-the-database rule all live in Rust, so the
/// frontend cannot answer this on its own.
#[tauri::command]
pub fn policy_relation_access(
    state: State<'_, AppState>,
    connection_id: String,
    relations: Vec<RelationRef>,
) -> Vec<crate::policy::RelationAccess> {
    let pairs: Vec<(Option<String>, String)> =
        relations.into_iter().map(|r| (r.schema, r.name)).collect();
    crate::policy::relation_access(state.inner(), &connection_id, &pairs)
}

/// The permission script for policy `role` on `connection_id`'s server:
/// `GRANT`s (or MongoDB's `createRole`) that make the database agree with
/// what the role allows, for an administrator to review and run. HuginnDB
/// never runs it.
///
/// Reads the catalog through the `_inner` cores, unfiltered on purpose: the
/// grants must cover every relation the rules name, and the connection is the
/// administrator's own. Guarded by `monitor`, the permission that already lets
/// a person read users and privileges on the server.
#[tauri::command]
pub async fn policy_generate_grants(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    role: String,
) -> crate::error::AppResult<crate::policy::grants::GrantScript> {
    use crate::error::AppError;
    use crate::policy::grants::{self, Engine, GrantInput, Relation};
    use crate::state::Driver;

    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    let parent = crate::state::parent_connection_id(&connection_id).to_string();
    let (doc, source) = match &*state.policy.read() {
        crate::policy::PolicyState::Active { doc, source, .. } => (doc.clone(), source.clone()),
        _ => {
            return Err(AppError::InvalidInput(
                "no managed policy is in force on this machine, so there is nothing to grant"
                    .into(),
            ))
        }
    };
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == parent)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {parent}")))?;
    let engine = match profile.driver {
        Driver::Postgres => Engine::Postgres,
        Driver::Mysql => Engine::Mysql,
        Driver::MsSql => Engine::MsSql,
        Driver::Mongo => Engine::Mongo,
        Driver::Sqlite => {
            return Err(AppError::InvalidInput(
                "SQLite has no users to grant to; only the file's permissions protect it".into(),
            ))
        }
    };
    let rules = grants::rules_for(&doc, &role, &profile)
        .ok_or_else(|| AppError::InvalidInput(format!("the policy has no role {role:?}")))?;

    let mut databases = Vec::new();
    let mut relations = Vec::new();
    if !rules.is_empty() {
        for db in crate::commands::schema::list_databases_inner(state.inner(), &parent).await? {
            if !grants::wants_database(&rules, &db.name) {
                continue;
            }
            // Postgres, MySQL and SQL Server list the tables of the database
            // a pool is bound to, so each one is read through its own view.
            let child = crate::state::database_view_id(&parent, &db.name);
            crate::commands::ensure_view(&app, &window, state.inner(), &child).await;
            // Names only: the figures would cost MongoDB a round trip per
            // collection, and a grant needs none of them. Columns are read
            // only where a rule limits them (ADR #113), since a column grant
            // has to name each one.
            for t in crate::commands::schema::list_table_names_inner(state.inner(), &child).await? {
                let columns = if grants::wants_columns(&rules, &db.name, &t.schema, &t.name) {
                    crate::commands::schema::list_columns_inner(
                        state.inner(),
                        &child,
                        Some(t.schema.clone()),
                        t.name.clone(),
                    )
                    .await?
                    .into_iter()
                    .map(|c| c.name)
                    .collect()
                } else {
                    Vec::new()
                };
                relations.push(Relation {
                    database: db.name.clone(),
                    schema: t.schema,
                    name: t.name,
                    columns,
                });
            }
            databases.push(db.name);
        }
    }

    let members = grants::members(&doc, &role, &rules);
    Ok(grants::build(&GrantInput {
        engine,
        role: &role,
        rules,
        databases,
        relations,
        members,
        server: format!("{}:{}", profile.host, profile.effective_port()),
        source,
        generated_at: chrono::Utc::now().to_rfc3339(),
    }))
}

// ---------------------------------------------------------------------------
// The policy editor (phase 4). None of these touches a database, and none
// decides who may edit: the share's permissions do, through a real write
// (`policy::editor`). All run off the main thread, since a share can take its
// SMB timeout to answer.
// ---------------------------------------------------------------------------

/// The policy as it stands, with what this machine may do with it.
#[tauri::command]
pub async fn policy_open_for_edit() -> crate::error::AppResult<crate::policy::editor::PolicyEditDoc>
{
    tauri::async_runtime::spawn_blocking(crate::policy::editor::open)
        .await
        .map_err(|e| crate::error::AppError::InvalidInput(format!("policy editor: {e}")))
}

/// A draft checked by the parser that applies it, and, for `preview_user`,
/// what that person and their AI would get on every saved connection under
/// it. Pure: reads the profiles in memory and nothing else.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDraftCheck {
    pub validation: crate::policy::editor::Validation,
    pub preview: Option<crate::policy::editor::Preview>,
}

#[tauri::command]
pub fn policy_validate(
    state: State<'_, AppState>,
    text: String,
    preview_user: Option<String>,
) -> PolicyDraftCheck {
    let (doc, validation) = crate::policy::editor::validate(&text);
    let preview = match (doc, preview_user.as_deref().map(str::trim)) {
        (Some(doc), Some(user)) if !user.is_empty() => {
            let profiles = state.profiles.read().clone();
            Some(crate::policy::editor::preview(&doc, user, &profiles))
        }
        _ => None,
    };
    PolicyDraftCheck {
        validation,
        preview,
    }
}

/// Save a draft over the policy file this machine's anchor names. The path is
/// read from the anchor here, never taken from the caller: the editor saves
/// the policy, not an arbitrary file.
#[tauri::command]
pub async fn policy_save(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    base_sha256: String,
) -> crate::error::AppResult<crate::policy::editor::SaveOutcome> {
    use crate::error::AppError;
    use tauri::Emitter;
    let anchor = crate::policy::editor::anchor_info();
    let Some(path) = anchor.path.filter(|_| anchor.kind == "file") else {
        return Err(AppError::InvalidInput(
            "this machine's policy is not a file HuginnDB can edit; export it to a file first"
                .into(),
        ));
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::policy::editor::save(std::path::Path::new(&path), &text, &base_sha256)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("policy editor: {e}")))??;
    if matches!(outcome, crate::policy::editor::SaveOutcome::Saved { .. }) {
        // Apply it here at once rather than at the next five-minute read, and
        // tell every window, whose locks may have just changed.
        let shared = state.policy.clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || crate::policy::reload_now(&shared)).await;
        let _ = app.emit(crate::policy::CHANGED_EVENT, ());
    }
    Ok(outcome)
}

/// Write a new policy file at `path` (the "Create policy" wizard, or moving an
/// inline policy to a file), and say how to point the machines at it.
#[tauri::command]
pub async fn policy_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> crate::error::AppResult<crate::policy::editor::CreatedPolicy> {
    use crate::error::AppError;
    use tauri::Emitter;
    let created = tauri::async_runtime::spawn_blocking(move || {
        crate::policy::editor::create(std::path::Path::new(path.trim()), &text)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("policy editor: {e}")))??;
    // Only a machine already pointed at this path changes; for any other the
    // reload finds the same anchor and nothing moves.
    let shared = state.policy.clone();
    let changed = tauri::async_runtime::spawn_blocking(move || crate::policy::reload_now(&shared))
        .await
        .unwrap_or(false);
    if changed {
        let _ = app.emit(crate::policy::CHANGED_EVENT, ());
    }
    Ok(created)
}
