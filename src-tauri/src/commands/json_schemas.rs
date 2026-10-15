//! Command surface for the JSON Schema library and its per-column bindings.
//!
//! Thin, like every module here: validate, take state, delegate to
//! [`crate::json_schemas`], persist outside the lock, broadcast.
//!
//! # Per-item writes, never a whole-blob save
//!
//! Every mutator below touches one record. That is deliberate and it is the one
//! design decision worth defending: `update_preferences` sends the *entire*
//! `Preferences` blob, which is exactly why two windows editing different
//! settings used to lose one of the changes (issue #18, see
//! `src/lib/bridges/prefs-sync-bridge.ts`). Reproducing that shape here would
//! mean two windows editing two different schemas silently clobbering each
//! other. The pattern followed instead is `save_profile`'s: upsert by id, save,
//! emit.
//!
//! # Resolution granularity
//!
//! [`resolve_json_schemas_for_columns`] answers for a whole relation in one
//! call — the caller makes it once per data tab, not once per cell — and
//! [`resolve_json_schema`] answers for a single column, which is what the
//! MongoDB document view needs, since a nested field path is not known until the
//! user expands it (ADR #29).
//!
//! # Why the resolver is not mirrored in TypeScript
//!
//! It would be the second implementation of one grammar, which ADRs #30/#33
//! exist to prevent — and here the drift would be especially nasty, because a
//! resolution bug is not an error, it is "the autocompletion did not appear",
//! which nobody reports. Rust is also where it can be tested (`cargo test`);
//! there is no frontend test runner in this repo at all.

use crate::error::{AppError, AppResult};
use crate::json_schemas::{
    self, import as schema_import, JsonSchemaBinding, JsonSchemaItem, JsonSchemaLibrary,
    JsonSchemaMatch, JsonSchemaSource, ResolveTarget, ResolvedJsonSchema,
};
use crate::state::AppState;
use crate::transfer::{
    ConflictAction, ConflictResolution, JsonSchemaExportFile, JsonSchemaImportAnalysis,
    JsonSchemaImportResult, KIND_JSON_SCHEMAS,
};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Broadcast (unscoped — every window) after any mutation of the library.
///
/// Global `emit` rather than `emit_to`, and the frontend bridge listens **without
/// a `target`** on purpose. That looks like the cross-window leak gotcha #25
/// warns about, and it is the deliberate opposite: `json_schemas.json` is one
/// global file shared by every window, so every window's cached resolutions go
/// stale together and all of them must invalidate. Do not "fix" this by scoping
/// it, or a schema edited in one window will silently not apply in another.
///
/// The payload is `()`, not the library: broadcasting several hundred KB of
/// schema bodies on every keystroke-debounced save is precisely the cost this
/// feature avoided by staying out of `prefs.json`.
pub const JSON_SCHEMAS_CHANGED_EVENT: &str = "huginndb://json-schemas-changed";

/// Persist a snapshot and tell every window. Callers clone the library inside
/// their lock scope and pass it here after dropping the guard.
fn commit(app: &AppHandle, snapshot: &JsonSchemaLibrary) -> AppResult<()> {
    json_schemas::save_library(snapshot)?;
    let _ = app.emit(JSON_SCHEMAS_CHANGED_EVENT, ());
    Ok(())
}

/// Build a [`ResolveTarget`], folding a synthetic `<parent>::db::<db>` id down
/// to its parent profile id.
///
/// Every resolution command routes through here so the fold happens in exactly
/// one place. Forgetting it means a binding never matches on a server-wide
/// connection — silently, and precisely on the "one shared configuration server"
/// setup this feature exists for (ADRs #32/#36).
fn target<'a>(
    connection_id: Option<&'a String>,
    db_schema: Option<&'a String>,
    table: Option<&'a String>,
    column: &'a str,
) -> ResolveTarget<'a> {
    ResolveTarget {
        connection_id: connection_id
            .map(|id| crate::commands::connection::parent_connection_id(id.as_str())),
        db_schema: db_schema.map(String::as_str),
        table: table.map(String::as_str),
        column,
    }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/// Return the whole library: schemas and bindings.
///
/// Bindings come back sorted by `order` so the Settings table can render them in
/// a stable sequence without re-deriving anything.
#[tauri::command]
pub fn list_json_schemas(state: State<'_, AppState>) -> AppResult<JsonSchemaLibrary> {
    Ok(state.json_schemas.read().clone())
}

// ---------------------------------------------------------------------------
// Schema CRUD
// ---------------------------------------------------------------------------

/// Create or update one schema.
///
/// The payload is a set of discrete arguments rather than a whole
/// [`JsonSchemaItem`], mirroring `save_environment`: a form round-tripping the
/// full struct would let the frontend overwrite `created_at` and `origin_id`,
/// which it has no business setting. Same class of bug as gotcha #14, arriving
/// from the other direction.
#[tauri::command]
pub fn save_json_schema(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    description: Option<String>,
    body: String,
    source: Option<JsonSchemaSource>,
) -> AppResult<JsonSchemaItem> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::InvalidInput("a schema needs a name".into()));
    }
    json_schemas::validate_body(&body)?;

    let now = chrono::Utc::now().to_rfc3339();
    let (item, snapshot) = {
        let mut lib = state.json_schemas.write();
        let existing = id
            .as_deref()
            .and_then(|wanted| lib.schemas.iter_mut().find(|s| s.id == wanted));
        let item = match existing {
            Some(slot) => {
                slot.name = name;
                slot.description = description;
                slot.body = body;
                slot.updated_at = now;
                slot.clone()
            }
            None => {
                let fresh = JsonSchemaItem {
                    id: Uuid::new_v4().to_string(),
                    name,
                    description,
                    body,
                    created_at: now.clone(),
                    updated_at: now,
                    source: source.unwrap_or_default(),
                    origin_id: None,
                };
                lib.schemas.push(fresh.clone());
                fresh
            }
        };
        (item, lib.clone())
    };
    commit(&app, &snapshot)?;
    Ok(item)
}

/// Delete a schema and every binding that points at it.
///
/// Returns how many bindings went, so the UI can say so. The confirmation
/// itself is the frontend's (`confirmIrreversible`): a body exists nowhere else
/// and cannot be reconstructed from the database.
#[tauri::command]
pub fn delete_json_schema(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<usize> {
    let (dropped, snapshot) = {
        let mut lib = state.json_schemas.write();
        let dropped = json_schemas::sweep_schema(&mut lib, &id);
        (dropped, lib.clone())
    };
    commit(&app, &snapshot)?;
    Ok(dropped)
}

// ---------------------------------------------------------------------------
// Binding CRUD
// ---------------------------------------------------------------------------

/// Create or update one binding.
///
/// Here the full struct *is* the right payload: every field is the user's to
/// set. An empty `id` means "create". Validation and wildcard canonicalisation
/// happen in [`json_schemas::normalise_binding`].
#[tauri::command]
pub fn save_json_schema_binding(
    app: AppHandle,
    state: State<'_, AppState>,
    binding: JsonSchemaBinding,
) -> AppResult<JsonSchemaBinding> {
    let mut incoming = binding;
    json_schemas::normalise_binding(&mut incoming)?;

    let (stored, snapshot) = {
        let mut lib = state.json_schemas.write();
        if !lib.schemas.iter().any(|s| s.id == incoming.schema_id) {
            return Err(AppError::NotFound(format!(
                "no schema with id {}",
                incoming.schema_id
            )));
        }
        let stored = match lib.bindings.iter_mut().find(|b| b.id == incoming.id) {
            Some(slot) if !incoming.id.is_empty() => {
                // Preserve `order` and `origin_id`: neither is the form's to set.
                incoming.order = slot.order;
                incoming.origin_id = slot.origin_id.clone();
                *slot = incoming;
                slot.clone()
            }
            _ => {
                incoming.id = Uuid::new_v4().to_string();
                incoming.order = json_schemas::next_order(&lib);
                incoming.origin_id = None;
                lib.bindings.push(incoming.clone());
                incoming
            }
        };
        (stored, lib.clone())
    };
    commit(&app, &snapshot)?;
    Ok(stored)
}

/// Remove one binding. No confirmation: the schema survives and the rule is one
/// dropdown click to recreate.
#[tauri::command]
pub fn delete_json_schema_binding(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let snapshot = {
        let mut lib = state.json_schemas.write();
        lib.bindings.retain(|b| b.id != id);
        lib.clone()
    };
    commit(&app, &snapshot)
}

/// Reassign binding `order` to match `ids`. Mirrors `reorder_environments`, and
/// matters because `order` is the documented tie-break of the cascade.
#[tauri::command]
pub fn reorder_json_schema_bindings(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<()> {
    let snapshot = {
        let mut lib = state.json_schemas.write();
        json_schemas::reorder_bindings(&mut lib, &ids);
        lib.clone()
    };
    commit(&app, &snapshot)
}

/// Move literal bindings from `from` to `to` after a column rename.
///
/// Called by the structure editor **after** a successful apply, best-effort: the
/// DDL has already run, so a failure here is a toast, never a rollback.
#[tauri::command]
pub fn rename_json_schema_binding_column(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: Option<String>,
    db_schema: Option<String>,
    table: Option<String>,
    from: String,
    to: String,
) -> AppResult<usize> {
    let parent = connection_id
        .as_deref()
        .map(crate::commands::connection::parent_connection_id);
    let (moved, snapshot) = {
        let mut lib = state.json_schemas.write();
        let moved = json_schemas::rename_column(
            &mut lib,
            parent,
            db_schema.as_deref(),
            table.as_deref(),
            &from,
            &to,
        );
        (moved, lib.clone())
    };
    if moved > 0 {
        commit(&app, &snapshot)?;
    }
    Ok(moved)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// Resolve every column of one relation in a single call.
///
/// Only the columns that matched come back, so the caller can build its lookup
/// map straight from the result.
#[tauri::command]
pub fn resolve_json_schemas_for_columns(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    db_schema: Option<String>,
    table: Option<String>,
    columns: Vec<String>,
) -> AppResult<Vec<ResolvedJsonSchema>> {
    let lib = state.json_schemas.read();
    Ok(columns
        .iter()
        .filter_map(|column| {
            let t = target(
                connection_id.as_ref(),
                db_schema.as_ref(),
                table.as_ref(),
                column,
            );
            json_schemas::resolve_one(&lib, &t).map(|r| json_schemas::to_resolved(&r, column))
        })
        .collect())
}

/// Resolve one column — the MongoDB dotted-path case, and the Settings
/// "test a column" box.
#[tauri::command]
pub fn resolve_json_schema(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    db_schema: Option<String>,
    table: Option<String>,
    column: String,
) -> AppResult<Option<ResolvedJsonSchema>> {
    let lib = state.json_schemas.read();
    let t = target(
        connection_id.as_ref(),
        db_schema.as_ref(),
        table.as_ref(),
        &column,
    );
    Ok(json_schemas::resolve_one(&lib, &t).map(|r| json_schemas::to_resolved(&r, &column)))
}

/// The full ranked cascade for one column.
///
/// Answers "why is *this* schema applying?" — and, just as often, "why is my
/// rule not applying?", which is the support question this feature will
/// generate most. Nearly free: the resolver already builds the whole list.
#[tauri::command]
pub fn explain_json_schema_bindings(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    db_schema: Option<String>,
    table: Option<String>,
    column: String,
) -> AppResult<Vec<JsonSchemaMatch>> {
    let lib = state.json_schemas.read();
    let t = target(
        connection_id.as_ref(),
        db_schema.as_ref(),
        table.as_ref(),
        &column,
    );
    Ok(json_schemas::explain(&lib, &t))
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/// Draft a schema from sample values.
///
/// `values` are raw JSON documents the caller pulled from the rows it already
/// has in memory, so nothing is re-queried. See [`json_schemas::infer`] for the
/// rules and for why they live in Rust.
#[tauri::command]
pub fn infer_json_schema(
    values: Vec<serde_json::Value>,
    closed_objects: Option<bool>,
) -> AppResult<json_schemas::infer::InferResult> {
    let opts = json_schemas::infer::InferOptions {
        closed_objects: closed_objects.unwrap_or(false),
        ..Default::default()
    };
    Ok(json_schemas::infer::infer_schema(&values, opts))
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/// Write the selected schemas (and optionally their bindings) to a file the user
/// picks. Returns the path written.
///
/// No passphrase and no encryption: a JSON Schema carries no secret and no
/// keychain material, so there is nothing here for one to protect.
#[tauri::command]
pub async fn export_json_schemas(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    include_bindings: Option<bool>,
) -> AppResult<String> {
    if ids.is_empty() {
        return Err(AppError::InvalidInput(
            "select at least one schema to export".into(),
        ));
    }
    let bundle = {
        let lib = state.json_schemas.read();
        schema_import::collect_bundle(&lib, &ids, include_bindings.unwrap_or(true))
    };
    if bundle.schemas.is_empty() {
        return Err(AppError::NotFound(
            "none of the selected schemas exist".into(),
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let file = JsonSchemaExportFile {
        meta: crate::transfer::metadata(KIND_JSON_SCHEMAS, false, &now),
        bundle,
    };

    let date_part = now.get(..10).unwrap_or("export");
    crate::transfer::save_export(
        &app,
        "Export JSON Schemas",
        &format!("huginndb-json-schemas-{date_part}.json"),
        &serde_json::to_string_pretty(&file)?,
    )
}

/// Parse a schema export without touching any state, so the wizard can show
/// conflicts (and the disabled-binding count) before committing.
#[tauri::command]
pub fn analyze_json_schema_import(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<JsonSchemaImportAnalysis> {
    let (export, _) = read_schema_export(&file_path)?;
    let known = known_profile_ids(&state);
    let remap = schema_import::ConnectionRemap::LocalOnly(&known);

    let lib = state.json_schemas.read();
    Ok(JsonSchemaImportAnalysis {
        total_schemas: export.bundle.schemas.len(),
        total_bindings: export.bundle.bindings.len(),
        conflicts: schema_import::detect_conflicts(&lib.schemas, &export.bundle.schemas),
        bindings_unresolvable: schema_import::count_unresolvable(&export.bundle, &remap),
    })
}

/// Merge a schema export into the library.
#[tauri::command]
pub fn import_json_schemas(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<JsonSchemaImportResult> {
    let (export, _) = read_schema_export(&file_path)?;
    let resolution_map: HashMap<String, ConflictAction> = conflict_resolutions
        .into_iter()
        .map(|r| (r.id, r.action))
        .collect();
    let known = known_profile_ids(&state);
    let now = chrono::Utc::now().to_rfc3339();

    let (result, snapshot) = {
        let mut lib = state.json_schemas.write();
        let result = schema_import::apply_imports(
            &mut lib,
            export.bundle,
            &resolution_map,
            &schema_import::ConnectionRemap::LocalOnly(&known),
            &now,
        );
        (result, lib.clone())
    };
    commit(&app, &snapshot)?;
    Ok(result)
}

/// Read and validate a standalone schema export.
///
/// The `kind` check is strict, so pointing this at a profile bundle fails with a
/// clear message rather than importing nothing and reporting success — the same
/// courtesy `import_profiles` and `import_environment` already extend.
fn read_schema_export(file_path: &str) -> AppResult<(JsonSchemaExportFile, ())> {
    let data = std::fs::read_to_string(file_path)?;
    let export: JsonSchemaExportFile = serde_json::from_str(&data)?;
    crate::transfer::check_meta(&export.meta, KIND_JSON_SCHEMAS)?;
    Ok((export, ()))
}

/// Profile ids present on this machine — what decides whether an imported
/// binding keeps its connection or lands disabled.
fn known_profile_ids(state: &State<'_, AppState>) -> HashSet<String> {
    state.profiles.read().iter().map(|p| p.id.clone()).collect()
}
