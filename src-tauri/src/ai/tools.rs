//! The read surface HuginnDB describes to a model, and the mapping from a tool
//! call back onto [`BridgeRequest`].
//!
//! # Why a second catalogue instead of reusing `crate::mcp`'s
//!
//! The `#[tool]` macros in `crate::mcp` are rmcp-specific *presentation*: they
//! produce an MCP tool router, over a transport, for a client that speaks MCP.
//! What an OpenAI-compatible `/chat/completions` call needs is a JSON array of
//! `{name, description, parameters}` plus a dispatcher — the same substance in
//! a different envelope. Both envelopes sit over the one [`BridgeRequest`] /
//! [`crate::bridge::exec`] data path, which is why phase 1 refactors nothing:
//! it adds a presentation layer, it does not move the surface it presents.
//!
//! # Why [`exposure`] has no `_` arm
//!
//! `crate::bridge::server`'s `policy_id_of` and `class_of` both end in
//! `_ => None`, so a [`BridgeRequest`] variant added without touching them is
//! silently unclassified rather than a build error (convention #49). Those two now
//! have a second consumer, which doubles the stakes — and this module answers a
//! *sharper* question than they do: not "which tier does this need" but "may a
//! language model reach this at all, and does its reply carry rows". Getting
//! that wrong is exactly how the metadata-only guarantee leaks.
//!
//! So [`exposure`] is an exhaustive match, the pattern `MongoOp::class` uses
//! (ADR #54): a new variant does not compile until somebody has decided, in
//! writing, whether a model may call it. That is the whole mechanism, and it is
//! why this module keeps its own mapping instead of extending `class_of`.

use crate::ai::scope::DataScope;
use crate::bridge::protocol::BridgeRequest;
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};

/// One tool, as the model sees it.
#[derive(Debug)]
pub struct ToolSpec {
    /// The name the model calls. Matches the MCP connector's tool names
    /// wherever the two overlap — one product should not have two vocabularies
    /// for the same operation.
    pub name: &'static str,
    /// Model-facing description. Terse and behavioural: a small model reads
    /// this to choose, and pays for every token of it on every turn.
    pub description: &'static str,
    /// JSON Schema for the arguments. A function rather than a `&'static str`
    /// so it is built with `serde_json` and cannot be malformed JSON.
    pub schema: fn() -> Value,
    /// Whether this tool's reply puts row data into the model's context.
    ///
    /// The flag the metadata-only guarantee is built on: [`catalogue`] omits
    /// every spec carrying it under [`DataScope::MetadataOnly`], and
    /// [`to_request`] cross-checks it against [`exposure`] so a tool cannot
    /// claim to be metadata-only while mapping onto a row-returning request.
    pub needs_rows: bool,
}

/// Whether a language model may reach a [`BridgeRequest`] variant, and what its
/// reply carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exposure {
    /// Reachable, and the reply carries no row data.
    Metadata,
    /// Reachable, and the reply puts rows in the model's context.
    Rows,
    /// Never reachable by a model.
    Never,
}

/// The exhaustive decision described in this module's docs. **No `_` arm.**
pub fn exposure(request: &BridgeRequest) -> Exposure {
    use BridgeRequest::*;
    match request {
        // Metadata reads: names, types, indexes, versions, view bodies.
        ListDatabases { .. }
        | ListTables { .. }
        | GetTableStructure { .. }
        | ListIndexes { .. }
        | ServerVersion { .. }
        | GetViewDefinition { .. } => Exposure::Metadata,

        // Pulse's two diagnostic reads. `PulseExplain` returns a plan for a
        // statement the model itself supplied, and `PulseTopQueries` returns
        // the server's own digest table, whose statement text is normalised
        // (`?` placeholders) by every engine that exposes it — so neither is a
        // row read. They are here because "why is this slow" is the question
        // the assistant answers best, and one of the few a 4B model answers at
        // all.
        PulseExplain { .. } | PulseTopQueries { .. } => Exposure::Metadata,

        // The two that put rows in the prompt. Both gated by `DataScope`.
        RunStatement { .. } | FetchTableData { .. } => Exposure::Rows,

        // Reachable through the bridge, deliberately not offered to a model.
        //
        // These Pulse reads are useful but not yet earned: v1's assisted tasks
        // cover the slow-query case with `PulseExplain`, and every extra tool
        // costs a small model accuracy on every turn. Add one when a task needs
        // it, not because the variant exists.
        PulseHealth { .. }
        | PulseMetrics { .. }
        | PulseStorage { .. }
        | PulseSessions { .. }
        | PulseIndexUsage { .. } => Exposure::Never,

        // Who may log in and what they may do is the most attack-shaped thing
        // HuginnDB can read, and no assisted task needs it. Withheld on
        // purpose, not by omission.
        ListUsers { .. } | ListPrivileges { .. } => Exposure::Never,

        // Plumbing. Pool ownership and target resolution are the executor's
        // job, decided from the tool's own arguments — a model that could call
        // these could open pools and address synthetic connection ids.
        EnsureConnected { .. } | ResolveMongoTarget { .. } | IsMongo { .. } => Exposure::Never,

        // Every write, and the dry run that builds one. Decision D4: the
        // assistant proposes SQL, the user runs it. A write-capable assistant
        // is a separate decision with a separate threat model — not a tool
        // somebody adds to this list.
        InsertRow { .. }
        | UpdateCell { .. }
        | DeleteRows { .. }
        | RunWriteBatch { .. }
        | PreviewViewChange { .. }
        | ApplyViewChange { .. }
        | DropView { .. }
        | CreateMongoIndex { .. }
        | DropMongoIndex { .. } => Exposure::Never,
    }
}

pub const LIST_DATABASES: &str = "list_databases";
pub const LIST_TABLES: &str = "list_tables";
pub const DESCRIBE_TABLE: &str = "describe_table";
pub const LIST_INDEXES: &str = "list_indexes";
pub const SERVER_VERSION: &str = "server_version";
pub const GET_VIEW_DEFINITION: &str = "get_view_definition";
pub const PULSE_EXPLAIN: &str = "pulse_explain";
pub const PULSE_TOP_QUERIES: &str = "pulse_top_queries";
pub const RUN_QUERY: &str = "run_query";
pub const BROWSE_TABLE: &str = "browse_table";

/// Every tool v1 can offer, before [`DataScope`] filtering.
///
/// Read-tier only, and no write variant appears at all — see [`exposure`].
pub const CATALOGUE: &[ToolSpec] = &[
    ToolSpec {
        name: LIST_DATABASES,
        description: "List the databases on this connection's server.",
        schema: no_args,
        needs_rows: false,
    },
    ToolSpec {
        name: LIST_TABLES,
        description: "List the tables, views and collections visible on this connection.",
        schema: no_args,
        needs_rows: false,
    },
    ToolSpec {
        name: DESCRIBE_TABLE,
        description: "Describe one table: its columns, types, nullability, defaults and keys. \
                      For a view, also its definition. Call this whenever you need to know a \
                      table's columns — do not ask the user to paste a schema you can read.",
        schema: table_args,
        needs_rows: false,
    },
    ToolSpec {
        name: LIST_INDEXES,
        description: "List the indexes on one table, with the columns each covers.",
        schema: table_args,
        needs_rows: false,
    },
    ToolSpec {
        name: SERVER_VERSION,
        description: "The server's product name and version string.",
        schema: no_args,
        needs_rows: false,
    },
    ToolSpec {
        name: GET_VIEW_DEFINITION,
        description: "Read one view's definition: the SQL body, or for MongoDB the source \
                      collection and the stored pipeline.",
        schema: view_args,
        needs_rows: false,
    },
    ToolSpec {
        name: PULSE_EXPLAIN,
        description: "Ask the server for the plan it would use for one read statement, without \
                      running it.",
        schema: explain_args,
        needs_rows: false,
    },
    ToolSpec {
        name: PULSE_TOP_QUERIES,
        description: "The statements this server has spent the most time on, slowest first. \
                      Statement text is the server's normalised digest, not literal values.",
        schema: no_args,
        needs_rows: false,
    },
    ToolSpec {
        name: RUN_QUERY,
        // The description a model reads *while deciding whether to call this*,
        // which is why the propose-instead sentence cannot live here. It used
        // to, and a 12B duly generalised it: asked to summarise a table, it
        // wrote `SELECT * FROM t LIMIT 5` and asked the *user* to run it — a
        // tool telling the model to delegate the one thing the tool is for.
        // The write refusal is still enforced (`exec::refuse_unless_read`) and
        // still explained, in the refusal itself, where it is read only by a
        // model that actually tried to write.
        description: "Run one read-only statement and return its rows. This is how you answer \
                      questions about data — run the query yourself, never ask the user to run \
                      one for you.",
        schema: query_args,
        needs_rows: true,
    },
    ToolSpec {
        name: BROWSE_TABLE,
        description: "Read a page of rows from one table, without writing SQL. Use this for \
                      sample data rather than asking the user for it. The reply carries the \
                      table's real row count alongside the page.",
        schema: browse_args,
        needs_rows: true,
    },
];

/// The tools offered at `scope`.
///
/// Under [`DataScope::MetadataOnly`] the row-reading tools are **absent**, not
/// present-and-refused: see [`crate::ai`]'s coupling rule for why absence is
/// both the cheaper and the stronger answer.
pub fn catalogue(scope: DataScope) -> Vec<&'static ToolSpec> {
    CATALOGUE
        .iter()
        .filter(|spec| scope.allows_rows() || !spec.needs_rows)
        .collect()
}

/// Look one tool up *within the catalogue `scope` actually offers*.
///
/// A model can emit any string, so this is where a name that was never offered
/// becomes a message it can act on. A row tool asked for under
/// [`DataScope::MetadataOnly`] gets the reason rather than a bare "unknown
/// tool": the model never saw it in its catalogue, but the *user* reads this
/// through the Console, and "browse_table does not exist" would be a lie.
pub fn available(name: &str, scope: DataScope) -> AppResult<&'static ToolSpec> {
    if let Some(spec) = catalogue(scope).into_iter().find(|s| s.name == name) {
        return Ok(spec);
    }
    if let Some(spec) = CATALOGUE.iter().find(|s| s.name == name) {
        debug_assert!(spec.needs_rows, "a metadata tool cannot be out of scope");
        return Err(AppError::InvalidInput(format!(
            "{name:?} returns row data, and this inference endpoint is configured metadata-only. \
             Answer from the schema instead, or ask the user to allow row access for this \
             connection."
        )));
    }
    let offered = catalogue(scope)
        .iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>()
        .join(", ");
    Err(AppError::InvalidInput(format!(
        "unknown tool {name:?}. Available tools: {offered}"
    )))
}

/// The connection a tool call resolved to, plus the caps it must respect.
///
/// Built by [`crate::ai::exec`], never by a model: the two ids are the
/// executor's conclusions about *which* connection the call addresses, and
/// `max_context_rows` comes from the user's preferences.
pub struct ToolCtx {
    /// The id the data path is addressed with. For a MongoDB per-database view
    /// this differs from [`Self::policy_id`].
    pub connection_id: String,
    /// The profile id the write policy applies to.
    pub policy_id: String,
    /// Ceiling on how many rows one tool reply may put in the model's context.
    /// Pushed into the request wherever the request has a `limit` to push it
    /// into.
    pub max_context_rows: i64,
}

/// Build the [`BridgeRequest`] one tool call means.
pub fn to_request(spec: &ToolSpec, args: &Value, ctx: &ToolCtx) -> AppResult<BridgeRequest> {
    let connection_id = ctx.connection_id.clone();
    let name = spec.name;
    let request = match name {
        LIST_DATABASES => BridgeRequest::ListDatabases { connection_id },
        LIST_TABLES => BridgeRequest::ListTables { connection_id },
        SERVER_VERSION => BridgeRequest::ServerVersion { connection_id },
        PULSE_TOP_QUERIES => BridgeRequest::PulseTopQueries { connection_id },
        DESCRIBE_TABLE => BridgeRequest::GetTableStructure {
            connection_id,
            schema: optional_str(args, "schema"),
            table: required_str(args, "table", name)?,
        },
        LIST_INDEXES => BridgeRequest::ListIndexes {
            connection_id,
            schema: optional_str(args, "schema"),
            table: required_str(args, "table", name)?,
        },
        GET_VIEW_DEFINITION => BridgeRequest::GetViewDefinition {
            connection_id,
            schema: optional_str(args, "schema"),
            view: required_str(args, "view", name)?,
        },
        PULSE_EXPLAIN => BridgeRequest::PulseExplain {
            connection_id,
            sample: required_str(args, "sample", name)?,
        },
        RUN_QUERY => BridgeRequest::RunStatement {
            connection_id,
            policy_id: ctx.policy_id.clone(),
            sql: required_str(args, "sql", name)?,
        },
        BROWSE_TABLE => BridgeRequest::FetchTableData {
            connection_id,
            policy_id: ctx.policy_id.clone(),
            schema: optional_str(args, "schema"),
            table: required_str(args, "table", name)?,
            // Clamped here rather than only trimmed off the reply: the request
            // has a `limit`, so a cap applied after the fact would make the
            // server read — and the driver decode — a thousand rows in order to
            // throw most of them away.
            limit: clamped_limit(args, ctx.max_context_rows)?,
            offset: optional_i64(args, "offset")?.unwrap_or(0).max(0),
            // Asked for, and the first sentence of this comment used to say the
            // opposite. "Summarise these rows" is the question a model gets
            // most often here, and without the total it answers about the page
            // it was handed as though that were the table — which is the same
            // class of confident-and-wrong the whole feature is built to avoid.
            // It is nearly free besides: `fetch_table_data_inner` returns the
            // planner's O(1) estimate for a whole-table browse rather than a
            // real `COUNT(*)`.
            with_count: Some(true),
        },
        other => {
            return Err(AppError::InvalidInput(format!(
                "tool {other:?} is in the catalogue but has no request mapping — this is a bug"
            )));
        }
    };

    // Defence in depth, and the knot that ties `needs_rows` to the exhaustive
    // match. A spec claiming to be metadata-only while mapping onto a
    // row-returning variant would defeat `catalogue`'s filter silently; one
    // mapping onto something a model may not reach at all would defeat
    // `exposure`. Neither is a compile error, so both are checked here.
    let found = exposure(&request);
    match found {
        Exposure::Rows if spec.needs_rows => Ok(request),
        Exposure::Metadata if !spec.needs_rows => Ok(request),
        _ => Err(AppError::InvalidInput(format!(
            "tool {name:?} maps onto {} ({found:?}), which contradicts needs_rows={} — this is a \
             bug",
            request.label(),
            spec.needs_rows
        ))),
    }
}

fn no_args() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

/// `schema` doubles as the MongoDB *database* selector, exactly as it does on
/// the MCP connector's table tools — see
/// `crate::commands::connection::resolve_mongo_database_view`.
fn table_args() -> Value {
    json!({
        "type": "object",
        "properties": {
            "table": { "type": "string", "description": "Table, view or collection name." },
            "schema": {
                "type": "string",
                "description": "SQL schema, or for MongoDB the database name. Omit unless the \
                                connection spans several."
            }
        },
        "required": ["table"],
        "additionalProperties": false
    })
}

fn view_args() -> Value {
    json!({
        "type": "object",
        "properties": {
            "view": { "type": "string", "description": "View name." },
            "schema": {
                "type": "string",
                "description": "SQL schema, or for MongoDB the database name."
            }
        },
        "required": ["view"],
        "additionalProperties": false
    })
}

fn explain_args() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sample": {
                "type": "string",
                "description": "One read statement to plan. Not itself an EXPLAIN."
            },
            "database": {
                "type": "string",
                "description": "MongoDB only: which database the statement runs against."
            }
        },
        "required": ["sample"],
        "additionalProperties": false
    })
}

fn query_args() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sql": {
                "type": "string",
                "description": "One read-only statement. SQL, or mongosh syntax on a MongoDB \
                                connection. Add your own LIMIT: replies are capped and the tail \
                                is discarded."
            },
            "database": {
                "type": "string",
                "description": "MongoDB only: which database the statement runs against."
            }
        },
        "required": ["sql"],
        "additionalProperties": false
    })
}

fn browse_args() -> Value {
    json!({
        "type": "object",
        "properties": {
            "table": { "type": "string", "description": "Table or collection name." },
            "schema": {
                "type": "string",
                "description": "SQL schema, or for MongoDB the database name."
            },
            "limit": {
                "type": "integer",
                "description": "Rows to read. Capped by the user's context setting."
            },
            "offset": { "type": "integer", "description": "Rows to skip. Defaults to 0." }
        },
        "required": ["table"],
        "additionalProperties": false
    })
}

/// A required string argument, or a message naming the tool and the argument.
///
/// The message matters more here than in a hand-written client: it goes back to
/// the model as the tool result, and it is the only thing that lets a small
/// model recover instead of repeating the same malformed call.
fn required_str(args: &Value, key: &str, tool: &str) -> AppResult<String> {
    match args.get(key).and_then(Value::as_str).map(str::trim) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => Err(AppError::InvalidInput(format!(
            "{tool} requires a non-empty string argument {key:?}"
        ))),
    }
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// An optional integer argument, accepting the string form too.
///
/// Lenient on purpose: models routinely emit `"limit": "50"`, and a strict type
/// error there costs a turn to fix something that was never ambiguous. Anything
/// that is neither a number nor a numeric string is still an error — reading a
/// silent `0` out of `{"limit": {}}` would be worse than the extra turn.
fn optional_i64(args: &Value, key: &str) -> AppResult<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(|| {
            AppError::InvalidInput(format!("{key:?} must be a whole number, got {n}"))
        }),
        Some(Value::String(s)) => s.trim().parse::<i64>().map(Some).map_err(|_| {
            AppError::InvalidInput(format!("{key:?} must be a whole number, got {s:?}"))
        }),
        Some(other) => Err(AppError::InvalidInput(format!(
            "{key:?} must be a whole number, got {other}"
        ))),
    }
}

/// The `limit` a browse call may actually use: whatever the model asked for,
/// bounded by the user's context cap, and never below 1.
fn clamped_limit(args: &Value, max_context_rows: i64) -> AppResult<i64> {
    let ceiling = max_context_rows.max(1);
    Ok(optional_i64(args, "limit")?
        .unwrap_or(ceiling)
        .clamp(1, ceiling))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ToolCtx {
        ToolCtx {
            connection_id: "conn".into(),
            policy_id: "conn".into(),
            max_context_rows: 50,
        }
    }

    fn spec_for(name: &str) -> &'static ToolSpec {
        CATALOGUE
            .iter()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("{name} is not in the catalogue"))
    }

    /// Minimal valid arguments for every catalogue entry, so the tests below
    /// can walk the whole catalogue rather than a hand-picked subset.
    fn sample_args(name: &str) -> Value {
        match name {
            DESCRIBE_TABLE | LIST_INDEXES | BROWSE_TABLE => json!({ "table": "users" }),
            GET_VIEW_DEFINITION => json!({ "view": "active_users" }),
            PULSE_EXPLAIN => json!({ "sample": "SELECT 1" }),
            RUN_QUERY => json!({ "sql": "SELECT 1" }),
            _ => json!({}),
        }
    }

    /// The metadata-only guarantee, asserted at the catalogue rather than at
    /// the call: a row tool the model can *see* is a row tool it will try.
    #[test]
    fn the_metadata_only_catalogue_is_row_free() {
        let offered = catalogue(DataScope::MetadataOnly);
        assert!(!offered.is_empty(), "metadata-only must still be useful");
        for spec in &offered {
            assert!(
                !spec.needs_rows,
                "{} reaches rows and must not be offered metadata-only",
                spec.name
            );
        }
        assert_eq!(catalogue(DataScope::Rows).len(), CATALOGUE.len());
    }

    /// Ties `needs_rows` to the exhaustive match for every entry: this is what
    /// catches a tool added later that returns rows without saying so.
    #[test]
    fn every_tool_maps_onto_a_request_a_model_may_reach() {
        let ctx = ctx();
        for spec in CATALOGUE {
            let request = to_request(spec, &sample_args(spec.name), &ctx)
                .unwrap_or_else(|e| panic!("{} failed to map: {e}", spec.name));
            let expected = match spec.needs_rows {
                true => Exposure::Rows,
                false => Exposure::Metadata,
            };
            assert_eq!(
                exposure(&request),
                expected,
                "{} maps onto {}",
                spec.name,
                request.label()
            );
        }
    }

    #[test]
    fn tool_names_are_unique_and_schemas_are_object_schemas() {
        let mut seen = std::collections::HashSet::new();
        for spec in CATALOGUE {
            assert!(seen.insert(spec.name), "duplicate tool name {}", spec.name);
            let schema = (spec.schema)();
            assert_eq!(
                schema.get("type").and_then(Value::as_str),
                Some("object"),
                "{}'s schema must be an object schema",
                spec.name
            );
        }
    }

    /// D4, asserted rather than assumed: no write is reachable, and neither is
    /// the plumbing a model could use to address a connection of its own
    /// choosing.
    #[test]
    fn writes_and_plumbing_are_never_exposed() {
        let never = [
            BridgeRequest::InsertRow {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_column: None,
                values: json!({}),
            },
            BridgeRequest::DeleteRows {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                table: "t".into(),
                pk_columns: vec!["id".into()],
                pk_value_rows: vec![vec![json!(1)]],
            },
            BridgeRequest::DropView {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                view: "v".into(),
            },
            BridgeRequest::PreviewViewChange {
                connection_id: "c".into(),
                policy_id: "c".into(),
                schema: None,
                name: "v".into(),
                query: "SELECT 1".into(),
                rename_from: None,
                view_on: None,
            },
            BridgeRequest::EnsureConnected {
                connection_id: "c".into(),
            },
            BridgeRequest::ResolveMongoTarget {
                connection_id: "c".into(),
                database: "d".into(),
            },
            BridgeRequest::ListUsers {
                connection_id: "c".into(),
            },
        ];
        for request in &never {
            assert_eq!(
                exposure(request),
                Exposure::Never,
                "{} must be unreachable by a model",
                request.label()
            );
        }
        // And no catalogue entry shares a name with one of them: the tool names
        // mirror `BridgeRequest::label`, so a collision would mean a write tool
        // had been given a read tool's name.
        for spec in CATALOGUE {
            assert!(
                !never.iter().any(|request| request.label() == spec.name),
                "{} collides with an unexposed request",
                spec.name
            );
        }
    }

    /// A regression guard on the *descriptions*, which is where the bug was.
    ///
    /// A tool's description is read at the moment the model decides whether to
    /// call it. One that tells it to hand the job to the user is a tool that
    /// does not get called — and that is precisely what happened: `run_query`
    /// carried "propose the SQL to the user instead of trying to run it", and a
    /// 12B asked to summarise a table wrote the SELECT out and waited.
    #[test]
    fn no_tool_tells_the_model_to_delegate_its_own_job() {
        for spec in CATALOGUE {
            let description = spec.description.to_lowercase();
            for forbidden in ["propose", "instead of trying"] {
                assert!(
                    !description.contains(forbidden),
                    "{}'s description says {forbidden:?} — a tool must not tell the model to \
                     delegate the thing the tool exists for",
                    spec.name
                );
            }
            // Mentioning the user running something is fine when it is being
            // *forbidden*, which is what these descriptions now do. The first
            // version of this guard matched the substring and failed on the
            // prohibition — the pattern to catch is the instruction, so every
            // occurrence has to carry its negation.
            for phrase in ["ask the user", "asking the user"] {
                for (at, _) in description.match_indices(phrase) {
                    let before = &description[..at];
                    assert!(
                        before.ends_with("never ")
                            || before.ends_with("rather than ")
                            || before.ends_with("not "),
                        "{}'s description says {phrase:?} without negating it",
                        spec.name
                    );
                }
            }
        }
    }

    /// The three tools a model reaches for when it needs to look say so, in the
    /// imperative. A small model picks tools by description, not by inference.
    #[test]
    fn the_reading_tools_tell_the_model_to_use_them() {
        let of = |name: &str| {
            CATALOGUE
                .iter()
                .find(|s| s.name == name)
                .map(|s| s.description.to_lowercase())
                .unwrap_or_default()
        };
        assert!(of(RUN_QUERY).contains("run the query yourself"));
        assert!(of(DESCRIBE_TABLE).contains("call this whenever"));
        assert!(of(BROWSE_TABLE).contains("rather than asking the user"));
    }

    #[test]
    fn a_row_tool_asked_for_metadata_only_is_told_why() {
        let err = available(BROWSE_TABLE, DataScope::MetadataOnly)
            .expect_err("browse_table must be refused metadata-only")
            .to_string();
        assert!(err.contains("metadata-only"), "unhelpful message: {err}");
        assert!(available(BROWSE_TABLE, DataScope::Rows).is_ok());
    }

    #[test]
    fn an_unknown_tool_is_answered_with_the_ones_that_exist() {
        let err = available("drop_everything", DataScope::MetadataOnly)
            .expect_err("a hallucinated tool must not resolve")
            .to_string();
        assert!(err.contains("unknown tool"), "{err}");
        assert!(err.contains(LIST_TABLES), "{err}");
        // The offered list must not advertise what the scope withholds.
        assert!(!err.contains(BROWSE_TABLE), "{err}");
    }

    #[test]
    fn a_missing_required_argument_names_the_tool_and_the_argument() {
        let err = to_request(
            spec_for(DESCRIBE_TABLE),
            &json!({ "schema": "public" }),
            &ctx(),
        )
        .expect_err("table is required")
        .to_string();
        assert!(err.contains(DESCRIBE_TABLE), "{err}");
        assert!(err.contains("table"), "{err}");
    }

    #[test]
    fn browse_limit_is_clamped_to_the_context_cap() {
        let cases = [
            (json!({ "table": "t", "limit": 5000 }), 50),
            (json!({ "table": "t", "limit": 10 }), 10),
            // Absent: the cap is the default, not the driver's idea of one.
            (json!({ "table": "t" }), 50),
            // Nonsense a model can emit: clamped, not rejected.
            (json!({ "table": "t", "limit": 0 }), 1),
            (json!({ "table": "t", "limit": -3 }), 1),
            // Models routinely stringify numbers.
            (json!({ "table": "t", "limit": "12" }), 12),
        ];
        for (args, expected) in cases {
            match to_request(spec_for(BROWSE_TABLE), &args, &ctx()).unwrap() {
                BridgeRequest::FetchTableData {
                    limit,
                    offset,
                    with_count,
                    ..
                } => {
                    assert_eq!(limit, expected, "{args}");
                    assert_eq!(offset, 0);
                    // The total is what stops a model describing one page as
                    // the whole table.
                    assert_eq!(with_count, Some(true));
                }
                other => panic!("wrong variant: {}", other.label()),
            }
        }
    }

    #[test]
    fn a_non_numeric_limit_is_an_error_rather_than_a_silent_zero() {
        let err = to_request(
            spec_for(BROWSE_TABLE),
            &json!({ "table": "t", "limit": {} }),
            &ctx(),
        )
        .expect_err("an object is not a limit")
        .to_string();
        assert!(err.contains("whole number"), "{err}");
    }

    #[test]
    fn run_query_carries_the_policy_id_separately_from_the_target() {
        let ctx = ToolCtx {
            connection_id: "parent::db::shop".into(),
            policy_id: "parent".into(),
            max_context_rows: 50,
        };
        match to_request(
            spec_for(RUN_QUERY),
            &json!({ "sql": "db.orders.find({})" }),
            &ctx,
        )
        .unwrap()
        {
            BridgeRequest::RunStatement {
                connection_id,
                policy_id,
                sql,
            } => {
                assert_eq!(connection_id, "parent::db::shop");
                assert_eq!(policy_id, "parent");
                assert_eq!(sql, "db.orders.find({})");
            }
            other => panic!("wrong variant: {}", other.label()),
        }
    }
}
