//! The 60-second (by default) background tick that turns [`super::store`]
//! from an empty file into a history.
//!
//! Mirrors `pool_reaper.rs`'s shape deliberately — same
//! `tauri::async_runtime::spawn` (not `tokio::spawn`; `setup` is not inside a
//! tokio reactor context), same "read what's needed under a short lock,
//! release it, then do the actual I/O" discipline, same split between the
//! loop and a directly-testable `tick`. The two differ in what a tick means
//! to fail at: a missed reap just leaves a pool open a little longer, while a
//! missed sample is a permanent gap in someone's history — so `tick` never
//! lets one connection's failure (a dropped server, a revoked privilege)
//! cost every other connection its sample for that minute.

use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::pulse::MetricSample;
use crate::state::{AppState, DbPool};

/// Start the sampler. Called once from the Tauri `setup` hook, alongside
/// `pool_reaper::spawn`.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Read the interval fresh each pass rather than once at spawn
            // time, so a preference change the user makes in Settings takes
            // effect on the *next* tick instead of needing a relaunch.
            let secs = app
                .state::<AppState>()
                .prefs
                .read()
                .pulse
                .history_interval_secs
                .max(1);
            tokio::time::sleep(Duration::from_secs(u64::from(secs))).await;
            tick(&app).await;
        }
    });
}

/// One sampling pass: read every opted-in, currently-connected connection's
/// vital signs into `pulse.db`, then run retention.
///
/// Split out from the loop for the same reason `pool_reaper::sweep` is: it is
/// directly testable and it is where a future "sample now" affordance would
/// hook in.
async fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();

    let (enabled, sample_when_minimized, retention_days, max_disk_mb) = {
        let profiles = state.profiles.read();
        let prefs = state.prefs.read();
        // The module switch wins over every per-connection opt-in: Pulse
        // turned off in Settings samples nothing, and the opt-ins are left
        // alone so turning it back on resumes the same set.
        let enabled: Vec<String> = if prefs.pulse.enabled {
            profiles
                .iter()
                .filter(|p| p.pulse_enabled)
                .map(|p| p.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        (
            enabled,
            prefs.pulse.sample_when_minimized,
            prefs.pulse.retention_days,
            prefs.pulse.max_disk_mb,
        )
    };
    if enabled.is_empty() {
        return;
    }

    // Off by default, but when the user turns it off: skip the whole tick,
    // sampling included — this is the one preference that trades a gap in
    // the history for the promise that a minimised HuginnDB costs nothing.
    if !sample_when_minimized && main_window_minimized(app) {
        return;
    }

    // Only top-level pools: a server's vital signs are a property of the
    // server, not of one database on it — the same call the dock panel makes
    // via `parentConnectionId` before it ever samples anything. A synthetic
    // `<parent>::db::<name>` view id never appears in `profiles.json`, so it
    // could never match `enabled` anyway; this just makes the invariant
    // explicit rather than relying on that coincidence.
    let live: HashSet<String> = {
        let conns = state.connections.read();
        conns
            .ids()
            .into_iter()
            .filter(|id| !crate::state::is_database_view(id))
            .collect()
    };

    let now = crate::state::now_millis() as i64;
    for id in &enabled {
        if !live.contains(id) {
            continue;
        }
        // `peek`, not `pool_for`: a background sample is not use. `pool_for`
        // stamps `last_used`, and this runs every minute — so a connection the
        // MCP bridge opened, for a profile with Pulse on, never went idle and
        // the reaper never closed it: ADR #67's permanent pool, reached by
        // another route.
        let Some(pool) = state.connections.read().peek(id) else {
            continue;
        };
        let samples = read(pool).await;
        // Best-effort: a server that refused this tick's read (a dropped
        // connection, a revoked privilege) just has a gap for this minute —
        // the same "a wrong reading is worse than a missing one" stance
        // every other Pulse read takes, not a reason to skip every other
        // connection's tick.
        let Ok(samples) = samples else { continue };
        let _ = state.pulse_store.append(id, now, &samples).await;
    }

    let _ = state
        .pulse_store
        .prune(now, retention_days, max_disk_mb)
        .await;
}

/// One connection's reading, via each driver's lightweight `sample` —
/// deliberately not `health()`: that reads a second, almost-static
/// statement (MySQL's variables; MongoDB's profiling level) that a 60-second
/// tick has no use for, exactly as `db::mysql::pulse::health`'s own doc
/// comment says this module would skip. A driver Pulse cannot read yet is
/// not an error here — it simply contributes nothing this tick, the same
/// silence an unsupported metric already gets.
async fn read(pool: DbPool) -> crate::error::AppResult<Vec<MetricSample>> {
    match pool {
        DbPool::Mysql(p) => crate::db::mysql::pulse::sample(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::pulse::sample(&conn).await,
        DbPool::Postgres(_) | DbPool::Sqlite(_) | DbPool::MsSql(_) => Ok(Vec::new()),
    }
}

/// Whether the main window is currently minimised. `false` (i.e. "sample
/// anyway") when the window cannot be found at all — a headless launch or a
/// timing edge at shutdown must not silently disable sampling.
fn main_window_minimized(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_minimized().ok())
        .unwrap_or(false)
}
