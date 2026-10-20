//! Policy applied to what an AI asks for: every [`BridgeRequest`] mapped onto
//! what it needs, and the discovery results filtered to what the AI may see.

use super::model::{verb_names, Grant, Subject};
use super::resolve::{Ctx, Need};
use super::{current_user, PolicyState};
use crate::bridge::protocol::BridgeRequest;
use crate::commands::schema::{DatabaseInfo, TableInfo};
use crate::db::sql::Verbs;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, ConnectionProfile};
use serde::Serialize;
use std::sync::Arc;

/// What an AI request needs, variant by variant.
///
/// Exhaustive, with **no `_` arm** (convention #49, ADR #71): a new `BridgeRequest`
/// cannot be added without saying what policy it needs, because the failure
/// mode of a default is an AI reaching a relation its user's role hides.
fn needs_of(request: &BridgeRequest) -> Vec<Need> {
    use BridgeRequest::*;
    let rel = |schema: &Option<String>, name: &str, verbs: Verbs| Need::Relation {
        schema: schema.clone(),
        name: name.to_string(),
        verbs,
    };
    match request {
        // Opening the pool, and the plumbing that only answers about it.
        EnsureConnected { .. } | IsMongo { .. } | ServerVersion { .. } => vec![Need::Endpoint],
        ResolveMongoTarget { database, .. } => vec![Need::Database(database.clone())],
        // Discovery is allowed and *filtered* ([`filter_databases`],
        // [`filter_tables`]), so the AI never learns a hidden relation's name.
        ListDatabases { .. } | ListTables { .. } => vec![Need::Endpoint],
        GetTableStructure { schema, table, .. } | ListIndexes { schema, table, .. } => {
            vec![rel(schema, table, Verbs::SELECT)]
        }
        GetViewDefinition { schema, view, .. } => vec![rel(schema, view, Verbs::SELECT)],
        FetchTableData { schema, table, .. } => vec![rel(schema, table, Verbs::SELECT)],
        InsertRow { schema, table, .. } => vec![rel(schema, table, Verbs::INSERT)],
        UpdateCell { schema, table, .. } => vec![rel(schema, table, Verbs::UPDATE)],
        DeleteRows { schema, table, .. } => vec![rel(schema, table, Verbs::DELETE)],
        // Free text: its verbs are whatever the classifier finds in it, and a
        // scoped rule refuses it whatever they are (D3).
        RunStatement { sql, .. } => vec![Need::FreeSql(crate::db::classify::verbs_of(sql))],
        // Several free-text writes: whatever any of them does.
        RunWriteBatch { writes, .. } => vec![Need::FreeSql(
            crate::commands::write_batch::verbs_of_writes(writes),
        )],
        // Other people's statements, the server's sessions, its accounts.
        ListUsers { .. }
        | ListPrivileges { .. }
        | PulseHealth { .. }
        | PulseMetrics { .. }
        | PulseTopQueries { .. }
        | PulseStorage { .. }
        | PulseSessions { .. }
        | PulseIndexUsage { .. } => vec![Need::Monitor],
        // A plan is read from text the AI supplies, so it is free SQL too.
        PulseExplain { sample, .. } => vec![
            Need::Monitor,
            Need::FreeSql(crate::db::classify::verbs_of(sample)),
        ],
        // A dry run executes nothing, but names the view it would change.
        PreviewViewChange { schema, name, .. } => vec![rel(schema, name, Verbs::SELECT)],
        ApplyViewChange {
            schema,
            name,
            rename_from,
            ..
        } => {
            let mut needs = vec![rel(schema, name, Verbs::DDL)];
            if let Some(old) = rename_from {
                needs.push(rel(schema, old, Verbs::DDL));
            }
            needs
        }
        DropView { schema, view, .. } => vec![rel(schema, view, Verbs::DDL)],
        CreateMongoIndex { collection, .. } | DropMongoIndex { collection, .. } => {
            vec![rel(&None, collection, Verbs::DDL)]
        }
    }
}

/// The profile behind a connection id — a per-database view folds to its
/// parent.
///
/// For the AI it is read from disk first, as `bridge::server::check_policy`
/// does, so the sidecar sees a profile edited in the app since it started. For
/// a person it is the app's own memory: this runs on every grid page and cell
/// edit, and the app is what writes `profiles.json` in the first place.
fn profile_for(
    state: &AppState,
    connection_id: &str,
    subject: Subject,
) -> Option<ConnectionProfile> {
    let root = crate::state::parent_connection_id(connection_id);
    let in_memory = || state.profiles.read().iter().find(|p| p.id == root).cloned();
    match subject {
        Subject::Ai => crate::store::load_profiles()
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.id == root))
            .or_else(in_memory),
        Subject::Human => in_memory(),
    }
}

/// The database a request is addressed to: the `::db::` part of a
/// per-database view, else the profile's own, if it names one.
fn database_of<'a>(
    connection_id: &'a str,
    profile: Option<&'a ConnectionProfile>,
) -> Option<&'a str> {
    crate::state::split_database_view(connection_id)
        .map(|(_, db)| db)
        .or_else(|| {
            profile
                .map(|p| p.database.as_str())
                .filter(|db| !db.is_empty())
        })
}

/// The active document, or `Ok(None)` when the machine is unmanaged, or the
/// refusal when the policy is pending or broken.
///
/// Pending and broken block **everything** for either subject: which
/// endpoints the policy would have governed is unknowable, so no connection
/// can be assumed to be outside it (§5.4). For a person that means the app
/// opens and its settings work, but no connection reads or writes until the
/// policy is read — the wording says so, since they see it in a locked panel.
fn active(state: &AppState, subject: Subject) -> AppResult<Option<Arc<super::model::PolicyDoc>>> {
    let who = match subject {
        Subject::Ai => "the AI is",
        Subject::Human => "reading and changing data is",
    };
    match &*state.policy.read() {
        PolicyState::Unmanaged => Ok(None),
        PolicyState::Active { doc, .. } => Ok(Some(doc.clone())),
        PolicyState::Pending { source } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy is still being read from {source}; {who} \
             paused until it is. Try again in a moment."
        ))),
        PolicyState::Broken { source, error } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy could not be applied, so {who} blocked on \
             every connection ({source}: {error}). Ask your administrator to fix it."
        ))),
    }
}

/// Whether the policy lets this person have HuginnDB download a tool (the
/// `mongosh` of the Terminal, ADR #109). Unmanaged: yes. A policy that is
/// pending or broken blocks, like everything else it governs; an active one
/// follows the person's role (`allowToolDownloads`, off unless the role says
/// so). The refusal is the sentence the interface shows.
pub fn tool_downloads(state: &AppState) -> AppResult<()> {
    match &*state.policy.read() {
        PolicyState::Unmanaged => Ok(()),
        PolicyState::Pending { source } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy is still being read from {source}; downloading              tools is paused until it is. Try again in a moment."
        ))),
        PolicyState::Broken { source, error } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy could not be applied, so downloading tools is              blocked ({source}: {error}). Ask your administrator to fix it."
        ))),
        PolicyState::Active { doc, .. } => {
            let (name, role) = doc.role_for(current_user());
            if role.allow_tool_downloads {
                Ok(())
            } else {
                Err(AppError::InvalidInput(format!(
                    "your organization's HuginnDB policy does not let the role \"{name}\"                      download tools; install mongosh yourself or ask your administrator                      (allowToolDownloads)."
                )))
            }
        }
    }
}

/// Refuse `request` unless the policy lets the AI make it. Called at the top
/// of `bridge::exec::execute`, and for `EnsureConnected` where that is
/// intercepted before it.
pub fn enforce(state: &AppState, request: &BridgeRequest) -> AppResult<()> {
    let connection_id = crate::bridge::server::connection_id_of(request);
    for need in needs_of(request) {
        require(state, &connection_id, &need, Subject::Ai)?;
    }
    Ok(())
}

/// Refuse unless `subject` may do what `need` says on `connection_id`.
///
/// The one entry point both subjects share. The AI reaches it through
/// [`enforce`]; a person through the app's own commands (`commands::guard`),
/// which know what they are about to do and name it directly.
pub fn require(
    state: &AppState,
    connection_id: &str,
    need: &Need,
    subject: Subject,
) -> AppResult<()> {
    let Some(doc) = active(state, subject)? else {
        return Ok(());
    };
    let profile = profile_for(state, connection_id, subject);
    let ctx = Ctx {
        doc: &doc,
        user: current_user(),
        profile: profile.as_ref(),
        database: database_of(connection_id, profile.as_ref()),
        subject,
    };
    ctx.decide(need).map_err(AppError::InvalidInput)
}

/// Run `f` against the policy context for `connection_id`: `unmanaged` when
/// there is no policy, `blocked` when it is pending or broken.
///
/// `blocked` is its own argument on purpose. The first version returned the
/// unmanaged answer for both, which was harmless for the AI — [`enforce`] had
/// refused the request before any filter ran — and would have shown a person
/// every table on a machine whose policy share was down.
fn with_ctx<T>(
    state: &AppState,
    connection_id: &str,
    subject: Subject,
    unmanaged: T,
    blocked: T,
    f: impl FnOnce(&Ctx<'_>) -> T,
) -> T {
    let doc = match active(state, subject) {
        Ok(Some(doc)) => doc,
        Ok(None) => return unmanaged,
        Err(_) => return blocked,
    };
    let profile = profile_for(state, connection_id, subject);
    let ctx = Ctx {
        doc: &doc,
        user: current_user(),
        profile: profile.as_ref(),
        database: database_of(connection_id, profile.as_ref()),
        subject,
    };
    f(&ctx)
}

/// The databases `subject` may see.
pub fn filter_databases_for(
    state: &AppState,
    connection_id: &str,
    databases: Vec<DatabaseInfo>,
    subject: Subject,
) -> Vec<DatabaseInfo> {
    let hide_all = Some(vec![false; databases.len()]);
    let keep: Option<Vec<bool>> = with_ctx(state, connection_id, subject, None, hide_all, |ctx| {
        Some(
            databases
                .iter()
                .map(|d| ctx.database_visible(&d.name))
                .collect(),
        )
    });
    retain_marked(databases, keep)
}

/// The databases the AI may see.
pub fn filter_databases(
    state: &AppState,
    connection_id: &str,
    databases: Vec<DatabaseInfo>,
) -> Vec<DatabaseInfo> {
    filter_databases_for(state, connection_id, databases, Subject::Ai)
}

/// `items` without the ones `keep` marks false; all of them when there is no
/// policy to filter by.
fn retain_marked<T>(items: Vec<T>, keep: Option<Vec<bool>>) -> Vec<T> {
    match keep {
        None => items,
        Some(keep) => items
            .into_iter()
            .zip(keep)
            .filter_map(|(item, k)| k.then_some(item))
            .collect(),
    }
}

/// The tables and views `subject` may see.
pub fn filter_tables_for(
    state: &AppState,
    connection_id: &str,
    tables: Vec<TableInfo>,
    subject: Subject,
) -> Vec<TableInfo> {
    let hide_all = Some(vec![false; tables.len()]);
    let keep: Option<Vec<bool>> = with_ctx(state, connection_id, subject, None, hide_all, |ctx| {
        Some(
            tables
                .iter()
                .map(|t| {
                    let schema = (!t.schema.is_empty()).then_some(t.schema.as_str());
                    ctx.relation_visible(schema, &t.name)
                })
                .collect(),
        )
    });
    retain_marked(tables, keep)
}

/// The tables and views the AI may see.
pub fn filter_tables(
    state: &AppState,
    connection_id: &str,
    tables: Vec<TableInfo>,
) -> Vec<TableInfo> {
    filter_tables_for(state, connection_id, tables, Subject::Ai)
}

/// Whether free SQL is withheld from `subject` on this connection.
pub fn free_sql_blocked_for(state: &AppState, connection_id: &str, subject: Subject) -> bool {
    with_ctx(state, connection_id, subject, false, true, |ctx| {
        ctx.free_sql_blocked()
    })
}

/// Whether free SQL is withheld from the AI on this connection, so the AI
/// panel can leave `run_query` out of its catalogue instead of offering a tool
/// that always refuses (gotcha #74: absence beats present-but-refused). Over
/// MCP the tool list cannot vary per connection (ADRs #58, #59), so there
/// the call is refused instead.
pub fn free_sql_blocked(state: &AppState, connection_id: &str) -> bool {
    free_sql_blocked_for(state, connection_id, Subject::Ai)
}

/// Whether the AI may reach this connection at all — what the MCP
/// `list_connections` tool filters by, so a model is not shown connections it
/// will be refused on.
// Used by the MCP `list_connections` tool only, which the `mcp` feature gates.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn reachable_by_ai(state: &AppState, profile: &ConnectionProfile) -> bool {
    match active(state, Subject::Ai) {
        Err(_) => false,
        Ok(None) => true,
        Ok(Some(doc)) => Ctx {
            doc: &doc,
            user: current_user(),
            profile: Some(profile),
            database: None,
            subject: Subject::Ai,
        }
        .decide(&Need::Endpoint)
        .is_ok(),
    }
}

/// What the app's own interface may offer a person, per connection — the
/// frontend half of the people phase. The backend refuses regardless; this is
/// so a control the policy forbids is shown locked, with the reason, instead
/// of being offered and then failing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyAccess {
    /// `unmanaged` / `pending` / `active` / `broken`.
    pub state: &'static str,
    /// Why everything is locked, when the policy is pending or broken.
    pub reason: Option<String>,
    pub connections: Vec<ConnectionAccess>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAccess {
    /// As asked: a profile id or a `<parent>::db::<name>` view id.
    pub id: String,
    /// Whether the policy governs this connection at all.
    pub managed: bool,
    /// Whether the person may use it (and, for a view id, its database).
    pub visible: bool,
    pub free_sql: bool,
    /// An upper bound for the connection: a single relation may allow less,
    /// which [`relation_access`] answers.
    pub verbs: Vec<&'static str>,
    pub export: bool,
    pub monitor: bool,
    /// The refusal a locked control shows, when `visible` is false.
    pub reason: Option<String>,
}

/// What a person may do on each relation, in one call per listing or tab.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationAccess {
    pub visible: bool,
    pub verbs: Vec<&'static str>,
    pub export: bool,
}

/// Everything, for a machine or connection the policy does not govern.
fn full_grant() -> Grant {
    Grant {
        verbs: Verbs::ALL,
        export: true,
        monitor: true,
    }
}

fn state_label(state: &AppState) -> &'static str {
    match &*state.policy.read() {
        PolicyState::Unmanaged => "unmanaged",
        PolicyState::Pending { .. } => "pending",
        PolicyState::Active { .. } => "active",
        PolicyState::Broken { .. } => "broken",
    }
}

/// [`PolicyAccess`] for the person using the app.
pub fn access(state: &AppState, connection_ids: &[String]) -> PolicyAccess {
    let label = state_label(state);
    let doc = match active(state, Subject::Human) {
        Ok(doc) => doc,
        Err(e) => {
            let reason = e.to_string();
            return PolicyAccess {
                state: label,
                connections: connection_ids
                    .iter()
                    .map(|id| ConnectionAccess {
                        id: id.clone(),
                        managed: true,
                        visible: false,
                        free_sql: false,
                        verbs: Vec::new(),
                        export: false,
                        monitor: false,
                        reason: Some(reason.clone()),
                    })
                    .collect(),
                reason: Some(reason),
            };
        }
    };
    let connections = connection_ids
        .iter()
        .map(|id| {
            let Some(doc) = &doc else {
                let full = full_grant();
                return ConnectionAccess {
                    id: id.clone(),
                    managed: false,
                    visible: true,
                    free_sql: true,
                    verbs: verb_names(full.verbs),
                    export: true,
                    monitor: true,
                    reason: None,
                };
            };
            let profile = profile_for(state, id, Subject::Human);
            connection_access(doc, current_user(), profile.as_ref(), id, Subject::Human)
        })
        .collect();
    PolicyAccess {
        state: label,
        reason: None,
        connections,
    }
}

/// What `user` may do on connection `id` under `doc`, for `subject` — the
/// decision [`access`] makes for the person using the app, open to any
/// document and any user, which is what the policy editor's "view as" preview
/// needs for a draft that is not in force yet.
pub(super) fn connection_access(
    doc: &super::model::PolicyDoc,
    user: &str,
    profile: Option<&ConnectionProfile>,
    id: &str,
    subject: Subject,
) -> ConnectionAccess {
    let ctx = Ctx {
        doc,
        user,
        profile,
        database: database_of(id, profile),
        subject,
    };
    let refusal = ctx.decide(&Need::Endpoint).err().or_else(|| {
        crate::state::split_database_view(id)
            .and_then(|(_, db)| ctx.decide(&Need::Database(db.to_string())).err())
    });
    let grant = if refusal.is_some() {
        Grant::default()
    } else {
        ctx.database_grant().unwrap_or_else(full_grant)
    };
    ConnectionAccess {
        id: id.to_string(),
        managed: !ctx.is_unmanaged(),
        visible: refusal.is_none(),
        free_sql: refusal.is_none() && !ctx.free_sql_blocked(),
        verbs: verb_names(grant.verbs),
        export: grant.export,
        // Server-wide, so not the per-database grant.
        monitor: refusal.is_none() && ctx.decide(&Need::Monitor).is_ok(),
        reason: refusal,
    }
}

/// [`RelationAccess`] for each `(schema, name)`, for the person using the app.
pub fn relation_access(
    state: &AppState,
    connection_id: &str,
    relations: &[(Option<String>, String)],
) -> Vec<RelationAccess> {
    let blocked = relations
        .iter()
        .map(|_| RelationAccess {
            visible: false,
            verbs: Vec::new(),
            export: false,
        })
        .collect();
    let everything = || {
        relations
            .iter()
            .map(|_| RelationAccess {
                visible: true,
                verbs: verb_names(Verbs::ALL),
                export: true,
            })
            .collect()
    };
    with_ctx(
        state,
        connection_id,
        Subject::Human,
        everything(),
        blocked,
        |ctx| {
            relations
                .iter()
                .map(|(schema, name)| {
                    let g = ctx
                        .relation_grant(schema.as_deref(), name)
                        .unwrap_or_else(full_grant);
                    RelationAccess {
                        visible: !g.is_empty(),
                        verbs: verb_names(g.verbs),
                        export: g.export && g.verbs.contains(Verbs::SELECT),
                    }
                })
                .collect()
        },
    )
}

/// What Settings → Policy shows: where the policy came from, who this is, and
/// what each connection allows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    /// `unmanaged` / `pending` / `active` / `broken`.
    pub state: &'static str,
    pub source: Option<String>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub user: String,
    pub role: Option<String>,
    pub unmanaged_connections: Option<&'static str>,
    pub connections: Vec<ConnectionPolicy>,
    /// Every role the policy defines, for generating its grants. Nothing the
    /// policy file does not already show to whoever can read it.
    pub roles: Vec<RoleInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub name: String,
    /// The accounts the policy gives this role by name.
    pub members: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPolicy {
    pub id: String,
    pub name: String,
    /// No rule of the role names this connection.
    pub unmatched: bool,
    /// When unmatched: whether the policy leaves it alone (`allow`) or not.
    pub left_alone: bool,
    /// The database user the policy signs this person in to it as (a rule's
    /// `dbUser`, expanded), if it pins one.
    pub db_user: Option<String>,
    pub rules: Vec<RulePolicy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePolicy {
    pub databases: Option<Vec<String>>,
    pub allow: Option<Vec<String>>,
    pub deny: Vec<String>,
    pub human: Vec<&'static str>,
    /// What the AI effectively gets: `ai ∩ human`.
    pub ai: Vec<&'static str>,
    /// Whether free SQL is available to the AI under this rule.
    pub free_sql: bool,
}

pub fn status(state: &AppState) -> PolicyStatus {
    let user = current_user().to_string();
    let (state_label, source, error, warnings, doc) = match &*state.policy.read() {
        PolicyState::Unmanaged => ("unmanaged", None, None, Vec::new(), None),
        PolicyState::Pending { source } => {
            ("pending", Some(source.clone()), None, Vec::new(), None)
        }
        PolicyState::Broken { source, error } => (
            "broken",
            Some(source.clone()),
            Some(error.clone()),
            Vec::new(),
            None,
        ),
        PolicyState::Active {
            doc,
            source,
            warnings,
        } => (
            "active",
            Some(source.clone()),
            None,
            warnings.clone(),
            Some(doc.clone()),
        ),
    };
    let Some(doc) = doc else {
        return PolicyStatus {
            state: state_label,
            source,
            error,
            warnings,
            user,
            role: None,
            unmanaged_connections: None,
            connections: Vec::new(),
            roles: Vec::new(),
        };
    };
    let profiles = state.profiles.read().clone();
    let connections = profiles
        .iter()
        .filter(|p| !p.ephemeral)
        .map(|p| {
            let ctx = Ctx {
                doc: &doc,
                user: &user,
                profile: Some(p),
                database: None,
                subject: Subject::Human,
            };
            let rules: Vec<RulePolicy> = ctx
                .endpoint_rules()
                .into_iter()
                .map(|r| {
                    let ai = r.ai_grant();
                    RulePolicy {
                        databases: r.databases.clone(),
                        allow: r.relations.allow.clone(),
                        deny: r.relations.deny.clone(),
                        human: r.human_grant().names(),
                        ai: ai.names(),
                        // What `Ctx::free_sql_blocked` decides: an unscoped rule
                        // that grants reading. It said "any grant" before, so an
                        // insert-only rule was shown with free SQL it did not have.
                        free_sql: !r.is_scoped() && ai.verbs.contains(Verbs::SELECT),
                    }
                })
                .collect();
            ConnectionPolicy {
                id: p.id.clone(),
                name: p.name.clone(),
                unmatched: rules.is_empty(),
                left_alone: ctx.is_unmanaged(),
                db_user: super::resolve::pinned_db_user(&doc, &user, p),
                rules,
            }
        })
        .collect();
    PolicyStatus {
        state: state_label,
        source,
        error,
        warnings,
        role: Some(doc.role_for(&user).0.to_string()),
        unmanaged_connections: Some(doc.unmanaged_connections.label()),
        roles: doc
            .roles
            .keys()
            .map(|name| RoleInfo {
                name: name.clone(),
                members: doc
                    .users
                    .iter()
                    .filter(|(_, r)| *r == name)
                    .map(|(u, _)| u.clone())
                    .collect(),
            })
            .collect(),
        user,
        connections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;
    use crate::testkit;

    const POLICY: &str = r#"{
        "version": 1,
        "defaultRole": "none",
        "users": {},
        "roles": {
            "none": {},
            "sales": { "rules": [{
                "endpoint": { "host": "erp.local" },
                "databases": ["billing"],
                "relations": { "allow": ["invoices"] },
                "human": ["select", "insert"],
                "ai": ["select", "insert"]
            }] }
        }
    }"#;

    /// A state with one ERP profile and the policy above, with the running
    /// account assigned to `sales` so the test does not depend on who runs it.
    fn state_with_policy() -> AppState {
        let state = AppState::new();
        let text = POLICY.replace(
            "\"users\": {}",
            &format!("\"users\": {{ {:?}: \"sales\" }}", current_user_or_test()),
        );
        let (doc, _) = super::super::model::PolicyDoc::parse(&text).unwrap();
        *state.policy.write() = PolicyState::Active {
            doc: Arc::new(doc),
            source: "test".into(),
            warnings: Vec::new(),
        };
        state.profiles.write().push(ConnectionProfile {
            driver: Driver::Mysql,
            host: "erp.local".into(),
            port: 3306,
            database: "billing".into(),
            ..testkit::profile("policy-test-erp")
        });
        state
    }

    /// The account key the test policy names. `current_user` can be empty on
    /// an exotic CI runner, and an empty key is refused by the parser, so the
    /// empty case gets the default role instead — the test then checks refusals
    /// only. Real runs always have a name.
    fn current_user_or_test() -> String {
        let u = current_user();
        if u.is_empty() {
            "nobody-at-all".into()
        } else {
            u.to_string()
        }
    }

    fn fetch(table: &str) -> BridgeRequest {
        BridgeRequest::FetchTableData {
            connection_id: "policy-test-erp".into(),
            policy_id: "policy-test-erp".into(),
            schema: None,
            table: table.into(),
            limit: 10,
            offset: 0,
            with_count: None,
        }
    }

    #[test]
    fn unmanaged_state_enforces_nothing() {
        let state = AppState::new();
        assert!(enforce(&state, &fetch("anything")).is_ok());
        assert!(!free_sql_blocked(&state, "x"));
    }

    #[test]
    fn a_broken_or_pending_policy_blocks_every_ai_request() {
        let state = AppState::new();
        *state.policy.write() = PolicyState::Broken {
            source: "\\\\srv\\it\\huginn.json".into(),
            error: "cannot read".into(),
        };
        let err = enforce(&state, &fetch("invoices")).unwrap_err().to_string();
        assert!(err.contains("could not be applied"), "{err}");
        assert!(free_sql_blocked(&state, "x"));
        assert!(!reachable_by_ai(&state, &testkit::profile("x")));

        *state.policy.write() = PolicyState::Pending {
            source: "share".into(),
        };
        assert!(enforce(&state, &fetch("invoices")).is_err());
    }

    #[test]
    fn requests_are_checked_against_the_role() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        assert!(enforce(&state, &fetch("invoices")).is_ok());
        assert!(enforce(&state, &fetch("payroll")).is_err());
        let run = BridgeRequest::RunStatement {
            connection_id: "policy-test-erp".into(),
            policy_id: "policy-test-erp".into(),
            sql: "SELECT * FROM payroll".into(),
        };
        let err = enforce(&state, &run).unwrap_err().to_string();
        assert!(err.contains("free-form queries are disabled"), "{err}");
        assert!(free_sql_blocked(&state, "policy-test-erp"));
        let users = BridgeRequest::ListUsers {
            connection_id: "policy-test-erp".into(),
        };
        assert!(enforce(&state, &users).is_err());
    }

    #[test]
    fn discovery_only_shows_what_the_ai_may_reach() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        let table = |name: &str| TableInfo {
            schema: "billing".into(),
            name: name.into(),
            kind: "table".into(),
            row_count: None,
            size_bytes: None,
        };
        let kept = filter_tables(
            &state,
            "policy-test-erp",
            vec![table("invoices"), table("payroll")],
        );
        assert_eq!(
            kept.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["invoices"]
        );

        let db = |name: &str| DatabaseInfo { name: name.into() };
        let kept = filter_databases(&state, "policy-test-erp", vec![db("billing"), db("hr")]);
        assert_eq!(
            kept.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["billing"]
        );
    }

    #[test]
    fn the_status_describes_each_connection() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        let status = status(&state);
        assert_eq!(status.state, "active");
        assert_eq!(status.role.as_deref(), Some("sales"));
        let erp = status
            .connections
            .iter()
            .find(|c| c.id == "policy-test-erp")
            .unwrap();
        assert!(!erp.unmatched);
        assert_eq!(erp.rules[0].ai, ["select", "insert"]);
        assert!(!erp.rules[0].free_sql);
    }

    #[test]
    fn a_blocked_policy_shows_a_person_nothing() {
        let state = AppState::new();
        state.profiles.write().push(testkit::profile("any"));
        *state.policy.write() = PolicyState::Broken {
            source: "share".into(),
            error: "cannot read".into(),
        };
        let table = TableInfo {
            schema: "public".into(),
            name: "t".into(),
            kind: "table".into(),
            row_count: None,
            size_bytes: None,
        };
        // The first version returned the unmanaged answer here, which would
        // have listed every table on a machine whose policy share was down.
        assert!(filter_tables_for(&state, "any", vec![table], Subject::Human).is_empty());
        assert!(free_sql_blocked_for(&state, "any", Subject::Human));
        let err = require(&state, "any", &Need::Endpoint, Subject::Human)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("reading and changing data is blocked"),
            "{err}"
        );

        let access = access(&state, &["any".to_string()]);
        assert_eq!(access.state, "broken");
        assert!(access.reason.is_some());
        assert!(!access.connections[0].visible);
        assert!(access.connections[0].verbs.is_empty());
        let rel = relation_access(&state, "any", &[(None, "t".into())]);
        assert!(!rel[0].visible);
    }

    #[test]
    fn an_unmanaged_machine_offers_a_person_everything() {
        let state = AppState::new();
        let access = access(&state, &["whatever".to_string()]);
        assert_eq!(access.state, "unmanaged");
        let c = &access.connections[0];
        assert!(c.visible && c.free_sql && c.export && c.monitor && !c.managed);
        assert_eq!(c.verbs, ["select", "insert", "update", "delete", "ddl"]);
    }

    #[test]
    fn a_person_is_offered_what_their_role_allows() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        let access = access(&state, &["policy-test-erp".to_string()]);
        let c = &access.connections[0];
        assert!(c.managed && c.visible);
        // The rule names relations, so free SQL is off for people too.
        assert!(!c.free_sql);
        assert_eq!(c.verbs, ["select", "insert"]);
        assert!(!c.export && !c.monitor);

        let rel = relation_access(
            &state,
            "policy-test-erp",
            &[(None, "invoices".into()), (None, "payroll".into())],
        );
        assert!(rel[0].visible);
        assert_eq!(rel[0].verbs, ["select", "insert"]);
        assert!(!rel[1].visible);
        assert!(require(
            &state,
            "policy-test-erp",
            &Need::Relation {
                schema: None,
                name: "invoices".into(),
                verbs: Verbs::DELETE,
            },
            Subject::Human,
        )
        .is_err());
    }

    /// A state whose active policy gives the running account `role`, with
    /// `allowToolDownloads` set as asked.
    fn state_allowing_downloads(allow: Option<bool>) -> AppState {
        let state = AppState::new();
        let flag = match allow {
            Some(v) => format!(r#", "allowToolDownloads": {v}"#),
            None => String::new(),
        };
        let text = format!(
            r#"{{ "version": 1, "defaultRole": "r", "users": {{ {user:?}: "r" }},
                 "roles": {{ "r": {{ "rules": []{flag} }} }} }}"#,
            user = current_user_or_test(),
        );
        let (doc, _) = super::super::model::PolicyDoc::parse(&text).unwrap();
        *state.policy.write() = PolicyState::Active {
            doc: Arc::new(doc),
            source: "test".into(),
            warnings: Vec::new(),
        };
        state
    }

    #[test]
    fn downloading_a_tool_is_free_without_a_policy() {
        assert!(tool_downloads(&AppState::new()).is_ok());
    }

    #[test]
    fn under_a_policy_a_role_must_allow_downloading_a_tool() {
        // Off unless the role says so — a managed machine does not fetch an
        // executable because nobody thought to forbid it.
        let silent = tool_downloads(&state_allowing_downloads(None)).unwrap_err();
        assert!(
            silent.to_string().contains("allowToolDownloads"),
            "{silent}"
        );
        assert!(tool_downloads(&state_allowing_downloads(Some(false))).is_err());
        assert!(tool_downloads(&state_allowing_downloads(Some(true))).is_ok());
    }

    #[test]
    fn a_pending_or_broken_policy_blocks_downloading_a_tool() {
        let state = AppState::new();
        *state.policy.write() = PolicyState::Pending {
            source: "share".into(),
        };
        assert!(tool_downloads(&state).is_err());
        *state.policy.write() = PolicyState::Broken {
            source: "share".into(),
            error: "unreadable".into(),
        };
        assert!(tool_downloads(&state).is_err());
    }
}
