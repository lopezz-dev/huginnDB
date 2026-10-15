//! HuginnDB Pulse — server-health telemetry.
//!
//! Pulse reads the counters the engine already keeps and hands them to the UI
//! (a side panel and its expanded window) and, later, to the MCP connector.
//! This module owns the two things that must be shared across every engine:
//! the **canonical metric catalogue** and the DTOs that cross the IPC boundary.
//!
//! # Why canonical names, and why the raw value
//!
//! Each engine spells the same idea differently — MySQL's `Threads_connected`
//! is MongoDB's `connections.current` — so a snapshot is normalised to a fixed
//! vocabulary here. The panel then renders one set of tiles for every driver,
//! and an MCP client can ask for `connections_active` without knowing which
//! engine is answering. An engine that has no equivalent for a metric simply
//! omits it; a missing metric and a zero are different answers, and collapsing
//! them would invent a reading.
//!
//! What is emphatically **not** normalised is the value: a [`MetricKind::Counter`]
//! is reported exactly as the server reports it, monotonically increasing since
//! its last restart. Deriving a per-second rate needs two samples and the
//! interval between them, which only the caller holding the series has; doing it
//! here would mean either guessing the interval or keeping per-connection state
//! in a module that has no business owning any. It also makes a server restart
//! detectable — a counter that goes *down* is a restart, not a negative rate —
//! which a pre-derived rate throws away.
//!
//! # No display copy
//!
//! Nothing here is user-facing text. A degradation is a [`PulseNote`] carrying a
//! machine-readable `code` the frontend translates, for the same reason the
//! backend never writes an environment's default name (ADR #27): copy chosen
//! in Rust would freeze one language into the user's screen.

pub mod sampler;
pub mod store;

use serde::Serialize;

/// Whether a reading accumulates since server start or describes the instant.
///
/// The distinction is the whole reason the catalogue exists: a consumer must
/// difference a `Counter` against the previous sample and must not difference a
/// `Gauge`. Getting it backwards yields a chart that is either flat or absurd.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricKind {
    /// Monotonic since the server last restarted. Rate = Δvalue / Δt.
    Counter,
    /// An instantaneous reading. Plotted as-is.
    Gauge,
}

/// What the number counts, so a consumer can format it without a lookup table
/// of its own. Kept here rather than on the frontend because the MCP connector
/// serves the same metrics to a client that has no frontend at all.
///
/// Only the units the catalogue actually uses are listed — a duration unit will
/// arrive with the first metric measured in one, rather than sitting here
/// unconstructed waiting for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricUnit {
    Count,
    Bytes,
}

/// One entry in the catalogue.
#[derive(Debug, Clone, Copy)]
pub struct MetricSpec {
    pub name: &'static str,
    pub kind: MetricKind,
    pub unit: MetricUnit,
}

const fn counter(name: &'static str, unit: MetricUnit) -> MetricSpec {
    MetricSpec {
        name,
        kind: MetricKind::Counter,
        unit,
    }
}

const fn gauge(name: &'static str, unit: MetricUnit) -> MetricSpec {
    MetricSpec {
        name,
        kind: MetricKind::Gauge,
        unit,
    }
}

/// The canonical metric vocabulary.
///
/// Adding an entry is cheap; renaming one is not — the names are the MCP tool's
/// public argument values and, once the history store lands, the key rows are
/// written under. Treat them as a contract.
pub const METRICS: &[MetricSpec] = &[
    // Throughput. `queries` is every statement the server answered; the four
    // below break it down and deliberately do not have to sum to it (a server
    // answers plenty that is none of the four).
    counter("queries", MetricUnit::Count),
    counter("select_ops", MetricUnit::Count),
    counter("insert_ops", MetricUnit::Count),
    counter("update_ops", MetricUnit::Count),
    counter("delete_ops", MetricUnit::Count),
    counter("slow_queries", MetricUnit::Count),
    // Connection pressure. `connections_max` is the server's configured
    // ceiling, which is a gauge even though it almost never moves — it can be
    // changed at runtime, and a panel that cached it would keep showing the old
    // limit after someone raised it mid-incident.
    gauge("connections_active", MetricUnit::Count),
    gauge("connections_running", MetricUnit::Count),
    gauge("connections_max", MetricUnit::Count),
    counter("connections_aborted", MetricUnit::Count),
    // Memory and spill. `cache_reads` counts the reads that had to go to disk,
    // so the hit ratio is `1 - Δcache_reads / Δcache_read_requests` — a ratio
    // over the *interval*, not over the server's lifetime, which is what makes
    // it able to show a problem that started an hour ago.
    counter("cache_read_requests", MetricUnit::Count),
    counter("cache_reads", MetricUnit::Count),
    counter("tmp_disk_tables", MetricUnit::Count),
    counter("lock_waits", MetricUnit::Count),
    // Network.
    counter("bytes_sent", MetricUnit::Bytes),
    counter("bytes_received", MetricUnit::Bytes),
];

/// Look a spec up by canonical name.
pub fn spec(name: &str) -> Option<&'static MetricSpec> {
    METRICS.iter().find(|m| m.name == name)
}

/// One reading in a snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSample {
    pub name: &'static str,
    pub value: f64,
    pub kind: MetricKind,
    pub unit: MetricUnit,
}

impl MetricSample {
    /// Build a sample for a catalogued metric. Returns `None` for a name that
    /// is not in [`METRICS`], which is what keeps a typo in a driver's mapping
    /// table from inventing a metric nobody can render or query.
    pub fn new(name: &str, value: f64) -> Option<Self> {
        spec(name).map(|s| MetricSample {
            name: s.name,
            value,
            kind: s.kind,
            unit: s.unit,
        })
    }
}

/// Something the user needs to know about the snapshot itself — a capability
/// the server does not grant, a feature switched off — as a code the frontend
/// translates. Never a sentence.
///
/// There is deliberately no severity field. Every note describes a *reading
/// Pulse could not take*, which is one thing and reads as a caution; the
/// alerts with real severity (a connection ceiling being approached, a
/// blocking transaction) are derived from the metrics by whoever holds the
/// series, and carry their own. A severity arrives here the day a note needs
/// one that is not "caution".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseNote {
    pub code: &'static str,
}

impl PulseNote {
    pub fn warning(code: &'static str) -> Self {
        PulseNote { code }
    }
}

/// A single read of a server's vital signs.
///
/// `sampledAtMs` is stamped by the backend, not the frontend: the frontend's
/// clock is the same one either way, but the interval between two samples is
/// what every rate is divided by, and taking both ends of it from the same
/// place keeps a slow IPC round trip out of the arithmetic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseHealth {
    /// `"mysql"` / `"mongodb"`. The frontend already knows the driver from the
    /// profile; this is here so an MCP client, which does not, still can tell.
    pub driver: &'static str,
    pub server_version: String,
    /// Seconds since the server last restarted, when it reports one.
    pub uptime_secs: Option<u64>,
    pub sampled_at_ms: u64,
    pub metrics: Vec<MetricSample>,
    pub notes: Vec<PulseNote>,
}

/// One normalised statement the server has been spending time on.
///
/// Aggregated since the statistics were last reset, not over an interval:
/// unlike the health counters there is no cheap way to difference these (the
/// digest table is keyed by a hash whose rows come and go as it fills), so the
/// honest framing is "what this server has spent its time on", and the view
/// says so rather than implying a live rate. On MongoDB the framing is closer
/// to "whatever the profiler currently retains" — `system.profile` is a
/// capped collection, not a since-flush accumulator — but the same caution
/// applies either way: this is a shape of recent activity, not a live rate.
///
/// Latency is the **average**, not a percentile. MySQL 8.0 does expose
/// `QUANTILE_95` here, but 5.7 does not have the column at all and a query
/// naming it simply fails there — one number that works everywhere beats two
/// code paths, and the percentile belongs with the expanded Queries view where
/// there is room to explain what it is a percentile *of*.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopQuery {
    /// The normalised statement text, already truncated by the reader.
    pub digest: String,
    pub schema: Option<String>,
    pub count: u64,
    pub avg_ms: f64,
    pub max_ms: f64,
    pub rows_examined: u64,
    pub rows_sent: u64,
    /// Executions that resolved without using any index. The single most
    /// useful column here: a statement can be fast and still be the reason the
    /// server is busy, and this is what says which.
    pub full_scans: u64,
    /// One runnable example of this statement, source text in the engine's
    /// own grammar (a literal MySQL statement; a `db.coll.find({…})` shell
    /// call for MongoDB) — what [`crate::commands::pulse::pulse_explain`]
    /// wraps in `EXPLAIN`. `None` when the server kept no example (an old
    /// MySQL without `QUERY_SAMPLE_TEXT`) or the statement shape has no
    /// well-defined plan to preview (MongoDB `update`/`delete`/`insert`
    /// entries group here too, since they still tell the user *where* time
    /// went, but nothing here replays one) — the frontend disables the
    /// Explain action rather than sending a request it knows will fail.
    pub sample: Option<String>,
}

/// One EXPLAIN read, engine-native.
///
/// The two engines' plan shapes have nothing in common beyond both being a
/// tree — MySQL's `EXPLAIN FORMAT=JSON` and MongoDB's `explain` command reply
/// share no field — so this stays a single opaque `raw` value rather than a
/// modelled DTO. Inventing a shared shape would either lose fields or force
/// one engine to answer questions the other cannot ask, the same call this
/// module's doc comment makes for [`PulseNote`]'s machine-readable `code`.
/// The frontend renders it as read-only JSON; it never inspects a field by
/// name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainPlan {
    pub raw: serde_json::Value,
}

/// How much of a normalised statement to keep.
///
/// A digest can be tens of kilobytes (a generated `IN (?, ?, ?, …)` list runs
/// long) and neither the panel row nor the expanded table can show more than a
/// couple of lines. Truncating in the reader keeps that off the IPC boundary
/// entirely rather than shipping it and letting CSS hide it. Shared by every
/// driver's reader — MySQL's digest and MongoDB's synthesised label both go
/// through this, so the panel never has to know which engine drew a row long.
pub const DIGEST_MAX_CHARS: usize = 300;

/// Truncate a digest on a character boundary, marking that it was cut.
pub fn truncate(digest: &str) -> String {
    let trimmed = digest.trim();
    if trimmed.chars().count() <= DIGEST_MAX_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(DIGEST_MAX_CHARS).collect();
    format!("{cut}…")
}

/// One relation's footprint on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    pub name: String,
    pub schema: Option<String>,
    pub data_bytes: u64,
    pub index_bytes: u64,
    /// Allocated but unused — space a rebuild would hand back.
    pub free_bytes: u64,
    /// Whether `free_bytes` is already counted inside `data_bytes` (MongoDB's
    /// `freeStorageSize` is the reclaimable portion of `storageSize`) rather
    /// than sitting alongside it (MySQL's `Data_free` is separate from
    /// `Data_length`). `total_bytes` is derived from this at construction so
    /// no caller has to know which engine it is looking at.
    pub free_is_within_data: bool,
    /// `data_bytes + index_bytes`, plus `free_bytes` only when it is not
    /// already inside `data_bytes`. Computed once here — the ranking and both
    /// frontend panels read this instead of re-deriving the sum, which is
    /// exactly what let the two drift for MongoDB in the first place.
    pub total_bytes: u64,
}

impl StorageItem {
    pub fn new(
        name: String,
        schema: Option<String>,
        data_bytes: u64,
        index_bytes: u64,
        free_bytes: u64,
        free_is_within_data: bool,
    ) -> Self {
        let total_bytes =
            data_bytes + index_bytes + if free_is_within_data { 0 } else { free_bytes };
        Self {
            name,
            schema,
            data_bytes,
            index_bytes,
            free_bytes,
            free_is_within_data,
            total_bytes,
        }
    }
}

/// One active session on the server, from `pulse_sessions`.
///
/// MySQL's `SHOW FULL PROCESSLIST` and MongoDB's `currentOp` describe the same
/// idea in different words — a running thread vs. a running operation — so
/// `command`/`state` stay whichever vocabulary the engine reports rather than
/// being translated into a shared one that neither engine actually speaks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// MySQL's PROCESSLIST id; MongoDB's `opid`. Kept as text end-to-end — a
    /// sharded MongoDB opid is not always a bare integer, and this id is never
    /// arithmetic, only ever displayed or matched against `blocked_by`.
    pub id: String,
    pub user: Option<String>,
    pub host: Option<String>,
    pub db: Option<String>,
    pub command: String,
    pub state: Option<String>,
    pub duration_secs: f64,
    /// The statement text, truncated the same way a Consultas digest is —
    /// [`truncate`], not a second cap invented for this DTO.
    pub query: Option<String>,
    /// This session's own id, when it is known to be waiting on a lock this
    /// other session holds. MySQL derives it from
    /// `performance_schema.data_lock_waits`, best-effort — absent when
    /// `performance_schema` is off, same as [`TopQuery`]. MongoDB does not
    /// identify the blocker in this release (see
    /// `crate::db::mongo::pulse::sessions`'s doc comment for why) — a blocked
    /// Mongo session still shows through `state`, it just cannot point at who
    /// it is waiting for yet.
    pub blocked_by: Option<String>,
}

/// One index's usage since its counters were last reset, from
/// `pulse_index_usage`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUsage {
    pub schema: Option<String>,
    pub table: String,
    pub index_name: String,
    /// Reads served since reset. `None` when the server could not be asked
    /// (a role without the privilege) — distinct from `Some(0)`, an index
    /// genuinely untouched since the counters last reset, which is the whole
    /// signal this view exists to surface.
    pub reads: Option<u64>,
    pub size_bytes: Option<u64>,
}

/// One metric's stored history for a connection, from `pulse_history`.
///
/// `kind` travels with the points rather than being something the frontend
/// hardcodes per metric name: it is what tells the Retrospectiva view
/// whether to plot `points` as-is (a gauge) or difference consecutive points
/// into a rate (a counter) — the same distinction [`MetricKind`] draws for
/// the live series, applied to a store that has no `PulseHealth` snapshot to
/// carry it on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseHistorySeries {
    pub kind: MetricKind,
    pub points: Vec<PulseHistoryPoint>,
}

/// One raw reading, oldest-to-newest order guaranteed by
/// [`store::PulseStore::range`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseHistoryPoint {
    pub ts_ms: i64,
    pub value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_names_are_unique() {
        // The names key both the MCP argument surface and (later) the history
        // rows, so a duplicate would make one of the two unreachable.
        let mut seen: Vec<&str> = METRICS.iter().map(|m| m.name).collect();
        seen.sort_unstable();
        let before = seen.len();
        seen.dedup();
        assert_eq!(before, seen.len(), "duplicate metric name in METRICS");
    }

    #[test]
    fn sample_rejects_an_uncatalogued_name() {
        assert!(MetricSample::new("queries", 1.0).is_some());
        assert!(MetricSample::new("Questions", 1.0).is_none());
    }

    #[test]
    fn sample_carries_the_catalogue_kind_and_unit() {
        let s = MetricSample::new("bytes_sent", 42.0).expect("catalogued");
        assert_eq!(s.kind, MetricKind::Counter);
        assert_eq!(s.unit, MetricUnit::Bytes);

        let g = MetricSample::new("connections_active", 7.0).expect("catalogued");
        assert_eq!(g.kind, MetricKind::Gauge);
        assert_eq!(g.unit, MetricUnit::Count);
    }

    #[test]
    fn truncate_keeps_a_short_digest_verbatim() {
        assert_eq!(truncate("  SELECT ? FROM t  "), "SELECT ? FROM t");
    }

    #[test]
    fn truncate_cuts_a_long_digest_and_says_so() {
        let long = "a".repeat(DIGEST_MAX_CHARS + 50);
        let cut = truncate(&long);
        assert_eq!(cut.chars().count(), DIGEST_MAX_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn truncate_cuts_on_a_character_boundary() {
        // A multi-byte digest must not be sliced mid-codepoint — a byte-wise
        // truncation here would panic on a table named in Japanese.
        let long = "た".repeat(DIGEST_MAX_CHARS + 10);
        let cut = truncate(&long);
        assert_eq!(cut.chars().count(), DIGEST_MAX_CHARS + 1);
    }
}
