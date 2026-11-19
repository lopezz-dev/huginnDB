//! A person's runs in flight, by the id the query tab gave them, and the means
//! of stopping each one (ADR #137).
//!
//! The query tab names a run when it starts it (`execute_query` /
//! `execute_batch` with a `run_id`) and asks for it to be stopped by that name
//! (`cancel_query`). This module only records and signals: it knows nothing of
//! drivers. Stopping the statement **on the server** is the runner's job,
//! `commands::query::stop`, which races each statement against the
//! [`StopSignal`] and, when it fires, applies the per-driver stop of
//! `commands::query::bounded` (ADR #134).
//!
//! A run is registered for exactly as long as its [`RunGuard`] lives, so a run
//! that ends — whichever way — leaves nothing behind, and a stop asked for a
//! run that has already ended finds nothing and says so (`false`), which is
//! not an error: the person pressed Stop as the result arrived.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

/// The runs in flight, by id. One per [`crate::state::AppState`].
///
/// A person's runs (the query tab's) and an AI's reads (MCP `run_query`, the
/// AI panel's) share it, because both are "a statement in flight that may be
/// asked to stop" (ADRs #137, #142). Only an AI read carries [`AiRead`]: what
/// `running_queries` lists and what `cancel_query` may stop.
#[derive(Default)]
pub struct RunRegistry {
    runs: parking_lot::Mutex<HashMap<String, Entry>>,
}

struct Entry {
    token: CancellationToken,
    /// `Some` for an AI's read, `None` for a person's run.
    ai_read: Option<AiRead>,
}

/// An AI read in flight, as `running_queries` describes it.
struct AiRead {
    /// The profile it runs against — what an MCP client names it by.
    profile_id: String,
    sql_head: String,
    started: Instant,
    /// Set once it has a slot of its connection's gate (ADR #141); until
    /// then it is queued.
    running: Arc<AtomicBool>,
}

/// One AI read in flight, for `running_queries` (ADR #142).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AiReadView {
    pub query_id: String,
    pub connection_id: String,
    /// `queued` (waiting for a slot of its connection) or `running`.
    pub state: AiReadState,
    pub elapsed_ms: u64,
    pub sql_head: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiReadState {
    Queued,
    Running,
}

/// What `cancel_query` found (ADR #142).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    /// Asked to stop; its own call ends with how.
    Stopped,
    /// No AI read with that id on that connection: it ended, it never
    /// existed, or it is someone else's — a person's run is never one.
    NotFound,
}

/// Marks an AI read as past its queue. Held by the read itself.
pub struct ReadProgress(Arc<AtomicBool>);

impl ReadProgress {
    pub fn running(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl RunRegistry {
    /// Register `id` for the length of the returned guard.
    ///
    /// An id already in flight is refused rather than replaced: replacing it
    /// would leave the first run unstoppable, and its guard would later remove
    /// the second run's entry when it dropped.
    pub fn start(self: &Arc<Self>, id: String) -> AppResult<RunGuard> {
        self.register(id, None)
    }

    /// Register an AI read `id` against `profile_id` for the length of the
    /// returned guard, queued until [`ReadProgress::running`].
    pub fn start_ai_read(
        self: &Arc<Self>,
        id: String,
        profile_id: &str,
        sql: &str,
    ) -> AppResult<(RunGuard, ReadProgress)> {
        let running = Arc::new(AtomicBool::new(false));
        let guard = self.register(
            id,
            Some(AiRead {
                profile_id: profile_id.to_string(),
                sql_head: crate::error::ReadTimeout::head_of(sql),
                started: Instant::now(),
                running: running.clone(),
            }),
        )?;
        Ok((guard, ReadProgress(running)))
    }

    fn register(self: &Arc<Self>, id: String, ai_read: Option<AiRead>) -> AppResult<RunGuard> {
        if id.trim().is_empty() {
            return Err(AppError::InvalidInput("a run id cannot be empty".into()));
        }
        let token = CancellationToken::new();
        let mut runs = self.runs.lock();
        if runs.contains_key(&id) {
            return Err(AppError::InvalidInput(format!(
                "a run with id {id} is already in flight"
            )));
        }
        runs.insert(
            id.clone(),
            Entry {
                token: token.clone(),
                ai_read,
            },
        );
        Ok(RunGuard {
            registry: Arc::clone(self),
            id,
            token,
        })
    }

    /// Ask the run `id` to stop. `false` when there is no such run in flight —
    /// it never existed, or it has already ended.
    pub fn stop(&self, id: &str) -> bool {
        match self.runs.lock().get(id) {
            Some(entry) => {
                entry.token.cancel();
                true
            }
            None => false,
        }
    }

    /// Stop the AI read `id` on `profile_id` — `cancel_query` (ADR #142).
    /// Never reaches a person's run, nor a read on another connection: an
    /// MCP client may stop only what it could have started.
    pub fn stop_ai_read(&self, profile_id: &str, id: &str) -> CancelOutcome {
        match self.runs.lock().get(id) {
            Some(Entry {
                token,
                ai_read: Some(read),
            }) if read.profile_id == profile_id => {
                token.cancel();
                CancelOutcome::Stopped
            }
            _ => CancelOutcome::NotFound,
        }
    }

    /// The AI reads in flight on `profile_id`, oldest first —
    /// `running_queries` (ADR #142).
    pub fn ai_reads(&self, profile_id: &str) -> Vec<AiReadView> {
        let mut reads: Vec<(Instant, AiReadView)> = self
            .runs
            .lock()
            .iter()
            .filter_map(|(id, entry)| {
                let read = entry.ai_read.as_ref()?;
                (read.profile_id == profile_id).then(|| {
                    (
                        read.started,
                        AiReadView {
                            query_id: id.clone(),
                            connection_id: read.profile_id.clone(),
                            state: if read.running.load(Ordering::Relaxed) {
                                AiReadState::Running
                            } else {
                                AiReadState::Queued
                            },
                            elapsed_ms: read.started.elapsed().as_millis() as u64,
                            sql_head: read.sql_head.clone(),
                        },
                    )
                })
            })
            .collect();
        reads.sort_by_key(|(started, _)| *started);
        reads.into_iter().map(|(_, view)| view).collect()
    }

    /// Ask every run in flight to stop — the app lock, which takes the
    /// window that started them down with it (`app_lock::lock_app`).
    pub fn stop_all(&self) {
        for entry in self.runs.lock().values() {
            entry.token.cancel();
        }
    }

    /// How many runs are in flight.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.runs.lock().len()
    }
}

/// One run's registration: removed from the registry when this drops.
pub struct RunGuard {
    registry: Arc<RunRegistry>,
    id: String,
    token: CancellationToken,
}

impl RunGuard {
    /// What the runner races its statements against.
    pub fn signal(&self) -> StopSignal {
        StopSignal(self.token.clone())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        // By id: `start` refuses a second run under an id in flight, so the
        // entry under this id is this run's.
        self.registry.runs.lock().remove(&self.id);
    }
}

/// The stop a person may ask for while a run is in flight.
#[derive(Clone)]
pub struct StopSignal(CancellationToken);

impl StopSignal {
    /// Resolves once a stop has been asked for — at once, if it already has.
    pub async fn requested(&self) {
        self.0.cancelled().await
    }

    /// Whether a stop has been asked for.
    pub fn is_requested(&self) -> bool {
        self.0.is_cancelled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_registered_for_as_long_as_its_guard_lives() {
        let registry = Arc::new(RunRegistry::default());
        let guard = registry.start("r1".into()).unwrap();
        assert_eq!(registry.len(), 1);
        drop(guard);
        assert_eq!(registry.len(), 0, "the registry cleans up after itself");
        assert!(!registry.stop("r1"), "a run that ended is not found");
    }

    #[test]
    fn an_unknown_run_is_not_an_error() {
        let registry = Arc::new(RunRegistry::default());
        assert!(!registry.stop("never-started"));
    }

    #[test]
    fn stopping_a_run_fires_its_signal() {
        let registry = Arc::new(RunRegistry::default());
        let guard = registry.start("r1".into()).unwrap();
        let signal = guard.signal();
        assert!(!signal.is_requested());
        assert!(registry.stop("r1"));
        assert!(signal.is_requested());
        // Asking twice is harmless: the run is still in flight until it lands.
        assert!(registry.stop("r1"));
    }

    #[test]
    fn an_id_in_flight_is_not_taken_twice() {
        let registry = Arc::new(RunRegistry::default());
        let _first = registry.start("r1".into()).unwrap();
        assert!(registry.start("r1".into()).is_err());
        assert!(registry.start("  ".into()).is_err());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn an_ai_read_is_listed_and_stopped_only_on_its_own_connection() {
        let registry = Arc::new(RunRegistry::default());
        let (guard, progress) = registry
            .start_ai_read("q-1".into(), "prod", "SELECT   1\n FROM t")
            .unwrap();
        let _person = registry.start("tab-run".into()).unwrap();

        let listed = registry.ai_reads("prod");
        assert_eq!(listed.len(), 1, "a person's run is not listed");
        assert_eq!(listed[0].query_id, "q-1");
        assert_eq!(listed[0].state, AiReadState::Queued);
        assert_eq!(listed[0].sql_head, "SELECT 1 FROM t");
        progress.running();
        assert_eq!(registry.ai_reads("prod")[0].state, AiReadState::Running);
        assert!(registry.ai_reads("other").is_empty());

        // Another connection, or a person's run, is out of reach.
        assert_eq!(
            registry.stop_ai_read("other", "q-1"),
            CancelOutcome::NotFound
        );
        assert_eq!(
            registry.stop_ai_read("prod", "tab-run"),
            CancelOutcome::NotFound
        );
        assert!(!guard.signal().is_requested());

        assert_eq!(registry.stop_ai_read("prod", "q-1"), CancelOutcome::Stopped);
        assert!(guard.signal().is_requested());
        drop(guard);
        assert_eq!(
            registry.stop_ai_read("prod", "q-1"),
            CancelOutcome::NotFound
        );
        assert!(registry.ai_reads("prod").is_empty());
    }

    #[test]
    fn stop_all_reaches_every_run() {
        let registry = Arc::new(RunRegistry::default());
        let a = registry.start("a".into()).unwrap();
        let b = registry.start("b".into()).unwrap();
        registry.stop_all();
        assert!(a.signal().is_requested() && b.signal().is_requested());
    }
}
