//! The organization's policy applied to what a **person** does through the
//! app's own commands — phase 2 of `docs/POLICY_ROADMAP.md`.
//!
//! Each `#[tauri::command]` that touches a database calls one of these first,
//! naming what it is about to do. They are thin wrappers over
//! `policy::require(…, Subject::Human)` and the people-side filters; the
//! decisions are `policy::resolve`'s, shared with the AI.
//!
//! **In the command wrappers, never in the `_inner` cores.** The cores are
//! shared with `bridge::exec`, which acts for an AI and is already bound by
//! `policy::enforce`; checking there would judge an AI request by the person's
//! `human` block, which is wider than the AI's.
//!
//! **A guardrail, not a wall, and said so** (roadmap §3): a person who holds
//! the database password can open another client. What makes these limits
//! impossible to bypass is a per-person database user whose grants match the
//! policy — phase 3. Without a policy installed every function here is a
//! no-op, so an unmanaged machine behaves exactly as before.
//!
//! `HUMAN_POLICY` below classifies every registered command, and a test fails
//! when a new one is registered without saying which of these it needs —
//! commands are not an enum, so this is how the "no `_` arm" rule (gotchas
//! #49, #71) reaches them.

use crate::commands::query::TableFilter;
use crate::commands::schema::{DatabaseInfo, TableInfo};
use crate::db::sql::Verbs;
use crate::error::AppResult;
use crate::policy::{Need, Subject};
use crate::state::{AppState, DbPool};

fn require(state: &AppState, connection_id: &str, need: Need) -> AppResult<()> {
    crate::policy::require(state, connection_id, &need, Subject::Human)
}

/// The connection itself: opening it, the server version.
pub(crate) fn endpoint(state: &AppState, connection_id: &str) -> AppResult<()> {
    require(state, connection_id, Need::Endpoint)
}

/// A database on the connection — opening a per-database view of it.
pub(crate) fn database(state: &AppState, connection_id: &str, database: &str) -> AppResult<()> {
    require(state, connection_id, Need::Database(database.to_string()))
}

/// `verbs` on one relation.
pub(crate) fn relation(
    state: &AppState,
    connection_id: &str,
    schema: Option<&str>,
    name: &str,
    verbs: Verbs,
) -> AppResult<()> {
    require(
        state,
        connection_id,
        Need::Relation {
            schema: schema.map(str::to_string),
            name: name.to_string(),
            verbs,
        },
    )
}

/// Reading one relation's rows or structure.
pub(crate) fn read(
    state: &AppState,
    connection_id: &str,
    schema: Option<&str>,
    name: &str,
) -> AppResult<()> {
    relation(state, connection_id, schema, name, Verbs::SELECT)
}

/// Free text the person typed — SQL, or mongosh — needing whatever it does.
/// Refused outright under a rule that limits which relations may be seen (D3).
pub(crate) fn free_sql(state: &AppState, connection_id: &str, text: &str) -> AppResult<()> {
    require(
        state,
        connection_id,
        Need::FreeSql(crate::db::classify::verbs_of(text)),
    )
}

/// A `mongosh` session signed in as the connection (`commands::terminal`).
///
/// Free text with every verb: inside `mongosh` any collection can be read and
/// anything can be written or dropped, and nothing the app sees afterwards —
/// keystrokes, not statements — could be checked against the policy. So it is
/// asked for up front as the widest free text there is, and refused under any
/// rule that limits relations (D3) or withholds a write or DDL.
pub(crate) fn mongosh(state: &AppState, connection_id: &str) -> AppResult<()> {
    require(state, connection_id, Need::FreeSql(Verbs::ALL))
}

/// Several statements run as one batch (the editor's "run all", a SQL file
/// import): whatever any of them does.
pub(crate) fn free_sql_batch(
    state: &AppState,
    connection_id: &str,
    statements: &[String],
) -> AppResult<()> {
    let verbs = statements
        .iter()
        .map(|s| crate::db::classify::verbs_of(s))
        .fold(Verbs::NONE, |all, v| all | v);
    require(state, connection_id, Need::FreeSql(verbs))
}

/// A pipeline or query the person wrote that only reads, but may read *other*
/// relations — a MongoDB `$lookup` / `$unionWith`, a view's body. Free SQL for
/// the policy's purposes, at the `select` verb.
pub(crate) fn free_read(state: &AppState, connection_id: &str) -> AppResult<()> {
    require(state, connection_id, Need::FreeSql(Verbs::SELECT))
}

/// The query panel's hand-written expression.
///
/// On SQL it is a raw `WHERE` fragment, and `validate_raw_where` says in so
/// many words it is not a security boundary: `id IN (SELECT … FROM payroll)`
/// reads any relation, and a function call can write. So a browse that carries
/// one is free SQL. On MongoDB it is a filter document over the same
/// collection, with no way to reach another, and is left alone.
pub(crate) fn raw_filter(
    state: &AppState,
    connection_id: &str,
    filter: &TableFilter,
) -> AppResult<()> {
    let has_raw = filter.raw.as_deref().is_some_and(|r| !r.trim().is_empty());
    if !has_raw || matches!(state.pool_for(connection_id), Ok(DbPool::Mongo(_))) {
        return Ok(());
    }
    free_read(state, connection_id)
}

/// A MongoDB pipeline over `source`.
///
/// It reads `source` — and, through `$lookup` / `$unionWith` / `$graphLookup`,
/// any other collection it names, which a text scan of the pipeline cannot
/// check against the policy's relation globs any better than it can a SQL
/// query. So a pipeline that joins is free SQL (D3); one that does not is a
/// read of its source, and keeps working under a scoped rule. The scan is
/// deliberately naive: the stage name anywhere, a string literal included,
/// counts — the direction that refuses too much, never too little.
pub(crate) fn pipeline<'a>(
    state: &AppState,
    connection_id: &str,
    source: &str,
    bodies: impl IntoIterator<Item = &'a str>,
) -> AppResult<()> {
    read(state, connection_id, None, source)?;
    let joins = bodies.into_iter().any(|b| {
        ["$lookup", "$unionWith", "$graphLookup"]
            .iter()
            .any(|s| b.contains(s))
    });
    if joins {
        free_read(state, connection_id)?;
    }
    Ok(())
}

/// Pulse, sessions, users and privileges.
pub(crate) fn monitor(state: &AppState, connection_id: &str) -> AppResult<()> {
    require(state, connection_id, Need::Monitor)
}

/// Writing a relation's rows out to a file.
pub(crate) fn export(
    state: &AppState,
    connection_id: &str,
    schema: Option<&str>,
    name: &str,
) -> AppResult<()> {
    require(
        state,
        connection_id,
        Need::Export {
            schema: schema.map(str::to_string),
            name: name.to_string(),
        },
    )
}

/// Creating or dropping a database, or a MongoDB collection in one.
pub(crate) fn database_ddl(state: &AppState, connection_id: &str, database: &str) -> AppResult<()> {
    require(
        state,
        connection_id,
        Need::DatabaseDdl(database.to_string()),
    )
}

/// The databases a person may see.
pub(crate) fn databases(
    state: &AppState,
    connection_id: &str,
    list: Vec<DatabaseInfo>,
) -> Vec<DatabaseInfo> {
    crate::policy::filter_databases_for(state, connection_id, list, Subject::Human)
}

/// The tables and views a person may see.
pub(crate) fn tables(
    state: &AppState,
    connection_id: &str,
    list: Vec<TableInfo>,
) -> Vec<TableInfo> {
    crate::policy::filter_tables_for(state, connection_id, list, Subject::Human)
}

/// Whether a person may see one relation — for results that name relations
/// other than the one asked about (foreign keys pointing in).
pub(crate) fn visible(
    state: &AppState,
    connection_id: &str,
    schema: Option<&str>,
    name: &str,
) -> bool {
    read(state, connection_id, schema, name).is_ok()
}

/// What every registered command asks of the policy, by category — read by
/// the completeness test below, which fails when a command is registered in
/// `lib.rs` without an entry here, and when an entry that touches a database
/// does not call into this module.
///
/// Categories: `endpoint`, `database`, `list` (results filtered), `read`,
/// `free_sql`, `insert`, `update`, `delete`, `ddl`, `export`, `monitor`;
/// `ai` for the AI panel's commands, which reach a database only through
/// `bridge::exec::execute` and are bound there (`policy::enforce`); and `none`
/// for commands that touch no database — preferences, profiles, windows, the
/// JSON Schema library, themes, the policy's own read-outs. `test_connection`
/// is `none` on purpose: it opens a throwaway pool to run `SELECT 1` against a
/// profile being edited, reads nothing, and refusing it would stop a person
/// finding out their password is wrong.
#[cfg(test)]
pub(crate) const HUMAN_POLICY: &[(&str, &str)] = &[
    ("connection::connect", "endpoint"),
    ("schema::server_version", "endpoint"),
    ("connection::open_database_view", "database"),
    ("schema::list_databases", "list"),
    ("schema::get_database_sizes", "list"),
    ("schema::list_tables", "list"),
    ("schema::get_table_stats", "list"),
    ("schema::list_columns", "read"),
    ("schema::list_indexes", "read"),
    ("schema::list_referencing_foreign_keys", "read"),
    ("structure::get_table_structure", "read"),
    ("structure::get_table_create_ddl", "read"),
    ("structure::preview_structure_change", "read"),
    ("view::get_view_definition", "read"),
    ("query::fetch_table_data", "read"),
    ("query::count_table_rows", "read"),
    ("query::explain_table_query", "read"),
    ("query::describe_table_query", "read"),
    ("query::fetch_fk_options", "read"),
    ("bulk::preview_bulk_update", "read"),
    ("aggregation::get_mongo_view", "read"),
    ("aggregation::run_mongo_pipeline", "read"),
    ("aggregation::preview_mongo_stages", "read"),
    ("mongo_indexes::list_mongo_indexes", "read"),
    ("view::preview_view_change", "read"),
    ("query::execute_query", "free_sql"),
    ("query::execute_batch", "free_sql"),
    // Signed in as the connection, and anything goes inside it.
    ("terminal::terminal_open_mongosh", "free_sql"),
    ("query::insert_row", "insert"),
    ("query::insert_documents", "insert"),
    ("insert::insert_rows", "insert"),
    ("mongo::import_collection", "insert"),
    ("query::update_cell", "update"),
    ("query::unset_field", "update"),
    ("bulk::apply_bulk_update", "update"),
    ("query::delete_rows", "delete"),
    ("schema::create_database", "ddl"),
    ("schema::drop_database", "ddl"),
    ("schema::create_collection", "ddl"),
    ("schema::drop_table", "ddl"),
    ("schema::empty_table", "ddl"),
    ("schema::rename_table", "ddl"),
    ("structure::apply_structure_change", "ddl"),
    ("view::apply_view_change", "ddl"),
    ("view::rename_view", "ddl"),
    ("view::drop_view", "ddl"),
    ("aggregation::save_mongo_view", "ddl"),
    ("mongo_indexes::create_mongo_index", "ddl"),
    ("mongo_indexes::recreate_mongo_index", "ddl"),
    ("mongo_indexes::drop_mongo_index", "ddl"),
    ("mongo_indexes::set_mongo_index_hidden", "ddl"),
    ("dump::export_databases", "export"),
    ("dump::export_table", "export"),
    ("dump::export_table_rows", "export"),
    ("mongo::export_collection", "export"),
    ("pulse::pulse_health", "monitor"),
    ("pulse::pulse_top_queries", "monitor"),
    ("pulse::pulse_storage", "monitor"),
    ("pulse::pulse_sessions", "monitor"),
    ("pulse::pulse_index_usage", "monitor"),
    ("pulse::pulse_explain", "monitor"),
    ("pulse::pulse_history", "monitor"),
    ("schema::list_users", "monitor"),
    ("schema::list_privileges", "monitor"),
    ("ai::ai_send", "ai"),
    ("ai::ai_task", "ai"),
    ("aggregation::format_mongo_pipeline", "none"),
    ("ai::ai_cancel", "none"),
    ("ai::ai_clear_key", "none"),
    ("ai::ai_has_key", "none"),
    ("ai::ai_models", "none"),
    ("ai::ai_probe", "none"),
    ("ai::ai_set_key", "none"),
    ("app::get_app_flavor", "none"),
    ("connection::active_connections", "none"),
    ("connection::analyze_import_file", "none"),
    ("connection::connection_pool_stats", "none"),
    ("connection::delete_profile", "none"),
    ("connection::delete_profiles", "none"),
    ("connection::disconnect", "none"),
    ("connection::export_profiles", "none"),
    ("connection::forget_host_key", "none"),
    ("connection::get_host_key", "none"),
    ("connection::get_startup_args", "none"),
    ("connection::import_profiles", "none"),
    ("connection::edited_connections", "none"),
    ("connection::list_profiles", "none"),
    ("connection::open_new_window", "none"),
    ("connection::take_window_environment_intent", "none"),
    ("connection::open_pulse_window", "none"),
    ("connection::open_tab_window", "none"),
    ("connection::release_idle_pools", "none"),
    ("connection::save_profile", "none"),
    ("connection::set_ai_enabled", "none"),
    ("connection::set_ai_notes", "none"),
    ("connection::set_ai_rows_allowed", "none"),
    ("connection::set_mcp_exposed", "none"),
    ("connection::set_mcp_write_policy", "none"),
    ("connection::set_pulse_enabled", "none"),
    ("connection::take_detached_tab_intent", "none"),
    ("connection::take_pending_cli_connect", "none"),
    ("connection::take_pulse_window_intent", "none"),
    ("connection::take_window_startup_intent", "none"),
    ("connection::test_connection", "none"),
    ("dump::read_image_data_url", "none"),
    ("dump::read_text_file", "none"),
    ("dump::write_text_file", "none"),
    ("feedback::clear_github_pat", "none"),
    ("feedback::get_diagnostics", "none"),
    ("feedback::has_github_pat", "none"),
    ("feedback::mailto_report_url", "none"),
    ("feedback::set_github_pat", "none"),
    ("feedback::submit_issue", "none"),
    ("json_schemas::analyze_json_schema_import", "none"),
    ("json_schemas::delete_json_schema", "none"),
    ("json_schemas::delete_json_schema_binding", "none"),
    ("json_schemas::explain_json_schema_bindings", "none"),
    ("json_schemas::export_json_schemas", "none"),
    ("json_schemas::import_json_schemas", "none"),
    ("json_schemas::infer_json_schema", "none"),
    ("json_schemas::list_json_schemas", "none"),
    ("json_schemas::rename_json_schema_binding_column", "none"),
    ("json_schemas::reorder_json_schema_bindings", "none"),
    ("json_schemas::resolve_json_schema", "none"),
    ("json_schemas::resolve_json_schemas_for_columns", "none"),
    ("json_schemas::save_json_schema", "none"),
    ("json_schemas::save_json_schema_binding", "none"),
    ("mcp::get_claude_code_registration", "none"),
    ("mcp::get_mcp_connector_info", "none"),
    ("mcp::is_mcp_sidecar_running", "none"),
    ("mcp::register_with_claude_code", "none"),
    ("mcp::update_claude_code_registration", "none"),
    ("origin_doc::create_origin_document", "none"),
    ("origin_doc::list_publishable_environments", "none"),
    ("origin_doc::open_origin_document", "none"),
    ("origin_doc::preview_origin_publish", "none"),
    ("origin_doc::probe_origin_writable", "none"),
    ("origin_doc::republish_profile_to_origin", "none"),
    ("origin_doc::save_origin_document", "none"),
    ("origins::add_origin", "none"),
    ("origins::clear_secret_override", "none"),
    ("origins::list_origins", "none"),
    ("origins::peek_origin_file", "none"),
    ("origins::remove_origin", "none"),
    ("origins::set_secret_override", "none"),
    // A person's own user and password: local, and no database is touched.
    ("credentials::personal_credentials", "none"),
    ("credentials::set_personal_credentials", "none"),
    ("credentials::clear_personal_credentials", "none"),
    ("credentials::remember_password", "none"),
    ("origins::sync_origin", "none"),
    ("origins::update_origin", "none"),
    ("policy::policy_access", "none"),
    ("policy::policy_relation_access", "none"),
    ("policy::policy_status", "none"),
    // Reads the server's catalog to write grants: the permission that already
    // shows users and privileges.
    ("policy::policy_generate_grants", "monitor"),
    // The policy editor: no database is touched, and who may save is decided
    // by a real write to the share (`policy::editor`), not by the policy.
    ("policy::policy_open_for_edit", "none"),
    ("policy::policy_validate", "none"),
    ("policy::policy_save", "none"),
    ("policy::policy_create", "none"),
    ("prefs::adopt_environment", "none"),
    ("prefs::analyze_environment_import", "none"),
    ("prefs::clear_tab_state", "none"),
    ("prefs::delete_environment", "none"),
    ("prefs::export_environments", "none"),
    ("prefs::find_environments_for_connection", "none"),
    ("prefs::get_launch_state", "none"),
    ("prefs::get_preferences", "none"),
    ("prefs::get_tab_state", "none"),
    ("prefs::get_workspace_layout", "none"),
    ("prefs::import_environment", "none"),
    ("prefs::list_environments", "none"),
    ("prefs::reorder_environments", "none"),
    ("prefs::save_environment", "none"),
    ("prefs::save_launch_state", "none"),
    ("prefs::save_tab_state", "none"),
    ("prefs::save_workspace_layout", "none"),
    ("prefs::set_active_environment", "none"),
    ("prefs::set_environment_local_overrides", "none"),
    ("prefs::update_preferences", "none"),
    ("themes::check_theme_updates", "none"),
    ("themes::forget_installed_theme", "none"),
    ("themes::install_registry_theme", "none"),
    ("themes::list_installed_themes", "none"),
    ("themes::mark_theme_palette_edited", "none"),
    ("themes::read_vsix", "none"),
    ("themes::save_installed_theme", "none"),
    ("themes::search_registry_themes", "none"),
    // The user's own shell, no credential handed to it, and the plumbing of a
    // session already opened (`terminal_open_mongosh` above is the guarded
    // way in).
    ("terminal::terminal_environment", "none"),
    ("terminal::terminal_open_shell", "none"),
    ("terminal::terminal_write", "none"),
    ("terminal::terminal_resize", "none"),
    ("terminal::terminal_close", "none"),
    ("terminal::terminal_close_window_sessions", "none"),
    // Fetching `mongosh` itself (ADR #109): a download from MongoDB's own host
    // into the app's data directory. No database, no credential — the guarded
    // step is still opening a session as a connection.
    ("terminal::terminal_mongosh_latest_version", "none"),
    ("terminal::terminal_mongosh_download", "none"),
    ("terminal::terminal_mongosh_cancel_download", "none"),
    ("updater::get_auto_update_status", "none"),
    ("updater::note_update_check", "none"),
];

#[cfg(test)]
mod tests {
    use super::HUMAN_POLICY;
    use std::collections::BTreeSet;
    use std::path::Path;

    fn source(rel: &str) -> String {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    /// `module::name` for every command in `lib.rs`'s `generate_handler!`.
    fn registered() -> BTreeSet<String> {
        let lib = source("src/lib.rs");
        let start = lib
            .find("generate_handler![")
            .expect("generate_handler! in lib.rs");
        let end = start + lib[start..].find("])").expect("end of generate_handler!");
        lib[start..end]
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with("//"))
            .filter_map(|l| l.strip_prefix("commands::"))
            .map(|l| l.trim_end_matches(',').to_string())
            .collect()
    }

    #[test]
    fn every_registered_command_says_what_the_policy_asks_of_it() {
        let registered = registered();
        let classified: BTreeSet<String> = HUMAN_POLICY
            .iter()
            .map(|(name, _)| name.to_string())
            .collect();
        let unclassified: Vec<_> = registered.difference(&classified).collect();
        assert!(
            unclassified.is_empty(),
            "new commands need an entry in guard::HUMAN_POLICY (and, if they touch a \
             database, a guard call): {unclassified:?}"
        );
        let stale: Vec<_> = classified.difference(&registered).collect();
        assert!(
            stale.is_empty(),
            "entries for commands no longer registered: {stale:?}"
        );
        assert_eq!(
            classified.len(),
            HUMAN_POLICY.len(),
            "a command is listed twice"
        );
    }

    #[test]
    fn every_command_that_touches_a_database_calls_the_guard() {
        for (name, category) in HUMAN_POLICY {
            if matches!(*category, "none" | "ai") {
                continue;
            }
            let (module, function) = name.split_once("::").unwrap();
            let file = source(&format!("src/commands/{module}.rs"));
            let body = ["pub async fn ", "pub fn "]
                .iter()
                .find_map(|head| file.find(&format!("{head}{function}(")))
                .map(|at| {
                    let end = file[at..].find("\n}\n").map_or(file.len(), |e| at + e);
                    &file[at..end]
                })
                .unwrap_or_else(|| panic!("{name}: function not found"));
            assert!(
                body.contains("crate::commands::guard::"),
                "{name} is classified `{category}` but never calls commands::guard"
            );
        }
    }

    use super::*;
    use crate::policy::PolicyState;
    use crate::state::{ConnectionProfile, Driver};
    use crate::testkit;
    use std::sync::Arc;

    /// A person in `sales`, who may read and insert into `invoices` and
    /// `v_invoice_*` in `billing` — nothing else, no export, no monitor.
    fn managed_state() -> Option<AppState> {
        let user = crate::policy::current_user();
        if user.is_empty() {
            return None;
        }
        let text = format!(
            r#"{{
                "version": 1, "defaultRole": "none",
                "users": {{ {user:?}: "sales" }},
                "roles": {{
                    "none": {{}},
                    "sales": {{ "rules": [{{
                        "endpoint": {{ "host": "erp.local" }},
                        "databases": ["billing"],
                        "relations": {{ "allow": ["invoices", "v_invoice_*"] }},
                        "human": ["select", "insert"],
                        "ai": ["select"]
                    }}] }}
                }}
            }}"#
        );
        let (doc, _) = crate::policy::model::PolicyDoc::parse(&text).unwrap();
        let state = AppState::new();
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
            ..testkit::profile("erp")
        });
        Some(state)
    }

    fn filter(raw: Option<&str>) -> TableFilter {
        TableFilter {
            filters: Vec::new(),
            search: None,
            search_columns: Vec::new(),
            raw: raw.map(str::to_string),
        }
    }

    #[test]
    fn an_unmanaged_machine_is_guarded_by_nothing() {
        let state = AppState::new();
        assert!(read(&state, "any", None, "anything").is_ok());
        assert!(free_sql(&state, "any", "DELETE FROM t WHERE id = 1").is_ok());
        assert!(raw_filter(&state, "any", &filter(Some("id IN (SELECT 1)"))).is_ok());
        assert!(monitor(&state, "any").is_ok());
    }

    #[test]
    fn a_person_reads_and_writes_what_their_role_allows() {
        let Some(state) = managed_state() else { return };
        assert!(read(&state, "erp", None, "invoices").is_ok());
        assert!(relation(&state, "erp", None, "invoices", Verbs::INSERT).is_ok());
        assert!(relation(&state, "erp", None, "invoices", Verbs::DELETE).is_err());
        assert!(read(&state, "erp", None, "payroll").is_err());
        assert!(export(&state, "erp", None, "invoices").is_err());
        assert!(monitor(&state, "erp").is_err());
        assert!(database_ddl(&state, "erp", "billing").is_err());
    }

    #[test]
    fn the_query_panel_expression_is_free_sql_on_sql() {
        let Some(state) = managed_state() else { return };
        // No expression: an ordinary browse, allowed.
        assert!(raw_filter(&state, "erp", &filter(None)).is_ok());
        assert!(raw_filter(&state, "erp", &filter(Some("   "))).is_ok());
        // With one: it could read `payroll` through a subquery, so under a
        // rule that names relations it is refused.
        let err = raw_filter(
            &state,
            "erp",
            &filter(Some("id IN (SELECT id FROM payroll)")),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("free-form queries are disabled"), "{err}");
    }

    #[test]
    fn a_pipeline_is_free_sql_only_when_it_joins() {
        let Some(state) = managed_state() else { return };
        assert!(pipeline(&state, "erp", "invoices", ["{ $match: { a: 1 } }"]).is_ok());
        assert!(pipeline(
            &state,
            "erp",
            "invoices",
            ["{ $lookup: { from: \"payroll\", as: \"p\" } }"]
        )
        .is_err());
        // Its source has to be readable either way.
        assert!(pipeline(&state, "erp", "payroll", ["{ $match: {} }"]).is_err());
    }

    #[test]
    fn listings_only_name_what_a_person_may_see() {
        let Some(state) = managed_state() else { return };
        let t = |name: &str| TableInfo {
            schema: "billing".into(),
            name: name.into(),
            kind: "table".into(),
            row_count: None,
            size_bytes: None,
        };
        let kept = tables(
            &state,
            "erp",
            vec![t("invoices"), t("v_invoice_totals"), t("payroll")],
        );
        let names: Vec<_> = kept.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["invoices", "v_invoice_totals"]);
        let d = |name: &str| DatabaseInfo { name: name.into() };
        let kept = databases(&state, "erp", vec![d("billing"), d("hr")]);
        assert_eq!(kept.len(), 1);
        assert!(!visible(&state, "erp", None, "payroll"));
    }

    #[test]
    fn a_broken_policy_leaves_a_person_nothing_to_read() {
        let state = AppState::new();
        state.profiles.write().push(testkit::profile("any"));
        *state.policy.write() = PolicyState::Broken {
            source: "share".into(),
            error: "cannot read".into(),
        };
        assert!(endpoint(&state, "any").is_err());
        assert!(read(&state, "any", None, "t").is_err());
        let d = DatabaseInfo { name: "x".into() };
        assert!(databases(&state, "any", vec![d]).is_empty());
    }
}
