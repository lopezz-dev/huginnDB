//! User-defined JSON Schema library and per-column bindings.
//!
//! Lives next to `profiles.json` in the platform config dir:
//!
//! * Windows — `%APPDATA%\HuginnDB\json_schemas.json`
//! * Linux   — `$XDG_CONFIG_HOME/HuginnDB/json_schemas.json`
//! * macOS   — `~/Library/Application Support/HuginnDB/json_schemas.json`
//!
//! # Why a file of its own, and not `prefs.json`
//!
//! A real configuration schema is 50–200 KB, and `prefs.json` is rewritten
//! (debounced 400 ms) on every `Ctrl`+wheel of the grid and every column
//! resize. Rewriting hundreds of KB per zoom step is not acceptable, and a
//! schema is a *document* anyway, not a preference.
//!
//! # Why global, and not per environment
//!
//! A binding is `(table, column)`: it belongs to the *server*, not to the
//! Producción/Staging axis. Putting it on `Environment` would reproduce the
//! `visible_databases` bug (ADR #27) exactly — the same table would have a
//! schema in one environment and not in another. `tab_state.json` is also
//! LRU-pruned, which a user-authored library must never be. The right
//! precedent is [`crate::prefs::GridPrefs`]'s `column_widths`, which is
//! likewise "something per table column" and likewise global.
//!
//! # Why `body` is text, and why nothing here parses it
//!
//! `serde_json::Map` is a `BTreeMap` unless the `preserve_order` feature is
//! on, so storing a schema as a `Value` would silently re-sort every key
//! alphabetically on each save — the user opens their schema and `$schema`,
//! `title` and `properties` have moved. Turning `preserve_order` on is not an
//! option either: it is a *global* feature of `serde_json` in this tree and
//! would change key order for every `Value` in the app (BSON conversions,
//! Extended JSON, `internal_layout`, `bson_to_shell_text`) — precisely the
//! invisible-and-permanent loss gotcha #17 and ADRs #29/#34 are about.
//!
//! A body is therefore stored as **source text** and this module **never
//! parses it**. The only JSON Schema parser in the product is the one already
//! inside Monaco's bundled JSON worker, which keeps ADR #33's "one grammar,
//! one parser" trivially true. The cost — `json_schemas.json` is awkward to
//! hand-edit because bodies are escaped strings — is the same one
//! `tab_state.json` already accepts for `PersistedTab::query`.
//!
//! # Versioning
//!
//! `prefs.rs`'s pattern, not `tab_state.rs`'s: `#[serde(default)]` everywhere
//! and **no** migration machinery. `tab_state` carries `RawState`/`into_state`
//! because three real, incompatible reshapes happened; building that scaffold
//! here today would be code no test ever exercises. The shape (two `Vec`s of
//! records) is additive by construction, and `version` exists so a genuine
//! reshape can be detected if one ever comes.

pub mod import;
pub mod infer;
/// Merging the slice a shared origin publishes — ownership by id, not a
/// one-shot import by name. See the module doc for why the two cannot be one.
pub mod origin;

#[cfg(test)]
mod import_tests;
#[cfg(test)]
mod tests;

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// File name used for the persisted library.
const JSON_SCHEMAS_FILE: &str = "json_schemas.json";

/// Current on-disk version. See the module doc: there is deliberately no
/// migration machinery behind this.
pub const CURRENT_VERSION: u32 = 1;

/// Hard cap on one schema body.
///
/// Rejected with an error rather than silently truncated — the contrast with
/// [`crate::tab_state`]'s query-body cap is deliberate: a query body is
/// captured automatically by a debounced autosave the user never asked for, so
/// trimming it quietly is kind. A schema body is something they just typed.
pub const MAX_SCHEMA_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// Model — mirrored in src/types.ts (camelCase on the wire).
// ---------------------------------------------------------------------------

/// The whole persisted library: the schemas plus the rules that attach them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JsonSchemaLibrary {
    pub version: u32,
    pub schemas: Vec<JsonSchemaItem>,
    /// A `Vec`, never a `HashMap`: `order` *and* position are the documented
    /// tie-breaks of the cascade, and `HashMap` iteration order varies between
    /// runs — the exact nondeterminism `Environment::prune` had to fix.
    pub bindings: Vec<JsonSchemaBinding>,
}

impl Default for JsonSchemaLibrary {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            schemas: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

/// One schema in the library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JsonSchemaItem {
    pub id: String,
    /// Display name, and **the conflict key on import** — unlike a profile,
    /// whose conflict key is its id (see [`crate::transfer::detect_conflicts`]).
    /// A schema has no keychain account and no server tying it to an id, and
    /// two machines mint independent uuids for "the same" schema, so the id can
    /// never collide and the name always will.
    pub name: String,
    pub description: Option<String>,
    /// The JSON Schema as **source text**, stored opaquely and never parsed
    /// here. See the module doc.
    pub body: String,
    /// RFC 3339, like `Origin::last_synced_at` / `ExportMetadata::exported_at`.
    pub created_at: String,
    pub updated_at: String,
    pub source: JsonSchemaSource,
    /// Owning shared origin (1.18.0). `Some(..)` also means "synced, not
    /// local", so the same `origin_id == Some(id)` ownership filter
    /// `commands::origins::sync_origin` already runs over profiles applies
    /// unchanged. Always cleared on a file import: an id minted on another
    /// machine points at an origin that is not this machine's.
    pub origin_id: Option<String>,
}

/// Where a library entry came from.
///
/// `Imported` covers both a file import and (from 1.18.0) an origin sync, which
/// is distinguished by `origin_id` being set. A separate `Origin` variant would
/// encode the same fact twice and make the contradictory
/// `source == Origin, origin_id == None` representable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JsonSchemaSource {
    #[default]
    Manual,
    Imported,
    Inferred,
}

/// A rule attaching one schema to a set of columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JsonSchemaBinding {
    pub id: String,
    pub schema_id: String,
    /// A **profile** id, always — never a synthetic `<parent>::db::<db>` one.
    /// The command layer folds an incoming child id to its parent before
    /// matching, so a binding pinned to a server applies to every database
    /// browsed under it. Compared exactly and case-sensitively (it is a uuid).
    /// `None` = any connection.
    pub connection_id: Option<String>,
    /// Whatever the explorer calls a "schema" for that driver: a Postgres
    /// schema, a MySQL/MongoDB *database*, `main` on SQLite. Opaque, matched
    /// case-insensitively. `None` = any.
    pub db_schema: Option<String>,
    /// Simple `*` glob. `None` = any table.
    pub table: Option<String>,
    /// Required. Simple `*` glob; `"*"` is the wildcard spelling.
    ///
    /// Admits dots, because a MongoDB field path arrives as `path.join(".")`
    /// (ADR #29) — and `.` is **not** a metacharacter here, so `customData`
    /// does not match `customData.format`; that needs `customData.*`.
    pub column: String,
    pub enabled: bool,
    /// Tie-break among equally specific bindings, ascending. Maintained by
    /// `reorder_json_schema_bindings`, exactly like `Environment`'s `order`.
    pub order: i32,
    /// Owning shared origin (1.18.0), so an origin sync can compute the same
    /// `vanished` set for bindings that it already computes for profiles.
    pub origin_id: Option<String>,
}

/// Written by hand, **not derived**.
///
/// `#[serde(default)]` on the container fills missing fields from *this* impl,
/// and a derived one would make `enabled` default to `false` — so a binding
/// written by a client that predates the field, or built with
/// `..Default::default()`, would arrive silently disabled.
impl Default for JsonSchemaBinding {
    fn default() -> Self {
        Self {
            id: String::new(),
            schema_id: String::new(),
            connection_id: None,
            db_schema: None,
            table: None,
            column: String::new(),
            enabled: true,
            order: 0,
            origin_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Resolution DTOs (outbound only).
// ---------------------------------------------------------------------------

/// One resolved binding-to-schema pair.
///
/// `binding_id` and `specificity` travel back so the UI can answer "why *this*
/// schema?" without a second call: a cascade nobody can inspect is a cascade
/// nobody trusts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedJsonSchema {
    /// Echoed, because the batch call returns a `Vec` rather than a map.
    pub column: String,
    pub schema_id: String,
    pub name: String,
    pub body: String,
    pub binding_id: String,
    pub specificity: i32,
    /// `true` when the winning rule names this exact column literally, `false`
    /// when it was inherited from a broader one. Drives the "inherited" hint,
    /// and decides whether "unlink" may be offered at all — unlinking an
    /// inherited rule would delete a rule that affects other columns too.
    pub exact: bool,
}

/// A full ranked match, for the "why this schema?" view. Element `0` is what
/// [`resolve_one`] returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchemaMatch {
    pub binding: JsonSchemaBinding,
    pub schema_id: String,
    pub schema_name: String,
    pub specificity: i32,
    /// Rank in the cascade, 1-based — what the Settings table shows as `#`.
    pub rank: usize,
}

/// What a resolution is being asked about.
///
/// `connection_id` is a **precondition**: the caller has already folded a
/// synthetic `<parent>::db::<db>` id down to its parent profile id.
#[derive(Debug, Clone, Copy)]
pub struct ResolveTarget<'a> {
    pub connection_id: Option<&'a str>,
    pub db_schema: Option<&'a str>,
    pub table: Option<&'a str>,
    pub column: &'a str,
}

/// A binding that matched, with everything the ranking needs.
#[derive(Debug, Clone)]
pub struct Ranked<'a> {
    pub binding: &'a JsonSchemaBinding,
    pub schema: &'a JsonSchemaItem,
    pub specificity: i32,
    /// Position in `library.bindings`, the final (unique) sort key.
    pub index: usize,
}

// ---------------------------------------------------------------------------
// Glob matching.
// ---------------------------------------------------------------------------

/// Match `value` against a simple glob where `*` is the only metacharacter.
///
/// Matches the whole string; `*` matches any run of characters including the
/// empty one and including `.`. There is no `?`, no character class and no
/// escape — deliberately, so no new dependency is needed and the syntax stays
/// explainable in one sentence of user-facing documentation.
///
/// Iterative with two backtracking cursors rather than recursive, so a pattern
/// like `****x` against a long value cannot blow the stack or backtrack
/// catastrophically.
///
/// Comparison is ASCII-case-insensitive: someone who writes `widget_*` should
/// not have to know their engine's identifier folding (Postgres lower-cases,
/// MySQL depends on the filesystem, MongoDB is sensitive). A binding that
/// matches too widely only ever feeds autocompletion — it cannot corrupt data.
/// ASCII-only folding (rather than Unicode `to_lowercase`) avoids the
/// dotted/dotless-I class of surprise and allocates nothing; comparing bytes is
/// safe with UTF-8 because no continuation byte can equal `*` (`0x2A`).
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let (mut pi, mut vi) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut resume = 0usize;

    while vi < v.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            resume = vi;
        } else if pi < p.len() && p[pi].eq_ignore_ascii_case(&v[vi]) {
            pi += 1;
            vi += 1;
        } else if let Some(s) = star {
            // Backtrack: let the last `*` swallow one more byte.
            pi = s + 1;
            resume += 1;
            vi = resume;
        } else {
            return false;
        }
    }
    // Trailing `*`s may still match the empty remainder.
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

/// Is this pattern a glob, as opposed to a literal or the bare wildcard?
fn is_glob(pattern: &str) -> bool {
    pattern.contains('*') && pattern != "*"
}

fn ci_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

// ---------------------------------------------------------------------------
// Specificity and matching.
// ---------------------------------------------------------------------------

/// Per-axis weight: literal `2`, glob `1`, wildcard `0`.
fn axis_weight(pattern: Option<&str>) -> i32 {
    match pattern {
        None => 0,
        Some("*") => 0,
        Some(p) if is_glob(p) => 1,
        Some(_) => 2,
    }
}

/// Score a binding so that a higher number wins.
///
/// Priority, highest axis first: **column > table > db_schema > connection**.
/// Each axis contributes at most `2`, and the axes below any given one sum to
/// at most `222 < 1000`, so there can be no carry: the `i32` encodes a strict
/// lexicographic order.
///
/// Connection being the *lightest* axis is the counter-intuitive part, and it
/// is deliberate:
///
/// * `{connection: X, column: "*"}` ("everything on this server") must lose to
///   `{table: "widgets", column: "configuration"}`. If connection dominated,
///   the blanket rule would win, which is wrong.
/// * `{connection: X, table: "widgets", column: "config"}` must beat
///   `{table: "widgets", column: "config"}` — and that is precisely
///   connection's job: breaking ties between otherwise identical rules.
///
/// Column outranking table follows the same logic: naming the exact column is a
/// more specific claim than a blanket rule over a table. Arguable at the
/// margin, but deterministic, documented, and `order` is the escape hatch.
pub fn specificity(b: &JsonSchemaBinding) -> i32 {
    axis_weight(Some(b.column.as_str())) * 1000
        + axis_weight(b.table.as_deref()) * 100
        + axis_weight(b.db_schema.as_deref()) * 10
        + axis_weight(b.connection_id.as_deref())
}

/// Does this binding apply to this target?
///
/// The asymmetry is load-bearing: a pattern of `Some(p)` against a target of
/// `None` does **not** match. A binding pinned to connection X must not apply
/// to a request that carries no connection at all (an ad-hoc query result, for
/// instance). Only `None` *in the pattern* is a wildcard.
pub fn matches(b: &JsonSchemaBinding, t: &ResolveTarget<'_>) -> bool {
    let conn_ok = match b.connection_id.as_deref() {
        None => true,
        Some(want) => t.connection_id == Some(want),
    };
    let schema_ok = match b.db_schema.as_deref() {
        None => true,
        Some(want) => t.db_schema.is_some_and(|got| ci_eq(got, want)),
    };
    let table_ok = match b.table.as_deref() {
        None => true,
        Some(want) => t.table.is_some_and(|got| glob_match(want, got)),
    };
    let column_ok = b.column == "*" || glob_match(&b.column, t.column);
    conn_ok && schema_ok && table_ok && column_ok
}

/// Every enabled, resolvable binding that matches `t`, most specific first.
///
/// The sort has a **total** order (its third key is a unique index), so the
/// result never depends on sort stability — the same lesson as
/// `Environment::prune`'s tie-breaker: load-bearing, not cosmetic.
///
/// A binding whose `schema_id` no longer resolves is skipped rather than
/// raising: a dangling pointer should degrade to "no schema here", never to an
/// error in the middle of opening a cell.
pub fn rank_matches<'a>(lib: &'a JsonSchemaLibrary, t: &ResolveTarget<'_>) -> Vec<Ranked<'a>> {
    let by_id: HashMap<&str, &JsonSchemaItem> =
        lib.schemas.iter().map(|s| (s.id.as_str(), s)).collect();

    let mut out: Vec<Ranked<'a>> = lib
        .bindings
        .iter()
        .enumerate()
        .filter(|(_, b)| b.enabled)
        .filter(|(_, b)| matches(b, t))
        .filter_map(|(index, b)| {
            by_id.get(b.schema_id.as_str()).map(|schema| Ranked {
                binding: b,
                schema,
                specificity: specificity(b),
                index,
            })
        })
        .collect();

    out.sort_by(|a, b| {
        b.specificity
            .cmp(&a.specificity)
            .then_with(|| a.binding.order.cmp(&b.binding.order))
            .then_with(|| a.index.cmp(&b.index))
    });
    out
}

/// The winning binding for `t`, or `None`.
pub fn resolve_one<'a>(lib: &'a JsonSchemaLibrary, t: &ResolveTarget<'_>) -> Option<Ranked<'a>> {
    rank_matches(lib, t).into_iter().next()
}

/// Turn a winner into the wire DTO.
pub fn to_resolved(r: &Ranked<'_>, column: &str) -> ResolvedJsonSchema {
    ResolvedJsonSchema {
        column: column.to_string(),
        schema_id: r.schema.id.clone(),
        name: r.schema.name.clone(),
        body: r.schema.body.clone(),
        binding_id: r.binding.id.clone(),
        specificity: r.specificity,
        exact: !is_glob(&r.binding.column) && r.binding.column != "*",
    }
}

/// The full ranked cascade for one column, as wire DTOs.
pub fn explain(lib: &JsonSchemaLibrary, t: &ResolveTarget<'_>) -> Vec<JsonSchemaMatch> {
    rank_matches(lib, t)
        .into_iter()
        .enumerate()
        .map(|(i, r)| JsonSchemaMatch {
            binding: r.binding.clone(),
            schema_id: r.schema.id.clone(),
            schema_name: r.schema.name.clone(),
            specificity: r.specificity,
            rank: i + 1,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Normalisation and validation.
// ---------------------------------------------------------------------------

/// Canonicalise a binding before it is stored.
///
/// Collapsing `Some("")` is the important half: an emptied form field is an
/// almost-guaranteed frontend bug, and the backend is the right place to make
/// it unrepresentable. `Some("*")` collapses too, because `*` is the universal
/// spelling of "any" and no real identifier is `*` — note this is *not* the
/// `undefined`-vs-`null` distinction of ADR #27, where the two spellings
/// genuinely meant different things; here they mean the same thing.
pub fn normalise_binding(b: &mut JsonSchemaBinding) -> AppResult<()> {
    b.id = b.id.trim().to_string();
    b.schema_id = b.schema_id.trim().to_string();
    b.column = b.column.trim().to_string();

    for axis in [&mut b.connection_id, &mut b.db_schema, &mut b.table] {
        if let Some(v) = axis.as_mut() {
            *v = v.trim().to_string();
        }
        if matches!(axis.as_deref(), Some("") | Some("*")) {
            *axis = None;
        }
    }

    if b.column.is_empty() {
        return Err(AppError::InvalidInput(
            "a binding needs a column name or pattern".into(),
        ));
    }
    if b.schema_id.is_empty() {
        return Err(AppError::InvalidInput("a binding needs a schema".into()));
    }
    Ok(())
}

/// Reject an oversize body up front. See [`MAX_SCHEMA_BYTES`].
pub fn validate_body(body: &str) -> AppResult<()> {
    if body.len() > MAX_SCHEMA_BYTES {
        return Err(AppError::InvalidInput(format!(
            "schema body is {} bytes; the limit is {}",
            body.len(),
            MAX_SCHEMA_BYTES
        )));
    }
    Ok(())
}

/// Do two bindings describe exactly the same rule, ignoring identity and order?
pub fn same_rule(a: &JsonSchemaBinding, b: &JsonSchemaBinding) -> bool {
    a.schema_id == b.schema_id
        && a.connection_id == b.connection_id
        && a.db_schema == b.db_schema
        && a.table == b.table
        && a.column == b.column
}

// ---------------------------------------------------------------------------
// Sweeps.
// ---------------------------------------------------------------------------

/// Drop every binding pinned to a deleted profile; returns how many went.
///
/// Sweeping, rather than leaving them dangling, is right here because a profile
/// id is a uuid that is **never reused** (both `save_profile` and
/// `apply_profile_imports` mint a fresh one), so such a binding can never match
/// again — it is not "inert but possibly meaningful" like
/// `launch.collapsed_connections`, it is a provably dead rule. That makes it a
/// keyed payload worth reaping (ADR #27, precedent `database_visibility`).
///
/// The destruction is asymmetric on purpose: the **schema** — the expensive
/// artefact the user wrote — is never touched; only the six trivial fields of
/// the rule are. Bindings with `connection_id: None` are global and untouched.
pub fn sweep_connection(lib: &mut JsonSchemaLibrary, connection_id: &str) -> usize {
    let before = lib.bindings.len();
    lib.bindings
        .retain(|b| b.connection_id.as_deref() != Some(connection_id));
    before - lib.bindings.len()
}

/// Delete a schema and cascade to its bindings; returns how many bindings went.
///
/// Cascading rather than orphaning: a binding pointing at a schema that does
/// not exist is not a rule, it is a dangling pointer, and there is nothing the
/// user could re-point it at.
pub fn sweep_schema(lib: &mut JsonSchemaLibrary, schema_id: &str) -> usize {
    lib.schemas.retain(|s| s.id != schema_id);
    let before = lib.bindings.len();
    lib.bindings.retain(|b| b.schema_id != schema_id);
    before - lib.bindings.len()
}

/// Rewrite the `connection_id` of local bindings whose profile an import
/// replaced; returns how many were rewritten.
///
/// **Only for `Overwrite` resolutions.** On `Rename` the local profile keeps
/// its original id and its bindings must stay on it; a `Skip` has no entry in
/// the map at all. See the caller in `commands::connection` for why this pass
/// exists: `apply_profile_imports` mints a fresh uuid even when overwriting, so
/// without this every binding pinned to an overwritten profile would silently
/// stop matching — no error, the autocompletion just disappears.
pub fn remap_connection_ids(lib: &mut JsonSchemaLibrary, remap: &HashMap<String, String>) -> usize {
    let mut n = 0;
    for b in lib.bindings.iter_mut() {
        if let Some(old) = b.connection_id.as_deref() {
            if let Some(new) = remap.get(old) {
                b.connection_id = Some(new.clone());
                n += 1;
            }
        }
    }
    n
}

/// Rewrite bindings that name `from` as their literal column, after a rename.
///
/// Scoped to the relation the rename happened in, and only literal columns: a
/// glob rule is about a *shape* of name, so one column changing name is not a
/// reason to rewrite it.
pub fn rename_column(
    lib: &mut JsonSchemaLibrary,
    connection_id: Option<&str>,
    db_schema: Option<&str>,
    table: Option<&str>,
    from: &str,
    to: &str,
) -> usize {
    let mut n = 0;
    for b in lib.bindings.iter_mut() {
        let scoped = b.connection_id.as_deref() == connection_id
            && b.db_schema.as_deref() == db_schema
            && b.table.as_deref() == table;
        if scoped && !is_glob(&b.column) && ci_eq(&b.column, from) {
            b.column = to.to_string();
            n += 1;
        }
    }
    n
}

/// Reassign `order` to match `ids`, mirroring `reorder_environments`.
pub fn reorder_bindings(lib: &mut JsonSchemaLibrary, ids: &[String]) {
    let rank: HashMap<&str, i32> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as i32))
        .collect();
    for b in lib.bindings.iter_mut() {
        if let Some(r) = rank.get(b.id.as_str()) {
            b.order = *r;
        }
    }
    lib.bindings.sort_by_key(|b| b.order);
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

/// Read the library from disk.
///
/// Returns [`JsonSchemaLibrary::default`] when the file is missing or
/// unparseable — a corrupted library costs the user this feature, never their
/// ability to launch the app.
pub fn load_library() -> JsonSchemaLibrary {
    // `read_bytes` rather than `load_or_default`: a file written by a *newer*
    // build has to be accepted with a warning, not silently replaced, so the
    // version check has to run between the parse and the return.
    let Some(bytes) = crate::state_file::read_bytes(JSON_SCHEMAS_FILE, "json_schemas") else {
        return JsonSchemaLibrary::default();
    };
    match serde_json::from_slice::<JsonSchemaLibrary>(&bytes) {
        Ok(lib) => {
            if lib.version > CURRENT_VERSION {
                // Never refuse to load: that would cost the user the whole
                // feature. Warn instead — a downgrade that re-saves will drop
                // whatever this build did not understand.
                eprintln!(
                    "[json_schemas] file version {} is newer than {CURRENT_VERSION}; \
                     unknown fields will be dropped if it is re-saved",
                    lib.version
                );
            }
            lib
        }
        Err(e) => {
            eprintln!("[json_schemas] failed to parse {JSON_SCHEMAS_FILE}: {e}; using defaults");
            JsonSchemaLibrary::default()
        }
    }
}

/// Persist the library atomically (see [`crate::state_file::save_atomic`]).
pub fn save_library(lib: &JsonSchemaLibrary) -> AppResult<()> {
    crate::state_file::save_atomic(JSON_SCHEMAS_FILE, lib)
}

// ---------------------------------------------------------------------------
// Helpers shared with the import path (file types live in `transfer`).
// ---------------------------------------------------------------------------

/// Disambiguate `base` against `taken`. Shared with the profile and
/// environment importers — see [`crate::transfer::disambiguate_name`].
pub use crate::transfer::disambiguate_name;

/// Next free `order` value, so imported bindings land after existing ones.
pub fn next_order(lib: &JsonSchemaLibrary) -> i32 {
    lib.bindings.iter().map(|b| b.order).max().unwrap_or(-1) + 1
}

/// Does a rule identical to `candidate` already exist?
pub fn has_same_rule(lib: &JsonSchemaLibrary, candidate: &JsonSchemaBinding) -> bool {
    lib.bindings.iter().any(|b| same_rule(b, candidate))
}
