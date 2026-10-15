//! `pulse.db` — the on-disk history [`crate::pulse::sampler`] writes into and
//! the Retrospectiva view reads back out of.
//!
//! A time series doesn't fit `state_file.rs`'s pattern: that module exists so
//! a *whole* JSON blob can be rewritten atomically, and rewriting the whole
//! history on every 60-second tick is exactly the write amplification this
//! file is meant to avoid. So this is the one state file that is not JSON —
//! a SQLite database, opened once and appended to — and `state_file::path`
//! is still what resolves *where* it lives: that function only resolves a
//! path and creates the parent directory, it never assumes the file's format,
//! so `state_file::path("pulse.db")` is exactly as valid a call as
//! `state_file::path("prefs.json")`. That is what keeps the canary build's
//! isolation (ADR #26) working here for free — the same `APP_DIR` split
//! applies to this file as to every other one.
//!
//! Schema is a single flat table: `samples(connection_id, ts_ms, metric,
//! value)`, indexed on `(connection_id, metric, ts_ms)` — every query this
//! module runs filters on exactly that prefix. Counters are stored **raw**,
//! the same rule the live in-memory series follows (`src/lib/pulse/rates.ts`):
//! deriving a rate needs two samples and the gap between them, and only the
//! reader has both. Storing a pre-derived rate here would also make a server
//! restart (a counter going backwards) indistinguishable from a real drop.

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use tokio::sync::OnceCell;

use crate::error::AppResult;
use crate::pulse::MetricSample;

/// Below this age a sample is kept at full (sampler-tick) resolution.
const RAW_RETENTION_MS: i64 = 48 * 60 * 60 * 1000;

/// Bucket width once a sample ages past [`RAW_RETENTION_MS`] — one row per
/// bucket survives, the rest are dropped. 5 minutes, per the design's
/// "60s/48h → 5min/30d → gone" staircase: coarse enough that a month of
/// history for one metric is a few thousand rows, not a few hundred thousand.
const DOWNSAMPLE_BUCKET_MS: i64 = 5 * 60 * 1000;

/// A lazily-opened handle to `pulse.db`.
///
/// Lazy on purpose: constructing [`crate::state::AppState`] is synchronous
/// and runs before Tauri's async runtime is guaranteed to be pumping, and —
/// more to the point — an install where nobody has ever turned Pulse on for
/// any connection should never create this file at all. The first read (the
/// Retrospectiva view) or the first sampler tick opens it; every call after
/// that reuses the same pool.
pub struct PulseStore {
    cell: OnceCell<SqlitePool>,
}

impl PulseStore {
    pub fn new() -> Self {
        Self {
            cell: OnceCell::new(),
        }
    }

    async fn pool(&self) -> AppResult<&SqlitePool> {
        self.cell.get_or_try_init(open).await
    }

    /// Persist one sampler tick's readings for `connection_id`, all stamped
    /// with the same `ts_ms` — they were read together, and a chart that
    /// lines a connection's metrics up by timestamp depends on that.
    pub async fn append(
        &self,
        connection_id: &str,
        ts_ms: i64,
        samples: &[MetricSample],
    ) -> AppResult<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let pool = self.pool().await?;
        let mut tx = pool.begin().await?;
        for s in samples {
            sqlx::query(
                "INSERT INTO samples (connection_id, ts_ms, metric, value) VALUES (?, ?, ?, ?)",
            )
            .bind(connection_id)
            .bind(ts_ms)
            .bind(s.name)
            .bind(s.value)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// One metric's raw readings for `connection_id` since `since_ms`,
    /// oldest first — exactly what a chart needs and nothing it has to
    /// re-sort.
    pub async fn range(
        &self,
        connection_id: &str,
        metric: &str,
        since_ms: i64,
    ) -> AppResult<Vec<(i64, f64)>> {
        let pool = self.pool().await?;
        let rows = sqlx::query(
            "SELECT ts_ms, value FROM samples \
             WHERE connection_id = ? AND metric = ? AND ts_ms >= ? \
             ORDER BY ts_ms ASC",
        )
        .bind(connection_id)
        .bind(metric)
        .bind(since_ms)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get::<i64, _>("ts_ms"), r.get::<f64, _>("value")))
            .collect())
    }

    /// Run the retention staircase: downsample the 48h–`retention_days`
    /// window to one row per 5-minute bucket, drop anything older than
    /// `retention_days` outright, and — only if the file is still over
    /// `max_disk_mb` after that — shed the oldest tenth of what remains as a
    /// blunt safety valve. Called once per sampler tick, right after
    /// [`Self::append`], so the file never grows for more than one tick
    /// between prunes.
    pub async fn prune(&self, now_ms: i64, retention_days: u32, max_disk_mb: u32) -> AppResult<()> {
        let pool = self.pool().await?;
        let cutoff_raw = now_ms - RAW_RETENTION_MS;
        let cutoff_expire = now_ms - i64::from(retention_days) * 24 * 60 * 60 * 1000;

        // Downsample: within [cutoff_expire, cutoff_raw), keep the earliest
        // row of each 5-minute bucket per (connection, metric) and delete the
        // rest. `MIN(rowid)` is the earliest because rowids are assigned in
        // insertion order, which is timestamp order here.
        sqlx::query(
            "DELETE FROM samples \
             WHERE ts_ms < ?1 AND ts_ms >= ?2 \
               AND rowid NOT IN ( \
                 SELECT MIN(rowid) FROM samples \
                 WHERE ts_ms < ?1 AND ts_ms >= ?2 \
                 GROUP BY connection_id, metric, ts_ms / ?3 \
               )",
        )
        .bind(cutoff_raw)
        .bind(cutoff_expire)
        .bind(DOWNSAMPLE_BUCKET_MS)
        .execute(pool)
        .await?;

        sqlx::query("DELETE FROM samples WHERE ts_ms < ?")
            .bind(cutoff_expire)
            .execute(pool)
            .await?;

        if max_disk_mb > 0 {
            if let Ok(path) = crate::state_file::path("pulse.db") {
                if let Ok(meta) = std::fs::metadata(&path) {
                    let mb = meta.len() / (1024 * 1024);
                    if mb > u64::from(max_disk_mb) {
                        sqlx::query(
                            "DELETE FROM samples WHERE rowid IN ( \
                               SELECT rowid FROM samples ORDER BY ts_ms ASC \
                               LIMIT (SELECT CAST(COUNT(*) / 10 AS INTEGER) FROM samples) \
                             )",
                        )
                        .execute(pool)
                        .await?;
                    }
                }
            }
        }
        Ok(())
    }
}

impl Default for PulseStore {
    fn default() -> Self {
        Self::new()
    }
}

async fn open() -> AppResult<SqlitePool> {
    let path = crate::state_file::path("pulse.db")?;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        // WAL so the sampler's writes and a concurrent Retrospectiva read
        // never block each other on this single-file database.
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS samples ( \
           connection_id TEXT NOT NULL, \
           ts_ms INTEGER NOT NULL, \
           metric TEXT NOT NULL, \
           value REAL NOT NULL \
         )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples (connection_id, metric, ts_ms)",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store backed by a private in-memory database — never
    /// `state_file::path` in a test (convention #52): that resolves into the
    /// developer's real `%APPDATA%/HuginnDB/`, and `cargo test` must never
    /// touch it. `sqlite::memory:` with a *named* connection would be shared
    /// across the pool's connections and dropped once any of them closes, so
    /// this uses a single-connection pool against a private, unnamed
    /// in-memory database instead — the whole point being that nothing here
    /// resolves through `open()`/`state_file::path` at all.
    async fn memory_store() -> PulseStore {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::query(
            "CREATE TABLE samples ( \
               connection_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, \
               metric TEXT NOT NULL, value REAL NOT NULL \
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let store = PulseStore::new();
        store.cell.set(pool).ok();
        store
    }

    fn sample(name: &'static str, value: f64) -> MetricSample {
        MetricSample::new(name, value).expect("catalogued metric")
    }

    #[tokio::test]
    async fn appends_and_reads_back_a_range() {
        let store = memory_store().await;
        store
            .append(
                "c1",
                1_000,
                &[sample("queries", 5.0), sample("connections_active", 2.0)],
            )
            .await
            .unwrap();
        store
            .append("c1", 2_000, &[sample("queries", 9.0)])
            .await
            .unwrap();

        let points = store.range("c1", "queries", 0).await.unwrap();
        assert_eq!(points, vec![(1_000, 5.0), (2_000, 9.0)]);
    }

    #[tokio::test]
    async fn range_is_scoped_to_connection_and_metric() {
        let store = memory_store().await;
        store
            .append("c1", 1_000, &[sample("queries", 1.0)])
            .await
            .unwrap();
        store
            .append("c2", 1_000, &[sample("queries", 99.0)])
            .await
            .unwrap();
        store
            .append("c1", 1_000, &[sample("connections_active", 42.0)])
            .await
            .unwrap();

        let points = store.range("c1", "queries", 0).await.unwrap();
        assert_eq!(points, vec![(1_000, 1.0)]);
    }

    #[tokio::test]
    async fn range_respects_since_ms() {
        let store = memory_store().await;
        store
            .append("c1", 1_000, &[sample("queries", 1.0)])
            .await
            .unwrap();
        store
            .append("c1", 5_000, &[sample("queries", 2.0)])
            .await
            .unwrap();

        let points = store.range("c1", "queries", 3_000).await.unwrap();
        assert_eq!(points, vec![(5_000, 2.0)]);
    }

    #[tokio::test]
    async fn append_is_a_no_op_for_an_empty_batch() {
        // Not just an optimisation: a `BEGIN`/`COMMIT` around zero statements
        // is harmless, but a caller that always appends (even when a sample
        // failed and produced no metrics) must not write a phantom
        // transaction on every skipped tick.
        let store = memory_store().await;
        store.append("c1", 1_000, &[]).await.unwrap();
        assert!(store.range("c1", "queries", 0).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn prune_downsamples_the_48h_to_30d_window_to_one_row_per_bucket() {
        let store = memory_store().await;
        let now = 40 * 24 * 60 * 60 * 1000_i64; // day 40, comfortably past 48h
        let old = now - 10 * 24 * 60 * 60 * 1000; // day 30, inside the downsample window

        // Three raw ticks one minute apart, all inside the same 5-minute
        // bucket — only the earliest should survive.
        for i in 0..3 {
            store
                .append("c1", old + i * 60_000, &[sample("queries", i as f64)])
                .await
                .unwrap();
        }

        store.prune(now, 30, 0).await.unwrap();

        let points = store.range("c1", "queries", 0).await.unwrap();
        assert_eq!(
            points,
            vec![(old, 0.0)],
            "only the bucket's earliest row survives"
        );
    }

    #[tokio::test]
    async fn prune_leaves_recent_raw_samples_untouched() {
        let store = memory_store().await;
        let now = 1_000_000_i64;
        // Well inside the 48h raw window relative to `now`.
        store
            .append("c1", now - 60_000, &[sample("queries", 1.0)])
            .await
            .unwrap();
        store
            .append("c1", now - 30_000, &[sample("queries", 2.0)])
            .await
            .unwrap();

        store.prune(now, 30, 0).await.unwrap();

        let points = store.range("c1", "queries", 0).await.unwrap();
        assert_eq!(
            points.len(),
            2,
            "raw-resolution samples must survive untouched"
        );
    }

    #[tokio::test]
    async fn prune_expires_anything_past_the_retention_window() {
        let store = memory_store().await;
        let now = 40 * 24 * 60 * 60 * 1000_i64;
        let ancient = now - 35 * 24 * 60 * 60 * 1000; // past a 30-day retention

        store
            .append("c1", ancient, &[sample("queries", 1.0)])
            .await
            .unwrap();
        store.prune(now, 30, 0).await.unwrap();

        assert!(store.range("c1", "queries", 0).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn max_disk_mb_zero_disables_the_safety_valve() {
        // `0` means "no cap" — the same convention `ConnectionPrefs::max_child_pools`
        // uses — so prune must not touch `std::fs::metadata` at all for an
        // in-memory database that has no path to stat.
        let store = memory_store().await;
        store
            .append("c1", 1_000, &[sample("queries", 1.0)])
            .await
            .unwrap();
        store.prune(1_000_000, 30, 0).await.unwrap();
        assert_eq!(store.range("c1", "queries", 0).await.unwrap().len(), 1);
    }
}
