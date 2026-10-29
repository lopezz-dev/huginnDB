//! Import/Export of connection profiles.
//!
//! Handles the on-disk format for `.json` profile bundles and the optional
//! AES-256-GCM encryption of individual secrets when the user opts to include
//! passwords in the export.
//!
//! ## File format (version 1)
//!
//! ```json
//! {
//!   "meta": { "version": 1, "app": "huginndb", "exported_at": "...", "encrypted": false },
//!   "profiles": [
//!     {
//!       "id": "...",
//!       "name": "...",
//!       ...connection profile fields...,
//!       "secrets": null
//!     }
//!   ]
//! }
//! ```
//!
//! When `meta.encrypted = true` every `secrets` object contains base64-encoded
//! ciphertext blobs. Each blob carries its own random salt and nonce so that
//! different profiles (or even the same profile's DB vs SSH secret) can be
//! decrypted independently even if the file is partially corrupted.
//!
//! ## Encryption scheme
//!
//! Each secret value is encrypted as:
//!   `base64( salt[16] || nonce[12] || AES-256-GCM(plaintext) )`
//!
//! The 256-bit AES key is derived with PBKDF2-HMAC-SHA256 at 600 000
//! iterations (NIST SP 800-132 minimum for interactive use).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::json_schemas::{JsonSchemaBinding, JsonSchemaItem};
use crate::keychain;
use crate::state::{ConnectionProfile, Driver};

// ---------------------------------------------------------------------------
// File-format types
// ---------------------------------------------------------------------------

/// Top-level wrapper for the exported JSON file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportFile {
    pub meta: ExportMetadata,
    pub profiles: Vec<ExportedProfile>,
}

/// Metadata header describing the file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportMetadata {
    /// Always `1` for this version of the format.
    pub version: u8,
    /// Constant `"huginndb"` — lets importers from other tools detect the origin.
    pub app: String,
    /// RFC 3339 timestamp of when the file was written.
    pub exported_at: String,
    /// `true` when `ExportedSecret` values are AES-256-GCM ciphertext;
    /// `false` when `secrets` is `null` for every profile.
    pub encrypted: bool,
    /// `"profiles"` (a plain profile bundle) or `"environment"` (an
    /// [`EnvironmentExportFile`]). `#[serde(default)]` so a pre-existing
    /// profile-bundle file — written before this field existed — loads as
    /// `""`, which every `kind` check below treats the same as `"profiles"`.
    /// Lets `import_profiles` refuse an environment file (and vice versa)
    /// with a clear error instead of silently importing half of it.
    #[serde(default)]
    pub kind: String,
    /// Who curates the file, when it is a shared origin's *document* rather
    /// than a one-shot export (`crate::origin_doc`). Display copy for the
    /// humans pulling it — nothing in the sync path resolves against it, and
    /// it grants no permission: what stops two publishers clobbering each
    /// other is the content hash the editor compares on save.
    ///
    /// `skip_serializing_if` keeps a plain `export_profiles` /
    /// `export_environments` file byte-identical to a pre-1.19 one, which is
    /// also what makes the origin editor's round trip exact for a file it did
    /// not write itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintainer: Option<String>,
    /// Monotonic revision the publisher bumps. `None` (a file written by an
    /// export command, or before this field existed) is deliberately distinct
    /// from `Some(0)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
    /// Free-text note about this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A profile bundle's `meta.kind` — also the default for a legacy file that
/// predates the field.
pub const KIND_PROFILES: &str = "profiles";
/// An [`EnvironmentExportFile`]'s `meta.kind`.
pub const KIND_ENVIRONMENT: &str = "environment";
/// A [`JsonSchemaExportFile`]'s `meta.kind`.
pub const KIND_JSON_SCHEMAS: &str = "json-schemas";

/// One profile entry inside the export file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedProfile {
    /// All non-sensitive metadata. Flattened so the JSON shape is a superset
    /// of the regular `profiles.json` entry.
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    /// `None` when the file was exported without passwords.
    /// When present, each field is either `None` (no secret exists for that
    /// slot) or a base64-encoded ciphertext.
    pub secrets: Option<ExportedSecret>,
}

/// Optional secret payload attached to an exported profile.
///
/// `Clone` because `crate::origin_doc::SecretSlot::Keep` carries one and copies
/// it into the file it builds byte for byte — re-encrypting would invalidate
/// every consumer's `landed_secrets` cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedSecret {
    /// DB password ciphertext, or `None` if the profile has no DB password.
    pub db_password: Option<String>,
    /// SSH secret (password or key passphrase) ciphertext, or `None`.
    pub ssh_secret: Option<String>,
}

// ---------------------------------------------------------------------------
// Analysis / import result types (returned to the frontend as DTOs)
// ---------------------------------------------------------------------------

/// Summary returned by `analyze_import_file` so the UI can present the user
/// with a conflict-resolution step before committing to the import.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportAnalysis {
    /// Total number of profiles in the file.
    pub total: usize,
    /// Whether the file contains encrypted secrets (requires a passphrase).
    pub encrypted: bool,
    /// Profiles whose `id` already exists in the current profile list.
    pub conflicts: Vec<ImportConflict>,
}

/// One conflicting profile.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportConflict {
    /// The `id` shared by both the existing and incoming profile.
    pub id: String,
    pub existing_name: String,
    pub incoming_name: String,
}

/// Per-conflict action chosen by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictAction {
    /// Replace the existing profile (and its keychain entries) with the
    /// imported one. A fresh UUID is generated for the imported copy so
    /// keychain accounts don't collide.
    Overwrite,
    /// Skip this profile entirely.
    Skip,
    /// Import as a new profile with an auto-generated name suffix.
    Rename,
}

/// Caller-supplied resolution for one conflict.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConflictResolution {
    pub id: String,
    pub action: ConflictAction,
}

/// Summary returned to the frontend after `import_profiles` completes.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    /// Ids (post-UUID-remapping) of profiles that were added successfully.
    pub imported: Vec<String>,
    /// Original ids of profiles that were skipped.
    pub skipped: Vec<String>,
    /// `(original_name, new_name)` pairs for profiles that were renamed to
    /// avoid duplicate display names.
    pub renamed: Vec<(String, String)>,
    /// Ids of imported profiles that arrived without passwords and will
    /// need manual credential setup before they can connect.
    pub needs_password: Vec<String>,
}

// ---------------------------------------------------------------------------
// Environment export/import
// ---------------------------------------------------------------------------
//
// An environment's *portable* identity is its name/color/icon/theme, the
// connection profiles it groups, and the shared origins those connections (or
// the environment's own mirror, if it's one) depend on — not its tabs,
// dockview geometry or launch state. Those are session artifacts
// tied to the machine that produced them (ADR #10: the inner
// dockview's geometry is a JSON blob keyed to panel ids from that machine's
// `useTabs`), so portability stops at "which connections, from where".
//
// A single export can bundle **more than one** environment — the picker lets
// the user select any subset — so the file format is one file, N environment
// bundles, and one deduplicated pool of connection profiles the bundles
// reference by id (see `EnvironmentExportFile`'s doc for why they're not
// duplicated per environment).
//
// Importing an environment always creates a **new** one — never merges into
// an existing one — so there is nothing for its origins or cosmetic fields to
// conflict with. The only genuine conflict is at the connection-profile layer
// (`profiles.json` is global), which is why this reuses the exact
// `ImportConflict` / `ConflictAction` / `ImportResult` machinery `import_profiles`
// already has, rather than inventing a parallel one.

/// Top-level wrapper for one or more exported environments. Shares
/// [`ExportMetadata`] with [`ExportFile`] (with `meta.kind` set to
/// [`KIND_ENVIRONMENT`]) so both formats carry the same version/encryption
/// header.
///
/// `profiles` is a single **deduplicated** union of every connection profile
/// referenced by any environment in `environments` — not one copy per
/// environment. Two exported environments sharing a connection (a common
/// "Producción" + "Staging" split against the same jump-box server) would
/// otherwise duplicate that profile, its secrets, and — on import — its
/// keychain entry. Each bundle instead lists which of the shared `profiles`
/// it references by id, resolved back into that environment's
/// `launch.visible_connections` after import (`connection_ids` names
/// *original* ids, the same ones `ExportedProfile.profile.id` carries; the
/// map from original id to post-import fresh id is threaded through
/// `apply_profile_imports`'s second return value).
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentExportFile {
    pub meta: ExportMetadata,
    pub environments: Vec<ExportedEnvironmentBundle>,
    pub profiles: Vec<ExportedProfile>,
    /// Optional JSON Schema library slice, present when the user ticked
    /// "include JSON Schemas".
    ///
    /// Schemas are **global**, not owned by an environment (see
    /// [`crate::json_schemas`]), so this is not part of an environment's
    /// portable identity the way `origins` and `connection_ids` are — it rides
    /// along so one file can set up a new machine. `#[serde(default)]` so every
    /// file written before 1.17.0 still loads, and `skip_serializing_if` so an
    /// export without them stays byte-identical to a 1.16 one.
    #[serde(default, skip_serializing_if = "JsonSchemaBundle::is_empty")]
    pub json_schemas: JsonSchemaBundle,
}

/// The portable JSON Schema payload.
///
/// One type with three homes: flattened into a standalone
/// [`JsonSchemaExportFile`], carried by [`EnvironmentExportFile`], and — from
/// 1.18.0 — by the plain [`ExportFile`] a shared origin publishes. That reuse is
/// what makes the origin work purely additive: one `#[serde(default)]` field.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JsonSchemaBundle {
    #[serde(default)]
    pub schemas: Vec<JsonSchemaItem>,
    #[serde(default)]
    pub bindings: Vec<JsonSchemaBinding>,
}

impl JsonSchemaBundle {
    pub fn is_empty(&self) -> bool {
        self.schemas.is_empty() && self.bindings.is_empty()
    }
}

/// A standalone schema-library export.
///
/// No passphrase and no `encrypted` payload: a JSON Schema is not a secret and
/// there is no keychain material anywhere in it, so [`ExportMetadata::encrypted`]
/// is always `false` here.
#[derive(Debug, Serialize, Deserialize)]
pub struct JsonSchemaExportFile {
    pub meta: ExportMetadata,
    #[serde(flatten)]
    pub bundle: JsonSchemaBundle,
}

/// Summary returned by `analyze_json_schema_import`, so the wizard can show
/// what a file holds — and what it will have to disable — before committing.
#[derive(Debug, Serialize, Deserialize)]
pub struct JsonSchemaImportAnalysis {
    pub total_schemas: usize,
    pub total_bindings: usize,
    /// Schemas in the file whose **name** already exists locally. Keyed on the
    /// name rather than the id, unlike [`detect_conflicts`] — see
    /// [`crate::json_schemas::JsonSchemaItem::name`] for why an id can never
    /// collide here and a name always will.
    pub conflicts: Vec<ImportConflict>,
    /// How many bindings would land disabled because they name a connection
    /// this machine does not have. Reported up front so the count is not a
    /// surprise buried in the result.
    pub bindings_unresolvable: usize,
}

/// Outcome of `import_json_schemas`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JsonSchemaImportResult {
    /// Names of schemas added as new entries.
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub overwritten: Vec<String>,
    /// `(original name, stored name)` for each renamed entry.
    pub renamed: Vec<(String, String)>,
    pub bindings_imported: usize,
    /// Imported with `enabled: false` because their connection is unknown here.
    pub bindings_disabled: usize,
    /// Dropped because the schema they point at was skipped.
    pub bindings_dropped: usize,
    /// Not inserted because an identical rule already existed.
    pub bindings_duplicate: usize,
}

/// One environment's slice of an [`EnvironmentExportFile`]: its cosmetic
/// identity, which of the file's shared `profiles` it groups, and the origins
/// those connections (or the environment's own mirror) depend on.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEnvironmentBundle {
    pub environment: ExportedEnvironment,
    /// Ids into the sibling `EnvironmentExportFile::profiles` list.
    pub connection_ids: Vec<String>,
    /// Derived at export time from the global origin registry
    /// (`commands::origins`'s module doc) — not copied verbatim from the
    /// environment, which doesn't own any of its own any more (tab_state.json
    /// v5). See `export_environments`.
    pub origins: Vec<ExportedOrigin>,
}

/// The environment's cosmetic identity. Deliberately has no portable `id`:
/// the one-shot `import_environment` always mints a fresh one, since it never
/// merges into an existing environment (see the module-level note above).
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedEnvironment {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub theme_id: Option<String>,
    /// The publisher's own `Environment.id` at export time. `import_environment`
    /// ignores this field on purpose — it always mints a fresh local id. It
    /// exists for the *other* consumer of this file shape: an origin (#108)
    /// registered against a `kind = "environment"` export, whose continuous
    /// `sync_origin` pull needs a stable way to recognise "the same" bundle
    /// across repeated syncs (`tab_state::Environment::origin_source_id`).
    /// `#[serde(default)]` so a file exported before this field existed still
    /// parses — it just can never be matched by the sync path, only imported
    /// once.
    #[serde(default)]
    pub source_environment_id: String,
}

/// A shared origin's *registration* — name and path only, never its
/// passphrase. Mirrors the threat model `origins.rs` already documents: the
/// passphrase travels out-of-band (the admin tells the new hire), never
/// through a file. An imported encrypted origin surfaces the same "no
/// passphrase stored" state a freshly `add_origin`-ed one does until the user
/// enters it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedOrigin {
    pub name: String,
    pub path: String,
}

/// Summary returned by `analyze_environment_import`. Mirrors [`ImportAnalysis`]
/// but scoped to what an environment import needs decided up front — one
/// entry per environment in the file, plus the conflicts and encryption flag
/// that apply to the file's shared `profiles` as a whole.
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentImportAnalysis {
    pub environments: Vec<EnvironmentImportAnalysisEntry>,
    pub total_profiles: usize,
    pub encrypted: bool,
    pub conflicts: Vec<ImportConflict>,
    /// How many JSON Schemas ride along in this file, for display only. Schema
    /// name conflicts are resolved by the *same* `conflict_resolutions` list as
    /// the profiles, keyed by the incoming schema id, so they need no separate
    /// step in the wizard.
    #[serde(default)]
    pub total_json_schemas: usize,
    #[serde(default)]
    pub total_json_schema_bindings: usize,
}

/// Display summary for one environment inside an
/// [`EnvironmentImportAnalysis`] — enough for the picker to show what each
/// one is without decrypting or importing anything yet.
///
/// `camelCase` on the wire (unlike its parent [`EnvironmentImportAnalysis`],
/// which keeps `total_profiles` etc. snake_case): the frontend's
/// `EnvironmentImportAnalysisEntry` in `src/types.ts` was written expecting
/// `connectionCount`, and nothing round-trips this type through disk, so
/// there is no old file format to stay compatible with.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentImportAnalysisEntry {
    pub name: String,
    pub connection_count: usize,
    /// For display only ("N shared origins will be registered") — origins
    /// never conflict, since import always lands in a brand-new environment.
    pub origins: Vec<ExportedOrigin>,
}

/// Result of `import_environment` — one new environment per bundle in the
/// file, plus the shared profile-import outcome (imported/skipped/renamed
/// apply across the whole file, not per environment, since `profiles` is a
/// single deduplicated list).
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentImportResult {
    pub environments: Vec<ImportedEnvironment>,
    pub profiles: ImportResult,
    /// Present only when the file carried a JSON Schema bundle. `None` is
    /// meaningfully different from a zeroed result: it means the exporter did
    /// not tick the box, so the UI says nothing rather than "0 schemas".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_schemas: Option<JsonSchemaImportResult>,
}

/// One environment created by `import_environment`.
///
/// `camelCase` on the wire, matching `src/types.ts`'s `environmentId` /
/// `originIds` — this DTO is a command return value, never read back from a
/// file, so there is no on-disk format to keep snake_case for (contrast
/// [`EnvironmentImportResult::json_schemas`], which deliberately stays
/// snake_case one level up).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEnvironment {
    pub environment_id: String,
    pub name: String,
    /// Ids of the origins registered in this environment, in file order.
    pub origin_ids: Vec<String>,
}

/// Human name for a `meta.kind`, for the one error message that has to name
/// both the file the user picked and the importer they picked it in.
fn kind_label(kind: &str) -> &'static str {
    match kind {
        KIND_ENVIRONMENT => "environment",
        KIND_JSON_SCHEMAS => "JSON Schema",
        // `""` is a pre-`kind` profile bundle; see [`KIND_PROFILES`].
        _ => "profile",
    }
}

/// Reject an export file whose `meta` this importer cannot read.
///
/// Both checks were spelled out at four call sites across three modules, and
/// the `kind` half is the one that matters: `serde_json` silently ignores
/// unknown fields, so an environment export fed to the profile importer used
/// to parse *fine* and quietly contribute nothing but its `profiles` array.
/// `""` counts as [`KIND_PROFILES`] — files written before the discriminant
/// existed have no `kind` at all.
pub fn check_meta(meta: &ExportMetadata, expected: &str) -> AppResult<()> {
    if meta.version != 1 {
        return Err(AppError::Transfer(format!(
            "unsupported export format version {}",
            meta.version
        )));
    }
    let actual = if meta.kind.is_empty() {
        KIND_PROFILES
    } else {
        meta.kind.as_str()
    };
    if actual != expected {
        return Err(AppError::Transfer(format!(
            "this file is a {} export, not a {} one",
            kind_label(actual),
            kind_label(expected)
        )));
    }
    Ok(())
}

/// The `meta` block every export file carries. `app` and `version` are fixed;
/// the three writers differed only in `kind` and `encrypted`.
pub fn metadata(kind: &str, encrypted: bool, exported_at: &str) -> ExportMetadata {
    ExportMetadata {
        version: 1,
        app: "huginndb".into(),
        exported_at: exported_at.to_string(),
        encrypted,
        kind: kind.into(),
        // The export commands publish no document metadata; the origin editor
        // sets these itself after calling this (see
        // `crate::origin_doc::build_origin_file`).
        maintainer: None,
        revision: None,
        note: None,
    }
}

/// Ask the user where to put an export, write it there, return the path.
///
/// The tail of all three export commands: a native save dialog filtered to
/// `.json`, a cancel mapped to [`crate::error::EXPORT_CANCELLED`] (which the
/// frontend special-cases into "nothing happened" rather than an error toast),
/// and the write.
pub fn save_export(
    app: &tauri::AppHandle,
    title: &str,
    suggested_name: &str,
    json: &str,
) -> AppResult<String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(suggested_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer(crate::error::EXPORT_CANCELLED.into()))?;
    let dest = path.to_string();
    std::fs::write(&dest, json)?;
    Ok(dest)
}

/// Disambiguate `base` against `taken`: `name`, `name (imported)`,
/// `name (2)`, `name (3)`, …
///
/// Every importer needs this and two had grown their own. The profile
/// importer's inline copy jumped straight from `(imported)` to `(3)` — it
/// reused one suffix counter for both rungs — so a third collision was named
/// `(3)` with no `(2)` anywhere. This is the JSON Schema importer's ladder,
/// which was the tested one and the one its doc comment claimed both used.
pub fn disambiguate_name<'a>(base: &str, taken: impl Iterator<Item = &'a str>) -> String {
    let used: std::collections::HashSet<&str> = taken.collect();
    if !used.contains(base) {
        return base.to_string();
    }
    let first = format!("{base} (imported)");
    if !used.contains(first.as_str()) {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if !used.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// Profiles in `incoming` whose `id` already exists in `existing`. Shared by
/// `analyze_import_file` and `analyze_environment_import` — the conflict rule
/// (same id, different bundle) doesn't care which command found it.
pub fn detect_conflicts(
    existing: &[ConnectionProfile],
    incoming: &[ExportedProfile],
) -> Vec<ImportConflict> {
    incoming
        .iter()
        .filter_map(|ep| {
            existing
                .iter()
                .find(|p| p.id == ep.profile.id)
                .map(|found| ImportConflict {
                    id: ep.profile.id.clone(),
                    existing_name: found.name.clone(),
                    incoming_name: ep.profile.name.clone(),
                })
        })
        .collect()
}

/// Build the `profiles` section of an export file: snapshot each profile's
/// metadata and, when `include_passwords` is set, its keychain secrets
/// encrypted with `passphrase`. Shared by `export_profiles` and
/// `export_environment` — same rules either way, just a different subset of
/// profiles feeding in.
pub fn build_exported_profiles(
    profiles: &[ConnectionProfile],
    include_passwords: bool,
    passphrase: Option<&str>,
) -> AppResult<Vec<ExportedProfile>> {
    let mut exported = Vec::with_capacity(profiles.len());
    for profile in profiles {
        // A person's own database user is theirs, not the file's: it is
        // never exported (and `merge_into` / the import clear it anyway).
        let mut out = ConnectionProfile {
            personal_username: None,
            ..profile.clone()
        };
        // A MongoDB password inside the connection string never reaches the
        // file in clear: it rides in the encrypted slot when passwords are
        // exported, and is dropped when they are not. The save path already
        // keeps it out of `profiles.json`; this covers a profile that predates
        // that and has not been swept yet.
        let embedded = crate::credentials::take_embedded_password(&mut out);
        let secrets = if include_passwords {
            let pp = passphrase.ok_or_else(|| {
                AppError::InvalidInput(
                    "a passphrase is required when include_passwords is true".into(),
                )
            })?;
            let db_password = if matches!(profile.driver, Driver::Sqlite) {
                None
            } else {
                // The URI's password first: it is the one the driver signs in
                // with when both exist.
                match embedded {
                    Some(pw) => Some(pw),
                    None => keychain::get_password(&profile.keyring_account())?,
                }
                .map(|pw| encrypt_secret(&pw, pp))
                .transpose()?
            };
            let ssh_secret = profile
                .ssh_keyring_account()
                .and_then(|acct| keychain::get_password(&acct).ok().flatten())
                .map(|s| encrypt_secret(&s, pp))
                .transpose()?;
            Some(ExportedSecret {
                db_password,
                ssh_secret,
            })
        } else {
            None
        };
        exported.push(ExportedProfile {
            profile: out,
            secrets,
        });
    }
    Ok(exported)
}

/// How a caller wants a per-profile secret-landing failure handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandMode {
    /// Propagate the first failure. The interactive importer uses this: the
    /// user picked the file and typed the passphrase in this very dialog, so a
    /// wrong passphrase has to be reported rather than silently producing a
    /// pile of connections that cannot authenticate.
    Strict,
    /// Swallow per-profile failures and keep going. The shared-origin sync uses
    /// this: it runs unattended (launch, the 4-hourly poll), and one
    /// undecryptable profile must not abort a whole pass over the origin.
    BestEffort,
}

/// Decrypt `secrets` and land them in *this* machine's keychain for `profile`.
///
/// Returns `true` when at least one secret was actually stored, which is what
/// both callers use to decide whether the profile still needs a password from
/// the user.
///
/// Two rules are load-bearing, and used to be spelled differently in the two
/// call sites — which is how the second one grew a bug:
///
/// * **Every value in an [`ExportedSecret`] is ciphertext, always.**
///   [`build_exported_profiles`] refuses to export secrets without a
///   passphrase and runs each one through [`encrypt_secret`], and
///   `ExportMetadata::encrypted` is set to the same `include_passwords` flag —
///   so "secrets present" and "secrets encrypted" are the same condition and
///   there is no plaintext path to fall back to. A missing passphrase
///   therefore means *"this secret cannot be recovered here"*, never *"the
///   blob is the password"*. Storing the base64 envelope is precisely the
///   failure this function exists to make unrepresentable: the connection then
///   fails to authenticate with an opaque driver error, and because the
///   keychain entry looks perfectly valid the bad secret survives every
///   restart with nothing pointing at the cause.
/// * **SQLite has no DB password.** A file path needs no credential, so that
///   slot is skipped for it — matching the export side, which never writes one.
///   An SSH secret is still landed, since a SQLite file can sit behind a
///   tunnel.
pub fn land_secrets(
    profile: &ConnectionProfile,
    secrets: &ExportedSecret,
    passphrase: Option<&str>,
    mode: LandMode,
) -> AppResult<bool> {
    let mut stored = false;

    // `None` is deliberately *not* folded into `Some("")`: an empty passphrase
    // is a passphrase the user could have typed, whereas absent means we were
    // never given one. Both fail to decrypt, but keeping them distinct is what
    // stops a future edit from reintroducing a "no passphrase → use the blob"
    // shortcut.
    for (account, blob) in secret_slots(profile, secrets) {
        let plain = match passphrase {
            Some(pass) => decrypt_secret(blob, pass),
            None => Err(AppError::Transfer(
                "the export carries encrypted secrets but no passphrase was supplied".into(),
            )),
        };
        match (plain, mode) {
            (Ok(pw), _) => {
                keychain::set_password(&account, &pw)?;
                stored = true;
            }
            (Err(e), LandMode::Strict) => return Err(e),
            // Leave the slot empty. The caller reports the profile as needing a
            // password, which is a state the UI already knows how to surface.
            (Err(_), LandMode::BestEffort) => {}
        }
    }

    Ok(stored)
}

/// The keychain accounts an [`ExportedSecret`] lands for `profile`, paired with
/// the ciphertext each one carries.
///
/// The **one** definition of which slots an exported secret covers, including
/// the SQLite rule: a file path needs no credential, so that slot is skipped
/// for it — matching the export side, which never writes one. An SSH secret is
/// still landed, since a SQLite file can sit behind a tunnel.
///
/// Extracted because [`land_secrets`] is no longer the only caller: the origin
/// sync needs the same list to ask "is every account this secret covers still
/// in the keychain?" before it decides it can skip the (very expensive)
/// decryption. Re-deriving that rule at the second call site is exactly how
/// this function's own doc says the first bug got in.
pub fn secret_slots<'a>(
    profile: &ConnectionProfile,
    secrets: &'a ExportedSecret,
) -> Vec<(String, &'a str)> {
    let mut slots = Vec::new();
    if let Some(blob) = &secrets.db_password {
        if !matches!(profile.driver, Driver::Sqlite) {
            slots.push((profile.keyring_account(), blob.as_str()));
        }
    }
    if let Some(blob) = &secrets.ssh_secret {
        if let Some(account) = profile.ssh_keyring_account() {
            slots.push((account, blob.as_str()));
        }
    }
    slots
}

/// Stable fingerprint of the ciphertext an [`ExportedSecret`] carries.
///
/// Lets the origin sync recognise a secret it has already decrypted and landed,
/// and skip doing it again — see `commands::origins::already_landed`. Hashing
/// the *ciphertext* is what keeps this cheap and safe: no plaintext is involved
/// and no key is derived, so it costs microseconds against the ~600 000 PBKDF2
/// rounds it avoids.
///
/// Note what it does **not** buy. [`encrypt_secret`] draws a fresh salt and
/// nonce every time, so re-exporting the same password yields a different
/// blob and a different fingerprint. This makes an *unchanged* origin file
/// free; it cannot make a changed one cheap.
pub fn secrets_fingerprint(secrets: &ExportedSecret) -> String {
    let mut h = Sha256::new();
    // Length-prefixed so `(Some("ab"), None)` and `(Some("a"), Some("b"))`
    // cannot collide.
    for slot in [&secrets.db_password, &secrets.ssh_secret] {
        match slot {
            Some(blob) => {
                h.update((blob.len() as u64).to_le_bytes());
                h.update(blob.as_bytes());
            }
            None => h.update(u64::MAX.to_le_bytes()),
        }
    }
    hex_lower(&h.finalize())
}

/// Lowercase hex, the spelling every fingerprint in this codebase uses.
/// `pub(crate)` so the origin editor's content hash reads the same as the
/// secret fingerprints beside it in the same file.
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

/// Public because `crate::origin_doc` quotes the cost of a re-encryption back
/// to the publisher: the number only means something next to the count of slots
/// it multiplies.
pub const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32; // AES-256

/// Encrypt `plaintext` with AES-256-GCM, deriving the key from `passphrase`
/// via PBKDF2-HMAC-SHA256.
///
/// Returns a base64 string containing the concatenated `salt || nonce ||
/// ciphertext+tag` so the output is self-contained.
pub fn encrypt_secret(plaintext: &str, passphrase: &str) -> AppResult<String> {
    // Random salt and nonce — each call produces unique output even for
    // identical plaintexts.
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| AppError::Transfer("encryption failed".into()))?;

    // Pack: salt || nonce || ciphertext
    let mut payload = Vec::with_capacity(SALT_LEN + NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(&salt);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);

    Ok(B64.encode(&payload))
}

/// Decrypt a value produced by [`encrypt_secret`].
pub fn decrypt_secret(encoded: &str, passphrase: &str) -> AppResult<String> {
    let payload = B64
        .decode(encoded)
        .map_err(|_| AppError::Transfer("invalid base64 in encrypted secret".into()))?;

    if payload.len() < SALT_LEN + NONCE_LEN {
        return Err(AppError::Transfer("encrypted secret too short".into()));
    }

    let (salt, rest) = payload.split_at(SALT_LEN);
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);

    let key = derive_key(passphrase, salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Transfer("decryption failed — wrong passphrase?".into()))?;

    String::from_utf8(plaintext)
        .map_err(|_| AppError::Transfer("decrypted value is not UTF-8".into()))
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;

    /// An export without passwords must not carry one inside a MongoDB
    /// connection string either: that slot is metadata and is written in clear.
    /// Keychain-free, since `include_passwords: false` never reads it.
    #[test]
    fn an_export_without_passwords_drops_the_one_in_a_mongo_uri() {
        let p = ConnectionProfile {
            driver: Driver::Mongo,
            connection_string: Some("mongodb://app:s3cret@h1/db".into()),
            ..crate::testkit::profile("m")
        };
        let out = build_exported_profiles(&[p], false, None).unwrap();
        assert_eq!(
            out[0].profile.connection_string.as_deref(),
            Some("mongodb://app@h1/db")
        );
        assert!(out[0].secrets.is_none());
        assert!(!serde_json::to_string(&out).unwrap().contains("s3cret"));
    }

    /// An encrypted secret with no passphrase must never reach the keychain.
    ///
    /// This is the regression guard for the bug this function was extracted to
    /// kill: the origin-sync path used to treat "no passphrase" as "the blob is
    /// already plaintext" and stored the base64 AES-GCM envelope as the
    /// password. Both assertions below stay keychain-free on purpose —
    /// decryption fails before `set_password` is ever reached, which is exactly
    /// the property under test.
    #[test]
    fn encrypted_secret_without_passphrase_is_never_stored() {
        let p = profile("p1", "one");
        let secrets = ExportedSecret {
            db_password: Some(encrypt_secret("hunter2", "right-passphrase").unwrap()),
            ssh_secret: None,
        };

        // Best-effort (origin sync): the profile is simply left without a
        // secret, so the UI reports it as needing a password.
        let stored = land_secrets(&p, &secrets, None, LandMode::BestEffort).unwrap();
        assert!(!stored, "nothing may be stored without a passphrase");

        // Strict (interactive import): the caller must hear about it.
        assert!(
            land_secrets(&p, &secrets, None, LandMode::Strict).is_err(),
            "a missing passphrase must surface to the importer"
        );
    }

    /// A wrong passphrase is the same situation as a missing one: the ciphertext
    /// must not be written anywhere.
    #[test]
    fn wrong_passphrase_is_never_stored() {
        let p = profile("p1", "one");
        let secrets = ExportedSecret {
            db_password: Some(encrypt_secret("hunter2", "right-passphrase").unwrap()),
            ssh_secret: None,
        };
        assert!(!land_secrets(&p, &secrets, Some("wrong"), LandMode::BestEffort).unwrap());
        assert!(land_secrets(&p, &secrets, Some("wrong"), LandMode::Strict).is_err());
    }

    /// `secret_slots` is the single definition of which keychain accounts an
    /// exported secret covers, so the origin sync's "are they all still
    /// there?" check cannot drift from what `land_secrets` actually writes.
    #[test]
    fn secret_slots_lists_what_land_secrets_would_write() {
        let p = profile("p1", "one");
        let secrets = ExportedSecret {
            db_password: Some("db-blob".into()),
            ssh_secret: Some("ssh-blob".into()),
        };
        // No tunnel on the fixture, so the SSH slot has no account to land to.
        let slots = secret_slots(&p, &secrets);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].1, "db-blob");

        // SQLite drops the DB slot: a file path needs no credential.
        let mut lite = profile("p2", "two");
        lite.driver = Driver::Sqlite;
        assert!(secret_slots(&lite, &secrets).is_empty());
    }

    #[test]
    fn the_fingerprint_tracks_the_ciphertext_and_nothing_else() {
        let a = ExportedSecret {
            db_password: Some("blob".into()),
            ssh_secret: None,
        };
        let same = ExportedSecret {
            db_password: Some("blob".into()),
            ssh_secret: None,
        };
        let other = ExportedSecret {
            db_password: Some("blob2".into()),
            ssh_secret: None,
        };
        assert_eq!(secrets_fingerprint(&a), secrets_fingerprint(&same));
        assert_ne!(secrets_fingerprint(&a), secrets_fingerprint(&other));
    }

    #[test]
    fn the_fingerprint_cannot_confuse_the_two_slots() {
        // Without length-prefixing, ("ab", None) and ("a", "b") would hash the
        // same bytes — and a rotated SSH secret could then look unchanged.
        let split = ExportedSecret {
            db_password: Some("a".into()),
            ssh_secret: Some("b".into()),
        };
        let joined = ExportedSecret {
            db_password: Some("ab".into()),
            ssh_secret: None,
        };
        assert_ne!(secrets_fingerprint(&split), secrets_fingerprint(&joined));
    }

    #[test]
    fn re_encrypting_the_same_password_changes_the_fingerprint() {
        // `encrypt_secret` draws a fresh salt and nonce every time, so this
        // makes an *unchanged* origin file free but cannot make a re-exported
        // one cheap. Pinned so the limitation is not mistaken for a bug.
        let one = ExportedSecret {
            db_password: Some(encrypt_secret("hunter2", "pass").unwrap()),
            ssh_secret: None,
        };
        let two = ExportedSecret {
            db_password: Some(encrypt_secret("hunter2", "pass").unwrap()),
            ssh_secret: None,
        };
        assert_ne!(secrets_fingerprint(&one), secrets_fingerprint(&two));
    }

    /// SQLite has no DB password, so that slot is skipped rather than landed —
    /// mirroring the export side, which never writes one. Verified with a
    /// *correct* passphrase so the skip is what stops the store, not a failed
    /// decrypt (which is why this test needs no keychain either).
    #[test]
    fn sqlite_db_password_slot_is_skipped() {
        let mut p = profile("p1", "one");
        p.driver = Driver::Sqlite;
        let secrets = ExportedSecret {
            db_password: Some(encrypt_secret("hunter2", "pass").unwrap()),
            ssh_secret: None,
        };
        let stored = land_secrets(&p, &secrets, Some("pass"), LandMode::Strict).unwrap();
        assert!(!stored, "SQLite has no DB password to land");
    }

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            name: name.into(),
            ..crate::testkit::profile(id)
        }
    }

    fn exported(id: &str, name: &str) -> ExportedProfile {
        ExportedProfile {
            profile: profile(id, name),
            secrets: None,
        }
    }

    #[test]
    fn detect_conflicts_matches_by_id_not_name() {
        // A profile renamed on either side is still the same connection — the
        // conflict is keyed on `id`, and the two names are carried through so
        // the UI can show both.
        let existing = vec![profile("a", "Prod")];
        let incoming = vec![
            exported("a", "Prod (renamed upstream)"),
            exported("b", "New"),
        ];
        let conflicts = detect_conflicts(&existing, &incoming);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].id, "a");
        assert_eq!(conflicts[0].existing_name, "Prod");
        assert_eq!(conflicts[0].incoming_name, "Prod (renamed upstream)");
    }

    #[test]
    fn detect_conflicts_is_empty_when_no_ids_overlap() {
        let existing = vec![profile("a", "Prod")];
        let incoming = vec![exported("b", "New")];
        assert!(detect_conflicts(&existing, &incoming).is_empty());
    }

    #[test]
    fn export_metadata_kind_defaults_to_empty_for_legacy_files() {
        // A profile bundle written before `kind` existed must still parse,
        // and every `kind` check downstream (import_profiles,
        // analyze_import_file) treats "" the same as `KIND_PROFILES`.
        let legacy = r#"{
            "version": 1, "app": "huginndb",
            "exported_at": "2020-01-01T00:00:00Z", "encrypted": false
        }"#;
        let meta: ExportMetadata = serde_json::from_str(legacy).unwrap();
        assert_eq!(meta.kind, "");
    }

    #[test]
    fn the_three_export_kinds_are_distinct() {
        // Each importer rejects the other two by exact match, so a collision
        // here would let one silently import half of another kind of file.
        assert_ne!(KIND_PROFILES, KIND_ENVIRONMENT);
        assert_ne!(KIND_PROFILES, KIND_JSON_SCHEMAS);
        assert_ne!(KIND_ENVIRONMENT, KIND_JSON_SCHEMAS);
    }

    fn meta_of(kind: &str) -> ExportMetadata {
        metadata(kind, false, "2026-08-21T00:00:00Z")
    }

    #[test]
    fn check_meta_accepts_only_the_kind_the_importer_asked_for() {
        assert!(check_meta(&meta_of(KIND_PROFILES), KIND_PROFILES).is_ok());
        assert!(check_meta(&meta_of(KIND_ENVIRONMENT), KIND_ENVIRONMENT).is_ok());
        assert!(check_meta(&meta_of(KIND_JSON_SCHEMAS), KIND_JSON_SCHEMAS).is_ok());
    }

    #[test]
    fn a_missing_kind_is_a_pre_1_9_profile_bundle() {
        // Files written before the discriminant existed carry no `kind` at all,
        // and must keep importing as what they are.
        let mut meta = meta_of(KIND_PROFILES);
        meta.kind = String::new();
        assert!(check_meta(&meta, KIND_PROFILES).is_ok());
        assert!(check_meta(&meta, KIND_ENVIRONMENT).is_err());
    }

    #[test]
    fn check_meta_names_both_the_file_and_the_importer() {
        // serde ignores unknown fields, so without this an environment export
        // fed to the profile importer parses fine and silently contributes
        // only its `profiles` array.
        let err = check_meta(&meta_of(KIND_ENVIRONMENT), KIND_PROFILES)
            .unwrap_err()
            .to_string();
        assert!(err.contains("environment"), "{err}");
        assert!(err.contains("profile"), "{err}");

        let err = check_meta(&meta_of(KIND_PROFILES), KIND_JSON_SCHEMAS)
            .unwrap_err()
            .to_string();
        assert!(err.contains("JSON Schema"), "{err}");
    }

    #[test]
    fn check_meta_rejects_a_future_format_version() {
        let mut meta = meta_of(KIND_PROFILES);
        meta.version = 2;
        assert!(check_meta(&meta, KIND_PROFILES)
            .unwrap_err()
            .to_string()
            .contains("version 2"));
    }

    #[test]
    fn disambiguate_name_numbers_from_two_after_the_imported_rung() {
        // The profile importer's inline copy reused one counter for both rungs
        // and so jumped from `(imported)` straight to `(3)`.
        assert_eq!(disambiguate_name("prod", ["other"].into_iter()), "prod");
        assert_eq!(
            disambiguate_name("prod", ["prod"].into_iter()),
            "prod (imported)"
        );
        assert_eq!(
            disambiguate_name("prod", ["prod", "prod (imported)"].into_iter()),
            "prod (2)"
        );
        assert_eq!(
            disambiguate_name("prod", ["prod", "prod (imported)", "prod (2)"].into_iter()),
            "prod (3)"
        );
    }

    #[test]
    fn an_environment_export_written_before_1_17_still_parses() {
        // The direct analogue of the `kind` test above: `json_schemas` is a
        // `#[serde(default)]` addition, so every file already in the wild loads
        // unchanged and simply carries an empty bundle.
        let legacy = r#"{
            "meta": {
                "version": 1, "app": "huginndb",
                "exported_at": "2020-01-01T00:00:00Z",
                "encrypted": false, "kind": "environment"
            },
            "environments": [],
            "profiles": []
        }"#;
        let file: EnvironmentExportFile = serde_json::from_str(legacy).unwrap();
        assert!(file.json_schemas.is_empty());
    }

    #[test]
    fn an_export_without_schemas_serialises_no_json_schemas_key() {
        // `skip_serializing_if` keeps a 1.17 export that did not opt in
        // byte-identical to a 1.16 one, so diffing two exports stays useful.
        let file = EnvironmentExportFile {
            meta: metadata(KIND_ENVIRONMENT, false, "2026-08-19T00:00:00Z"),
            environments: vec![],
            profiles: vec![],
            json_schemas: JsonSchemaBundle::default(),
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(!json.contains("json_schemas"));
    }

    #[test]
    fn a_json_schema_export_file_round_trips_its_flattened_bundle() {
        let file = JsonSchemaExportFile {
            meta: metadata(KIND_JSON_SCHEMAS, false, "2026-08-19T00:00:00Z"),
            bundle: JsonSchemaBundle {
                schemas: vec![JsonSchemaItem {
                    id: "s1".into(),
                    name: "cfg".into(),
                    body: r#"{"type":"object"}"#.into(),
                    ..Default::default()
                }],
                bindings: vec![],
            },
        };
        let json = serde_json::to_string(&file).unwrap();
        // Flattened: `schemas` sits next to `meta`, not nested under a `bundle`.
        assert!(json.contains(r#""schemas""#));
        assert!(!json.contains(r#""bundle""#));
        let back: JsonSchemaExportFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.meta.kind, KIND_JSON_SCHEMAS);
        assert_eq!(back.bundle.schemas.len(), 1);
        assert_eq!(back.bundle.schemas[0].name, "cfg");
    }
}
