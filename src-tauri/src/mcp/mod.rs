//! Headless MCP (Model Context Protocol) connector.
//!
//! Exposes the databases HuginnDB already knows about (from `profiles.json` +
//! the OS keychain) to an MCP client — Claude Code, Claude Desktop, Cursor, …
//! — over stdio, so an AI assistant can inspect real schema and data instead
//! of guessing. See `docs/MCP_CONNECTOR_ROADMAP.md`.
//!
//! Design (roadmap Option A — headless stdio twin):
//!
//! * **Reuses the desktop backend wholesale.** Every tool delegates to the
//!   same `_inner` data-path functions the Tauri commands call
//!   ([`crate::commands`]); the MCP surface adds no new SQL. Reads go through a
//!   [`NoopSink`]; writes go through an [`AuditSink`] that appends to
//!   `mcp-audit.log`.
//! * **Writes gated by a per-connection policy.** Each exposed connection
//!   carries a saved [`McpWritePolicy`] (`read-only` / `data` / `full`,
//!   default `read-only`), edited in the app's Settings → MCP and persisted in
//!   `profiles.json`. The sidecar re-reads it **fresh from disk on every write
//!   attempt** ([`Huginn::write_policy`]), so changing a connection's level in
//!   the app takes effect without restarting the MCP client. `run_query`
//!   classifies each statement ([`crate::db::sql::classify`]) and the
//!   structured write tools (`insert_row` / `update_cell` / `delete_rows`)
//!   require at least `data`; DDL requires `full`. A global `--read-only`
//!   kill-switch forces read-only regardless of saved policy. (The old
//!   `--allow-writes` flag is deprecated and inert.)
//! * **Opt-in per profile.** Nothing is reachable until the user ticks a
//!   connection in the app's Settings → MCP, which sets
//!   [`crate::state::ConnectionProfile::mcp_exposed`]; like the write policy,
//!   it is re-read from disk per call, so the choice takes effect without
//!   restarting the MCP client. A `--connections id1,id2` argument still pins
//!   an explicit set for one client, and wins when present.
//! * **Addressed by name.** Every tool takes the connection's *name* or its
//!   profile id ([`Huginn::canonical_connection`]); the uuid is an internal
//!   identity the user never chose and should not have to see.
//! * **Lazy pools.** No database is touched until a tool call names a
//!   connection; the pool is then opened via [`crate::db::pool::open_pool`]
//!   (password from the keychain) and cached in the shared [`AppState`]. It is
//!   a separate process from the running desktop app — it does not share the
//!   GUI's live pools.
//! * **Row cap.** `--max-rows` (default [`DEFAULT_MAX_ROWS`]) bounds how many
//!   rows a single `run_query` / `browse_table` call can return, so a tool
//!   call can't dump a whole table into the model's context.

pub mod delegate;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt};
use serde::Deserialize;

use crate::bridge::protocol::BridgeRequest;
use crate::db::sql::{StmtClass, Verbs};
use crate::error::AppResult;
use crate::log_bus::{LogEntry, LogSink, NoopSink};
use crate::state::{ActivePool, AppState, McpWritePolicy};

/// Default cap on rows returned by a single `run_query` / `browse_table` call.
const DEFAULT_MAX_ROWS: i64 = 1000;

/// Default pool ceiling per exposed connection, overridable with
/// `--max-connections`.
///
/// Deliberately far below the desktop app's default. This process is one of
/// *several* clients competing for the same server: the user is also running
/// the HuginnDB GUI, very likely a JetBrains data source, quite possibly an
/// application backend with its own pool — and one of these sidecars per MCP
/// client, since each spawns its own. Inheriting the GUI's budget meant a user
/// with Claude Code and Claude Desktop configured silently added two more
/// five-connection budgets that nothing in the product disclosed.
///
/// Two is enough by construction: MCP is request/response over stdio and tools
/// are dispatched one at a time, so the second slot only ever covers an
/// overlapping keepalive-style probe. It is also
/// [`crate::db::pool::MIN_MAX_CONNECTIONS`], the floor below which a pool stops
/// being safely usable.
const DEFAULT_MAX_CONNECTIONS: u32 = 2;

/// How long a pool may go untouched before this process closes it.
///
/// The sidecar is long-lived — it lives as long as the MCP client keeps it,
/// which is days — but its *work* is bursty: a few tool calls, then nothing
/// until the user asks the model something else. Before 1.13.0 nothing ever
/// removed a pool once opened, so a single question at 09:00 held a pool for
/// the rest of the week.
///
/// Unlike the desktop app, this reaper closes **top-level** pools too. There is
/// no user watching a connection indicator here and nothing to invalidate;
/// `ensure_connected` transparently reopens on the next call, at the cost of
/// one connect.
///
/// Derived from [`crate::db::pool::MCP_IDLE_TTL`] rather than stated, so that a
/// connector-driven connection is released on the same schedule whichever
/// process is holding it — see ADR #67 for what their divergence cost.
const POOL_IDLE_TTL: Duration = crate::db::pool::MCP_IDLE_TTL;

/// How often the idle-pool sweep runs.
const POOL_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Which of the two statement tools a call arrived through.
///
/// `run_query` and `run_write` share one executor and differ only in the tier
/// they admit — see [`Huginn::run_statement`] for why they are two tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatementKind {
    Read,
    Write,
}

/// Runtime configuration parsed from the process arguments.
struct Config {
    /// Profile ids pinned on the command line with `--connections`, or `None`
    /// when the flag was absent and exposure is therefore the *app's* to
    /// decide (`ConnectionProfile::mcp_exposed`, ticked in Settings → MCP and
    /// re-read fresh on every call).
    ///
    /// Three states, all load-bearing. `None` defers to disk — the normal case
    /// now, and what lets the client's command be a bare `huginndb-mcp` with no
    /// uuids in it. `Some(set)` pins exactly that set for the life of the
    /// process: an argument the user typed outranks a checkbox, and every
    /// pre-1.21 client config keeps behaving exactly as it did. `Some(empty)`
    /// — `--connections ""` — is an explicit "expose nothing", which is *not*
    /// the same as `None` and must not collapse into it.
    ///
    /// Opt-in survives either way: a profile is exposed only if the user ticked
    /// it or named it, and `mcp_exposed` defaults to `false` on every profile
    /// that predates the field.
    pinned: Option<HashSet<String>>,
    /// Global read-only kill-switch (`--read-only`). When set, every
    /// connection is forced to [`McpWritePolicy::ReadOnly`] regardless of its
    /// saved per-connection policy — a way to expose the sidecar in a
    /// guaranteed-safe mode without editing any profile. Default `false`
    /// (the per-connection policy governs).
    read_only: bool,
    /// Upper bound on rows returned per call.
    max_rows: i64,
    /// Pool ceiling per exposed connection (`--max-connections`). See
    /// [`DEFAULT_MAX_CONNECTIONS`] for why this process defaults lower than
    /// the desktop app. A profile that pins its own
    /// [`crate::state::ConnectionProfile::max_connections`] still wins when it
    /// is the *smaller* of the two — the flag raises the sidecar's own default,
    /// it never overrides a limit the user recorded against the server.
    max_connections: u32,
    /// Whether the deprecated `--allow-writes` flag was seen, so `serve` can
    /// emit a one-time deprecation notice. It no longer grants anything — the
    /// per-connection [`McpWritePolicy`] (Settings → MCP) is the sole authority.
    saw_allow_writes: bool,
}

impl Config {
    /// Whether `profile` is reachable through this server.
    ///
    /// The exposure rule, in one place: a `--connections` list the user typed
    /// wins outright, and otherwise the answer is the profile's own
    /// `mcp_exposed` flag from Settings → MCP. Lives on `Config` rather than on
    /// `Huginn` because [`serve`] has to answer the same question for its
    /// startup banner and the bridge handshake, before any `Huginn` exists.
    fn exposes(&self, profile: &crate::state::ConnectionProfile) -> bool {
        match &self.pinned {
            Some(ids) => ids.contains(&profile.id),
            None => profile.mcp_exposed,
        }
    }

    /// Parse `--connections a,b,c`, `--read-only`, `--max-rows N`, and the
    /// deprecated `--allow-writes` from `argv` (program name at index 0).
    /// Accepts both `--flag value` and `--flag=value`, mirroring the desktop
    /// CLI parser.
    fn from_args(argv: &[String]) -> Self {
        let mut pinned: Option<HashSet<String>> = None;
        let mut read_only = false;
        let mut max_rows = DEFAULT_MAX_ROWS;
        let mut max_connections = DEFAULT_MAX_CONNECTIONS;
        let mut saw_allow_writes = false;

        let args: Vec<String> = argv.iter().skip(1).cloned().collect();
        let mut iter = args.iter().peekable();
        while let Some(raw) = iter.next() {
            let (flag, inline) = match raw.split_once('=') {
                Some((f, v)) => (f, Some(v.to_string())),
                None => (raw.as_str(), None),
            };
            let value =
                |iter: &mut std::iter::Peekable<std::slice::Iter<'_, String>>| -> Option<String> {
                    inline.clone().or_else(|| iter.next().cloned())
                };
            match flag {
                "--connections" | "--connection" => {
                    if let Some(v) = value(&mut iter) {
                        // Seeing the flag at all pins the set, even when the
                        // value is empty: `--connections ""` means "expose
                        // nothing", which has to stay distinguishable from
                        // omitting the flag and deferring to the app.
                        let set = pinned.get_or_insert_with(HashSet::new);
                        for id in v.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                            set.insert(id.to_string());
                        }
                    }
                }
                "--read-only" | "--readonly" => {
                    // Bare `--read-only` means true; `--read-only=false` is
                    // honoured for explicit config files.
                    read_only =
                        !matches!(inline.as_deref(), Some("false") | Some("0") | Some("no"));
                }
                "--allow-writes" => {
                    // Deprecated and inert: writes are now governed per
                    // connection by the saved `McpWritePolicy`. Consume any
                    // attached value so it isn't mis-parsed as a positional.
                    let _ = inline;
                    saw_allow_writes = true;
                }
                "--max-rows" => {
                    if let Some(v) = value(&mut iter).and_then(|v| v.parse::<i64>().ok()) {
                        if v > 0 {
                            max_rows = v;
                        }
                    }
                }
                "--max-connections" => {
                    if let Some(v) = value(&mut iter).and_then(|v| v.parse::<u32>().ok()) {
                        if v > 0 {
                            max_connections = v;
                        }
                    }
                }
                _ => {}
            }
        }

        Config {
            pinned,
            read_only,
            max_rows,
            max_connections,
            saw_allow_writes,
        }
    }
}

/// Deserialize an optional integer that may arrive as a JSON number *or* a
/// numeric string. Some MCP clients serialize `limit`/`offset` arguments as
/// strings despite the tool schema advertising `integer` — accepting either
/// keeps `browse_table` usable instead of hard-rejecting a client's
/// serialization quirk with an opaque deserialization error.
fn lenient_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrString {
        Num(i64),
        Str(String),
    }
    match Option::<NumOrString>::deserialize(deserializer)? {
        None => Ok(None),
        Some(NumOrString::Num(n)) => Ok(Some(n)),
        Some(NumOrString::Str(s)) => s
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

/// Tool-argument shapes. Each derives [`Deserialize`] (so the `Parameters`
/// wrapper can parse the JSON-RPC `arguments`) and `JsonSchema` via rmcp's
/// re-exported `schemars` (so the tool advertises a schema to the client).
mod args {
    use super::Deserialize;

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Connection {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Tables {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// For MongoDB only: the database to list collections from, when the
        /// connection has no database bound; see [`Table::schema`]. Ignored
        /// for SQL drivers (a connection is already bound to one database).
        #[serde(default)]
        pub schema: Option<String>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Table {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Schema / namespace. Omit for the driver default (Postgres
        /// `public`, MySQL current database, SQLite `main`). For MongoDB,
        /// this is the **database name** — required when the connection has
        /// no database bound (see `list_connections`' `database` field);
        /// opens (or reuses) a per-database view automatically.
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Query {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// A single read-only statement: SQL (SELECT / WITH / SHOW / EXPLAIN
        /// / PRAGMA) for Postgres/MySQL/SQLite, or mongosh syntax
        /// (`db.<collection>.find({...})`) for MongoDB. Rejected otherwise
        /// unless the server runs with `--allow-writes`.
        pub sql: String,
        /// MongoDB only: the database `sql`'s `db.<collection>...` should
        /// target, when the connection has no database bound (see
        /// `list_connections`' `database` field). Ignored for SQL drivers.
        #[serde(default)]
        pub database: Option<String>,
    }

    // The batch tools' doc comments are their schema descriptions, sent to the
    // client in `tools/list` and carried in its context for the whole session:
    // kept short on purpose, since saving tokens is what these tools are for.

    /// Arguments for `run_queries`.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Queries {
        /// Connection name (or id) from `list_connections`.
        pub connection_id: String,
        /// Read-only statements, each run as `run_query` would. Results come
        /// back in the same order.
        pub queries: Vec<String>,
        /// MongoDB only: database to target when the connection has none
        /// bound.
        #[serde(default)]
        pub database: Option<String>,
    }

    /// One entry of `run_writes`.
    ///
    /// `#[schemars(inline)]` for the reason [`RowValueArg`] gives (issue #83).
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    #[schemars(inline)]
    pub struct WriteArg {
        /// One INSERT / UPDATE / DELETE (or MongoDB insert/update/replace/
        /// delete).
        pub sql: String,
        /// Rows this write must affect; any other count rolls back the whole
        /// batch.
        #[serde(default)]
        pub expect_rows: Option<u64>,
    }

    /// Arguments for `run_writes`.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Writes {
        /// Connection name (or id) from `list_connections`.
        pub connection_id: String,
        /// Row writes, applied in order inside one transaction.
        pub writes: Vec<WriteArg>,
        /// Read-only statements run after the commit, to check the result in
        /// the same call. Results come back in the same order.
        #[serde(default)]
        pub verify: Vec<String>,
        /// MongoDB only: database to target when the connection has none
        /// bound.
        #[serde(default)]
        pub database: Option<String>,
    }

    /// Arguments for `run_script`.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Script {
        /// Connection name (or id) from `list_connections`. SQL only.
        pub connection_id: String,
        /// The script: statements separated by `;` (T-SQL `GO` lines work
        /// too). Give this or `path`, not both.
        #[serde(default)]
        pub sql: Option<String>,
        /// Absolute path of a local `.sql` file to run instead of `sql` —
        /// the script never has to pass through the conversation.
        #[serde(default)]
        pub path: Option<String>,
        /// Wrap the script in one transaction (default true): all of it
        /// lands or none does. false runs it as written, its own
        /// BEGIN/COMMIT included.
        #[serde(default)]
        pub transaction: Option<bool>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Browse {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Schema / namespace. For MongoDB, this is the **database name** —
        /// required when the connection has no database bound; see
        /// [`Table::schema`].
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Max rows to return this page. Clamped to the server's `--max-rows`.
        /// Accepts a JSON number, or (leniently) a numeric string — some MCP
        /// clients serialize integer arguments as strings.
        #[serde(default, deserialize_with = "super::lenient_opt_i64")]
        pub limit: Option<i64>,
        /// Rows to skip (pagination offset). Same lenient number parsing as
        /// `limit`.
        #[serde(default, deserialize_with = "super::lenient_opt_i64")]
        pub offset: Option<i64>,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct Privileges {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// User/role as returned by `list_users` (MySQL: `user@host`).
        pub user: String,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct PulseMetrics {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Canonical metric name from Pulse's catalogue (`pulse_health`'s
        /// reply lists which ones this connection's engine reports), e.g.
        /// `"queries"`, `"connections_active"`.
        pub metric: String,
        /// Only points at or after this epoch-millisecond timestamp.
        pub since_ms: i64,
    }

    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct PulseExplain {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// One runnable statement to EXPLAIN — a `pulse_top_queries` row's
        /// own `sample` field in practice. Must be read-only and a single
        /// statement; rejected otherwise, same as `run_query`.
        pub sample: String,
        /// MongoDB only: the database `sample`'s `db.<collection>...` should
        /// target, when the connection has no database bound. Ignored for
        /// SQL drivers. Same field `run_query` takes for the same reason.
        #[serde(default)]
        pub database: Option<String>,
    }

    /// Hand-written schema for a PK scalar value: a JSON string, number,
    /// boolean or null. `serde_json::Value`'s derived schema is the bare
    /// boolean `true` ("matches anything") — valid JSON Schema, but some MCP
    /// clients' `tools/list` ingestion assumes every (sub-)schema node is an
    /// object and chokes on it, silently dropping every tool for that
    /// session (see CHANGELOG / issue #83). This constrains the advertised
    /// shape to what a PK value actually is without touching the Rust type
    /// (still `serde_json::Value` end-to-end, so deserialization/handlers
    /// are unaffected).
    fn pk_scalar_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": ["string", "number", "boolean", "null"]
        })
    }

    fn pk_values_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let item = pk_scalar_schema(generator);
        schemars::json_schema!({
            "type": "array",
            "items": item
        })
    }

    fn pk_value_rows_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let item = pk_values_schema(generator);
        schemars::json_schema!({
            "type": "array",
            "items": item
        })
    }

    /// One column/value pair for `insert_row`. Mirrors the desktop
    /// `RowValue` (values travel as text; the driver casts to the column
    /// type). Split out with its own `JsonSchema` so the tool advertises a
    /// schema — the command-layer `RowValue` derives only `Deserialize`.
    ///
    /// `#[schemars(inline)]`: without it, schemars hoists this struct into a
    /// root-level `$defs` entry and references it via `$ref` from
    /// `InsertRow.values`'s `items` — the first `$ref`/`$defs` shape in this
    /// server's `tools/list` output, and (per issue #83) a shape some MCP
    /// clients' schema ingestion doesn't expect. Inlining keeps the object
    /// schema written directly where it's used.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    #[schemars(inline)]
    pub struct RowValueArg {
        /// Column name.
        pub column: String,
        /// Value as text; `null` writes a SQL `NULL`. Omitted columns fall
        /// back to their database default.
        #[serde(default)]
        pub value: Option<String>,
        /// Optional raw column type (e.g. `"BIT"`) so drivers that need
        /// special binding get it right; safe to omit.
        #[serde(default)]
        pub column_type: Option<String>,
    }

    /// Arguments for the `insert_row` write tool.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct InsertRow {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Schema / namespace (see [`Table::schema`]; MongoDB database name).
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// PK column to recover the generated id via `RETURNING` (Postgres);
        /// MySQL/SQLite report the last insert id automatically.
        #[serde(default)]
        pub pk_column: Option<String>,
        /// Columns to populate.
        pub values: Vec<RowValueArg>,
    }

    /// Arguments for the `update_cell` write tool — updates one column of the
    /// single row addressed by the full primary key.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct UpdateCell {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Ordered PK column names (composite keys supported).
        pub pk_columns: Vec<String>,
        /// PK values parallel to `pk_columns`, identifying the one row.
        #[schemars(schema_with = "pk_values_schema")]
        pub pk_values: Vec<serde_json::Value>,
        /// Column to update.
        pub column: String,
        /// New value as text; `null` sets SQL `NULL`.
        #[serde(default)]
        pub value: Option<String>,
        /// Optional raw column type (e.g. `"BIT"`); safe to omit.
        #[serde(default)]
        pub column_type: Option<String>,
    }

    /// Arguments for the `delete_rows` write tool. Each entry in
    /// `pk_value_rows` is one full-PK tuple, parallel to `pk_columns`.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct DeleteRows {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        #[serde(default)]
        pub schema: Option<String>,
        pub table: String,
        /// Ordered PK column names (composite keys supported).
        pub pk_columns: Vec<String>,
        /// One PK-value tuple per row to delete, each parallel to
        /// `pk_columns`.
        #[schemars(schema_with = "pk_value_rows_schema")]
        pub pk_value_rows: Vec<Vec<serde_json::Value>>,
    }

    /// Arguments for the `save_view` write tool — creates, redefines or renames
    /// a view.
    ///
    /// Every field is a plain scalar (`String` / `Option<String>` / `bool`): no
    /// `serde_json::Value`, no nested struct, no `Vec`. That is a design
    /// constraint, not luck — it is why the derived schema needs none of the
    /// hand-written `json_schema!` helpers above, and it is the reason `query`
    /// carries a MongoDB pipeline as *text* rather than as structured JSON (see
    /// its own note).
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct SaveView {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Schema / namespace. Omit for the driver default. For MongoDB this is
        /// the **database name** — required when the connection has no database
        /// bound (see [`Table::schema`]).
        #[serde(default)]
        pub schema: Option<String>,
        /// The view's name after this call.
        pub name: String,
        /// SQL drivers: the view body only — a bare `SELECT ...`, WITHOUT a
        /// surrounding `CREATE VIEW ... AS`, which this tool adds itself.
        ///
        /// MongoDB: the aggregation pipeline as source text, exactly as you
        /// would type it in `mongosh` — `[{ $match: { _id: ObjectId("...") } }]`.
        /// Relaxed JSON with `ObjectId(...)` / `NumberLong(...)` constructors is
        /// accepted and is the only correct way to express those values: plain
        /// JSON would store a string where the view needs an ObjectId, leaving a
        /// view that matches nothing.
        pub query: String,
        /// The view's CURRENT name, when this call is also a rename. Omit
        /// otherwise. You never supply the old body — the tool reads the
        /// existing definition itself. Not supported on MongoDB, which cannot
        /// rename a view.
        #[serde(default)]
        pub rename_from: Option<String>,
        /// MongoDB only: the collection (or view) the pipeline reads from
        /// (`viewOn`). Required when creating a view; when redefining one it
        /// defaults to the existing source. Ignored on SQL drivers.
        #[serde(default)]
        pub view_on: Option<String>,
        /// Dry run: return the exact statements this call would execute (and, on
        /// MongoDB, the pipeline as it would be stored) and run nothing.
        /// Allowed on a read-only connection.
        #[serde(default)]
        pub preview: bool,
    }

    /// Arguments for the `drop_view` write tool.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct DropView {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// Schema / namespace; the **database name** for MongoDB. See
        /// [`Table::schema`].
        #[serde(default)]
        pub schema: Option<String>,
        /// The view to drop, as reported by `list_tables` with `kind: "view"`.
        /// Refused if the name is not a view: on MongoDB a view and a collection
        /// share one namespace, so the catalog is checked before anything is
        /// dropped.
        pub view: String,
    }

    /// Arguments for the `create_index` write tool (MongoDB only).
    ///
    /// **Flat on purpose.** The obvious shape is one nested `spec` object
    /// mirroring `NewMongoIndexSpec`, and `schemars` renders a nested struct as
    /// a `$ref` into `$defs` — which is exactly what made some clients drop
    /// *every* tool from `tools/list` in #83. Every field here is a string,
    /// bool, number or null, and the struct is assembled into the backend DTO
    /// by the tool body.
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct CreateIndex {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// MongoDB database to target on a multi-database connection. See
        /// [`Table::schema`].
        #[serde(default)]
        pub schema: Option<String>,
        /// The collection to index.
        pub collection: String,
        /// The key document, as source text: `{createdAt: -1}`,
        /// `{location: "2dsphere"}`, `{title: "text", body: "text"}`. Relaxed
        /// JSON is accepted (unquoted keys, single quotes, trailing commas), and
        /// key **order matters** — a compound index is only usable in the order
        /// it was declared.
        pub keys: String,
        /// Blank falls back to the `field_1_other_-1` convention MongoDB's own
        /// helpers use.
        #[serde(default)]
        pub name: Option<String>,
        #[serde(default)]
        pub unique: bool,
        #[serde(default)]
        pub sparse: bool,
        /// Create it hidden — invisible to the query planner but fully
        /// maintained. The reversible way to rehearse a drop.
        #[serde(default)]
        pub hidden: bool,
        /// TTL in seconds. Requires a single-field index on a date field.
        #[serde(default)]
        pub expire_after_seconds: Option<i64>,
        /// Partial-index predicate, as source text. Omit for a full index —
        /// `{}` is *not* the same thing, it is a predicate that matches
        /// everything.
        #[serde(default)]
        pub partial_filter_expression: Option<String>,
        /// Collation document, as source text.
        #[serde(default)]
        pub collation: Option<String>,
        /// Per-field weights for a text index, as source text.
        #[serde(default)]
        pub weights: Option<String>,
        /// Default language for a text index.
        #[serde(default)]
        pub default_language: Option<String>,
        /// A source-text document merged into the spec last and allowed to win —
        /// the escape hatch for options with no field above
        /// (`wildcardProjection`, `storageEngine`, …).
        #[serde(default)]
        pub extra_options: Option<String>,
    }

    /// Arguments for the `drop_index` write tool (MongoDB only).
    #[derive(Debug, Deserialize, schemars::JsonSchema)]
    pub struct DropIndex {
        /// The connection to work on: its **name** as shown in HuginnDB
        /// (matched case-insensitively), or its profile id. Both are reported
        /// by `list_connections`; prefer the name.
        pub connection_id: String,
        /// MongoDB database to target on a multi-database connection. See
        /// [`Table::schema`].
        #[serde(default)]
        pub schema: Option<String>,
        pub collection: String,
        /// The index name, exactly as `list_indexes` reports it. `_id_` is
        /// refused — MongoDB maintains it for every collection.
        pub name: String,
    }
}

/// The MCP server. `Clone` (cheap — everything is behind `Arc`) as required by
/// the tool router.
#[derive(Clone)]
pub struct Huginn {
    state: Arc<AppState>,
    /// Link to a running desktop app, when the bridge is enabled and
    /// reachable — attached at startup or on a later call (see
    /// [`crate::bridge::client::BridgeSlot`]). While it has none, this process
    /// owns its own pools, exactly as it did before the bridge existed.
    bridge: Arc<crate::bridge::client::BridgeSlot>,
    config: Arc<Config>,
    tool_router: ToolRouter<Self>,
}

/// Audit entry for a write that was executed by the desktop app on this
/// sidecar's behalf.
///
/// The local path is audited from inside the `_inner` functions, which see the
/// real SQL and row counts. A bridged write is executed elsewhere, so what we
/// can honestly record is the *request we sent* — which is arguably the more
/// useful provenance line for an audit log whose subject is "what did the AI
/// ask for".
fn audit_entry(request: &BridgeRequest, error: Option<&str>) -> LogEntry {
    let mut entry = LogEntry::new(crate::log_bus::LogKind::Sql)
        .message(format!("mcp bridge: {}", request.label()))
        .sql(format!("[via bridge] {}", request.label()));
    if let Some(id) = bridged_connection_id(request) {
        entry = entry.connection_id(id);
    }
    if let Some(e) = error {
        entry = entry.error(e);
    }
    entry
}

/// The connection a bridged write targeted, for the audit line.
fn bridged_connection_id(request: &BridgeRequest) -> Option<String> {
    match request {
        BridgeRequest::RunStatement { policy_id, .. }
        | BridgeRequest::RunWriteBatch { policy_id, .. }
        | BridgeRequest::RunScript { policy_id, .. }
        | BridgeRequest::InsertRow { policy_id, .. }
        | BridgeRequest::UpdateCell { policy_id, .. }
        | BridgeRequest::DeleteRows { policy_id, .. }
        // Not `PreviewViewChange`: a dry run is not audited, so it never
        // reaches here.
        | BridgeRequest::ApplyViewChange { policy_id, .. }
        | BridgeRequest::DropView { policy_id, .. }
        | BridgeRequest::CreateMongoIndex { policy_id, .. }
        | BridgeRequest::DropMongoIndex { policy_id, .. } => Some(policy_id.clone()),
        // Careful when adding a write variant: this arm makes forgetting one a
        // silent `conn=-` in `mcp-audit.log` rather than a compile error.
        _ => None,
    }
}

/// Serialise a backend DTO into a text tool result.
///
/// **Compact, never pretty-printed.** The reader is a model, and every byte of
/// this lands in its context and is billed against the user's plan. Pretty
/// printing put each cell of `rows: [[…]]` on its own indented line, so a
/// result set paid a newline-and-indent run per *cell* — a 50-row, 6-column
/// page came out ~43% larger than the same JSON compact, with nothing gained
/// for a reader that does not need the whitespace to parse it. The AI panel's
/// tool results (`ai::exec`) were already compact for the same reason.
/// Read the `.sql` file `run_script` was pointed at, for the sidecar to send
/// as text (ADR #121).
///
/// Read here, never by the app: the bridge carries the script, so the desktop
/// app does not open files because a bridge client named one. Only an absolute
/// path to a `.sql` file, so the argument cannot be turned into "read me any
/// file" — the contents are executed, not returned, but a failure message
/// quotes the start of the statement it names. UTF-8, with or without a BOM,
/// and UTF-16 with a BOM, which is what SQL Server Management Studio saves.
async fn read_script_file(path: &str) -> Result<String, ErrorData> {
    let invalid = |msg: String| ErrorData::invalid_params(msg, None);
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(invalid(format!(
            "`path` must be absolute ({path:?} is not)"
        )));
    }
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("sql")) {
        return Err(invalid(format!(
            "`path` must name a .sql file ({path:?} does not)"
        )));
    }
    let meta = tokio::fs::metadata(p)
        .await
        .map_err(|e| invalid(format!("cannot read {path:?}: {e}")))?;
    if !meta.is_file() {
        return Err(invalid(format!("{path:?} is not a file")));
    }
    if meta.len() > crate::commands::script::MAX_SCRIPT_BYTES as u64 {
        return Err(invalid(format!(
            "{path:?} is {} bytes; run_script takes at most {}. Split it.",
            meta.len(),
            crate::commands::script::MAX_SCRIPT_BYTES
        )));
    }
    let bytes = tokio::fs::read(p)
        .await
        .map_err(|e| invalid(format!("cannot read {path:?}: {e}")))?;
    decode_script(&bytes).ok_or_else(|| {
        invalid(format!(
            "{path:?} is not UTF-8 (or UTF-16 with a byte-order mark). Save it as UTF-8."
        ))
    })
}

/// The text of a script file: UTF-8 (BOM stripped), or UTF-16 LE/BE when a BOM
/// says so. `None` for anything else.
fn decode_script(bytes: &[u8]) -> Option<String> {
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        if !rest.len().is_multiple_of(2) {
            return None;
        }
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| unit([c[0], c[1]])).collect();
        String::from_utf16(&units).ok()
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8(rest.to_vec()).ok(),
        [0xFF, 0xFE, rest @ ..] => utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, u16::from_be_bytes),
        _ => String::from_utf8(bytes.to_vec()).ok(),
    }
}

fn ok_json<T: serde::Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    let text =
        serde_json::to_string(value).map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// Map a backend [`crate::error::AppError`] onto an MCP error.
/// Every tool that can change a database. The write half of the surface.
///
/// Kept as one list because three separate places need exactly it and would
/// otherwise each keep their own copy: the `--read-only` gate below, and the
/// two tests that pin down their annotations.
const WRITE_TOOLS: [&str; 10] = [
    "run_write",
    "run_writes",
    "run_script",
    "insert_row",
    "update_cell",
    "delete_rows",
    "save_view",
    "drop_view",
    "create_index",
    "drop_index",
];

/// Remove every write tool from the surface, for a process started with
/// `--read-only`.
///
/// The flag already forces each connection to [`McpWritePolicy::ReadOnly`], so
/// these eight could only ever answer with a refusal. Taking them off
/// `tools/list` instead says the same thing earlier and cheaper: the model
/// never spends a turn discovering that this deployment does not write, and
/// nothing in the client's context suggests it might. `ToolRouter::call`
/// refuses a disabled route as well, so this is a gate rather than a
/// presentation trick.
///
/// **This is the only thing allowed to vary the tool surface, and `--read-only`
/// is the only input allowed to vary it.** A client fetches `tools/list` once,
/// at startup, and caches it for the session — while exposure and per-connection
/// write policy are deliberately re-read on every call so they can change under
/// a running client (ADR #58). Deriving the surface, or a tool's annotations,
/// from those would go stale in the unsafe direction the moment a connection was
/// raised to `data`: the client would keep believing no write was possible and
/// an auto-approving mode would skip the confirmation the user thought they had.
/// The policy gate would still hold; the prompt would not. `--read-only` cannot
/// go stale, because it is a process argument fixed for the life of this
/// sidecar.
fn disable_write_tools(router: &mut ToolRouter<Huginn>) {
    for name in WRITE_TOOLS {
        router.disable_route(name);
    }
}

/// Resolve a client-supplied connection reference — a profile **id or name** —
/// to the canonical id, among the connections `config` exposes.
///
/// Names are accepted because the id is a uuid the user never chose and should
/// never have to see: `list_connections` reports both, and asking a model to
/// copy a uuid across every subsequent call only invited it to get one
/// character wrong. The id stays the identity — names are neither unique nor
/// stable, and a rename must not silently repoint a saved reference — so an id
/// always wins over a name that happens to equal it, and an ambiguous name is
/// an error naming the candidates rather than a guess.
///
/// Resolution is scoped to *exposed* connections throughout: a name must not be
/// able to reach a profile the user did not expose, and — the more useful half
/// — a reference naming a real but unexposed connection is told exactly that,
/// with the fix that applies to how this server was started, instead of
/// "unknown connection".
fn resolve_connection(
    config: &Config,
    reference: &str,
    profiles: &[crate::state::ConnectionProfile],
) -> Result<String, ErrorData> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(ErrorData::invalid_params(
            "connection_id is required: pass the name or id of a connection from \
             `list_connections`"
                .to_string(),
            None,
        ));
    }
    let exposed: Vec<&crate::state::ConnectionProfile> =
        profiles.iter().filter(|p| config.exposes(p)).collect();

    if let Some(p) = exposed.iter().find(|p| p.id == reference) {
        return Ok(p.id.clone());
    }
    let by_name: Vec<&&crate::state::ConnectionProfile> = exposed
        .iter()
        .filter(|p| p.name.eq_ignore_ascii_case(reference))
        .collect();
    match by_name.as_slice() {
        [one] => return Ok(one.id.clone()),
        [] => {}
        many => {
            let candidates = many
                .iter()
                .map(|p| format!("{:?} (id {}, host {})", p.name, p.id, p.host))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(ErrorData::invalid_params(
                format!(
                    "{reference:?} matches {} exposed connections — pass the id instead: \
                     {candidates}",
                    many.len()
                ),
                None,
            ));
        }
    }

    // Known but not exposed is a different problem with a different fix, and by
    // far the likelier of the two.
    if let Some(p) = profiles
        .iter()
        .find(|p| p.id == reference || p.name.eq_ignore_ascii_case(reference))
    {
        return Err(ErrorData::invalid_params(
            if config.pinned.is_some() {
                format!(
                    "connection {:?} exists but this MCP server was started with an explicit \
                     --connections list that does not include it (id {})",
                    p.name, p.id
                )
            } else {
                format!(
                    "connection {:?} exists but is not exposed to MCP — tick it in HuginnDB → \
                     Settings → MCP (id {})",
                    p.name, p.id
                )
            },
            None,
        ));
    }
    Err(ErrorData::invalid_params(
        format!(
            "unknown connection {reference:?}. Exposed: {}",
            summarize_names(&exposed)
        ),
        None,
    ))
}

/// Render an exposed-connection list for an error message, bounded.
///
/// Names, not ids: the whole point of accepting a name is that the caller need
/// never see a uuid, so the recovery hint must not hand it one. Capped because
/// this goes into a model's context on every miss, and a machine with forty
/// exposed connections would spend more of it on the apology than on the work.
fn summarize_names(exposed: &[&crate::state::ConnectionProfile]) -> String {
    const MAX: usize = 10;
    if exposed.is_empty() {
        return "none — tick the connections you want reachable in HuginnDB → Settings → MCP"
            .to_string();
    }
    let mut names: Vec<&str> = exposed.iter().map(|p| p.name.as_str()).collect();
    names.sort_unstable();
    let shown = names
        .iter()
        .take(MAX)
        .map(|n| format!("{n:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > MAX {
        format!("{shown}, and {} more", names.len() - MAX)
    } else {
        shown
    }
}

fn to_err(e: crate::error::AppError) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

/// File name of the append-only audit log for MCP writes.
const AUDIT_FILE: &str = "mcp-audit.log";

/// Resolve the audit-log path: `<config-dir>/HuginnDB/mcp-audit.log`, the same
/// directory `profiles.json` lives in. Returns `None` if no config dir is
/// available (audit then silently degrades to no-op — it must never fail a
/// write).
fn audit_log_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|base| base.join(crate::app_identity::APP_DIR).join(AUDIT_FILE))
}

/// [`LogSink`] that appends a line to `mcp-audit.log` for every write the
/// sidecar performs (both successes and failures — the shared `_inner` cores
/// emit a [`LogEntry`] on each path). Reads use a [`NoopSink`] instead, so the
/// audit log is a clean record of state-changing operations only.
///
/// Since the sidecar can't show an interactive permission prompt (it's a
/// headless process the MCP client spawns), this log — plus the per-action
/// approval the MCP client itself asks for — is the accountability mechanism:
/// the user can see exactly which writes ran, against which connection, and
/// what they touched. Emission is fire-and-forget: any I/O error is swallowed
/// so it can never fail the originating DB operation.
struct AuditSink {
    path: Option<std::path::PathBuf>,
    /// `user=… role=…` — who the AI acted for, under which policy role
    /// (`crate::policy::audit_identity`).
    who: String,
}

impl AuditSink {
    fn new(state: &AppState) -> Self {
        Self {
            path: audit_log_path(),
            who: crate::policy::audit_identity(state),
        }
    }
}

impl LogSink for AuditSink {
    fn log(&self, entry: LogEntry) {
        use std::io::Write;
        let Some(path) = &self.path else { return };
        let outcome = match (&entry.error, entry.rows_affected) {
            (Some(err), _) => format!("ERROR {err}"),
            (None, Some(n)) => format!("rows={n}"),
            (None, None) => "ok".to_string(),
        };
        let line = format!(
            "{} {} conn={} driver={} {} sql={}\n",
            entry.timestamp_ms,
            self.who,
            entry.connection_id.as_deref().unwrap_or("-"),
            entry.driver.as_deref().unwrap_or("-"),
            outcome,
            entry.sql.as_deref().unwrap_or("-"),
        );
        // Best-effort append; ignore any failure (see the struct doc).
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[tool_router]
impl Huginn {
    fn new(
        state: Arc<AppState>,
        config: Arc<Config>,
        bridge: Arc<crate::bridge::client::BridgeSlot>,
    ) -> Self {
        let mut tool_router = Self::tool_router();
        if config.read_only {
            disable_write_tools(&mut tool_router);
        }
        Self {
            state,
            config,
            bridge,
            tool_router,
        }
    }

    /// Run one data-path call, through the desktop app when the bridge is up
    /// and against this process's own pools otherwise.
    ///
    /// `audit` marks a call that must land in `mcp-audit.log`. On the local
    /// path the `_inner` function does that itself through the sink it is
    /// handed; on the bridged path execution happens in the *app*, so the entry
    /// is written here instead — losing the audit trail because a write was
    /// proxied would be a straight regression of a documented security feature.
    /// What gets recorded there describes the request this sidecar sent, which
    /// is arguably the better provenance anyway.
    async fn call(&self, request: BridgeRequest, audit: bool) -> AppResult<serde_json::Value> {
        use crate::bridge::client::BridgeError;
        if let Some(bridge) = self.bridge.get().await {
            match bridge.call(&request).await {
                Ok(value) => {
                    if audit {
                        AuditSink::new(&self.state).log(audit_entry(&request, None));
                    }
                    return Ok(value);
                }
                Err(BridgeError::Remote(message)) => {
                    // The app answered, and the answer was a failure. Report it:
                    // re-running against a local pool could double-apply a write
                    // whose reply was merely lost. See `BridgeClient::call`.
                    // `Bridged`, not a prefixed variant: the app already
                    // rendered its error, prefix and all.
                    if audit {
                        AuditSink::new(&self.state).log(audit_entry(&request, Some(&message)));
                    }
                    return Err(crate::error::AppError::Bridged(message));
                }
                Err(BridgeError::Unreachable(why)) => {
                    // The request never left this process — the app shut down,
                    // or was never there. Falling through to a local pool is
                    // safe precisely because nothing was sent. Say so on stderr
                    // (stdout is the JSON-RPC channel): the user's connection
                    // footprint just changed shape, and silently growing a
                    // second budget is the thing this whole bridge exists to
                    // avoid doing invisibly.
                    eprintln!(
                        "[huginndb-mcp] the HuginnDB app is no longer serving the bridge \
                         ({why}); falling back to this process's own connection pools"
                    );
                }
            }
        }
        // No app to ask: this process would open its own pools, with secrets
        // it can only read when the app lock is off. It has no way to unlock,
        // so the answer is to open the app (ADR #118).
        if crate::vault::is_locked() {
            return Err(crate::error::AppError::Locked);
        }
        let audit_sink = AuditSink::new(&self.state);
        let noop = NoopSink;
        let sink: &dyn LogSink = if audit { &audit_sink } else { &noop };
        crate::bridge::exec::execute(&self.state, sink, &request).await
    }

    /// Ask the desktop app to open `id`, when a bridge is attached.
    ///
    /// `Some` is the app's answer, success or failure. `None` means there is
    /// no app to ask — no bridge, or one that turned out to be unreachable —
    /// and the caller opens a pool of its own.
    ///
    /// Not through [`Self::call`]: its fallback for an unreachable app is to
    /// run the request locally, and `bridge::exec::execute` refuses
    /// `EnsureConnected` by design (opening a pool differs per side). So when
    /// the app went away, every tool call — each one starts with this — failed
    /// with "ensure_connected must be handled by the caller", even though
    /// everything around it promised a fall back to local pools. An unreachable
    /// app is exactly the safe case for falling back: nothing was sent.
    async fn ensure_via_bridge(&self, id: &str) -> Option<AppResult<()>> {
        use crate::bridge::client::BridgeError;
        let bridge = self.bridge.get().await?;
        let request = BridgeRequest::EnsureConnected {
            connection_id: id.to_string(),
        };
        match bridge.call(&request).await {
            Ok(_) => Some(Ok(())),
            Err(BridgeError::Remote(message)) => {
                Some(Err(crate::error::AppError::Bridged(message)))
            }
            Err(BridgeError::Unreachable(why)) => {
                eprintln!(
                    "[huginndb-mcp] the HuginnDB app is no longer serving the bridge ({why}); {}",
                    format_args!("opening this process's own pool for {id}")
                );
                None
            }
        }
    }

    /// Ensure a live pool exists for `id`, opening one lazily on first use.
    ///
    /// Enforces the allowlist, resolves the password (and any SSH secret) from
    /// the OS keychain, and caches the pool in the shared [`AppState`] with no
    /// keepalive heartbeat (a short-lived headless process doesn't need one).
    ///
    /// **Dials what `profiles.json` says now**, not what it said when this
    /// process started. It used to open from the startup snapshot and reuse
    /// any pool it already held, so a connection repointed in HuginnDB (same
    /// server, `db-1` → `db-2`) kept answering from `db-1` — after the idle
    /// reaper closed the pool too, since the reopen read the same snapshot —
    /// until the MCP client was restarted. Exposure and write policy were
    /// already re-read per call; where the connection goes now is as well.
    async fn ensure_connected(&self, id: &str) -> AppResult<()> {
        let profiles = self.all_profiles();
        // Second line of defence. Every tool canonicalises its argument through
        // `canonical_connection` first, which already resolves only among
        // exposed profiles — but that is a convention a new tool can forget,
        // and this is the gate, so it re-asks the question against disk here
        // where no caller can skip it.
        if !profiles.iter().any(|p| p.id == id && self.is_exposed(p)) {
            return Err(crate::error::AppError::InvalidInput(format!(
                "connection {id:?} is not exposed to this MCP server (tick it in HuginnDB → \
                 Settings → MCP, or pass --connections {id})"
            )));
        }
        // Bring the in-memory copy up to date as well. The `_inner` functions
        // this process runs read profiles from `AppState` rather than from
        // disk — a Mongo connection's bound database, among others — and here
        // that copy is only ever a cache: the sidecar never edits a profile.
        *self.state.profiles.write() = profiles.clone();
        // And the organization's policy, before a pool is opened either here
        // or by the app — which checks it again on its side.
        crate::policy::enforce(
            &self.state,
            &BridgeRequest::EnsureConnected {
                connection_id: id.to_string(),
            },
        )?;
        // With the bridge up, pool ownership belongs to the desktop app: ask it
        // to open the connection and keep none of our own. The local
        // `contains` check below is deliberately *not* consulted first — this
        // process holds no pool in that mode, so it would always miss.
        if let Some(answer) = self.ensure_via_bridge(id).await {
            return answer;
        }
        // Opening a pool of our own needs the app lock off — and not only for
        // connections with a password: with the lock on, nothing is reached
        // without the app (ADR #118).
        if crate::vault::is_locked() {
            return Err(crate::error::AppError::Locked);
        }
        let profile = profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| crate::error::AppError::NotFound(format!("profile {id}")))?;
        self.open_local(profile).await
    }

    /// The half of [`Self::ensure_connected`] that runs when this process owns
    /// its pools: reuse the one it holds for `profile`, or open one.
    ///
    /// **Single-flight per id**, through the same [`AppState::open_lock`] the
    /// app's `connect_inner` takes (ADR #104). `rmcp` serves every request on
    /// its own task, and a model routinely calls several tools at once — three
    /// `describe_table`s, say — each of which starts here. Without the lock all
    /// of them found the id absent and all of them dialled: for a tunnelled
    /// connection, that many SSH handshakes against the same bastion inside a
    /// second, which is precisely what a "new connections per minute" rule on
    /// port 22 bans. Each later insert then replaced the earlier pool with a bare
    /// `Drop`. Now the second caller waits and finds the first one's pool.
    ///
    /// Split out from `ensure_connected` so it can be tested without reading the
    /// real `profiles.json` (convention #52).
    async fn open_local(&self, profile: crate::state::ConnectionProfile) -> AppResult<()> {
        let id = profile.id.as_str();
        let open_lock = self.state.open_lock(id);
        let _opening = open_lock.lock().await;
        // As the app does: the person's own database user, when one is in force.
        let profile = crate::credentials::effective_profile(&self.state.policy, &profile);
        let target = profile.dial_target();
        if self
            .state
            .connections
            .read()
            .redialed(id, &target)
            .is_some()
        {
            // Every pool this process holds is its own (no window shows it),
            // so an edited connection is simply closed and dialled again.
            self.close_local(id).await;
            eprintln!(
                "[huginndb-mcp] connection {id} was edited in HuginnDB; reopening it with the \
                 new settings"
            );
        } else if self.state.connections.read().contains(id) {
            return Ok(());
        }

        let password = crate::commands::connection::resolve_password(&profile)?;
        let ssh_secret = crate::commands::connection::resolve_ssh_secret(&profile)?;
        let known_hosts = self.state.known_hosts.clone();
        // Two limits apply and the stricter wins. `--max-connections` is what
        // *this process* is willing to take; the profile's own
        // `max_connections` is the whole budget the user says that **server**
        // can give. The reservation then shares that budget across every pool
        // this process holds against the same host — the same endpoint
        // accounting the desktop app does, in this process's own registry,
        // since the two cannot see each other's pools.
        let budget = crate::db::pool::endpoint_budget(&profile, self.config.max_connections)
            .min(self.config.max_connections);
        let grant = match crate::db::endpoint::EndpointKey::for_profile(&profile) {
            Some(key) => Some(
                self.state
                    .endpoints
                    .reserve(&key, budget, budget, 1)
                    .map_err(|e| {
                        crate::error::AppError::TooManyConnections(format!(
                            "this MCP connector's budget for {} is spent ({}/{} in use). Raise \
                             --max-connections, or the connection's limit in HuginnDB.",
                            e.label, e.in_use, e.budget
                        ))
                    })?,
            ),
            None => None,
        };
        let limits = match &grant {
            Some(g) => crate::db::pool::PoolLimits::granted(g.amount()),
            None => crate::db::pool::PoolLimits::default(),
        };
        let (pool, ssh_handle) =
            crate::db::pool::open_pool(&profile, &password, ssh_secret, known_hosts, limits)
                .await?;
        self.state.connections.write().insert(
            profile.id.clone(),
            ActivePool {
                _ssh: ssh_handle,
                _endpoint: grant,
                dialed: Some(target),
                ..ActivePool::bare(pool)
            },
        );
        Ok(())
    }

    /// Close this process's pool for `id` and the `::db::` views riding on it,
    /// the way the idle reaper does: views first, while the parent's tunnel is
    /// still up, then the parent.
    async fn close_local(&self, id: &str) {
        let removed = self.state.connections.write().remove(id);
        crate::pool_reaper::close_children(&self.state, id).await;
        if let Some(active) = removed {
            crate::db::pool::close_pool(
                &active.pool,
                crate::db::pool::PoolOwnership::for_id(id),
                crate::db::pool::CLOSE_TIMEOUT,
            )
            .await;
        }
    }

    /// Resolve which connection id a table-scoped (or `run_query`) call
    /// should actually address. For every driver except MongoDB this is
    /// always just `connection_id` unchanged — `schema` only ever meant a
    /// SQL namespace within the already-connected database. For MongoDB,
    /// `connection_id` may have no database bound at all (a multi-database
    /// connection, `list_connections`' `database: ""`) — the desktop app
    /// handles this by opening a synthetic per-database pool when the user
    /// expands a database in the explorer
    /// ([`crate::commands::connection::open_database_view`]); the MCP server
    /// has no equivalent gesture, so `schema` (or `run_query`'s `database`)
    /// is the caller's only way to say which database a Mongo table/query
    /// call targets. Reuses the same pure, headless-safe resolver the
    /// desktop command calls into
    /// ([`crate::commands::connection::resolve_mongo_database_view`]).
    async fn resolve_mongo_target(
        &self,
        connection_id: &str,
        schema: Option<&str>,
    ) -> Result<String, ErrorData> {
        let Some(db) = schema.filter(|db| !db.is_empty()) else {
            return Ok(connection_id.to_string());
        };
        // Asked of whoever owns the pool: with the bridge up that is the app,
        // and this process's own connection map is empty. Reached only when a
        // schema was actually supplied — the four connection-scoped tools pass
        // `None` and would otherwise pay a bridge round trip to be told
        // something the next line ignores.
        let is_mongo = self
            .call(
                BridgeRequest::IsMongo {
                    connection_id: connection_id.to_string(),
                },
                false,
            )
            .await
            .map_err(to_err)?
            .as_bool()
            .unwrap_or(false);
        match is_mongo {
            true => self
                .call(
                    BridgeRequest::ResolveMongoTarget {
                        connection_id: connection_id.to_string(),
                        database: db.to_string(),
                    },
                    false,
                )
                .await
                .map_err(to_err)?
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| {
                    to_err(crate::error::AppError::InvalidInput(
                        "resolve_mongo_target returned a non-string id".into(),
                    ))
                }),
            false => Ok(connection_id.to_string()),
        }
    }

    /// The whole body of a read-only tool: reopen the pool if it was reaped,
    /// resolve which connection id actually holds the data, run one bridge
    /// request, serialise the answer.
    ///
    /// Eight tools spelled this out, and the middle step is the reason it is
    /// worth sharing: a MongoDB connection with no database bound needs
    /// `schema` folded into a synthetic per-database id before the request is
    /// built, and a tool that forgets to do so does not fail — it answers for
    /// the wrong database, or for none. `build` receives that resolved id so
    /// there is no way to construct the request without it.
    ///
    /// Read-only by construction: `call(.., false)` skips the audit log, which
    /// is correct here and would be a hole anywhere else. The write tools keep
    /// their own bodies — their policy check has to sit between the connect
    /// and the call, and is deliberately duplicated across the two layers.
    async fn read_tool<F>(
        &self,
        connection_id: &str,
        schema: Option<&str>,
        build: F,
    ) -> Result<CallToolResult, ErrorData>
    where
        F: FnOnce(String) -> BridgeRequest,
    {
        self.ensure_connected(connection_id).await.map_err(to_err)?;
        let target = self.resolve_mongo_target(connection_id, schema).await?;
        let out = self.call(build(target), false).await.map_err(to_err)?;
        ok_json(&out)
    }

    /// Every profile on this machine, read **fresh from `profiles.json`** with
    /// the startup snapshot as a fallback — see [`Self::write_policy`] for why
    /// the disk is the authority while this process is running.
    fn all_profiles(&self) -> Vec<crate::state::ConnectionProfile> {
        crate::store::load_profiles().unwrap_or_else(|_| self.state.profiles.read().clone())
    }

    /// Whether this server may reach `profile` at all.
    ///
    /// The exposure gate, and the one place that knows the two sources rank:
    /// a `--connections` list the user typed wins outright, and otherwise the
    /// answer is the profile's own `mcp_exposed`, ticked in Settings → MCP.
    fn is_exposed(&self, profile: &crate::state::ConnectionProfile) -> bool {
        self.config.exposes(profile)
    }

    /// Resolve a client-supplied connection reference — a profile **id or
    /// name** — to the canonical id every layer below this one speaks.
    ///
    /// Thin wrapper: the rules live in the free [`resolve_connection`] so they
    /// can be tested without an [`AppState`] and without reading the real
    /// `profiles.json` (convention #52 — a test that reaches this function's own
    /// disk read is a test whose answer depends on the developer's saved
    /// connections).
    fn canonical_connection(&self, reference: &str) -> Result<String, ErrorData> {
        resolve_connection(&self.config, reference, &self.all_profiles())
    }

    /// The body behind `run_query` and `run_write`.
    ///
    /// One statement executor, two tools, and the split is the whole point:
    /// a client's permission rules key on the **tool name**, so while reads and
    /// writes shared one name there was no way to say "let the SELECTs run,
    /// ask me about the rest". The tool's annotation had the same problem from
    /// the other side — a single name spanning both tiers can only be
    /// annotated as the more dangerous of the two, which put write-shaped
    /// friction in front of the tool that serves nearly every read.
    ///
    /// Splitting by tier makes both annotations honest **constants**:
    /// `run_query` is `readOnlyHint`, `run_write` is `destructiveHint`, and
    /// neither can go stale the way a policy-derived hint would (that trap is
    /// documented in the `Unreleased` CHANGELOG entry and ADR #59).
    ///
    /// Enforcement runs in **both** directions. Refusing writes on `run_query`
    /// is the obvious half; refusing *reads* on `run_write` is what stops a
    /// model routing everything through the write tool and quietly undoing the
    /// split — the caller is told which tool to use instead, since being
    /// pointed at the cheaper tool is a better answer than silently obliging.
    ///
    /// Neither refusal replaces the policy gate: `require_verbs` below still
    /// re-reads `mcp_write` from disk on every call, and it is what actually
    /// decides whether a write is allowed to happen.
    async fn run_statement(
        &self,
        mut a: args::Query,
        kind: StatementKind,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.database.as_deref())
            .await?;

        // Classify the statement into its required tier. `classify_statement`
        // picks the grammar from the statement *text*, which is deliberate:
        // this used to derive "is this Mongo?" from `self.state.connections`,
        // and that map is empty whenever the app is serving the shared pool —
        // so every bridged Mongo statement was classified by the SQL keyword
        // heuristic instead. See `crate::db::classify` for the two bugs that
        // caused.
        let verbs = crate::db::classify::verbs_of(&a.sql);
        let class = verbs.class();

        match (kind, class) {
            (StatementKind::Read, StmtClass::Read) => {}
            (StatementKind::Read, _) => {
                return Err(ErrorData::invalid_params(
                    "run_query only runs read-only statements. This one writes — call \
                     `run_write` instead (it needs the connection's MCP write policy to \
                     allow it)."
                        .to_string(),
                    None,
                ));
            }
            (StatementKind::Write, StmtClass::Read) => {
                return Err(ErrorData::invalid_params(
                    "run_write only runs statements that change the database. This one is \
                     read-only — call `run_query` instead, which needs no write permission."
                        .to_string(),
                    None,
                ));
            }
            (StatementKind::Write, _) => {}
        }

        // Refuse a whole-relation UPDATE/DELETE outright, regardless of tier —
        // a classic AI footgun. Both grammars are covered: the caller can opt in
        // with `WHERE 1=1`, or `{_id: {$exists: true}}` on MongoDB.
        if crate::db::classify::is_unfiltered_write(&a.sql) {
            return Err(ErrorData::invalid_params(
                "run_write refused a whole-relation UPDATE/DELETE with no predicate. \
                 Add one — `WHERE 1=1` on SQL, or `{_id: {$exists: true}}` on MongoDB, \
                 if you really mean every row."
                    .to_string(),
                None,
            ));
        }

        // Policy is a property of the *profile* (`ConnectionProfile::mcp_write`),
        // not of the resolved pool: for Mongo, `target` may be the synthetic
        // per-database id `<connection_id>::db::<name>` (see
        // `resolve_mongo_target`), which is never a key in `profiles.json` — a
        // `write_policy` lookup against it would always miss and silently fall
        // back to `ReadOnly`, regardless of the connection's real setting.
        self.require_verbs(&a.connection_id, verbs)?;

        // Reads are not audited; writes append to mcp-audit.log.
        let value = self
            .call(
                BridgeRequest::RunStatement {
                    connection_id: target,
                    policy_id: a.connection_id.clone(),
                    sql: a.sql.clone(),
                },
                class != StmtClass::Read,
            )
            .await
            .map_err(to_err)?;
        let mut result: crate::commands::query::QueryResult =
            serde_json::from_value(value).map_err(|e| to_err(crate::error::AppError::from(e)))?;
        truncate_rows(&mut result, self.config.max_rows);
        ok_json(&result)
    }

    /// The write policy in force for `connection_id`, read **fresh from
    /// `profiles.json`** so a change made in the desktop app (Settings → MCP)
    /// takes effect without restarting the MCP client. Falls back to the
    /// in-memory profile loaded at startup if the disk re-read fails, and to
    /// [`McpWritePolicy::ReadOnly`] if the profile is unknown. The global
    /// `--read-only` kill-switch overrides everything.
    fn write_policy(&self, connection_id: &str) -> McpWritePolicy {
        if self.config.read_only {
            return McpWritePolicy::ReadOnly;
        }
        crate::store::load_profiles()
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.id == connection_id))
            .map(|p| p.mcp_write)
            .or_else(|| {
                self.state
                    .profiles
                    .read()
                    .iter()
                    .find(|p| p.id == connection_id)
                    .map(|p| p.mcp_write)
            })
            .unwrap_or_default()
    }

    /// Enforce that `connection_id`'s policy admits a statement of tier
    /// `class`, returning an MCP error naming the current level otherwise.
    fn require_verbs(&self, connection_id: &str, needed: Verbs) -> Result<(), ErrorData> {
        let policy = self.write_policy(connection_id);
        if policy.allows(needed) {
            return Ok(());
        }
        // Worded in tiers, because that is what the setting this names offers:
        // the per-connection policy grants the row writes together.
        let needed = match needed.class() {
            StmtClass::Read => "read-only",
            StmtClass::DataWrite => "data",
            StmtClass::Ddl => "full",
        };
        Err(ErrorData::invalid_params(
            format!(
                "connection {connection_id:?} has MCP write policy {:?}, which does not permit                  this operation (needs at least {needed:?}). Raise the connection's level in                  HuginnDB → Settings → MCP.",
                policy.label()
            ),
            None,
        ))
    }

    #[tool(
        title = "List exposed connections",
        annotations(read_only_hint = true, open_world_hint = false),
        description = "List the databases this server is allowed to reach \
                      (name, profile id, driver, host, database, whether a \
                      pool is currently open, and the MCP write policy in \
                      force: read-only / data / full). Every other tool \
                      accepts either the name or the id; prefer the name. \
                      An empty list means the user has not exposed any \
                      connection yet — they do that in HuginnDB under \
                      Settings → MCP."
    )]
    async fn list_connections(&self) -> Result<CallToolResult, ErrorData> {
        // With the app lock on, even the names stay behind it unless the app
        // is serving the bridge — which it does only while unlocked.
        if crate::vault::is_locked() && crate::bridge::read_discovery().is_none() {
            return Err(to_err(crate::error::AppError::Locked));
        }
        #[derive(serde::Serialize)]
        struct Conn {
            id: String,
            name: String,
            driver: String,
            host: String,
            database: String,
            active: bool,
            /// Effective write policy (`read-only` / `data` / `full`), read
            /// fresh so it reflects the current Settings → MCP choice and the
            /// global `--read-only` kill-switch.
            write_policy: &'static str,
        }
        let active: HashSet<String> = self.state.connections.read().ids().into_iter().collect();
        // Collect the allowed ids first, then resolve each policy through
        // `write_policy` (which re-reads profiles.json) without holding the
        // `profiles` read-lock across the call.
        let ids: Vec<crate::state::ConnectionProfile> = self
            .all_profiles()
            .into_iter()
            .filter(|p| self.is_exposed(p))
            // Nor one the organization's policy puts out of the AI's reach:
            // listing it would only invite a call that is then refused.
            .filter(|p| crate::policy::reachable_by_ai(&self.state, p))
            .collect();
        let conns: Vec<Conn> = ids
            .into_iter()
            .map(|p| Conn {
                write_policy: self.write_policy(&p.id).label(),
                id: p.id.clone(),
                name: p.name.clone(),
                // The profile's own wire name, not a `Debug` repr: the latter
                // reported `"mongo"` where `profiles.json` (and every other
                // surface) says `"mongodb"`, and would have said `"mssql"` for
                // SQL Server's `"sqlserver"`.
                driver: p.driver.wire_name().to_string(),
                host: p.host.clone(),
                database: p.database.clone(),
                active: active.contains(&p.id),
            })
            .collect();
        ok_json(&conns)
    }

    #[tool(
        title = "List databases",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "List databases/schemas/catalogs on a connection."
    )]
    async fn list_databases(
        &self,
        Parameters(mut a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, None, |connection_id| {
            BridgeRequest::ListDatabases { connection_id }
        })
        .await
    }

    #[tool(
        title = "List tables and views",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "List tables and views on a connection, with \
                      approximate row counts and sizes where available. \
                      For MongoDB, pass `schema` (the database name) when \
                      the connection has no database bound — otherwise \
                      this returns an empty list."
    )]
    async fn list_tables(
        &self,
        Parameters(mut a): Parameters<args::Tables>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, a.schema.as_deref(), |connection_id| {
            BridgeRequest::ListTables { connection_id }
        })
        .await
    }

    #[tool(
        title = "Describe a table",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Describe a relation's full structure: columns, types, \
                      nullability, primary key, foreign keys, and indexes. \
                      Works on a view too, and when the relation IS a view \
                      the reply carries an extra `view` object with what the \
                      view actually is: `query` (the bare SELECT body) on \
                      SQL drivers, or `viewOn` plus `pipeline` on MongoDB, \
                      where a view is a stored aggregation pipeline. Absent \
                      `view` key means the relation is a plain table. On a \
                      MongoDB view, `columns` is inferred by reading a page of \
                      what the view returns and comes back empty when that \
                      does not finish quickly, and `indexes` is always empty \
                      (a view has none of its own) — `view` is the reliable \
                      half there."
    )]
    async fn describe_table(
        &self,
        Parameters(mut a): Parameters<args::Table>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Table {
            connection_id,
            schema,
            table,
        } = a;
        self.read_tool(&connection_id, schema.as_deref(), |connection_id| {
            BridgeRequest::GetTableStructure {
                connection_id,
                schema: schema.clone(),
                table,
            }
        })
        .await
    }

    #[tool(
        title = "List indexes",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "List indexes on a table, with the columns each covers."
    )]
    async fn list_indexes(
        &self,
        Parameters(mut a): Parameters<args::Table>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Table {
            connection_id,
            schema,
            table,
        } = a;
        self.read_tool(&connection_id, schema.as_deref(), |connection_id| {
            BridgeRequest::ListIndexes {
                connection_id,
                schema: schema.clone(),
                table,
            }
        })
        .await
    }

    #[tool(
        title = "Run a read-only statement",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Run a single READ-ONLY statement and return its rows: \
                      SELECT / WITH / SHOW / EXPLAIN / PRAGMA for SQL, or \
                      find/aggregate/countDocuments/distinct for MongoDB. \
                      Anything that writes is refused here whatever the \
                      connection's policy says — use `run_write` for those. \
                      Rows are capped by the server's --max-rows."
    )]
    async fn run_query(
        &self,
        Parameters(a): Parameters<args::Query>,
    ) -> Result<CallToolResult, ErrorData> {
        self.run_statement(a, StatementKind::Read).await
    }

    #[tool(
        title = "Run a writing statement",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        ),
        description = "Run a single statement that CHANGES the database, and \
                      return whatever it reports. Row-level DML \
                      (INSERT/UPDATE/DELETE) needs the connection's MCP write \
                      policy to be at least 'data'; schema changes \
                      (CREATE/DROP/ALTER/…) need 'full'. Whole-relation \
                      UPDATE/DELETE with no predicate are refused. A read is \
                      refused here too — use `run_query`, which does not need \
                      write permission. For several statements that must \
                      share a session (temporary tables, a migration), use \
                      `run_script`. Every call is recorded in the app's \
                      MCP audit log."
    )]
    async fn run_write(
        &self,
        Parameters(a): Parameters<args::Query>,
    ) -> Result<CallToolResult, ErrorData> {
        self.run_statement(a, StatementKind::Write).await
    }

    /// Run each of `queries` as `run_query` would, against `target` under
    /// `policy_id`'s policy — the body `run_queries` and `run_writes`' `verify`
    /// list share.
    ///
    /// One after another, not concurrently: concurrent reads would each take a
    /// connection, and on a tunnelled server a burst of new sessions is the
    /// thing ADRs #104 and #105 exist to avoid. The saving these tools are for
    /// is model turns, not milliseconds. The rows share one `--max-rows`
    /// budget across the list, so ten queries cannot put ten times the cap in
    /// the model's context.
    async fn read_many(
        &self,
        target: &str,
        policy_id: &str,
        queries: &[String],
    ) -> Vec<ReadOutcome> {
        let mut left = self.config.max_rows.max(0);
        let mut out = Vec::with_capacity(queries.len());
        for sql in queries {
            out.push(match self.read_one(target, policy_id, sql, left).await {
                Ok(result) => {
                    left -= result.rows.len() as i64;
                    ReadOutcome::Rows(result)
                }
                Err(error) => ReadOutcome::Failed { error },
            });
        }
        out
    }

    /// One read of [`Self::read_many`]: the same tier check and the same
    /// `RunStatement` `run_query` sends, so it runs in the read-only
    /// transaction every AI read gets (ADR #93).
    async fn read_one(
        &self,
        target: &str,
        policy_id: &str,
        sql: &str,
        max_rows: i64,
    ) -> Result<crate::commands::query::QueryResult, String> {
        let verbs = crate::db::classify::verbs_of(sql);
        if verbs.class() != StmtClass::Read {
            return Err("this statement writes; only reads run here — writes go in \
                        `run_writes`"
                .to_string());
        }
        self.require_verbs(policy_id, verbs)
            .map_err(|e| e.message.to_string())?;
        let value = self
            .call(
                BridgeRequest::RunStatement {
                    connection_id: target.to_string(),
                    policy_id: policy_id.to_string(),
                    sql: sql.to_string(),
                },
                false,
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut result: crate::commands::query::QueryResult =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        truncate_rows(&mut result, max_rows);
        Ok(result)
    }

    #[tool(
        title = "Run several read-only statements",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Run several READ-ONLY statements in one call — prefer \
                      this to consecutive `run_query` calls. Each runs as \
                      `run_query` would; one that fails is reported in its \
                      slot (`{\"error\": …}`) without stopping the rest. \
                      Returns one result per statement, in order. Rows share \
                      one --max-rows budget."
    )]
    async fn run_queries(
        &self,
        Parameters(mut a): Parameters<args::Queries>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        if a.queries.is_empty() || a.queries.len() > MAX_BATCH_READS {
            return Err(ErrorData::invalid_params(
                format!(
                    "run_queries takes 1 to {MAX_BATCH_READS} queries ({} given)",
                    a.queries.len()
                ),
                None,
            ));
        }
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.database.as_deref())
            .await?;
        ok_json(&self.read_many(&target, &a.connection_id, &a.queries).await)
    }

    #[tool(
        title = "Run several writes as one transaction",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        ),
        description = "Apply several row writes (INSERT/UPDATE/DELETE) in ONE \
                      transaction: all land or none do. Prefer this to \
                      consecutive `run_write` calls. A write's `expect_rows` \
                      rolls everything back if it touches a different number \
                      of rows. `verify` reads run after the commit and come \
                      back in the same reply — no separate re-read needed. \
                      Needs MCP write policy 'data' or above. Schema changes \
                      and BEGIN/COMMIT are refused (use `run_write`). MongoDB \
                      has no transaction here: writes run in order and stop at \
                      the first failure (`atomic: false`). Recorded in the MCP \
                      audit log."
    )]
    async fn run_writes(
        &self,
        Parameters(mut a): Parameters<args::Writes>,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::commands::write_batch::{self, BatchWrite};
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let writes: Vec<BatchWrite> = a
            .writes
            .into_iter()
            .map(|w| BatchWrite {
                sql: w.sql,
                expect_rows: w.expect_rows,
            })
            .collect();
        // Before a pool is opened, so a list that cannot run costs no
        // connection. The executor checks it again on whichever side runs it.
        write_batch::check_writes(&writes)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        if a.verify.len() > MAX_BATCH_READS {
            return Err(ErrorData::invalid_params(
                format!(
                    "run_writes takes at most {MAX_BATCH_READS} verify queries ({} given)",
                    a.verify.len()
                ),
                None,
            ));
        }
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.database.as_deref())
            .await?;
        // Against the profile, never the resolved target — see `run_statement`.
        self.require_verbs(&a.connection_id, write_batch::verbs_of_writes(&writes))?;

        let value = self
            .call(
                BridgeRequest::RunWriteBatch {
                    connection_id: target.clone(),
                    policy_id: a.connection_id.clone(),
                    writes,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        let batch: write_batch::WriteBatchResult =
            serde_json::from_value(value).map_err(|e| to_err(crate::error::AppError::from(e)))?;

        #[derive(serde::Serialize)]
        struct Reply {
            #[serde(flatten)]
            batch: write_batch::WriteBatchResult,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            verify: Vec<ReadOutcome>,
        }
        let verify = self.read_many(&target, &a.connection_id, &a.verify).await;
        ok_json(&Reply { batch, verify })
    }

    #[tool(
        title = "Run a SQL script on one session",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        ),
        description = "Run a whole SQL script — a migration, a .sql file — on \
                      ONE pinned session, in order, so temporary tables \
                      (CREATE TEMPORARY TABLE, #temp), SET and variables \
                      persist from one statement to the next. Mix DDL, \
                      INSERT … SELECT, multi-row INSERTs and SELECTs to \
                      verify; each SELECT's rows come back (one --max-rows \
                      budget). Pass the script as `sql`, or a local .sql \
                      file as `path` so it never goes through the \
                      conversation. One transaction by default (all or \
                      nothing; BEGIN/COMMIT in the script are refused — pass \
                      `transaction: false` to run them as written). The \
                      session is closed afterwards, so nothing carries to the \
                      next call. Needs policy 'data'; any DDL, temporary \
                      tables included, needs 'full'. Postgres, MySQL, SQLite, \
                      SQL Server — not MongoDB. Recorded in the MCP audit log."
    )]
    async fn run_script(
        &self,
        Parameters(mut a): Parameters<args::Script>,
    ) -> Result<CallToolResult, ErrorData> {
        use crate::commands::script;
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let text = match (a.sql, a.path) {
            (Some(sql), None) => sql,
            (None, Some(path)) => read_script_file(&path).await?,
            _ => {
                return Err(ErrorData::invalid_params(
                    "run_script takes the script as `sql` or as a `path` to a .sql file — \
                     exactly one of them"
                        .to_string(),
                    None,
                ))
            }
        };
        let transaction = a.transaction.unwrap_or(true);
        if text.len() > script::MAX_SCRIPT_BYTES {
            return Err(ErrorData::invalid_params(
                format!(
                    "the script is {} bytes; run_script takes at most {}. Split it.",
                    text.len(),
                    script::MAX_SCRIPT_BYTES
                ),
                None,
            ));
        }
        // Before a pool is opened, as `run_writes` does. The executor checks
        // again on whichever side runs it.
        script::check_script(&script::split_script(&text), transaction)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        self.require_verbs(&a.connection_id, script::verbs_of_script(&text))?;

        let value = self
            .call(
                BridgeRequest::RunScript {
                    connection_id: a.connection_id.clone(),
                    policy_id: a.connection_id.clone(),
                    sql: text,
                    transaction,
                    max_rows: self.config.max_rows.max(0) as usize,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        let result: script::ScriptResult =
            serde_json::from_value(value).map_err(|e| to_err(crate::error::AppError::from(e)))?;
        ok_json(&result)
    }

    #[tool(
        title = "Browse table rows",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Browse one page of rows from a table without writing \
                      SQL. Returns columns + rows; limit is clamped to the \
                      server's --max-rows."
    )]
    async fn browse_table(
        &self,
        Parameters(mut a): Parameters<args::Browse>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let limit = a
            .limit
            .unwrap_or(self.config.max_rows)
            .clamp(1, self.config.max_rows);
        let offset = a.offset.unwrap_or(0).max(0);
        let policy_id = a.connection_id.clone();
        let (schema, table) = (a.schema, a.table);
        self.read_tool(&policy_id, schema.as_deref(), |connection_id| {
            BridgeRequest::FetchTableData {
                connection_id,
                policy_id: policy_id.clone(),
                schema: schema.clone(),
                table,
                limit,
                offset,
                with_count: Some(true),
            }
        })
        .await
    }

    #[tool(
        title = "Server version",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Return the connected server's engine and version."
    )]
    async fn server_version(
        &self,
        Parameters(mut a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, None, |connection_id| {
            BridgeRequest::ServerVersion { connection_id }
        })
        .await
    }

    #[tool(
        title = "List users and roles",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "List server-side users/roles (permission context)."
    )]
    async fn list_users(
        &self,
        Parameters(mut a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, None, |connection_id| {
            BridgeRequest::ListUsers { connection_id }
        })
        .await
    }

    #[tool(
        title = "List privileges",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "List the privileges granted to a user/role."
    )]
    async fn list_privileges(
        &self,
        Parameters(mut a): Parameters<args::Privileges>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Privileges {
            connection_id,
            user,
        } = a;
        self.read_tool(&connection_id, None, |connection_id| {
            BridgeRequest::ListPrivileges {
                connection_id,
                user,
            }
        })
        .await
    }

    #[tool(
        title = "Server vital signs",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Read a connection's live vital signs: queries/s, \
                      connection pressure, cache hit rate and related \
                      counters, normalised to an engine-independent \
                      metric catalogue (name kept the same whether the \
                      server is MySQL or MongoDB). MySQL and MongoDB \
                      only; fails with an explicit 'unsupported driver' \
                      on the others."
    )]
    async fn pulse_health(
        &self,
        Parameters(mut a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, None, |connection_id| {
            BridgeRequest::PulseHealth { connection_id }
        })
        .await
    }

    #[tool(
        title = "Stored metric history",
        annotations(read_only_hint = true, open_world_hint = false),
        description = "Read one metric's stored history from Pulse's \
                      on-disk sampler (pulse.db), oldest first. Empty \
                      unless the connection has Pulse's history sampler \
                      turned on in Settings; pulse_health's reply names \
                      the metrics a given engine reports."
    )]
    async fn pulse_metrics(
        &self,
        Parameters(mut a): Parameters<args::PulseMetrics>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::PulseMetrics {
            connection_id,
            metric,
            since_ms,
        } = a;
        self.read_tool(&connection_id, None, |connection_id| {
            BridgeRequest::PulseMetrics {
                connection_id,
                metric,
                since_ms,
            }
        })
        .await
    }

    #[tool(
        title = "Slowest statements",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Statements this server has spent the most time on, \
                      ranked by total time, since the statistics were \
                      last reset (MySQL) or over what the profiler \
                      currently retains (MongoDB). Each row's 'sample' \
                      field, when present, is a runnable example \
                      pulse_explain accepts."
    )]
    async fn pulse_top_queries(
        &self,
        Parameters(mut a): Parameters<args::Tables>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Tables {
            connection_id,
            schema,
        } = a;
        self.read_tool(&connection_id, schema.as_deref(), |connection_id| {
            BridgeRequest::PulseTopQueries { connection_id }
        })
        .await
    }

    #[tool(
        title = "Explain a statement",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Read the plan the server would use for one \
                      statement, without running it — a pulse_top_queries \
                      row's own 'sample' field in practice. Refuses a \
                      statement that is not read-only, is itself \
                      EXPLAIN/ANALYZE, or carries more than one \
                      statement."
    )]
    async fn pulse_explain(
        &self,
        Parameters(mut a): Parameters<args::PulseExplain>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::PulseExplain {
            connection_id,
            sample,
            database,
        } = a;
        self.read_tool(&connection_id, database.as_deref(), |connection_id| {
            BridgeRequest::PulseExplain {
                connection_id,
                sample,
            }
        })
        .await
    }

    #[tool(
        title = "Largest relations",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "The connection's biggest relations, largest first, \
                      split into data / index / free space."
    )]
    async fn pulse_storage(
        &self,
        Parameters(mut a): Parameters<args::Tables>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Tables {
            connection_id,
            schema,
        } = a;
        self.read_tool(&connection_id, schema.as_deref(), |connection_id| {
            BridgeRequest::PulseStorage { connection_id }
        })
        .await
    }

    #[tool(
        title = "Open sessions",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Every session or operation currently open on the \
                      server (SHOW FULL PROCESSLIST on MySQL; active or \
                      lock-waiting ops from currentOp on MongoDB), with a \
                      best-effort blocking chain on MySQL."
    )]
    async fn pulse_sessions(
        &self,
        Parameters(mut a): Parameters<args::Connection>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.read_tool(&a.connection_id, None, |connection_id| {
            BridgeRequest::PulseSessions { connection_id }
        })
        .await
    }

    #[tool(
        title = "Index usage",
        annotations(read_only_hint = true, open_world_hint = true),
        description = "Index usage across the connection's biggest \
                      relations, least-read first — the fastest way to \
                      spot an index nobody reads. A reads count of 0 \
                      means genuinely never used since the counters were \
                      last reset, not unavailable; unavailable reads as \
                      null."
    )]
    async fn pulse_index_usage(
        &self,
        Parameters(mut a): Parameters<args::Tables>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        let args::Tables {
            connection_id,
            schema,
        } = a;
        self.read_tool(&connection_id, schema.as_deref(), |connection_id| {
            BridgeRequest::PulseIndexUsage { connection_id }
        })
        .await
    }

    #[tool(
        title = "Insert a row",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        ),
        description = "Insert one row into a table. Requires the connection's \
                      MCP write policy to be 'data' or 'full'. Values travel \
                      as text and are cast to each column's type; omitted \
                      columns take their database default. Returns the \
                      generated primary key when available."
    )]
    async fn insert_row(
        &self,
        Parameters(mut a): Parameters<args::InsertRow>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_verbs(&a.connection_id, Verbs::INSERT)?;
        let values: Vec<crate::commands::query::RowValue> = a
            .values
            .into_iter()
            .map(|v| crate::commands::query::RowValue {
                column: v.column,
                value: v.value,
                column_type: v.column_type,
            })
            .collect();
        let out = self
            .call(
                BridgeRequest::InsertRow {
                    connection_id: target,
                    policy_id: a.connection_id,
                    schema: a.schema,
                    table: a.table,
                    pk_column: a.pk_column,
                    values: serde_json::to_value(values)
                        .map_err(|e| to_err(crate::error::AppError::from(e)))?,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Update one column",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Update one column of the single row addressed by its \
                      full primary key. Requires the connection's MCP write \
                      policy to be 'data' or 'full'. Refuses to touch more \
                      than one row (an incomplete composite key is an error, \
                      not a silent multi-row update)."
    )]
    async fn update_cell(
        &self,
        Parameters(mut a): Parameters<args::UpdateCell>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_verbs(&a.connection_id, Verbs::UPDATE)?;
        let out = self
            .call(
                BridgeRequest::UpdateCell {
                    connection_id: target,
                    policy_id: a.connection_id,
                    schema: a.schema,
                    table: a.table,
                    pk_columns: a.pk_columns,
                    pk_values: a.pk_values,
                    column: a.column,
                    value: a.value,
                    column_type: a.column_type,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Delete rows",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Delete one or more rows, each addressed by its full \
                      primary key. Requires the connection's MCP write \
                      policy to be 'data' or 'full'. Only rows whose full \
                      key matches a supplied tuple are removed. Returns the \
                      number of rows deleted."
    )]
    async fn delete_rows(
        &self,
        Parameters(mut a): Parameters<args::DeleteRows>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        self.require_verbs(&a.connection_id, Verbs::DELETE)?;
        let out = self
            .call(
                BridgeRequest::DeleteRows {
                    connection_id: target,
                    policy_id: a.connection_id,
                    schema: a.schema,
                    table: a.table,
                    pk_columns: a.pk_columns,
                    pk_value_rows: a.pk_value_rows,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Create or replace a view",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Create a view, redefine an existing one, or rename one. \
                      Requires the connection's MCP write policy to be 'full' \
                      — a view is schema, so this is the same DDL tier \
                      CREATE/DROP/ALTER need through run_query. Pass just \
                      `name` and `query`: the tool reads the current definition \
                      itself to decide whether this is a create or a replace \
                      and how to express it on this engine (Postgres CREATE OR \
                      REPLACE, MySQL RENAME TABLE, SQLite drop-and-recreate, \
                      MongoDB createView/collMod). Set `preview: true` to see \
                      the statements without running them — that dry run is a \
                      read and works on any connection. Note a rename plus a \
                      body change is atomic on Postgres but NOT on MySQL, \
                      which commits each DDL statement implicitly. Not \
                      supported on SQL Server, whose T-SQL view DDL is not \
                      written yet."
    )]
    async fn save_view(
        &self,
        Parameters(mut a): Parameters<args::SaveView>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        if a.preview {
            // A dry run executes nothing, so it goes through the shared
            // read-only body: `call(.., false)` skips the audit log, which is
            // right here and would be a hole on the apply path. The app still
            // gates it independently, as `StmtClass::Read`.
            let args::SaveView {
                connection_id,
                schema,
                name,
                query,
                rename_from,
                view_on,
                ..
            } = a;
            let policy_id = connection_id.clone();
            return self
                .read_tool(&connection_id, schema.as_deref(), |connection_id| {
                    BridgeRequest::PreviewViewChange {
                        connection_id,
                        policy_id,
                        schema: schema.clone(),
                        name,
                        query,
                        rename_from,
                        view_on,
                    }
                })
                .await;
        }
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // See the comment in `run_query`: policy is checked against the real
        // profile id, not the resolved (possibly synthetic per-database) target.
        // `Ddl` because a view is schema — the same tier `db::sql::classify`
        // gives the `CREATE OR REPLACE VIEW` a caller could write by hand
        // through `run_query`. Anything lower would let a `data` connection
        // reach through this tool what `run_query` refuses it.
        self.require_verbs(&a.connection_id, Verbs::DDL)?;
        let out = self
            .call(
                BridgeRequest::ApplyViewChange {
                    connection_id: target,
                    policy_id: a.connection_id,
                    schema: a.schema,
                    name: a.name,
                    query: a.query,
                    rename_from: a.rename_from,
                    view_on: a.view_on,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Drop a view",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Drop a view. Requires the connection's MCP write policy \
                      to be 'full' (DROP is schema, the same tier run_query \
                      needs for it — note that deleting *rows* only needs \
                      'data'). Works on every driver, SQL Server and MongoDB \
                      included. Refuses to drop anything that is not a view: on \
                      SQL a DROP VIEW against a table errors, and on MongoDB — \
                      where a view and a collection are one namespace — the \
                      catalog is checked first, so a mistyped name cannot \
                      destroy a collection's documents."
    )]
    async fn drop_view(
        &self,
        Parameters(mut a): Parameters<args::DropView>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // Policy against the real profile id, never the resolved target — see
        // `save_view` above and `run_query`.
        self.require_verbs(&a.connection_id, Verbs::DDL)?;
        let out = self
            .call(
                BridgeRequest::DropView {
                    connection_id: target,
                    policy_id: a.connection_id,
                    schema: a.schema,
                    view: a.view,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Create an index",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Create an index on a MongoDB collection. MongoDB only — on \
                      the SQL drivers an index is created with CREATE INDEX \
                      through run_query, which is more expressive than any \
                      portable form (USING gin, INCLUDE, a partial predicate). \
                      Requires the connection's MCP write policy to be 'full': \
                      an index is schema, the same tier run_query needs for \
                      db.coll.createIndex(...). Read the existing indexes with \
                      list_indexes first — its 'mongo' object reports each key's \
                      direction and type, which a bare column list cannot."
    )]
    async fn create_index(
        &self,
        Parameters(mut a): Parameters<args::CreateIndex>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        // Policy against the real profile id, never the resolved target — see
        // `run_query`. `Ddl`, because `db.coll.createIndex(…)` is `Ddl`: a
        // lower tier here would grant through a tool what the statement path
        // refuses.
        self.require_verbs(&a.connection_id, Verbs::DDL)?;
        let out = self
            .call(
                BridgeRequest::CreateMongoIndex {
                    connection_id: target,
                    policy_id: a.connection_id,
                    collection: a.collection,
                    // Assembled here rather than deserialised as a nested
                    // object — see `args::CreateIndex`.
                    spec: crate::db::mongo::indexes::NewMongoIndexSpec {
                        keys: a.keys,
                        name: a.name,
                        unique: a.unique,
                        sparse: a.sparse,
                        hidden: a.hidden,
                        expire_after_seconds: a.expire_after_seconds,
                        partial_filter_expression: a.partial_filter_expression,
                        collation: a.collation,
                        weights: a.weights,
                        default_language: a.default_language,
                        extra_options: a.extra_options,
                    },
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }

    #[tool(
        title = "Drop an index",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true,
            open_world_hint = true
        ),
        description = "Drop an index from a MongoDB collection. MongoDB only (on \
                      SQL, use DROP INDEX through run_query). Requires the \
                      connection's MCP write policy to be 'full'. The `_id_` \
                      index is refused. There is no 'edit an index' tool \
                      because MongoDB cannot alter one in place: replacing it \
                      is drop_index then create_index, and doing it as two \
                      calls keeps the window where the index is missing \
                      visible to you."
    )]
    async fn drop_index(
        &self,
        Parameters(mut a): Parameters<args::DropIndex>,
    ) -> Result<CallToolResult, ErrorData> {
        a.connection_id = self.canonical_connection(&a.connection_id)?;
        self.ensure_connected(&a.connection_id)
            .await
            .map_err(to_err)?;
        let target = self
            .resolve_mongo_target(&a.connection_id, a.schema.as_deref())
            .await?;
        self.require_verbs(&a.connection_id, Verbs::DDL)?;
        let out = self
            .call(
                BridgeRequest::DropMongoIndex {
                    connection_id: target,
                    policy_id: a.connection_id,
                    collection: a.collection,
                    name: a.name,
                },
                true,
            )
            .await
            .map_err(to_err)?;
        ok_json(&out)
    }
}

/// Truncate a query result to at most `max` rows, in place, and say so.
/// Returns how many rows it kept.
///
/// `truncated` is set: it used to be left as the engine reported it, so a
/// result cut to `--max-rows` arrived looking complete, and a model that cannot
/// tell a page from a table either concludes the table ends there or spends a
/// call asking again. `row_types` (MongoDB's per-cell types) is row-aligned and
/// cut with `rows`, or the two desynchronise. `rows_affected` keeps what the
/// engine reported — we drop the tail rather than lie about the count.
fn truncate_rows(result: &mut crate::commands::query::QueryResult, max: i64) -> usize {
    let max = max.max(0) as usize;
    if result.rows.len() > max {
        result.rows.truncate(max);
        if let Some(types) = result.row_types.as_mut() {
            types.truncate(max);
        }
        result.truncated = true;
    }
    result.rows.len()
}

/// Most statements one `run_queries` call, or one `run_writes` `verify` list,
/// may carry — the same bound `run_writes` puts on its writes.
const MAX_BATCH_READS: usize = crate::commands::write_batch::MAX_WRITES;

/// One answer in a `run_queries` reply or a `run_writes` `verify` list.
///
/// A failed read is an entry, not a failed call: the others ran and their
/// answers are worth having, and after `run_writes` has committed, failing the
/// call would tell the model its writes did not land when they did — the
/// one misreading that makes it write them again.
#[derive(serde::Serialize)]
#[serde(untagged)]
enum ReadOutcome {
    Rows(crate::commands::query::QueryResult),
    Failed { error: String },
}

// `router = self.tool_router` dispatches through the stored router (built once
// in `new`) instead of the macro's default `Self::tool_router()`, which would
// rebuild it on every call and leave the field unread.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Huginn {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo`/`Implementation` are `#[non_exhaustive]`, so build them
        // through the provided constructors/builders rather than struct
        // literals.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "huginndb-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(instructions())
    }
}

/// The server's instructions, plus a line about a waiting update when the app
/// has recorded one for more than a day (`updater::pending_notice`). Read at
/// `initialize`, from the file the app writes — the connector never contacts
/// the update feed itself.
fn instructions() -> String {
    let mut text = String::from(
        "Access to the databases configured in HuginnDB. Call \
         list_connections first to see which connection ids are available \
         (each shows its write policy), then pass a connection_id to the \
         other tools. Reads always work; writes (run_write, run_writes, \
         run_script, insert_row, update_cell, delete_rows) only succeed \
         when the connection's policy permits them — 'data' for row \
         changes, 'full' for schema changes — and every write is recorded \
         in the app's MCP audit log. To save calls, batch: several reads go \
         in one run_queries, several row writes in one run_writes (one \
         transaction, with `verify` reads returned after the commit — no \
         need to re-read). Separate calls may land on different pooled \
         sessions, so session state does not carry between them. For a \
         migration or any multi-step SQL script — temporary tables (CREATE \
         TEMPORARY TABLE, #temp), SET, staging inserts, INSERT … SELECT, \
         verification SELECTs — use run_script: the whole script on ONE \
         session, in one transaction, inline or from a local .sql file.",
    );
    let record = crate::updater::record::load();
    if let Some(note) =
        crate::updater::pending_notice(&record, env!("CARGO_PKG_VERSION"), crate::updater::now_ms())
    {
        text.push_str("\n\n");
        text.push_str(&note);
    }
    text
}

/// Run the MCP server over stdio until the client disconnects.
///
/// Builds a headless [`AppState`] (loading `profiles.json` / prefs /
/// known-hosts from disk with no Tauri involvement), parses config from the
/// process arguments, and serves the tool router on stdin/stdout.
/// Close pools this process hasn't used in [`POOL_IDLE_TTL`].
///
/// The sidecar's counterpart to [`crate::pool_reaper`], with one deliberate
/// difference: it reaps **every** pool, top-level included. The desktop app
/// can't, because a connection the user sees as connected must stay connected;
/// here there is no such contract, and `ensure_connected` reopens on demand.
///
/// Runs unconditionally rather than behind a flag: there is no configuration
/// under which holding a pool open across an idle hour is the behaviour
/// anyone wants from a background process.
fn spawn_idle_pool_reaper(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(POOL_SWEEP_INTERVAL).await;
            let ttl_millis = POOL_IDLE_TTL.as_millis() as u64;
            let mut victims = state
                .connections
                .read()
                .idle_pools(crate::state::now_millis(), ttl_millis);
            if victims.is_empty() {
                continue;
            }
            // A parent goes with its views, and they go first. A MongoDB view
            // shares its parent's client: reaping only the parent shut that
            // client down and left a view in the map that
            // `resolve_mongo_database_view` would keep handing out, dead. And a
            // SQL view rides its parent's SSH tunnel, which has to be up while
            // the view closes.
            {
                let conns = state.connections.read();
                let parents: Vec<String> = victims
                    .iter()
                    .filter(|id| !crate::state::is_database_view(id))
                    .cloned()
                    .collect();
                for parent in parents {
                    let prefix = crate::state::database_view_prefix(&parent);
                    victims.extend(conns.ids().into_iter().filter(|id| id.starts_with(&prefix)));
                }
            }
            victims.sort();
            victims.dedup();
            victims.sort_by_key(|id| !crate::state::is_database_view(id));
            // Remove under the lock, close outside it — `close_pool` awaits,
            // and a `parking_lot` guard must never be held across an await.
            let removed: Vec<_> = {
                let mut conns = state.connections.write();
                victims
                    .iter()
                    .filter_map(|id| conns.remove(id).map(|active| (id.clone(), active)))
                    .collect()
            };
            for (id, active) in removed {
                crate::db::pool::close_pool(
                    &active.pool,
                    crate::db::pool::PoolOwnership::for_id(&id),
                    crate::db::pool::CLOSE_TIMEOUT,
                )
                .await;
                // stderr, not stdout: stdout is the JSON-RPC channel.
                eprintln!("[huginndb-mcp] closed idle pool for connection {id}");
            }
        }
    });
}

pub async fn serve() -> anyhow::Result<()> {
    let argv: Vec<String> = std::env::args().collect();
    let config = Config::from_args(&argv);

    // A one-line startup banner on stderr (stdout is the JSON-RPC channel and
    // must stay clean). Helps confirm which connections were exposed.
    if config.saw_allow_writes {
        eprintln!(
            "[huginndb-mcp] note: --allow-writes is deprecated and ignored. Writes are now \
             governed per connection by the write policy set in HuginnDB → Settings → MCP."
        );
    }
    let state = Arc::new(AppState::new());
    // The sidecar reads the same machine anchors the app does, so a policy
    // binds the AI whether or not the app is running to serve it.
    crate::policy::install(&state.policy, None);

    // The exposed set as it stands *right now*. Only a banner and the bridge
    // handshake below read it: every enforcement path re-reads `profiles.json`
    // per call, so ticking a connection in Settings → MCP takes effect without
    // restarting the client and this snapshot going stale costs nothing.
    let exposed: Vec<crate::state::ConnectionProfile> = state
        .profiles
        .read()
        .iter()
        .filter(|p| config.exposes(p))
        .cloned()
        .collect();
    if exposed.is_empty() {
        eprintln!(
            "[huginndb-mcp] no connections exposed yet — tick the ones you want reachable in \
             HuginnDB → Settings → MCP (or pass --connections <profile-id>[,<id>...] to pin a \
             set for this client only)"
        );
    } else {
        let mut names: Vec<String> = exposed
            .iter()
            .map(|p| format!("{} ({})", p.name, p.id))
            .collect();
        names.sort();
        eprintln!(
            "[huginndb-mcp] exposing {} connection(s) from {}: {} (write policy: \
             per-connection{}, max-rows: {}, max-connections: {} per connection, idle pools \
             closed after {}s)",
            names.len(),
            if config.pinned.is_some() {
                "--connections"
            } else {
                "Settings → MCP"
            },
            names.join(", "),
            if config.read_only {
                ", forced read-only via --read-only"
            } else {
                ""
            },
            config.max_rows,
            config.max_connections,
            POOL_IDLE_TTL.as_secs(),
        );
    }

    // Attach to a running desktop app when its bridge is up, so this process
    // borrows the app's pools instead of opening its own. `None` — no app, or
    // the bridge disabled — is the ordinary case and keeps the pre-bridge
    // behaviour exactly.
    // The handshake still carries a concrete list, even when exposure is the
    // app's to decide: an app older than this change enforces exactly that
    // snapshot, which is the pre-1.21 behaviour rather than a refusal, and a
    // refusal is the one failure the sidecar cannot fall back from (it arrives
    // as an error reply mid-tool-call, not as `Unreachable`). A current app
    // ignores the snapshot and re-reads `mcp_exposed` per request — that is
    // what `defer_exposure` asks it to do.
    let allowed: Vec<String> = exposed.iter().map(|p| p.id.clone()).collect();
    let bridge =
        Arc::new(crate::bridge::client::BridgeSlot::new(allowed, config.pinned.is_none()).await);
    // The local reaper only matters when we own pools. With the bridge up it
    // has nothing to sweep, but the app can go away mid-session and this
    // process falls back — so it stays armed either way.
    spawn_idle_pool_reaper(state.clone());
    let server = Huginn::new(state, Arc::new(config), bridge);
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{query, schema};

    /// What a tier needs, as verbs — so the tests written against tiers keep
    /// pinning the per-connection policy exactly as before the verb split.
    fn needs(class: StmtClass) -> Verbs {
        match class {
            StmtClass::Read => Verbs::SELECT,
            StmtClass::DataWrite => Verbs::WRITES,
            StmtClass::Ddl => Verbs::DDL,
        }
    }
    use crate::state::{ActivePool, DbPool};

    fn args(v: &[&str]) -> Vec<String> {
        // Prepend a dummy program name; Config::from_args skips argv[0].
        std::iter::once("huginndb-mcp".to_string())
            .chain(v.iter().map(|s| s.to_string()))
            .collect()
    }

    #[test]
    fn config_defaults_expose_nothing() {
        let c = Config::from_args(&args(&[]));
        assert!(
            c.pinned.is_none(),
            "no --connections defers to the app's own mcp_exposed flags"
        );
        assert!(!c.read_only);
        assert!(!c.saw_allow_writes);
        assert_eq!(c.max_rows, DEFAULT_MAX_ROWS);
        assert_eq!(
            c.max_connections, DEFAULT_MAX_CONNECTIONS,
            "the sidecar must default well below the desktop app: it is one of \
             several processes sharing the user's connection budget"
        );
    }

    /// Every tool answers through `ok_json`, and what it writes is billed to
    /// the user's plan by the token: a pretty-printed result set spent one
    /// newline-and-indent run per cell.
    #[test]
    fn a_script_file_is_read_as_utf8_or_bom_marked_utf16() {
        let text = "INSERT INTO t VALUES ('ñ');";
        assert_eq!(decode_script(text.as_bytes()).as_deref(), Some(text));
        let bom = [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat();
        assert_eq!(decode_script(&bom).as_deref(), Some(text));
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_script(&le).as_deref(), Some(text));
        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(decode_script(&be).as_deref(), Some(text));
        assert_eq!(decode_script(&[0xC3, 0x28]), None);
    }

    #[tokio::test]
    async fn run_script_reads_only_absolute_sql_files() {
        let dir = std::env::temp_dir().join(format!("huginndb-script-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sql = dir.join("migrate.SQL");
        std::fs::write(&sql, "INSERT INTO t VALUES (1);").unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "secret").unwrap();

        assert_eq!(
            read_script_file(sql.to_str().unwrap()).await.unwrap(),
            "INSERT INTO t VALUES (1);"
        );
        let refused = |r: Result<String, ErrorData>| r.unwrap_err().message.to_string();
        assert!(refused(read_script_file(txt.to_str().unwrap()).await).contains(".sql file"));
        assert!(refused(read_script_file("migrate.sql").await).contains("absolute"));
        assert!(
            refused(read_script_file(dir.join("missing.sql").to_str().unwrap()).await)
                .contains("cannot read")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_results_are_compact_json() {
        let result = query::QueryResult::rows(
            vec![query::ColumnMeta {
                name: "id".into(),
                data_type: "INTEGER".into(),
            }],
            vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            0,
        );
        let call = ok_json(&result).expect("serialises");
        let wire = serde_json::to_value(&call).expect("CallToolResult serialises");
        let text = wire["content"][0]["text"].as_str().expect("one text block");
        assert!(!text.contains('\n'), "pretty-printed tool result: {text}");
        assert!(text.contains(r#""rows":[[1],[2]]"#), "{text}");
    }

    #[test]
    fn config_parses_max_connections_in_both_spellings() {
        assert_eq!(
            Config::from_args(&args(&["--max-connections", "4"])).max_connections,
            4
        );
        assert_eq!(
            Config::from_args(&args(&["--max-connections=7"])).max_connections,
            7
        );
        // Garbage and zero leave the default in place rather than producing a
        // pool that can't hand out a connection.
        assert_eq!(
            Config::from_args(&args(&["--max-connections", "0"])).max_connections,
            DEFAULT_MAX_CONNECTIONS
        );
        assert_eq!(
            Config::from_args(&args(&["--max-connections", "lots"])).max_connections,
            DEFAULT_MAX_CONNECTIONS
        );
    }

    #[test]
    fn config_parses_connections_read_only_and_max_rows() {
        let c = Config::from_args(&args(&[
            "--connections",
            "alpha, beta ,gamma",
            "--read-only",
            "--max-rows=50",
        ]));
        let pinned = c.pinned.as_ref().expect("the flag pins a set");
        assert!(pinned.contains("alpha"));
        assert!(pinned.contains("beta"));
        assert!(pinned.contains("gamma"));
        assert_eq!(pinned.len(), 3);
        assert!(c.read_only);
        assert_eq!(c.max_rows, 50);
    }

    #[test]
    fn an_empty_connections_value_pins_an_empty_set() {
        // Distinct from omitting the flag: `--connections ""` is an explicit
        // "expose nothing", while no flag at all defers to Settings → MCP.
        // Collapsing the two would turn a deliberate lockdown into a wide-open
        // one on upgrade.
        let c = Config::from_args(&args(&["--connections", ""]));
        let pinned = c.pinned.as_ref().expect("the flag was seen");
        assert!(pinned.is_empty());
    }

    /// Config for the resolver tests: `None` defers to `mcp_exposed`, `Some`
    /// pins that set.
    fn resolver_config(pinned: Option<&[&str]>) -> Config {
        Config {
            pinned: pinned.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
            read_only: false,
            max_rows: DEFAULT_MAX_ROWS,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            saw_allow_writes: false,
        }
    }

    fn exposed_profile(id: &str, name: &str) -> crate::state::ConnectionProfile {
        crate::state::ConnectionProfile {
            name: name.into(),
            mcp_exposed: true,
            ..crate::testkit::profile(id)
        }
    }

    #[test]
    fn a_connection_resolves_by_id_or_by_name() {
        let profiles = vec![exposed_profile("uuid-1", "Producción MySQL")];
        let config = resolver_config(None);
        assert_eq!(
            resolve_connection(&config, "uuid-1", &profiles).unwrap(),
            "uuid-1"
        );
        assert_eq!(
            resolve_connection(&config, "Producción MySQL", &profiles).unwrap(),
            "uuid-1"
        );
        // Case-insensitively, and tolerating the whitespace a model pads with.
        assert_eq!(
            resolve_connection(&config, "  producción mysql  ", &profiles).unwrap(),
            "uuid-1"
        );
    }

    #[test]
    fn an_id_wins_over_a_name_that_collides_with_it() {
        // Nothing stops a user naming one connection after another's uuid. The
        // id is the identity, so it must win — resolving to the *named* profile
        // would send the write somewhere the caller never asked for.
        let profiles = vec![
            exposed_profile("beta", "Alpha"),
            exposed_profile("uuid-2", "beta"),
        ];
        assert_eq!(
            resolve_connection(&resolver_config(None), "beta", &profiles).unwrap(),
            "beta"
        );
    }

    #[test]
    fn an_ambiguous_name_is_refused_and_names_the_candidates() {
        // Profile names are not unique, so this is reachable with two clients'
        // servers both called "Producción". Guessing either would be a write to
        // the wrong database.
        let profiles = vec![
            exposed_profile("uuid-1", "Producción"),
            exposed_profile("uuid-2", "producción"),
        ];
        let err = resolve_connection(&resolver_config(None), "Producción", &profiles)
            .expect_err("ambiguous");
        let msg = format!("{err:?}");
        assert!(msg.contains("uuid-1"), "{msg}");
        assert!(msg.contains("uuid-2"), "{msg}");
    }

    #[test]
    fn an_unexposed_connection_is_told_apart_from_an_unknown_one() {
        // The two need different fixes, and "unknown connection" sent the user
        // hunting for a typo when the answer was a checkbox.
        let profiles = vec![crate::testkit::profile("uuid-1")];
        let err = resolve_connection(&resolver_config(None), "uuid-1", &profiles)
            .expect_err("not exposed");
        let msg = format!("{err:?}");
        assert!(msg.contains("Settings"), "{msg}");

        // Same connection, but this client pinned its own list: the fix is the
        // command line, not the app.
        let err = resolve_connection(&resolver_config(Some(&["other"])), "uuid-1", &profiles)
            .expect_err("not in the pinned list");
        assert!(format!("{err:?}").contains("--connections"));

        let err =
            resolve_connection(&resolver_config(None), "nope", &profiles).expect_err("unknown");
        assert!(format!("{err:?}").contains("unknown connection"));
    }

    #[test]
    fn pinning_a_list_overrides_the_apps_own_flags_in_both_directions() {
        // `--connections` is an argument the user typed; a checkbox must not
        // widen it, and must not narrow it either.
        let profiles = vec![
            exposed_profile("uuid-1", "Ticked"),
            crate::testkit::profile("uuid-2"), // mcp_exposed: false
        ];
        let config = resolver_config(Some(&["uuid-2"]));
        assert_eq!(
            resolve_connection(&config, "uuid-2", &profiles).unwrap(),
            "uuid-2",
            "pinned wins over an unticked flag"
        );
        assert!(
            resolve_connection(&config, "uuid-1", &profiles).is_err(),
            "a ticked flag must not widen a pinned list"
        );
    }

    #[test]
    fn an_empty_reference_is_refused() {
        let profiles = vec![exposed_profile("uuid-1", "Alpha")];
        assert!(resolve_connection(&resolver_config(None), "   ", &profiles).is_err());
    }

    #[test]
    fn config_read_only_false_is_honoured() {
        let c = Config::from_args(&args(&["--read-only=false"]));
        assert!(!c.read_only);
    }

    #[test]
    fn config_allow_writes_is_deprecated_and_inert() {
        // The flag is recognised only so `serve` can warn; it grants nothing.
        let c = Config::from_args(&args(&["--allow-writes"]));
        assert!(c.saw_allow_writes);
        assert!(!c.read_only, "deprecated flag must not affect policy");
    }

    #[test]
    fn write_policy_maps_tiers_correctly() {
        use crate::state::McpWritePolicy::*;
        assert!(ReadOnly.allows(needs(StmtClass::Read)));
        assert!(!ReadOnly.allows(needs(StmtClass::DataWrite)));
        assert!(!ReadOnly.allows(needs(StmtClass::Ddl)));
        assert!(Data.allows(needs(StmtClass::Read)));
        assert!(Data.allows(needs(StmtClass::DataWrite)));
        assert!(!Data.allows(needs(StmtClass::Ddl)));
        assert!(Full.allows(needs(StmtClass::Read)));
        assert!(Full.allows(needs(StmtClass::DataWrite)));
        assert!(Full.allows(needs(StmtClass::Ddl)));
    }

    /// Build a `Huginn` around an in-memory profile carrying `policy`, exposed
    /// to the server. `write_policy` re-reads `profiles.json` first, but the
    /// synthetic id is not on disk, so it falls back to this in-memory profile
    /// — letting us exercise `require_verbs` without touching real state.
    fn huginn_with_policy(id: &str, policy: McpWritePolicy, read_only: bool) -> Huginn {
        let state = AppState::new();
        // Through `testkit::profile` rather than a full struct literal, which
        // is what this was: the literal spelled every field, so each new one on
        // `ConnectionProfile` broke it — and because this module is behind the
        // `mcp` feature, the break only ever surfaced on a build somebody
        // remembered to pass `--features mcp` to. `secret_override` had already
        // landed with it missing. Struct-update syntax keeps the three fields
        // this fixture is actually *about* visible and lets the rest default.
        state
            .profiles
            .write()
            .push(crate::state::ConnectionProfile {
                driver: crate::state::Driver::Sqlite,
                host: String::new(),
                port: 0,
                username: String::new(),
                mcp_write: policy,
                mcp_exposed: true,
                ..crate::testkit::profile(id)
            });
        let mut allowed = HashSet::new();
        allowed.insert(id.to_string());
        Huginn::new(
            Arc::new(state),
            Arc::new(Config {
                pinned: Some(allowed),
                read_only,
                max_rows: DEFAULT_MAX_ROWS,
                max_connections: DEFAULT_MAX_CONNECTIONS,
                saw_allow_writes: false,
            }),
            // No bridge: these tests exercise the local path, which is what a
            // sidecar runs when no desktop app is serving. `never`, not a slot
            // that has not attached yet — that one would find a developer's
            // running app and send these requests to it.
            Arc::new(crate::bridge::client::BridgeSlot::never()),
        )
    }

    /// A model calling several tools at once used to open one pool — and, over
    /// SSH, one tunnel — per call, because each found the id absent before any
    /// of them had inserted. A local open now waits for one already in flight
    /// for the same id and then reuses its pool.
    ///
    /// Holds the lock itself rather than racing two opens: two SQLite opens are
    /// too fast to overlap reliably, and the question is only whether
    /// `open_local` takes the per-id lock at all.
    /// `run_queries` and `run_writes`' `verify`: every read answered in its
    /// slot, a failure kept to its own slot, a write refused there rather than
    /// run, and one row budget across the list.
    #[tokio::test]
    async fn a_list_of_reads_answers_each_in_its_slot_under_one_row_budget() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let id = "t-read-many";
        let path =
            std::env::temp_dir().join(format!("huginndb-mcp-read-many-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (1), (2), (3)")
            .execute(&pool)
            .await
            .unwrap();
        let mut huginn = huginn_with_policy(id, McpWritePolicy::Data, false);
        huginn.config = Arc::new(Config {
            pinned: Some(HashSet::from([id.to_string()])),
            read_only: false,
            max_rows: 4,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            saw_allow_writes: false,
        });
        huginn
            .state
            .connections
            .write()
            .insert(id.into(), ActivePool::bare(DbPool::Sqlite(pool)));

        let out = huginn
            .read_many(
                id,
                id,
                &[
                    "SELECT id FROM t ORDER BY id".into(),
                    "SELECT * FROM missing".into(),
                    "DELETE FROM t WHERE id = 1".into(),
                    "SELECT id FROM t ORDER BY id".into(),
                ],
            )
            .await;
        let json = serde_json::to_value(&out).unwrap();
        assert_eq!(json[0]["rows"], serde_json::json!([[1], [2], [3]]));
        assert_eq!(json[0]["truncated"], false);
        assert!(json[1]["error"].as_str().unwrap().contains("missing"));
        assert!(json[2]["error"].as_str().unwrap().contains("writes"));
        // Three of the four rows the budget allows went to the first read.
        assert_eq!(json[3]["rows"], serde_json::json!([[1]]));
        assert_eq!(json[3]["truncated"], true);
        // And the refused DELETE did not run.
        let Ok(DbPool::Sqlite(p)) = huginn.state.pool_for(id) else {
            unreachable!()
        };
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM t")
            .fetch_one(&p)
            .await
            .unwrap();
        assert_eq!(n, 3);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_local_open_waits_for_one_already_in_flight_for_the_same_id() {
        // Its own temp file: tests in this module run concurrently.
        let path = std::env::temp_dir().join("huginndb_mcp_single_flight_test.db");
        let _ = std::fs::remove_file(&path);
        std::fs::File::create(&path).unwrap();
        let id = "single-flight";
        let huginn = huginn_with_policy(id, McpWritePolicy::default(), true);
        let profile = crate::state::ConnectionProfile {
            driver: crate::state::Driver::Sqlite,
            host: String::new(),
            port: 0,
            username: String::new(),
            database: path.to_string_lossy().into_owned(),
            ..crate::testkit::profile(id)
        };

        let lock = huginn.state.open_lock(id);
        let in_flight = lock.lock().await;
        let opening = huginn.open_local(profile.clone());
        tokio::pin!(opening);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut opening)
                .await
                .is_err(),
            "a second opener must wait for the first instead of dialling its own pool"
        );
        assert!(!huginn.state.connections.read().contains(id));

        drop(in_flight);
        opening.await.unwrap();
        assert!(huginn.state.connections.read().contains(id));

        huginn.close_local(id).await;
        let _ = std::fs::remove_file(&path);
    }

    /// The bug this guards: with the bridge attached and the app gone, every
    /// tool call failed with "ensure_connected must be handled by the caller"
    /// instead of falling back to this process's own pool, as everything around
    /// it promised. An app that quit must hand the decision back (`None`), so
    /// `ensure_connected` goes on to open a local pool.
    ///
    /// Aimed at `ensure_via_bridge` rather than `ensure_connected` because the
    /// latter checks exposure against the real `profiles.json` (convention #52).
    #[tokio::test]
    async fn an_app_that_quit_hands_the_open_back_to_this_process() {
        use crate::bridge::client::test_support::{fake_app, AfterHello};
        use crate::bridge::client::{BridgeClient, BridgeSlot};
        // Before giving up on the app the call re-reads the discovery file; on
        // a machine where HuginnDB is running it would reach that real app.
        // Never send a test's requests there. (`--features canary` points the
        // lookup at a directory no running app publishes into.)
        if crate::bridge::read_discovery().is_some() {
            eprintln!("skipped: a real HuginnDB bridge is published on this machine");
            return;
        }
        let port = fake_app(AfterHello::Quit).await;
        let client = BridgeClient::connect_to_for_test(port, "t").await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let huginn = Huginn {
            bridge: Arc::new(BridgeSlot::attached_for_test(client)),
            ..huginn_with_policy("t-fallback", McpWritePolicy::ReadOnly, false)
        };
        assert!(
            huginn.ensure_via_bridge("t-fallback").await.is_none(),
            "an unreachable app must hand the open back, not fail it"
        );
    }

    /// With the app lock on and no app serving the bridge, the sidecar has no
    /// way to unlock: every path refuses with the "locked" message rather
    /// than reaching a database — even one, like this SQLite file, that needs
    /// no password (ADR #118).
    #[tokio::test]
    async fn the_sidecar_alone_refuses_while_the_app_is_locked() {
        let huginn = huginn_with_policy("t-locked", McpWritePolicy::ReadOnly, false);
        crate::vault::force_locked_on_this_thread(Some(true));
        let refused = huginn
            .call(
                BridgeRequest::ListDatabases {
                    connection_id: "t-locked".into(),
                },
                false,
            )
            .await
            .unwrap_err()
            .to_string();
        let listing = if crate::bridge::read_discovery().is_none() {
            Some(
                huginn
                    .list_connections()
                    .await
                    .unwrap_err()
                    .message
                    .to_string(),
            )
        } else {
            // A real, unlocked HuginnDB is publishing its bridge on this
            // machine; the listing would rightly go ahead.
            None
        };
        crate::vault::force_locked_on_this_thread(None);
        assert!(refused.starts_with(crate::error::LOCKED_TAG), "{refused}");
        if let Some(listing) = listing {
            assert!(listing.starts_with(crate::error::LOCKED_TAG), "{listing}");
        }
    }

    #[test]
    fn require_verbs_enforces_per_connection_policy() {
        let ro = huginn_with_policy("t-ro", McpWritePolicy::ReadOnly, false);
        assert!(ro.require_verbs("t-ro", needs(StmtClass::Read)).is_ok());
        assert!(ro
            .require_verbs("t-ro", needs(StmtClass::DataWrite))
            .is_err());
        assert!(ro.require_verbs("t-ro", needs(StmtClass::Ddl)).is_err());

        let data = huginn_with_policy("t-data", McpWritePolicy::Data, false);
        assert!(data.require_verbs("t-data", needs(StmtClass::Read)).is_ok());
        assert!(data
            .require_verbs("t-data", needs(StmtClass::DataWrite))
            .is_ok());
        assert!(data.require_verbs("t-data", needs(StmtClass::Ddl)).is_err());

        let full = huginn_with_policy("t-full", McpWritePolicy::Full, false);
        assert!(full
            .require_verbs("t-full", needs(StmtClass::DataWrite))
            .is_ok());
        assert!(full.require_verbs("t-full", needs(StmtClass::Ddl)).is_ok());
    }

    /// The sidecar-side half of the escalation guard, spelled out as the pair
    /// of steps `run_query` actually performs: classify, then require.
    ///
    /// Before the grammar gained DDL this could not go wrong, because every
    /// mongosh write was `DataWrite` and `data` was the right answer. It can now.
    #[test]
    fn mongo_ddl_through_run_query_needs_full() {
        use crate::db::classify::classify_statement;

        let data = huginn_with_policy("t-data", McpWritePolicy::Data, false);
        let full = huginn_with_policy("t-full", McpWritePolicy::Full, false);

        for sql in [
            "db.users.createIndex({a: 1})",
            "db.users.dropIndex(\"a_1\")",
            "db.users.drop()",
            "db.users.renameCollection(\"clients\")",
        ] {
            let class = classify_statement(sql);
            assert_eq!(class, StmtClass::Ddl, "{sql}");
            assert!(
                data.require_verbs("t-data", needs(class)).is_err(),
                "a `data` connection must not reach {sql}"
            );
            assert!(full.require_verbs("t-full", needs(class)).is_ok(), "{sql}");
        }

        // ...and the DML it must not drag with it.
        let class = classify_statement("db.users.insertOne({a: 1})");
        assert_eq!(class, StmtClass::DataWrite);
        assert!(data.require_verbs("t-data", needs(class)).is_ok());
    }

    /// The availability half: a `read-only` MongoDB connection must be able to
    /// read. It could not when the tier came from the SQL keyword heuristic,
    /// which is what every bridged Mongo statement fell through to.
    #[test]
    fn a_read_only_mongo_connection_can_still_read() {
        let ro = huginn_with_policy("t-ro", McpWritePolicy::ReadOnly, false);
        for sql in [
            "db.users.find({})",
            "db.users.aggregate([{$match: {a: 1}}])",
            "db.users.countDocuments({})",
        ] {
            let class = crate::db::classify::classify_statement(sql);
            assert_eq!(class, StmtClass::Read, "{sql}");
            assert!(ro.require_verbs("t-ro", needs(class)).is_ok(), "{sql}");
        }
    }

    #[test]
    fn read_only_kill_switch_overrides_full_policy() {
        // Even a `full` connection is forced read-only when --read-only is set.
        let killed = huginn_with_policy("t-kill", McpWritePolicy::Full, true);
        assert!(killed
            .require_verbs("t-kill", needs(StmtClass::Read))
            .is_ok());
        assert!(killed
            .require_verbs("t-kill", needs(StmtClass::DataWrite))
            .is_err());
        assert!(killed
            .require_verbs("t-kill", needs(StmtClass::Ddl))
            .is_err());
    }

    async fn mongo_client() -> mongodb::Client {
        // Parsing + `with_options` only validate and spawn the driver's
        // background monitor tasks — no reachable server is required.
        let options = mongodb::options::ClientOptions::parse("mongodb://127.0.0.1:1")
            .await
            .expect("valid connection string");
        mongodb::Client::with_options(options).expect("client construction is lazy")
    }

    /// Regression test for the bug reported against a real `data`-policy Mongo
    /// connection: `write_policy` must be checked against the *profile* id
    /// (`a.connection_id`), never against `resolve_mongo_target`'s resolved
    /// pool id. For a multi-database Mongo connection (empty top-level
    /// `database`, `list_connections`' `database: ""`), a table/query call
    /// naming a `schema`/`database` resolves to the synthetic per-database id
    /// `<connection_id>::db::<name>` (`database_view_id`) — which is never a
    /// key in `profiles.json`. Checking the policy against that id used to
    /// make `write_policy` miss the lookup and silently fall back to
    /// `ReadOnly`, blocking every write on a `data`/`full` connection the
    /// moment the caller named a specific database.
    #[tokio::test]
    async fn write_policy_is_checked_against_the_real_connection_not_the_mongo_db_binding() {
        let huginn = huginn_with_policy("mongo-conn", McpWritePolicy::Data, false);
        let client = mongo_client().await;
        huginn.state.connections.write().insert(
            "mongo-conn".to_string(),
            ActivePool::bare(DbPool::Mongo(crate::state::MongoConn {
                client,
                database: None,
                sockets: Default::default(),
            })),
        );

        let target = huginn
            .resolve_mongo_target("mongo-conn", Some("iMesPyme"))
            .await
            .unwrap();
        assert_eq!(target, "mongo-conn::db::iMesPyme");

        // The bug: `require_verbs(&target, ...)` would find no profile named
        // `"mongo-conn::db::iMesPyme"` and default to ReadOnly.
        assert!(
            huginn
                .require_verbs(&target, needs(StmtClass::DataWrite))
                .is_err(),
            "sanity check: the synthetic id is never a profile id"
        );

        // The fix: callers gate on the real connection id, which does carry
        // the connection's actual `data` policy.
        assert!(huginn
            .require_verbs("mongo-conn", needs(StmtClass::DataWrite))
            .is_ok());
    }

    /// Exercises the exact classifier `run_query` uses to gate MongoDB
    /// statements: `MongoOp::is_read()` on the parsed statement, not
    /// `db::sql::is_read_only`'s plain-SQL keyword match (which never
    /// recognises mongosh syntax and used to reject every Mongo read).
    #[test]
    fn mongo_run_query_gate_classifies_reads_and_writes() {
        use crate::db::mongo::shell::parse;

        for read in [
            "db.users.find({})",
            "db.users.findOne({_id: 1})",
            "db.users.aggregate([{$match: {a: 1}}])",
            "db.users.countDocuments({})",
            "db.users.distinct('name')",
        ] {
            assert!(
                parse(read).unwrap().op.is_read(),
                "expected read-only: {read:?}"
            );
        }

        for write in [
            "db.users.insertOne({a: 1})",
            "db.users.updateOne({}, {$set: {a: 1}})",
            "db.users.deleteMany({})",
            "db.users.replaceOne({}, {a: 1})",
        ] {
            assert!(
                !parse(write).unwrap().op.is_read(),
                "expected write: {write:?}"
            );
        }
    }

    /// Some MCP clients serialize `limit`/`offset` as JSON strings despite
    /// the advertised `integer` schema — `browse_table` used to hard-reject
    /// those calls with an opaque deserialization error.
    #[test]
    fn browse_args_accept_limit_as_number_or_string() {
        let from_number: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":200}"#).unwrap();
        assert_eq!(from_number.limit, Some(200));

        let from_string: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":"200"}"#).unwrap();
        assert_eq!(from_string.limit, Some(200));

        let absent: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t"}"#).unwrap();
        assert_eq!(absent.limit, None);

        let explicit_null: args::Browse =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":null}"#).unwrap();
        assert_eq!(explicit_null.limit, None);

        let invalid: Result<args::Browse, _> =
            serde_json::from_str(r#"{"connection_id":"c","table":"t","limit":"not-a-number"}"#);
        assert!(invalid.is_err());
    }

    /// End-to-end exercise of the Tauri-independent `_inner` data path against
    /// a real (file-backed) SQLite database — the first coverage of the `db`
    /// layer without the GUI (roadmap testing item). Uses a temp file rather
    /// than `sqlite::memory:` so the schema is shared across pooled
    /// connections.
    #[tokio::test]
    async fn sqlite_inner_data_path_end_to_end() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let path = std::env::temp_dir().join("huginndb_mcp_inner_test.db");
        let _ = std::fs::remove_file(&path);
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO widget (name) VALUES ('alpha'), ('beta'), ('gamma')")
            .execute(&pool)
            .await
            .unwrap();

        let state = AppState::new();
        state.connections.write().insert(
            "test-conn".to_string(),
            ActivePool::bare(DbPool::Sqlite(pool)),
        );

        // list_tables_inner sees the table.
        let tables = schema::list_tables_inner(&state, "test-conn")
            .await
            .unwrap();
        assert!(tables.iter().any(|t| t.name == "widget"));

        // execute_with_state runs a read through the NoopSink path.
        let res = query::execute_with_state(
            &NoopSink,
            &state,
            "test-conn",
            "SELECT COUNT(*) AS n FROM widget",
        )
        .await
        .unwrap();
        assert_eq!(res.rows.len(), 1);

        // fetch_table_data_inner paginates + counts.
        let page = query::fetch_table_data_inner(
            &NoopSink,
            &state,
            query::TableQuery {
                connection_id: "test-conn".to_string(),
                schema: None,
                table: "widget".to_string(),
                limit: 10,
                offset: 0,
                order: Vec::new(),
                filter: Default::default(),
                projection: None,
                collation: None,
                hint: None,
                with_count: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.total, Some(3));
        assert_eq!(page.rows.len(), 3);

        let _ = std::fs::remove_file(&path);
    }

    /// End-to-end exercise of both insert paths against a real (file-backed)
    /// SQLite database, through the same `_inner` cores the GUI and the bridge
    /// call.
    ///
    /// Its reason to exist is the refactor that folded `insert_row_inner` onto
    /// `commands::insert`'s shared statement builder: the builder itself is
    /// covered by pure tests, but nothing exercised the single-row path end to
    /// end, so "the statement still reads the same" was the only evidence that
    /// it still *worked*. The two paths are asserted side by side because the
    /// whole point of sharing the builder is that they agree.
    ///
    /// Its own temp file, deliberately not the one the tests above use: they
    /// run concurrently in one process and would fight over it.
    #[tokio::test]
    async fn sqlite_insert_paths_end_to_end() {
        use crate::commands::insert::insert_rows_inner;
        use crate::commands::query::{insert_row_inner, RowValue};
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let path = std::env::temp_dir().join("huginndb_mcp_insert_paths_test.db");
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL, \
             qty INTEGER, note TEXT DEFAULT 'unset')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let state = AppState::new();
        state.connections.write().insert(
            "test-conn".to_string(),
            ActivePool::bare(DbPool::Sqlite(pool)),
        );

        let rv = |column: &str, value: &str| RowValue {
            column: column.to_string(),
            value: Some(value.to_string()),
            column_type: None,
        };

        // Single row, through the path the grid's draft row uses. SQLite
        // reports the generated rowid.
        let returned = insert_row_inner(
            &NoopSink,
            &state,
            "test-conn".to_string(),
            None,
            "widget".to_string(),
            Some("id".to_string()),
            vec![rv("name", "alpha"), rv("qty", "1")],
        )
        .await
        .unwrap();
        assert_eq!(returned, serde_json::json!(1));

        // Many rows, through the pasted-JSON path, into the same table.
        let summary = insert_rows_inner(
            &NoopSink,
            &state,
            "test-conn".to_string(),
            None,
            "widget".to_string(),
            r#"[{"name":"beta","qty":2},{"name":"gamma","qty":null}]"#.to_string(),
        )
        .await
        .unwrap();
        assert_eq!(summary.inserted, 2);
        assert_eq!(summary.statements, 1);
        assert_eq!(summary.columns, vec!["name".to_string(), "qty".to_string()]);

        let page = query::fetch_table_data_inner(
            &NoopSink,
            &state,
            query::TableQuery {
                connection_id: "test-conn".to_string(),
                schema: None,
                table: "widget".to_string(),
                limit: 10,
                offset: 0,
                order: Vec::new(),
                filter: Default::default(),
                projection: None,
                collation: None,
                hint: None,
                with_count: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.total, Some(3));
        // A column nobody named takes its database default rather than NULL —
        // the semantics that make refusing a heterogeneous paste the right call.
        let note_idx = page.columns.iter().position(|c| c.name == "note").unwrap();
        assert!(page
            .rows
            .iter()
            .all(|r| r[note_idx] == serde_json::json!("unset")));
        // ...while an explicit JSON null really is a SQL NULL.
        let qty_idx = page.columns.iter().position(|c| c.name == "qty").unwrap();
        assert!(page.rows.iter().any(|r| r[qty_idx].is_null()));

        // A key the table does not have is refused by name, and nothing lands.
        let err = insert_rows_inner(
            &NoopSink,
            &state,
            "test-conn".to_string(),
            None,
            "widget".to_string(),
            r#"{"name":"delta","nmae":"typo"}"#.to_string(),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("nmae"), "{err}");

        let _ = std::fs::remove_file(&path);
    }

    /// End-to-end exercise of the whole view lifecycle against a real
    /// (file-backed) SQLite database, through the same `_inner` cores the MCP
    /// tools call.
    ///
    /// SQLite is the ideal driver for this: no server, no fixtures, and it takes
    /// the *hardest* path in `build_view_ddl` — it has neither `CREATE OR
    /// REPLACE VIEW` nor `ALTER VIEW`, so every change is a drop-and-recreate
    /// whose statement order matters (emit them the other way round and the
    /// second statement destroys what the first just built).
    ///
    /// Its own temp file, deliberately not the one
    /// `sqlite_inner_data_path_end_to_end` uses: the two run concurrently in one
    /// process and would fight over it.
    #[tokio::test]
    async fn sqlite_view_lifecycle_end_to_end() {
        use crate::commands::view::{
            drop_view_inner, get_any_view_definition_inner, save_any_view_inner, ViewSaveRequest,
        };
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let path = std::env::temp_dir().join("huginndb_mcp_view_lifecycle_test.db");
        let _ = std::fs::remove_file(&path);
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ok INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO widget (name, ok) VALUES ('alpha', 1), ('beta', 0)")
            .execute(&pool)
            .await
            .unwrap();

        let state = AppState::new();
        state.connections.write().insert(
            "test-conn".to_string(),
            ActivePool::bare(DbPool::Sqlite(pool)),
        );

        let request =
            |name: &str, query: &str, rename_from: Option<&str>, preview: bool| ViewSaveRequest {
                connection_id: "test-conn".to_string(),
                schema: None,
                name: name.to_string(),
                query: query.to_string(),
                rename_from: rename_from.map(str::to_string),
                view_on: None,
                preview,
            };

        // A table is not a view: `describe_table`'s view half stays absent, and
        // that is an answer rather than an error.
        assert!(
            get_any_view_definition_inner(&state, "test-conn", None, "widget")
                .await
                .unwrap()
                .is_none()
        );

        // Create. `original` is absent, so this is a plain CREATE — one
        // statement, no drop-and-recreate.
        let created = save_any_view_inner(
            &NoopSink,
            &state,
            &request(
                "ok_widgets",
                "SELECT id, name FROM widget WHERE ok = 1",
                None,
                false,
            ),
        )
        .await
        .unwrap();
        assert!(created.applied);
        assert!(!created.drop_and_recreate);
        assert_eq!(created.statements.len(), 1);

        // The body reads back, stripped of its `CREATE VIEW ... AS` header.
        let body = get_any_view_definition_inner(&state, "test-conn", None, "ok_widgets")
            .await
            .unwrap()
            .expect("the view exists");
        assert_eq!(
            body.query.as_deref(),
            Some("SELECT id, name FROM widget WHERE ok = 1")
        );
        // SQL drivers fill only `query` — no Mongo fields leak in.
        assert!(body.view_on.is_none() && body.pipeline.is_none());

        // And it is a working relation, not just a catalog row.
        let rows = query::execute_with_state(
            &NoopSink,
            &state,
            "test-conn",
            "SELECT COUNT(*) AS n FROM ok_widgets",
        )
        .await
        .unwrap();
        assert_eq!(rows.rows.len(), 1);

        // Preview a redefinition: statements are built, nothing runs.
        let preview = save_any_view_inner(
            &NoopSink,
            &state,
            &request("ok_widgets", "SELECT id FROM widget", None, true),
        )
        .await
        .unwrap();
        assert!(!preview.applied);
        assert!(
            preview.drop_and_recreate,
            "SQLite always drops and recreates"
        );
        assert_eq!(preview.statements.len(), 2);
        assert!(preview.statements[0].starts_with("DROP VIEW"));
        assert!(
            preview.statements[1].starts_with("CREATE VIEW"),
            "order is load-bearing: recreating before dropping destroys the new view"
        );
        // The database is untouched by a dry run.
        assert_eq!(
            get_any_view_definition_inner(&state, "test-conn", None, "ok_widgets")
                .await
                .unwrap()
                .and_then(|b| b.query)
                .as_deref(),
            Some("SELECT id, name FROM widget WHERE ok = 1")
        );

        // Apply the same change: what was previewed is what runs.
        let applied = save_any_view_inner(
            &NoopSink,
            &state,
            &request("ok_widgets", "SELECT id FROM widget", None, false),
        )
        .await
        .unwrap();
        assert!(applied.applied);
        assert_eq!(applied.statements, preview.statements);
        assert_eq!(
            get_any_view_definition_inner(&state, "test-conn", None, "ok_widgets")
                .await
                .unwrap()
                .and_then(|b| b.query)
                .as_deref(),
            Some("SELECT id FROM widget")
        );

        // Rename, preserving the body. The caller supplies only the old and new
        // names — the tool reads the definition itself.
        save_any_view_inner(
            &NoopSink,
            &state,
            &request(
                "widget_ids",
                "SELECT id FROM widget",
                Some("ok_widgets"),
                false,
            ),
        )
        .await
        .unwrap();
        assert!(
            get_any_view_definition_inner(&state, "test-conn", None, "ok_widgets")
                .await
                .unwrap()
                .is_none(),
            "the old name is gone"
        );
        assert_eq!(
            get_any_view_definition_inner(&state, "test-conn", None, "widget_ids")
                .await
                .unwrap()
                .and_then(|b| b.query)
                .as_deref(),
            Some("SELECT id FROM widget")
        );

        // Renaming something absent is an error, not a silent create under the
        // new name.
        assert!(save_any_view_inner(
            &NoopSink,
            &state,
            &request("whatever", "SELECT 1", Some("no_such_view"), false),
        )
        .await
        .is_err());

        // Drop, and it is gone.
        drop_view_inner(&NoopSink, &state, "test-conn", None, "widget_ids")
            .await
            .unwrap();
        assert!(
            get_any_view_definition_inner(&state, "test-conn", None, "widget_ids")
                .await
                .unwrap()
                .is_none()
        );

        let _ = std::fs::remove_file(&path);
    }

    /// The MCP Bundle manifest must list exactly the tools the router serves.
    ///
    /// `mcpb/manifest.json` is what an MCPB-aware client (and Anthropic's
    /// directory review) reads to describe this extension before ever starting
    /// it, so a tool added here and forgotten there makes the bundle lie about
    /// itself — silently, and in the one place nobody re-reads. Nothing links
    /// the two files, so this test is the link.
    #[test]
    fn the_mcpb_manifest_lists_exactly_the_tools_we_serve() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../mcpb/manifest.json");
        let raw = std::fs::read_to_string(path).expect("mcpb/manifest.json");
        let manifest: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
        let mut declared: Vec<String> = manifest["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|t| t["name"].as_str().expect("tool name").to_string())
            .collect();
        declared.sort();

        let mut served: Vec<String> = Huginn::tool_router()
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        served.sort();

        assert_eq!(
            declared, served,
            "mcpb/manifest.json's tool list has drifted from the router"
        );
    }

    /// Every tool must carry a human-readable title and an explicit
    /// `readOnlyHint`.
    ///
    /// Nothing in the type system enforces this — `annotations` is optional on
    /// `Tool`, so a new tool compiles fine with none and simply tells clients
    /// nothing about whether it writes. The cost is not cosmetic: a client's
    /// auto-approval mode and its permission rules read these hints, so an
    /// unannotated read gets treated with the same suspicion as a DELETE, and
    /// an unannotated write gets no more friction than a SELECT. Same family as
    /// the unenforced steps convention #49 records — the test is the enforcement.
    #[test]
    fn every_tool_declares_a_title_and_a_read_only_hint() {
        for tool in Huginn::tool_router().list_all() {
            let name = &tool.name;
            assert!(
                tool.title.as_deref().is_some_and(|t| !t.trim().is_empty()),
                "{name}: needs a human-readable title"
            );
            let annotations = tool
                .annotations
                .as_ref()
                .unwrap_or_else(|| panic!("{name}: needs annotations"));
            assert!(
                annotations.read_only_hint.is_some(),
                "{name}: must say whether it modifies anything"
            );
            assert!(
                annotations.open_world_hint.is_some(),
                "{name}: must say whether its domain is closed"
            );
        }
    }

    /// The seven write tools must never advertise themselves as read-only, and
    /// must each state whether they are destructive — the half of the contract
    /// a client uses to decide how loudly to ask.
    #[test]
    fn the_write_tools_are_annotated_as_writes() {
        let tools = Huginn::tool_router().list_all();
        for name in WRITE_TOOLS {
            let tool = tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("tool {name} missing from tool_router"));
            let a = tool.annotations.as_ref().expect("annotated");
            assert_eq!(
                a.read_only_hint,
                Some(false),
                "{name}: writes are not read-only"
            );
            assert!(
                a.destructive_hint.is_some(),
                "{name}: must state whether it destroys or only adds"
            );
        }
        // And the two that only ever add must not be lumped in with the ones
        // that overwrite or remove: `destructive_hint` defaults to true when it
        // is absent, so saying "false" out loud is the whole point.
        for name in ["insert_row", "create_index"] {
            let tool = tools.iter().find(|t| t.name == name).unwrap();
            assert_eq!(
                tool.annotations.as_ref().unwrap().destructive_hint,
                Some(false),
                "{name}: additive"
            );
        }
    }

    /// The two statement tools are annotated as the constants they now are:
    /// `run_query` reads, `run_write` writes. Neither depends on any
    /// connection's policy, which is the property that keeps them honest for a
    /// client that caches `tools/list` at startup.
    #[test]
    fn the_two_statement_tools_are_annotated_as_constants() {
        let tools = Huginn::tool_router().list_all();
        let ann = |name: &str| {
            tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
                .annotations
                .clone()
                .expect("annotated")
        };
        assert_eq!(ann("run_query").read_only_hint, Some(true));
        assert_eq!(ann("run_write").read_only_hint, Some(false));
        assert_eq!(ann("run_write").destructive_hint, Some(true));
    }

    /// `--read-only` takes every write tool off the surface rather than leaving
    /// eight tools that can only answer with a refusal.
    ///
    /// It is also the *only* input allowed to vary the surface: it is a process
    /// argument, so unlike a per-connection policy it cannot change under a
    /// client that cached `tools/list` at startup. See `disable_write_tools`.
    #[test]
    fn read_only_mode_removes_the_write_tools() {
        let normal = huginn_with_policy("t-ann", McpWritePolicy::Full, false);
        for name in WRITE_TOOLS {
            assert!(
                normal.tool_router.get(name).is_some(),
                "{name} should be offered when writes are possible"
            );
        }

        let killed = huginn_with_policy("t-ann", McpWritePolicy::Full, true);
        for name in WRITE_TOOLS {
            assert!(
                killed.tool_router.get(name).is_none(),
                "{name} must not be offered under --read-only"
            );
        }
        // The read half survives, or the flag would leave nothing usable.
        assert!(killed.tool_router.get("run_query").is_some());
    }

    /// Regression test for issue #83: the write tools' input schemas must
    /// stay free of `$ref`/`$defs` and bare-boolean subschemas, since at
    /// least one MCP client's `tools/list` ingestion chokes on those shapes
    /// and silently drops every tool for the session — even though the
    /// server itself considers the schema valid (rmcp only checks the root
    /// is `type: object`).
    #[test]
    fn write_tool_schemas_avoid_ref_and_bare_boolean_subschemas() {
        let tools = Huginn::tool_router().list_all();
        for name in [
            "insert_row",
            "update_cell",
            "delete_rows",
            "save_view",
            "drop_view",
            "create_index",
            "drop_index",
            // Nested `writes: [{sql, expect_rows}]` — the shape that reaches
            // for `$ref` without `#[schemars(inline)]`.
            "run_writes",
            // Not a write, but a list argument, checked for the same shapes.
            "run_queries",
            // Optional string/boolean arguments.
            "run_script",
        ] {
            let tool = tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("tool {name} missing from tool_router"));
            assert_eq!(
                tool.input_schema.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "{name}: root schema must stay type:object (rmcp's own invariant)"
            );
            let raw = serde_json::to_string(tool.input_schema.as_ref()).unwrap();
            assert!(
                !raw.contains("\"$ref\""),
                "{name}: schema must not use $ref: {raw}"
            );
            assert!(
                !raw.contains("\"$defs\""),
                "{name}: schema must not use $defs: {raw}"
            );
            assert!(
                !raw.contains("\"items\":true") && !raw.contains("\"items\": true"),
                "{name}: schema must not have a bare-boolean items subschema: {raw}"
            );
            // The other bare-boolean shape schemars can emit, and one the
            // original version of this test did not cover.
            assert!(
                !raw.contains("\"additionalProperties\":true")
                    && !raw.contains("\"additionalProperties\": true"),
                "{name}: schema must not have a bare-boolean additionalProperties: {raw}"
            );
        }
    }

    /// The seven Pulse tools are registered and advertise a sane schema.
    /// Same shape as the write-tool regression test above, run over reads:
    /// `PulseMetrics`/`PulseExplain` are the two new args structs this batch
    /// added, and both are flat (`String`/`i64` fields only), so this pins
    /// down that staying flat keeps schemars from reaching for `$ref`/`$defs`
    /// the way a nested struct would (issue #83).
    #[test]
    fn pulse_tool_schemas_are_registered_and_stay_flat() {
        let tools = Huginn::tool_router().list_all();
        for name in [
            "pulse_health",
            "pulse_metrics",
            "pulse_top_queries",
            "pulse_explain",
            "pulse_storage",
            "pulse_sessions",
            "pulse_index_usage",
        ] {
            let tool = tools
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("tool {name} missing from tool_router"));
            assert_eq!(
                tool.input_schema.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "{name}: root schema must stay type:object"
            );
            let raw = serde_json::to_string(tool.input_schema.as_ref()).unwrap();
            assert!(
                !raw.contains("\"$ref\""),
                "{name}: schema must not use $ref: {raw}"
            );
            assert!(
                !raw.contains("\"$defs\""),
                "{name}: schema must not use $defs: {raw}"
            );
        }
    }

    /// The view tools are DDL, and must be refused at `data` as firmly as at
    /// `read-only`.
    ///
    /// Written down because the tempting simplification — "a view is just a
    /// stored query, let `data` manage them" — is a privilege escalation rather
    /// than a convenience: `db::sql::classify` already sends `CREATE OR REPLACE
    /// VIEW` and `DROP VIEW` to `StmtClass::Ddl`, so a `data` connection is
    /// refused those through `run_query`, and a tool that granted them anyway
    /// would hand back exactly what the policy just denied. If this assertion
    /// ever needs changing, that reasoning has to be answered first.
    #[test]
    fn managing_a_view_needs_full_not_data() {
        use crate::state::McpWritePolicy::{Data, Full, ReadOnly};
        assert!(!ReadOnly.allows(needs(StmtClass::Ddl)));
        assert!(!Data.allows(needs(StmtClass::Ddl)));
        assert!(Full.allows(needs(StmtClass::Ddl)));
        // A preview builds statements and executes nothing, so it rides the
        // read tier and is available at every level.
        assert!(ReadOnly.allows(needs(StmtClass::Read)));
    }

    /// Regression guard for the Mongo policy-id trap, at the DDL tier the two
    /// view writes use.
    ///
    /// A MongoDB per-database target is the synthetic `<id>::db::<name>`, which
    /// is never a key in `profiles.json`. `require_verbs` must therefore be
    /// handed the real profile id: called with the resolved target it misses the
    /// lookup, and because `McpWritePolicy` defaults to `ReadOnly` it would
    /// refuse a view change the user had explicitly allowed. Sibling of
    /// `write_policy_is_checked_against_the_real_connection_not_the_mongo_db_binding`
    /// above, which covers the same trap one tier down.
    #[test]
    fn view_writes_check_the_ddl_policy_against_the_profile_not_the_mongo_view() {
        let huginn = huginn_with_policy("mongo-conn", McpWritePolicy::Full, false);

        // The real profile id: `full` admits DDL, so both view writes proceed.
        assert!(huginn
            .require_verbs("mongo-conn", needs(StmtClass::Ddl))
            .is_ok());

        // The resolved per-database id is not a profile id, so a policy lookup
        // against it falls back to ReadOnly and refuses.
        assert!(huginn
            .require_verbs("mongo-conn::db::shop", needs(StmtClass::Ddl))
            .is_err());
    }

    /// A failure the desktop app reports over the bridge must reach the MCP
    /// client exactly as the sidecar's own no-app path would word it. The app
    /// sends its `AppError` already rendered, prefix included; wrapping that
    /// in `InvalidInput` again used to print `invalid input: invalid input: …`.
    #[test]
    fn a_bridged_error_reads_like_the_same_error_raised_locally() {
        let local = crate::error::AppError::InvalidInput(
            "\"payroll\" on connection \"Policy Test\" is not available to the AI".into(),
        );
        // What `bridge::server::handle` puts on the wire.
        let wire = local.to_string();
        let bridged = to_err(crate::error::AppError::Bridged(wire.clone()));

        assert_eq!(bridged.message, to_err(local).message);
        assert_eq!(bridged.message, wire);
        assert!(!bridged.message.contains("invalid input: invalid input:"));
    }
}
