//! MongoDB vital signs for Pulse. See [`crate::pulse`] for the contract these
//! readings are normalised into.

use std::collections::HashMap;

use mongodb::bson::{doc, Bson, Document};

use crate::db::mongo::shell::{self, MongoOp};
use crate::db::mongo::values::bson_to_shell_text;
use crate::error::{AppError, AppResult};
use crate::pulse::{
    truncate, ExplainPlan, IndexUsage, MetricSample, PulseHealth, PulseNote, SessionRow,
    StorageItem, TopQuery,
};
use crate::state::MongoConn;

/// Read a nested numeric field by path, coercing whatever BSON number the
/// server chose.
///
/// `serverStatus` is not consistent about width: the same counter comes back as
/// `Int32` on a quiet server and `Int64` once it grows, and WiredTiger's own
/// block reports `Double` for several. A typed `get_i64` therefore silently
/// misses readings on exactly the servers worth measuring, which is the kind of
/// bug that looks like "that metric is not supported here".
fn num(doc: &Document, path: &[&str]) -> Option<f64> {
    let (last, parents) = path.split_last()?;
    let mut current = doc;
    for key in parents {
        current = current.get_document(key).ok()?;
    }
    match current.get(*last)? {
        Bson::Int32(v) => Some(*v as f64),
        Bson::Int64(v) => Some(*v as f64),
        Bson::Double(v) => Some(*v),
        _ => None,
    }
}

/// Sum of every `opcounters` entry — the closest MongoDB has to "statements
/// this server answered".
///
/// Summed rather than reading one field because there is no single counter:
/// `query` alone would omit every `getmore` a cursor-heavy workload is made of,
/// and `command` alone would omit the CRUD. Absent entries contribute nothing,
/// so an older server missing one still reports a usable total.
fn opcounter_total(status: &Document) -> Option<f64> {
    let ops = status.get_document("opcounters").ok()?;
    let total: f64 = ["query", "insert", "update", "delete", "getmore", "command"]
        .iter()
        .filter_map(|k| num(ops, &[k]))
        .sum();
    Some(total)
}

/// Build a snapshot from a `serverStatus` reply.
///
/// Pure, so the whole mapping is testable against a captured reply — which
/// matters here more than for MySQL, because a wrong path in a nested document
/// does not fail, it just makes the metric quietly absent.
pub fn build_health(status: &Document, profiling_level: Option<i32>) -> PulseHealth {
    let mut metrics = Vec::new();
    let mut push = |name: &str, value: Option<f64>| {
        if let Some(v) = value {
            metrics.extend(MetricSample::new(name, v));
        }
    };

    push("queries", opcounter_total(status));
    push("select_ops", num(status, &["opcounters", "query"]));
    push("insert_ops", num(status, &["opcounters", "insert"]));
    push("update_ops", num(status, &["opcounters", "update"]));
    push("delete_ops", num(status, &["opcounters", "delete"]));

    let current = num(status, &["connections", "current"]);
    push("connections_active", current);
    // MongoDB reports headroom, not a ceiling, so the ceiling is the sum.
    // Reporting `available` as the max would make a busy server look idle.
    if let (Some(cur), Some(avail)) = (current, num(status, &["connections", "available"])) {
        push("connections_max", Some(cur + avail));
    }

    // The nearest thing to MySQL's `Threads_running`: clients holding or
    // waiting on the global lock right now. Not identical — it counts internal
    // clients too — but it moves for the same reason and is the only
    // instantaneous concurrency figure `serverStatus` offers.
    push(
        "connections_running",
        num(status, &["globalLock", "activeClients", "total"]),
    );

    // WiredTiger's cache accounting mirrors a buffer pool's: requests against
    // the cache, and the subset that had to be read in from disk. Same shape as
    // the MySQL pair, so the hit ratio is derived identically downstream.
    push(
        "cache_read_requests",
        num(
            status,
            &["wiredTiger", "cache", "pages requested from the cache"],
        ),
    );
    push(
        "cache_reads",
        num(status, &["wiredTiger", "cache", "pages read into cache"]),
    );

    push("bytes_sent", num(status, &["network", "bytesOut"]));
    push("bytes_received", num(status, &["network", "bytesIn"]));

    let mut notes = Vec::new();
    // Level 0 is off. `None` means the level could not be read at all (a role
    // without the privilege), which is not the same claim — stay quiet rather
    // than telling the user to switch on something that may already be on.
    if profiling_level == Some(0) {
        notes.push(PulseNote::warning("profilerOff"));
    }

    PulseHealth {
        driver: "mongodb",
        server_version: status
            .get_str("version")
            .unwrap_or_default()
            .split('-')
            .next()
            .unwrap_or_default()
            .to_string(),
        uptime_secs: num(status, &["uptime"]).map(|v| v.max(0.0) as u64),
        sampled_at_ms: crate::state::now_millis(),
        metrics,
        notes,
    }
}

/// Read the server's vital signs.
///
/// `serverStatus` is an `admin` command and is one round trip. The profiling
/// level is a second, best-effort one: a role without it simply leaves the
/// note unraised, and the sampler will skip this call entirely the same way
/// MySQL's variables read is skipped.
pub async fn health(conn: &MongoConn) -> AppResult<PulseHealth> {
    let admin = conn.client.database("admin");
    let status = admin.run_command(doc! {"serverStatus": 1}).await?;

    // Profiling is per database, so it is read against the connection's own
    // target rather than `admin`; a cluster-level connection with no database
    // selected has nothing to ask about and skips it.
    let level = match crate::db::mongo::schema::resolve_db(conn) {
        Ok(db) => db
            .run_command(doc! {"profile": -1})
            .await
            .ok()
            .and_then(|d| d.get_i32("was").ok()),
        Err(_) => None,
    };

    Ok(build_health(&status, level))
}

/// The one-round-trip read `pulse::sampler` ticks every 60s: `serverStatus`
/// only, skipping the profiling-level read — this is exactly the second
/// round trip [`health`]'s own doc comment says the sampler would skip.
/// `build_health` never needs the level to compute `metrics`, only to decide
/// whether to raise `profilerOff`, so passing `None` here costs nothing but
/// that note, which the stored history has no use for anyway.
pub async fn sample(conn: &MongoConn) -> AppResult<Vec<MetricSample>> {
    let admin = conn.client.database("admin");
    let status = admin.run_command(doc! {"serverStatus": 1}).await?;
    Ok(build_health(&status, None).metrics)
}

/// Per-collection footprint from one `$collStats` aggregation.
///
/// One round trip for every collection at once, the same call
/// [`crate::db::mongo::schema`] already makes for the explorer's sizes — the
/// N+1 of a `collStats` per collection is what that avoided and this must not
/// reintroduce. Views have no storage stats and drop out on their own.
///
/// `freeStorageSize` lands in `free_bytes` with `free_is_within_data: true`:
/// WiredTiger reports it as the reclaimable portion *of* `storageSize`, not
/// something alongside it the way MySQL's `Data_free` sits outside
/// `Data_length` — so `StorageItem::new` leaves it out of `total_bytes`
/// rather than double-counting it (issue #163). Servers before 4.4 do not
/// report it and simply read as zero.
pub async fn storage(conn: &MongoConn, limit: usize) -> AppResult<Vec<StorageItem>> {
    let db = crate::db::mongo::schema::resolve_db(conn)?;
    let db_name = db.name().to_string();
    let prefix = format!("{db_name}.");

    let mut cursor = db
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await?;

    let mut items: Vec<StorageItem> = Vec::new();
    while matches!(cursor.advance().await, Ok(true)) {
        let Ok(stat) = cursor.deserialize_current() else {
            continue;
        };
        let Some(name) = stat
            .get_str("ns")
            .ok()
            .and_then(|ns| ns.strip_prefix(&prefix))
        else {
            continue;
        };
        let Ok(s) = stat.get_document("storageStats") else {
            continue;
        };
        let take = |key: &str| num(s, &[key]).unwrap_or(0.0).max(0.0) as u64;
        items.push(StorageItem::new(
            name.to_string(),
            Some(db_name.clone()),
            take("storageSize"),
            take("totalIndexSize"),
            take("freeStorageSize"),
            true,
        ));
    }

    items.sort_unstable_by_key(|i| std::cmp::Reverse(i.total_bytes));
    items.truncate(limit);
    Ok(items)
}

/// How many of the profiler's most recent entries to scan when grouping.
///
/// `system.profile` is a capped collection (1 MiB by default), so this is
/// generous headroom rather than a real limit in practice — it exists so a
/// profiler someone pointed at level 2 on a busy, large-document server
/// cannot turn one on-demand read into an unbounded scan.
const PROFILE_SCAN_LIMIT: i64 = 5_000;

/// Command names the profiler records that Pulse groups into a "statement" —
/// the CRUD-shaped operations someone came here to see. Everything else
/// (`serverStatus`, `collStats`, `profile`, `listCollections`, …) is
/// introspection — largely Pulse's own reads, on a connection with profiling
/// turned up to capture everything — and would otherwise pollute the ranking
/// with noise nobody asked to see.
const TRACKED_COMMANDS: &[&str] = &[
    "find",
    "aggregate",
    "count",
    "distinct",
    "findandmodify",
    "update",
    "delete",
    "insert",
];

/// The command name a profile entry recorded, read from the embedded original
/// command rather than the top-level `op` field — `op` collapses several
/// command shapes onto `"command"` on modern servers, while `command`'s own
/// first key always names the real operation.
fn command_name(doc: &Document) -> Option<String> {
    let cmd = doc.get_document("command").ok()?;
    cmd.keys().next().map(|k| k.to_ascii_lowercase())
}

/// One group's running totals while [`build_top_queries`] folds the profiler's
/// entries. Not `TopQuery` itself: `avg_ms` needs the final count, and the
/// digest needs to fall back to a synthesised label when no runnable sample
/// was ever seen for the group.
struct QueryGroup {
    schema: String,
    fallback_label: String,
    sample: Option<String>,
    count: u64,
    total_ms: f64,
    max_ms: f64,
    rows_examined: u64,
    rows_sent: u64,
    full_scans: u64,
}

/// Group profiler entries into statement-shaped rows, MySQL digest-table
/// style.
///
/// Pure, so the grouping is testable against a captured `system.profile`
/// shape without a server — the same reason [`build_health`] is pure. The
/// grouping key is the server's own `queryHash` (present since 4.2 on the
/// tracked command shapes) when the entry carries one, falling back to
/// `namespace + command` for older servers or command shapes `queryHash`
/// does not cover — a coarser grouping, still useful, never a hard failure.
pub fn build_top_queries(docs: &[Document], limit: usize) -> Vec<TopQuery> {
    let mut groups: HashMap<String, QueryGroup> = HashMap::new();

    for doc in docs {
        let Ok(ns) = doc.get_str("ns") else { continue };
        // Skip the profiler reading itself and other server-internal
        // namespaces — never what anyone opened Consultas to see.
        if ns.contains(".system.") {
            continue;
        }
        let Some(name) = command_name(doc) else {
            continue;
        };
        if !TRACKED_COMMANDS.contains(&name.as_str()) {
            continue;
        }

        let (schema, collection) = ns
            .split_once('.')
            .map(|(d, c)| (d.to_string(), c.to_string()))
            .unwrap_or_else(|| (ns.to_string(), String::new()));

        let key = doc
            .get_str("queryHash")
            .map(|h| h.to_string())
            .unwrap_or_else(|_| format!("{ns}|{name}"));

        let millis = num(doc, &["millis"]).unwrap_or(0.0).max(0.0);
        let examined = num(doc, &["docsExamined"]).unwrap_or(0.0).max(0.0) as u64;
        let returned = num(doc, &["nreturned"]).unwrap_or(0.0).max(0.0) as u64;
        let full_scan = doc
            .get_str("planSummary")
            .is_ok_and(|p| p.contains("COLLSCAN"));

        let group = groups.entry(key).or_insert_with(|| QueryGroup {
            schema: schema.clone(),
            fallback_label: format!("db.{collection}.{name}()"),
            sample: None,
            count: 0,
            total_ms: 0.0,
            max_ms: 0.0,
            rows_examined: 0,
            rows_sent: 0,
            full_scans: 0,
        });

        group.count += 1;
        group.total_ms += millis;
        group.max_ms = group.max_ms.max(millis);
        group.rows_examined += examined;
        group.rows_sent += returned;
        if full_scan {
            group.full_scans += 1;
        }

        // Keep the first runnable filter seen for the group. Only `find`
        // yields one today — [`explain`] only knows how to replay the
        // read-shaped operations `shell::parse` understands (see its own doc
        // comment) — so an `update`/`delete`/`insert` group still shows where
        // the time went, it just cannot be explained from here.
        if group.sample.is_none() && name == "find" {
            if let Some(filter) = doc
                .get_document("command")
                .ok()
                .and_then(|cmd| cmd.get_document("filter").ok())
            {
                group.sample = Some(format!(
                    "db.{collection}.find({})",
                    bson_to_shell_text(&Bson::Document(filter.clone())),
                ));
            }
        }
    }

    let mut items: Vec<(f64, TopQuery)> = groups
        .into_values()
        .map(|g| {
            let avg_ms = g.total_ms / g.count.max(1) as f64;
            let query = TopQuery {
                digest: truncate(g.sample.as_deref().unwrap_or(&g.fallback_label)),
                schema: Some(g.schema),
                count: g.count,
                avg_ms,
                max_ms: g.max_ms,
                rows_examined: g.rows_examined,
                rows_sent: g.rows_sent,
                full_scans: g.full_scans,
                sample: g.sample,
            };
            (g.total_ms, query)
        })
        .collect();

    items.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    items.truncate(limit);
    items.into_iter().map(|(_, q)| q).collect()
}

/// Statements this connection's profiler has recorded, grouped and ranked by
/// total time — MongoDB's answer to MySQL's digest table.
///
/// Reads `system.profile` directly with a normal `find`, the same collection
/// `mongosh` itself reads to show recent operations, rather than a
/// `$collStats`-style privileged command — no more than the built-in `read`
/// role already grants. An empty or missing collection (profiling off, or
/// never turned on) is not an error: it means nothing was recorded, and
/// [`health`]'s own `profilerOff` note already told the user why.
pub async fn top_queries(conn: &MongoConn, limit: usize) -> AppResult<Vec<TopQuery>> {
    let db = crate::db::mongo::schema::resolve_db(conn)?;
    let coll = db.collection::<Document>("system.profile");
    let mut cursor = coll
        .find(doc! {})
        .sort(doc! {"ts": -1})
        .limit(PROFILE_SCAN_LIMIT)
        .await?;

    let mut docs = Vec::new();
    while matches!(cursor.advance().await, Ok(true)) {
        if let Ok(d) = cursor.deserialize_current() {
            docs.push(d);
        }
    }
    Ok(build_top_queries(&docs, limit))
}

/// Read the plan MongoDB would use for one statement, without running it.
///
/// `sample` is shell syntax (`db.<collection>.find({…})` today —
/// [`top_queries`] is the only producer of a Mongo sample right now, and it
/// only ever writes a `find`), the same grammar the query editor speaks.
/// Routing it back through [`shell::parse`] here is what keeps that the
/// *only* Mongo statement parser in the tree rather than growing a second,
/// subtly different one for this one caller (the rule ADR #33 documents).
///
/// Only the read-shaped operations carry enough of a query for `explain` to
/// mean anything; anything else is refused rather than silently no-op'd.
/// `verbosity` is hardcoded to `"queryPlanner"` — never taken from `sample` —
/// which is what keeps this safe to call on arbitrary shell text: MongoDB's
/// higher verbosities (`executionStats`, `allPlansExecution`) actually *run*
/// the statement, and nothing here ever asks for those.
pub async fn explain(conn: &MongoConn, sample: &str) -> AppResult<ExplainPlan> {
    let parsed = shell::parse(sample)?;
    let db = crate::db::mongo::schema::resolve_db(conn)?;

    let target = match parsed.op {
        MongoOp::Find {
            filter,
            projection,
            sort,
            skip,
            limit,
            collation,
            hint,
            ..
        } => {
            let mut cmd = doc! {"find": &parsed.collection, "filter": filter};
            if let Some(p) = projection {
                cmd.insert("projection", p);
            }
            // Both change the plan the server picks, so an explain that left
            // them out would be explaining a different query.
            if let Some(c) = collation {
                cmd.insert("collation", *c);
            }
            if let Some(h) = hint {
                cmd.insert("hint", *h);
            }
            if let Some(s) = sort {
                cmd.insert("sort", s);
            }
            if let Some(s) = skip {
                cmd.insert("skip", s);
            }
            if let Some(l) = limit {
                cmd.insert("limit", l);
            }
            cmd
        }
        MongoOp::Aggregate { pipeline } => doc! {
            "aggregate": &parsed.collection,
            "pipeline": pipeline,
            "cursor": {},
        },
        MongoOp::Count { filter } => doc! {"count": &parsed.collection, "query": filter},
        MongoOp::Distinct { field, filter } => doc! {
            "distinct": &parsed.collection,
            "key": field,
            "query": filter,
        },
        _ => {
            return Err(AppError::InvalidInput(
                "pulse_explain only reads find/aggregate/count/distinct on MongoDB".into(),
            ))
        }
    };

    let reply = db
        .run_command(doc! {"explain": target, "verbosity": "queryPlanner"})
        .await?;
    Ok(ExplainPlan {
        raw: crate::db::mongo::values::bson_to_json(&Bson::Document(reply)),
    })
}
/// Operations MongoDB is actively running or lock-waiting on right now, from
/// the aggregation-pipeline form of `currentOp` (3.6+, the documented
/// replacement for the deprecated `db.currentOp()` command).
///
/// Deliberately narrower than MySQL's `SHOW FULL PROCESSLIST`: both
/// `idleConnections` and `idleSessions` are left off, so a pool of client
/// connections doing nothing never shows up here. MongoDB has no cheap
/// equivalent of MySQL's "Sleep" state worth surfacing, and including every
/// idle session would turn this into a list dominated by rows nobody came
/// here to see — what remains is genuinely active or lock-waiting operations,
/// which is also why there is no separate row cap: the filter itself bounds
/// the result.
pub async fn sessions(conn: &MongoConn) -> AppResult<Vec<SessionRow>> {
    let admin = conn.client.database("admin");
    let mut cursor = admin
        .aggregate(vec![doc! {"$currentOp": {
            "allUsers": true,
            "idleConnections": false,
            "idleSessions": false,
        }}])
        .await?;

    let mut out = Vec::new();
    while matches!(cursor.advance().await, Ok(true)) {
        if let Ok(op) = cursor.deserialize_current() {
            out.push(session_row(&op));
        }
    }
    Ok(out)
}

/// One `$currentOp` reply document → one row.
///
/// `blocked_by` is always `None`: unlike MySQL's `data_lock_waits`, MongoDB
/// gives no direct "this opid is waiting on that opid" mapping — `currentOp`
/// exposes `lockStats`/`waitingForLock`, but naming the *holder* means
/// matching lock resources across every other operation's own lock state, a
/// correctness-sensitive piece of work this pass leaves for later rather than
/// guessing at. A blocked Mongo session still shows through `state`.
fn session_row(op: &Document) -> SessionRow {
    let id = op
        .get("opid")
        .map(|v| match v {
            Bson::String(s) => s.clone(),
            other => bson_to_shell_text(other),
        })
        .unwrap_or_default();

    let user = op
        .get_array("effectiveUsers")
        .ok()
        .and_then(|arr| arr.first())
        .and_then(Bson::as_document)
        .and_then(|u| u.get_str("user").ok())
        .map(str::to_string);

    let db = op
        .get_str("ns")
        .ok()
        .and_then(|ns| ns.split('.').next())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let waiting = op.get_bool("waitingForLock").unwrap_or(false);
    let active = op.get_bool("active").unwrap_or(false);
    let state = Some(
        if waiting {
            "waiting for lock"
        } else if active {
            "active"
        } else {
            "idle"
        }
        .to_string(),
    );

    let query = op
        .get_document("command")
        .ok()
        .map(|cmd| truncate(&bson_to_shell_text(&Bson::Document(cmd.clone()))));

    SessionRow {
        id,
        user,
        host: op.get_str("client").ok().map(str::to_string),
        db,
        command: op.get_str("op").unwrap_or("none").to_string(),
        state,
        duration_secs: num(op, &["secs_running"]).unwrap_or(0.0),
        query,
        blocked_by: None,
    }
}

/// How many of the database's largest collections to check for index usage.
///
/// MongoDB has no server-wide form of `$indexStats` the way `$collStats` has
/// for storage (see [`storage`]'s own doc comment) — the stage only runs
/// per collection, so covering N collections costs N round trips. This bounds
/// the read to whichever collections are worth the cost: a dead index on a
/// tiny collection wastes little, and the biggest collections are where an
/// unused one costs the most in both disk and write overhead.
const INDEX_USAGE_SCAN_LIMIT: usize = 20;

/// Per-index usage since the counters were last reset, across the database's
/// largest collections, least-read first.
///
/// Ranks by [`storage`]'s own footprint read rather than a separate listing —
/// one fewer round trip, and it means the ordering this view scans in agrees
/// with what the Almacenamiento view already shows for "biggest". Per-index
/// *size* is not read here: getting it needs a second `$collStats` per
/// collection alongside the `$indexStats` one, doubling the round trips this
/// bound exists to avoid, so `size_bytes` stays `None` — the same tradeoff
/// [`crate::db::mysql::pulse::index_usage`] makes for `mysql.innodb_index_stats`.
pub async fn index_usage(conn: &MongoConn, limit: usize) -> AppResult<Vec<IndexUsage>> {
    let db = crate::db::mongo::schema::resolve_db(conn)?;
    let db_name = db.name().to_string();
    let ranked = storage(conn, INDEX_USAGE_SCAN_LIMIT).await?;

    let mut items = Vec::new();
    for item in &ranked {
        let Ok(mut cursor) = db
            .collection::<Document>(&item.name)
            .aggregate(vec![doc! {"$indexStats": {}}])
            .await
        else {
            continue;
        };
        while matches!(cursor.advance().await, Ok(true)) {
            let Ok(stat) = cursor.deserialize_current() else {
                continue;
            };
            let Ok(name) = stat.get_str("name") else {
                continue;
            };
            let reads = stat
                .get_document("accesses")
                .ok()
                .and_then(|a| num(a, &["ops"]))
                .map(|v| v.max(0.0) as u64);
            items.push(IndexUsage {
                schema: Some(db_name.clone()),
                table: item.name.clone(),
                index_name: name.to_string(),
                reads,
                size_bytes: None,
            });
        }
    }

    items.sort_unstable_by_key(|i| i.reads.unwrap_or(0));
    items.truncate(limit);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of(h: &PulseHealth, name: &str) -> Option<f64> {
        h.metrics.iter().find(|m| m.name == name).map(|m| m.value)
    }

    fn status() -> Document {
        doc! {
            "version": "7.0.9",
            "uptime": 1_036_800.0,
            "opcounters": {
                "query": 500_i64, "insert": 120_i32, "update": 90_i64,
                "delete": 30_i64, "getmore": 180_i64, "command": 20_i64,
            },
            "connections": { "current": 214_i32, "available": 286_i32 },
            "globalLock": { "activeClients": { "total": 7_i32 } },
            "wiredTiger": { "cache": {
                "pages requested from the cache": 1_000_000_i64,
                "pages read into cache": 4_200_i64,
            }},
            "network": { "bytesIn": 9_000_i64, "bytesOut": 12_000.0 },
        }
    }

    #[test]
    fn maps_server_status_onto_canonical_names() {
        let h = build_health(&status(), Some(1));
        assert_eq!(h.driver, "mongodb");
        assert_eq!(h.server_version, "7.0.9");
        assert_eq!(h.uptime_secs, Some(1_036_800));
        assert_eq!(value_of(&h, "select_ops"), Some(500.0));
        assert_eq!(value_of(&h, "connections_active"), Some(214.0));
        assert_eq!(value_of(&h, "connections_running"), Some(7.0));
        assert_eq!(value_of(&h, "cache_reads"), Some(4_200.0));
    }

    #[test]
    fn totals_every_opcounter_rather_than_reading_one() {
        // 500 + 120 + 90 + 30 + 180 + 20. Reading `query` alone would omit the
        // getmores a cursor-heavy workload is mostly made of.
        assert_eq!(
            value_of(&build_health(&status(), None), "queries"),
            Some(940.0)
        );
    }

    #[test]
    fn reports_the_ceiling_not_the_headroom() {
        // 214 in use + 286 free = 500. Reporting `available` would make a
        // server at 43 % look almost idle.
        assert_eq!(
            value_of(&build_health(&status(), None), "connections_max"),
            Some(500.0),
        );
    }

    #[test]
    fn accepts_whichever_bson_number_width_the_server_chose() {
        // Int32, Int64 and Double all appear in a real reply, sometimes for the
        // same field on different servers.
        let h = build_health(&status(), None);
        assert_eq!(value_of(&h, "insert_ops"), Some(120.0)); // Int32
        assert_eq!(value_of(&h, "update_ops"), Some(90.0)); // Int64
        assert_eq!(value_of(&h, "bytes_sent"), Some(12_000.0)); // Double
    }

    #[test]
    fn omits_a_metric_the_reply_does_not_carry() {
        let h = build_health(&doc! {"version": "7.0.9"}, None);
        assert_eq!(value_of(&h, "connections_active"), None);
        assert_eq!(value_of(&h, "cache_reads"), None);
        // MongoDB has no equivalent of these at all, so they are absent rather
        // than zero — a zero would render as a healthy reading.
        assert_eq!(value_of(&h, "slow_queries"), None);
        assert_eq!(value_of(&h, "tmp_disk_tables"), None);
    }

    #[test]
    fn warns_only_when_the_profiler_is_known_to_be_off() {
        assert_eq!(build_health(&status(), Some(0)).notes.len(), 1);
        assert_eq!(
            build_health(&status(), Some(0)).notes[0].code,
            "profilerOff"
        );
        assert!(build_health(&status(), Some(1)).notes.is_empty());
        // Unreadable level: stay quiet rather than telling someone to switch on
        // something that may already be on.
        assert!(build_health(&status(), None).notes.is_empty());
    }

    fn find_entry(
        ns: &str,
        filter: Document,
        millis: f64,
        examined: i64,
        returned: i64,
    ) -> Document {
        doc! {
            "ns": ns,
            "millis": millis,
            "docsExamined": examined,
            "nreturned": returned,
            "planSummary": "IXSCAN { a: 1 }",
            "command": { "find": ns.split('.').next_back().unwrap_or(""), "filter": filter },
        }
    }

    #[test]
    fn groups_profile_entries_by_query_hash() {
        let docs = vec![
            {
                let mut d = find_entry("shop.orders", doc! {"status": "A"}, 12.0, 100, 10);
                d.insert("queryHash", "ABCD1234");
                d
            },
            {
                let mut d = find_entry("shop.orders", doc! {"status": "B"}, 8.0, 50, 5);
                d.insert("queryHash", "ABCD1234");
                d
            },
        ];
        let items = build_top_queries(&docs, 10);
        assert_eq!(items.len(), 1, "same queryHash must fold into one row");
        assert_eq!(items[0].count, 2);
        assert_eq!(items[0].avg_ms, 10.0);
        assert_eq!(items[0].max_ms, 12.0);
        assert_eq!(items[0].rows_examined, 150);
        assert_eq!(items[0].rows_sent, 15);
        assert_eq!(items[0].schema.as_deref(), Some("shop"));
    }

    #[test]
    fn falls_back_to_namespace_and_command_without_a_query_hash() {
        // Pre-4.2 servers, or a command shape the server does not hash.
        let docs = vec![
            find_entry("shop.orders", doc! {"status": "A"}, 5.0, 1, 1),
            find_entry("shop.orders", doc! {"status": "B"}, 5.0, 1, 1),
            find_entry("shop.customers", doc! {}, 5.0, 1, 1),
        ];
        let items = build_top_queries(&docs, 10);
        assert_eq!(
            items.len(),
            2,
            "grouped by namespace + command, not per-document"
        );
    }

    #[test]
    fn flags_a_collection_scan_from_plan_summary() {
        let mut scanned = find_entry("shop.orders", doc! {}, 1.0, 1000, 1);
        scanned.insert("planSummary", "COLLSCAN");
        let items = build_top_queries(&[scanned], 10);
        assert_eq!(items[0].full_scans, 1);

        let items = build_top_queries(&[find_entry("shop.orders", doc! {}, 1.0, 1, 1)], 10);
        assert_eq!(items[0].full_scans, 0);
    }

    #[test]
    fn captures_a_runnable_sample_for_find_but_not_other_commands() {
        let find = find_entry("shop.orders", doc! {"status": "A"}, 1.0, 1, 1);
        let items = build_top_queries(&[find], 10);
        // `bson_to_shell_text` pretty-prints, so match the shape rather than
        // pin every whitespace byte to this test.
        let sample = items[0].sample.as_deref().expect("find yields a sample");
        assert!(sample.starts_with("db.orders.find({"));
        assert!(sample.contains("status: \"A\""));
        assert!(sample.ends_with("})"));

        let update = doc! {
            "ns": "shop.orders",
            "millis": 1.0,
            "command": { "update": "orders", "updates": [] },
        };
        let items = build_top_queries(&[update], 10);
        assert_eq!(items[0].sample, None);
        // No sample: the digest falls back to a synthesised label rather than
        // an empty string.
        assert_eq!(items[0].digest, "db.orders.update()");
    }

    #[test]
    fn skips_the_profilers_own_traffic_and_untracked_commands() {
        let own_read = doc! {
            "ns": "shop.system.profile",
            "millis": 1.0,
            "command": { "find": "system.profile", "filter": {} },
        };
        let admin_read = doc! {
            "ns": "admin.$cmd",
            "millis": 1.0,
            "command": { "serverStatus": 1 },
        };
        assert!(build_top_queries(&[own_read, admin_read], 10).is_empty());
    }

    #[test]
    fn ranks_groups_by_total_time_descending() {
        let busy = find_entry("shop.orders", doc! {"a": 1}, 100.0, 1, 1);
        let quiet = find_entry("shop.customers", doc! {"b": 1}, 1.0, 1, 1);
        let items = build_top_queries(&[quiet, busy], 10);
        assert_eq!(items[0].schema.as_deref(), Some("shop"));
        assert_eq!(items[0].max_ms, 100.0, "the busier group must sort first");
    }

    #[test]
    fn respects_the_row_limit_after_ranking() {
        // Distinct collections, so each entry is its own group — the filter
        // value alone does not fork a group when there is no `queryHash`, by
        // design (see `falls_back_to_namespace_and_command_without_a_query_hash`).
        let docs: Vec<Document> = (0..5)
            .map(|i| find_entry(&format!("shop.coll{i}"), doc! {"n": i}, i as f64, 1, 1))
            .collect();
        assert_eq!(build_top_queries(&docs, 2).len(), 2);
    }
    fn current_op(extra: Document) -> Document {
        let mut base = doc! {
            "opid": 4217_i32,
            "active": true,
            "secs_running": 3_i64,
            "op": "query",
            "ns": "shop.orders",
            "client": "127.0.0.1:54321",
            "waitingForLock": false,
            "effectiveUsers": [{"user": "app", "db": "admin"}],
            "command": {"find": "orders", "filter": {"status": "A"}},
        };
        base.extend(extra);
        base
    }

    #[test]
    fn session_row_reads_the_common_fields() {
        let row = session_row(&current_op(doc! {}));
        assert_eq!(row.id, "4217");
        assert_eq!(row.user.as_deref(), Some("app"));
        assert_eq!(row.host.as_deref(), Some("127.0.0.1:54321"));
        assert_eq!(row.db.as_deref(), Some("shop"));
        assert_eq!(row.command, "query");
        assert_eq!(row.state.as_deref(), Some("active"));
        assert_eq!(row.duration_secs, 3.0);
        assert!(row.query.as_deref().unwrap().contains("filter"));
        // MongoDB does not identify the blocker in this release.
        assert_eq!(row.blocked_by, None);
    }

    #[test]
    fn session_row_flags_a_lock_wait_over_active() {
        let row = session_row(&current_op(doc! {"waitingForLock": true}));
        assert_eq!(row.state.as_deref(), Some("waiting for lock"));
    }

    #[test]
    fn session_row_reports_idle_when_neither_active_nor_waiting() {
        let row = session_row(&current_op(doc! {"active": false}));
        assert_eq!(row.state.as_deref(), Some("idle"));
    }

    #[test]
    fn session_row_tolerates_a_missing_effective_user() {
        let mut op = current_op(doc! {});
        op.remove("effectiveUsers");
        let row = session_row(&op);
        assert_eq!(row.user, None);
    }

    #[test]
    fn session_row_keeps_a_string_opid_verbatim() {
        // A sharded cluster's opid is `"shard1:12345"`, not a bare integer.
        let row = session_row(&current_op(doc! {"opid": "shard1:12345"}));
        assert_eq!(row.id, "shard1:12345");
    }
}
