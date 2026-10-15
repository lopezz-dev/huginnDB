//! Merging an imported [`JsonSchemaBundle`] into the local library.
//!
//! Pure: no filesystem, no keychain, no `AppState`, and `now` is a parameter
//! rather than a call to `Utc::now()`, so every rule below is testable.
//!
//! # Import never merges *identities*
//!
//! Same rule as ADR #35: an import mints fresh ids and never adopts one from
//! the file. What it does reconcile is **names**, because a schema library is
//! global and two machines will genuinely have a `product-config` each. The
//! conflict machinery (`ConflictAction`, `ImportConflict`) is the profile
//! importer's, reused verbatim so the wizard behaves identically.
//!
//! # The connection-id problem
//!
//! A binding pinned to a connection is the one part of this payload that is not
//! portable: a profile id is a uuid minted on the machine that created it. The
//! rule is **disable, never widen and never silently drop**:
//!
//! * Widening it to a wildcard would change what the rule *means* — a schema for
//!   one server would start applying to every server.
//! * Dropping it silently loses the user's intent with no way to notice.
//! * Disabling it keeps the intent (the original `connection_id` is preserved,
//!   which is the only thing that lets anyone see what the rule meant), is
//!   inert while off, is visible in the Settings table, and is one click to fix.
//!
//! An environment import is the lucky case: `apply_profile_imports` hands back
//! an original-to-new id map, so there the id is *translated* instead — exactly
//! what already happens to `launch.visible_connections`.

use std::collections::{HashMap, HashSet};

use super::{
    disambiguate_name, has_same_rule, next_order, normalise_binding, JsonSchemaBinding,
    JsonSchemaItem, JsonSchemaLibrary, JsonSchemaSource,
};
use crate::transfer::{ConflictAction, ImportConflict, JsonSchemaBundle, JsonSchemaImportResult};
use uuid::Uuid;

/// How an imported binding's `connection_id` survives the trip.
///
/// An enum rather than a closure so the two policies are named, exhaustive and
/// testable without building an `AppState`.
pub enum ConnectionRemap<'a> {
    /// Standalone import: keep the id — and the binding enabled — only if a
    /// profile with that exact id exists locally. That is what makes
    /// re-importing your own file on the same machine work completely, while a
    /// file from a colleague lands visibly disabled.
    LocalOnly(&'a HashSet<String>),
    /// Environment import: translate through `apply_profile_imports`'s
    /// original-to-new map, like `launch.visible_connections`. A profile the
    /// user chose to skip has no entry, so its bindings land disabled.
    IdMap(&'a HashMap<String, String>),
}

/// Schemas in `incoming` whose **name** already exists in `existing`.
///
/// Keyed on name, not id — see [`JsonSchemaItem::name`]. `ImportConflict::id`
/// carries the *incoming* id because that is the key the frontend echoes back in
/// a `ConflictResolution`; `existing_name` and `incoming_name` are therefore
/// always equal here, which is the visible difference from the profile flavour.
pub fn detect_conflicts(
    existing: &[JsonSchemaItem],
    incoming: &[JsonSchemaItem],
) -> Vec<ImportConflict> {
    let taken: HashSet<&str> = existing.iter().map(|s| s.name.as_str()).collect();
    incoming
        .iter()
        .filter(|s| taken.contains(s.name.as_str()))
        .map(|s| ImportConflict {
            id: s.id.clone(),
            existing_name: s.name.clone(),
            incoming_name: s.name.clone(),
        })
        .collect()
}

/// How many of `bundle`'s bindings would land disabled under `remap`.
pub fn count_unresolvable(bundle: &JsonSchemaBundle, remap: &ConnectionRemap<'_>) -> usize {
    bundle
        .bindings
        .iter()
        .filter(|b| match b.connection_id.as_deref() {
            None => false,
            Some(id) => match remap {
                ConnectionRemap::LocalOnly(known) => !known.contains(id),
                ConnectionRemap::IdMap(map) => !map.contains_key(id),
            },
        })
        .count()
}

/// Merge `bundle` into `lib`.
pub fn apply_imports(
    lib: &mut JsonSchemaLibrary,
    bundle: JsonSchemaBundle,
    resolutions: &HashMap<String, ConflictAction>,
    remap: &ConnectionRemap<'_>,
    now: &str,
) -> JsonSchemaImportResult {
    let mut result = JsonSchemaImportResult::default();
    // Incoming schema id -> the local schema id its bindings should point at.
    // A skipped schema simply has no entry, which is what drops its bindings.
    let mut schema_ids: HashMap<String, String> = HashMap::new();

    for incoming in bundle.schemas {
        let existing_idx = lib.schemas.iter().position(|s| s.name == incoming.name);
        // Default to `Skip` for a conflict the caller left unresolved, matching
        // `apply_profile_imports`.
        //
        // The reason is not the same as the profile importer's, so it is worth
        // stating. There, a conflict is matched by *id*, so it is definitionally
        // the same connection and skipping is plainly idempotent. Here it is
        // matched by *name* (see `JsonSchemaItem::name`), and two people can
        // genuinely own a different `product-config` — so `Rename` looks like the
        // safer, lossless answer.
        //
        // It is not, in practice: the dominant real-world case is re-importing
        // your own export, and renaming turns that into `x (imported)`, `x (2)`,
        // … accumulating a duplicate on every round trip. That was reported as a
        // real problem for profiles and the same mechanism produces it here. The
        // conflict step is still shown whenever a name collides, so a genuinely
        // different schema is one click from `Rename` or `Overwrite`; `Skip` is
        // only what "I did not touch that row" means.
        //
        // Note the branch below: with **no** conflict, this value is irrelevant —
        // an unmatched entry is always inserted as new.
        let action = resolutions
            .get(&incoming.id)
            .copied()
            .unwrap_or(ConflictAction::Skip);

        match (existing_idx, action) {
            (Some(_), ConflictAction::Skip) => {
                result.skipped.push(incoming.name);
            }
            (Some(idx), ConflictAction::Overwrite) => {
                // Keep the local id and `created_at`, so bindings that already
                // point at this entry keep working and the entry keeps its
                // history. `origin_id` is cleared: an id minted elsewhere names
                // an origin this machine does not have.
                let local = &mut lib.schemas[idx];
                local.description = incoming.description;
                local.body = incoming.body;
                local.updated_at = now.to_string();
                local.source = JsonSchemaSource::Imported;
                local.origin_id = None;
                schema_ids.insert(incoming.id, local.id.clone());
                result.overwritten.push(local.name.clone());
            }
            (existing, _) => {
                // `Rename`, or an `Overwrite`/`Skip` whose conflict no longer
                // exists — both mean "insert as a new entry".
                let base = incoming.name.clone();
                let name = disambiguate_name(&base, lib.schemas.iter().map(|s| s.name.as_str()));
                let renamed = name != base;
                let fresh = JsonSchemaItem {
                    id: Uuid::new_v4().to_string(),
                    name: name.clone(),
                    description: incoming.description,
                    body: incoming.body,
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                    source: JsonSchemaSource::Imported,
                    origin_id: None,
                };
                schema_ids.insert(incoming.id, fresh.id.clone());
                lib.schemas.push(fresh);
                if renamed && existing.is_some() {
                    result.renamed.push((base, name));
                } else {
                    result.imported.push(name);
                }
            }
        }
    }

    let mut order = next_order(lib);
    for incoming in bundle.bindings {
        let Some(local_schema_id) = schema_ids.get(&incoming.schema_id) else {
            // Its schema was skipped. A binding with no schema is not a rule to
            // re-enable later, it is a dangling pointer, so it goes.
            result.bindings_dropped += 1;
            continue;
        };

        let mut b = JsonSchemaBinding {
            id: Uuid::new_v4().to_string(),
            schema_id: local_schema_id.clone(),
            order,
            // Never carried over: it names an origin registered on the machine
            // that wrote the file.
            origin_id: None,
            ..incoming
        };

        let mut disabled = false;
        if let Some(original) = b.connection_id.clone() {
            match remap {
                ConnectionRemap::LocalOnly(known) => {
                    if !known.contains(&original) {
                        // Keep the id: it is the only record of what the rule
                        // meant, and it is inert while disabled.
                        b.enabled = false;
                        disabled = true;
                    }
                }
                ConnectionRemap::IdMap(map) => match map.get(&original) {
                    Some(new_id) => b.connection_id = Some(new_id.clone()),
                    None => {
                        b.enabled = false;
                        disabled = true;
                    }
                },
            }
        }

        if normalise_binding(&mut b).is_err() {
            result.bindings_dropped += 1;
            continue;
        }
        if has_same_rule(lib, &b) {
            // Makes re-importing idempotent, and cannot lose intent: an
            // identical rule is redundant by definition. Note this does not
            // re-enable an existing rule the user had switched off.
            result.bindings_duplicate += 1;
            continue;
        }

        lib.bindings.push(b);
        order += 1;
        result.bindings_imported += 1;
        if disabled {
            result.bindings_disabled += 1;
        }
    }

    result
}

/// Collect the schemas named by `ids` plus, optionally, the bindings that point
/// at them.
///
/// Only bindings whose `schema_id` is inside the selection: one pointing outside
/// it would be dangling the moment the file is opened elsewhere.
///
/// `include_bindings` is offered because sharing "just the schema" with someone
/// whose tables are named differently is the common case, and the pinned
/// bindings are precisely the non-portable part.
pub fn collect_bundle(
    lib: &JsonSchemaLibrary,
    ids: &[String],
    include_bindings: bool,
) -> JsonSchemaBundle {
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let schemas: Vec<JsonSchemaItem> = lib
        .schemas
        .iter()
        .filter(|s| wanted.contains(s.id.as_str()))
        .cloned()
        .collect();
    let bindings = if include_bindings {
        lib.bindings
            .iter()
            .filter(|b| wanted.contains(b.schema_id.as_str()))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    JsonSchemaBundle { schemas, bindings }
}
