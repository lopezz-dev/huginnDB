//! HuginnDB — desktop database manager.
//!
//! The library crate hosts all of the Tauri command handlers and the
//! shared state they operate on. `main.rs` is a thin shim that calls
//! [`run`] so the same binary can be re-used in different bundling modes
//! (custom protocol, mobile, etc.).
//!
//! ### Module map
//!
//! * [`commands`] — public command surface exposed to the frontend via
//!   `invoke`. Each submodule maps to one feature area.
//! * [`db`] — database abstraction layer shared by all commands.
//! * [`keychain`] — OS-keychain integration for password storage.
//! * [`state`] — runtime state (active pools, saved profiles).
//! * [`store`] — on-disk persistence for non-sensitive profile metadata.
//! * [`error`] — common error type, serialised to the frontend.

/// The in-app AI assistant's backend: the read surface a model is described,
/// and the gates a tool call passes through. A second presentation layer over
/// [`bridge::protocol::BridgeRequest`], sharing the whole data path with the
/// headless MCP connector — see the module docs for the egress invariant and
/// the metadata/rows coupling rule.
mod ai;
mod app_identity;
mod bridge;
mod commands;
mod credentials;
mod db;
mod error;
pub mod json_schemas;
mod jump_list;
mod keepalive;
mod keychain;
mod log_bus;
/// Headless MCP (Model Context Protocol) connector. Compiled only under the
/// `mcp` feature (see `Cargo.toml`); the `huginndb-mcp` binary in
/// `src/bin/mcp.rs` is a thin shim over [`mcp::serve`]. Lives inside the lib
/// crate — not the binary crate — so it can reach the `pub(crate)` `_inner`
/// data-path functions the desktop commands share.
#[cfg(feature = "mcp")]
pub mod mcp;
mod mcp_launcher;
/// The document a shared origin publishes, as an editable draft. Pure model
/// only — no disk, no keychain; the I/O lives in `commands::origin_doc`.
mod origin_doc;
mod policy;
mod pool_reaper;
mod prefs;
mod pulse;
mod ssh_known_hosts;
mod state;
mod state_file;
mod store;
mod tab_state;
mod terminal;
#[cfg(test)]
mod testkit;
mod themes;
mod transfer;
mod updater;
mod window_chrome;

use state::{AppState, StartupArgs};

/// Parse the process's own command-line arguments into [`StartupArgs`].
///
/// Thin wrapper over [`parse_cli_args`] for the cold-start path. We
/// intentionally avoid pulling in `clap` for the small set of flags we
/// support. Unknown flags are ignored silently so external launchers can pass
/// extra metadata without breaking the app.
fn parse_startup_args() -> StartupArgs {
    let argv: Vec<String> = std::env::args().collect();
    parse_cli_args(&argv)
}

/// Parse a full `argv` (program name at `argv[0]`) into [`StartupArgs`] and
/// log a redacted summary.
///
/// Shared by the cold-start path ([`parse_startup_args`]) and the
/// single-instance callback, which receives the *second* launch's argv with
/// the same shape (`argv[0]` is the executable). Both must `skip(1)` so the
/// program name is never mistaken for a flag value.
fn parse_cli_args(argv: &[String]) -> StartupArgs {
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let result = parse_args(&args);
    log_parsed_args(&result);
    result
}

/// Echo what we parsed to stderr when any flag was supplied. The user
/// typically launches from a terminal, so this is the quickest way to confirm
/// the args actually reached the app (and were spelled right) without opening
/// devtools. The password is intentionally not logged.
fn log_parsed_args(result: &StartupArgs) {
    let has_any = result.connect_profile.is_some()
        || result.adhoc_host.is_some()
        || result.adhoc_database.is_some()
        || result.adhoc_username.is_some()
        || result.adhoc_driver.is_some()
        || result.adhoc_connection_string.is_some();
    if has_any {
        eprintln!(
            "[cli] startup args: connect_profile={:?} by_id={} host={:?} port={:?} db={:?} user={:?} driver={:?} name={:?} password={}",
            result.connect_profile,
            result.connect_by_id,
            result.adhoc_host,
            result.adhoc_port,
            result.adhoc_database,
            result.adhoc_username,
            result.adhoc_driver,
            result.adhoc_name,
            if result.adhoc_password.is_some() { "<provided>" } else { "<none>" },
        );
    }
}

/// Pure arg-parser over an explicit slice (so it's unit-testable without
/// touching the process environment).
fn parse_args(args: &[String]) -> StartupArgs {
    let mut result = StartupArgs::default();
    let mut iter = args.iter().peekable();
    while let Some(raw) = iter.next() {
        // Accept both `--flag value` and `--flag=value`. We split on the FIRST
        // `=` so a value that itself contains `=` (e.g. a password) survives;
        // when there's no inline value we fall back to the next token. Without
        // this, `--password=secret` never matched `"--password"` and the
        // password was silently dropped.
        let (flag, inline) = match raw.split_once('=') {
            Some((f, v)) => (f, Some(v.to_string())),
            None => (raw.as_str(), None),
        };
        // Resolve a value: prefer the inline `=value`, else consume the next
        // token. Each arm calls this at most once, so moving `inline` is fine.
        let value = move |iter: &mut std::iter::Peekable<std::slice::Iter<'_, String>>| {
            inline.or_else(|| iter.next().cloned())
        };
        match flag {
            "--connect-profile" => {
                result.connect_profile = value(&mut iter);
            }
            "--connect-profile-id" => {
                result.connect_profile = value(&mut iter);
                result.connect_by_id = true;
            }
            "--host" => {
                result.adhoc_host = value(&mut iter);
            }
            "--port" => {
                result.adhoc_port = value(&mut iter).and_then(|v| v.parse().ok());
            }
            "--database" => {
                result.adhoc_database = value(&mut iter);
            }
            // `--user` is an alias for `--username` — most CLI database tools
            // (psql, mysql) spell it `--user`/`-u`, so we accept both.
            "--username" | "--user" => {
                result.adhoc_username = value(&mut iter);
            }
            // The password is opt-in via the CLI and lives only in memory for
            // this launch — it is passed straight to `connect` and never
            // written to the OS keychain. Works for both `--connect-profile`
            // (overrides the stored password) and ad-hoc connections.
            "--password" | "--pass" => {
                result.adhoc_password = value(&mut iter);
            }
            "--driver" => {
                result.adhoc_driver = value(&mut iter);
            }
            // Connection URI for an ad-hoc launch. The primary path for MongoDB
            // (`mongodb://…` / `mongodb+srv://…`); implies `--driver mongodb`
            // when no driver is given.
            "--connection-string" | "--uri" => {
                result.adhoc_connection_string = value(&mut iter);
            }
            // MongoDB authSource for the URI-less ad-hoc path (`--host … \
            // --auth-source admin`). Ignored when a full `--uri` is supplied,
            // which carries its own `?authSource=…`.
            "--auth-source" => {
                result.adhoc_auth_source = value(&mut iter);
            }
            "--name" => {
                result.adhoc_name = value(&mut iter);
            }
            _ => {}
        }
    }
    result
}

/// Does this parsed arg set carry a connection intent (vs. just flags we
/// ignore)? Mirrors the frontend's own check in `App.tsx`.
fn has_connection_intent(args: &StartupArgs) -> bool {
    args.connect_profile.is_some()
        || args.adhoc_host.is_some()
        || args.adhoc_connection_string.is_some()
}

/// Tauri event carrying a *second* launch's connection intent to the running
/// instance. The frontend listens on this (see `cli-connect-bridge.ts`) and
/// asks the user whether to open it in a new or the active workspace.
#[cfg(desktop)]
const CLI_CONNECT_EVENT: &str = "huginndb://cli-connect";

/// Single-instance callback: a second `huginndb …` launch landed while this
/// process owns the lock. Focus the existing window and, if the new argv
/// carries a connection, buffer it and emit [`CLI_CONNECT_EVENT`] so the
/// frontend can route it into a workspace. A launch with no connection flags
/// just brings the window to the front.
#[cfg(desktop)]
fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    use tauri::{Emitter, Manager};

    // Bring the existing window forward. Prefer the labelled "main" window;
    // fall back to whatever window exists so a config change to the label
    // can't silently break focus.
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
    {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    // The Jump List's "New window" task. On its own flag rather than a field of
    // `StartupArgs`, which is the frontend's DTO and has nothing to say about
    // it; a cold start never gets here and just opens the main window.
    if argv.iter().skip(1).any(|a| a == jump_list::NEW_WINDOW_FLAG) {
        let app = app.clone();
        // `open_new_window` is async on purpose (gotcha #19: building a
        // `WebviewWindow` from a synchronous context deadlocks WebView2).
        tauri::async_runtime::spawn(async move {
            if let Err(e) = commands::connection::open_new_window(app, None, None).await {
                eprintln!("[jump-list] could not open a new window: {e}");
            }
        });
        return;
    }

    let args = parse_cli_args(&argv);
    if !has_connection_intent(&args) {
        return;
    }
    // Buffer before emitting so a launch that races the window's boot is not
    // lost (events are not replayed for late subscribers). The frontend
    // drains this on bridge mount and then relies on the live event.
    *app.state::<AppState>().pending_cli_connect.write() = Some(args.clone());
    let _ = app.emit(CLI_CONNECT_EVENT, args);
}

/// Entry point invoked from `main.rs`.
///
/// Initialises the application state, registers the Tauri dialog plugin
/// (used for SQLite file pickers), and wires up every command handler.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `HuginnDB.AppImage --mcp` becomes the MCP connector before anything else
    // runs, stdout included — see `mcp_launcher` for why an AppImage is
    // registered that way.
    #[cfg(unix)]
    mcp_launcher::run_if_requested();
    // `huginndb.exe --update` & co. run with no window and never reach the
    // Builder below — see `updater::headless` for why it has to be this early.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Some(request) = updater::request_from(&args) {
            std::process::exit(updater::headless::run(request, context));
        }
    }
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // The single-instance plugin MUST be registered before any other so its
    // argv-forwarding lock is installed first. Desktop-only: there is no
    // second-launch concept on mobile.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_second_instance(app, argv);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        // Remembers the main window's position, size, and maximised state
        // across launches. The plugin writes its own JSON blob alongside our
        // `prefs.json` / `tab_state.json` in the app config dir. Everything
        // but decorations: those are `window_chrome`'s to decide, not a
        // remembered state. Only the main window: the secondary ones are
        // labelled with a fresh uuid each time, so an entry for one could
        // never be restored. The prune plugin must come first — it clears
        // what older builds saved before this one loads the file (see
        // `window_chrome`).
        .plugin(window_chrome::forget_unremembered_windows())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_chrome::window_state_flags())
                .with_filter(window_chrome::remembers)
                .build(),
        )
        // Auto-update infrastructure. The frontend calls `check()` on
        // launch (see `src/stores/update.ts`); endpoints and the public
        // verification key live in `tauri.conf.json`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Lets the frontend relaunch the app after installing an update.
        .plugin(tauri_plugin_process::init())
        // Opens external URLs in the OS default browser. The in-app issue
        // reporter relies on this: `window.open` is a no-op in the WebView.
        .plugin(tauri_plugin_opener::init())
        // The OS clipboard, read and written natively rather than through the
        // WebView's Clipboard API — see ADR #63 and the capability, which
        // grants only the two text commands.
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new_with_args(parse_startup_args()))
        // The terminal panel's PTY sessions, across every window.
        .manage(terminal::TerminalRegistry::default())
        // The one `mongosh` download that may run at a time.
        .manage(terminal::download::Installer::default())
        // Background eviction of idle per-database pools. Started here rather
        // than lazily on first connect so the sweep also covers pools left
        // behind by a connection that was opened and closed again.
        .setup(|app| {
            // The config declares the main window undecorated; macOS takes its
            // native frame back before the window is ever painted.
            window_chrome::adapt_main_window(app);
            // Before anything can reach a database for an AI: an inline
            // policy is in force from here, one on a share blocks until its
            // first read (`policy::install`).
            {
                use tauri::{Emitter, Manager};
                // Every window re-reads what it may offer when the policy
                // changes, rather than keeping yesterday's locks until reopened.
                let handle = app.handle().clone();
                policy::install(
                    &app.state::<AppState>().policy,
                    Some(Box::new(move || {
                        let _ = handle.emit(policy::CHANGED_EVENT, ());
                    })),
                );
            }
            // The silent updater's schedule follows the preference; this only
            // fills in what is missing (an installer hook that failed, a task
            // someone deleted). `schtasks` blocks, so off the async runtime.
            {
                use tauri::Manager;
                let product = app.config().product_name.clone().unwrap_or_default();
                let enabled = app.state::<AppState>().prefs.read().updates.auto_install;
                tauri::async_runtime::spawn_blocking(move || {
                    updater::reconcile_for_app(&product, enabled, false);
                });
            }
            // Rebuilt from what is already on disk, then kept current by the
            // events it listens to (see `jump_list`).
            jump_list::install(app.handle());
            pool_reaper::spawn(app.handle().clone());
            // Off in effect (a no-op tick) unless some profile has
            // `pulse_enabled` set, so this costs nothing on a fresh install.
            pulse::sampler::spawn(app.handle().clone());
            // The MCP bridge is off unless the user turned it on; `reconcile`
            // is a no-op in that case. Spawned rather than awaited so a
            // filesystem hiccup writing the discovery file can't delay the
            // window appearing.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                bridge::server::reconcile(&handle).await;
            });
            Ok(())
        })
        // The other half of `WINDOW_LIST_CHANGED_EVENT`: `open_new_window` /
        // `open_tab_window` / `open_pulse_window` emit it on creation, this
        // catches every window's destruction (main window included, so
        // closing back down to one window hides the last badge too). A
        // global handler rather than one registered per window at creation
        // time — the main window is never created by our own code, so there
        // is no single call site to attach it from.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::{Emitter, Manager};
                let _ = window
                    .app_handle()
                    .emit(commands::connection::WINDOW_LIST_CHANGED_EVENT, ());
                // And the connections only this window was using go with it —
                // see `ActivePool::holders`. Spawned: closing awaits the
                // server, and this handler runs on the event loop.
                // Its terminals too: no other window can show them.
                window
                    .state::<terminal::TerminalRegistry>()
                    .close_window(window.label());
                let app = window.app_handle().clone();
                let label = window.label().to_string();
                tauri::async_runtime::spawn(async move {
                    commands::connection::release_window(&app, &label).await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::edited_connections,
            commands::policy::policy_status,
            commands::policy::policy_access,
            commands::policy::policy_relation_access,
            commands::policy::policy_generate_grants,
            commands::policy::policy_open_for_edit,
            commands::policy::policy_validate,
            commands::policy::policy_save,
            commands::policy::policy_create,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::delete_profiles,
            commands::connection::set_mcp_write_policy,
            commands::connection::set_pulse_enabled,
            commands::connection::set_mcp_exposed,
            commands::connection::set_ai_enabled,
            commands::connection::set_ai_rows_allowed,
            commands::connection::set_ai_notes,
            commands::ai::ai_probe,
            commands::ai::ai_models,
            commands::ai::ai_send,
            commands::ai::ai_task,
            commands::ai::ai_cancel,
            commands::ai::ai_set_key,
            commands::ai::ai_has_key,
            commands::ai::ai_clear_key,
            commands::connection::test_connection,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::active_connections,
            commands::connection::connection_pool_stats,
            commands::connection::release_idle_pools,
            commands::connection::open_database_view,
            commands::connection::forget_host_key,
            commands::connection::get_host_key,
            commands::connection::analyze_import_file,
            commands::connection::export_profiles,
            commands::connection::import_profiles,
            commands::connection::get_startup_args,
            commands::connection::take_pending_cli_connect,
            commands::connection::open_new_window,
            commands::connection::take_window_environment_intent,
            commands::connection::take_window_startup_intent,
            commands::connection::open_tab_window,
            commands::connection::take_detached_tab_intent,
            commands::connection::open_pulse_window,
            commands::connection::take_pulse_window_intent,
            commands::schema::list_databases,
            commands::schema::get_database_sizes,
            commands::schema::get_table_stats,
            commands::schema::create_database,
            commands::schema::drop_database,
            commands::schema::create_collection,
            commands::schema::list_tables,
            commands::schema::list_columns,
            commands::schema::list_indexes,
            commands::schema::drop_table,
            commands::schema::list_referencing_foreign_keys,
            commands::schema::empty_table,
            commands::schema::rename_table,
            commands::schema::server_version,
            commands::schema::list_users,
            commands::schema::list_privileges,
            commands::pulse::pulse_health,
            commands::pulse::pulse_top_queries,
            commands::pulse::pulse_storage,
            commands::pulse::pulse_explain,
            commands::pulse::pulse_history,
            commands::pulse::pulse_sessions,
            commands::pulse::pulse_index_usage,
            commands::structure::get_table_structure,
            commands::structure::get_table_create_ddl,
            commands::structure::preview_structure_change,
            commands::structure::apply_structure_change,
            commands::themes::read_vsix,
            commands::themes::search_registry_themes,
            commands::themes::install_registry_theme,
            commands::themes::list_installed_themes,
            commands::themes::save_installed_theme,
            commands::themes::forget_installed_theme,
            commands::themes::mark_theme_palette_edited,
            commands::themes::check_theme_updates,
            commands::view::get_view_definition,
            commands::view::preview_view_change,
            commands::view::apply_view_change,
            commands::view::rename_view,
            commands::view::drop_view,
            commands::dump::export_databases,
            commands::dump::read_text_file,
            commands::dump::read_image_data_url,
            commands::dump::write_text_file,
            commands::dump::export_table,
            commands::dump::export_table_rows,
            commands::mongo::export_collection,
            commands::mongo::import_collection,
            commands::aggregation::format_mongo_pipeline,
            commands::aggregation::run_mongo_pipeline,
            commands::aggregation::preview_mongo_stages,
            commands::aggregation::get_mongo_view,
            commands::aggregation::save_mongo_view,
            commands::mongo_indexes::list_mongo_indexes,
            commands::mongo_indexes::create_mongo_index,
            commands::mongo_indexes::recreate_mongo_index,
            commands::mongo_indexes::drop_mongo_index,
            commands::mongo_indexes::set_mongo_index_hidden,
            commands::bulk::preview_bulk_update,
            commands::bulk::apply_bulk_update,
            commands::query::execute_query,
            commands::query::execute_batch,
            commands::query::fetch_table_data,
            commands::query::count_table_rows,
            commands::query::describe_table_query,
            commands::query::explain_table_query,
            commands::query::update_cell,
            commands::query::unset_field,
            commands::query::delete_rows,
            commands::query::insert_row,
            commands::query::insert_documents,
            commands::insert::insert_rows,
            commands::paste::apply_paste,
            commands::query::fetch_fk_options,
            commands::prefs::get_preferences,
            commands::prefs::update_preferences,
            commands::prefs::get_tab_state,
            commands::prefs::save_tab_state,
            commands::prefs::clear_tab_state,
            commands::prefs::get_workspace_layout,
            commands::prefs::save_workspace_layout,
            commands::prefs::get_launch_state,
            commands::prefs::save_launch_state,
            commands::prefs::list_environments,
            commands::prefs::save_environment,
            commands::prefs::set_environment_local_overrides,
            commands::prefs::delete_environment,
            commands::prefs::adopt_environment,
            commands::prefs::set_active_environment,
            commands::prefs::reorder_environments,
            commands::prefs::find_environments_for_connection,
            commands::prefs::export_environments,
            commands::prefs::analyze_environment_import,
            commands::prefs::import_environment,
            commands::json_schemas::list_json_schemas,
            commands::json_schemas::save_json_schema,
            commands::json_schemas::delete_json_schema,
            commands::json_schemas::save_json_schema_binding,
            commands::json_schemas::delete_json_schema_binding,
            commands::json_schemas::reorder_json_schema_bindings,
            commands::json_schemas::rename_json_schema_binding_column,
            commands::json_schemas::resolve_json_schemas_for_columns,
            commands::json_schemas::resolve_json_schema,
            commands::json_schemas::explain_json_schema_bindings,
            commands::json_schemas::infer_json_schema,
            commands::json_schemas::export_json_schemas,
            commands::json_schemas::analyze_json_schema_import,
            commands::json_schemas::import_json_schemas,
            commands::origins::list_origins,
            commands::origins::add_origin,
            commands::origins::update_origin,
            commands::origins::remove_origin,
            commands::origins::peek_origin_file,
            commands::origins::sync_origin,
            commands::origins::set_secret_override,
            commands::origins::clear_secret_override,
            commands::credentials::personal_credentials,
            commands::credentials::set_personal_credentials,
            commands::credentials::clear_personal_credentials,
            commands::credentials::remember_password,
            commands::origin_doc::probe_origin_writable,
            commands::origin_doc::open_origin_document,
            commands::origin_doc::list_publishable_environments,
            commands::origin_doc::preview_origin_publish,
            commands::origin_doc::create_origin_document,
            commands::origin_doc::save_origin_document,
            commands::origin_doc::republish_profile_to_origin,
            commands::feedback::get_diagnostics,
            commands::feedback::set_github_pat,
            commands::feedback::has_github_pat,
            commands::feedback::clear_github_pat,
            commands::feedback::submit_issue,
            commands::feedback::mailto_report_url,
            commands::mcp::get_mcp_connector_info,
            commands::mcp::get_claude_code_registration,
            commands::mcp::register_with_claude_code,
            commands::mcp::update_claude_code_registration,
            commands::mcp::is_mcp_sidecar_running,
            commands::app::get_app_flavor,
            commands::updater::get_auto_update_status,
            commands::updater::note_update_check,
            commands::terminal::terminal_environment,
            commands::terminal::terminal_open_shell,
            commands::terminal::terminal_open_mongosh,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_close_window_sessions,
            commands::terminal::terminal_mongosh_latest_version,
            commands::terminal::terminal_mongosh_download,
            commands::terminal::terminal_mongosh_cancel_download,
            commands::terminal::terminal_mongosh_download_running,
        ])
        .build(context())
        .expect("error while building HuginnDB")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                // Close every pool the windows left open, rather than letting
                // the process exit drop them — see `close_all_pools`. Three
                // seconds at most: a quit that hangs on a dead server is worse
                // than the sessions that server will reap on its own.
                // Every shell and `mongosh` the panel started ends with the
                // app, rather than being orphaned to the OS.
                app.state::<terminal::TerminalRegistry>().close_all();
                let state = app.state::<state::AppState>();
                tauri::async_runtime::block_on(commands::connection::close_all_pools(
                    state.inner(),
                    std::time::Duration::from_secs(3),
                ));
            }
        });
}

/// The bundle's generated context, shared by the interface and the headless
/// updater so the embedded assets are expanded once.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(test)]
mod cli_tests {
    use super::parse_args;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn equals_form_is_accepted() {
        // The original bug: `--password=secret` (and friends) never matched
        // and the value was silently dropped.
        let a = parse_args(&v(&[
            "--host=db.example.com",
            "--port=46005",
            "--database=iMesPyme",
            "--username=ITB_industria",
            "--password=ITBCastellon",
        ]));
        assert_eq!(a.adhoc_host.as_deref(), Some("db.example.com"));
        assert_eq!(a.adhoc_port, Some(46005));
        assert_eq!(a.adhoc_database.as_deref(), Some("iMesPyme"));
        assert_eq!(a.adhoc_username.as_deref(), Some("ITB_industria"));
        assert_eq!(a.adhoc_password.as_deref(), Some("ITBCastellon"));
    }

    #[test]
    fn space_form_still_works_and_user_alias() {
        let a = parse_args(&v(&[
            "--host",
            "localhost",
            "--user",
            "root",
            "--pass",
            "hunter2",
        ]));
        assert_eq!(a.adhoc_host.as_deref(), Some("localhost"));
        assert_eq!(a.adhoc_username.as_deref(), Some("root"));
        assert_eq!(a.adhoc_password.as_deref(), Some("hunter2"));
    }

    #[test]
    fn password_may_contain_equals() {
        // split_once('=') must only split on the first '='.
        let a = parse_args(&v(&["--password=a=b=c"]));
        assert_eq!(a.adhoc_password.as_deref(), Some("a=b=c"));
    }

    #[test]
    fn connection_string_uri_flag() {
        // `--uri` is the MongoDB-friendly alias; the value (an SRV URI with its
        // own `=` query params) must survive the first-`=` split.
        let a = parse_args(&v(&[
            "--uri=mongodb+srv://u:p@cluster.mongodb.net/db?retryWrites=true",
        ]));
        assert_eq!(
            a.adhoc_connection_string.as_deref(),
            Some("mongodb+srv://u:p@cluster.mongodb.net/db?retryWrites=true")
        );
        // The long spelling and the space form work too.
        let b = parse_args(&v(&["--connection-string", "mongodb://localhost:27017"]));
        assert_eq!(
            b.adhoc_connection_string.as_deref(),
            Some("mongodb://localhost:27017")
        );
    }

    #[test]
    fn auth_source_flag() {
        let a = parse_args(&v(&[
            "--host=localhost",
            "--username=root",
            "--auth-source=admin",
        ]));
        assert_eq!(a.adhoc_auth_source.as_deref(), Some("admin"));
        // Space form too.
        let b = parse_args(&v(&["--auth-source", "myAuthDb"]));
        assert_eq!(b.adhoc_auth_source.as_deref(), Some("myAuthDb"));
    }

    #[test]
    fn connect_profile_id_sets_flag() {
        let a = parse_args(&v(&["--connect-profile-id=abc-123"]));
        assert_eq!(a.connect_profile.as_deref(), Some("abc-123"));
        assert!(a.connect_by_id);
    }
}
