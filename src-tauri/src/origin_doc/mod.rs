//! The *document* a shared origin publishes, as an editable draft.
//!
//! A shared origin (#108) was pull-only: [`crate::commands::origins::sync_origin`]
//! reads the file and never writes it, so publishing meant a human running
//! `export_environments`, picking a destination in the native dialog, and
//! dropping the JSON on the share. Updating it meant repeating that export from
//! whatever the publisher happened to have mounted at that moment — or editing
//! the JSON by hand.
//!
//! This module is the model behind an *editor* for that file: a draft the user
//! composes, plus the pure functions that load one from a file, build a file
//! back out of one, and predict what publishing it would do to everyone pulling
//! from it. The I/O — reading the path, resolving keychain secrets, writing
//! atomically — lives in [`crate::commands::origin_doc`]. Nothing here touches a
//! disk or a keychain, which is the whole reason the rules below are testable at
//! all (convention #52: the first tests written against
//! `merge_profiles_bundle` overwrote the developer's own `profiles.json`,
//! because the only entry point insisted on saving first).
//!
//! Four invariants shape everything in here.
//!
//! ## 1. The editor edits a document, not the local state
//!
//! An [`OriginDraft`] lives in memory and never touches `profiles.json`,
//! `tab_state.json` or `json_schemas.json` — and, symmetrically, saving one
//! changes nothing locally. A publisher composes "the team's file" as a
//! document, which is what lets them publish a connection they have never
//! opened and edit one they no longer have.
//!
//! ## 2. One constructor for the file
//!
//! [`crate::transfer::EnvironmentExportFile`] **already is** the format, so this
//! module invents nothing: [`build_origin_file`] assembles that exact type and
//! reuses [`crate::transfer::metadata`]. Mirrors ADR #16 (the DDL is built in
//! Rust, never in the component) and #33 (one grammar, one parser): a second
//! writer would drift, and the drift would be silent, because a consumer's sync
//! reports "read cleanly" either way.
//!
//! ## 3. A secret that did not change travels verbatim
//!
//! [`crate::commands::origins::already_landed`] skips the ~600 000 PBKDF2 rounds
//! *per slot* of landing a secret when the ciphertext's fingerprint matches what
//! this machine already decrypted. Since [`crate::transfer::encrypt_secret`]
//! draws a fresh salt and nonce on every call, re-encrypting on every save would
//! invalidate that cache for the whole team — tens of millions of SHA-256 rounds
//! each, on their next sync, because somebody changed an environment's colour.
//! [`SecretSlot::Keep`] is therefore what everything loaded from the file gets,
//! and it is copied byte for byte. Rotating the passphrase is the one operation
//! that must re-encrypt everything, and [`PublishImpact::reencryption`] exists so
//! that cost is announced rather than discovered.
//!
//! ## 4. `source_environment_id` is sacred
//!
//! It is the identity [`crate::commands::origins::sync_origin`] matches a bundle
//! against its local mirror with — the `(origin_id, origin_source_id)` pair on
//! [`crate::tab_state::Environment`]. Minting a fresh one while editing makes
//! every consumer see that environment **disappear** and a different one appear,
//! losing the tabs, layout and filters they had in it. A [`DraftEnvironment`]
//! loaded from a file keeps its own; only one created from scratch gets a new
//! uuid, and that is the command layer's job, not [`build_origin_file`]'s. The
//! same applies one level down to `ConnectionProfile::id`: adding a local
//! connection to the document keeps its id, which is what lets a publisher
//! consume their own origin without ending up with two copies of every server.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::commands::origins::{disappearance_is_trustworthy, merge_into};
use crate::json_schemas::{JsonSchemaBinding, JsonSchemaItem};
use crate::state::{ConnectionProfile, Driver};
use crate::transfer::{
    self, EnvironmentExportFile, ExportedEnvironment, ExportedEnvironmentBundle, ExportedOrigin,
    ExportedProfile, ExportedSecret, JsonSchemaBundle, KIND_ENVIRONMENT,
};

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/// Publication metadata: who curates the file and which revision this is.
///
/// **Coordination, never permission.** "Ana curates this, revision 14" is what a
/// second publisher reads before touching it; what actually stops two people
/// clobbering each other is the content hash in [`DraftBase`]. Nothing in the
/// sync path reads any of these fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DraftMeta {
    /// Display copy — a name, an email, a team. Blank is normalised to `None` by
    /// [`build_origin_file`] so an emptied field does not publish `""`.
    pub maintainer: Option<String>,
    /// Monotonic counter the publisher bumps. `None` means the file predates the
    /// editor (or was written by `export_environments`), which is deliberately
    /// distinct from `Some(0)`: keeping them apart is what lets
    /// [`build_origin_file`] rebuild a legacy file byte for byte instead of
    /// growing a `revision: 0` nobody asked for.
    pub revision: Option<u32>,
    /// Free-text note about this revision, for the humans pulling it.
    pub note: Option<String>,
    /// What the loaded file's `meta.encrypted` said. Informational only —
    /// [`build_origin_file`] recomputes it from the slots it actually writes, so
    /// the header can never claim secrets the file does not carry.
    pub encrypted: bool,
}

/// One environment as the document describes it: cosmetics, membership, and the
/// origins its connections depend on.
///
/// Has no local `Environment::id`, on purpose — the document is not a mirror of
/// this machine's environments, and importing one always mints a fresh local id.
/// `source_environment_id` is the identity that matters; see the module doc.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DraftEnvironment {
    pub source_environment_id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub theme_id: Option<String>,
    /// Ids into [`OriginDraft::connections`]. Retained verbatim even when an id
    /// names a connection the document no longer carries — see
    /// [`DraftMembership::dangling`], which reports those rather than having the
    /// builder silently drop them.
    pub connection_ids: Vec<String>,
    pub origins: Vec<ExportedOrigin>,
}

/// Where the ciphertext for one published connection comes from.
///
/// Deliberately has **no** `Default`. The choice between "publish the password"
/// and "let the consumer type it" is not one a struct-update expression should
/// be able to make silently, and the two wrong answers fail in opposite
/// directions: defaulting to a secret publishes a credential nobody asked to
/// share, defaulting to none ships a connection that cannot connect.
///
/// One variant covers both of a profile's keychain slots (DB password and SSH
/// secret) rather than there being one `SecretSlot` per slot: the decision is
/// made per connection in the UI, and splitting it would let a document carry a
/// kept DB password next to a re-encrypted SSH secret for the same profile —
/// representable, never useful, and enough to defeat invariant 3 for that row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SecretSlot {
    /// The base64 envelope exactly as it came out of the file. What everything
    /// [`draft_from_file`] loads gets, and the reason a save is cheap for every
    /// consumer (invariant 3).
    Keep { envelope: ExportedSecret },
    /// Resolve at save time from *this* machine's keychain and encrypt with the
    /// document's passphrase. What a connection just added from the local
    /// profile list gets.
    FromKeychain,
    /// Publish no secret: the consumer will be asked for the password, exactly
    /// as they are for an origin whose publisher never included one.
    Clear,
}

/// One connection as the document publishes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftConnection {
    /// Flattened, so the wire shape is a superset of a `profiles.json` entry —
    /// matching [`ExportedProfile`], whose place this takes in the draft.
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    pub secret: SecretSlot,
}

/// The whole editable document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OriginDraft {
    pub meta: DraftMeta,
    pub environments: Vec<DraftEnvironment>,
    pub connections: Vec<DraftConnection>,
    pub schemas: Vec<JsonSchemaItem>,
    pub bindings: Vec<JsonSchemaBinding>,
}

/// What the file looked like when the editor opened it.
///
/// Round-tripped through the frontend and handed back on save, where the hash is
/// recomputed from disk and compared: if it differs, somebody else published in
/// the meantime and the save is refused with the newer document rather than
/// overwriting it. Optimistic concurrency is the only kind available here — a
/// share offers no locks worth trusting, and a lock file on a path a laptop can
/// drop off the VPN mid-edit strands the document instead of protecting it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftBase {
    /// Lowercase hex SHA-256 of the file's bytes.
    pub sha256: String,
    /// Last-modified stamp (RFC 3339) when it could be read. Display only — the
    /// hash is what the comparison uses, because a share's clock and mtime
    /// granularity are not something to bet a team's file on.
    pub mtime: Option<String>,
    /// `meta.revision` as read, `0` when the file carried none.
    pub revision: u32,
}

// ---------------------------------------------------------------------------
// file <-> draft
// ---------------------------------------------------------------------------

/// Load a published file into an editable draft.
///
/// Every secret it carries becomes [`SecretSlot::Keep`] — invariant 3. Takes the
/// file by value: it is the parse's only consumer, and cloning a document full
/// of ciphertext to throw the original away has no upside.
pub fn draft_from_file(file: EnvironmentExportFile) -> OriginDraft {
    let EnvironmentExportFile {
        meta,
        environments,
        profiles,
        json_schemas,
    } = file;
    OriginDraft {
        meta: DraftMeta {
            maintainer: meta.maintainer,
            revision: meta.revision,
            note: meta.note,
            encrypted: meta.encrypted,
        },
        environments: environments
            .into_iter()
            .map(|bundle| {
                let ExportedEnvironmentBundle {
                    environment,
                    connection_ids,
                    origins,
                } = bundle;
                DraftEnvironment {
                    source_environment_id: environment.source_environment_id,
                    name: environment.name,
                    color: environment.color,
                    icon: environment.icon,
                    theme_id: environment.theme_id,
                    connection_ids,
                    origins,
                }
            })
            .collect(),
        connections: profiles
            .into_iter()
            .map(|entry| DraftConnection {
                secret: match entry.secrets {
                    Some(envelope) => SecretSlot::Keep { envelope },
                    None => SecretSlot::Clear,
                },
                profile: entry.profile,
            })
            .collect(),
        schemas: json_schemas.schemas,
        bindings: json_schemas.bindings,
    }
}

/// Assemble the file a draft publishes.
///
/// Pure and total: no keychain, no clock, no failure mode. `exported_at` is
/// passed in for both reasons — a pure function has no business reading a clock,
/// and rebuilding a loaded file with its original stamp is what makes the
/// round-trip property assertable.
///
/// A [`SecretSlot::FromKeychain`] that reaches here publishes **no** secret.
/// That is not a silent drop: the command layer resolves those into
/// [`SecretSlot::Keep`] before calling, so one arriving unresolved means this
/// machine's keychain had nothing for that profile — in which case "publish
/// nothing" is the honest answer, and the consumer is asked for the password.
pub fn build_origin_file(draft: &OriginDraft, exported_at: &str) -> EnvironmentExportFile {
    let profiles: Vec<ExportedProfile> = draft
        .connections
        .iter()
        .map(|conn| ExportedProfile {
            // The publisher's own database user never ships: it would sign
            // every consumer in as them. `merge_into` clears it on arrival
            // too; this keeps it out of the file in the first place.
            profile: ConnectionProfile {
                personal_username: None,
                ..conn.profile.clone()
            },
            secrets: published_envelope(&conn.secret).cloned(),
        })
        .collect();

    // Recomputed, never copied from `draft.meta.encrypted`: the header says
    // whether `land_secrets` will find ciphertext, and a header that disagrees
    // with the body makes `sync_origin` demand a passphrase for a file that
    // carries nothing — or, worse, skip asking for one it needs.
    let encrypted = profiles.iter().any(|p| {
        p.secrets
            .as_ref()
            .is_some_and(|s| s.db_password.is_some() || s.ssh_secret.is_some())
    });

    let mut meta = transfer::metadata(KIND_ENVIRONMENT, encrypted, exported_at);
    meta.maintainer = normalise(draft.meta.maintainer.as_deref());
    meta.note = normalise(draft.meta.note.as_deref());
    meta.revision = draft.meta.revision;

    EnvironmentExportFile {
        meta,
        environments: draft
            .environments
            .iter()
            .map(|env| ExportedEnvironmentBundle {
                environment: ExportedEnvironment {
                    name: env.name.clone(),
                    color: env.color.clone(),
                    icon: env.icon.clone(),
                    theme_id: env.theme_id.clone(),
                    source_environment_id: env.source_environment_id.clone(),
                },
                connection_ids: env.connection_ids.clone(),
                origins: env.origins.clone(),
            })
            .collect(),
        profiles,
        json_schemas: JsonSchemaBundle {
            schemas: draft.schemas.clone(),
            bindings: draft.bindings.clone(),
        },
    }
}

/// Trim, and treat a blank field as absent. An emptied text input arrives as
/// `Some("")`, which would otherwise publish a `maintainer` of `""` — a value
/// that reads as "curated by nobody in particular" rather than "not stated".
fn normalise(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The envelope a slot actually publishes, or `None` for the two that publish
/// nothing. One place, so [`build_origin_file`] and the impact preview cannot
/// disagree about what a `FromKeychain` slot means.
fn published_envelope(slot: &SecretSlot) -> Option<&ExportedSecret> {
    match slot {
        SecretSlot::Keep { envelope } => Some(envelope),
        SecretSlot::FromKeychain | SecretSlot::Clear => None,
    }
}

/// Replace one connection in a draft with the local profile that just changed,
/// reporting whether the draft carried it at all.
///
/// The model half of `commands::origin_doc::republish_profile_to_origin`, kept
/// here because the interesting part is a rule and not the I/O: **the secret
/// slot is left exactly as it was unless the password itself changed.**
/// Invariant 2 of this module is what makes that mandatory rather than thrifty
/// — a re-encrypted envelope is a *different* ciphertext for the same password,
/// which invalidates every consumer's `landed_secrets` fingerprint and charges
/// each of them ~600 000 PBKDF2 rounds to learn nothing. Correcting a port must
/// cost the team zero derivations, for the same reason renaming an environment
/// does.
///
/// Matched on `ConnectionProfile::id`, the identity a consumer's `merge_into`
/// owns a profile by. Returns `false` when the document does not publish this
/// connection (any more), which is a thing to *report* — publishing it back
/// would silently re-add a row somebody deliberately removed.
pub fn replace_connection(
    draft: &mut OriginDraft,
    profile: ConnectionProfile,
    with_secret: bool,
) -> bool {
    let Some(entry) = draft
        .connections
        .iter_mut()
        .find(|c| c.profile.id == profile.id)
    else {
        return false;
    };
    entry.profile = profile;
    if with_secret {
        entry.secret = SecretSlot::FromKeychain;
    }
    true
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/// One environment's membership, for the editor's checklists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentMembership {
    pub source_environment_id: String,
    pub name: String,
    pub connection_ids: Vec<String>,
}

/// Who belongs to what, plus the two ways a document can be inconsistent
/// without being invalid.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMembership {
    pub by_environment: Vec<EnvironmentMembership>,
    /// Connections no environment lists. Perfectly publishable — `merge_into`
    /// puts every profile in the file into the consumer's global pool, and only
    /// `launch.visible_connections` filters it per environment — so these are
    /// the document's *loose* connections, not an error. The editor groups them
    /// under "unassigned" so they are visible rather than implied.
    pub unassigned: Vec<String>,
    /// Ids an environment lists that the document does not carry. Harmless on
    /// the consumer (a stale `visible_connections` entry is ignored), so the
    /// builder keeps them instead of rewriting the user's data behind their
    /// back — but worth surfacing, since it usually means a connection was
    /// removed from the file and not from the environment.
    pub dangling: Vec<String>,
}

/// Resolve the document's membership.
pub fn membership(draft: &OriginDraft) -> DraftMembership {
    let present: HashSet<&str> = draft
        .connections
        .iter()
        .map(|c| c.profile.id.as_str())
        .collect();
    let mut assigned: HashSet<&str> = HashSet::new();
    let mut dangling: Vec<String> = Vec::new();

    let by_environment = draft
        .environments
        .iter()
        .map(|env| {
            for id in &env.connection_ids {
                match present.get(id.as_str()) {
                    Some(known) => {
                        assigned.insert(known);
                    }
                    None if !dangling.contains(id) => dangling.push(id.clone()),
                    None => {}
                }
            }
            EnvironmentMembership {
                source_environment_id: env.source_environment_id.clone(),
                name: env.name.clone(),
                connection_ids: env.connection_ids.clone(),
            }
        })
        .collect();

    DraftMembership {
        by_environment,
        unassigned: draft
            .connections
            .iter()
            .map(|c| c.profile.id.clone())
            .filter(|id| !assigned.contains(id.as_str()))
            .collect(),
        dangling,
    }
}

// ---------------------------------------------------------------------------
// Publish impact
// ---------------------------------------------------------------------------

/// The origin id the simulation tags its synthetic local profiles with.
///
/// Any non-uuid string works — it only has to be the same on both sides of
/// [`merge_into`]'s ownership check, and it can never collide with a real origin
/// id, which is a uuid.
const SIM_ORIGIN_ID: &str = "origin-doc::simulated";

/// One thing that changes, with enough to name it in a list.
///
/// `id` is a profile id for a connection and a `source_environment_id` for an
/// environment. `name` rides along because a *vanished* entry exists only in the
/// base file — the editor has no draft entry to look it up in, and "3
/// connections will disappear" without saying which is not a warning anybody can
/// act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEntity {
    pub id: String,
    pub name: String,
}

/// What publishing does to one class of entity, for a consumer already up to
/// date with the base file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityImpact {
    pub added: Vec<ChangedEntity>,
    /// Entries that genuinely change — the metadata differs, or the published
    /// ciphertext does. An entry the merge visits and leaves identical is
    /// counted in `unchanged` instead, which is what makes "renamed one
    /// environment" read as *0 refreshed* rather than as the whole roster.
    pub refreshed: Vec<ChangedEntity>,
    pub unchanged: usize,
    pub vanished: Vec<ChangedEntity>,
    /// How many entries this origin publishes today, i.e. the denominator the
    /// consumer's suspicion check will use. Exact for a consumer in step with
    /// the base file; one who skipped a revision has their own count.
    pub owned: usize,
    /// **The consumer will not be told.** When disappearances cross
    /// [`crate::commands::origins`]'s suspicion threshold, the sync treats the
    /// read as untrustworthy and clears `vanished` — so publishing a file
    /// missing half the roster leaves every consumer with phantom connections
    /// and no notice whatsoever. Today that is undiscoverable; this flag is the
    /// whole reason the preview exists.
    pub silently_dropped: bool,
}

/// What a consumer pays in key derivations because a published ciphertext
/// changed.
///
/// Invariant 3 in numbers. `Keep` costs nothing; anything else means a fresh
/// salt and nonce, so every consumer re-derives that slot's key on their next
/// sync at [`crate::transfer::PBKDF2_ITERATIONS`] rounds each.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReencryptionCost {
    /// Connections whose published envelope differs from the base file's.
    pub connections: Vec<ChangedEntity>,
    pub slots: usize,
    pub pbkdf2_rounds: u64,
    /// True when at least one slot is an upper-bound guess rather than a count:
    /// a [`SecretSlot::FromKeychain`] has no envelope yet, so its slot count is
    /// inferred from the profile (a DB password unless SQLite, plus an SSH
    /// secret if it is tunnelled) and the keychain may hold neither.
    pub estimated: bool,
}

/// What a machine pulling this origin for the first time receives.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshMachineImpact {
    pub connections: usize,
    pub environments: usize,
    pub schemas: usize,
    pub bindings: usize,
    /// Every published slot — the full landing cost, paid once.
    pub slots: usize,
    pub pbkdf2_rounds: u64,
}

/// Everything the confirmation dialog needs in order to say what publishing will
/// do.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishImpact {
    pub connections: EntityImpact,
    pub environments: EntityImpact,
    pub fresh_machine: FreshMachineImpact,
    pub reencryption: ReencryptionCost,
    /// Connections published with no secret, which a consumer cannot open until
    /// they type a password. SQLite without a tunnel is excluded — a file path
    /// needs no credential, so its empty slot is not a gap.
    pub without_password: Vec<ChangedEntity>,
    /// Bindings pinned to a specific connection. Reported for context.
    pub bindings_pinned: usize,
    /// The subset of those whose connection the document does not carry. They
    /// arrive **disabled** on every consumer (see `docs/JSON_SCHEMAS.md`),
    /// because a binding naming an unknown connection cannot be widened to a
    /// wildcard without changing what the rule means.
    pub bindings_unresolvable: usize,
    /// [`membership`] of the draft, so the dialog can mention loose connections
    /// and dangling ids without a second call.
    pub membership: DraftMembership,
}

/// Simulate publishing `draft` over `base`.
///
/// `base` is the file as it stands on the share — the state a consumer who
/// synced since the last publish is in. The connection half runs the *real*
/// [`merge_into`] against a synthetic local pool built from `base`, rather than
/// re-deriving its rules here: which fields a refresh may overwrite, what a live
/// pool defers, how ownership is decided. Re-implementing that is exactly the
/// drift CLAUDE.md warns about, and the failure mode is a preview that
/// confidently describes something other than what happens.
///
/// The refreshed/unchanged split is then read off the simulated pool by
/// comparing each profile before and after, which means it needs no knowledge of
/// *which* fields the merge preserves locally (`mcp_write`/`pulse_enabled`,
/// today). Add one and
/// this keeps telling the truth.
///
/// Pure: no locks, no pools, no keychain. The `live` set handed to `merge_into`
/// is deliberately empty — the publisher cannot know which connections a
/// consumer has open, and a deferral is a delay, not a different outcome.
pub fn publish_impact(draft: &OriginDraft, base: &EnvironmentExportFile) -> PublishImpact {
    let incoming = build_origin_file(draft, "");

    PublishImpact {
        connections: connection_impact(&incoming.profiles, &base.profiles),
        environments: environment_impact(&incoming.environments, &base.environments),
        fresh_machine: fresh_machine_impact(&incoming),
        reencryption: reencryption_cost(draft, base),
        without_password: draft
            .connections
            .iter()
            .filter(|c| published_envelope(&c.secret).is_none())
            .filter(|c| needs_credential(&c.profile))
            .map(|c| entity(&c.profile.id, &c.profile.name))
            .collect(),
        bindings_pinned: draft
            .bindings
            .iter()
            .filter(|b| b.connection_id.is_some())
            .count(),
        bindings_unresolvable: unresolvable_bindings(draft),
        membership: membership(draft),
    }
}

fn entity(id: &str, name: &str) -> ChangedEntity {
    ChangedEntity {
        id: id.to_string(),
        name: name.to_string(),
    }
}

/// Does this profile need a credential at all? A SQLite file behind no tunnel
/// does not, which is also why [`transfer::secret_slots`] skips its DB slot.
fn needs_credential(profile: &ConnectionProfile) -> bool {
    !matches!(profile.driver, Driver::Sqlite) || profile.ssh_tunnel.is_some()
}

fn connection_impact(incoming: &[ExportedProfile], base: &[ExportedProfile]) -> EntityImpact {
    // The consumer's pool as it stands after their last sync: every profile the
    // base publishes, owned by this origin.
    let mut local: Vec<ConnectionProfile> = base
        .iter()
        .map(|entry| ConnectionProfile {
            origin_id: Some(SIM_ORIGIN_ID.to_string()),
            ..entry.profile.clone()
        })
        .collect();
    let before: HashMap<String, serde_json::Value> =
        local.iter().map(|p| (p.id.clone(), snapshot(p))).collect();

    let report = merge_into(&mut local, SIM_ORIGIN_ID, incoming, &[]);

    let after: HashMap<&str, &ConnectionProfile> =
        local.iter().map(|p| (p.id.as_str(), p)).collect();
    let before_fingerprints = fingerprints(base);
    let after_fingerprints = fingerprints(incoming);
    let names: HashMap<&str, &str> = incoming
        .iter()
        .map(|e| (e.profile.id.as_str(), e.profile.name.as_str()))
        .collect();
    let named = |id: &str| entity(id, names.get(id).copied().unwrap_or_default());

    let mut refreshed = Vec::new();
    let mut unchanged = 0usize;
    for id in &report.updated {
        let metadata_changed = after
            .get(id.as_str())
            .is_some_and(|p| Some(&snapshot(p)) != before.get(id));
        let secret_changed =
            before_fingerprints.get(id.as_str()) != after_fingerprints.get(id.as_str());
        if metadata_changed || secret_changed {
            refreshed.push(named(id));
        } else {
            unchanged += 1;
        }
    }

    // Computed here rather than read off the report, and that is the point:
    // `merge_into` *clears* `vanished` once the read looks untrustworthy, so the
    // report alone can never tell the publisher that the disappearances they are
    // about to publish will reach nobody.
    let incoming_ids: HashSet<&str> = incoming.iter().map(|e| e.profile.id.as_str()).collect();
    let vanished: Vec<ChangedEntity> = base
        .iter()
        .filter(|e| !incoming_ids.contains(e.profile.id.as_str()))
        .map(|e| entity(&e.profile.id, &e.profile.name))
        .collect();

    EntityImpact {
        added: report.added.iter().map(|id| named(id)).collect(),
        refreshed,
        unchanged,
        silently_dropped: !disappearance_is_trustworthy(base.len(), vanished.len()),
        vanished,
        owned: base.len(),
    }
}

/// A profile as the diff sees it. Serialised rather than field-compared so a new
/// field on [`ConnectionProfile`] is covered the day it is added.
fn snapshot(profile: &ConnectionProfile) -> serde_json::Value {
    serde_json::to_value(profile).unwrap_or(serde_json::Value::Null)
}

fn fingerprints(entries: &[ExportedProfile]) -> HashMap<&str, String> {
    entries
        .iter()
        .filter_map(|e| {
            e.secrets
                .as_ref()
                .map(|s| (e.profile.id.as_str(), transfer::secrets_fingerprint(s)))
        })
        .collect()
}

/// Environments are matched by `source_environment_id`, the same identity
/// `sync_environment_bundles` uses (paired there with the origin id, which is
/// fixed in a simulation of a single origin). Not reusing that function is
/// deliberate: it mints fresh local uuids for added environments and reports
/// local ones for the rest, none of which the editor of a *document* can name.
/// The matching rule and the suspicion verdict — the two things that must not
/// drift — are shared.
fn environment_impact(
    incoming: &[ExportedEnvironmentBundle],
    base: &[ExportedEnvironmentBundle],
) -> EntityImpact {
    let base_by_id: HashMap<&str, &ExportedEnvironmentBundle> = base
        .iter()
        .map(|b| (b.environment.source_environment_id.as_str(), b))
        .collect();
    let incoming_ids: HashSet<&str> = incoming
        .iter()
        .map(|b| b.environment.source_environment_id.as_str())
        .collect();

    let mut added = Vec::new();
    let mut refreshed = Vec::new();
    let mut unchanged = 0usize;
    for bundle in incoming {
        let id = bundle.environment.source_environment_id.as_str();
        match base_by_id.get(id) {
            None => added.push(entity(id, &bundle.environment.name)),
            Some(previous) if mirrored_state(bundle) == mirrored_state(previous) => unchanged += 1,
            Some(_) => refreshed.push(entity(id, &bundle.environment.name)),
        }
    }

    let vanished: Vec<ChangedEntity> = base
        .iter()
        .filter(|b| !incoming_ids.contains(b.environment.source_environment_id.as_str()))
        .map(|b| entity(&b.environment.source_environment_id, &b.environment.name))
        .collect();

    EntityImpact {
        added,
        refreshed,
        unchanged,
        silently_dropped: !disappearance_is_trustworthy(base.len(), vanished.len()),
        vanished,
        owned: base.len(),
    }
}

/// The part of a bundle a consumer's mirror actually adopts: cosmetics plus
/// membership. A bundle's nested `origins` are excluded because
/// `sync_environment_bundles` deliberately never registers them, so changing one
/// is not a change any consumer sees.
fn mirrored_state(bundle: &ExportedEnvironmentBundle) -> serde_json::Value {
    serde_json::json!({
        "name": bundle.environment.name,
        "color": bundle.environment.color,
        "icon": bundle.environment.icon,
        "themeId": bundle.environment.theme_id,
        "connectionIds": bundle.connection_ids,
    })
}

fn fresh_machine_impact(file: &EnvironmentExportFile) -> FreshMachineImpact {
    let slots: usize = file
        .profiles
        .iter()
        .filter_map(|e| {
            e.secrets
                .as_ref()
                .map(|s| transfer::secret_slots(&e.profile, s).len())
        })
        .sum();
    FreshMachineImpact {
        connections: file.profiles.len(),
        environments: file.environments.len(),
        schemas: file.json_schemas.schemas.len(),
        bindings: file.json_schemas.bindings.len(),
        slots,
        pbkdf2_rounds: slots as u64 * u64::from(transfer::PBKDF2_ITERATIONS),
    }
}

fn reencryption_cost(draft: &OriginDraft, base: &EnvironmentExportFile) -> ReencryptionCost {
    let base_fingerprints = fingerprints(&base.profiles);
    let mut cost = ReencryptionCost::default();

    for conn in &draft.connections {
        let id = conn.profile.id.as_str();
        let slots = match &conn.secret {
            // Verbatim ciphertext the consumer has already landed: free, and the
            // entire point of invariant 3.
            SecretSlot::Keep { envelope } => {
                let fingerprint = transfer::secrets_fingerprint(envelope);
                if base_fingerprints.get(id) == Some(&fingerprint) {
                    continue;
                }
                transfer::secret_slots(&conn.profile, envelope).len()
            }
            // A fresh salt and nonce by construction, so always new. The slot
            // count is an upper bound: the keychain may hold neither secret.
            SecretSlot::FromKeychain => {
                cost.estimated = true;
                usize::from(!matches!(conn.profile.driver, Driver::Sqlite))
                    + usize::from(conn.profile.ssh_keyring_account().is_some())
            }
            // Nothing published, nothing to derive.
            SecretSlot::Clear => continue,
        };
        if slots == 0 {
            continue;
        }
        cost.connections.push(entity(id, &conn.profile.name));
        cost.slots += slots;
    }

    cost.pbkdf2_rounds = cost.slots as u64 * u64::from(transfer::PBKDF2_ITERATIONS);
    cost
}

fn unresolvable_bindings(draft: &OriginDraft) -> usize {
    let present: HashSet<&str> = draft
        .connections
        .iter()
        .map(|c| c.profile.id.as_str())
        .collect();
    draft
        .bindings
        .iter()
        .filter_map(|b| b.connection_id.as_deref())
        .filter(|id| !present.contains(id))
        .count()
}
