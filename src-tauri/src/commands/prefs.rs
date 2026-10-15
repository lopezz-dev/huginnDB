//! Preferences and per-connection tab-state command surface.
//!
//! The frontend hydrates from [`get_preferences`] / [`get_tab_state`] at
//! startup and writes back via the matching setters (debounced on the
//! frontend side to avoid hammering the disk while a user drags a slider).

use crate::commands::connection::{
    apply_profile_imports, ImportProgress, IMPORT_PROGRESS_EVENT, PROFILES_CHANGED_EVENT,
};
use crate::error::{AppError, AppResult};
use crate::prefs::{self, Preferences};
use crate::state::{AppState, ConnectionProfile};
use crate::store;
use crate::tab_state::{self, ConnectionTabState, Environment, LaunchState, Origin};
use crate::transfer::{
    self, ConflictAction, ConflictResolution, EnvironmentExportFile, EnvironmentImportAnalysis,
    EnvironmentImportAnalysisEntry, EnvironmentImportResult, ExportedEnvironment,
    ExportedEnvironmentBundle, ExportedOrigin, ImportedEnvironment, KIND_ENVIRONMENT,
};
use tauri::{AppHandle, Emitter, State};

/// Broadcast (unscoped — every window) after a successful `update_preferences`,
/// carrying the full persisted snapshot. Each window's frontend hydrates its
/// own private `Preferences` copy once at boot and otherwise has no way to
/// learn another window changed a setting; without this, two windows racing
/// to save (each sending its *entire* blob, not a diff) silently lose
/// whichever one saved first the moment the other's debounce timer fires —
/// see issue #18. The listener just adopts the payload as its new baseline
/// (no re-save), so this is idempotent for the window that triggered it too.
pub const PREFS_CHANGED_EVENT: &str = "huginndb://prefs-changed";

/// Return the in-memory preferences snapshot.
#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> AppResult<Preferences> {
    Ok(state.prefs.read().clone())
}

/// Replace the entire preferences blob and persist it to disk.
///
/// The frontend always sends a full [`Preferences`] value; partial updates
/// are merged client-side. This keeps the wire shape trivial and lets us
/// keep the on-disk file as a faithful mirror of frontend state.
#[tauri::command]
pub async fn update_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    prefs: Preferences,
) -> AppResult<()> {
    let (auto_install_was, jump_list_was) = {
        let mut guard = state.prefs.write();
        let was = (
            guard.updates.auto_install,
            (guard.ui.jump_list_recent, guard.ui.language.clone()),
        );
        *guard = prefs.clone();
        was
    };
    prefs::save_preferences(&prefs)?;
    // The one preference with a footprint outside the app: turning background
    // updates on or off registers or removes the scheduled tasks. Only on a
    // change — every other save would otherwise shell out to `schtasks`.
    if auto_install_was != prefs.updates.auto_install {
        let product = app.config().product_name.clone().unwrap_or_default();
        let enabled = prefs.updates.auto_install;
        tauri::async_runtime::spawn_blocking(move || {
            crate::updater::reconcile_for_app(&product, enabled, true);
        });
    }
    // The taskbar Jump List is written by the shell, not rendered from these
    // preferences, so it has to be rebuilt when either input it reads moves:
    // the recent-connections switch, or the language its labels are in.
    if jump_list_was != (prefs.ui.jump_list_recent, prefs.ui.language.clone()) {
        crate::jump_list::refresh(&app);
    }
    let _ = app.emit(PREFS_CHANGED_EVENT, prefs);
    // Most preferences take effect just by being readable, but the MCP bridge
    // owns a socket: toggling it has to actually start or stop the listener.
    // `reconcile` is idempotent and cheap when nothing changed, so it runs on
    // every write rather than trying to detect which field moved — the
    // preferences arrive as a whole snapshot, so there is no diff to inspect.
    // `async` for this one reason; the command's IPC shape is unchanged.
    crate::bridge::server::reconcile(&app).await;
    Ok(())
}

/// Look up the persisted tab state for `connection_id` **in the active
/// environment**. Returns `None` when the connection has never been opened
/// there, has been pruned, or its entry was cleared after the profile was
/// deleted.
///
/// Only the main window ever calls this — secondary windows (opened via
/// "New window") never hydrate or save tab state, which is what makes
/// them ephemeral. The active environment is likewise a main-window concept.
#[tauri::command]
pub fn get_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<ConnectionTabState>> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .and_then(|env| env.connections.get(&connection_id))
        .cloned())
}

/// Replace the persisted tab state for `connection_id` in the active
/// environment and write the full blob to disk. The frontend stamps
/// `last_opened` before sending; we run a final pass to drop oversize query
/// bodies and to LRU-prune each environment's map.
#[tauri::command]
pub fn save_tab_state(
    state: State<'_, AppState>,
    connection_id: String,
    mut tab_state_value: ConnectionTabState,
) -> AppResult<()> {
    tab_state::normalise(&mut tab_state_value);
    tab_state::mutate(&state.tab_state, |ts| {
        ts.active_environment_mut()
            .connections
            .insert(connection_id, tab_state_value);
        ts.prune();
        Ok(())
    })
}

/// Drop the persisted tab state for `connection_id`. Invoked when a
/// profile is deleted so a removed connection can't keep a dangling tab
/// reference around.
///
/// Sweeps **every** environment, not just the active one: the profile is gone
/// globally, so an entry left behind in another environment would resurface as
/// a tab pointing at a connection that no longer exists the moment the user
/// switched there.
#[tauri::command]
pub fn clear_tab_state(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        for env in &mut ts.environments {
            env.connections.remove(&connection_id);
            env.launch
                .active_connections
                .retain(|id| id != &connection_id);
            if env.launch.selected_connection_id.as_deref() == Some(connection_id.as_str()) {
                env.launch.selected_connection_id = None;
            }
        }
        Ok(())
    })
}

/// Return the session-level inner-dockview geometry, or `None` for the
/// default tabbed layout. Session-level rather than per-connection: the
/// inner dockview is a single shared instance hosting every connection's
/// tabs, so its geometry belongs to the session (see
/// `tab_state::PersistedTabState::internal_layout`). Main-window-only, same
/// as the per-connection tab-state calls.
#[tauri::command]
pub fn get_workspace_layout(state: State<'_, AppState>) -> AppResult<Option<serde_json::Value>> {
    Ok(state
        .tab_state
        .read()
        .active_environment()
        .and_then(|env| env.internal_layout.clone()))
}

/// Persist the session-level inner-dockview geometry (or `None` to clear it
/// back to the default tabbed layout) and write the full blob to disk.
#[tauri::command]
pub fn save_workspace_layout(
    state: State<'_, AppState>,
    layout: Option<serde_json::Value>,
) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        ts.active_environment_mut().internal_layout = layout;
        Ok(())
    })
}

/// Return the active environment's launch-restore state.
///
/// The DTO used to be declared here; it now lives in `tab_state` next to the
/// rest of the persisted shape, so there is one definition instead of two kept
/// in sync by hand.
///
/// `visible_connections` is resolved through `effective_visible_connections`
/// rather than read off `env.launch` verbatim — a mirrored environment's own
/// hide/show choice (`local_visible_connections`) must win over the true
/// membership a sync last wrote there. See that method's doc.
#[tauri::command]
pub fn get_launch_state(state: State<'_, AppState>) -> AppResult<LaunchState> {
    let guard = state.tab_state.read();
    Ok(guard
        .active_environment()
        .map(|env| {
            let mut launch = env.launch.clone();
            launch.visible_connections = env.effective_visible_connections();
            launch
        })
        .unwrap_or_default())
}

/// Record the launch-restore state (live connections, focused connection,
/// active tab) so the next launch — or the next switch back into this
/// environment — can restore it. Written on window close and opportunistically
/// on connect/disconnect; see `src/stores/persistedTabs.ts`.
#[tauri::command]
pub fn save_launch_state(state: State<'_, AppState>, launch_state: LaunchState) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        apply_launch_state(ts.active_environment_mut(), launch_state);
        Ok(())
    })
}

/// The part of [`save_launch_state`] worth testing without an `AppState`
/// (convention #52) — a pure function over the one `Environment` it
/// touches.
///
/// For a mirrored environment, `visible_connections` is diverted into
/// `local_visible_connections` instead of `launch.visible_connections`: the
/// latter is `sync_environment_bundles`'s notion of this environment's true
/// membership, and letting a plain save overwrite it there would leave the
/// next sync with nothing genuine to compare against (and, worse, would erase
/// itself the moment that sync runs — the reported bug this whole mechanism
/// exists to fix). Every other field of the incoming state still lands in
/// `launch` normally.
fn apply_launch_state(env: &mut Environment, launch_state: LaunchState) {
    if env.origin_id.is_some() {
        let synced_membership = env.launch.visible_connections.clone();
        env.local_visible_connections = launch_state.visible_connections.clone();
        env.launch = launch_state;
        env.launch.visible_connections = synced_membership;
    } else {
        env.launch = launch_state;
    }
}

// --- Environments ------------------------------------------------------------
// A named set of connections plus the session state belonging to them. The
// active one scopes every tab-state / layout / launch call above.
//
// All of these are main-window-only in practice, for the same reason tab state
// is (ADR #8): a secondary window writing here would reshape the
// main window's session out from under it.

/// Every environment in display order, plus which one is active.
#[tauri::command]
pub fn list_environments(state: State<'_, AppState>) -> AppResult<EnvironmentList> {
    let guard = state.tab_state.read();
    let mut environments = guard.environments.clone();
    environments.sort_by_key(|e| e.order);
    // Same resolution `get_launch_state` applies: a secondary window seeds its
    // own filters straight from this list's `launch` field (`applyLocalView`),
    // so it needs the effective value too, not the raw synced membership.
    for env in &mut environments {
        env.launch.visible_connections = env.effective_visible_connections();
    }
    Ok(EnvironmentList {
        active_environment_id: guard
            .active_environment()
            .map(|e| e.id.clone())
            .unwrap_or_default(),
        environments,
    })
}

/// What [`list_environments`] returns: the list and the active id together, so
/// the frontend can't render a switcher out of step with the backend's notion of
/// which one is current.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub environments: Vec<Environment>,
    pub active_environment_id: String,
}

/// Create a new environment, or update an existing one's presentation fields.
///
/// Deliberately narrow: this never touches `connections`, `internal_layout` or
/// `launch`. Those are owned by the session-state commands above and a
/// round-trip through the frontend's editing form would drop whatever the user
/// had open — the same class of bug as gotcha #14, but caused by an incomplete
/// payload rather than by serde.
#[tauri::command]
pub fn save_environment(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    theme_id: Option<String>,
) -> AppResult<Environment> {
    tab_state::mutate(&state.tab_state, |ts| match id {
        Some(id) => {
            let env = ts
                .environments
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))?;
            env.name = name;
            env.color = color;
            env.icon = icon;
            env.theme_id = theme_id;
            Ok(env.clone())
        }
        None => {
            let order = ts.environments.iter().map(|e| e.order).max().unwrap_or(0) + 1;
            let env = Environment {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                color,
                icon,
                order,
                theme_id,
                ..Environment::default()
            };
            ts.environments.push(env.clone());
            Ok(env)
        }
    })
}

/// Set (or clear) this machine's local override of a mirrored environment's
/// cosmetics — `local_name`/`local_color`/`local_icon`/`local_theme_id` on
/// [`Environment`]. A separate command from `save_environment` on purpose:
/// that one replaces the *synced* fields wholesale, and giving one signature
/// two different semantics (synced value vs. local-only override) is exactly
/// the "an omitted field silently reverts something else" trap CLAUDE.md's
/// gotcha #14 already documents for a typed IPC boundary. `Some(None)` isn't
/// representable per-field here — passing `None` for a field clears that
/// override (falls back to the synced value); there is no "leave unchanged"
/// state, so the frontend always sends the full effective draft.
#[tauri::command]
pub fn set_environment_local_overrides(
    state: State<'_, AppState>,
    id: String,
    local_name: Option<String>,
    local_color: Option<String>,
    local_icon: Option<String>,
    local_theme_id: Option<String>,
) -> AppResult<Environment> {
    tab_state::mutate(&state.tab_state, |ts| {
        let env = ts
            .environments
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))?;
        env.local_name = local_name;
        env.local_color = local_color;
        env.local_icon = local_icon;
        env.local_theme_id = local_theme_id;
        Ok(env.clone())
    })
}

/// Delete an environment and everything it remembered.
///
/// Refuses to delete the last one: the invariant every session-state command
/// relies on is that an active environment always exists, and "delete the only
/// environment" has no sensible outcome — an empty switcher is not a state the
/// user can act from. Deleting the active one moves focus to the first survivor.
///
/// Connection *profiles* are untouched. An environment owns session state, not
/// the connections themselves (they live in `profiles.json`), so removing one
/// discards tabs and layout, never credentials.
#[tauri::command]
pub fn delete_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        if ts.environments.len() <= 1 {
            return Err(AppError::InvalidInput(
                "cannot delete the last environment".into(),
            ));
        }
        let before = ts.environments.len();
        ts.environments.retain(|e| e.id != id);
        if ts.environments.len() == before {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        if ts.active_environment_id.as_deref() == Some(id.as_str()) {
            ts.active_environment_id = ts.environments.first().map(|e| e.id.clone());
        }
        Ok(())
    })
}

/// Detach an environment from the origin that mirrors it (#108 continuous
/// environment sync's "adopt", the environment-level twin of clearing a
/// connection profile's `origin_id`).
///
/// Clears `origin_id`/`origin_source_id`. Connections and session state are
/// left exactly as they were at the moment of adoption — the next
/// `sync_origin` run for that origin will no longer touch this environment,
/// and it becomes an ordinary local one.
///
/// Cosmetics fold rather than staying exactly as they were: any
/// `local_name`/`local_color`/`local_icon`/`local_theme_id` override is
/// promoted into the now-authoritative `name`/`color`/`icon`/`theme_id` and
/// the `local_*` fields are cleared. Once detached there is no longer a
/// synced value to override — leaving both set would be pure ambiguity, and
/// wrong the moment the public fields diverged from what the override was
/// shadowing.
#[tauri::command]
pub fn adopt_environment(state: State<'_, AppState>, id: String) -> AppResult<Environment> {
    tab_state::mutate(&state.tab_state, |ts| {
        let env = ts
            .environments
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))?;
        env.origin_id = None;
        env.origin_source_id = None;
        env.adopt_local_overrides();
        Ok(env.clone())
    })
}

/// Switch the active environment.
///
/// Backend-side this is just a pointer move plus a write; the expensive part is
/// the frontend's job and its order is load-bearing (flush the outgoing
/// session → disconnect → set active → reconnect → restore layout → restore
/// focus). See `src/stores/environments.ts`.
#[tauri::command]
pub fn set_active_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        if !ts.environments.iter().any(|e| e.id == id) {
            return Err(AppError::InvalidInput(format!(
                "no environment with id {id}"
            )));
        }
        ts.active_environment_id = Some(id);
        Ok(())
    })
}

/// Persist the switcher's display order.
#[tauri::command]
pub fn reorder_environments(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        for (i, id) in ids.iter().enumerate() {
            if let Some(env) = ts.environments.iter_mut().find(|e| &e.id == id) {
                env.order = i as i32;
            }
        }
        Ok(())
    })
}

// --- Environment export/import ------------------------------------------
//
// An environment's portable identity is its cosmetics + the connections it
// groups + the shared origins it pulls from — never its tabs or dockview
// geometry (see the module doc in `crate::transfer`). Import always creates a
// brand-new environment, so there is nothing for origins (or the environment
// itself) to conflict with; only the connection profiles can, because
// `profiles.json` is global. That reuses `import_profiles`'s exact
// conflict/rename/keychain machinery via `apply_profile_imports`.

/// Every connection id this environment references, anywhere: its remembered
/// tab state, what was live at last close, the focused connection, and the
/// per-connection database-visibility overrides. Deleting a profile already
/// sweeps all of these (ADR #27), so in practice every id here resolves to
/// a real profile — but the export still filters defensively rather than
/// assuming that.
/// `pub(crate)` for a second caller with the same question: the origin
/// editor offers this machine's environments as bundles to copy into a
/// document, and "which connections does this environment mean" has to be
/// answered the same way the export answers it, or the two disagree about what
/// an environment *is*.
pub(crate) fn referenced_profile_ids(env: &Environment) -> std::collections::HashSet<String> {
    let mut ids: std::collections::HashSet<String> = env.connections.keys().cloned().collect();
    ids.extend(env.launch.active_connections.iter().cloned());
    if let Some(sel) = &env.launch.selected_connection_id {
        ids.insert(sel.clone());
    }
    if let Some(visible) = &env.launch.visible_connections {
        ids.extend(visible.iter().cloned());
    }
    if let Some(visible) = &env.local_visible_connections {
        ids.extend(visible.iter().cloned());
    }
    ids.extend(env.launch.database_visibility.keys().cloned());
    ids
}

/// Every environment in `environments` that references `profile_id`, by the
/// same definition of "references" as [`referenced_profile_ids`] (tab state,
/// last-open set, focus, visibility filters). Pure and separate from the
/// command below so it's testable without a real `AppState`.
fn environments_referencing(environments: &[Environment], profile_id: &str) -> Vec<String> {
    environments
        .iter()
        .filter(|env| referenced_profile_ids(env).contains(profile_id))
        .map(|env| env.id.clone())
        .collect()
}

/// Every environment that references `profile_id` — see
/// [`environments_referencing`].
///
/// Used by the CLI connect flow (`useCliIntents.ts`) to follow a connection
/// into whichever environment it actually belongs to, rather than always
/// landing in whatever happens to be active — `profiles.json` is global, so a
/// profile's own environment isn't otherwise knowable from the frontend
/// (`Environment.connections`, the strongest signal, is never sent over IPC
/// except implicitly through this lookup). A profile referenced by more than
/// one environment (or by none — e.g. a freshly saved profile never yet
/// opened) is for the caller to resolve; this just reports the raw set.
#[tauri::command]
pub fn find_environments_for_connection(
    state: State<'_, AppState>,
    profile_id: String,
) -> Vec<String> {
    environments_referencing(&state.tab_state.read().environments, &profile_id)
}

/// Export one or more environments into a single bundle: each one's
/// cosmetics and registered shared origins (name + path only — never the
/// passphrase, which stays in this machine's keychain; see
/// `commands::origins`), plus a single deduplicated pool of the connection
/// profiles any of them reference.
///
/// Tabs, dockview geometry and launch state are deliberately left out — they
/// are session artifacts tied to this machine, not part of an environment's
/// portable identity (ADR #10).
#[tauri::command]
pub async fn export_environments(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    include_passwords: bool,
    passphrase: Option<String>,
    include_json_schemas: Option<bool>,
) -> AppResult<String> {
    if ids.is_empty() {
        return Err(AppError::InvalidInput(
            "select at least one environment to export".into(),
        ));
    }
    if include_passwords && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "a passphrase is required when include_passwords is true".into(),
        ));
    }

    let (envs, origins_snapshot): (Vec<Environment>, Vec<Origin>) = {
        let guard = state.tab_state.read();
        let envs = ids
            .iter()
            .map(|id| {
                guard
                    .environments
                    .iter()
                    .find(|e| &e.id == id)
                    .cloned()
                    .ok_or_else(|| AppError::InvalidInput(format!("no environment with id {id}")))
            })
            .collect::<AppResult<Vec<_>>>()?;
        (envs, guard.origins.clone())
    };

    // Union of every profile any selected environment references — not one
    // copy per environment (see `EnvironmentExportFile`'s doc).
    let mut profile_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for env in &envs {
        profile_ids.extend(referenced_profile_ids(env));
    }
    let profiles_snapshot: Vec<ConnectionProfile> = {
        let guard = state.profiles.read();
        guard
            .iter()
            .filter(|p| profile_ids.contains(&p.id))
            .cloned()
            .collect()
    };
    let exported_profiles = transfer::build_exported_profiles(
        &profiles_snapshot,
        include_passwords,
        passphrase.as_deref(),
    )?;

    let bundles: Vec<ExportedEnvironmentBundle> = envs
        .iter()
        .map(|env| {
            let mut connection_ids: Vec<String> = referenced_profile_ids(env).into_iter().collect();
            connection_ids.sort();

            // Origins are a global registry now (`PersistedTabState::origins`,
            // tab_state.json v5), so there is no `env.origins` to copy
            // verbatim any more — an environment's "own" origins are whichever
            // ones its connections actually depend on, plus the one it mirrors
            // itself, if any.
            let mut origin_ids: std::collections::HashSet<&str> = connection_ids
                .iter()
                .filter_map(|id| profiles_snapshot.iter().find(|p| &p.id == id))
                .filter_map(|p| p.origin_id.as_deref())
                .collect();
            if let Some(oid) = env.origin_id.as_deref() {
                origin_ids.insert(oid);
            }
            let origins: Vec<ExportedOrigin> = origins_snapshot
                .iter()
                .filter(|o| origin_ids.contains(o.id.as_str()))
                .map(|o| ExportedOrigin {
                    name: o.name.clone(),
                    path: o.path.clone(),
                })
                .collect();

            ExportedEnvironmentBundle {
                environment: ExportedEnvironment {
                    name: env.name.clone(),
                    color: env.color.clone(),
                    icon: env.icon.clone(),
                    theme_id: env.theme_id.clone(),
                    source_environment_id: env.id.clone(),
                },
                connection_ids,
                origins,
            }
        })
        .collect();

    // The whole library, not a per-environment slice: schemas are global
    // (`crate::json_schemas`), so there is no subset an environment "owns".
    // Riding along in this file is a convenience for setting up a machine, not
    // a claim that the environment contains them.
    let json_schemas = if include_json_schemas.unwrap_or(false) {
        let guard = state.json_schemas.read();
        let ids: Vec<String> = guard.schemas.iter().map(|s| s.id.clone()).collect();
        crate::json_schemas::import::collect_bundle(&guard, &ids, true)
    } else {
        transfer::JsonSchemaBundle::default()
    };

    let now = chrono::Utc::now().to_rfc3339();
    let file = EnvironmentExportFile {
        meta: transfer::metadata(KIND_ENVIRONMENT, include_passwords, &now),
        environments: bundles,
        profiles: exported_profiles,
        json_schemas,
    };

    let date_part = now.get(..10).unwrap_or("export");
    let suggested = if envs.len() == 1 {
        format!("huginndb-environment-{date_part}.json")
    } else {
        format!("huginndb-environments-{date_part}.json")
    };
    let dest = transfer::save_export(
        &app,
        "Export environments",
        &suggested,
        &serde_json::to_string_pretty(&file)?,
    )?;
    Ok(dest)
}

/// Read and parse an environment export without decrypting anything or
/// touching any state. Mirrors `analyze_import_file`: the frontend calls this
/// first to drive the same conflict-resolution step, before collecting a
/// passphrase (if `encrypted`) and calling `import_environment`.
#[tauri::command]
pub fn analyze_environment_import(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<EnvironmentImportAnalysis> {
    let data = std::fs::read_to_string(&file_path)?;
    let export: EnvironmentExportFile = serde_json::from_str(&data)?;

    transfer::check_meta(&export.meta, KIND_ENVIRONMENT)?;

    let profiles = state.profiles.read();
    let conflicts = transfer::detect_conflicts(&profiles, &export.profiles);

    let environments = export
        .environments
        .iter()
        .map(|b| EnvironmentImportAnalysisEntry {
            name: b.environment.name.clone(),
            connection_count: b.connection_ids.len(),
            origins: b.origins.clone(),
        })
        .collect();

    Ok(EnvironmentImportAnalysis {
        environments,
        total_profiles: export.profiles.len(),
        encrypted: export.meta.encrypted,
        conflicts,
        total_json_schemas: export.json_schemas.schemas.len(),
        total_json_schema_bindings: export.json_schemas.bindings.len(),
    })
}

/// Import an environment export: every bundle in the file becomes a **new**
/// environment — none is ever merged into or overwritten on top of one that
/// already exists, which is what makes this safe to run repeatedly and what
/// guarantees the origins/cosmetics below never collide with anything already
/// configured. The only real conflict surface is the shared connection-profile
/// pool (`profiles.json` is global), resolved once for the whole file via
/// `apply_profile_imports` — not once per environment.
///
/// Each new environment's connection-tree is scoped to exactly the profiles
/// its bundle referenced via `launch.visible_connections` (the same
/// DataGrip-style filter #107 already added), translated through the
/// import's original-id → new-id map so a skipped or renamed profile is
/// reflected correctly. None are auto-connected (`launch.active_connections`
/// stays empty): importing an environment should not silently open N live
/// database connections.
///
/// Each origin is registered — globally, in `PersistedTabState::origins`, not
/// on the new environment (there is no per-environment slot any more, see
/// `commands::origins`'s module doc) — with a fresh id and no stored
/// passphrase. An encrypted one surfaces the same "no passphrase stored"
/// state a freshly `add_origin`-ed one would, on the next sync — there's
/// nothing special to resolve here at import time. No dedup against origins
/// already registered from a previous import: unlike the v4→v5 migration
/// (which merges by necessity, since a v4 blob could genuinely hold the same
/// path twice), a fresh import minting a second global entry for a path
/// that's already registered is a much rarer case and easy to spot and clean
/// up by hand in Settings → Origins.
///
/// `async fn` on purpose, with the actual work run via `spawn_blocking`: a
/// synchronous Tauri command executes on the main thread, and
/// `apply_profile_imports` runs one 600 000-iteration PBKDF2 derivation per
/// encrypted secret (`transfer::decrypt_secret`) — deliberately slow, and with
/// a bundle carrying dozens of environments' worth of connection profiles,
/// slow enough in aggregate to freeze the window for the whole import (issue:
/// app reported "not responding" importing 13 environments / 22 conflicting
/// profiles).
///
/// `window` is only used to scope [`IMPORT_PROGRESS_EVENT`] to the caller —
/// see the event's own doc comment (`commands::connection`) for why a plain
/// `app.emit` would leak progress into every open window (gotcha #25).
#[tauri::command]
pub async fn import_environment(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    file_path: String,
    passphrase: Option<String>,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<EnvironmentImportResult> {
    let profiles_lock = state.profiles.clone();
    let json_schemas_lock = state.json_schemas.clone();
    let tab_state_lock = state.tab_state.clone();
    let app_for_task = app.clone();
    let window_label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || -> AppResult<EnvironmentImportResult> {
        let data = std::fs::read_to_string(&file_path)?;
        let export: EnvironmentExportFile = serde_json::from_str(&data)?;

        transfer::check_meta(&export.meta, KIND_ENVIRONMENT)?;
        if export.meta.encrypted && passphrase.is_none() {
            return Err(AppError::Transfer(
                "this export file contains encrypted passwords — provide a passphrase".into(),
            ));
        }

        let resolution_map: std::collections::HashMap<String, ConflictAction> =
            conflict_resolutions
                .into_iter()
                .map(|r| (r.id, r.action))
                .collect();

        let (profile_result, id_map, overwritten_ids) = {
            let mut profiles = profiles_lock.write();
            let (result, id_map, overwritten_ids) = apply_profile_imports(
                &mut profiles,
                export.profiles,
                passphrase.as_deref(),
                &resolution_map,
                |done, total| {
                    let _ = app_for_task.emit_to(
                        &window_label,
                        IMPORT_PROGRESS_EVENT,
                        ImportProgress { done, total },
                    );
                },
            )?;
            store::save_profiles(&profiles)?;
            (result, id_map, overwritten_ids)
        };
        let _ = app_for_task.emit(PROFILES_CHANGED_EVENT, ());

        // JSON Schemas, when the file carried them. Two passes, in this order:
        // first repoint local bindings whose profile was *overwritten* (a fresh
        // uuid is minted even then, so they would silently stop matching), then
        // merge the file's own schemas, translating their bindings through the same
        // `id_map` that `launch.visible_connections` uses below.
        let schema_result = {
            let bundle = export.json_schemas;
            let has_bundle = !bundle.is_empty();
            if !has_bundle && overwritten_ids.is_empty() {
                None
            } else {
                let now = chrono::Utc::now().to_rfc3339();
                let mut lib = json_schemas_lock.write();
                crate::json_schemas::remap_connection_ids(&mut lib, &overwritten_ids);
                let outcome = if has_bundle {
                    Some(crate::json_schemas::import::apply_imports(
                        &mut lib,
                        bundle,
                        &resolution_map,
                        &crate::json_schemas::import::ConnectionRemap::IdMap(&id_map),
                        &now,
                    ))
                } else {
                    None
                };
                let snapshot = lib.clone();
                drop(lib);
                crate::json_schemas::save_library(&snapshot)?;
                let _ = app_for_task.emit(
                    crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
                    (),
                );
                outcome
            }
        };

        let imported_environments = tab_state::mutate(&tab_state_lock, |ts| {
            let base_order = ts.environments.iter().map(|e| e.order).max().unwrap_or(0) + 1;

            let mut imported_environments = Vec::with_capacity(export.environments.len());
            for (i, bundle) in export.environments.into_iter().enumerate() {
                let ExportedEnvironmentBundle {
                    environment,
                    connection_ids,
                    origins: bundle_origins,
                } = bundle;

                let mut origins = Vec::with_capacity(bundle_origins.len());
                let mut origin_ids = Vec::with_capacity(bundle_origins.len());
                for eo in bundle_origins {
                    let oid = uuid::Uuid::new_v4().to_string();
                    origin_ids.push(oid.clone());
                    origins.push(Origin {
                        id: oid,
                        name: eo.name,
                        path: eo.path,
                        last_synced_at: None,
                        landed_secrets: Default::default(),
                        // An imported origin is a consumer, like any other
                        // freshly registered one: a file cannot hand this
                        // machine permission to write to a share.
                        role: Default::default(),
                        maintainer: None,
                        // The full scope, like any other freshly registered
                        // origin: an environment bundle names an origin its
                        // connections depend on, so narrowing the import's
                        // registration to exclude connections would produce an
                        // environment that can never resolve its own members.
                        scope: Default::default(),
                    });
                }

                // Translate this bundle's original connection ids into whatever
                // they actually landed as — a skipped profile has no entry here.
                let visible: Vec<String> = connection_ids
                    .iter()
                    .filter_map(|orig| id_map.get(orig).cloned())
                    .collect();
                let visible_connections = if visible.is_empty() {
                    None
                } else {
                    Some(visible)
                };

                ts.origins.extend(origins);

                let env_id = uuid::Uuid::new_v4().to_string();
                let name = environment.name.clone();
                let env = Environment {
                    id: env_id.clone(),
                    name: environment.name,
                    color: environment.color,
                    icon: environment.icon,
                    order: base_order + i as i32,
                    theme_id: environment.theme_id,
                    launch: LaunchState {
                        visible_connections,
                        ..LaunchState::default()
                    },
                    ..Environment::default()
                };
                imported_environments.push(ImportedEnvironment {
                    environment_id: env_id,
                    name,
                    origin_ids,
                });
                ts.environments.push(env);
            }
            Ok(imported_environments)
        })?;

        Ok(EnvironmentImportResult {
            environments: imported_environments,
            profiles: profile_result,
            json_schemas: schema_result,
        })
    })
    .await
    .map_err(|e| AppError::Transfer(format!("environment import task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_profile_ids_covers_every_slot_that_can_name_a_connection() {
        let mut env = Environment::default();
        env.connections
            .insert("from-tabs".into(), ConnectionTabState::default());
        env.launch.active_connections = vec!["from-active".into()];
        env.launch.selected_connection_id = Some("from-selected".into());
        env.launch.visible_connections = Some(vec!["from-visible".into()]);
        env.launch
            .database_visibility
            .insert("from-db-visibility".into(), None);

        let ids = referenced_profile_ids(&env);
        for expected in [
            "from-tabs",
            "from-active",
            "from-selected",
            "from-visible",
            "from-db-visibility",
        ] {
            assert!(ids.contains(expected), "missing {expected}");
        }
        assert_eq!(ids.len(), 5);
    }

    #[test]
    fn referenced_profile_ids_is_empty_for_a_fresh_environment() {
        assert!(referenced_profile_ids(&Environment::default()).is_empty());
    }

    #[test]
    fn apply_launch_state_writes_straight_through_for_an_ordinary_environment() {
        let mut env = Environment::default();
        apply_launch_state(
            &mut env,
            LaunchState {
                visible_connections: Some(vec!["c1".into()]),
                ..LaunchState::default()
            },
        );
        assert_eq!(env.launch.visible_connections, Some(vec!["c1".into()]));
        assert!(
            env.local_visible_connections.is_none(),
            "no origin to shadow, so there is nothing to override"
        );
    }

    #[test]
    fn apply_launch_state_diverts_visibility_into_the_override_for_a_mirrored_environment() {
        let mut env = Environment {
            origin_id: Some("origin-1".into()),
            launch: LaunchState {
                visible_connections: Some(vec!["c1".into(), "c2".into()]),
                ..LaunchState::default()
            },
            ..Environment::default()
        };

        // The user hides `c2`.
        apply_launch_state(
            &mut env,
            LaunchState {
                visible_connections: Some(vec!["c1".into()]),
                ..LaunchState::default()
            },
        );

        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["c1".into(), "c2".into()]),
            "the true membership is left exactly as the last sync wrote it"
        );
        assert_eq!(
            env.local_visible_connections,
            Some(vec!["c1".into()]),
            "the hide/show choice lands in the override instead"
        );
        assert_eq!(env.effective_visible_connections(), Some(vec!["c1".into()]));
    }

    #[test]
    fn apply_launch_state_clears_the_override_when_the_user_shows_everything_again() {
        let mut env = Environment {
            origin_id: Some("origin-1".into()),
            launch: LaunchState {
                visible_connections: Some(vec!["c1".into(), "c2".into()]),
                ..LaunchState::default()
            },
            local_visible_connections: Some(vec!["c1".into()]),
            ..Environment::default()
        };

        apply_launch_state(
            &mut env,
            LaunchState {
                visible_connections: None,
                ..LaunchState::default()
            },
        );

        assert!(env.local_visible_connections.is_none());
        assert_eq!(
            env.effective_visible_connections(),
            Some(vec!["c1".into(), "c2".into()]),
            "falls back to the origin's full membership, i.e. \"show all\""
        );
    }

    #[test]
    fn environments_referencing_finds_only_the_environments_that_hold_the_id() {
        let mut a = Environment {
            id: "env-a".into(),
            ..Default::default()
        };
        a.launch.active_connections = vec!["conn-1".into()];

        let mut b = Environment {
            id: "env-b".into(),
            ..Default::default()
        };
        b.launch.selected_connection_id = Some("conn-2".into());

        let c = Environment {
            id: "env-c".into(),
            ..Default::default()
        };
        // Doesn't reference either connection.

        let environments = vec![a, b, c];
        assert_eq!(
            environments_referencing(&environments, "conn-1"),
            vec!["env-a".to_string()]
        );
        assert_eq!(
            environments_referencing(&environments, "conn-2"),
            vec!["env-b".to_string()]
        );
        assert!(environments_referencing(&environments, "conn-missing").is_empty());
    }

    #[test]
    fn environments_referencing_can_return_more_than_one_environment() {
        let mut a = Environment {
            id: "env-a".into(),
            ..Default::default()
        };
        a.launch.active_connections = vec!["shared".into()];

        let mut b = Environment {
            id: "env-b".into(),
            ..Default::default()
        };
        b.launch.visible_connections = Some(vec!["shared".into()]);

        let environments = vec![a, b];
        let mut found = environments_referencing(&environments, "shared");
        found.sort();
        assert_eq!(found, vec!["env-a".to_string(), "env-b".to_string()]);
    }
}
