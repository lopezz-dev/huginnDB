//! Reading and writing the *document* a shared origin publishes.
//!
//! The model — what a draft is, how it becomes a file, what publishing one does
//! to everyone pulling from it — is [`crate::origin_doc`], and it is pure. This
//! module is the I/O half: it reads the path, resolves keychain secrets,
//! computes the content hash the optimistic-concurrency check rests on, and
//! writes the result atomically.
//!
//! Three things here are load-bearing.
//!
//! **Writing is opt-in per origin, and the OS gets the last word.** A registered
//! origin loads as [`OriginRole::Consumer`] (`tab_state::Origin::role`,
//! `#[serde(default)]`), so no existing origin becomes writable by installing an
//! update, and marking one as a publisher is a separate confirmed action. Even
//! then [`probe_origin_writable`] *tries* to create a file next to the document
//! before the editor offers to save: a share's ACL is the real perimeter
//! (`SECURITY.md`), and permission metadata on Windows routinely disagrees with
//! what a write actually does.
//!
//! **Concurrency is optimistic, by content hash.** [`open_origin_document`]
//! stamps the file's SHA-256 into a [`DraftBase`]; [`save_origin_document`]
//! re-reads and re-hashes before writing and refuses on a mismatch, handing back
//! the newer document instead of overwriting it. A lock file would be worse than
//! nothing here — a laptop dropping off the VPN mid-edit would strand the team's
//! document rather than protect it.
//!
//! **Every path that can decrypt runs off the main thread.** Landing or rotating
//! a secret costs ~600 000 PBKDF2 rounds *per slot*, and a synchronous
//! `#[tauri::command]` runs on the thread pumping the window — the exact freeze
//! `sync_origin` documents at length. Anything that touches a passphrase here is
//! an `async fn` whose body sits on `spawn_blocking`.

use std::path::Path;
use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter, State};

use crate::commands::origins::ORIGINS_CHANGED_EVENT;
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::origin_doc::{self, DraftBase, OriginDraft, PublishImpact, SecretSlot};
use crate::state::{AppState, ConnectionProfile};
use crate::state_file;
use crate::tab_state::{self, Origin, OriginRole, PersistedTabState};
use crate::transfer::{self, EnvironmentExportFile, ExportedSecret, KIND_ENVIRONMENT};

/// Per-secret progress while a publish encrypts.
///
/// A *separate* event from `IMPORT_PROGRESS_EVENT` rather than a reuse of it,
/// even though the payload is identical and the reason for both is the same
/// (one 600 000-iteration PBKDF2 derivation per secret, deliberately slow). An
/// event whose name says "import" emitted by a publish is a wire contract that
/// lies, and the two can then never be told apart by a window that happens to
/// be doing both.
///
/// Scoped with `emit_to` to the window that asked, like every other per-window
/// event here (gotcha #25): a bare `emit` would drive a *different* window's
/// progress bar.
pub const ORIGIN_PUBLISH_PROGRESS_EVENT: &str = "huginndb://origin-publish-progress";

/// Payload of [`ORIGIN_PUBLISH_PROGRESS_EVENT`]. `total` counts only the
/// connections that actually need crypto work — a document of verbatim
/// envelopes emits nothing at all, which is what the frontend reads as "there
/// is no bar to show".
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct PublishProgress {
    pub done: usize,
    pub total: usize,
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Re-exported: the probe moved to `state_file` so the policy editor shares it.
pub use crate::state_file::WritableProbe;

/// An opened document, plus everything the editor's header needs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginDocument {
    pub origin_id: String,
    pub name: String,
    pub path: String,
    pub role: OriginRole,
    pub draft: OriginDraft,
    pub base: DraftBase,
    pub writable: WritableProbe,
    /// Whether a passphrase for this origin is in *this* machine's keychain.
    /// The editor needs it to know whether it can resolve a
    /// [`SecretSlot::FromKeychain`] at all, and never receives the value.
    pub has_passphrase: bool,
}

/// What a save did, or why it did nothing.
///
/// A tagged enum rather than an `Err`, because the interesting outcome carries
/// data: a conflict has to hand back the document as it now stands so the editor
/// can show what changed underneath the user instead of asking them to guess.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    /// Boxed for the same reason `Conflict` is: both halves are big, and the
    /// enum's size is the larger of them at every call site.
    Saved(Box<SaveReport>),
    /// Somebody else published while this document was open. Nothing was
    /// written.
    Conflict { document: Box<OriginDocument> },
}

/// The successful half of [`SaveOutcome`].
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    /// The new base, so the editor can keep going without reopening.
    pub base: DraftBase,
    pub revision: u32,
    /// Whether the previous revision was preserved as `<file>.bak`. Best
    /// effort: a `.bak` another user left read-only must not be what stops
    /// today's publish.
    pub backup: bool,
    /// What this save actually did to the team, recomputed from the file that
    /// was on disk — not the preview the dialog showed, which was computed
    /// against a base that may since have moved.
    pub impact: PublishImpact,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Can this machine write `path`?
///
/// Safe to call on any path, including one the user is still typing: every
/// failure is a `reason`, never an error, because "the share is offline" is a
/// state the editor renders rather than a command that failed.
#[tauri::command]
pub fn probe_origin_writable(path: String) -> AppResult<WritableProbe> {
    Ok(state_file::probe_writable(Path::new(&path)))
}

/// This machine's own environments, shaped as bundles the editor can copy into
/// a document.
///
/// Not a read of the document and not a write of anything: it is the *left-hand
/// column* of the environments pane, the same role `list_profiles` plays for the
/// connections one. Without it a publisher composing a file from scratch could
/// only build environments by hand, retyping what they already have configured.
///
/// Membership is resolved by [`crate::commands::prefs::referenced_profile_ids`],
/// the same helper `export_environments` uses, so "which connections does this
/// environment mean" cannot be answered two different ways.
///
/// **A mirrored environment is excluded**, and that is not tidiness. Its
/// identity for every consumer is the publisher's `origin_source_id`, not the
/// local `Environment::id` this would have to publish under — so copying one in
/// would mint a *second* bundle for an environment the document may already
/// carry, and every consumer would end up with two of it. An environment
/// mirrored from a *different* origin is refused for the mirror image of the
/// same reason: two origins claiming one source id is a conflict neither sync
/// can resolve.
#[tauri::command]
pub fn list_publishable_environments(
    state: State<'_, AppState>,
) -> AppResult<Vec<origin_doc::DraftEnvironment>> {
    let guard = state.tab_state.read();
    Ok(guard
        .environments
        .iter()
        .filter(|env| env.origin_id.is_none())
        .map(|env| {
            let mut connection_ids: Vec<String> =
                crate::commands::prefs::referenced_profile_ids(env)
                    .into_iter()
                    .collect();
            // Sorted for the same reason the export sorts them: a stable order
            // makes two documents built from the same environment diff cleanly.
            connection_ids.sort();
            origin_doc::DraftEnvironment {
                // The publisher's own id, exactly as `export_environments`
                // stamps it — and the identity a consumer's sync will match on
                // for as long as this environment is published.
                source_environment_id: env.id.clone(),
                name: env.name.clone(),
                color: env.color.clone(),
                icon: env.icon.clone(),
                theme_id: env.theme_id.clone(),
                connection_ids,
                origins: Vec::new(),
            }
        })
        .collect())
}

/// Open a registered origin's document for editing.
///
/// Works for a consumer too, and deliberately: reading the file you pull from is
/// how you find out what it actually says, and the editor renders read-only
/// (`role`/`writable` say why). An origin whose file does not exist yet opens as
/// an empty document, which is what [`create_origin_document`] leaves behind.
#[tauri::command]
pub fn open_origin_document(
    state: State<'_, AppState>,
    origin_id: String,
) -> AppResult<OriginDocument> {
    let origin = find_origin(&state.tab_state.read(), &origin_id)?;
    load_document(&origin)
}

/// Recompute the publish preview against the file *as it stands on disk*.
///
/// Separate from the save so the editor can show the impact while the user is
/// still deciding — and cheap enough to call on a debounce: it neither decrypts
/// nor writes anything.
#[tauri::command]
pub fn preview_origin_publish(
    state: State<'_, AppState>,
    origin_id: String,
    draft: OriginDraft,
) -> AppResult<PublishImpact> {
    let origin = find_origin(&state.tab_state.read(), &origin_id)?;
    let base = read_file(Path::new(&origin.path))?
        .map(|(file, _, _)| file)
        .unwrap_or_else(empty_document);
    Ok(origin_doc::publish_impact(&draft, &base))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Create an empty document at `path` and register it as an origin this machine
/// publishes.
///
/// Refuses an existing file outright. Adopting one as a publisher is what
/// `update_origin`'s `role` is for — creating must never be a way to overwrite
/// something already on the share.
#[tauri::command]
pub fn create_origin_document(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
    maintainer: Option<String>,
) -> AppResult<Origin> {
    let target = Path::new(path.trim());
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("origin path is empty".into()));
    }
    if target.exists() {
        return Err(AppError::InvalidInput(format!(
            "{path} already exists — register it as an origin and switch its role to publisher instead"
        )));
    }
    let probe = state_file::probe_writable(target);
    if !probe.writable {
        return Err(AppError::InvalidInput(format!(
            "cannot write to {path}: {}",
            probe.reason.unwrap_or_else(|| "unknown reason".into())
        )));
    }

    let mut draft = OriginDraft::default();
    draft.meta.maintainer = maintainer.clone();
    draft.meta.revision = Some(1);
    write_document(target, &draft)?;

    let origin = Origin {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: path.trim().to_string(),
        last_synced_at: None,
        landed_secrets: Default::default(),
        // The one place a publisher role is granted without a separate
        // confirmation, because creating the file *is* the confirmation.
        role: OriginRole::Publisher,
        maintainer,
        // A publisher consumes their own document, in full: keeping the
        // profile ids stable across the round trip is what stops them ending
        // up with two copies of every server (`origin_doc`'s module doc), and
        // that only holds if the slices carrying them are actually pulled.
        scope: Default::default(),
    };
    let created = origin.clone();
    tab_state::mutate(&state.tab_state, |ts| {
        ts.origins.push(origin);
        Ok(())
    })?;
    let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    Ok(created)
}

/// Publish a draft.
///
/// `base` is what the editor read when it opened; the file is re-read and
/// re-hashed here, and a mismatch returns [`SaveOutcome::Conflict`] without
/// writing a byte.
///
/// `passphrase` is only needed when the draft has a [`SecretSlot::FromKeychain`]
/// to resolve or `rotate_from` is set; otherwise the stored one is used and none
/// of this costs anything, because every kept envelope travels verbatim
/// (`crate::origin_doc`'s invariant 3).
///
/// `rotate_from` re-keys the whole document: every kept envelope is decrypted
/// with it and re-encrypted with `passphrase`. It is the one operation that
/// invalidates every consumer's `landed_secrets` cache on purpose, which is why
/// it is an explicit argument rather than something a save can drift into.
///
/// `async fn` with the body on `spawn_blocking` — see the module doc.
// A Tauri command's parameters *are* its wire shape — the frontend passes them
// by name — so the count here is the IPC contract, not a signature that wants a
// struct. Same reason the write paths in `commands::query` carry the allow.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn save_origin_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    origin_id: String,
    draft: OriginDraft,
    base: DraftBase,
    passphrase: Option<String>,
    rotate_from: Option<String>,
) -> AppResult<SaveOutcome> {
    let tab_state_lock = state.tab_state.clone();
    // Cloned into the blocking task so it can report progress from there.
    // `window` itself is only used for its label — see the event's doc.
    let app_for_task = app.clone();
    let window_label = window.label().to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        save_inner(
            &tab_state_lock,
            &origin_id,
            draft,
            base,
            passphrase.as_deref(),
            rotate_from.as_deref(),
            |done, total| {
                let _ = app_for_task.emit_to(
                    &window_label,
                    ORIGIN_PUBLISH_PROGRESS_EVENT,
                    PublishProgress { done, total },
                );
            },
        )
    })
    .await
    .map_err(|e| AppError::Transfer(format!("origin document save task failed: {e}")))?;
    // A conflict wrote nothing and changed no registry field, so it announces
    // nothing — same rule `sync_origin` follows for a failed pull.
    if matches!(outcome, Ok(SaveOutcome::Saved(_))) {
        let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    }
    outcome
}

/// Republish one connection, from the local edit that just corrected it.
///
/// The gap this closes: a publisher who fixed a rotated password in the
/// connection dialog had corrected it for *themselves*. `save_profile` writes
/// `profiles.json` and this machine's keychain and stops there, so the share
/// still carried the old envelope and every consumer still failed to connect
/// until the publisher remembered to open the editor, find the row, flip its
/// secret to `fromKeychain` and publish. Nothing about that sequence is a
/// decision — it is the same intent, expressed twice — so this command is the
/// second half of the first one.
///
/// **Not a shortcut around the editor's rules; the same code path with one row
/// pre-filled.** It re-reads the document, replaces exactly the entry whose
/// `profile.id` matches, and hands the result to [`save_inner`] — so the
/// publisher check, the write probe, the SHA-256 conflict check, the `.bak`
/// and the impact report are all the ones the editor gets. In particular a
/// concurrent publish still comes back as [`SaveOutcome::Conflict`] rather
/// than overwriting; the caller sends the user to the editor to merge, because
/// resolving one is a document-shaped job and this command only knows a row.
///
/// `with_secret` is the whole reason this is not simply "publish the profile".
/// A slot that did not change must travel **verbatim** (ADR #56): a fresh
/// `encrypt_secret` draws a new salt and nonce, which invalidates every
/// consumer's `landed_secrets` fingerprint and costs each of them ~600 000
/// PBKDF2 rounds for a password that is still the same one. So correcting a
/// port republishes with the envelope untouched, and only a password the user
/// actually retyped turns the slot into [`SecretSlot::FromKeychain`].
#[tauri::command]
pub async fn republish_profile_to_origin(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    origin_id: String,
    profile_id: String,
    with_secret: bool,
    passphrase: Option<String>,
) -> AppResult<SaveOutcome> {
    let tab_state_lock = state.tab_state.clone();
    let profiles_lock = state.profiles.clone();
    let app_for_task = app.clone();
    let window_label = window.label().to_string();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let origin = find_origin(&tab_state_lock.read(), &origin_id)?;
        let document = load_document(&origin)?;
        let profile = profiles_lock
            .read()
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("profile {profile_id}")))?;

        let mut draft = document.draft;
        if !origin_doc::replace_connection(&mut draft, profile, with_secret) {
            // Reachable: the profile still carries the tag of an origin whose
            // document has since dropped it. Publishing it back would silently
            // re-add a connection somebody deliberately removed, so say so
            // instead and let the editor stay the place a connection is *added*
            // to a document.
            return Err(AppError::InvalidInput(format!(
                "{:?} does not publish this connection any more — add it back from the origin editor if that is what you meant",
                origin.name
            )));
        }

        save_inner(
            &tab_state_lock,
            &origin_id,
            draft,
            document.base,
            passphrase.as_deref(),
            None,
            |done, total| {
                let _ = app_for_task.emit_to(
                    &window_label,
                    ORIGIN_PUBLISH_PROGRESS_EVENT,
                    PublishProgress { done, total },
                );
            },
        )
    })
    .await
    .map_err(|e| AppError::Transfer(format!("origin republish task failed: {e}")))?;
    if matches!(outcome, Ok(SaveOutcome::Saved(_))) {
        let _ = app.emit(ORIGINS_CHANGED_EVENT, ());
    }
    outcome
}

fn save_inner(
    tab_state_lock: &Arc<RwLock<PersistedTabState>>,
    origin_id: &str,
    mut draft: OriginDraft,
    base: DraftBase,
    passphrase: Option<&str>,
    rotate_from: Option<&str>,
    on_progress: impl Fn(usize, usize),
) -> AppResult<SaveOutcome> {
    let origin = find_origin(&tab_state_lock.read(), origin_id)?;
    if origin.role != OriginRole::Publisher {
        return Err(AppError::InvalidInput(format!(
            "origin {:?} is registered as a consumer — switch its role to publisher before editing it",
            origin.name
        )));
    }
    let path = Path::new(&origin.path);
    let probe = state_file::probe_writable(path);
    if !probe.writable {
        return Err(AppError::InvalidInput(format!(
            "cannot write to {}: {}",
            origin.path,
            probe.reason.unwrap_or_else(|| "unknown reason".into())
        )));
    }

    // Re-read *now*, not from whatever the editor cached: the whole
    // optimistic-concurrency story is this comparison.
    let current = read_file(path)?;
    let current_hash = current.as_ref().map(|(_, hash, _)| hash.as_str());
    if current_hash.unwrap_or_default() != base.sha256 {
        return Ok(SaveOutcome::Conflict {
            document: Box::new(load_document(&origin)?),
        });
    }
    let base_file = current
        .map(|(file, _, _)| file)
        .unwrap_or_else(empty_document);

    // Resolving and rotating both need the passphrase; a document with neither
    // is published without one being asked for.
    let effective = match passphrase {
        Some(p) => Some(p.to_string()),
        None => keychain::get_password(&crate::commands::origins::passphrase_account(origin_id))?,
    };
    resolve_secrets(&mut draft, effective.as_deref(), rotate_from, on_progress)?;

    draft.meta.revision = Some(base.revision.saturating_add(1));
    let impact = origin_doc::publish_impact(&draft, &base_file);

    let backup = state_file::backup_previous(path).unwrap_or(false);
    let bytes = write_document(path, &draft)?;

    // A rotation is only committed to the keychain once the file that needs it
    // is actually on the share. The other order leaves this machine holding a
    // passphrase that decrypts nothing.
    if rotate_from.is_some() {
        match effective.as_deref() {
            Some(new) => keychain::set_password(
                &crate::commands::origins::passphrase_account(origin_id),
                new,
            )?,
            None => {
                return Err(AppError::InvalidInput(
                    "a new passphrase is required in order to rotate one".into(),
                ))
            }
        }
    }

    let new_base = DraftBase {
        sha256: state_file::sha256_hex(&bytes),
        mtime: state_file::mtime_of(path),
        revision: draft.meta.revision.unwrap_or_default(),
    };
    let maintainer = draft.meta.maintainer.clone();
    tab_state::mutate(tab_state_lock, |ts| {
        if let Some(o) = ts.origins.iter_mut().find(|o| o.id == origin_id) {
            o.maintainer = maintainer;
        }
        Ok(())
    })?;

    Ok(SaveOutcome::Saved(Box::new(SaveReport {
        base: new_base,
        revision: draft.meta.revision.unwrap_or_default(),
        backup,
        impact,
    })))
}

/// Turn every slot that is not already a verbatim envelope into one.
///
/// Two jobs, both expensive and both deliberate:
///
/// * [`SecretSlot::FromKeychain`] — a connection the publisher just added.
///   Delegated to [`transfer::build_exported_profiles`] rather than reading the
///   keychain here, so the SQLite rule (a file path has no DB password) and the
///   SSH-account rule stay in the one place that already owns them.
/// * `rotate_from` — the passphrase changed, so every kept envelope has to be
///   decrypted with the old one and re-encrypted with the new. This is the
///   operation that invalidates the whole team's `landed_secrets` cache; it is
///   never implicit.
///
/// A slot with nothing behind it is left alone: `build_origin_file` publishes no
/// secret for it, and the consumer is asked for a password. Inventing an empty
/// envelope instead would make the file's header claim encryption it does not
/// carry.
fn resolve_secrets(
    draft: &mut OriginDraft,
    passphrase: Option<&str>,
    rotate_from: Option<&str>,
    on_progress: impl Fn(usize, usize),
) -> AppResult<()> {
    let needs_work = |slot: &SecretSlot| {
        matches!(slot, SecretSlot::FromKeychain)
            || (rotate_from.is_some() && matches!(slot, SecretSlot::Keep { .. }))
    };
    // Counted before the loop, and only over the slots that actually derive a
    // key: a document of verbatim envelopes reports nothing, which is what
    // makes "no bar" mean "there was nothing slow to wait for" rather than
    // "progress was not wired up".
    let total = draft
        .connections
        .iter()
        .filter(|c| needs_work(&c.secret))
        .count();
    if total == 0 {
        return Ok(());
    }
    let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
        return Err(AppError::InvalidInput(
            "this document publishes passwords, so it needs a passphrase to encrypt them with"
                .into(),
        ));
    };

    let mut done = 0usize;
    for conn in &mut draft.connections {
        // Reported *before* the derivation, not after: the first slot is as slow
        // as the rest, so emitting afterwards would leave the bar unpainted for
        // the whole of it — the one stretch the user most needs to see.
        // Connections that need no work are skipped without a tick, so the
        // denominator stays what it promised.
        if needs_work(&conn.secret) {
            on_progress(done, total);
            done += 1;
        }
        match &conn.secret {
            SecretSlot::FromKeychain => {
                conn.secret = match from_keychain(&conn.profile, pass)? {
                    Some(envelope) => SecretSlot::Keep { envelope },
                    None => SecretSlot::Clear,
                };
            }
            SecretSlot::Keep { envelope } if rotate_from.is_some() => {
                let old = rotate_from.unwrap_or_default();
                conn.secret = SecretSlot::Keep {
                    envelope: rekey(envelope, old, pass)?,
                };
            }
            SecretSlot::Keep { .. } | SecretSlot::Clear => {}
        }
    }
    on_progress(total, total);
    Ok(())
}

fn from_keychain(
    profile: &ConnectionProfile,
    passphrase: &str,
) -> AppResult<Option<ExportedSecret>> {
    let exported =
        transfer::build_exported_profiles(std::slice::from_ref(profile), true, Some(passphrase))?;
    Ok(exported
        .into_iter()
        .next()
        .and_then(|e| e.secrets)
        .filter(|s| s.db_password.is_some() || s.ssh_secret.is_some()))
}

fn rekey(envelope: &ExportedSecret, old: &str, new: &str) -> AppResult<ExportedSecret> {
    let re = |blob: &Option<String>| -> AppResult<Option<String>> {
        match blob {
            None => Ok(None),
            Some(b) => Ok(Some(transfer::encrypt_secret(
                &transfer::decrypt_secret(b, old)?,
                new,
            )?)),
        }
    };
    Ok(ExportedSecret {
        db_password: re(&envelope.db_password)?,
        ssh_secret: re(&envelope.ssh_secret)?,
    })
}

// ---------------------------------------------------------------------------
// File plumbing
// ---------------------------------------------------------------------------

fn find_origin(state: &PersistedTabState, id: &str) -> AppResult<Origin> {
    state
        .origins
        .iter()
        .find(|o| o.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("no origin with id {id}")))
}

/// The document an origin whose file does not exist yet is edited as.
///
/// `kind` matters: a document is always an environment export, even when it
/// carries nothing but loose connections, so a consumer's `sync_origin` reads
/// its `environments` array instead of silently ignoring it.
fn empty_document() -> EnvironmentExportFile {
    origin_doc::build_origin_file(&OriginDraft::default(), "")
}

/// Read and parse the document, returning it with the hash and mtime the
/// concurrency check needs. `Ok(None)` when the file does not exist — a
/// publisher who has not saved yet, which is a state and not a failure.
fn read_file(path: &Path) -> AppResult<Option<(EnvironmentExportFile, String, Option<String>)>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::InvalidInput(format!("cannot read {path:?}: {e}")))?;
    let file: EnvironmentExportFile = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::Transfer(format!(
            "{path:?} is not a HuginnDB environment document: {e}"
        ))
    })?;
    transfer::check_meta(&file.meta, KIND_ENVIRONMENT)?;
    Ok(Some((
        file,
        state_file::sha256_hex(&bytes),
        state_file::mtime_of(path),
    )))
}

fn load_document(origin: &Origin) -> AppResult<OriginDocument> {
    let path = Path::new(&origin.path);
    let (draft, base) = match read_file(path)? {
        Some((file, hash, mtime)) => {
            let revision = file.meta.revision.unwrap_or_default();
            (
                origin_doc::draft_from_file(file),
                DraftBase {
                    sha256: hash,
                    mtime,
                    revision,
                },
            )
        }
        // An empty base hash is how "there is no file yet" is spelled, and it
        // is what a first save compares against.
        None => (
            OriginDraft::default(),
            DraftBase {
                sha256: String::new(),
                mtime: None,
                revision: 0,
            },
        ),
    };
    Ok(OriginDocument {
        origin_id: origin.id.clone(),
        name: origin.name.clone(),
        path: origin.path.clone(),
        role: origin.role,
        draft,
        base,
        writable: state_file::probe_writable(path),
        has_passphrase: keychain::get_password(&crate::commands::origins::passphrase_account(
            &origin.id,
        ))
        .ok()
        .flatten()
        .is_some(),
    })
}

/// Serialise and publish, returning the exact bytes written so the caller can
/// hash what is now on disk rather than re-reading it (and racing itself).
fn write_document(path: &Path, draft: &OriginDraft) -> AppResult<Vec<u8>> {
    let file = origin_doc::build_origin_file(draft, &chrono::Utc::now().to_rfc3339());
    let bytes = serde_json::to_vec_pretty(&file)?;
    state_file::write_atomic(path, &bytes)?;
    Ok(bytes)
}
