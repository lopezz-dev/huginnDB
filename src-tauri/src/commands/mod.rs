//! Tauri command handlers — the public surface the frontend invokes via
//! `invoke("name", { args })`.
//!
//! Modules here are organised by feature area and intentionally kept thin:
//! they validate arguments, look up state, and delegate the heavy lifting
//! to the [`crate::db`] / [`crate::keychain`] helpers.

pub mod aggregation;
pub mod ai;
pub mod app;
pub mod bulk;
pub mod connection;
pub mod credentials;
pub mod dump;
pub mod feedback;
pub mod guard;
pub mod insert;
pub mod json_schemas;
pub mod mcp;
pub mod mongo;
pub mod mongo_indexes;
pub mod origin_doc;
pub mod origins;
pub mod paste;
pub mod policy;
pub mod prefs;
pub mod pulse;
pub mod query;
pub mod schema;
pub mod script;
pub mod structure;
pub mod terminal;
pub mod themes;
pub mod updater;
pub mod vault;
pub mod view;
pub mod write_batch;

use crate::log_bus::TauriSink;
use crate::state::AppState;
use tauri::AppHandle;

/// The prologue every connection-scoped Tauri command starts with: reopen the
/// `<parent>::db::<database>` pool if the idle reaper closed it, so the
/// `pool_for` lookup that follows sees the connection the tree is still showing
/// as open.
///
/// Forty-five commands across nine modules spelled out the same seven-line
/// [`connection::ensure_database_view`] call, differing only in which field
/// holds the id. Forgetting it is invisible until a
/// database view has been idle long enough to be reaped and the user clicks it,
/// at which point the command fails with `NotConnected` on a connection that is
/// genuinely still up — the exact false negative `ensure_database_view` exists
/// to remove. One call is one line now, and the `window` is taken whole rather
/// than pre-unwrapped to its label so a caller cannot pass the wrong one.
pub(crate) async fn ensure_view(
    app: &AppHandle,
    window: &tauri::Window,
    state: &AppState,
    connection_id: &str,
) {
    connection::ensure_database_view(app, state, Some(window.label()), connection_id).await;
}

/// [`ensure_view`], plus the [`TauriSink`] the statement-logging commands hand
/// to their `_inner` core.
///
/// Same prologue as the metadata commands, except these eight also feed the
/// Console panel. The sink is scoped to *this* window's label, which is what
/// keeps another window's Console from receiving these entries (gotcha #25);
/// building it here rather than at each call site is one less place for that
/// scoping to be dropped.
pub(crate) async fn entry_sink<'a>(
    app: &'a AppHandle,
    window: &tauri::Window,
    state: &AppState,
    connection_id: &str,
) -> TauriSink<'a> {
    ensure_view(app, window, state, connection_id).await;
    TauriSink::new(app, window.label())
}
