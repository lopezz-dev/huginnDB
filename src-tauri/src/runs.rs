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
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

/// The runs in flight, by id. One per [`crate::state::AppState`].
#[derive(Default)]
pub struct RunRegistry {
    runs: parking_lot::Mutex<HashMap<String, CancellationToken>>,
}

impl RunRegistry {
    /// Register `id` for the length of the returned guard.
    ///
    /// An id already in flight is refused rather than replaced: replacing it
    /// would leave the first run unstoppable, and its guard would later remove
    /// the second run's entry when it dropped.
    pub fn start(self: &Arc<Self>, id: String) -> AppResult<RunGuard> {
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
        runs.insert(id.clone(), token.clone());
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
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Ask every run in flight to stop — the app lock, which takes the
    /// window that started them down with it (`app_lock::lock_app`).
    pub fn stop_all(&self) {
        for token in self.runs.lock().values() {
            token.cancel();
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
    fn stop_all_reaches_every_run() {
        let registry = Arc::new(RunRegistry::default());
        let a = registry.start("a".into()).unwrap();
        let b = registry.start("b".into()).unwrap();
        registry.stop_all();
        assert!(a.signal().is_requested() && b.signal().is_requested());
    }
}
