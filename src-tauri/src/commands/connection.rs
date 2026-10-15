//! Connection-profile and lifecycle commands.

use crate::db::endpoint::{EndpointExhausted, EndpointGrant, EndpointKey};
use crate::db::pool::{
    close_pool, endpoint_budget, open_pool, smoke_test, top_level_request, PoolLimits,
    PoolOwnership, CLOSE_TIMEOUT, MIN_MAX_CONNECTIONS,
};
use crate::error::{AppError, AppResult};
use crate::keychain;
use crate::log_bus::{self, LogEntry, LogKind};
use crate::ssh_known_hosts;
use crate::state::{ActivePool, AppState, ConnectionProfile, Driver, PoolOrigin, StartupArgs};
use crate::store;
use crate::transfer::{
    self, ConflictAction, ConflictResolution, ExportFile, ImportAnalysis, ImportResult,
    KIND_PROFILES,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// Tauri events broadcast (unscoped — every window, not `emit_to` a single
/// one) so that a change made from *any* window's frontend is reflected in
/// every other window's `useConnections` store. Before this, each window's
/// `active`/`profiles` state was a private snapshot taken once at boot with
/// no way to learn about another window's `connect`/`disconnect`/profile
/// edit — see issue #18.
pub const CONNECTION_OPENED_EVENT: &str = "huginndb://connection-opened";
pub const CONNECTION_CLOSED_EVENT: &str = "huginndb://connection-closed";
pub const PROFILES_CHANGED_EVENT: &str = "huginndb://profiles-changed";

/// Broadcast whenever the number of open OS windows changes — a new one is
/// created (here) or an existing one is destroyed (the global handler in
/// `lib.rs`). Every window's `WindowColorBadge` re-derives its visibility
/// from a fresh `getAllWindows()` count on this event; the payload carries
/// nothing because Tauri's own window registry is the source of truth, not
/// anything tracked on this side.
pub const WINDOW_LIST_CHANGED_EVENT: &str = "huginndb://window-list-changed";

/// Payload for [`CONNECTION_OPENED_EVENT`] / [`CONNECTION_CLOSED_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionSyncPayload {
    pub connection_id: String,
}

/// Emit a `connection` log entry. Used for `connect`, `disconnect`, and
/// `test_connection` so the Console panel can show the actual lifecycle
/// boundary that's currently invisible to the user.
/// `window_label` of `None` broadcasts to every window instead of targeting
/// one — correct for an action with no originating window, such as a connection
/// the MCP bridge opened on a sidecar's behalf. Every Console should see that,
/// the same way they all see the keepalive's connection-lost entries.
fn log_connection(
    app: &AppHandle,
    window_label: Option<&str>,
    connection_id: &str,
    driver: Driver,
    message: &str,
    start: Option<Instant>,
    error: Option<&str>,
) {
    let mut entry = LogEntry::new(LogKind::Connection)
        .connection_id(connection_id)
        .driver(driver.wire_name())
        .message(message);
    if let Some(s) = start {
        entry = entry.duration_ms(s.elapsed().as_millis() as u64);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    match window_label {
        Some(label) => log_bus::emit(app, label, entry),
        None => log_bus::broadcast(app, entry),
    }
}

/// The connection-pool preferences, read once under a single lock so a change
/// can't be observed half-applied.
///
/// Read at *connect* time rather than baked into constants: that is what makes
/// the global preference and the per-profile
/// [`ConnectionProfile::max_connections`] override take effect on the next
/// connection rather than the next release.
#[derive(Clone, Copy)]
struct PoolPolicy {
    /// Total connections allowed against this profile's server.
    budget: u32,
    /// What a per-database view asks for.
    child_request: u32,
    keepalive: Duration,
    /// Ceiling for one keepalive ping. Resolved here rather than inside
    /// `keepalive::spawn` because that function holds a pool and an id, not an
    /// `AppState` — and the profile is right here, at the one moment the
    /// connection is being opened.
    ping_timeout: Duration,
}

fn pool_policy(state: &AppState, profile: &ConnectionProfile) -> PoolPolicy {
    let prefs = state.prefs.read();
    PoolPolicy {
        budget: endpoint_budget(profile, prefs.connections.max_connections),
        child_request: prefs.connections.child_max_connections,
        keepalive: Duration::from_secs(u64::from(prefs.connections.keepalive_secs)),
        ping_timeout: crate::db::pool::operation_timeout(
            profile,
            prefs.connections.operation_timeout_secs,
        ),
    }
}

/// Turn a refused reservation into an error that names the server and our own
/// share of it.
///
/// Distinct from [`annotate_connection_limit`], which decorates a refusal that
/// came back *from* the server: this one never reached the wire. Saying so
/// matters — the remedy is HuginnDB's own setting, not the DBA's.
fn exhausted_to_error(e: EndpointExhausted) -> AppError {
    AppError::TooManyConnections(format!(
        "HuginnDB's own budget for {} is spent ({}/{} connections in use). Raise it in \
         Settings → Connections or on this connection, or close a database view.",
        e.label, e.in_use, e.budget
    ))
}

/// How large a share of the server's budget a top-level pool asks for, given
/// who it is for.
///
/// A connection a person opened backs a query editor, a grid and a schema tree
/// at once, so it takes [`top_level_request`]'s five. A connection the MCP
/// connector asked for backs one tool call at a time — the sidecar's own
/// default when it opens the pool itself is *two* — so spending five of a
/// ten-slot endpoint budget on one is the wrong split, and two of them used to
/// exhaust a server's whole allowance between them. It still cannot go below
/// [`MIN_MAX_CONNECTIONS`], because two sidecars can share one pool and a
/// single slot deadlocks a batch against a concurrent read.
///
/// `in_use` is what the server's budget already has reserved, and it is what
/// makes a person's share adaptive. The first connection to a server takes
/// the full [`top_level_request`]. Every later one takes **half of what is
/// left**, never below [`MIN_MAX_CONNECTIONS`]. Before this, every connection
/// asked for five, so two profiles on one server spent a budget of ten between
/// them and the third was refused by our own accounting — while the server
/// itself saw two or three sockets. Pool sizes cannot change once a pool is
/// open (in sqlx or in the MongoDB driver), so the split has to be decided
/// here, at connect time; halving what is left keeps room for whoever comes
/// next. Under the default budget that is 5, 2, 2: three connections where
/// there used to be two.
fn top_level_request_for(origin: PoolOrigin, policy: &PoolPolicy, in_use: u32) -> u32 {
    match origin {
        PoolOrigin::User if in_use == 0 => top_level_request(policy.budget, policy.child_request),
        PoolOrigin::User => (policy.budget.saturating_sub(in_use) / 2)
            .clamp(MIN_MAX_CONNECTIONS, crate::db::pool::TOP_LEVEL_REQUEST),
        PoolOrigin::Bridge => policy
            .child_request
            .max(MIN_MAX_CONNECTIONS)
            .min(policy.budget),
    }
}

/// Reserve capacity for a top-level pool against `profile`'s server.
///
/// `Ok(None)` means the profile has no server to ration (SQLite) — not that the
/// reservation failed.
///
/// When the budget is spent, our own idle per-database views on the same
/// server are closed, least recently used first, before giving up — the same
/// reclaim `open_database_view` already did for views. A view reopens by
/// itself the next time its database is touched, so it is a far cheaper thing
/// to lose than the connection the user just asked for.
async fn reserve_top_level(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    profile: &ConnectionProfile,
    policy: &PoolPolicy,
    origin: PoolOrigin,
) -> AppResult<Option<EndpointGrant>> {
    let Some(key) = EndpointKey::for_profile(profile) else {
        return Ok(None);
    };
    let mut reclaimable = state.connections.read().views_on_endpoint_by_lru(&key);
    loop {
        let requested = top_level_request_for(origin, policy, state.endpoints.in_use(&key));
        match state
            .endpoints
            .reserve(&key, requested, policy.budget, MIN_MAX_CONNECTIONS)
        {
            Ok(grant) => return Ok(Some(grant)),
            Err(exhausted) => {
                if reclaimable.is_empty() {
                    return Err(exhausted_to_error(exhausted));
                }
                let victim = reclaimable.remove(0);
                close_view(app, state, window_label, profile.driver, &victim, "budget").await;
            }
        }
    }
}

/// Pool sizing implied by a grant. SQLite (`None`) is fixed at one connection
/// inside `open_pool` regardless of what is passed here.
fn limits_for(grant: &Option<EndpointGrant>) -> PoolLimits {
    match grant {
        Some(g) => PoolLimits::granted(g.amount()),
        None => PoolLimits::default(),
    }
}

/// Add HuginnDB's own pool footprint to a connection-limit refusal.
///
/// A bare "FATAL: sorry, too many connections already" tells the user their
/// server is full and nothing about what to do — least of all that the client
/// showing them the error is holding fourteen pools of its own. Quoting the
/// count turns it into something they can act on, and naming the other usual
/// occupants heads off the wrong conclusion, since HuginnDB is frequently the
/// marginal straw rather than the main consumer.
///
/// Holding nothing is not a footprint worth quoting: the sentence exists to
/// disclose HuginnDB's own share, and "0 connection pool(s) and 0 per-database
/// pool(s)" discloses that there is none to release while reading as though
/// the count were the point. That happens on the very first connect of a
/// session — the pool that just failed is never in the map, since insertion
/// only happens on the success arm — which is exactly when the reader is least
/// able to tell a real limit from a server that never answered. The hint about
/// the other occupants still applies and stays.
///
/// Any other error passes through untouched.
fn annotate_connection_limit(state: &AppState, error: AppError) -> AppError {
    if !error.is_too_many_connections() {
        return error;
    }
    let AppError::TooManyConnections(detail) = &error else {
        return error;
    };
    let (connections, views) = state.connections.read().counts();
    let ours = if connections + views == 0 {
        String::new()
    } else {
        format!(
            " HuginnDB is currently holding {connections} connection pool(s) and {views} \
             per-database pool(s)."
        )
    };
    AppError::TooManyConnections(format!(
        "{detail} —{ours} Other clients on this machine (IDE data sources, application \
         connection pools, huginndb-mcp sidecars) count against the same server limit."
    ))
}

/// The keychain account a person's own password lives under for `profile`,
/// when they sign in with their own database user and it differs from the
/// connection's — the second entry a deletion has to take with it.
fn personal_account(
    policy: &crate::policy::SharedPolicy,
    profile: &ConnectionProfile,
) -> Option<String> {
    let effective = crate::credentials::effective_profile(policy, profile);
    let account = effective.keyring_account();
    (account != profile.keyring_account()).then_some(account)
}

/// Look up the password for `profile` from the OS keychain.
///
/// SQLite profiles never store a password (the database is a local file),
/// so we short-circuit with the empty string for them.
///
/// `pub(crate)` so `crate::mcp` can share this driver-aware resolution
/// instead of calling `keychain::require_password` directly — see the MCP
/// module's `ensure_connected` for why that divergence was a bug.
pub(crate) fn resolve_password(profile: &ConnectionProfile) -> AppResult<String> {
    if matches!(profile.driver, Driver::Sqlite) {
        return Ok(String::new());
    }
    // MongoDB's password is optional: it may be embedded in the connection URI
    // (or the server may allow unauthenticated local access), so a missing
    // keychain entry is not an error — fall back to an empty string.
    //
    // Except with a personal user in force (`crate::credentials`): then the
    // published credential was taken out of the URI on purpose, and signing in
    // with no password would only fail at the server with a vaguer message.
    if matches!(profile.driver, Driver::Mongo) && profile.personal_username.is_none() {
        return Ok(keychain::get_password(&profile.keyring_account())?.unwrap_or_default());
    }
    keychain::require_password(&profile.keyring_account())
}

/// Look up the SSH secret (password or key passphrase) for `profile` from
/// the OS keychain. Returns `Ok(None)` if the profile has no tunnel, or if
/// no secret has been stored yet (some tunnels — e.g. a passphrase-less
/// key — legitimately have no stored secret).
pub(crate) fn resolve_ssh_secret(profile: &ConnectionProfile) -> AppResult<Option<String>> {
    let Some(account) = profile.ssh_keyring_account() else {
        return Ok(None);
    };
    keychain::get_password(&account)
}

/// Ids of the connections that are open in a window but were edited since —
/// pointed at another database, host or user — so every query from that
/// window still goes where the connection *used* to point.
///
/// Saving a profile does not touch its open pool, deliberately: closing it
/// would cut a running query and drop unsaved grid edits without asking. So
/// the windows ask this after every `profiles-changed` and offer a one-click
/// reconnect instead, the same affordance a lost connection gets. Compared on
/// the effective profile, as `connect_inner` dials it, so a personal database
/// user taking effect counts as an edit too.
#[tauri::command]
pub fn edited_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let targets: Vec<(String, String)> = state
        .profiles
        .read()
        .iter()
        .map(|p| {
            let effective = crate::credentials::effective_profile(&state.policy, p);
            (p.id.clone(), effective.dial_target())
        })
        .collect();
    Ok(state
        .connections
        .read()
        .redialed_by_people(targets.iter().map(|(id, t)| (id.as_str(), t.clone()))))
}

/// Return every saved profile.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> AppResult<Vec<ConnectionProfile>> {
    Ok(state.profiles.read().clone())
}

/// Create or update a profile.
///
/// * `profile` — profile to persist. If `profile.id` is empty a fresh
///   UUID is generated.
/// * `password` — if provided, written to the DB keychain entry. Passing
///   `None` leaves any existing stored password untouched.
/// * `ssh_secret` — if provided AND the profile has a tunnel configured,
///   written to a separate SSH keychain entry. Passing `None` leaves any
///   existing stored secret untouched. If the profile no longer has a
///   tunnel, any previously-stored SSH secret for this profile is removed.
#[tauri::command]
pub fn save_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    mut profile: ConnectionProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionProfile> {
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    // A person's own database user is set by its own command, never by the
    // form — which does not carry it — so a save keeps what is stored.
    if profile.personal_username.is_none() {
        profile.personal_username = state
            .profiles
            .read()
            .iter()
            .find(|p| p.id == profile.id)
            .and_then(|p| p.personal_username.clone());
    }

    if let Some(pw) = password {
        if !matches!(profile.driver, Driver::Sqlite) {
            // Under the account the connection signs in with: the policy may
            // pin a personal user (`dbUser`), and a password stored under the
            // published user's account would never be read.
            let account =
                crate::credentials::effective_profile(&state.policy, &profile).keyring_account();
            keychain::set_password(&account, &pw)?;
        }
    }

    match (profile.ssh_keyring_account(), ssh_secret) {
        // Tunnel present + new secret → persist it.
        (Some(account), Some(secret)) => {
            keychain::set_password(&account, &secret)?;
        }
        // Tunnel present + no new secret → keep whatever was there.
        (Some(_), None) => {}
        // Tunnel absent → make sure no orphan SSH secret lingers under any
        // prior account derived from a previous tunnel config for this id.
        (None, _) => {
            // We don't know the prior SSH username, but the account string
            // is namespaced by `${id}::ssh::${username}`. The cleanest
            // sweep is delegated to delete_profile; on plain update we
            // leave any prior entry in place (it cannot be resolved
            // without a tunnel config and will be cleaned up by deletion).
        }
    }

    {
        let mut profiles = state.profiles.write();
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        store::save_profiles(&profiles)?;
    }
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(profile)
}

/// What a bulk delete will do, and what it will refuse.
///
/// A pure decision, split out from [`delete_profiles`] so the refusal rule is
/// testable without a keychain or a disk — same criterion as `already_landed` in
/// `commands::origins` and `spec_is_view` in `db::mongo`.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct BulkDeletePlan {
    /// Ids that exist locally and are the user's to delete.
    pub delete: Vec<String>,
    /// Refused: a shared origin publishes these (#108). Deleting one locally is
    /// a no-op the next sync undoes — the id travels in the published file, so
    /// `merge_profiles_bundle` recreates it identically — and it destroys the
    /// keychain entry on the way. Removing the origin is the way out, and that
    /// has its own flow.
    pub skipped_origin: Vec<String>,
    /// Ids that were not in `profiles.json` to begin with.
    pub missing: Vec<String>,
}

/// Sort `ids` into the three buckets above, preserving the requested order
/// within each — the report is what the UI reads back to the user.
pub(crate) fn plan_bulk_delete(profiles: &[ConnectionProfile], ids: &[String]) -> BulkDeletePlan {
    let mut plan = BulkDeletePlan::default();
    for id in ids {
        match profiles.iter().find(|p| &p.id == id) {
            None => plan.missing.push(id.clone()),
            Some(p) if p.origin_id.is_some() => plan.skipped_origin.push(id.clone()),
            Some(_) => plan.delete.push(id.clone()),
        }
    }
    plan
}

/// Erase every trace of `ids` from the session state of **all** environments.
///
/// Extracted from [`delete_profile`] so the single and the batch path share one
/// sweep, and so the sweep is testable against a bare
/// [`crate::tab_state::PersistedTabState`] — which it had no test for at all,
/// despite being the thing that stops a persisted tab pointing at a connection
/// that no longer exists.
pub(crate) fn sweep_tab_state_for_profiles(
    ts: &mut crate::tab_state::PersistedTabState,
    ids: &[String],
) {
    // Every environment, not just the active one: the profile is gone globally,
    // so an entry surviving elsewhere would come back as a tab pointing at a
    // connection that no longer exists.
    for env in &mut ts.environments {
        for id in ids {
            env.connections.remove(id);
            env.launch.active_connections.retain(|c| c != id);
            if env.launch.selected_connection_id.as_deref() == Some(id.as_str()) {
                env.launch.selected_connection_id = None;
            }
            // Unlike the id lists above (where a stale entry is inert and left
            // alone on purpose), an override is a keyed payload: leaving it
            // behind would grow the blob with dead keys and, if the id were ever
            // reused, silently apply somebody else's subset.
            env.launch.database_visibility.remove(id);
        }
    }
}

/// Drop the JSON Schema bindings pinned to `ids`, saving and announcing once.
///
/// Same reasoning as `database_visibility` in the tab-state sweep, one step
/// further: a binding pinned to a deleted profile can never match again, because
/// a profile id is a uuid that is never reused. The schema itself — the
/// expensive artefact the user wrote — is deliberately untouched; only the rule
/// goes.
fn sweep_json_schema_bindings(app: &AppHandle, state: &AppState, ids: &[String]) -> AppResult<()> {
    let swept = {
        let mut lib = state.json_schemas.write();
        let n: usize = ids
            .iter()
            .map(|id| crate::json_schemas::sweep_connection(&mut lib, id))
            .sum();
        if n == 0 {
            None
        } else {
            Some((n, lib.clone()))
        }
    };
    let Some((n, snapshot)) = swept else {
        return Ok(());
    };
    crate::json_schemas::save_library(&snapshot)?;
    let count = ids.len();
    eprintln!("[json_schemas] dropped {n} binding(s) pinned to {count} deleted profile(s)");
    let _ = app.emit(
        crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
        (),
    );
    Ok(())
}

/// Outcome of [`delete_profiles`], so the confirmation dialog can say what it
/// skipped and what failed instead of swallowing it.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProfilesReport {
    pub deleted: Vec<String>,
    pub skipped_origin: Vec<String>,
    pub missing: Vec<String>,
    /// `(id, message)` for a profile already out of `profiles.json` whose
    /// keychain entry could not be removed. Best-effort on purpose: a locked or
    /// unavailable keychain must not leave the rest of the batch undone. That
    /// diverges from [`delete_profile`], where the error *does* propagate —
    /// there is nothing else in flight to protect there.
    pub failed: Vec<(String, String)>,
}

/// Set the MCP write policy on several profiles at once.
///
/// One write of `profiles.json` and one `profiles-changed` event, for the same
/// reason [`delete_profiles`] exists: the Settings panel offers "set every
/// connection to read-only", and looping `save_profile` over thirty connections
/// means thirty atomic rewrites and thirty global events, each of which makes
/// every open window re-read and re-render.
///
/// Touches keychain entries not at all — this is one enum field — which is what
/// makes it safe to run over a profile a shared origin published. That policy is
/// a local trust decision and `merge_profiles_bundle` preserves it across a
/// sync; without that, this command would appear to work and quietly revert.
///
/// Returns how many profiles actually changed, so a caller can tell "done" from
/// "they were already all like that".
#[tauri::command]
pub fn set_mcp_write_policy(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    level: crate::state::McpWritePolicy,
) -> AppResult<usize> {
    set_local_flag(app, state, ids, |p| {
        if p.mcp_write == level {
            return false;
        }
        p.mcp_write = level;
        true
    })
}

/// Set one local, non-secret field on several profiles at once, saving and
/// emitting exactly once.
///
/// The body the three `set_*` commands below share. `apply` returns whether it
/// actually changed the profile, so an already-correct batch costs no disk
/// write and no `profiles-changed` event — the distinction the callers' return
/// value reports, and the reason this can't just be a blind assignment.
///
/// Deliberately scoped to fields that touch neither the keychain nor anything a
/// shared origin publishes: every current caller sets a *local* trust or
/// resource decision (`mcp_write`, `mcp_exposed`, `pulse_enabled`,
/// `ai_enabled`, `ai_rows_allowed`), which is what makes running one over an
/// origin-owned profile safe. Reach for `save_profile` for anything else.
fn set_local_flag(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    mut apply: impl FnMut(&mut crate::state::ConnectionProfile) -> bool,
) -> AppResult<usize> {
    let changed = {
        let mut profiles = state.profiles.write();
        let wanted: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut changed = 0usize;
        for p in profiles.iter_mut() {
            if wanted.contains(p.id.as_str()) && apply(p) {
                changed += 1;
            }
        }
        if changed > 0 {
            store::save_profiles(&profiles)?;
        }
        changed
    };
    if changed > 0 {
        let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    }
    Ok(changed)
}

/// Turn Pulse's history sampler on or off for several profiles at once.
///
/// Same shape as [`set_mcp_write_policy`] immediately above, for the same
/// reasons: one write of `profiles.json`, one event, and — because this too
/// is one bool the sampler itself reads — `merge_profiles_bundle` preserves
/// it across a shared-origin sync the same way it preserves `mcp_write`.
#[tauri::command]
pub fn set_pulse_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    enabled: bool,
) -> AppResult<usize> {
    set_local_flag(app, state, ids, |p| {
        if p.pulse_enabled == enabled {
            return false;
        }
        p.pulse_enabled = enabled;
        true
    })
}

/// Expose (or hide) several connections from the headless MCP connector.
///
/// The write half of `ConnectionProfile::mcp_exposed`, and the reason
/// Settings → MCP stopped being a snippet generator: the exposed set used to
/// live only in the MCP client's config as `--connections <uuid>,<uuid>`, so
/// the panel could offer the choice but not make it. Same shape as the two
/// commands above, and local for the same reason — an origin's publisher does
/// not decide what this machine's AI clients may reach.
///
/// The sidecar re-reads the flag per call, so this takes effect without
/// restarting the MCP client — with one exception it cannot control: a client
/// launched with an explicit `--connections` list is pinned to it, since an
/// argument the user typed outranks a checkbox.
#[tauri::command]
pub fn set_mcp_exposed(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    exposed: bool,
) -> AppResult<usize> {
    set_local_flag(app, state, ids, |p| {
        if p.mcp_exposed == exposed {
            return false;
        }
        p.mcp_exposed = exposed;
        true
    })
}

/// Let the in-app AI panel reach (or stop reaching) several connections.
///
/// The same shape and the same local-only reasoning as the three commands
/// above — `merge_into` preserves it across a shared-origin sync and the bundle
/// import clears it, because what a language model on *this* machine may read
/// is not a publisher's decision.
///
/// One level coarser than [`set_ai_rows_allowed`] below, and the one to reach
/// for first: a connection that is off is not reachable by the assistant at
/// all, by name or by id (`crate::ai::exec::resolve_connection`), so it is also
/// the answer to "never let the assistant near this client's database".
#[tauri::command]
pub fn set_ai_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    enabled: bool,
) -> AppResult<usize> {
    set_local_flag(app, state, ids, |p| {
        if p.ai_enabled == enabled {
            return false;
        }
        p.ai_enabled = enabled;
        true
    })
}

/// Allow (or stop allowing) these connections' **rows** to reach an inference
/// endpoint the user has not declared as their own infrastructure.
///
/// The per-connection half of `crate::ai`'s coupling rule. It changes nothing
/// for a trusted endpoint, which may read rows regardless — see
/// `crate::ai::scope::DataScope::resolve`, which documents that asymmetry.
#[tauri::command]
pub fn set_ai_rows_allowed(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    allowed: bool,
) -> AppResult<usize> {
    set_local_flag(app, state, ids, |p| {
        if p.ai_rows_allowed == allowed {
            return false;
        }
        p.ai_rows_allowed = allowed;
        true
    })
}

/// Set (or clear) the free-text notes the assistant reads for one connection.
///
/// `ConnectionProfile::ai_notes`'s write half — the answer to "the model does
/// not understand my database". Empty (or whitespace) clears it, so the field
/// has one representation for absent rather than `Some("")` and `None` both
/// meaning nothing.
///
/// One id rather than a list, unlike the flag commands above: a note is about
/// one database, and applying the same paragraph to several connections at once
/// is not a gesture anyone wants. Local for the same reason as the flags, with
/// the caveat written on the field: publishing a team's notes would need a
/// field in the origin document.
#[tauri::command]
pub fn set_ai_notes(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    notes: String,
) -> AppResult<usize> {
    let notes = notes.trim();
    let notes = (!notes.is_empty()).then(|| {
        // Bounded on the way in as well as in the prompt: a `profiles.json`
        // carrying a pasted-in wiki page is a slow load and a big write on
        // every unrelated flag change.
        notes
            .chars()
            .take(crate::ai::exec::MAX_AI_NOTES_CHARS)
            .collect::<String>()
    });
    set_local_flag(app, state, vec![id], |p| {
        if p.ai_notes == notes {
            return false;
        }
        p.ai_notes = notes.clone();
        true
    })
}

/// Delete the profile with `id` and its associated keychain entries.
///
/// Also drops the persisted per-connection tab state (open tabs, schema-tree
/// expansion) so we don't keep dangling entries pointing at a profile that
/// no longer exists.
///
/// Deliberately does **not** refuse an origin-published profile, unlike
/// [`delete_profiles`]. `useOriginSync.retire` / `retireAllVanished` come through
/// here to retire a mirror whose origin stopped publishing it, which is the one
/// sanctioned way to remove one for real; guarding here would break that flow.
#[tauri::command]
pub fn delete_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let removed = {
        let mut profiles = state.profiles.write();
        let removed = profiles
            .iter()
            .position(|p| p.id == id)
            .map(|i| profiles.remove(i));
        store::save_profiles(&profiles)?;
        removed
    };
    if let Some(p) = removed {
        if !matches!(p.driver, Driver::Sqlite) {
            keychain::delete_password(&p.keyring_account())?;
            if let Some(account) = personal_account(&state.policy, &p) {
                keychain::delete_password(&account)?;
            }
        }
        if let Some(ssh_account) = p.ssh_keyring_account() {
            keychain::delete_password(&ssh_account)?;
        }
    }
    let ids = [id];
    crate::tab_state::mutate(&state.tab_state, |ts| {
        sweep_tab_state_for_profiles(ts, &ids);
        Ok(())
    })?;
    sweep_json_schema_bindings(&app, state.inner(), &ids)?;
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(())
}

/// Delete several profiles in one pass, refusing the ones a shared origin
/// publishes.
///
/// The frontend used to loop over [`delete_profile`], which for forty
/// connections meant forty atomic rewrites of `profiles.json`, forty of
/// `tab_state.json`, and forty global `profiles-changed` events — each of which
/// makes *every* open window re-read the profile list and re-render the tree,
/// the status bar and the rail. Atomicity was never the argument
/// (`save_profiles` is already atomic, so a crash mid-loop left a consistent
/// partial delete); the arguments are O(1) writes, one event, one place to
/// express the origin refusal where a future caller — the CLI, the MCP
/// connector — cannot route around it, and a report instead of a silent
/// swallowed error.
#[tauri::command]
pub fn delete_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<DeleteProfilesReport> {
    let mut report = DeleteProfilesReport::default();
    let removed = {
        let mut profiles = state.profiles.write();
        let plan = plan_bulk_delete(&profiles, &ids);
        report.skipped_origin = plan.skipped_origin;
        report.missing = plan.missing;
        if plan.delete.is_empty() {
            return Ok(report);
        }
        let doomed: std::collections::HashSet<&str> =
            plan.delete.iter().map(String::as_str).collect();
        let removed: Vec<ConnectionProfile> = profiles
            .iter()
            .filter(|p| doomed.contains(p.id.as_str()))
            .cloned()
            .collect();
        profiles.retain(|p| !doomed.contains(p.id.as_str()));
        store::save_profiles(&profiles)?;
        report.deleted = plan.delete;
        removed
    };

    for p in &removed {
        if !matches!(p.driver, Driver::Sqlite) {
            if let Err(e) = keychain::delete_password(&p.keyring_account()) {
                report.failed.push((p.id.clone(), e.to_string()));
            }
            if let Some(account) = personal_account(&state.policy, p) {
                if let Err(e) = keychain::delete_password(&account) {
                    report.failed.push((p.id.clone(), e.to_string()));
                }
            }
        }
        if let Some(ssh_account) = p.ssh_keyring_account() {
            if let Err(e) = keychain::delete_password(&ssh_account) {
                report.failed.push((p.id.clone(), e.to_string()));
            }
        }
    }

    crate::tab_state::mutate(&state.tab_state, |ts| {
        sweep_tab_state_for_profiles(ts, &report.deleted);
        Ok(())
    })?;
    sweep_json_schema_bindings(&app, state.inner(), &report.deleted)?;
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(report)
}

/// Try opening `profile` end-to-end and execute `SELECT 1` against it.
///
/// Used by the "Test" button in the connection dialog. The temporary pool
/// — and any SSH tunnel that fronts it — is dropped immediately after the
/// round-trip.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<String> {
    let window_label = Some(window.label());
    let profile = crate::credentials::effective_profile(&state.policy, &profile);
    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };
    let ssh = match ssh_secret {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&profile)?,
    };

    // Persist a freshly-typed SSH secret to the OS keychain *before* the
    // smoke-test. This is what triggers the OS credential prompt
    // (Windows Credential Manager, libsecret, macOS Keychain) the first
    // time the user wires up a tunnel — matching the UX they already get
    // for the DB password on a regular connection. We guard on a
    // non-empty `profile.id` so the namespaced account
    // (`<id>::ssh::<user>`) cannot collide between draft profiles that
    // haven't been saved yet; the frontend assigns a stable UUID before
    // calling Test so this branch is reached on new profiles too.
    if let (Some(account), Some(secret)) = (profile.ssh_keyring_account(), ssh.as_ref()) {
        if !profile.id.is_empty() {
            keychain::set_password(&account, secret)?;
        }
    }

    let known_hosts = state.known_hosts.clone();
    // Meter the probe too. It is one connection for a couple of seconds, but
    // "Test" is a button people press repeatedly while fixing a typo — against
    // the very server they are already struggling to get into. Floor of one:
    // nothing interactive runs on this pool, so it cannot deadlock the way an
    // undersized working pool would. The grant lives to the end of the command.
    let _probe_grant = match EndpointKey::for_profile(&profile) {
        Some(key) => {
            let budget = endpoint_budget(&profile, state.prefs.read().connections.max_connections);
            Some(
                state
                    .endpoints
                    .reserve(&key, 1, budget, 1)
                    .map_err(exhausted_to_error)?,
            )
        }
        None => None,
    };
    let start = Instant::now();
    log_connection(
        &app,
        window_label,
        &profile.id,
        profile.driver,
        "test_connection: start",
        None,
        None,
    );
    match smoke_test(&profile, &pw, ssh, known_hosts).await {
        Ok(()) => {
            log_connection(
                &app,
                window_label,
                &profile.id,
                profile.driver,
                "test_connection: ok",
                Some(start),
                None,
            );
            Ok("ok".into())
        }
        Err(e) => {
            let msg = e.to_string();
            log_connection(
                &app,
                window_label,
                &profile.id,
                profile.driver,
                "test_connection: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
}

/// Open a long-lived pool for the profile `id` and add it to
/// [`crate::state::ActiveConnections`]. When the profile carries an SSH
/// tunnel, the tunnel is brought up first and lives as long as the pool.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<()> {
    // A connection the person's role cannot reach is not even opened, so the
    // refusal comes with the policy's reason rather than as an empty explorer.
    crate::commands::guard::endpoint(state.inner(), &id)?;
    connect_inner(
        &app,
        state.inner(),
        Some(window.label()),
        &id,
        password,
        ssh_secret,
        PoolOrigin::User,
    )
    .await?;
    // Here in the wrapper, not in `connect_inner`: the MCP bridge shares the
    // inner body, and an AI opening a pool is not the person's recent history.
    crate::jump_list::note_connected(&app, &id);
    Ok(())
}

/// The body of [`connect`], reusable from a context with no window.
///
/// Extracted for the MCP bridge (`crate::bridge::server`), which opens pools on
/// a sidecar's behalf: it has an `AppHandle` but no originating window, and it
/// must go through *exactly* this path rather than a parallel one — the
/// endpoint reservation, the session-secret cache and the Console entry are all
/// things a second implementation would drift on.
///
/// `origin` is what the two callers do *not* share, and it decides three
/// things: how big a share of the server this pool reserves
/// ([`top_level_request_for`]), whether it gets a keepalive, and whether
/// [`crate::pool_reaper`] may ever close it. A bridge-opened pool that arrived
/// here as [`PoolOrigin::User`] would be immortal, which is exactly the bug in
/// ADR #67.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect_inner(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    id: &str,
    password: Option<String>,
    ssh_secret: Option<String>,
    origin: PoolOrigin,
) -> AppResult<()> {
    let id = id.to_string();
    let profile = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))?;
    // Signs in as the person when a personal database user is in force — the
    // policy's `dbUser`, or their own choice — with their own password.
    let profile = crate::credentials::effective_profile(&state.policy, &profile);

    // Held until this function returns, across the connect below: a second
    // opener of the same id waits here and then takes the reuse path instead
    // of dialling a second pool. See `AppState::open_lock`.
    let open_lock = state.open_lock(&id);
    let _opening = open_lock.lock().await;

    // The profile may have been edited since the pool for this id opened —
    // pointed at another database, host or user — and the reuse path below
    // would keep answering from the old one. A pool only the connector uses
    // is closed and dialled again; one a window is showing is the person's
    // own, so the connector is told to ask them rather than having it pulled
    // out from under their tabs.
    let target = profile.dial_target();
    let redialed = state.connections.read().redialed(&id, &target);
    match (redialed, origin) {
        (Some(PoolOrigin::Bridge), _) => {
            close_connection(
                app,
                state,
                window_label,
                &id,
                "disconnect: the connection was edited since the MCP connector opened it; \
                 reopening with the new settings",
            )
            .await;
        }
        (Some(PoolOrigin::User), PoolOrigin::Bridge) => {
            return Err(AppError::InvalidInput(format!(
                "the connection {:?} was edited in HuginnDB while it was open there, and that \
                 session still uses the old settings. Disconnect it in HuginnDB (or reconnect \
                 it) so the connector reaches what the connection now points at.",
                profile.name
            )));
        }
        _ => {}
    }

    // Idempotent: a second `connect` for an already-active id — e.g. a
    // secondary window connecting to the same profile the main window
    // already opened — must NOT fall through to `ActiveConnections::insert`,
    // whose replace semantics would tear down the live pool (and any SSH
    // tunnel) out from under the window that's using it. Reuse it instead.
    if state.connections.read().contains(&id) {
        if let Some(label) = window_label {
            state.connections.write().hold(&id, label);
        }
        // A person connecting to a profile the MCP connector already opened
        // *adopts* it: from now on a window shows it, so the reaper must stop
        // treating it as disposable and the heartbeat the bridge path skipped
        // has to start. The pool keeps its smaller bridge-sized grant —
        // re-reserving would need a second endpoint transaction, and throughput
        // is a nuance where being reaped mid-session is not.
        if origin == PoolOrigin::User {
            let policy = pool_policy(state, &profile);
            let adopted = state.connections.write().adopt_from_bridge(&id);
            if let Some((pool, last_used)) = adopted {
                // `keepalive::spawn` is synchronous — it only starts a task —
                // so taking the write lock again here crosses no await point.
                let keepalive = crate::keepalive::spawn(
                    app.clone(),
                    id.clone(),
                    pool,
                    policy.keepalive,
                    policy.ping_timeout,
                    last_used,
                );
                state.connections.write().attach_keepalive(&id, keepalive);
                log_connection(
                    app,
                    window_label,
                    &id,
                    profile.driver,
                    "connect: adopting the pool the MCP connector opened",
                    None,
                    None,
                );
                return Ok(());
            }
        }
        log_connection(
            app,
            window_label,
            &id,
            profile.driver,
            "connect: already active, reusing existing pool",
            None,
            None,
        );
        return Ok(());
    }

    let pw = match password {
        Some(p) => p,
        None => resolve_password(&profile)?,
    };
    let ssh = match ssh_secret {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&profile)?,
    };

    let known_hosts = state.known_hosts.clone();
    let policy = pool_policy(state, &profile);
    // Reserve the server's capacity *before* dialling. Failing here costs
    // nothing and reports a limit the user controls; failing at the server
    // costs a round trip and reports one they may not.
    let grant = reserve_top_level(app, state, window_label, &profile, &policy, origin).await?;
    let limits = limits_for(&grant);
    let start = Instant::now();
    log_connection(
        app,
        window_label,
        &id,
        profile.driver,
        &format!(
            "connect: opening {} pool to {}:{}/{} (max {} connections)",
            profile.driver.wire_name(),
            profile.host,
            profile.effective_port(),
            profile.database,
            limits.max_connections
        ),
        None,
        None,
    );
    // Clone the secrets before `open_pool` consumes `ssh`, so we can stash
    // them for child pools (open_database_view) on success.
    let ssh_for_cache = ssh.clone();
    let opened = open_pool(&profile, &pw, ssh, known_hosts, limits).await;
    match opened {
        Ok((pool, ssh_handle)) => {
            // Cache the secrets used for this profile, session-only, so a
            // child pool opened for a specific database doesn't re-resolve
            // from the keychain — which fails for a password supplied via the
            // CLI / connect dialog and never persisted there.
            state.session_secrets.write().insert(
                id.clone(),
                crate::state::SessionSecret {
                    password: Some(pw.clone()),
                    ssh_secret: ssh_for_cache,
                },
            );
            // Surface the SSH tunnel's local-port fallback (see
            // `db::ssh::open_tunnel`): if the user pinned a port that was
            // unavailable, the tunnel transparently bound an OS-assigned one.
            // Log it so the reassignment isn't invisible inside the GUI.
            if let (Some(handle), Some(tunnel)) = (&ssh_handle, &profile.ssh_tunnel) {
                if tunnel.local_port != 0 && handle.local_port != tunnel.local_port {
                    log_connection(
                        app,
                        window_label,
                        &id,
                        profile.driver,
                        &format!(
                            "connect: local port {} was unavailable; tunnel bound {} instead",
                            tunnel.local_port, handle.local_port
                        ),
                        None,
                        None,
                    );
                }
            }
            let active = ActivePool::bare(pool.clone());
            // No heartbeat for a pool the connector asked for. The heartbeat
            // exists to make the next *user* click instant and to raise
            // lost-connection UX in a window — neither of which exists here —
            // and it is the thing that pins one physical socket open past
            // `IDLE_TIMEOUT` forever, which is half of why such a pool used to
            // be a permanent cost (ADR #67). It starts if a person later
            // adopts the connection, at the top of this function.
            let keepalive = match origin {
                PoolOrigin::User => crate::keepalive::spawn(
                    app.clone(),
                    id.clone(),
                    pool,
                    policy.keepalive,
                    policy.ping_timeout,
                    active.last_used.clone(),
                ),
                PoolOrigin::Bridge => None,
            };
            state.connections.write().insert(
                id.clone(),
                ActivePool {
                    _ssh: ssh_handle,
                    _keepalive: keepalive,
                    _endpoint: grant,
                    origin,
                    holders: window_label.map(str::to_string).into_iter().collect(),
                    dialed: Some(target),
                    ..active
                },
            );
            log_connection(
                app,
                window_label,
                &id,
                profile.driver,
                "connect: ok",
                Some(start),
                None,
            );
            let _ = app.emit(
                CONNECTION_OPENED_EVENT,
                ConnectionSyncPayload {
                    connection_id: id.clone(),
                },
            );
            Ok(())
        }
        Err(e) => {
            let e = annotate_connection_limit(state, e);
            let msg = e.to_string();
            log_connection(
                app,
                window_label,
                &id,
                profile.driver,
                "connect: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
}

/// Close the active pool for `id`, if any. Also closes every synthetic
/// per-database pool registered as `<id>::db::<db>` so multi-DB browsing
/// sessions don't leak when the parent connection is closed.
///
/// `async` since 1.13.0, and the pools are now closed with an awaited
/// [`close_pool`] rather than left to `Drop`. The old synchronous version could
/// only remove the entries from the map and hope; that is fine on a healthy
/// LAN but not through a pooler or an SSH tunnel, and specifically not in the
/// back-to-back teardown/setup bursts this app produces — a reconnect after a
/// lost connection, or an environment switch closing every pool before
/// restoring the next environment's. There, the outgoing sessions could still
/// be attached to the server when the incoming ones asked for slots, briefly
/// doubling the connection budget at the exact moment it was tightest.
///
/// The frontend needed no change: `invoke` already returned a promise.
#[tauri::command]
pub async fn disconnect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    close_connection(&app, state.inner(), Some(window.label()), &id, "disconnect").await;
    Ok(())
}

/// Close the connection `id` and everything hanging off it, and tell every
/// window. The body of [`disconnect`], shared with the close no person asked
/// for in so many words: the last window using a connection going away
/// ([`release_window`]).
///
/// `reason` is the Console line, so the log says *why* a connection closed —
/// "the last window using it closed" reads very differently from "disconnect"
/// when someone is working out where their connection went.
pub(crate) async fn close_connection(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    id: &str,
    reason: &str,
) {
    // Drop the session-cached secret for this profile (children reuse the
    // parent's entry, so a single remove covers them).
    state.session_secrets.write().remove(id);
    // A `mongosh` signed in as this connection goes with it: it may be riding
    // the SSH tunnel that is about to close, and a person who disconnects
    // expects every session on that server to end, not one terminal to linger.
    if let Some(terminals) = app.try_state::<crate::terminal::TerminalRegistry>() {
        terminals.close_connection(id);
    }
    let removed = state.connections.write().remove(id);
    let prefix = crate::state::database_view_prefix(id);
    let had_views = state
        .connections
        .read()
        .ids()
        .iter()
        .any(|view| view.starts_with(&prefix));
    let closing = removed.is_some() || had_views;
    // Tell every window *now*, not once the graceful close below has finished.
    // From this point the connection is gone for every purpose a window
    // cares about — nothing new can resolve it — and over SSH the close takes
    // seconds; emitting at the end made the other windows (and this one's
    // tabs) let go that much later than the tree, as if the disconnect had
    // only half happened.
    if closing {
        let _ = app.emit(
            CONNECTION_CLOSED_EVENT,
            ConnectionSyncPayload {
                connection_id: id.to_string(),
            },
        );
    }
    // Sweep synthetic children first, so the parent's tunnel (which they ride
    // on) is still up while they close.
    crate::pool_reaper::close_children(state, id).await;
    if let Some(active) = &removed {
        close_pool(&active.pool, PoolOwnership::Owned, CLOSE_TIMEOUT).await;
    }
    if closing {
        // Driver is not tracked separately for active pools; look it up
        // on the profile (best-effort — the entry is purely informational).
        let driver = state
            .profiles
            .read()
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.driver)
            .unwrap_or(Driver::Sqlite);
        log_connection(app, window_label, id, driver, reason, None, None);
    }
}

/// A window was destroyed: forget it, and close every connection a person
/// opened that no remaining window is using.
///
/// Called from the global `WindowEvent::Destroyed` handler for every window,
/// the main one included. Closing the main window while a secondary one still
/// shows a connection keeps that connection, because the secondary window is
/// still holding it. See [`crate::state::ActivePool::holders`].
pub async fn release_window(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let orphaned = state.connections.write().release_window(label);
    for id in orphaned {
        close_connection(
            app,
            state.inner(),
            Some(label),
            &id,
            "disconnect: the last window using this connection closed",
        )
        .await;
    }
}

/// Close every pool, gracefully and all at once, as the app exits.
///
/// Without this the pools were simply dropped with the process. The operating
/// system tears the sockets down, which a server on the same LAN notices at
/// once — but a server behind an SSH tunnel or a connection pooler only finds
/// out when its own timeouts fire, and until then those sessions keep counting
/// against its connection limit after HuginnDB is gone. Views close first,
/// while their parents' tunnels are still up. Each close is bounded by
/// [`CLOSE_TIMEOUT`] and the whole sweep by `budget`, because nobody should
/// wait on a closing app for a server that has stopped answering.
pub async fn close_all_pools(state: &AppState, budget: Duration) {
    let all = state.connections.write().take_all_views_first();
    let (views, parents): (Vec<_>, Vec<_>) = all
        .into_iter()
        .partition(|(id, _)| crate::state::is_database_view(id));
    let sweep = async {
        futures_util::future::join_all(
            views
                .iter()
                .map(|(_, a)| close_pool(&a.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT)),
        )
        .await;
        futures_util::future::join_all(
            parents
                .iter()
                .map(|(_, a)| close_pool(&a.pool, PoolOwnership::Owned, CLOSE_TIMEOUT)),
        )
        .await;
    };
    let _ = tokio::time::timeout(budget, sweep).await;
    // Tunnels, keepalives and budget grants are released as these drop.
    drop(views);
    drop(parents);
}

/// Close and forget one synthetic per-database view, logging why.
///
/// Shared by the two reclaim paths in `open_database_view` — the per-connection
/// view cap and the per-server budget — so both release the pool *and* its
/// endpoint grant the same way. The grant rides on the `ActivePool` and
/// releases when this drops it, which is why neither caller has to think about
/// the budget bookkeeping.
async fn close_view(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    driver: Driver,
    id: &str,
    reason: &str,
) {
    let removed = state.connections.write().remove(id);
    if let Some(active) = removed {
        close_pool(&active.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT).await;
        log_connection(
            app,
            window_label,
            id,
            driver,
            &format!(
                "open_database_view: closed least-recently-used database pool ({reason} reached)"
            ),
            None,
            None,
        );
    }
}

// The synthetic-id vocabulary lives in `crate::state`, next to the connection
// map it addresses, so the layers *below* `commands` (`db::pool`,
// `pool_reaper`) can use it without depending upward. Re-exported here because
// these two paths are what the rest of `commands` already calls.
pub use crate::state::{database_view_id, parent_connection_id};

/// If `id` names a `<parent>::db::<database>` view the idle reaper
/// (`pool_reaper.rs`) has since closed, transparently reopen it with the same
/// cached credentials `open_database_view` used originally — exactly as if
/// the user had just re-expanded that database in the tree.
///
/// The reaper closing an idle child pool is deliberate policy (see
/// `pool_reaper.rs`'s module docs); the bug this fixes is that its effect used
/// to be invisible until the *next* click on that database failed with
/// `NotConnected`, even though the parent connection the tree shows as
/// "connected" genuinely still is. This makes the reopen part of that click
/// instead of a surprise on it.
///
/// A no-op for an already-open view or a top-level id — including one that
/// was never open in the first place, or a MongoDB/SQLite parent (both of
/// which take a fast, already-idempotent path inside
/// [`open_database_view_inner`]). Never errors: if the reopen fails (bad
/// credentials, server gone), the `pool_for` lookup that runs right after
/// this call is what reports `NotConnected`, unchanged — this only removes
/// the false negative the reaper introduced, it never masks a real one.
pub async fn ensure_database_view(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    id: &str,
) {
    if state.connections.read().get(id).is_some() {
        return;
    }
    if let Some((parent_id, database)) = crate::state::split_database_view(id) {
        // Only while the parent is open. A view the reaper closed comes back;
        // a view whose *connection* was closed must not. A schema read still
        // in flight when the user disconnected arrives here a moment later,
        // and reopening would resurrect a SQL view pool — with an SSH tunnel
        // of its own, since its parent's is gone — that no window lists and
        // nothing would ever close.
        if !state.connections.read().contains(parent_id) {
            return;
        }
        let _ = open_database_view_inner(app, state, window_label, parent_id, database).await;
    }
}

/// Resolve (or open) the synthetic per-database Mongo pool for `parent_id`
/// bound to `database` — the Mongo half of [`open_database_view`], pulled out
/// as a free function because it needs neither an `AppHandle`/`Window` nor
/// re-authentication: a single `mongodb::Client` reaches every database in
/// the cluster, so this only clones it and re-tags the target database.
/// Callable from a headless context (the MCP server), unlike the rest of
/// `open_database_view`, which logs to the Console panel and re-resolves
/// credentials for the SQL drivers.
pub async fn resolve_mongo_database_view(
    state: &AppState,
    parent_id: &str,
    database: &str,
) -> AppResult<String> {
    let child_id = database_view_id(parent_id, database);
    if state.connections.read().get(&child_id).is_some() {
        return Ok(child_id);
    }
    let parent_pool = state.connections.read().get(parent_id);
    let Some(crate::state::DbPool::Mongo(conn)) = parent_pool else {
        return Err(AppError::NotConnected(parent_id.to_string()));
    };
    let child_pool = crate::state::DbPool::Mongo(crate::state::MongoConn {
        client: conn.client.clone(),
        database: Some(database.to_string()),
        sockets: conn.sockets.clone(),
    });
    state
        .connections
        .write()
        .insert(child_id.clone(), ActivePool::bare(child_pool));
    Ok(child_id)
}

/// Open a secondary pool for `parent_id` bound to `database`, and register
/// it under `<parent_id>::db::<database>` so the existing commands can
/// address it like a regular connection.
///
/// Returns the synthetic id, or — if a child pool for that database is
/// already open — the existing id (idempotent).
///
/// Used by the schema explorer when the parent profile has an empty
/// `database` field: the parent pool connects to a maintenance catalog
/// (`postgres` on PG, no default DB on MySQL), and each database the user
/// expands in the tree spawns one of these children. This way every
/// downstream command (`list_tables`, `fetch_table_data`, `update_cell`,
/// …) keeps its existing single `connection_id` argument and doesn't need
/// to learn a `database` parameter.
#[tauri::command]
pub async fn open_database_view(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    parent_id: String,
    database: String,
) -> AppResult<String> {
    crate::commands::guard::database(state.inner(), &parent_id, &database)?;
    open_database_view_inner(
        &app,
        state.inner(),
        Some(window.label()),
        &parent_id,
        &database,
    )
    .await
}

/// The reusable body of [`open_database_view`] — no `AppHandle`/`Window`
/// dependency beyond what's threaded in explicitly, so [`ensure_database_view`]
/// and the MCP bridge (`bridge::server::dispatch`) can reopen a child pool the
/// idle reaper (`pool_reaper.rs`) has since closed, exactly as if the user had
/// just re-expanded that database.
async fn open_database_view_inner(
    app: &AppHandle,
    state: &AppState,
    window_label: Option<&str>,
    parent_id: &str,
    database: &str,
) -> AppResult<String> {
    let child_id = database_view_id(parent_id, database);
    // Same single-flight as `connect_inner`, keyed by the view: the tree's
    // expand effect, a context-menu action and the bridge can all ask for the
    // same database at once.
    let open_lock = state.open_lock(&child_id);
    let _opening = open_lock.lock().await;
    if state.connections.read().get(&child_id).is_some() {
        return Ok(child_id);
    }

    let parent = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == parent_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {parent_id}")))?;
    // A child signs in as the person, like its parent did.
    let parent = crate::credentials::effective_profile(&state.policy, &parent);

    if matches!(parent.driver, Driver::Sqlite) {
        // SQLite has a single file = single database; per-DB browsing is
        // not meaningful. Treat this as a no-op alias.
        return Ok(parent_id.to_string());
    }

    // MongoDB: a single client reaches every database in the cluster, so a
    // per-database "view" reuses the parent's client and only re-tags the
    // target database — no new connection, no re-auth, no second tunnel. The
    // child carries no SSH handle of its own; it depends on the parent's tunnel
    // staying alive, and `disconnect` sweeps children before the parent drops.
    // This needs no `AppHandle`/`Window` (unlike the SQL path below), so it's
    // pulled into a free function the headless MCP server can share — the MCP
    // has no equivalent of the desktop's "expand a database in the explorer"
    // gesture otherwise, leaving Mongo tools with no way to target a specific
    // database on a connection with none bound.
    if matches!(parent.driver, Driver::Mongo) {
        return resolve_mongo_database_view(state, parent_id, database).await;
    }

    // Clone the parent profile and substitute the database. The child uses
    // the same credentials and (if configured) SSH tunnel as the parent —
    // resolved from the keychain the same way `connect` does it.
    let mut child = parent.clone();
    child.database = database.to_string();

    // Prefer the session-cached secrets from the parent's `connect` (they may
    // have come from the CLI / dialog and never touched the keychain); only
    // fall back to the keychain when nothing was cached.
    let cached = state.session_secrets.read().get(parent_id).cloned();
    let pw = match cached.as_ref().and_then(|s| s.password.clone()) {
        Some(p) => p,
        None => resolve_password(&parent)?,
    };
    let ssh = match cached.as_ref().and_then(|s| s.ssh_secret.clone()) {
        Some(s) => Some(s),
        None => resolve_ssh_secret(&parent)?,
    };
    let known_hosts = state.known_hosts.clone();
    let policy = pool_policy(state, &parent);
    let max_child_pools = state.prefs.read().connections.max_child_pools;

    // Enforce the per-connection view cap *before* opening, not after: the
    // point is to never exceed the budget, and the case that trips servers is
    // precisely the burst — the schema explorer's cross-database search
    // fanning out across every database at once. Waiting for the reaper's
    // next sweep would let the whole fan-out land first.
    if max_child_pools > 0 {
        let over_cap: Vec<String> = {
            let conns = state.connections.read();
            let existing = conns.children_by_lru(parent_id);
            // `+ 1` accounts for the child we are about to add.
            let excess = (existing.len() + 1).saturating_sub(max_child_pools as usize);
            existing.into_iter().take(excess).collect()
        };
        for victim in over_cap {
            close_view(app, state, window_label, parent.driver, &victim, "cap").await;
        }
    }

    // Reserve this view's share of the *server's* budget, reclaiming from our
    // own idle views on that same server before giving up. This is what makes
    // browsing a twelve-database server work under a budget that can't hold
    // twelve views at once: the view the user hasn't looked at in a while pays
    // for the one they just clicked, instead of the click failing.
    //
    // Only views on the same endpoint are eligible — evicting one on an
    // unrelated server would free capacity nobody is waiting for.
    let grant = match EndpointKey::for_profile(&parent) {
        None => None,
        Some(key) => {
            let request = policy.child_request.max(MIN_MAX_CONNECTIONS);
            let mut reclaimable = state.connections.read().views_on_endpoint_by_lru(&key);
            // Never reclaim the view we are opening (it can't be live yet) nor,
            // more importantly, one that a caller is mid-query against — the
            // LRU ordering already puts those last, so taking from the front is
            // the least disruptive order available.
            reclaimable.retain(|id| id != &child_id);
            loop {
                match state
                    .endpoints
                    .reserve(&key, request, policy.budget, MIN_MAX_CONNECTIONS)
                {
                    Ok(g) => break Some(g),
                    Err(exhausted) => {
                        let Some(victim) = reclaimable.first().cloned() else {
                            return Err(exhausted_to_error(exhausted));
                        };
                        reclaimable.remove(0);
                        close_view(app, state, window_label, parent.driver, &victim, "budget")
                            .await;
                    }
                }
            }
        }
    };
    let limits = limits_for(&grant);

    let start = Instant::now();
    log_connection(
        app,
        window_label,
        &child_id,
        parent.driver,
        &format!(
            "open_database_view: {database} (max {} connections)",
            limits.max_connections
        ),
        None,
        None,
    );
    // Ride the parent's tunnel when it has one up: no second SSH handshake per
    // database, no second session to the bastion. A parent that is not open
    // (a view reopened by the reaper's transparent path after a disconnect
    // elsewhere) still dials its own, as every view used to.
    let route = match state.connections.read().tunnel_port(parent_id) {
        Some(port) => crate::db::pool::TunnelRoute::Through(port),
        None => crate::db::pool::TunnelRoute::Dial(ssh),
    };
    match crate::db::pool::open_pool_routed(&child, &pw, route, known_hosts, limits).await {
        Ok((pool, ssh_handle)) => {
            state.connections.write().insert(
                child_id.clone(),
                ActivePool {
                    _ssh: ssh_handle,
                    _endpoint: grant,
                    ..ActivePool::bare(pool)
                },
            );
            log_connection(
                app,
                window_label,
                &child_id,
                parent.driver,
                "open_database_view: ok",
                Some(start),
                None,
            );
            Ok(child_id)
        }
        Err(e) => {
            let e = annotate_connection_limit(state, e);
            let msg = e.to_string();
            log_connection(
                app,
                window_label,
                &child_id,
                parent.driver,
                "open_database_view: failed",
                Some(start),
                Some(&msg),
            );
            Err(e)
        }
    }
}

/// Ids of every currently active connection. Used by the frontend to
/// reconcile its in-memory state after reloads.
#[tauri::command]
pub fn active_connections(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.connections.read().ids())
}

/// How many pools HuginnDB is holding right now, split by kind.
///
/// Exists because "too many connections" is only an actionable error if the
/// user can see their own contribution to it. Surfaced in Settings →
/// Connections and quoted in the error toast.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    /// Top-level pools, whoever opened them.
    pub connections: usize,
    /// Synthetic `<parent>::db::<name>` pools opened by browsing databases.
    pub database_views: usize,
    /// How many of `connections` the MCP connector asked for through the
    /// bridge rather than a person opening them. Shown separately because no
    /// window lists them (the frontend does not adopt another window's
    /// connections, so it never listens for `connection-opened`), which made
    /// them invisible in the product until this count existed.
    pub mcp_connections: usize,
    /// Per-server reservations. This is the row that actually answers "how
    /// many connections am I holding against *that* box" — the two counts
    /// above are per-pool and a server may back several of them.
    pub endpoints: Vec<EndpointUsage>,
    /// Loopback port the MCP bridge is listening on, or `None` when it is off.
    /// Shown in Settings so a user who gets a firewall prompt, or who is
    /// wondering why an MCP client can't attach, can see the actual state
    /// rather than infer it from a checkbox.
    pub mcp_bridge_port: Option<u16>,
}

/// One server's share of the connection footprint.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointUsage {
    /// `host:port`, plus the SSH tunnel when there is one.
    pub label: String,
    /// Connections' worth of pool capacity **reserved** against it: the sum of
    /// the ceilings its pools may grow to. What the budget is enforced on.
    pub in_use: u32,
    /// The budget in force for this server — the profile's own override when
    /// it has one. The panel used to divide by the global preference, which
    /// was wrong for every server with an override.
    pub budget: u32,
    /// Connections actually **open** against it right now, as the server
    /// would count them. Usually far below `in_use`: a pool opens sockets on
    /// demand and closes idle ones, so a reservation of five is often one real
    /// connection. "5 of 10 reserved" with no real number beside it is what
    /// people found impossible to read.
    pub open: u32,
}

/// Snapshot of the current pool footprint. See [`PoolStats`].
#[tauri::command]
pub fn connection_pool_stats(state: State<'_, AppState>) -> AppResult<PoolStats> {
    let (connections, database_views) = state.connections.read().counts();
    let mcp_connections = state.connections.read().bridge_connections();
    Ok(PoolStats {
        connections,
        database_views,
        mcp_connections,
        endpoints: {
            let open = state.connections.read().open_by_endpoint();
            state
                .endpoints
                .usage()
                .into_iter()
                .map(|row| EndpointUsage {
                    open: open.get(&row.key).copied().unwrap_or(0),
                    label: row.label,
                    in_use: row.in_use,
                    budget: row.budget,
                })
                .collect()
        },
        mcp_bridge_port: state.mcp_bridge.lock().as_ref().map(|h| h.port),
    })
}

/// Close every synthetic per-database pool that isn't in use right now, **plus
/// every connection the MCP connector opened**, keeping the top-level
/// connections the user opened.
///
/// The manual counterpart to [`crate::pool_reaper`]'s TTL sweep: the recovery
/// action offered when a server refuses a connection because it is full. Each
/// closed view reopens transparently the next time the user touches that
/// database, so this is safe to invoke at any time — the cost is one round
/// trip, not lost state.
///
/// Connector-opened connections are included because this is the *remedy*
/// offered on a limit error, and it was refusing to touch a whole class of
/// connections the user cannot see or close by any other means (ADR #67).
/// The same reopen-transparently argument covers them: the sidecar re-asks the
/// app on its next tool call. The exposure is one tool call in flight failing
/// once — the same exposure as the user pressing Disconnect, and the bridge's
/// fallback rule deliberately does not retry a failure the app reported.
///
/// Returns how many pools were closed.
#[tauri::command]
pub async fn release_idle_pools(app: AppHandle, state: State<'_, AppState>) -> AppResult<usize> {
    // `idle_children(0)` is every child, since `last_used` is only stamped on
    // resolution and a pool being *resolved* right now still returns a
    // non-negative age. A query already in flight holds a cloned `DbPool`, so
    // closing the pool here cannot cut it off mid-statement: `close` waits for
    // checked-out connections to be returned.
    let now = crate::state::now_millis();
    let (victims, bridge_victims) = {
        let conns = state.connections.read();
        (conns.idle_children(now, 0), conns.idle_bridge_pools(now, 0))
    };
    let removed: Vec<_> = {
        let mut conns = state.connections.write();
        victims
            .iter()
            .filter_map(|id| conns.remove(id).map(|active| (id.clone(), active)))
            .collect()
    };
    let mut count = removed.len();
    for (id, active) in removed {
        close_pool(&active.pool, PoolOwnership::BorrowedView, CLOSE_TIMEOUT).await;
        log_bus::broadcast(
            &app,
            LogEntry::new(LogKind::Connection)
                .connection_id(id)
                .message("released per-database pool on request"),
        );
    }
    // Reuses the reaper's own teardown so the two paths cannot disagree about
    // what closing one of these means (children, tunnel ordering, cached
    // secrets, the `connection-closed` event).
    for id in bridge_victims {
        crate::pool_reaper::reap_bridge_parent(&app, state.inner(), &id).await;
        count += 1;
    }
    Ok(count)
}

/// Forget the trusted SSH host-key fingerprint for `host:port`. The next
/// connection under [`HostKeyPolicy::AcceptNew`](crate::state::HostKeyPolicy::AcceptNew)
/// will accept whatever the server presents and re-trust it on first use.
///
/// Returns `true` when an entry was actually removed — the frontend uses
/// this to show "already forgotten" rather than "forgotten" in the
/// confirmation toast.
#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, host_port: String) -> AppResult<bool> {
    let removed = state.known_hosts.write().remove(&host_port);
    if removed {
        let snapshot = state.known_hosts.read().clone();
        ssh_known_hosts::save(&snapshot)?;
    }
    Ok(removed)
}

/// Read the trusted SSH host-key fingerprint for `host:port`, if any.
/// Used by the connection dialog to show the currently-trusted fingerprint
/// next to the "Forget host key" button.
#[tauri::command]
pub fn get_host_key(state: State<'_, AppState>, host_port: String) -> AppResult<Option<String>> {
    Ok(state.known_hosts.read().get(&host_port).cloned())
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/// Read and parse an export file without decrypting secrets.
///
/// Returns metadata the frontend needs to present the conflict-resolution
/// step before committing to the import: whether it is encrypted, how many
/// profiles it contains, and which of those conflict with existing ones.
#[tauri::command]
pub fn analyze_import_file(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<ImportAnalysis> {
    let data = std::fs::read_to_string(&file_path)?;
    let export: ExportFile = serde_json::from_str(&data)?;

    transfer::check_meta(&export.meta, KIND_PROFILES)?;

    let profiles = state.profiles.read();
    let conflicts = transfer::detect_conflicts(&profiles, &export.profiles);

    Ok(ImportAnalysis {
        total: export.profiles.len(),
        encrypted: export.meta.encrypted,
        conflicts,
    })
}

/// Export the selected profiles to a JSON file chosen by the user.
///
/// When `include_passwords` is `true`, each profile's DB password and SSH
/// secret are read from the OS keychain and encrypted with AES-256-GCM using
/// the supplied `passphrase` before being written to the file. The file
/// dialog opens for the user to pick the destination.
#[tauri::command]
pub async fn export_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_ids: Option<Vec<String>>,
    include_passwords: bool,
    passphrase: Option<String>,
) -> AppResult<String> {
    if include_passwords && passphrase.is_none() {
        return Err(AppError::InvalidInput(
            "a passphrase is required when include_passwords is true".into(),
        ));
    }

    let profiles_snapshot: Vec<ConnectionProfile> = {
        let guard = state.profiles.read();
        match &profile_ids {
            Some(ids) => guard
                .iter()
                .filter(|p| ids.contains(&p.id))
                .cloned()
                .collect(),
            None => guard.clone(),
        }
    };

    let exported_profiles = transfer::build_exported_profiles(
        &profiles_snapshot,
        include_passwords,
        passphrase.as_deref(),
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    let file = ExportFile {
        meta: transfer::metadata(KIND_PROFILES, include_passwords, &now),
        profiles: exported_profiles,
    };

    // A suggested filename like `huginndb-profiles-2025-06-02.json`.
    let date_part = now.get(..10).unwrap_or("export");
    transfer::save_export(
        &app,
        "Export profiles",
        &format!("huginndb-profiles-{date_part}.json"),
        &serde_json::to_string_pretty(&file)?,
    )
}

/// Import profiles from a previously exported JSON file.
///
/// Callers should first call [`analyze_import_file`] to detect conflicts and,
/// if the file is encrypted, collect the passphrase. Then pass
/// `conflict_resolutions` to express how each conflicting profile should be
/// handled.
///
/// Every imported profile receives a **fresh UUID** regardless of whether it
/// came with one in the file. This prevents keychain-account collisions with
/// profiles that were already on this machine.
///
/// `async fn` on purpose, with the actual work run via `spawn_blocking`: a
/// synchronous Tauri command executes on the main thread (see the identical
/// reasoning on `import_environment` in `commands::prefs`), and
/// `apply_profile_imports` runs one 600 000-iteration PBKDF2 derivation per
/// encrypted secret (`transfer::decrypt_secret`) — deliberately slow, and with
/// enough profiles in one file, slow enough to freeze the window (issue: app
/// reported "not responding" importing a multi-environment bundle with dozens
/// of encrypted secrets).
///
/// `window` is only used to scope [`IMPORT_PROGRESS_EVENT`] to the caller —
/// see the event's own doc comment for why a plain `app.emit` would leak
/// progress into every open window (gotcha #25).
#[tauri::command]
pub async fn import_profiles(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    file_path: String,
    passphrase: Option<String>,
    conflict_resolutions: Vec<ConflictResolution>,
) -> AppResult<ImportResult> {
    let profiles_lock = state.profiles.clone();
    let json_schemas_lock = state.json_schemas.clone();
    let app_for_task = app.clone();
    let window_label = window.label().to_string();

    let (result, schema_changed) = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let data = std::fs::read_to_string(&file_path)?;
        let export: ExportFile = serde_json::from_str(&data)?;

        transfer::check_meta(&export.meta, KIND_PROFILES)?;
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

        let (result, overwritten_ids) = {
            let mut profiles = profiles_lock.write();
            let (result, _id_map, overwritten_ids) = apply_profile_imports(
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
            (result, overwritten_ids)
        };

        // An overwritten profile gets a fresh uuid, so any JSON-Schema binding
        // pinned to the old one would quietly stop matching. See the third
        // return value of `apply_profile_imports`.
        let mut schema_changed = false;
        if !overwritten_ids.is_empty() {
            let mut lib = json_schemas_lock.write();
            let n = crate::json_schemas::remap_connection_ids(&mut lib, &overwritten_ids);
            if n > 0 {
                let snapshot = lib.clone();
                drop(lib);
                crate::json_schemas::save_library(&snapshot)?;
                schema_changed = true;
            }
        }

        Ok((result, schema_changed))
    })
    .await
    .map_err(|e| AppError::Transfer(format!("profile import task failed: {e}")))??;

    if schema_changed {
        let _ = app.emit(
            crate::commands::json_schemas::JSON_SCHEMAS_CHANGED_EVENT,
            (),
        );
    }
    let _ = app.emit(PROFILES_CHANGED_EVENT, ());
    Ok(result)
}

/// What [`apply_profile_imports`] hands back: the user-facing result, the
/// original-to-new id map for *every* imported profile, and the subset of that
/// map for the ones that were overwritten.
pub(crate) type ProfileImportOutcome = (
    ImportResult,
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
);

/// Emitted by `import_profiles` and `import_environment` while
/// `apply_profile_imports` works through the exported profile list. Each
/// encrypted secret costs one 600 000-iteration PBKDF2 derivation
/// (`transfer::decrypt_secret`) — deliberately slow — so a file bundling many
/// profiles (an environment export in particular, see ADR #35)
/// can take long enough that a bare spinner isn't enough feedback. Snake_case
/// on the wire, matching `ImportResult` and every other DTO in this module
/// (no `rename_all`).
///
/// Emitted with `emit_to(window_label, ...)`, not a broadcast `emit` — each
/// import is triggered from one window's dialog, so a second ("New window")
/// window has no business rendering someone else's import progress (gotcha #25).
/// The frontend bridge (`lib/bridges/import-progress-bridge.ts`)
/// scopes its `listen` the same way, which is the half that actually matters:
/// an unscoped `listen()` defaults to `EventTarget::Any` and receives every
/// `emit_to(...)` regardless of the emitter's target.
pub const IMPORT_PROGRESS_EVENT: &str = "huginndb://import-progress";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
}

/// Apply a set of exported profiles onto `profiles`, honoring
/// `resolution_map` for ids that already exist there. Shared by
/// [`import_profiles`] and `import_environment` (`commands::prefs`) — the
/// conflict/rename/keychain rules are identical either way, only *where* the
/// exported profiles came from (a standalone bundle vs. an environment
/// bundle's shared profile pool) differs.
///
/// Every imported profile receives a **fresh UUID** regardless of whether it
/// came with one in the file, to avoid keychain-account collisions with
/// profiles already on this machine. The second return value maps each
/// *original* profile id to the local id it should now resolve to —
/// `import_profiles` has no use for it, but `import_environment` needs it to
/// translate each environment bundle's `connection_ids` into the ids that
/// actually landed in `profiles.json`. A **skipped** profile maps to *itself*:
/// the conflict was matched by id, so the local profile already answers to it.
/// Every incoming profile therefore has an entry, and an id missing from this
/// map genuinely means "did not land".
///
/// The **third** return value is the subset of that map for profiles that were
/// *overwritten*. Because a fresh UUID is minted even when overwriting, anything
/// keyed on a profile id that lives outside `profiles.json` would silently stop
/// resolving after an overwrite — with no error, just a feature quietly gone.
/// JSON-Schema bindings are exactly that (`crate::json_schemas`), so both
/// callers feed this map to `json_schemas::remap_connection_ids`. It is
/// deliberately *only* the overwrite subset: on `Rename` the local profile keeps
/// its original id and its bindings must stay on it, and on `Skip` nothing was
/// replaced, so there is nothing to repoint (it appears in the *second* map, as
/// an identity entry, but never in this one).
pub(crate) fn apply_profile_imports(
    profiles: &mut Vec<ConnectionProfile>,
    exported: Vec<transfer::ExportedProfile>,
    passphrase: Option<&str>,
    resolution_map: &std::collections::HashMap<String, ConflictAction>,
    mut on_progress: impl FnMut(usize, usize),
) -> AppResult<ProfileImportOutcome> {
    let mut result = ImportResult {
        imported: vec![],
        skipped: vec![],
        renamed: vec![],
        needs_password: vec![],
    };
    let mut id_map = std::collections::HashMap::new();
    let mut overwritten_ids = std::collections::HashMap::new();

    let total = exported.len();
    for (processed, ep) in exported.into_iter().enumerate() {
        // Fired unconditionally at the top of the loop body (rather than once
        // per exit path) so it can't be missed by the early `continue` below
        // or by a future one — the item being *started* is a fine proxy for
        // "N of total processed" on a progress bar.
        on_progress(processed + 1, total);

        // Determine action for profiles that conflict with an existing id.
        // Conflicts are matched by id (`detect_conflicts`), so a conflict here
        // is never a coincidence — it is definitionally the same connection
        // already present. The fallback for one the caller left unresolved is
        // therefore `Skip`, not `Rename`: renaming would silently create a
        // second, independent copy of a profile that already exists, which is
        // almost never what "I didn't touch that row" was meant to request.
        let conflict_action = if profiles.iter().any(|p| p.id == ep.profile.id) {
            resolution_map
                .get(&ep.profile.id)
                .cloned()
                .unwrap_or(ConflictAction::Skip)
        } else {
            ConflictAction::Rename // effectively: just insert as new
        };

        if matches!(conflict_action, ConflictAction::Skip) {
            // Map the skipped id to *itself*. A conflict is matched by id, so
            // "skip" means "a profile with this exact id is already here" — the
            // incoming reference resolves perfectly well, it just resolves to
            // the local profile instead of a freshly minted one. Leaving the
            // entry out made `id_map` say "this connection did not land",
            // which is false, and both consumers acted on it:
            //
            //   * `import_environment` builds the new environment's
            //     `launch.visible_connections` by translating the bundle's
            //     `connection_ids` through this map, so a skipped connection
            //     was dropped from the filter — the environment came up hiding
            //     the very connections it was exported to describe.
            //   * JSON-Schema bindings are repointed through the same map, and
            //     an id absent from it is taken to name a connection unknown
            //     locally, so the binding is *disabled* (ADR #39). It was
            //     disabling bindings for profiles that were sitting right
            //     there under the same id.
            //
            // `overwritten_ids` (the third return value) deliberately gets no
            // entry: nothing was overwritten, so there is nothing to repoint.
            result.skipped.push(ep.profile.id.clone());
            id_map.insert(ep.profile.id.clone(), ep.profile.id.clone());
            continue;
        }

        // If overwriting, drop the existing profile's keychain entries and
        // remove it from the list.
        if matches!(conflict_action, ConflictAction::Overwrite) {
            if let Some(pos) = profiles.iter().position(|p| p.id == ep.profile.id) {
                let old = profiles.remove(pos);
                if !matches!(old.driver, Driver::Sqlite) {
                    let _ = keychain::delete_password(&old.keyring_account());
                }
                if let Some(ssh_acct) = old.ssh_keyring_account() {
                    let _ = keychain::delete_password(&ssh_acct);
                }
            }
        }

        // Always assign a fresh UUID to avoid keychain collisions.
        let new_id = Uuid::new_v4().to_string();
        id_map.insert(ep.profile.id.clone(), new_id.clone());
        if matches!(conflict_action, ConflictAction::Overwrite) {
            overwritten_ids.insert(ep.profile.id.clone(), new_id.clone());
        }
        let original_name = ep.profile.name.clone();

        let final_name = crate::transfer::disambiguate_name(
            &ep.profile.name,
            profiles.iter().map(|p| p.name.as_str()),
        );

        let renamed = final_name != original_name;
        if renamed {
            result
                .renamed
                .push((original_name.clone(), final_name.clone()));
        }

        let mut new_profile = ep.profile.clone();
        new_profile.id = new_id.clone();
        new_profile.name = final_name;
        // Never let an imported file decide what this machine's AI clients may
        // reach. `ExportedProfile` flattens the whole `ConnectionProfile`, so
        // `mcp_exposed` rides along in any bundle written by a machine that had
        // it set — and importing someone's connections to *look* at them would
        // otherwise expose them to every configured MCP client on the spot.
        // The user re-opts in from Settings → MCP, which is one checkbox.
        //
        // `mcp_write` is deliberately left as it arrives: a policy on a
        // connection nothing can reach grants nothing, so the gate above is the
        // whole fix, and clearing both would silently discard a level the user
        // is about to want anyway.
        new_profile.mcp_exposed = false;
        // Same argument, same direction, for the in-app assistant: a bundle
        // written on a machine where the AI panel could read this connection —
        // rows and all — must not hand that reach to whoever imports it. Both
        // flags are one checkbox each in Settings → AI.
        new_profile.ai_enabled = false;
        new_profile.ai_rows_allowed = false;
        // Same reasoning, and a sharper failure if it were skipped: a
        // `secret_override` flag riding in from the exporting machine would
        // tell every future sync that *this* machine has its own password for
        // the connection, and the published secret would then be skipped for a
        // keychain entry the user never wrote.
        new_profile.secret_override = None;
        // And whoever the exporting machine's person signed in as: this
        // machine's person is somebody else.
        new_profile.personal_username = None;

        // Decrypt and store secrets if present. `Strict` because the user is
        // sitting in the import dialog: a wrong passphrase has to surface here
        // rather than yielding a pile of connections that cannot authenticate.
        let has_secrets = match &ep.secrets {
            Some(secrets) => crate::transfer::land_secrets(
                &new_profile,
                secrets,
                passphrase,
                crate::transfer::LandMode::Strict,
            )?,
            None => false,
        };

        if !has_secrets && !matches!(new_profile.driver, Driver::Sqlite) {
            result.needs_password.push(new_id.clone());
        }

        profiles.push(new_profile);
        result.imported.push(new_id);
    }

    Ok((result, id_map, overwritten_ids))
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Return the command-line arguments that were parsed before the app started.
///
/// Called once by the frontend on boot (after profiles are loaded) to
/// auto-connect when the user launched HuginnDB with `--connect-profile` or
/// ad-hoc `--host` / `--port` / … flags.
#[tauri::command]
pub fn get_startup_args(state: State<'_, AppState>) -> AppResult<StartupArgs> {
    Ok(state.startup_args.clone())
}

/// Drain any connection intent forwarded by a *second* launch.
///
/// The single-instance handler in `lib.rs` buffers the second launch's parsed
/// args here and emits `huginndb://cli-connect`. The frontend calls this once
/// when its event bridge mounts, to recover an intent that may have been
/// emitted before the listener existed (boot race). Returns `None` when there
/// is nothing pending and clears the buffer so it is consumed exactly once.
#[tauri::command]
pub fn take_pending_cli_connect(state: State<'_, AppState>) -> AppResult<Option<StartupArgs>> {
    Ok(state.pending_cli_connect.write().take())
}

// ---------------------------------------------------------------------------
// Multi-window
// ---------------------------------------------------------------------------

/// Open a new, blank HuginnDB window ("New window"). Optionally carries a
/// connection `intent` (e.g. from the CLI second-launch dialog choosing
/// "new window") for the new window's frontend to pick up on boot via
/// [`take_window_startup_intent`], and an `environment_id` ("Open environment
/// in new window") for it to pick up via [`take_window_environment_intent`].
///
/// The environment id is stored, not validated: the window resolves it against
/// `list_environments` and ignores one that no longer exists, so an environment
/// deleted between the click and the window's boot degrades to a plain blank
/// window rather than an error. Nothing about it is persisted — the window
/// holds the environment purely in memory (ADR #8).
///
/// Secondary windows are intentionally ephemeral: they never touch
/// `tab_state.json` (see `commands::prefs::get_tab_state`), so nothing about
/// them survives an app restart.
///
/// `WebviewWindowBuilder::new(...).build()` deadlocks on Windows (a WebView2
/// issue) when called from a *synchronous* command or event handler — the
/// new window comes up blank/unresponsive and can't even be closed via its
/// own "×" button. Tauri's own docs call this out and say to use an `async`
/// command instead (an earlier attempt here routed the build through
/// `run_on_main_thread`, which avoided the outright hang but still left the
/// window blank — `async fn` is the actual fix). See
/// <https://github.com/tauri-apps/tauri/issues/13963>.
#[tauri::command]
pub async fn open_new_window(
    app: AppHandle,
    intent: Option<StartupArgs>,
    environment_id: Option<String>,
) -> AppResult<String> {
    let label = format!("win-{}", Uuid::new_v4());
    if let Some(args) = intent {
        app.state::<AppState>()
            .window_startup_intents
            .write()
            .insert(label.clone(), args);
    }
    if let Some(id) = environment_id {
        app.state::<AppState>()
            .window_environment_intents
            .write()
            .insert(label.clone(), id);
    }
    crate::window_chrome::builder(&app, &label)
        .title("HuginnDB")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        // Mirror the main window's `dragDropEnabled: false` (tauri.conf.json).
        // The main window is declared statically with that flag; a window built
        // here would otherwise default to Tauri 2's OS-level drag-drop handler
        // being ENABLED, which swallows the HTML5 drag events dockview relies on
        // — so panels can't be rearranged and dragging shows the "not-allowed"
        // cursor. Disabling the native handler lets dockview's own DnD through,
        // matching the main window exactly.
        .disable_drag_drop_handler()
        .build()?;
    let _ = app.emit(WINDOW_LIST_CHANGED_EVENT, ());
    Ok(label)
}

/// Drain the connection intent stashed for `label` by [`open_new_window`].
/// Called once by a secondary window's frontend on boot, alongside the
/// existing `get_startup_args` cold-start call.
#[tauri::command]
pub fn take_window_startup_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<StartupArgs>> {
    Ok(state.window_startup_intents.write().remove(&label))
}

/// Drain the environment id stashed for `label` by [`open_new_window`]. Called
/// once by a secondary window's frontend on boot, after the environment store
/// has loaded.
#[tauri::command]
pub fn take_window_environment_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<String>> {
    Ok(state.window_environment_intents.write().remove(&label))
}

/// Pop a single workspace tab out into its own bare OS window (the "sacar
/// como ventana flotante" action) — a real, independently movable/resizable
/// native window rather than dockview's `addFloatingGroup`, which stays
/// confined to the inner workspace's own bounds. `tab` is the serialized
/// `AppTab` the frontend was displaying; it's carried opaquely (see
/// `AppState::detached_tab_intents`) and handed back verbatim to the new
/// window's frontend, which renders just that one panel — no sidebar, no
/// tab strip, no menus. The connection pool it needs is already open in the
/// shared backend `AppState`, so no reconnect happens here.
///
/// Like `open_new_window`, this window is ephemeral: closing it does not
/// hand anything back to the caller. The caller removes the tab from its own
/// `useTabs` immediately after this call returns, so "close the OS window"
/// and "close the tab" are simply the same moment from two different
/// windows' point of view — no cross-window signal is needed.
#[tauri::command]
pub async fn open_tab_window(
    app: AppHandle,
    tab: serde_json::Value,
    title: String,
) -> AppResult<String> {
    let label = format!("tabwin-{}", Uuid::new_v4());
    // The tab's connection is held by this window too: it never connects (it
    // borrows the pool its source window opened), so without this the source
    // window closing would close the pool under a tab that is still open.
    if let Some(connection_id) = tab.get("connectionId").and_then(|v| v.as_str()) {
        app.state::<AppState>()
            .connections
            .write()
            .hold(connection_id, &label);
    }
    app.state::<AppState>()
        .detached_tab_intents
        .write()
        .insert(label.clone(), tab);
    crate::window_chrome::builder(&app, &label)
        .title(title)
        .inner_size(1000.0, 700.0)
        .min_inner_size(480.0, 320.0)
        // See `open_new_window` above for why this matters even for a window
        // with no dockview instance of its own — the data grid's own drag
        // interactions rely on the same native HTML5 DnD path.
        .disable_drag_drop_handler()
        .build()?;
    let _ = app.emit(WINDOW_LIST_CHANGED_EVENT, ());
    Ok(label)
}

/// Drain the tab payload stashed for `label` by [`open_tab_window`]. Called
/// once by the detached window's frontend on boot.
#[tauri::command]
pub fn take_detached_tab_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<serde_json::Value>> {
    Ok(state.detached_tab_intents.write().remove(&label))
}

/// Open Pulse's expanded view in a window of its own.
///
/// Deliberately not a workspace tab and not a detached *tab* window either:
/// Pulse is context, not a document, so it has no `TabKind`, nothing in
/// `useTabs` and nothing in the persisted tab state. What it needs carried
/// across is one connection id, which is why this does not reuse
/// [`open_tab_window`]'s opaque payload.
///
/// `async fn` for the same reason [`open_new_window`] is: a sync command that
/// builds a `WebviewWindow` deadlocks WebView2 on Windows, and the symptom is
/// not an error but a blank window Windows marks "Not Responding".
#[tauri::command]
pub async fn open_pulse_window(
    app: AppHandle,
    connection_id: String,
    title: String,
) -> AppResult<String> {
    let label = format!("pulsewin-{}", Uuid::new_v4());
    // Held for the same reason as a detached tab's: see `open_tab_window`.
    app.state::<AppState>()
        .connections
        .write()
        .hold(&connection_id, &label);
    app.state::<AppState>()
        .pulse_window_intents
        .write()
        .insert(label.clone(), connection_id);
    crate::window_chrome::builder(&app, &label)
        .title(title)
        // Wider than the detached-tab window: the expanded Pulse is a rail plus
        // tables of digests and sessions, and at 1000px those wrap into
        // uselessness.
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 420.0)
        // See `open_new_window`. No dockview here, but the same native
        // drag-drop handler would swallow any HTML5 drag this window grows.
        .disable_drag_drop_handler()
        .build()?;
    let _ = app.emit(WINDOW_LIST_CHANGED_EVENT, ());
    Ok(label)
}

/// Drain the connection id stashed for `label` by [`open_pulse_window`].
/// Called once by the Pulse window's frontend on boot.
#[tauri::command]
pub fn take_pulse_window_intent(
    state: State<'_, AppState>,
    label: String,
) -> AppResult<Option<String>> {
    Ok(state.pulse_window_intents.write().remove(&label))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{DbPool, MongoConn};
    use crate::tab_state::{Environment, PersistedTabState};
    use crate::testkit;

    /// The split that stops one connector-driven connection from reserving
    /// half a server's allowance. Two of them used to spend a whole default
    /// budget of ten between themselves.
    #[test]
    fn a_connector_opened_connection_asks_for_a_view_sized_share() {
        let policy = PoolPolicy {
            budget: crate::db::pool::DEFAULT_ENDPOINT_BUDGET,
            child_request: crate::db::pool::DEFAULT_CHILD_MAX_CONNECTIONS,
            keepalive: Duration::from_secs(180),
            ping_timeout: crate::db::pool::DEFAULT_OPERATION_TIMEOUT,
        };
        assert_eq!(
            top_level_request_for(PoolOrigin::User, &policy, 0),
            crate::db::pool::TOP_LEVEL_REQUEST
        );
        assert_eq!(top_level_request_for(PoolOrigin::Bridge, &policy, 0), 2);
    }

    /// Three profiles on one server under the default budget of ten. Each used
    /// to ask for five, so the third was refused by our own accounting while
    /// the server saw two or three sockets. The share is now adaptive: the
    /// first takes five, later ones half of what is left, floor two.
    #[test]
    fn later_connections_to_one_server_take_half_of_what_is_left() {
        let policy = PoolPolicy {
            budget: crate::db::pool::DEFAULT_ENDPOINT_BUDGET,
            child_request: crate::db::pool::DEFAULT_CHILD_MAX_CONNECTIONS,
            keepalive: Duration::from_secs(180),
            ping_timeout: crate::db::pool::DEFAULT_OPERATION_TIMEOUT,
        };
        let registry = std::sync::Arc::new(crate::db::endpoint::EndpointRegistry::default());
        let key = EndpointKey::for_profile(&crate::testkit::profile("p")).unwrap();
        let mut grants = Vec::new();
        let mut amounts = Vec::new();
        loop {
            let requested = top_level_request_for(PoolOrigin::User, &policy, registry.in_use(&key));
            match registry.reserve(&key, requested, policy.budget, MIN_MAX_CONNECTIONS) {
                Ok(g) => {
                    amounts.push(g.amount());
                    grants.push(g);
                }
                Err(_) => break,
            }
        }
        assert_eq!(
            amounts,
            vec![5, 2, 2],
            "three connections to one server instead of two"
        );
        // The connector's share is unchanged by any of this.
        assert_eq!(top_level_request_for(PoolOrigin::Bridge, &policy, 9), 2);
    }

    #[test]
    fn a_connector_opened_connection_still_respects_the_deadlock_floor() {
        // A hand-edited child ceiling of one would hand out a pool that
        // deadlocks a batch against a concurrent read — the floor holds
        // whoever the pool is for.
        let policy = PoolPolicy {
            budget: crate::db::pool::DEFAULT_ENDPOINT_BUDGET,
            child_request: 1,
            keepalive: Duration::from_secs(0),
            ping_timeout: crate::db::pool::DEFAULT_OPERATION_TIMEOUT,
        };
        assert_eq!(
            top_level_request_for(PoolOrigin::Bridge, &policy, 0),
            MIN_MAX_CONNECTIONS
        );
        // ...but never more than the server's whole allowance.
        let tight = PoolPolicy {
            budget: 1,
            ..policy
        };
        assert_eq!(top_level_request_for(PoolOrigin::Bridge, &tight, 0), 1);
    }

    /// The first connect of a session against a server that turns out to be
    /// full: nothing else is open, so there is no footprint of ours to
    /// disclose. Quoting "0 connection pool(s) and 0 per-database pool(s)"
    /// there read as though the zero were the finding — see ADR #66, where
    /// this sentence was what made a misdiagnosis convincing.
    #[test]
    fn a_limit_error_with_no_pools_open_does_not_quote_an_empty_footprint() {
        let state = AppState::new();
        let annotated = annotate_connection_limit(
            &state,
            AppError::TooManyConnections("server is full".into()),
        )
        .to_string();
        assert!(annotated.contains("server is full"));
        assert!(
            !annotated.contains("0 connection pool(s)"),
            "an empty footprint is not worth a sentence: {annotated}"
        );
        // The other occupants still explain a server we did not fill.
        assert!(annotated.contains("Other clients on this machine"));
    }

    /// `#[tokio::test]` because `connect_lazy` spawns the pool's own
    /// maintenance task up front and needs a reactor to do it — the same
    /// reason every test in `pool_reaper` is async.
    #[tokio::test]
    async fn the_footprint_is_quoted_once_there_is_one() {
        let state = AppState::new();
        state.connections.write().insert(
            "p".into(),
            ActivePool::bare(DbPool::Sqlite(
                sqlx::sqlite::SqlitePoolOptions::new()
                    .connect_lazy("sqlite::memory:")
                    .expect("a lazy pool touches nothing"),
            )),
        );
        let annotated = annotate_connection_limit(
            &state,
            AppError::TooManyConnections("server is full".into()),
        )
        .to_string();
        assert!(annotated.contains("1 connection pool(s) and 0 per-database pool(s)"));
    }

    /// Anything that is not a limit refusal passes through untouched — the
    /// annotation must not start explaining pools on, say, a bad password.
    #[test]
    fn an_unrelated_error_is_never_annotated() {
        let state = AppState::new();
        let annotated =
            annotate_connection_limit(&state, AppError::NotFound("profile deadbeef".into()))
                .to_string();
        assert_eq!(annotated, "not found: profile deadbeef");
    }

    /// A profile a shared origin publishes.
    fn shared(id: &str, origin: &str) -> ConnectionProfile {
        ConnectionProfile {
            origin_id: Some(origin.into()),
            ..testkit::profile(id)
        }
    }

    /// An environment holding `id` in all four places the sweep has to reach.
    fn env_holding(env_id: &str, id: &str) -> Environment {
        let mut env = Environment {
            id: env_id.into(),
            ..Environment::default()
        };
        env.connections
            .insert(id.into(), crate::tab_state::ConnectionTabState::default());
        env.launch.active_connections = vec![id.into(), "other".into()];
        env.launch.selected_connection_id = Some(id.into());
        env.launch
            .database_visibility
            .insert(id.into(), Some(vec!["one".into()]));
        env
    }

    #[test]
    fn plan_bulk_delete_refuses_origin_owned_profiles() {
        let profiles = vec![testkit::profile("local"), shared("mirror", "o1")];
        let plan = plan_bulk_delete(&profiles, &["local".to_string(), "mirror".to_string()]);
        assert_eq!(plan.delete, vec!["local".to_string()]);
        assert_eq!(plan.skipped_origin, vec!["mirror".to_string()]);
        assert!(plan.missing.is_empty());
    }

    #[test]
    fn plan_bulk_delete_reports_unknown_ids_as_missing() {
        let profiles = vec![testkit::profile("local")];
        let plan = plan_bulk_delete(&profiles, &["ghost".to_string()]);
        assert!(plan.delete.is_empty());
        assert_eq!(plan.missing, vec!["ghost".to_string()]);
    }

    /// The report is what the confirmation dialog reads back, so the order the
    /// caller asked in is the order it has to keep.
    #[test]
    fn plan_bulk_delete_preserves_request_order() {
        let profiles = vec![
            testkit::profile("b"),
            testkit::profile("a"),
            testkit::profile("c"),
        ];
        let plan = plan_bulk_delete(
            &profiles,
            &["c".to_string(), "a".to_string(), "b".to_string()],
        );
        assert_eq!(
            plan.delete,
            vec!["c".to_string(), "a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn plan_bulk_delete_handles_an_empty_request() {
        assert_eq!(plan_bulk_delete(&[], &[]), BulkDeletePlan::default());
    }

    /// The thing that stops a persisted tab pointing at a connection that no
    /// longer exists — and it has to happen in *every* environment, not just the
    /// active one, or the entry comes back when the user switches.
    #[test]
    fn sweep_tab_state_clears_every_environment() {
        let mut ts = PersistedTabState {
            environments: vec![env_holding("e1", "gone"), env_holding("e2", "gone")],
            ..PersistedTabState::default()
        };
        sweep_tab_state_for_profiles(&mut ts, &["gone".to_string()]);
        for env in &ts.environments {
            assert!(!env.connections.contains_key("gone"), "{}", env.id);
            assert_eq!(env.launch.active_connections, vec!["other".to_string()]);
            assert!(env.launch.selected_connection_id.is_none());
            assert!(env.launch.database_visibility.is_empty());
        }
    }

    #[test]
    fn sweep_tab_state_is_idempotent_and_ignores_unknown_ids() {
        let mut ts = PersistedTabState {
            environments: vec![env_holding("e1", "gone")],
            ..PersistedTabState::default()
        };
        sweep_tab_state_for_profiles(&mut ts, &["gone".to_string()]);
        let after_first = format!("{:?}", ts.environments[0].launch);
        sweep_tab_state_for_profiles(&mut ts, &["gone".to_string(), "never-existed".to_string()]);
        assert_eq!(after_first, format!("{:?}", ts.environments[0].launch));
    }

    /// Leaves another profile's state alone — the sweep is keyed, not a reset.
    #[test]
    fn sweep_tab_state_leaves_other_profiles_intact() {
        let mut ts = PersistedTabState {
            environments: vec![env_holding("e1", "keep")],
            ..PersistedTabState::default()
        };
        sweep_tab_state_for_profiles(&mut ts, &["gone".to_string()]);
        let env = &ts.environments[0];
        assert!(env.connections.contains_key("keep"));
        assert_eq!(env.launch.selected_connection_id.as_deref(), Some("keep"));
        assert!(env.launch.database_visibility.contains_key("keep"));
    }

    /// Characterisation of the refactor: the batch of one has to decide exactly
    /// what the single-id path used to decide on its own.
    #[test]
    fn deleting_one_profile_matches_the_batch_of_one() {
        let profiles = vec![testkit::profile("local")];
        let plan = plan_bulk_delete(&profiles, &["local".to_string()]);
        assert_eq!(plan.delete, vec!["local".to_string()]);
        assert!(plan.skipped_origin.is_empty() && plan.missing.is_empty());
    }

    async fn mongo_client() -> mongodb::Client {
        // `ClientOptions::parse` + `Client::with_options` only parse/validate
        // and spawn the driver's background monitor tasks — no reachable
        // server is required, so this is safe to construct in a unit test
        // (mirrors `db/mongo/mod.rs`'s real connection setup).
        let options = mongodb::options::ClientOptions::parse("mongodb://127.0.0.1:1")
            .await
            .expect("valid connection string");
        mongodb::Client::with_options(options).expect("client construction is lazy")
    }

    #[tokio::test]
    async fn resolve_mongo_database_view_creates_and_reuses_child_pool() {
        let state = AppState::new();
        let client = mongo_client().await;
        state.connections.write().insert(
            "parent".to_string(),
            ActivePool::bare(crate::state::DbPool::Mongo(MongoConn {
                client: client.clone(),
                database: None,
                sockets: Default::default(),
            })),
        );

        let child_id = resolve_mongo_database_view(&state, "parent", "mydb")
            .await
            .unwrap();
        assert_eq!(child_id, "parent::db::mydb");
        match state.connections.read().get(&child_id) {
            Some(crate::state::DbPool::Mongo(conn)) => {
                assert_eq!(conn.database.as_deref(), Some("mydb"));
            }
            _ => panic!("expected a Mongo child pool"),
        }

        // Idempotent: calling again for the same database returns the same
        // id without erroring (and without needing the parent pool again).
        state.connections.write().remove("parent");
        let again = resolve_mongo_database_view(&state, "parent", "mydb")
            .await
            .unwrap();
        assert_eq!(again, child_id);
    }

    #[tokio::test]
    async fn resolve_mongo_database_view_errors_without_a_parent_pool() {
        let state = AppState::new();
        let err = resolve_mongo_database_view(&state, "missing", "mydb")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotConnected(_)));
    }

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            name: name.into(),
            ..crate::testkit::profile(id)
        }
    }

    fn exported(id: &str, name: &str) -> transfer::ExportedProfile {
        transfer::ExportedProfile {
            profile: profile(id, name),
            secrets: None,
        }
    }

    #[test]
    fn an_imported_profile_is_never_exposed_to_mcp() {
        // `ExportedProfile` flattens the whole `ConnectionProfile`, so a bundle
        // written on a machine that had the connection exposed carries
        // `mcp_exposed: true`. Importing someone's connections to look at them
        // must not hand every configured MCP client access to them on the spot.
        let mut profiles = Vec::new();
        let mut ep = exported("orig-a", "A");
        ep.profile.mcp_exposed = true;
        ep.profile.mcp_write = crate::state::McpWritePolicy::Full;

        let (result, _map, _overwritten) = apply_profile_imports(
            &mut profiles,
            vec![ep],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.imported.len(), 1);
        assert!(!profiles[0].mcp_exposed, "exposure is re-opted-in locally");
        // The policy rides along untouched: it grants nothing while the
        // connection is unreachable, and clearing it too would discard a level
        // the user is about to want.
        assert_eq!(profiles[0].mcp_write, crate::state::McpWritePolicy::Full);
    }

    /// Same reasoning as the MCP exposure above, one surface across: an
    /// imported bundle must not decide what this machine's AI panel may read,
    /// and least of all whether its rows may leave.
    #[test]
    fn an_imported_profile_is_never_reachable_by_the_ai_panel() {
        let mut profiles = Vec::new();
        let mut ep = exported("orig-a", "A");
        ep.profile.ai_enabled = true;
        ep.profile.ai_rows_allowed = true;

        let (result, _map, _overwritten) = apply_profile_imports(
            &mut profiles,
            vec![ep],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.imported.len(), 1);
        assert!(!profiles[0].ai_enabled, "AI reach is re-opted-in locally");
        assert!(!profiles[0].ai_rows_allowed, "so is row access");
    }

    #[test]
    fn apply_profile_imports_maps_original_ids_to_fresh_ones() {
        // `import_environment` needs this map to translate a bundle's
        // `connection_ids` (the original, pre-import ids) into whatever
        // actually landed in `profiles.json` — every imported profile gets a
        // fresh UUID, never its original id (to avoid keychain collisions).
        let mut profiles = Vec::new();
        let (result, id_map, _overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A"), exported("orig-b", "B")],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.imported.len(), 2);
        assert_eq!(id_map.len(), 2);
        let new_a = id_map.get("orig-a").expect("orig-a mapped");
        let new_b = id_map.get("orig-b").expect("orig-b mapped");
        assert_ne!(new_a, "orig-a", "must not reuse the original id");
        assert!(result.imported.contains(new_a));
        assert!(result.imported.contains(new_b));
        assert!(profiles.iter().any(|p| &p.id == new_a && p.name == "A"));
    }

    #[test]
    fn apply_profile_imports_maps_a_skipped_profile_to_itself() {
        let mut profiles = Vec::new();
        let mut resolutions = std::collections::HashMap::new();
        resolutions.insert("orig-a".to_string(), ConflictAction::Skip);
        // Pre-seed a profile with the same id so it registers as a conflict.
        profiles.push(profile("orig-a", "Existing"));

        let (result, id_map, overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A")],
            None,
            &resolutions,
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.skipped, vec!["orig-a".to_string()]);
        // The conflict was matched by id, so the local profile already answers
        // to it: the reference resolves, it just resolves to what is already
        // here. Callers translate ids through this map to decide what an
        // imported environment can see and where a JSON-Schema binding points,
        // and both read a missing entry as "this connection did not land".
        assert_eq!(
            id_map.get("orig-a").map(String::as_str),
            Some("orig-a"),
            "a skipped profile must map to the local profile it collided with"
        );
        // Nothing was replaced, so nothing needs repointing.
        assert!(overwritten.is_empty());
    }

    #[test]
    fn an_unresolved_conflict_defaults_to_skip_not_rename() {
        // A conflict is matched by id, so it is never a coincidence — it is
        // definitionally the same connection already present (the exact case
        // hit by exporting one's own profiles and reimporting them
        // unchanged). Leaving it unresolved must not silently duplicate it
        // under a fresh id with a " (imported)" suffix.
        let mut profiles = vec![profile("orig-a", "A")];

        let (result, id_map, overwritten) = apply_profile_imports(
            &mut profiles,
            vec![exported("orig-a", "A")],
            None,
            &std::collections::HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.skipped, vec!["orig-a".to_string()]);
        assert!(result.imported.is_empty());
        assert!(result.renamed.is_empty());
        assert_eq!(id_map.get("orig-a").map(String::as_str), Some("orig-a"));
        assert_eq!(profiles.len(), 1, "no duplicate profile must be created");
        // Nothing was overwritten, so no JSON-Schema binding should be
        // repointed either (see the third return value).
        assert!(overwritten.is_empty());
    }
}
