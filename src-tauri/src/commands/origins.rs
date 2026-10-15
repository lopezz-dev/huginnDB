//! Shared connection origins (#108).
//!
//! An origin is a **file** on a path the OS already mounts — a UNC share, a
//! mapped drive, a synced folder — in the format `export_profiles` writes
//! (`crate::transfer` v1). One person curates it; everyone else pulls from it.
//! There is no protocol and no service here: reading one is `std::fs::read`, and
//! the share's ACL is the actual access control.
//!
//! This module owns the origin *registry* (add / rename / remove), the
//! keychain handling for an encrypted origin's passphrase, and the pull
//! itself ([`sync_origin`]).
//!
//! ## Why the registry is global, not scoped to an environment
//!
//! An origin describes a *server-side* resource — a file on a share — not a
//! Producción/Staging axis, and what it produces (`profiles.json` entries,
//! and whole mirrored environments) is already global. Scoping the
//! registration itself to one environment reproduced the `visible_databases`
//! bug (ADR #27) one level up: the same physical file needed a
//! second, independent registration to be seen from a second environment, and
//! deleting whichever environment happened to hold the registration silently
//! orphaned every connection it had ever imported, with no notice raised at
//! all — worse than removing the origin on purpose, which at least tells the
//! frontend (`useOriginSync.noticeOriginRemoved`). `tab_state.json` v5 moved
//! `origins` to [`crate::tab_state::PersistedTabState`] for exactly this
//! reason; see that module's history for the migration.
//!
//! ## Why the passphrase goes in the keychain
//!
//! An encrypted export needs its passphrase on every pull, including the
//! unattended one at launch. Storing it in `tab_state.json` would put a secret
//! that decrypts a whole set of database passwords into a plaintext file that is
//! also, by design, the most-frequently-rewritten state we have — the exact
//! thing `profiles.json` avoids. It goes to the OS keychain under the same
//! service as connection passwords, keyed by origin id.
//!
//! Worth being explicit about the threat model, because the encryption invites
//! more confidence than it earns: read access to the share **plus** the
//! passphrase yields every password in the file. The passphrase travels
//! out-of-band (the admin tells the new hire), so the share's ACL is the real
//! perimeter. See `SECURITY.md`.

use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::state::{ActiveConnections, AppState, ConnectionProfile, Driver, SecretOverride};
use crate::tab_state::{self, Environment, LaunchState, Origin, OriginScope};
use crate::transfer::{
    EnvironmentExportFile, ExportMetadata, ExportedEnvironmentBundle, ExportedProfile,
    KIND_ENVIRONMENT,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Keychain account for an origin's passphrase.
///
/// Namespaced with an `origin::` prefix so it can never collide with a
/// connection's account, which is `<profile-id>::<username>`. A profile id is a
/// UUID, so the prefix is what keeps the two spaces disjoint by construction
/// rather than by luck.
pub(crate) fn passphrase_account(origin_id: &str) -> String {
    format!("origin::{origin_id}")
}

/// Emitted whenever the origin registry changes: one was added, renamed,
/// repointed, removed, or synced (which stamps `last_synced_at`).
///
/// Broadcast with an unscoped `emit`, and the frontend listens **without a
/// `target`**, which looks like gotcha #25's cross-window leak and is its
/// deliberate opposite — same reasoning as
/// [`crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT`]. The registry
/// is one global list in `tab_state.json`; a rename in the Settings window must
/// reach the connection manager in the main window, and every window's cached
/// id-to-name map goes stale at the same instant. Scoping it would leave one
/// window rendering a name that no longer exists.
///
/// The payload is `()`: listeners re-run `list_origins`, which is a clone of a
/// short `Vec`, and shipping the list would put `landed_secrets` fingerprints on
/// an event bus for no reason.
pub const ORIGINS_CHANGED_EVENT: &str = "huginndb://origins-changed";

/// Every registered origin, global across all environments, in insertion
/// order.
#[tauri::command]
pub fn list_origins(state: State<'_, AppState>) -> AppResult<Vec<Origin>> {
    Ok(state.tab_state.read().origins.clone())
}

/// Register a shared origin.
///
/// The path is **not** validated here beyond being non-empty. A share can be
/// legitimately unreachable at the moment it is configured — VPN down, laptop
/// off the corporate network — and refusing to save it then would force the user
/// to re-enter it later. Reachability is the sync's problem, where a failure has
/// somewhere sensible to be reported.
///
/// `passphrase` is stored in the keychain when the file is encrypted; pass
/// `None` for a plaintext export. It is never written to `tab_state.json`.
///
/// `scope` says which slices of the document to pull; `None` means all three,
/// which is both the historical behaviour and the sensible default for
/// somebody who has just pointed at a file and does not yet know what is in
/// it. Narrowing it later is `update_origin`, and narrowing it never deletes
/// what an earlier, wider scope already landed.
#[tauri::command]
pub fn add_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
    scope: Option<OriginScope>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    let origin = Origin {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        last_synced_at: None,
        landed_secrets: HashMap::new(),
        // A newly registered origin is always a consumer. Publishing is a
        // separate, confirmed decision (`commands::origin_doc`) — pointing at
        // a file must never be what grants write access to it.
        role: tab_state::OriginRole::Consumer,
        maintainer: None,
        scope: scope.unwrap_or_default(),
    };

    // Keychain first: a failure here must not leave a registered origin whose
    // passphrase silently went nowhere, since the next sync would then report a
    // decryption error the user has no way to connect to this moment.
    if let Some(secret) = passphrase.as_deref().filter(|s| !s.is_empty()) {
        keychain::set_password(&passphrase_account(&origin.id), secret)?;
    }

    let created = origin.clone();
    tab_state::mutate(&state.tab_state, |ts| {
        ts.origins.push(origin);
        Ok(())
    })?;
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(created)
}

/// Rename an origin, repoint it at a different file, and/or replace its stored
/// passphrase.
///
/// `passphrase` is tri-state on purpose: `None` leaves whatever is in the
/// keychain untouched (so a plain rename does not require the user to retype a
/// secret they already stored), while `Some("")` clears it — which is how an
/// origin that used to be encrypted becomes a plaintext one.
///
/// `role` is `None`-means-unchanged for the same reason. Switching it to
/// [`tab_state::OriginRole::Publisher`] is what lets this machine write the
/// file at all (`commands::origin_doc`), so it is a deliberate, reversible act
/// the UI confirms — never a side effect of a rename.
///
/// `scope` likewise. Narrowing one is **non-destructive on purpose**: what a
/// wider scope already landed stays exactly where it is, still tagged with
/// this origin, and simply stops being refreshed. Detaching those profiles and
/// environments into local ones is a separate, explicit act, because it cannot
/// be undone in either direction — [`merge_into`] skips a profile whose
/// `origin_id` no longer names this origin (it is the user's by then, not the
/// file's), and `sync_environment_bundles` would mirror a *second* copy of an
/// environment whose `origin_source_id` was cleared. A checkbox must not be
/// able to reach either outcome.
// A Tauri command's parameters *are* its wire shape — the frontend passes them
// by name — so the count here is the IPC contract, not a signature that wants a
// struct. Same reason `save_origin_document` next door carries the allow.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn update_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    path: String,
    passphrase: Option<String>,
    role: Option<tab_state::OriginRole>,
    scope: Option<OriginScope>,
) -> AppResult<Origin> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    match passphrase.as_deref() {
        Some("") => keychain::delete_password(&passphrase_account(&id))?,
        Some(secret) => keychain::set_password(&passphrase_account(&id), secret)?,
        None => {}
    }

    let updated = tab_state::mutate(&state.tab_state, |ts| {
        let origin = ts
            .origins
            .iter_mut()
            .find(|o| o.id == id)
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?;
        origin.name = name;
        origin.path = path;
        if let Some(role) = role {
            origin.role = role;
        }
        if let Some(scope) = scope {
            origin.scope = scope;
        }
        Ok(origin.clone())
    })?;
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(updated)
}

/// Unregister an origin and forget its passphrase.
///
/// The connections it imported are deliberately **left in place**, tagged with
/// its now-dangling `origin_id`. Removing an origin says "stop pulling from
/// here", not "delete these servers": the user may well have work open against
/// one, and silently deleting a batch of connections (plus their keychain
/// entries) on a config change is not a trade anyone would choose. A dangling
/// `origin_id` is harmless — no sync resolves against it any more, and the
/// frontend can offer to release those profiles into ordinary local ones.
#[tauri::command]
pub fn remove_origin(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    tab_state::mutate(&state.tab_state, |ts| {
        let before = ts.origins.len();
        ts.origins.retain(|o| o.id != id);
        if ts.origins.len() == before {
            return Err(AppError::InvalidInput(format!("no origin with id {id}")));
        }
        Ok(())
    })?;
    // Best-effort: a missing entry is the desired end state, and failing the
    // whole command over it would leave the origin registered.
    let _ = keychain::delete_password(&passphrase_account(&id));
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(())
}

/// Keep this machine's own password for a connection a shared origin publishes.
///
/// The narrow, supported answer to "the server reset the password and the
/// person who curates the file is on holiday". Everything else about the
/// profile stays the file's — see [`crate::state::SecretOverride`] for why the
/// secret is the one field a consumer gets to win, and for when the override
/// expires.
///
/// Writes only the keychain and the one flag. Deliberately **not**
/// `save_profile` with the read-only rule relaxed: that command replaces the
/// whole record, so it would let the host, the port or the visible-database
/// set of a curated connection be changed too, and the next sync would silently
/// revert those while keeping the password — the worst of both, and impossible
/// to explain from the UI.
/// What a file at `path` would contribute, without registering or pulling it.
///
/// Takes a **path, not an origin id**: its first caller is the "add origin"
/// form, where there is no origin yet and the user is about to decide which
/// slices to subscribe to. Offering those checkboxes without saying what is in
/// the file makes the choice a guess — and the interesting case ("this file
/// only carries connections anyway") is invisible until after the first sync.
///
/// Reads and parses; touches no local state, no keychain, and no registry.
/// Every failure is an `Err` the form renders inline rather than a panic-worthy
/// condition: an unreachable share while the user is still typing a UNC path is
/// the normal case, not an exceptional one.
#[tauri::command]
pub fn peek_origin_file(path: String) -> AppResult<OriginPeek> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| AppError::InvalidInput(format!("cannot read {path:?}: {e}")))?;

    // Same two-step parse `sync_origin_inner` does, and for the same reason:
    // `serde_json` drops unknown fields, so reading an environment-kind file as
    // the plain profile shape succeeds while silently discarding its whole
    // `environments` array. The peek has to agree with the sync about what the
    // file contains or it is worse than no preview at all.
    #[derive(serde::Deserialize)]
    struct MetaPeek {
        meta: ExportMetadata,
    }
    let meta_peek: MetaPeek = serde_json::from_str(&data)
        .map_err(|e| AppError::InvalidInput(format!("{path:?} is not a HuginnDB export: {e}")))?;

    if meta_peek.meta.kind == KIND_ENVIRONMENT {
        let export: EnvironmentExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!("{path:?} is not a valid environment export: {e}"))
        })?;
        Ok(OriginPeek {
            kind: meta_peek.meta.kind,
            encrypted: meta_peek.meta.encrypted,
            maintainer: meta_peek.meta.maintainer,
            connections: export.profiles.len(),
            environments: export.environments.len(),
            schemas: export.json_schemas.schemas.len(),
            bindings: export.json_schemas.bindings.len(),
        })
    } else {
        let export: crate::transfer::ExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!("{path:?} is not a HuginnDB export: {e}"))
        })?;
        Ok(OriginPeek {
            kind: meta_peek.meta.kind,
            encrypted: meta_peek.meta.encrypted,
            maintainer: meta_peek.meta.maintainer,
            connections: export.profiles.len(),
            environments: 0,
            schemas: 0,
            bindings: 0,
        })
    }
}

/// What [`peek_origin_file`] found. Counts only — no names, no hosts, and
/// certainly no ciphertext: this renders under a path the user may have typed
/// by mistake, and a preview of somebody else's file should not be a way to
/// read it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginPeek {
    /// `meta.kind` verbatim — `"environment"`, `"profiles"`, or `""` for a file
    /// written before the discriminant existed. A `"profiles"` file can only
    /// ever contribute connections, which is what lets the form grey out the
    /// other two checkboxes instead of offering a subscription to nothing.
    pub kind: String,
    /// Whether the file carries encrypted secrets, i.e. whether a passphrase is
    /// needed — and only needed at all if connections are pulled.
    pub encrypted: bool,
    pub maintainer: Option<String>,
    pub connections: usize,
    pub environments: usize,
    pub schemas: usize,
    pub bindings: usize,
}

#[tauri::command]
pub fn set_secret_override(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionProfile> {
    let (profile, origin_id) = {
        let profiles = state.profiles.read();
        let profile = profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;
        let origin_id = profile.origin_id.clone().ok_or_else(|| {
            // A local profile has no published secret to override. Its password
            // is edited by saving it, and offering two ways to write one
            // keychain entry is how they drift.
            AppError::InvalidInput(
                "this connection does not come from a shared origin — save it normally instead"
                    .into(),
            )
        })?;
        (profile, origin_id)
    };

    let mut stored = false;
    if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
        if !matches!(profile.driver, Driver::Sqlite) {
            keychain::set_password(&profile.keyring_account(), pw)?;
            stored = true;
        }
    }
    if let (Some(account), Some(secret)) = (
        profile.ssh_keyring_account(),
        ssh_secret.as_deref().filter(|s| !s.is_empty()),
    ) {
        keychain::set_password(&account, secret)?;
        stored = true;
    }
    if !stored {
        // Nothing was written, so flagging the profile would claim an override
        // that does not exist and — worse — suppress the published secret for
        // a connection now running on whatever was already in the keychain.
        return Err(AppError::InvalidInput(
            "no password was supplied to keep".into(),
        ));
    }

    // What the origin currently has landed for this profile *is* the ciphertext
    // being overridden: `landed_secrets` records the last envelope this machine
    // actually decrypted and stored. `None` (never landed, or an origin that
    // publishes no secrets) makes the override outlive anything but the first
    // real publication, which is the right way round — there is nothing yet for
    // it to be stale against.
    let supersedes = state
        .tab_state
        .read()
        .origins
        .iter()
        .find(|o| o.id == origin_id)
        .and_then(|o| o.landed_secrets.get(&profile_id).cloned());

    let updated = {
        let mut profiles = state.profiles.write();
        let entry = profiles
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;
        entry.secret_override = Some(SecretOverride {
            supersedes,
            set_at: chrono::Utc::now().to_rfc3339(),
        });
        let updated = entry.clone();
        crate::store::save_profiles(&profiles)?;
        updated
    };
    let _ = app.emit(crate::commands::connection::PROFILES_CHANGED_EVENT, ());
    Ok(updated)
}

/// Go back to the password the origin publishes.
///
/// Clearing the flag is not enough on its own: `already_landed` skips a
/// ciphertext whose fingerprint it has already recorded, so the origin's secret
/// would never be re-landed and the connection would keep running on the local
/// password with nothing saying so. Forgetting the fingerprint too is what
/// makes the next sync actually re-derive and overwrite the keychain entry.
#[tauri::command]
pub fn clear_secret_override(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> AppResult<ConnectionProfile> {
    let (updated, origin_id) = {
        let mut profiles = state.profiles.write();
        let entry = profiles
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;
        entry.secret_override = None;
        let updated = entry.clone();
        crate::store::save_profiles(&profiles)?;
        let origin_id = updated.origin_id.clone();
        (updated, origin_id)
    };
    if let Some(origin_id) = origin_id {
        tab_state::mutate(&state.tab_state, |ts| {
            if let Some(o) = ts.origins.iter_mut().find(|o| o.id == origin_id) {
                o.landed_secrets.remove(&profile_id);
            }
            Ok(())
        })?;
    }
    let _ = app.emit(crate::commands::connection::PROFILES_CHANGED_EVENT, ());
    Ok(updated)
}

/// Pull an origin: refresh what it publishes, report what disappeared.
///
/// Three outcomes are kept strictly apart, and the separation matters more than
/// the feature does:
///
/// 1. **Unreadable or unparseable** — share offline, VPN down, or the publisher
///    mid-save without an atomic rename. Returns `Err` and touches *nothing*: no
///    profiles, no `last_synced_at`. A failed read must never be mistaken for
///    "the file now says less".
/// 2. **Read cleanly, entries missing** — reported in `vanished` for the user to
///    decide on.
/// 3. **Read cleanly but suspiciously empty** — flagged via `suspicious` so the
///    frontend withholds removal offers. See [`disappearance_is_trustworthy`].
///
/// Metadata for an existing profile is refreshed in place, except while a pool is
/// open for it: repointing host/port under a running query changes the server
/// beneath the user, so those land in `deferred` and apply on disconnect.
///
/// Never writes to the origin's path.
///
/// `async fn` with the whole body on `spawn_blocking`, and that is not a
/// stylistic choice. A synchronous `#[tauri::command]` runs on the **main
/// thread** — the one pumping the window — and this one does two things that
/// can hold it for a long time: it reads the export off a network share (a
/// slow VPN is enough), and it lands every published secret into the keychain,
/// which costs ~600 000 PBKDF2 rounds *per slot*. A shared origin publishing
/// thirty tunnelled connections therefore froze the app for as long as tens of
/// millions of SHA-256 rounds take, on every launch, with Windows painting the
/// window "Not Responding" throughout. [`already_landed`] removes almost all
/// of that work; running off the main thread is what stops whatever remains
/// from being felt as a freeze.
#[tauri::command]
pub async fn sync_origin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<OriginSyncReport> {
    let connections = state.connections.clone();
    let profiles = state.profiles.clone();
    let tab_state_lock = state.tab_state.clone();
    let schemas = state.json_schemas.clone();
    let policy = state.policy.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        sync_origin_inner(
            &connections,
            &profiles,
            &tab_state_lock,
            &schemas,
            &policy,
            &id,
        )
    })
    .await
    .map_err(|e| AppError::Transfer(format!("origin sync task failed: {e}")))?;
    // Only on success: a failed pull writes nothing, `last_synced_at` included,
    // so there is no registry change to announce (outcome 1 in the doc above).
    // The emit stays out of `sync_origin_inner` so that body needs no
    // `AppHandle` and stays callable off the main thread.
    if let Ok(r) = &report {
        let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
        // The library's own event, so every window drops its cached
        // resolutions — the same broadcast a local edit raises. Only when the
        // pull actually touched something: a no-op sync must not invalidate
        // every open data tab's schema cache four times a day.
        if r.touched_json_schemas() {
            let _ = app.emit(
                crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
                (),
            );
        }
    }
    report
}

/// The body of [`sync_origin`], off the main thread. Takes the three locks it
/// needs rather than `AppState`, mirroring `import_environment`.
fn sync_origin_inner(
    connections: &Arc<RwLock<ActiveConnections>>,
    profiles_lock: &Arc<RwLock<Vec<ConnectionProfile>>>,
    tab_state_lock: &Arc<RwLock<tab_state::PersistedTabState>>,
    schemas_lock: &Arc<RwLock<crate::json_schemas::JsonSchemaLibrary>>,
    policy: &crate::policy::SharedPolicy,
    id: &str,
) -> AppResult<OriginSyncReport> {
    let origin = {
        let guard = tab_state_lock.read();
        guard
            .origins
            .iter()
            .find(|o| o.id == id)
            .cloned()
            .ok_or_else(|| AppError::InvalidInput(format!("no origin with id {id}")))?
    };

    // State 1. Any failure here returns early, before a single profile is
    // touched.
    let data = std::fs::read_to_string(&origin.path).map_err(|e| {
        AppError::InvalidInput(format!("cannot read origin {:?}: {e}", origin.path))
    })?;

    // Peek `meta.kind` before committing to a shape. This used to always
    // assume a plain `ExportFile`, which — since `serde_json` silently drops
    // unknown fields — parsed a `kind = "environment"` file just fine while
    // quietly ignoring its whole `environments` array. Now the file's own
    // declared kind decides which shape it's read as.
    #[derive(serde::Deserialize)]
    struct MetaPeek {
        meta: ExportMetadata,
    }
    let meta_peek: MetaPeek = serde_json::from_str(&data).map_err(|e| {
        AppError::InvalidInput(format!(
            "origin {:?} is not a HuginnDB export: {e}",
            origin.path
        ))
    })?;

    // Both the lookup and the refusal are gated on the connections slice.
    // `meta.encrypted` describes the `profiles` section and nothing else — it
    // is recomputed in `build_origin_file` from the secret slots actually
    // written — so an origin narrowed to environments or schemas has no use
    // for a passphrase, and demanding one would block a pull that never needs
    // to decrypt anything.
    let passphrase = if origin.scope.connections {
        let stored = keychain::get_password(&passphrase_account(id))?;
        if meta_peek.meta.encrypted && stored.is_none() {
            return Err(AppError::InvalidInput(
                "this origin is encrypted but no passphrase is stored for it".into(),
            ));
        }
        stored
    } else {
        None
    };

    let is_environment_kind = meta_peek.meta.kind == KIND_ENVIRONMENT;
    let (incoming_profiles, environment_bundles, json_schemas): (
        Vec<ExportedProfile>,
        Vec<ExportedEnvironmentBundle>,
        crate::transfer::JsonSchemaBundle,
    ) = if is_environment_kind {
        let export: EnvironmentExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!(
                "origin {:?} is not a valid environment export: {e}",
                origin.path
            ))
        })?;
        (export.profiles, export.environments, export.json_schemas)
    } else {
        let export: crate::transfer::ExportFile = serde_json::from_str(&data).map_err(|e| {
            AppError::InvalidInput(format!(
                "origin {:?} is not a HuginnDB export: {e}",
                origin.path
            ))
        })?;
        (
            export.profiles,
            Vec::new(),
            crate::transfer::JsonSchemaBundle::default(),
        )
    };
    let maintainer = meta_peek.meta.maintainer.clone();

    // Carried in and back out so the expensive keychain landing can recognise
    // ciphertext it has already dealt with; see `already_landed`.
    let mut landed = origin.landed_secrets.clone();
    let mut report = if origin.scope.connections {
        merge_profiles_bundle(
            connections,
            profiles_lock,
            policy,
            id,
            passphrase.as_deref(),
            &incoming_profiles,
            &mut landed,
        )?
    } else {
        // Not an empty merge — no merge. Nothing this origin previously landed
        // is touched, `landed_secrets` is carried through untouched below, and
        // every count in the report stays zero because nothing was read, which
        // is what `pulled` exists to distinguish from "read, found nothing".
        OriginSyncReport::default()
    };
    report.pulled = origin.scope;
    report.synced_at = chrono::Utc::now().to_rfc3339();

    // After the profiles, never before: a binding is disabled when it names a
    // connection this machine does not have, and the connections this very pull
    // just landed have to count as had.
    if origin.scope.schemas && !json_schemas.is_empty() {
        let known: std::collections::HashSet<String> =
            profiles_lock.read().iter().map(|p| p.id.clone()).collect();
        let mut lib = schemas_lock.write();
        let merged = crate::json_schemas::origin::merge_origin_bundle(
            &mut lib,
            id,
            &json_schemas,
            &known,
            &report.synced_at,
        );
        crate::json_schemas::save_library(&lib)?;
        report.schemas_added = merged.schemas_added;
        report.schemas_updated = merged.schemas_updated;
        report.schemas_vanished = merged.schemas_vanished;
        report.bindings_added = merged.bindings_added;
        report.bindings_updated = merged.bindings_updated;
        report.bindings_vanished = merged.bindings_vanished;
        report.bindings_disabled = merged.bindings_disabled;
    }

    tab_state::mutate(tab_state_lock, |ts| {
        // Run this whenever the file is environment-kind, even with zero
        // bundles: an origin that used to publish environments and now
        // publishes none must still get its previously-mirrored environments
        // reported vanished, not silently skipped. Gating on the file's kind
        // rather than on `environment_bundles` being non-empty is what makes
        // that degenerate case behave the same as an ordinary disappearance.
        // The scope is checked alongside the file's kind, not inside
        // `sync_environment_bundles`: that function's whole contract is
        // "reconcile these bundles against what this origin owns", and a
        // narrowed scope means there is nothing to reconcile *against* — the
        // mirrored environments are still this origin's, they are simply not
        // being refreshed. Letting it run with the scope off would hand it an
        // authoritative-looking empty list and report the user's environments
        // as vanished, which is the exact failure the default in
        // `OriginScope`'s doc is written to prevent.
        if is_environment_kind && origin.scope.environments {
            let (added, updated, vanished, suspicious) =
                sync_environment_bundles(ts, id, &environment_bundles);
            report.environments_added = added;
            report.environments_updated = updated;
            report.environments_vanished = vanished;
            report.environments_suspicious = suspicious;
        }
        if let Some(o) = ts.origins.iter_mut().find(|o| o.id == id) {
            o.last_synced_at = Some(report.synced_at.clone());
            o.landed_secrets = std::mem::take(&mut landed);
            // Cached so the Settings list can say who curates the file without
            // reading a path that may be behind a VPN. Display only — it grants
            // nothing, and the role beside it is this machine's own decision.
            o.maintainer = maintainer.clone();
        }
        Ok(())
    })?;
    Ok(report)
}

/// Has this machine already decrypted exactly this ciphertext for
/// `profile_id`, and does every keychain account it covers still hold a value?
///
/// Both halves are needed. The fingerprint alone would let a keychain entry the
/// user (or another tool) deleted stay missing forever, since the published
/// blob never changes; the presence check alone would never notice a rotated
/// password, since the old entry is still there. Together they skip exactly the
/// case that dominates every launch — an origin file that has not changed since
/// the last sync — and nothing else.
///
/// `present` is injected so the decision is testable without a keychain.
fn already_landed(
    landed: &HashMap<String, String>,
    profile_id: &str,
    fingerprint: &str,
    accounts: &[String],
    present: impl Fn(&str) -> bool,
) -> bool {
    landed.get(profile_id).map(String::as_str) == Some(fingerprint)
        && accounts.iter().all(|a| present(a))
}

/// Does this machine's own password still win against the ciphertext just read?
///
/// The whole expiry rule for [`crate::state::SecretOverride`], in one place so
/// that "when does a local password stop applying" has exactly one answer. It
/// holds while the origin keeps publishing the *same* envelope the user took
/// over from, and stops the moment a different one arrives — the publisher has
/// by then answered the question the override was standing in for.
///
/// `supersedes: None` (an override raised when the origin had landed nothing
/// for this connection) therefore never wins against a real ciphertext, which
/// is the right way round: there was nothing for it to be newer than.
fn override_still_stands(supersedes: Option<&String>, fingerprint: &str) -> bool {
    supersedes.map(String::as_str) == Some(fingerprint)
}

/// Apply one origin's published list to `profiles` in memory, returning what
/// changed. No I/O whatsoever: no disk, no keychain.
///
/// Split out of [`merge_profiles_bundle`] so the merge *rules* — ownership,
/// deferral while a pool is live, vanished detection, which fields a refresh may
/// overwrite — are testable without writing the real `profiles.json`. They were
/// not, and the first test written against the combined function silently
/// clobbered the developer's own saved connections. A rule this fiddly needs
/// tests; tests this cheap must not need a disk.
///
/// `live` is the set of connection ids with an open pool, passed in for the same
/// reason.
///
/// `pub(crate)` for a second caller with the same motivation: the shared-origin
/// editor's publish preview (`crate::origin_doc::publish_impact`) simulates a
/// consumer's next sync by running this against a pool built from the file it is
/// about to overwrite. Re-deriving the rules there would make the preview
/// confidently describe something other than what happens.
pub(crate) fn merge_into(
    profiles: &mut Vec<ConnectionProfile>,
    origin_id: &str,
    incoming: &[ExportedProfile],
    live: &[String],
) -> OriginSyncReport {
    let incoming_ids: std::collections::HashSet<&str> =
        incoming.iter().map(|p| p.profile.id.as_str()).collect();
    let mut report = OriginSyncReport::default();

    // Local profiles this origin owns, before the merge — the denominator for
    // the suspicion check.
    let owned: Vec<String> = profiles
        .iter()
        .filter(|p| p.origin_id.as_deref() == Some(origin_id))
        .map(|p| p.id.clone())
        .collect();
    report.vanished = owned
        .iter()
        .filter(|pid| !incoming_ids.contains(pid.as_str()))
        .cloned()
        .collect();
    report.suspicious = !disappearance_is_trustworthy(owned.len(), report.vanished.len());
    if report.suspicious {
        // Say nothing actionable about a read we don't trust.
        report.vanished.clear();
    }

    for entry in incoming {
        let mut profile = entry.profile.clone();
        profile.origin_id = Some(origin_id.to_string());
        // An origin never publishes session-only profiles.
        profile.ephemeral = false;
        // Nor anyone's local password override. `ExportedProfile` flattens the
        // whole `ConnectionProfile`, so a publisher who had taken a password
        // over on their own machine would otherwise ship the flag to everybody
        // — and on a *newly added* profile (the `None` arm below, which has no
        // local value to restore) it would suppress the very secret the file
        // publishes. The update arm restores this machine's own flag from
        // `existing` a few lines down.
        profile.secret_override = None;
        // Nor the database user a person signs in as on their own machine
        // (`crate::credentials`) — the same leak, one field over.
        profile.personal_username = None;

        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => {
                // Only ever refresh a profile this origin already owns. A
                // local profile that happens to share an id (an earlier
                // import, later detached) is the user's, not the file's.
                if existing.origin_id.as_deref() != Some(origin_id) {
                    continue;
                }
                if live.iter().any(|c| c == &profile.id) {
                    report.deferred.push(profile.id.clone());
                    continue;
                }
                // The MCP write policy is a LOCAL trust decision and must
                // survive the refresh. It is the one field on a published
                // profile that says what an AI client is allowed to do on
                // *this* machine, which the publisher cannot know; before
                // this, setting a shared connection to "data" in Settings
                // silently reverted on the next pull, so the whole panel was
                // unusable for anyone whose connections all come from an
                // origin. Everything else — host, port, credentials, the
                // visible-database default — is the file's to dictate.
                profile.mcp_write = existing.mcp_write;
                // Same reasoning, one field down: whether this machine samples
                // the connection into pulse.db is a local resource decision,
                // not something a publisher two machines away should be able
                // to flip back on with an unrelated refresh.
                profile.pulse_enabled = existing.pulse_enabled;
                // And one level up from `mcp_write`: whether the connector can
                // reach this connection at all. A publisher who happened to
                // have it exposed on their machine must not switch it on here,
                // and — the direction that actually bites — a refresh must not
                // switch *off* a connection the user exposed locally, which
                // would take an AI client's access away mid-session with no
                // visible cause.
                profile.mcp_exposed = existing.mcp_exposed;
                // And the same pair one surface across: whether the in-app AI
                // panel may reach this connection, and whether its rows may go
                // to an untrusted endpoint. Both are decisions about what
                // leaves *this* machine, which is the one thing a publisher
                // cannot know — and the off direction bites hardest here, since
                // a refresh that silently cleared `ai_rows_allowed` would leave
                // an assistant answering from metadata with no visible reason.
                profile.ai_enabled = existing.ai_enabled;
                profile.ai_rows_allowed = existing.ai_rows_allowed;
                // And what the user wrote about the database for the
                // assistant's benefit. Not a permission but the same
                // direction: a refresh that erased somebody's notes would
                // destroy work nothing else in the app can recover. Publishing
                // them team-wide would be a better feature and a different
                // one — it needs a field in the origin document.
                profile.ai_notes = existing.ai_notes.clone();
                // And the one local field that is not a permanent decision:
                // the consumer's own password standing in for the published
                // one. `merge_profiles_bundle` is what expires it, by comparing
                // the ciphertext it supersedes against the one arriving now —
                // so it has to survive the merge that hands it that ciphertext.
                profile.secret_override = existing.secret_override.clone();
                // And the person's own database user: a local choice the
                // publisher cannot see, which a refresh must never undo.
                profile.personal_username = existing.personal_username.clone();
                *existing = profile.clone();
                report.updated.push(profile.id);
            }
            None => {
                report.added.push(profile.id.clone());
                profiles.push(profile);
            }
        }
    }
    report
}

/// Merge one origin's published profile list into the global pool, and land
/// any secrets it carries into this user's keychain. Shared by a plain
/// `ExportFile` (`kind = "profiles"`, or the pre-`kind` legacy shape) and the
/// `profiles` section of an `EnvironmentExportFile` (`kind = "environment"`)
/// — the connection-sync rules (ownership by `origin_id`, deferral while a
/// pool is live, vanished detection) don't care which envelope they arrived
/// in, only `sync_origin`'s caller does.
fn merge_profiles_bundle(
    connections: &Arc<RwLock<ActiveConnections>>,
    profiles_lock: &Arc<RwLock<Vec<ConnectionProfile>>>,
    policy: &crate::policy::SharedPolicy,
    origin_id: &str,
    passphrase: Option<&str>,
    incoming: &[ExportedProfile],
    landed: &mut HashMap<String, String>,
) -> AppResult<OriginSyncReport> {
    let mut report;
    let live: Vec<String> = connections.read().ids();

    {
        let mut profiles = profiles_lock.write();
        report = merge_into(&mut profiles, origin_id, incoming, &live);
        crate::store::save_profiles(&profiles)?;
    }

    // Which connections this machine has taken its own password over for, and
    // the published ciphertext each override was raised against. Read *after*
    // the merge, which preserves the field, so it describes the pool the
    // secrets below are about to land into.
    let overrides: HashMap<String, Option<String>> = profiles_lock
        .read()
        .iter()
        .filter(|p| p.origin_id.as_deref() == Some(origin_id))
        .filter_map(|p| {
            p.secret_override
                .as_ref()
                .map(|o| (p.id.clone(), o.supersedes.clone()))
        })
        .collect();
    // Connections a person signs in to with their own database user — chosen
    // here, or pinned by the policy's `dbUser`. The shared secret is never
    // landed for them: it would be stored under an account nothing reads
    // (`id::<published user>`), and, worse, it would put on this machine the
    // very password that lets its user open another client as the shared
    // account — the one thing per-person users exist to prevent.
    let personal: std::collections::HashSet<String> = profiles_lock
        .read()
        .iter()
        .filter(|p| p.origin_id.as_deref() == Some(origin_id))
        .filter(|p| crate::credentials::personal_user(policy, p).is_some())
        .map(|p| p.id.clone())
        .collect();
    // Overrides this pass expired, because the publisher has since answered
    // the question they were a stopgap for. Reported, never silent: a
    // credential that changes under the user is exactly the thing they need
    // told about.
    let mut superseded: Vec<String> = Vec::new();

    // Secrets land in this user's own keychain, decrypted with the passphrase
    // stored for this origin. `BestEffort` because this runs unattended (launch,
    // the 4-hourly poll, "Sync now"): one undecryptable profile must leave that
    // connection needing a password rather than aborting the whole pass.
    //
    // The decryption itself lives in `transfer::land_secrets` — see its doc for
    // why "no passphrase" can never mean "store the blob as-is".
    for entry in incoming {
        let Some(secrets) = &entry.secrets else {
            // Nothing published for this connection, so there is nothing an
            // override could be losing a race against. Note this is also what
            // keeps an override alive indefinitely against an origin that
            // publishes no passwords at all.
            continue;
        };
        if personal.contains(&entry.profile.id) {
            continue;
        }
        let fingerprint = crate::transfer::secrets_fingerprint(secrets);
        let overridden = overrides.get(&entry.profile.id);
        if overridden.is_some_and(|s| override_still_stands(s.as_ref(), &fingerprint)) {
            // The origin still publishes the very ciphertext this machine took
            // over from. Landing it would overwrite the working password with
            // the broken one the override exists to route around — every sync,
            // four times a day.
            continue;
        }
        let accounts: Vec<String> = crate::transfer::secret_slots(&entry.profile, secrets)
            .into_iter()
            .map(|(account, _)| account)
            .collect();
        if already_landed(landed, &entry.profile.id, &fingerprint, &accounts, |a| {
            keychain::get_password(a).ok().flatten().is_some()
        }) {
            continue;
        }
        // Only remember the fingerprint once something was actually stored: a
        // failed decrypt (wrong or missing passphrase) must be retried on the
        // next sync, not cached as done.
        if crate::transfer::land_secrets(
            &entry.profile,
            secrets,
            passphrase,
            crate::transfer::LandMode::BestEffort,
        )
        .unwrap_or(false)
        {
            landed.insert(entry.profile.id.clone(), fingerprint);
            // Expired only now that the newer secret is actually in the
            // keychain. A failed decrypt leaves the override standing, so the
            // user keeps a connection that works rather than one that does not.
            if overridden.is_some() {
                superseded.push(entry.profile.id.clone());
            }
        }
    }

    if !superseded.is_empty() {
        let mut profiles = profiles_lock.write();
        for p in profiles.iter_mut().filter(|p| superseded.contains(&p.id)) {
            p.secret_override = None;
        }
        crate::store::save_profiles(&profiles)?;
    }
    report.superseded = superseded;

    Ok(report)
}

/// Reconcile the environments an origin's `EnvironmentExportFile` describes
/// against this machine's local mirrors of them, matched by
/// `(origin_id, origin_source_id)` — not by position in the file or by name,
/// which can both change between syncs. See `Environment::origin_source_id`
/// for why that pair is the identity that survives repeated syncs, given
/// `ExportedEnvironment` itself carries no portable id.
///
/// Deliberately does **not** register a bundle's own nested `origins`: a file
/// an origin points at must not be able to make this machine register more
/// origins on its own — that stays reserved for the conscious, one-shot
/// `import_environment`.
///
/// Returns (added env ids, updated env ids, vanished env ids, suspicious).
fn sync_environment_bundles(
    guard: &mut tab_state::PersistedTabState,
    origin_id: &str,
    bundles: &[ExportedEnvironmentBundle],
) -> (Vec<String>, Vec<String>, Vec<String>, bool) {
    let owned_count = guard
        .environments
        .iter()
        .filter(|e| e.origin_id.as_deref() == Some(origin_id))
        .count();
    let incoming_source_ids: std::collections::HashSet<&str> = bundles
        .iter()
        .map(|b| b.environment.source_environment_id.as_str())
        .collect();

    let mut vanished: Vec<String> = guard
        .environments
        .iter()
        .filter(|e| e.origin_id.as_deref() == Some(origin_id))
        .filter(|e| {
            e.origin_source_id
                .as_deref()
                .map(|src| !incoming_source_ids.contains(src))
                .unwrap_or(false)
        })
        .map(|e| e.id.clone())
        .collect();
    let suspicious = !disappearance_is_trustworthy(owned_count, vanished.len());
    if suspicious {
        vanished.clear();
    }

    let mut added = Vec::new();
    let mut updated = Vec::new();
    let base_order = guard
        .environments
        .iter()
        .map(|e| e.order)
        .max()
        .unwrap_or(0)
        + 1;
    for (i, bundle) in bundles.iter().enumerate() {
        let src_id = bundle.environment.source_environment_id.as_str();
        let visible_connections = if bundle.connection_ids.is_empty() {
            None
        } else {
            Some(bundle.connection_ids.clone())
        };

        match guard.environments.iter_mut().find(|e| {
            e.origin_id.as_deref() == Some(origin_id)
                && e.origin_source_id.as_deref() == Some(src_id)
        }) {
            Some(existing) => {
                existing.name = bundle.environment.name.clone();
                existing.color = bundle.environment.color.clone();
                existing.icon = bundle.environment.icon.clone();
                existing.theme_id = bundle.environment.theme_id.clone();
                existing.launch.visible_connections = visible_connections;
                // Deliberately not touched: `local_name`/`local_color`/
                // `local_icon`/`local_theme_id` are this machine's own
                // override of how the mirror displays, set only via
                // `set_environment_local_overrides`. See their doc on
                // `Environment` — the same "never revert a local decision"
                // reasoning as `merge_into`'s `mcp_write`/`pulse_enabled`.
                //
                // Also untouched: `local_visible_connections`, this machine's
                // own hide/show choice within the mirror — `launch.visible_connections`
                // just above is deliberately overwritten with the bundle's true
                // membership every sync (unlike the cosmetics), but the *effective*
                // value a caller sees is resolved through that override, via
                // `Environment::effective_visible_connections`
                // (`get_launch_state`/`list_environments`) — never read off
                // `launch.visible_connections` directly. Writing straight to it
                // here, unconditionally, used to erase a user's "hide this
                // connection" choice on every sync (the reported bug).
                updated.push(existing.id.clone());
            }
            None => {
                let env_id = uuid::Uuid::new_v4().to_string();
                let env = Environment {
                    id: env_id.clone(),
                    name: bundle.environment.name.clone(),
                    color: bundle.environment.color.clone(),
                    icon: bundle.environment.icon.clone(),
                    order: base_order + i as i32,
                    theme_id: bundle.environment.theme_id.clone(),
                    origin_id: Some(origin_id.to_string()),
                    origin_source_id: Some(src_id.to_string()),
                    launch: LaunchState {
                        visible_connections,
                        ..LaunchState::default()
                    },
                    ..Environment::default()
                };
                guard.environments.push(env);
                added.push(env_id);
            }
        }
    }

    (added, updated, vanished, suspicious)
}

/// Below this many origin-tagged profiles, the "too many vanished at once" check
/// is skipped — with two or three connections, losing both is plausibly a real
/// deletion rather than a corrupt read.
const SUSPICION_FLOOR: usize = 4;

/// Fraction of an origin's profiles that has to disappear in one sync before the
/// result is treated as untrustworthy rather than as a batch of deletions.
const SUSPICION_RATIO: f32 = 0.5;

/// Should this set of disappearances be acted on, or is the file probably not
/// telling us the truth?
///
/// A publisher writing the export without an atomic rename, a share dropping
/// mid-read, or a truncated file can all parse successfully while listing far
/// fewer profiles than they should. Treating that as "the admin deleted 25
/// clients" would bury the user in removal notices for connections that are
/// perfectly alive — and the recovery (re-adopting each one) is manual.
///
/// Pure so the threshold is testable without a filesystem.
///
/// `pub(crate)` because the publish preview has to be able to say *"nobody will
/// be told about this"* — the one thing a consumer's report can never reveal,
/// since crossing the threshold is what clears `vanished`.
pub(crate) fn disappearance_is_trustworthy(local_count: usize, vanished_count: usize) -> bool {
    if vanished_count == 0 {
        return true;
    }
    if local_count < SUSPICION_FLOOR {
        return true;
    }
    (vanished_count as f32 / local_count as f32) < SUSPICION_RATIO
}

/// Outcome of one [`sync_origin`] run.
///
/// Note what is absent: nothing here deletes. Disappearances are *reported* and
/// the user decides per connection whether to adopt it as local or retire it
/// (#108) — another user's edit to a shared file must never destroy credentials
/// on this machine.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginSyncReport {
    /// Profile ids created by this sync.
    pub added: Vec<String>,
    /// Profile ids whose metadata was refreshed from the file.
    pub updated: Vec<String>,
    /// Ids whose metadata changed but which have a live pool, so the change is
    /// held back rather than repointing a server under a running query.
    pub deferred: Vec<String>,
    /// Ids present locally under this origin but absent from the file. Reported
    /// only; see the type-level note.
    pub vanished: Vec<String>,
    /// True when `vanished` was large enough relative to the origin's footprint
    /// that the read is more likely broken than authoritative. The frontend must
    /// not offer removals in this state.
    pub suspicious: bool,
    /// Ids whose local password override this pass expired, because the origin
    /// now publishes a *different* ciphertext than the one it was raised
    /// against. Their keychain entry has been replaced with the published
    /// secret; see [`crate::state::SecretOverride`].
    ///
    /// Reported so the frontend can say so. A credential silently changing back
    /// under the user is the same class of surprise `vanished` exists to
    /// prevent, one level down.
    #[serde(default)]
    pub superseded: Vec<String>,
    /// RFC 3339 stamp written back onto the origin on success.
    pub synced_at: String,
    /// Environment ids created by this sync, when the origin publishes whole
    /// environments (`kind = "environment"`). Empty for a plain profile origin.
    #[serde(default)]
    pub environments_added: Vec<String>,
    /// Environment ids whose cosmetics/membership were refreshed from the file.
    #[serde(default)]
    pub environments_updated: Vec<String>,
    /// Environment ids this origin owns locally whose bundle disappeared from
    /// the file. Reported only, same as `vanished` one level up: nothing here
    /// deletes on its own.
    #[serde(default)]
    pub environments_vanished: Vec<String>,
    /// Same purpose as `suspicious`, scoped to the environment count instead
    /// of the profile count.
    #[serde(default)]
    pub environments_suspicious: bool,
    /// JSON Schemas this pull created / refreshed. Non-zero only for an
    /// environment-kind file whose publisher included them.
    #[serde(default)]
    pub schemas_added: usize,
    #[serde(default)]
    pub schemas_updated: usize,
    /// Owned by this origin locally and absent from the file. Reported only,
    /// like every other disappearance here: another user's edit to a shared
    /// file must not destroy what is on this machine.
    #[serde(default)]
    pub schemas_vanished: usize,
    #[serde(default)]
    pub bindings_added: usize,
    #[serde(default)]
    pub bindings_updated: usize,
    #[serde(default)]
    pub bindings_vanished: usize,
    /// Landed with `enabled: false` because they name a connection this machine
    /// does not have (`docs/JSON_SCHEMAS.md`).
    #[serde(default)]
    pub bindings_disabled: usize,
    /// Which slices this pull actually read, i.e. the origin's
    /// [`OriginScope`] at the moment it ran.
    ///
    /// Reported because every count above is zero for two completely different
    /// reasons — "the file publishes no environments" and "this machine does
    /// not pull environments" — and a summary that cannot tell them apart says
    /// "0 environments" to somebody who deliberately switched them off, which
    /// reads as the feature being broken.
    #[serde(default)]
    pub pulled: OriginScope,
}

impl OriginSyncReport {
    /// Did this pull change the JSON Schema library? Decides whether the
    /// library's global invalidation event is worth raising — every window
    /// drops its cached resolutions when it is, so a quiet sync must not.
    fn touched_json_schemas(&self) -> bool {
        self.schemas_added + self.schemas_updated + self.bindings_added + self.bindings_updated > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::McpWritePolicy;
    use crate::testkit;
    use crate::transfer::ExportedProfile;

    /// One published entry with no attached secrets, so the merge never touches
    /// the keychain and the test needs no OS credential store.
    fn published(profile: ConnectionProfile) -> ExportedProfile {
        ExportedProfile {
            profile,
            secrets: None,
        }
    }

    /// Runs the merge rules against `local` with no pools open.
    ///
    /// Deliberately `merge_into`, not `merge_profiles_bundle`: the latter writes
    /// the real `profiles.json`, so calling it from a test both raced the other
    /// tests and overwrote the developer's own saved connections.
    fn merge(
        mut local: Vec<ConnectionProfile>,
        incoming: &[ExportedProfile],
    ) -> Vec<ConnectionProfile> {
        merge_into(&mut local, "o1", incoming, &[]);
        local
    }

    /// The write policy says what an AI client may do on *this* machine, which
    /// the publisher cannot know. Before it was preserved, setting a shared
    /// connection to "data" reverted on the next pull — silently, so the MCP
    /// panel was unusable for anyone whose connections all come from an origin.
    #[test]
    fn a_sync_preserves_the_local_mcp_write_policy() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            mcp_write: McpWritePolicy::Data,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            mcp_write: McpWritePolicy::ReadOnly,
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert_eq!(after[0].mcp_write, McpWritePolicy::Data, "policy is local");
        assert_eq!(after[0].host, "newhost", "everything else is the file's");
    }

    /// The counterpart to the three above, and the reason the preserve list is
    /// a list rather than a rule: how long a server takes to answer is a fact
    /// about the *server*, which is exactly what a publisher does know. It
    /// follows the file, like `host` and `max_connections` — anything else
    /// would mean every machine on the team rediscovering the same number.
    #[test]
    fn a_sync_brings_the_publishers_operation_timeout() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            operation_timeout_secs: Some(20),
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            operation_timeout_secs: Some(120),
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert_eq!(after[0].operation_timeout_secs, Some(120));
    }

    /// A local password override is local state too, and unlike the three
    /// above it has to survive the merge *in order to be expired by it* — the
    /// landing loop reads it back off the merged pool to compare against the
    /// ciphertext that just arrived.
    #[test]
    fn a_sync_preserves_a_local_secret_override() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            secret_override: Some(SecretOverride {
                supersedes: Some("fp-old".into()),
                set_at: "2026-09-09T09:00:00Z".into(),
            }),
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert_eq!(
            after[0]
                .secret_override
                .as_ref()
                .and_then(|o| o.supersedes.as_deref()),
            Some("fp-old"),
        );
        assert_eq!(after[0].host, "newhost", "everything else is the file's");
    }

    /// A person's own database user is theirs: a refresh keeps it, and a
    /// publisher's — on a connection the consumer is adding, where there is
    /// nothing local to restore — never arrives, or everyone would sign in as
    /// the publisher.
    #[test]
    fn a_sync_keeps_the_local_personal_user_and_never_brings_the_publishers() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            personal_username: Some("alopez".into()),
            ..testkit::profile("shared")
        };
        let refreshed = published(ConnectionProfile {
            username: "erp_app".into(),
            personal_username: Some("the_publisher".into()),
            ..testkit::profile("shared")
        });
        let added = published(ConnectionProfile {
            personal_username: Some("the_publisher".into()),
            ..testkit::profile("new")
        });

        let after = merge(vec![local], &[refreshed, added]);

        assert_eq!(after[0].personal_username.as_deref(), Some("alopez"));
        assert_eq!(
            after[0].username, "erp_app",
            "the published user is the file's"
        );
        assert_eq!(after[1].personal_username, None);
    }

    /// A publisher who had taken a password over on their own machine must not
    /// ship the flag with the connection. On a profile the consumer does not
    /// have yet there is no local value to restore over it, and the flag would
    /// then suppress the very secret the file publishes.
    #[test]
    fn a_published_override_flag_is_never_adopted() {
        let incoming = published(ConnectionProfile {
            secret_override: Some(SecretOverride {
                supersedes: Some("fp-theirs".into()),
                set_at: "2026-09-09T09:00:00Z".into(),
            }),
            ..testkit::profile("shared")
        });

        let after = merge(vec![], &[incoming]);

        assert!(after[0].secret_override.is_none());
    }

    /// The expiry rule itself. `merge_profiles_bundle` writes the real
    /// `profiles.json` and reads the keychain, so the decision is tested where
    /// it is made rather than through the pass that applies it — the same split
    /// `already_landed` uses.
    #[test]
    fn an_override_stands_until_the_published_ciphertext_changes() {
        let taken_over = Some("fp-old".to_string());

        assert!(
            override_still_stands(taken_over.as_ref(), "fp-old"),
            "the origin is still publishing the password the user routed around"
        );
        assert!(
            !override_still_stands(taken_over.as_ref(), "fp-new"),
            "the publisher has answered: their secret wins again"
        );
    }

    /// An override raised against an origin that had landed nothing has no
    /// ciphertext to be newer than, so the first real publication takes it.
    #[test]
    fn an_override_over_nothing_yields_to_the_first_published_secret() {
        assert!(!override_still_stands(None, "fp-first"));
    }

    /// Same guarantee, one field down: a local `pulse_enabled` opt-in must not
    /// be silently reset (or silently granted) by a refresh from a shared
    /// origin — see the comment on the preservation line in `merge_into`.
    #[test]
    fn a_sync_preserves_the_local_pulse_opt_in() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            pulse_enabled: true,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            pulse_enabled: false,
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert!(after[0].pulse_enabled, "the opt-in is local");
        assert_eq!(after[0].host, "newhost", "everything else is the file's");
    }

    /// And one level up from the write policy: whether the MCP connector can
    /// reach the connection at all. Both directions matter — a publisher who
    /// had it exposed must not switch it on here, and a refresh must not take
    /// away access an AI client is using right now.
    #[test]
    fn a_sync_preserves_the_local_mcp_exposure() {
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            mcp_exposed: true,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            mcp_exposed: false,
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert!(after[0].mcp_exposed, "exposure is this machine's call");
        assert_eq!(after[0].host, "newhost", "everything else is the file's");

        // The other direction: the publisher's `true` must not expose a
        // connection this machine never ticked.
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            mcp_exposed: false,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            mcp_exposed: true,
            ..testkit::profile("shared")
        });
        let after = merge(vec![local], &[incoming]);
        assert!(!after[0].mcp_exposed, "a publisher cannot expose for us");
    }

    /// The same two directions for the in-app AI panel's pair of flags. Not
    /// compiler-enforced — `merge_into` assigns the fields it knows about and a
    /// new one is simply absent — so this is the test that stands in for a
    /// missing `#[deny]`.
    #[test]
    fn a_sync_preserves_the_local_ai_flags() {
        // This machine's decisions survive a refresh that says otherwise.
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            ai_enabled: true,
            ai_rows_allowed: true,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            host: "newhost".into(),
            ai_enabled: false,
            ai_rows_allowed: false,
            ..testkit::profile("shared")
        });

        let after = merge(vec![local], &[incoming]);

        assert!(after[0].ai_enabled, "AI reach is this machine's call");
        assert!(after[0].ai_rows_allowed, "so is row access");
        assert_eq!(after[0].host, "newhost", "everything else is the file's");

        // And the publisher cannot switch either of them on for us — the
        // direction that would quietly send a client's rows to whatever
        // endpoint this machine happens to have configured.
        let local = ConnectionProfile {
            origin_id: Some("o1".into()),
            ai_enabled: false,
            ai_rows_allowed: false,
            ..testkit::profile("shared")
        };
        let incoming = published(ConnectionProfile {
            ai_enabled: true,
            ai_rows_allowed: true,
            ..testkit::profile("shared")
        });
        let after = merge(vec![local], &[incoming]);
        assert!(!after[0].ai_enabled, "a publisher cannot enable AI for us");
        assert!(
            !after[0].ai_rows_allowed,
            "a publisher cannot allow rows for us"
        );
    }

    /// A profile arriving for the first time has no local decision to keep, so
    /// it takes whatever the file published (which is the export's default,
    /// read-only, unless the publisher changed it).
    #[test]
    fn a_newly_published_profile_takes_the_files_policy() {
        let incoming = published(ConnectionProfile {
            mcp_write: McpWritePolicy::Full,
            ..testkit::profile("fresh")
        });
        let after = merge(vec![], &[incoming]);
        assert_eq!(after[0].mcp_write, McpWritePolicy::Full);
        assert_eq!(after[0].origin_id.as_deref(), Some("o1"));
    }

    /// A local profile that merely shares an id is the user's, not the file's —
    /// the existing ownership guard, pinned here because the policy line sits
    /// right next to it.
    #[test]
    fn a_sync_never_claims_a_profile_another_origin_owns() {
        let local = ConnectionProfile {
            origin_id: Some("other".into()),
            host: "mine".into(),
            ..testkit::profile("contested")
        };
        let incoming = published(ConnectionProfile {
            host: "theirs".into(),
            ..testkit::profile("contested")
        });
        let after = merge(vec![local], &[incoming]);
        assert_eq!(after[0].host, "mine");
        assert_eq!(after[0].origin_id.as_deref(), Some("other"));
    }

    #[test]
    fn a_single_disappearance_is_trusted() {
        assert!(disappearance_is_trustworthy(20, 1));
    }

    #[test]
    fn a_wholesale_disappearance_is_not() {
        // A truncated or half-written file looks exactly like this.
        assert!(!disappearance_is_trustworthy(20, 20));
        assert!(!disappearance_is_trustworthy(20, 10));
    }

    #[test]
    fn small_origins_are_exempt_from_the_ratio() {
        // With three connections, losing two is plausibly deliberate; the ratio
        // alone would call it suspicious and block a legitimate cleanup.
        assert!(disappearance_is_trustworthy(3, 2));
    }

    #[test]
    fn no_disappearances_is_always_trusted() {
        assert!(disappearance_is_trustworthy(0, 0));
    }

    #[test]
    fn passphrase_account_cannot_collide_with_a_connection_account() {
        // Connection accounts are `<profile-id>::<username>`; origin accounts
        // carry a prefix instead, so the two namespaces can't overlap.
        let account = passphrase_account("2f1c8a0e-0000-4000-8000-000000000000");
        assert!(account.starts_with("origin::"));
        assert!(!account.contains("::origin"));
    }

    fn bundle(
        source_id: &str,
        name: &str,
        connection_ids: Vec<String>,
    ) -> ExportedEnvironmentBundle {
        ExportedEnvironmentBundle {
            environment: crate::transfer::ExportedEnvironment {
                name: name.into(),
                color: None,
                icon: None,
                theme_id: None,
                source_environment_id: source_id.into(),
            },
            connection_ids,
            // A sync must never auto-register origins from the file — see
            // `sync_environment_bundles`'s doc — so tests deliberately leave
            // this non-empty to prove it's ignored, not just untested.
            origins: vec![crate::transfer::ExportedOrigin {
                name: "should be ignored".into(),
                path: "/should/be/ignored".into(),
            }],
        }
    }

    #[test]
    fn first_sync_creates_a_mirrored_environment() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, updated, vanished, suspicious) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec!["conn-1".into()])],
        );

        assert_eq!(added.len(), 1);
        assert!(updated.is_empty());
        assert!(vanished.is_empty());
        assert!(!suspicious);

        let env = state
            .environments
            .iter()
            .find(|e| e.id == added[0])
            .unwrap();
        assert_eq!(env.name, "Producción");
        assert_eq!(env.origin_id.as_deref(), Some("origin-1"));
        assert_eq!(env.origin_source_id.as_deref(), Some("src-a"));
        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["conn-1".to_string()])
        );
        // The bundle's own nested origin must never be auto-registered.
        assert!(env.origins.is_empty());
    }

    #[test]
    fn a_later_sync_updates_the_same_mirrored_environment_instead_of_duplicating() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, ..) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec!["conn-1".into()])],
        );
        let env_id = added[0].clone();

        // The publisher renamed it and added a second connection — same
        // `source_environment_id`, so it must be recognised as the same
        // environment, not create a sibling.
        let (added2, updated2, vanished2, _) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle(
                "src-a",
                "Producción (EU)",
                vec!["conn-1".into(), "conn-2".into()],
            )],
        );

        assert!(added2.is_empty());
        assert_eq!(updated2, vec![env_id.clone()]);
        assert!(vanished2.is_empty());
        assert_eq!(
            state
                .environments
                .iter()
                .filter(|e| e.origin_id.as_deref() == Some("origin-1"))
                .count(),
            1
        );
        let env = state.environments.iter().find(|e| e.id == env_id).unwrap();
        assert_eq!(env.name, "Producción (EU)");
        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["conn-1".to_string(), "conn-2".to_string()])
        );
    }

    /// The reported bug: hiding a connection in a mirrored environment via
    /// the picker got undone by the very next sync, because
    /// `launch.visible_connections` (the origin's true membership) and "what
    /// the user chose to see" used to be the same field. `local_visible_connections`
    /// is that user choice now, and a sync must leave it alone exactly like it
    /// already leaves `local_name`/`local_color`/`local_icon`/`local_theme_id`
    /// alone — even while `launch.visible_connections` keeps tracking the
    /// origin's membership underneath it.
    #[test]
    fn a_sync_never_touches_the_local_visible_connections_override() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, ..) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle(
                "src-a",
                "Producción",
                vec!["conn-1".into(), "conn-2".into()],
            )],
        );
        let env_id = added[0].clone();

        // The user hides `conn-2` — same mechanism `save_launch_state` uses.
        state
            .environments
            .iter_mut()
            .find(|e| e.id == env_id)
            .unwrap()
            .local_visible_connections = Some(vec!["conn-1".to_string()]);

        // The origin still publishes both connections on the next sync.
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle(
                "src-a",
                "Producción",
                vec!["conn-1".into(), "conn-2".into()],
            )],
        );

        let env = state.environments.iter().find(|e| e.id == env_id).unwrap();
        assert_eq!(
            env.launch.visible_connections,
            Some(vec!["conn-1".to_string(), "conn-2".to_string()]),
            "the true membership keeps tracking the origin"
        );
        assert_eq!(
            env.effective_visible_connections(),
            Some(vec!["conn-1".to_string()]),
            "but the user's hide/show choice must survive the sync"
        );
    }

    /// The same "local decision survives a refresh" guarantee `merge_into`
    /// gives `mcp_write`/`pulse_enabled` (see those tests above), one level
    /// up: a user who picked their own icon/colour/name/theme for a mirrored
    /// environment must not have it silently reverted by the next sync just
    /// because the publisher touched something else in the bundle.
    #[test]
    fn a_sync_never_touches_the_local_cosmetic_overrides() {
        let mut state = tab_state::PersistedTabState::default();
        let (added, ..) = sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec!["conn-1".into()])],
        );
        let env_id = added[0].clone();
        {
            let env = state
                .environments
                .iter_mut()
                .find(|e| e.id == env_id)
                .unwrap();
            env.local_name = Some("Mi Producción".into());
            env.local_color = Some("#123456".into());
            env.local_icon = Some("star".into());
            env.local_theme_id = Some("nord".into());
        }

        // The publisher renamed it and changed its colour — none of that
        // should disturb the local overrides.
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle(
                "src-a",
                "Producción (EU)",
                vec!["conn-1".into(), "conn-2".into()],
            )],
        );

        let env = state.environments.iter().find(|e| e.id == env_id).unwrap();
        assert_eq!(env.name, "Producción (EU)", "the synced name still updates");
        assert_eq!(env.local_name.as_deref(), Some("Mi Producción"));
        assert_eq!(env.local_color.as_deref(), Some("#123456"));
        assert_eq!(env.local_icon.as_deref(), Some("star"));
        assert_eq!(env.local_theme_id.as_deref(), Some("nord"));
    }

    #[test]
    fn an_environment_dropped_from_the_file_is_reported_vanished_not_deleted() {
        let mut state = tab_state::PersistedTabState::default();
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec![])],
        );

        // The publisher stopped including it in the file.
        let (added, updated, vanished, suspicious) =
            sync_environment_bundles(&mut state, "origin-1", &[]);

        assert!(added.is_empty());
        assert!(updated.is_empty());
        assert_eq!(vanished.len(), 1);
        assert!(!suspicious);
        // Never deleted on our own initiative — same rule as a vanished profile.
        assert_eq!(
            state
                .environments
                .iter()
                .filter(|e| e.origin_id.as_deref() == Some("origin-1"))
                .count(),
            1
        );
    }

    #[test]
    fn an_unrelated_origins_environments_are_never_touched() {
        let mut state = tab_state::PersistedTabState::default();
        sync_environment_bundles(
            &mut state,
            "origin-1",
            &[bundle("src-a", "Producción", vec![])],
        );

        let (added, updated, vanished, _) = sync_environment_bundles(
            &mut state,
            "origin-2",
            &[bundle("src-b", "Staging", vec![])],
        );

        assert_eq!(added.len(), 1);
        assert!(updated.is_empty());
        // origin-2's own first sync must not flag origin-1's environment as
        // vanished — vanished detection is scoped per origin.
        assert!(vanished.is_empty());
    }

    // --- the launch-freeze guard --------------------------------------------
    //
    // Landing a secret costs ~600 000 PBKDF2 rounds per slot. A shared origin
    // publishing thirty tunnelled connections re-did all of them on every
    // sync, on the main thread, which is what made every launch a multi-second
    // "Not Responding". These pin the two halves of the skip that stops it.
    // All keychain-free: `already_landed` takes its presence check as an
    // argument precisely so the decision can be tested without one.

    fn fp_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn an_unchanged_secret_whose_accounts_are_present_is_skipped() {
        let landed = fp_map(&[("p1", "abc")]);
        assert!(already_landed(
            &landed,
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| true
        ));
    }

    #[test]
    fn a_rotated_secret_is_landed_again_even_though_the_account_exists() {
        // The keychain entry is still there, so the presence check alone would
        // wrongly skip and the new password would never arrive.
        let landed = fp_map(&[("p1", "old")]);
        assert!(!already_landed(
            &landed,
            "p1",
            "new",
            &["p1::user".to_string()],
            |_| true
        ));
    }

    #[test]
    fn a_deleted_keychain_entry_is_relanded_even_though_the_blob_is_unchanged() {
        // The published blob never changes, so the fingerprint alone would
        // wrongly skip and the connection would stay without a password
        // forever. This is why the check has two halves.
        let landed = fp_map(&[("p1", "abc")]);
        assert!(!already_landed(
            &landed,
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| false
        ));
    }

    #[test]
    fn one_missing_account_of_two_is_enough_to_reland() {
        // A tunnelled profile has a DB slot and an SSH slot; either being gone
        // must redo the pair rather than leave half a credential behind.
        let landed = fp_map(&[("p1", "abc")]);
        let accounts = ["p1::user".to_string(), "p1::ssh".to_string()];
        assert!(!already_landed(&landed, "p1", "abc", &accounts, |a| a != "p1::ssh"));
    }

    #[test]
    fn a_profile_never_landed_here_is_never_skipped() {
        assert!(!already_landed(
            &HashMap::new(),
            "p1",
            "abc",
            &["p1::user".to_string()],
            |_| true
        ));
    }

    // --- The consumption scope (#171) ------------------------------------
    //
    // These pin the one thing about `OriginScope` that is not obvious from
    // reading it: its default is `true` everywhere, against the house rule for
    // per-resource opt-ins, and the tests below are why. The first two are the
    // load-bearing pair — break either and installing an update silently
    // narrows every origin already registered on every machine in the team.

    #[test]
    fn an_origin_written_before_the_scope_existed_pulls_everything() {
        // Exactly what a 1.23 `tab_state.json` holds: no `scope` key at all.
        let json = r#"{
            "id": "o1",
            "name": "Team",
            "path": "\\share\team.json",
            "lastSyncedAt": null,
            "landedSecrets": {},
            "role": "consumer"
        }"#;
        let origin: Origin = serde_json::from_str(json).expect("parses");
        assert_eq!(
            origin.scope,
            OriginScope::default(),
            "an absent scope means the origin kept doing what it did before"
        );
        assert!(origin.scope.connections);
        assert!(origin.scope.environments);
        assert!(origin.scope.schemas);
    }

    #[test]
    fn a_partially_written_scope_fills_the_rest_in_as_enabled() {
        // The trap this guards: `#[serde(default)]` on the *struct* would fill
        // the missing fields with `bool::default()` — `false` — so a payload
        // naming only the slice that changed would silently switch the other
        // two off. Every field carries its own `default = "enabled"` instead.
        let origin: Origin =
            serde_json::from_str(r#"{ "id": "o1", "scope": { "connections": false } }"#)
                .expect("parses");
        assert!(!origin.scope.connections, "the stated field is honoured");
        assert!(origin.scope.environments, "an unstated field is not off");
        assert!(origin.scope.schemas, "an unstated field is not off");
    }

    #[test]
    fn a_narrowed_scope_survives_a_round_trip() {
        // The other direction of gotcha #14: the scope has to come back off
        // disk, or a user's choice silently reverts on the next launch.
        let origin = Origin {
            id: "o1".into(),
            scope: OriginScope {
                connections: true,
                environments: false,
                schemas: false,
            },
            ..Default::default()
        };
        let round_tripped: Origin =
            serde_json::from_str(&serde_json::to_string(&origin).expect("serialises"))
                .expect("parses");
        assert_eq!(round_tripped.scope, origin.scope);
    }

    #[test]
    fn a_team_sized_environment_set_would_be_reported_vanished_wholesale() {
        // Not a test of the scope — a test of what the scope's default is
        // protecting. `sync_environment_bundles` is authoritative about the
        // list it is handed, and a machine mirroring fewer than
        // `SUSPICION_FLOOR` environments has no ratio check to save it, so
        // handing it an empty list reports every one of them as gone. That is
        // precisely what a closed default would do on the first sync after an
        // update, which is why `sync_origin_inner` gates the *call* rather than
        // passing an empty slice.
        let mut state = tab_state::PersistedTabState::default();
        state.environments.push(Environment {
            id: "local-1".into(),
            name: "Producción".into(),
            origin_id: Some("o1".into()),
            origin_source_id: Some("src-1".into()),
            ..Default::default()
        });

        let (_, _, vanished, suspicious) = sync_environment_bundles(&mut state, "o1", &[]);

        assert!(!suspicious, "one environment is below the suspicion floor");
        assert_eq!(
            vanished,
            vec!["local-1".to_string()],
            "an empty list reads as an authoritative disappearance"
        );
    }

    #[test]
    fn a_peek_counts_every_slice_of_an_environment_file() {
        // Writes to the OS temp dir, never the config dir: convention #52 is the
        // record of a test suite that reached into real state and destroyed a
        // developer's saved connections.
        let path =
            std::env::temp_dir().join(format!("huginndb-peek-{}.json", uuid::Uuid::new_v4()));
        let file = crate::transfer::EnvironmentExportFile {
            // Spelled out rather than `..Default::default()`: `ExportMetadata`
            // has no `Default` on purpose — it is a wire header, and a version
            // or a kind that can be defaulted into existence is how a file ends
            // up claiming to be something it is not.
            meta: ExportMetadata {
                version: 1,
                app: "huginndb".into(),
                exported_at: "2026-09-14T10:00:00Z".into(),
                encrypted: false,
                kind: KIND_ENVIRONMENT.into(),
                maintainer: None,
                revision: Some(1),
                note: None,
            },
            environments: vec![bundle("src-1", "Producción", vec!["c1".into()])],
            profiles: vec![published(testkit::profile("c1"))],
            json_schemas: Default::default(),
        };
        std::fs::write(&path, serde_json::to_string(&file).expect("serialises")).expect("writes");

        let peek = peek_origin_file(path.to_string_lossy().into_owned()).expect("peeks");
        let _ = std::fs::remove_file(&path);

        assert_eq!(peek.kind, KIND_ENVIRONMENT);
        assert_eq!(peek.connections, 1);
        assert_eq!(peek.environments, 1);
        assert_eq!(peek.schemas, 0);
        assert!(!peek.encrypted);
    }

    #[test]
    fn a_peek_at_an_unreachable_path_is_an_error_not_a_panic() {
        // The normal case while the user is still typing a UNC path.
        let missing =
            std::env::temp_dir().join(format!("huginndb-absent-{}", uuid::Uuid::new_v4()));
        assert!(peek_origin_file(missing.to_string_lossy().into_owned()).is_err());
        assert!(peek_origin_file("   ".into()).is_err());
    }
}
