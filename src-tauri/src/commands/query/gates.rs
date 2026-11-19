//! How many AI reads may run at once against one connection, and the queue
//! for the rest (ADR #141).
//!
//! The app is the one place that sees every AI read: each MCP client's sidecar
//! and the in-app AI panel all reach a database through `bridge::exec`. A gate
//! kept in a sidecar would see only its own client's calls, so two clients —
//! or one client and the panel — could still pile onto a production server.
//!
//! One gate per **profile** (the policy id), not per pool: MongoDB's
//! per-database views of one server share their profile's gate, as they share
//! its connection limit. Its size is
//! [`crate::state::mcp_concurrent_reads`], read afresh on every read so a
//! change in Settings → MCP applies to the next one without a restart.
//!
//! Reads only. A write that was sent must run and be answered (ADR #130);
//! queueing it behind a slow read would only move its timeout.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Every connection's gate, by profile id. One per
/// [`crate::state::AppState`].
#[derive(Default)]
pub struct ReadGates {
    gates: parking_lot::Mutex<HashMap<String, ReadGate>>,
}

impl ReadGates {
    /// The gate for `profile_id`, sized `limit`.
    ///
    /// A limit that changed gets a new gate. Reads already holding a slot of
    /// the old one finish on it, so for as long as they run the connection
    /// may carry up to both limits at once — a moment's over-admission, which
    /// is the price of never stalling a read on a resize.
    pub fn gate(&self, profile_id: &str, limit: u32) -> ReadGate {
        let mut gates = self.gates.lock();
        match gates.get(profile_id) {
            Some(gate) if gate.limit == limit => gate.clone(),
            _ => {
                let gate = ReadGate::new(limit);
                gates.insert(profile_id.to_string(), gate.clone());
                gate
            }
        }
    }
}

/// One connection's gate: `limit` slots, shared by every AI read against it.
#[derive(Clone)]
pub struct ReadGate {
    limit: u32,
    slots: Arc<Semaphore>,
}

impl ReadGate {
    fn new(limit: u32) -> Self {
        Self {
            limit,
            slots: Arc::new(Semaphore::new(limit as usize)),
        }
    }

    /// How many reads it lets run at once.
    pub fn limit(&self) -> u32 {
        self.limit
    }

    /// Wait for a slot. Held for as long as the read runs; dropped, it lets
    /// the next one in. The caller bounds the wait with the read's deadline.
    pub async fn enter(&self) -> OwnedSemaphorePermit {
        self.slots
            .clone()
            .acquire_owned()
            .await
            .expect("a read gate's semaphore is never closed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_gate_lets_in_its_limit_and_queues_the_rest() {
        let gates = ReadGates::default();
        let gate = gates.gate("p", 2);
        let a = gate.enter().await;
        let _b = gate.enter().await;
        let third = tokio::time::timeout(Duration::from_millis(50), gate.enter()).await;
        assert!(third.is_err(), "the third read waits");
        drop(a);
        let third = tokio::time::timeout(Duration::from_millis(50), gate.enter()).await;
        assert!(third.is_ok(), "and gets in once a slot is free");
    }

    #[tokio::test]
    async fn connections_have_gates_of_their_own() {
        let gates = ReadGates::default();
        let busy = gates.gate("busy", 1);
        let _held = busy.enter().await;
        let idle = gates.gate("idle", 1);
        let other = tokio::time::timeout(Duration::from_millis(50), idle.enter());
        assert!(
            other.await.is_ok(),
            "a read on another connection is not held up"
        );
    }

    #[tokio::test]
    async fn the_same_limit_is_the_same_gate_and_a_new_limit_a_new_one() {
        let gates = ReadGates::default();
        let first = gates.gate("p", 1);
        let _held = first.enter().await;
        let same = gates.gate("p", 1);
        let waited = tokio::time::timeout(Duration::from_millis(50), same.enter());
        assert!(waited.await.is_err(), "one slot, taken");
        // Raised in Settings: the next read gets the new gate at once.
        let raised = gates.gate("p", 2);
        let entered = tokio::time::timeout(Duration::from_millis(50), raised.enter());
        assert!(entered.await.is_ok());
        assert_eq!(gates.gate("p", 2).limit(), 2);
    }
}
