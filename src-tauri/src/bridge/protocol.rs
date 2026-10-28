//! Wire format for the local MCP bridge.
//!
//! Newline-delimited JSON, one object per line, request/response in lockstep on
//! a single connection. Not JSON-RPC: there is exactly one client per
//! connection issuing one call at a time (MCP tools are dispatched serially
//! over stdio), so ids, batching and notifications would all be ceremony with
//! no user.
//!
//! # Shape
//!
//! Every request is one variant of [`BridgeRequest`], mirroring the `_inner`
//! data-path function it dispatches to one-for-one. That deliberate redundancy
//! is what keeps the bridge honest: adding an MCP tool that reaches a new
//! `_inner` function will not compile against the server's exhaustive `match`
//! until the bridge learns about it too, so a tool can never silently keep
//! opening its own pools while the rest of the process is proxying.
//!
//! Results come back as an opaque `serde_json::Value`. The concrete types
//! (`QueryResult`, `Vec<TableInfo>`, …) already round-trip through serde on
//! their way to the MCP client, so re-typing them here would buy nothing but a
//! second place to keep in sync.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped when a request or response shape changes incompatibly.
///
/// The desktop app and the sidecar are built from the same source but installed
/// as separate files, and a packaged install updates them together — except in
/// the one case that matters: a user who built `huginndb-mcp` from source
/// before this, or whose MCP client is still holding an old sidecar process
/// alive across an app update (the exact situation gotcha #23's installer hook
/// exists for). A mismatch must degrade to the local-pool fallback, not to a
/// deserialisation error mid-tool-call.
///
/// `2`: [`BridgeResponse::ok`] started wrapping its payload in [`OkWrapper`]
/// instead of carrying a bare `Option<Value>`, fixing a bug where a
/// legitimate `Value::Null` success (e.g. `EnsureConnected`, or `insert_row`
/// with no primary key to report) collapsed to indistinguishable-from-absent
/// on the old wire shape and was misreported as "empty reply". An old
/// sidecar's client can't parse the new `{"ok":{"value":…}}` shape as success
/// — bumping this forces that mismatch through the handshake version check
/// below, not into a silent misparse mid-call.
///
/// `3`: [`BridgeRequest`] gained `CreateMongoIndex` / `DropMongoIndex`. Adding a
/// variant looks additive, and for the *reply* direction it is — but an old app
/// cannot deserialise a request method it has never heard of, and that failure
/// arrives as an error reply rather than as [`crate::bridge::client::BridgeError::Unreachable`],
/// so the sidecar would surface it to the AI client instead of falling back to
/// its own pool. The handshake check is the only place that mismatch degrades
/// correctly, so every new request variant bumps this.
///
/// `4`: [`BridgeRequest`] gained `RunWriteBatch` (the `run_writes` tool).
///
/// `5`: [`BridgeRequest`] gained `RunScript` (the `run_script` tool).
pub const PROTOCOL_VERSION: u32 = 5;

/// Opening frame. Sent once, before any request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol_version: u32,
    pub token: String,
    /// The connection ids this client is allowed to reach — its own
    /// `--connections` allowlist, forwarded so the app can enforce it too.
    ///
    /// Advisory with respect to a *hostile* token-holder, which would simply
    /// declare everything; the per-connection write policy the server re-checks
    /// from disk is the authoritative gate. What this buys is that an honest
    /// sidecar cannot accidentally widen its own exposure by reaching a profile
    /// the user never named.
    #[serde(default)]
    pub allowed: Vec<String>,
    /// When true, `allowed` is only this client's startup snapshot and the app
    /// should authorize against `ConnectionProfile::mcp_exposed` instead,
    /// re-read on every request.
    ///
    /// Set whenever the sidecar was started without an explicit
    /// `--connections` list, which is the normal case now that the exposed set
    /// is picked in Settings → MCP. It is what makes ticking a connection there
    /// take effect in a client that is already running: without it the app
    /// would keep enforcing the snapshot taken when that client started, and
    /// the checkbox would appear to do nothing until the user restarted it.
    ///
    /// Additive, and deliberately **not** a `PROTOCOL_VERSION` bump: an app
    /// that predates the field ignores it and enforces `allowed`, which is the
    /// old behaviour rather than a refusal — and a refusal is the one outcome
    /// the sidecar cannot degrade from gracefully, since it arrives as an error
    /// reply mid-tool-call instead of as
    /// [`crate::bridge::client::BridgeError::Unreachable`]. An old *sidecar*
    /// never sets it and a current app then reads `false`, which is exactly
    /// what that sidecar means.
    #[serde(default)]
    pub defer_exposure: bool,
}

/// Reply to [`Hello`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAck {
    pub protocol_version: u32,
    /// `None` on success; a reason on refusal (bad token, version mismatch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One proxied data-path call.
///
/// Field names mirror the `_inner` signatures exactly so the dispatch is a
/// transcription rather than a translation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum BridgeRequest {
    /// Open (or reuse) the pool for a connection. Always the first call for a
    /// given connection — it is what moves pool ownership to the app.
    EnsureConnected {
        connection_id: String,
    },
    /// Resolve a Mongo per-database view, returning the id to address.
    ResolveMongoTarget {
        connection_id: String,
        database: String,
    },
    /// Whether the resolved connection is a MongoDB one. Needed by the
    /// sidecar's `run_query` to pick a statement classifier, and it must be
    /// answered by whoever owns the pool.
    IsMongo {
        connection_id: String,
    },
    ListDatabases {
        connection_id: String,
    },
    ListTables {
        connection_id: String,
    },
    GetTableStructure {
        connection_id: String,
        schema: Option<String>,
        table: String,
    },
    ListIndexes {
        connection_id: String,
        schema: Option<String>,
        table: String,
    },
    ServerVersion {
        connection_id: String,
    },
    ListUsers {
        connection_id: String,
    },
    ListPrivileges {
        connection_id: String,
        user: String,
    },
    /// One read of a connection's vital signs. See `crate::pulse`.
    PulseHealth {
        connection_id: String,
    },
    /// One metric's stored history from `pulse.db`, oldest first. Answered by
    /// whoever owns `AppState.pulse_store` — the same host either way, since
    /// unlike every other request here it needs no live pool at all.
    PulseMetrics {
        connection_id: String,
        metric: String,
        since_ms: i64,
    },
    /// Statements the server has spent the most time on.
    PulseTopQueries {
        connection_id: String,
    },
    /// The plan the server would use for one statement, without running it.
    /// `sample` is validated read-only, single-statement, and not itself an
    /// `EXPLAIN`/`ANALYZE` by `commands::pulse::validate_explain_target`
    /// before either driver ever sees it.
    PulseExplain {
        connection_id: String,
        sample: String,
    },
    /// The connection's biggest relations, largest first.
    PulseStorage {
        connection_id: String,
    },
    /// Every session or operation currently open on the server.
    PulseSessions {
        connection_id: String,
    },
    /// Index usage across the connection's biggest relations, least-read
    /// first.
    PulseIndexUsage {
        connection_id: String,
    },
    /// Read a view's definition. SQL drivers answer with the body; MongoDB with
    /// `viewOn` plus the stored pipeline as source text.
    GetViewDefinition {
        connection_id: String,
        schema: Option<String>,
        view: String,
    },
    /// Execute one statement. `class` is the tier the sidecar classified it as;
    /// the server re-derives it rather than trusting it (see
    /// [`crate::bridge`]'s security notes) and uses the caller's value only to
    /// cross-check.
    RunStatement {
        connection_id: String,
        /// The *profile* id the policy applies to, which for a Mongo
        /// per-database view differs from `connection_id`.
        policy_id: String,
        sql: String,
    },
    /// Run several row writes as one transaction — the `run_writes` tool.
    ///
    /// Its own variant rather than a loop of [`BridgeRequest::RunStatement`]s,
    /// because the loop cannot keep the promise: each `RunStatement` takes a
    /// connection from the pool, so the writes would land on whichever sessions
    /// were free and no transaction could span them. One request is one
    /// session and one `BEGIN … COMMIT`.
    ///
    /// Writes only. The tool's `verify` reads are sent afterwards as ordinary
    /// `RunStatement`s, so they keep the read-only transaction every AI read
    /// runs in (ADR #93) instead of running inside a write transaction where a
    /// misclassified write would execute.
    RunWriteBatch {
        connection_id: String,
        policy_id: String,
        writes: Vec<crate::commands::write_batch::BatchWrite>,
    },
    /// Run a whole SQL script on one session — the `run_script` tool
    /// (ADR #121).
    ///
    /// Its own variant for the reason [`BridgeRequest::RunWriteBatch`] is: a
    /// loop of `RunStatement`s lands on whichever pooled sessions are free, so
    /// a temporary table made by one statement is not there for the next. The
    /// script travels as text — the sidecar reads a `path` itself, so the app
    /// never opens a file on a bridge client's say-so.
    RunScript {
        connection_id: String,
        policy_id: String,
        sql: String,
        transaction: bool,
        /// Rows kept across every read in the script: the sidecar's own cap,
        /// applied where the rows are fetched rather than after they crossed.
        max_rows: usize,
    },
    FetchTableData {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        limit: i64,
        offset: i64,
        with_count: Option<bool>,
    },
    InsertRow {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_column: Option<String>,
        values: Value,
    },
    UpdateCell {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_columns: Vec<String>,
        pk_values: Vec<Value>,
        column: String,
        value: Option<String>,
        column_type: Option<String>,
    },
    DeleteRows {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        table: String,
        pk_columns: Vec<String>,
        pk_value_rows: Vec<Vec<Value>>,
    },
    /// Build the statements a view change would run, without running them.
    ///
    /// Split from [`BridgeRequest::ApplyViewChange`] rather than sharing one
    /// variant with a `preview: bool`, even though the two carry identical
    /// fields and the MCP tool exposing them is single. A shared variant would
    /// force [`BridgeRequest::is_mutating`] and the server's policy check to
    /// read a *field* to decide whether this is a read or DDL, and a later
    /// refactor that drops that binding would grant DDL at `read-only` with
    /// nothing failing to compile. Two variants put the decision in the
    /// exhaustive matches, which is the reason this enum mirrors its `_inner`
    /// functions one-for-one in the first place.
    PreviewViewChange {
        connection_id: String,
        /// The *profile* id the policy applies to, which for a Mongo
        /// per-database view differs from `connection_id`.
        policy_id: String,
        schema: Option<String>,
        name: String,
        /// SQL: the view body. MongoDB: the pipeline as source text.
        query: String,
        rename_from: Option<String>,
        view_on: Option<String>,
    },
    /// Create, redefine or rename a view. Fields identical to
    /// [`BridgeRequest::PreviewViewChange`]; see there for why they are two
    /// variants.
    ApplyViewChange {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        name: String,
        query: String,
        rename_from: Option<String>,
        view_on: Option<String>,
    },
    DropView {
        connection_id: String,
        policy_id: String,
        schema: Option<String>,
        view: String,
    },
    /// Create one index on a MongoDB collection.
    ///
    /// MongoDB-only by design: on the SQL drivers an index is created by
    /// `CREATE INDEX`, which `run_query` already reaches at the `full` tier and
    /// which is strictly more expressive than any portable DTO (`USING gin`,
    /// `INCLUDE`, a partial predicate). The mongosh grammar had no such
    /// statement at all until this pass, which is what made a dedicated tool
    /// worth its surface here and nowhere else.
    ///
    /// `spec` mirrors `db::mongo::indexes::NewMongoIndexSpec`: source text for
    /// the key document and the optional documents, plain flags for the rest.
    /// That is the same shape a `ViewDefinition` has, and the reason this
    /// cleared the bar a table-structure tool did not — there is no column
    /// list to synthesise.
    CreateMongoIndex {
        connection_id: String,
        policy_id: String,
        collection: String,
        spec: crate::db::mongo::indexes::NewMongoIndexSpec,
    },
    /// Drop one index from a MongoDB collection. `_id_` is refused by
    /// `db::mongo::indexes::drop_index`, not here.
    DropMongoIndex {
        connection_id: String,
        policy_id: String,
        collection: String,
        name: String,
    },
}

impl BridgeRequest {
    /// Whether this call can change data on the server.
    ///
    /// Drives the sidecar's no-retry rule: a transport failure on a mutating
    /// call must never be retried against a local pool, because the write may
    /// already have landed and only the reply was lost.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    pub fn is_mutating(&self) -> bool {
        match self {
            // `RunStatement` carries arbitrary SQL, so it is treated as
            // mutating regardless of what it looks like — the classifier lives
            // on the other side, and guessing here would be exactly the kind of
            // cleverness that double-writes.
            BridgeRequest::RunStatement { .. }
            | BridgeRequest::RunWriteBatch { .. }
            | BridgeRequest::RunScript { .. }
            | BridgeRequest::InsertRow { .. }
            | BridgeRequest::UpdateCell { .. }
            | BridgeRequest::DeleteRows { .. }
            | BridgeRequest::ApplyViewChange { .. }
            | BridgeRequest::DropView { .. }
            | BridgeRequest::CreateMongoIndex { .. }
            | BridgeRequest::DropMongoIndex { .. } => true,
            BridgeRequest::EnsureConnected { .. }
            | BridgeRequest::ResolveMongoTarget { .. }
            | BridgeRequest::IsMongo { .. }
            | BridgeRequest::ListDatabases { .. }
            | BridgeRequest::ListTables { .. }
            | BridgeRequest::GetTableStructure { .. }
            | BridgeRequest::ListIndexes { .. }
            | BridgeRequest::ServerVersion { .. }
            | BridgeRequest::ListUsers { .. }
            | BridgeRequest::ListPrivileges { .. }
            | BridgeRequest::PulseHealth { .. }
            | BridgeRequest::PulseMetrics { .. }
            | BridgeRequest::PulseTopQueries { .. }
            | BridgeRequest::PulseExplain { .. }
            | BridgeRequest::PulseStorage { .. }
            | BridgeRequest::PulseSessions { .. }
            | BridgeRequest::PulseIndexUsage { .. }
            | BridgeRequest::FetchTableData { .. }
            | BridgeRequest::GetViewDefinition { .. }
            // A dry run executes nothing, so a lost reply costs at most a
            // repeated build.
            | BridgeRequest::PreviewViewChange { .. } => false,
        }
    }

    /// Short label for the Console entry the app logs when it serves this.
    pub fn label(&self) -> &'static str {
        match self {
            BridgeRequest::EnsureConnected { .. } => "ensure_connected",
            BridgeRequest::ResolveMongoTarget { .. } => "resolve_mongo_target",
            BridgeRequest::IsMongo { .. } => "is_mongo",
            BridgeRequest::ListDatabases { .. } => "list_databases",
            BridgeRequest::ListTables { .. } => "list_tables",
            BridgeRequest::GetTableStructure { .. } => "get_table_structure",
            BridgeRequest::ListIndexes { .. } => "list_indexes",
            BridgeRequest::ServerVersion { .. } => "server_version",
            BridgeRequest::ListUsers { .. } => "list_users",
            BridgeRequest::ListPrivileges { .. } => "list_privileges",
            BridgeRequest::PulseHealth { .. } => "pulse_health",
            BridgeRequest::PulseMetrics { .. } => "pulse_metrics",
            BridgeRequest::PulseTopQueries { .. } => "pulse_top_queries",
            BridgeRequest::PulseExplain { .. } => "pulse_explain",
            BridgeRequest::PulseStorage { .. } => "pulse_storage",
            BridgeRequest::PulseSessions { .. } => "pulse_sessions",
            BridgeRequest::PulseIndexUsage { .. } => "pulse_index_usage",
            BridgeRequest::RunStatement { .. } => "run_query",
            BridgeRequest::RunWriteBatch { .. } => "run_writes",
            BridgeRequest::RunScript { .. } => "run_script",
            BridgeRequest::FetchTableData { .. } => "browse_table",
            BridgeRequest::InsertRow { .. } => "insert_row",
            BridgeRequest::UpdateCell { .. } => "update_cell",
            BridgeRequest::DeleteRows { .. } => "delete_rows",
            BridgeRequest::GetViewDefinition { .. } => "get_view_definition",
            // Preview and apply deliberately do not share a label: this string
            // is what the desktop Console shows, and a Console that cannot tell
            // a dry run from a real `DROP VIEW` is worse than none.
            BridgeRequest::PreviewViewChange { .. } => "save_view (preview)",
            BridgeRequest::ApplyViewChange { .. } => "save_view",
            BridgeRequest::DropView { .. } => "drop_view",
            BridgeRequest::CreateMongoIndex { .. } => "create_index",
            BridgeRequest::DropMongoIndex { .. } => "drop_index",
        }
    }
}

/// A successful reply's payload, wrapped one level deeper than a bare
/// `Value` so `Option<OkWrapper>` survives the wire roundtrip even when
/// `value` is itself `Value::Null`.
///
/// `Option<Value>` cannot make that distinction: `serde_json` collapses any
/// `null` token to `None` on deserialisation regardless of what type it's
/// wrapped in, so a genuine success carrying `Value::Null` (e.g.
/// `EnsureConnected`, or `insert_row` with no primary key to report) was
/// indistinguishable from the key being absent entirely — misreported as
/// "empty reply" (`BridgeClient::call`'s `(None, None)` arm) even though the
/// call had, in fact, succeeded. `OkWrapper` itself is never `null` at the
/// wire's top level — only its `value` field can be — so `Option<OkWrapper>`
/// round-trips correctly no matter what `value` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkWrapper {
    pub value: Value,
}

/// One reply. Exactly one of the two fields is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<OkWrapper>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

impl BridgeResponse {
    pub fn ok(value: Value) -> Self {
        Self {
            ok: Some(OkWrapper { value }),
            err: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: None,
            err: Some(message.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_multiline_view_body_survives_the_newline_framing() {
        // `ApplyViewChange` is the first request whose payload routinely
        // contains newlines, and the framing is newline-delimited JSON. serde
        // escapes them as `\n`, so this works — but nothing pinned it, and a
        // desync would present as the bridge hanging or misparsing an unrelated
        // later call rather than as a failure here.
        let req = BridgeRequest::ApplyViewChange {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: Some("public".into()),
            name: "active_orders".into(),
            query: "SELECT id,\n       name\n  FROM t\n WHERE ok".into(),
            rename_from: None,
            view_on: None,
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(
            !line.contains('\n'),
            "framing would desynchronise: {line:?}"
        );

        let back: BridgeRequest = serde_json::from_str(&line).unwrap();
        match back {
            BridgeRequest::ApplyViewChange { query, .. } => {
                assert_eq!(query, "SELECT id,\n       name\n  FROM t\n WHERE ok")
            }
            other => panic!("wrong variant: {}", other.label()),
        }
    }

    #[test]
    fn requests_round_trip_through_the_wire_format() {
        let req = BridgeRequest::UpdateCell {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: Some("public".into()),
            table: "t".into(),
            pk_columns: vec!["id".into()],
            pk_values: vec![Value::from(1)],
            column: "name".into(),
            value: Some("x".into()),
            column_type: None,
        };
        let line = serde_json::to_string(&req).unwrap();
        let back: BridgeRequest = serde_json::from_str(&line).unwrap();
        assert!(matches!(back, BridgeRequest::UpdateCell { .. }));
        // Single-line: the framing is newline-delimited, so an embedded newline
        // in the encoding would desynchronise the stream.
        assert!(!line.contains('\n'));
    }

    #[test]
    fn a_null_success_payload_round_trips_as_ok_not_empty_reply() {
        // Regression test for the bug where `Value::Null` — a legitimate
        // success payload (`EnsureConnected`, or `insert_row` with no PK to
        // report) — collapsed to an absent key through `Option<Value>`'s
        // serde roundtrip, making a real success indistinguishable from
        // "empty reply" on the client side (`BridgeClient::call`'s
        // `(None, None)` arm).
        let response = BridgeResponse::ok(Value::Null);
        let line = serde_json::to_string(&response).unwrap();

        // The wire form must still carry an `ok` key even though the payload
        // inside it is null.
        assert!(line.contains("\"ok\""), "expected an `ok` key in {line:?}");

        let back: BridgeResponse = serde_json::from_str(&line).unwrap();
        assert!(
            back.ok.is_some(),
            "a Value::Null success must deserialize as Some(..), not None: {line:?}"
        );
        assert_eq!(back.ok.unwrap().value, Value::Null);
        assert!(back.err.is_none());
    }

    #[test]
    fn every_write_path_is_marked_mutating() {
        // The no-retry rule depends on this being right; a read misclassified
        // as mutating merely loses a fallback, but a write misclassified as a
        // read can double-apply.
        for req in [
            BridgeRequest::RunStatement {
                connection_id: "c".into(),
                policy_id: "c".into(),
                sql: "SELECT 1".into(),
            },
            BridgeRequest::InsertRow {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_column: None,
                values: Value::Null,
            },
            BridgeRequest::DeleteRows {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_columns: vec![],
                pk_value_rows: vec![],
            },
            BridgeRequest::ApplyViewChange {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                name: "v".into(),
                query: "SELECT 1".into(),
                rename_from: None,
                view_on: None,
            },
            BridgeRequest::DropView {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                view: "v".into(),
            },
            BridgeRequest::RunWriteBatch {
                connection_id: "c".into(),
                policy_id: "c".into(),
                writes: vec![],
            },
            BridgeRequest::RunScript {
                connection_id: "c".into(),
                policy_id: "c".into(),
                sql: "SELECT 1".into(),
                transaction: true,
                max_rows: 1,
            },
        ] {
            assert!(req.is_mutating(), "{} must be mutating", req.label());
        }
        assert!(!BridgeRequest::ListTables {
            connection_id: "c".into()
        }
        .is_mutating());
        // A dry run executes nothing, so losing its reply is safe to retry.
        assert!(!BridgeRequest::PreviewViewChange {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            name: "v".into(),
            query: "SELECT 1".into(),
            rename_from: None,
            view_on: None,
        }
        .is_mutating());
        assert!(!BridgeRequest::GetViewDefinition {
            connection_id: "c".into(),
            schema: None,
            view: "v".into(),
        }
        .is_mutating());
    }

    #[test]
    fn preview_and_apply_do_not_share_a_console_label() {
        // The label is what the desktop Console shows for a bridged call. A
        // Console that cannot tell a dry run from a real `DROP VIEW` is worse
        // than none, so these two must stay distinguishable.
        let preview = BridgeRequest::PreviewViewChange {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            name: "v".into(),
            query: "SELECT 1".into(),
            rename_from: None,
            view_on: None,
        };
        let apply = BridgeRequest::ApplyViewChange {
            connection_id: "c".into(),
            policy_id: "c".into(),
            schema: None,
            name: "v".into(),
            query: "SELECT 1".into(),
            rename_from: None,
            view_on: None,
        };
        assert_ne!(preview.label(), apply.label());
    }
}
