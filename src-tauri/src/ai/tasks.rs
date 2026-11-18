//! Assisted mode: four jobs whose context HuginnDB assembles itself.
//!
//! # Why this exists before agent mode
//!
//! Roadmap Answer B — *shrink the job, not the model*. A tool loop needs a
//! model that emits reliable tool calls, which the hardware table says is a 14B
//! and up; an office laptop runs a 4B. But a 4B is perfectly capable of
//! explaining a statement it was *handed*, or writing SQL against a schema it
//! was *given*. So the intelligence that decides what to read moves out of the
//! model and into this file: one model call, no iteration, and a prompt whose
//! every byte was chosen here.
//!
//! That is also why assisted mode ships first. It is the mode most users can
//! actually run, and a feature that only works on a workstation is a feature
//! most of this project's users would never see.
//!
//! # The seam, and why it is where it is
//!
//! [`gather`] does the I/O — one `bridge::exec` call per thing a task needs —
//! and [`build_prompt`] is **pure**: context in, messages out. Everything worth
//! testing is in the second one. A prompt regression is invisible (the model
//! still answers, just worse), so the only defence is a test that pins what the
//! prompt contains, and that test cannot exist if building it requires a
//! database.
//!
//! # The row rule still holds
//!
//! Only [`AssistedTask::DocumentRelation`] reads rows at all, and only under
//! [`DataScope::Rows`]. Under metadata-only it drops the sample and says so in
//! the prompt rather than becoming unavailable — a documentation task that
//! refuses to run is worse than one that documents from the schema, which is
//! most of what it was going to do anyway.

use crate::ai::scope::DataScope;
use crate::bridge::protocol::BridgeRequest;
use crate::error::{AppError, AppResult};
use crate::log_bus::LogSink;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

/// How much of one gathered section may reach the prompt.
///
/// Per section rather than one total, so a 200-column table cannot crowd out
/// the `EXPLAIN` that the question was actually about. Generous enough for a
/// wide table's columns and mean enough that a context window survives it.
const SECTION_BUDGET: usize = 6000;

/// The four jobs. Each is one model call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistedTask {
    /// What does this statement do? Invoked on the editor's current statement.
    ExplainQuery,
    /// Write the SQL for this description, against the schema Rust supplies.
    NlToSql,
    /// Why is this slow? The statement plus the plan the server would use.
    ExplainSlow,
    /// Describe this relation: its columns, its indexes, and — when the scope
    /// allows — a bounded sample.
    DocumentRelation,
}

/// What the caller asked for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub task: AssistedTask,
    /// A connection id or name. Resolved among `ai_enabled` profiles only.
    pub connection: String,
    pub schema: Option<String>,
    pub table: Option<String>,
    /// The statement, for the two tasks that are about one.
    pub statement: Option<String>,
    /// The user's own words, for `NlToSql`.
    pub question: Option<String>,
}

/// Everything a builder is allowed to see.
///
/// Deliberately a flat bag of `Option`s rather than one enum per task: the
/// sections overlap heavily (three of the four want the server's identity, two
/// want a structure), and the builder reads what is there. What a task *asks*
/// for is decided in [`gather`]; what it *says* is decided in [`build_prompt`].
#[derive(Debug, Default, Clone)]
pub struct TaskContext {
    /// The server's product and version, so the model targets the right
    /// dialect instead of guessing from the SQL.
    pub server: Option<String>,
    pub statement: Option<String>,
    /// `schema.table`, as the user named it.
    pub relation: Option<String>,
    pub structure: Option<Value>,
    pub indexes: Option<Value>,
    pub explain: Option<Value>,
    /// Names only — the map a question is matched against.
    pub tables: Option<Value>,
    /// Structures of the tables a question appears to be about.
    pub relevant: Vec<(String, Value)>,
    /// A bounded page of rows. `None` under metadata-only.
    pub sample: Option<Value>,
    /// What the user wrote about this database (`ConnectionProfile::ai_notes`).
    ///
    /// The one section that comes from a person rather than from a read, and
    /// the only one that can say what a schema does not — which codes a column
    /// uses, which of two similar tables is the live one, what the database is
    /// *for*.
    pub notes: Option<String>,
    pub scope: DataScope,
}

/// Render one gathered section, bounded.
fn section(title: &str, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(body.len().min(SECTION_BUDGET) + 32);
    out.push_str("## ");
    out.push_str(title);
    out.push('\n');
    match body.char_indices().nth(SECTION_BUDGET) {
        None => out.push_str(body),
        Some((cut, _)) => {
            out.push_str(&body[..cut]);
            // Said out loud: a model handed a truncated column list should know
            // it is incomplete rather than conclude the table ends there.
            out.push_str("\n… (truncated)");
        }
    }
    out.push('\n');
    out
}

fn json_section(title: &str, value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(value) => section(
            title,
            &serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
        ),
    }
}

/// The instruction each task opens with.
///
/// Task-specific rather than one shared preamble, because the frontend's chat
/// prompt says the opposite of what is true here — in assisted mode the model
/// *has* been handed the schema, and telling it otherwise would make it hedge
/// about information sitting in front of it.
fn instruction(task: AssistedTask) -> &'static str {
    match task {
        AssistedTask::ExplainQuery => {
            "You explain SQL and mongosh statements to an experienced developer. \
             Say what the statement returns or changes, then anything about it that \
             is surprising, wrong, or likely to be slow. Be brief and concrete. Do \
             not restate the statement line by line."
        }
        AssistedTask::NlToSql => {
            "You write one statement for the request below, against the schema \
             given. Output the statement in a fenced code block tagged with the \
             dialect, then at most two sentences about it. Use only tables and \
             columns that appear in the schema — if the request needs something \
             that is not there, say so instead of inventing a name. Prefer an \
             explicit column list over `*`, and include a LIMIT on anything \
             exploratory."
        }
        AssistedTask::ExplainSlow => {
            "You are diagnosing one slow statement. The server's own plan is \
             below. Name the specific reason it is slow — the scan, the join \
             order, the missing index, the sort — and then the smallest change \
             that would fix it. If an index would help, give the exact CREATE \
             INDEX in a fenced block. Do not suggest rewriting the whole query \
             when an index is the answer."
        }
        AssistedTask::DocumentRelation => {
            "You document one database relation for a developer who has never \
             seen it. Say what it appears to hold and what each non-obvious \
             column means, note the keys and what the indexes suggest about how \
             it is queried, and flag anything that looks like a modelling \
             problem. Be brief. Do not list every column mechanically — the \
             reader can already see the schema. When you quote a value that is \
             JSON, XML or code, put it in a fenced code block rather than \
             inline in a sentence."
        }
    }
}

/// The user-facing half of the prompt.
///
/// Pure. Every section it can emit comes from [`TaskContext`], so the test
/// suite next door pins the whole prompt for each task without a server.
pub fn build_prompt(input: &TaskInput, ctx: &TaskContext) -> Vec<Value> {
    let mut body = String::new();
    // First, before the schema: it is the section that changes how everything
    // after it should be read.
    if let Some(notes) = &ctx.notes {
        body.push_str(&section("Notes", notes));
    }
    if let Some(server) = &ctx.server {
        body.push_str(&section("Server", server));
    }
    if let Some(relation) = &ctx.relation {
        body.push_str(&section("Relation", relation));
    }
    if let Some(statement) = &ctx.statement {
        body.push_str(&section("Statement", statement));
    }
    if let Some(question) = input.question.as_deref().map(str::trim) {
        if !question.is_empty() {
            body.push_str(&section("Request", question));
        }
    }
    body.push_str(&json_section("Plan", ctx.explain.as_ref()));
    body.push_str(&json_section("Columns", ctx.structure.as_ref()));
    body.push_str(&json_section("Indexes", ctx.indexes.as_ref()));
    body.push_str(&json_section("Tables", ctx.tables.as_ref()));
    for (name, structure) in &ctx.relevant {
        body.push_str(&json_section(
            &format!("Columns of {name}"),
            Some(structure),
        ));
    }
    match &ctx.sample {
        Some(sample) => body.push_str(&json_section("Sample rows", Some(sample))),
        // Only worth saying for the one task that would otherwise have had a
        // sample; elsewhere its absence is not a fact about anything.
        None if input.task == AssistedTask::DocumentRelation => body.push_str(&section(
            "Sample rows",
            "Not available: this endpoint is configured metadata-only, so no row \
             data was read. Document the relation from its schema and say nothing \
             about the values it holds.",
        )),
        None => {}
    }

    vec![
        json!({ "role": "system", "content": instruction(input.task) }),
        json!({ "role": "user", "content": body.trim_end() }),
    ]
}

/// Tables a request appears to be about.
///
/// A deliberately dumb, deterministic match: a table is relevant when its name
/// occurs in the request, case-insensitively, either whole or without a
/// trailing `s`. No embeddings, no model call, no fuzzy distance — this runs
/// *before* the one completion the task is allowed, so anything cleverer would
/// be a second inference to pick the context for the first.
///
/// It is allowed to find nothing. The prompt then carries the full table list
/// and the model asks, which is a better failure than a confidently wrong
/// subset.
pub fn relevant_tables(question: &str, tables: &[String], max: usize) -> Vec<String> {
    let haystack = question.to_lowercase();
    tables
        .iter()
        .filter(|table| {
            let name = table.to_lowercase();
            if name.len() < 3 {
                // A two-letter table name matches almost any sentence.
                return false;
            }
            haystack.contains(&name) || haystack.contains(name.trim_end_matches('s'))
        })
        .take(max)
        .cloned()
        .collect()
}

/// How many table structures `NlToSql` will fetch. Past this the prompt is
/// mostly schema and the model loses the question in it.
const MAX_RELEVANT_TABLES: usize = 6;

/// Read everything the task needs, and nothing else.
///
/// One `bridge::exec` call per section, all of them read-tier. The connection is
/// resolved through [`crate::ai::exec::resolve_connection`], so a profile the
/// user has not enabled for the assistant is unreachable here exactly as it is
/// from a tool call.
pub async fn gather(
    state: &AppState,
    sink: &dyn LogSink,
    input: &TaskInput,
    scope: DataScope,
    max_rows: i64,
) -> AppResult<TaskContext> {
    let connection_id = {
        let profiles = state.profiles.read();
        crate::ai::exec::resolve_connection(&input.connection, &profiles)?
    };
    let mut ctx = TaskContext {
        scope,
        statement: input.statement.clone(),
        // Free: already in memory, no round trip, and the section most likely
        // to stop a one-shot task guessing at a column's meaning.
        notes: crate::ai::exec::notes_for(state, &input.connection),
        ..TaskContext::default()
    };

    // Every task benefits from knowing which engine it is talking about, and it
    // is one cheap round trip. A failure is not fatal: a missing version line
    // costs dialect precision, not the answer.
    if let Ok(version) = read(
        state,
        sink,
        BridgeRequest::ServerVersion {
            connection_id: connection_id.clone(),
        },
    )
    .await
    {
        ctx.server = version
            .as_str()
            .map(str::to_string)
            .or(Some(version.to_string()));
    }

    match input.task {
        AssistedTask::ExplainQuery => {
            require_statement(input)?;
        }
        AssistedTask::ExplainSlow => {
            let statement = require_statement(input)?;
            ctx.explain = Some(
                read(
                    state,
                    sink,
                    BridgeRequest::PulseExplain {
                        connection_id: connection_id.clone(),
                        sample: statement,
                        mode: crate::pulse::ExplainMode::Plan,
                    },
                )
                .await?,
            );
        }
        AssistedTask::NlToSql => {
            let question = input
                .question
                .as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .ok_or_else(|| {
                    AppError::InvalidInput("this task needs a description to work from".into())
                })?;
            let tables = read(
                state,
                sink,
                BridgeRequest::ListTables {
                    connection_id: connection_id.clone(),
                },
            )
            .await?;
            let names = table_names(&tables);
            for name in relevant_tables(question, &names, MAX_RELEVANT_TABLES) {
                if let Ok(structure) = read(
                    state,
                    sink,
                    BridgeRequest::GetTableStructure {
                        connection_id: connection_id.clone(),
                        schema: input.schema.clone(),
                        table: name.clone(),
                    },
                )
                .await
                {
                    ctx.relevant.push((name, structure));
                }
            }
            // The full list goes in only when nothing matched: with structures
            // present it is redundant, and without them it is the map the model
            // needs to ask a sensible follow-up.
            if ctx.relevant.is_empty() {
                ctx.tables = Some(tables);
            }
        }
        AssistedTask::DocumentRelation => {
            let table = input
                .table
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .ok_or_else(|| {
                    AppError::InvalidInput("this task needs a table to document".into())
                })?
                .to_string();
            ctx.relation = Some(match &input.schema {
                Some(schema) if !schema.is_empty() => format!("{schema}.{table}"),
                _ => table.clone(),
            });
            ctx.structure = Some(
                read(
                    state,
                    sink,
                    BridgeRequest::GetTableStructure {
                        connection_id: connection_id.clone(),
                        schema: input.schema.clone(),
                        table: table.clone(),
                    },
                )
                .await?,
            );
            ctx.indexes = read(
                state,
                sink,
                BridgeRequest::ListIndexes {
                    connection_id: connection_id.clone(),
                    schema: input.schema.clone(),
                    table: table.clone(),
                },
            )
            .await
            .ok();
            // The one row read in the whole module, and the one place the
            // coupling rule bites: under metadata-only it simply does not
            // happen, and `build_prompt` says so.
            if scope.allows_rows() {
                ctx.sample = read(
                    state,
                    sink,
                    BridgeRequest::FetchTableData {
                        connection_id: connection_id.clone(),
                        policy_id: connection_id.clone(),
                        schema: input.schema.clone(),
                        table,
                        limit: sample_rows(max_rows),
                        offset: 0,
                        with_count: Some(false),
                    },
                )
                .await
                .ok();
            }
        }
    }
    Ok(ctx)
}

/// Rows a documentation sample takes.
///
/// A fraction of the tool cap, floored at one and capped at ten: the question
/// "what does this column hold" is answered by five example values, and fifty
/// of them is a context window spent on repetition.
fn sample_rows(max_rows: i64) -> i64 {
    max_rows.clamp(1, 10)
}

fn require_statement(input: &TaskInput) -> AppResult<String> {
    input
        .statement
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::InvalidInput("this task needs a statement to work on".into()))
}

/// The table names out of a `list_tables` reply, whatever shape it has.
///
/// Read defensively rather than typed: the reply is an opaque `Value` on the
/// bridge (see `crate::bridge::protocol`), and a task that hard-failed because
/// one driver spells the key differently would be a task that works on four
/// drivers out of five.
pub(crate) fn table_names(tables: &Value) -> Vec<String> {
    tables
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| match row {
                    Value::String(name) => Some(name.clone()),
                    Value::Object(map) => map
                        .get("name")
                        .or_else(|| map.get("table"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One read through the shared data path, with its timeout.
async fn read(state: &AppState, sink: &dyn LogSink, request: BridgeRequest) -> AppResult<Value> {
    crate::bridge::exec::execute(state, sink, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(task: AssistedTask) -> TaskInput {
        TaskInput {
            task,
            connection: "c1".into(),
            schema: None,
            table: None,
            statement: None,
            question: None,
        }
    }

    fn prompt(input: &TaskInput, ctx: &TaskContext) -> (String, String) {
        let messages = build_prompt(input, ctx);
        assert_eq!(messages.len(), 2, "a task is one system + one user message");
        (
            messages[0]["content"].as_str().unwrap().to_string(),
            messages[1]["content"].as_str().unwrap().to_string(),
        )
    }

    /// The user's notes lead the prompt, before the schema: they are what
    /// changes how everything after them should be read, and the only section
    /// no read could have produced.
    #[test]
    fn the_users_notes_lead_the_context() {
        let i = input(AssistedTask::NlToSql);
        let ctx = TaskContext {
            notes: crate::ai::exec::notes_section("cfg_* is one row per tenant"),
            server: Some("MySQL 8.0.36".into()),
            tables: Some(json!(["cfg_app", "cfg_tenant"])),
            ..TaskContext::default()
        };
        let (_, user) = prompt(&i, &ctx);
        assert!(user.contains("## Notes"), "{user}");
        assert!(user.contains("one row per tenant"), "{user}");
        assert!(
            user.find("## Notes") < user.find("## Server"),
            "the notes must come first: {user}"
        );
    }

    /// Each task opens with its *own* instruction. One shared preamble is how
    /// "explain this" and "write this" end up producing the same shape of
    /// answer, and the four differ in what a good answer even looks like.
    #[test]
    fn every_task_has_its_own_instruction() {
        let mut seen = std::collections::HashSet::new();
        for task in [
            AssistedTask::ExplainQuery,
            AssistedTask::NlToSql,
            AssistedTask::ExplainSlow,
            AssistedTask::DocumentRelation,
        ] {
            assert!(seen.insert(instruction(task)), "{task:?} shares a prompt");
        }
    }

    #[test]
    fn explain_query_carries_the_statement_and_the_engine() {
        let mut i = input(AssistedTask::ExplainQuery);
        i.statement = Some("SELECT 1".into());
        let ctx = TaskContext {
            server: Some("PostgreSQL 16.2".into()),
            statement: i.statement.clone(),
            ..TaskContext::default()
        };
        let (system, user) = prompt(&i, &ctx);
        assert!(system.contains("explain SQL"), "{system}");
        assert!(user.contains("## Server\nPostgreSQL 16.2"), "{user}");
        assert!(user.contains("## Statement\nSELECT 1"), "{user}");
        // Nothing it did not gather.
        assert!(!user.contains("## Columns"), "{user}");
        assert!(!user.contains("## Sample rows"), "{user}");
    }

    #[test]
    fn explain_slow_leads_with_the_servers_own_plan() {
        let mut i = input(AssistedTask::ExplainSlow);
        i.statement = Some("SELECT * FROM orders".into());
        let ctx = TaskContext {
            statement: i.statement.clone(),
            explain: Some(json!({ "plan": "Seq Scan on orders" })),
            ..TaskContext::default()
        };
        let (system, user) = prompt(&i, &ctx);
        assert!(
            system.contains("CREATE INDEX"),
            "the fix has to be concrete"
        );
        assert!(user.contains("## Plan"), "{user}");
        assert!(user.contains("Seq Scan on orders"), "{user}");
    }

    #[test]
    fn nl_to_sql_carries_the_request_and_only_the_relevant_structures() {
        let mut i = input(AssistedTask::NlToSql);
        i.question = Some("ventas del último mes por cliente".into());
        let ctx = TaskContext {
            relevant: vec![
                ("ventas".into(), json!([{ "name": "total" }])),
                ("clientes".into(), json!([{ "name": "nombre" }])),
            ],
            ..TaskContext::default()
        };
        let (system, user) = prompt(&i, &ctx);
        assert!(
            system.contains("only tables and columns that appear"),
            "{system}"
        );
        assert!(user.contains("## Request\nventas del último mes"), "{user}");
        assert!(user.contains("## Columns of ventas"), "{user}");
        assert!(user.contains("## Columns of clientes"), "{user}");
        // The full list is redundant once structures are present.
        assert!(!user.contains("## Tables"), "{user}");
    }

    #[test]
    fn nl_to_sql_falls_back_to_the_table_list_when_nothing_matched() {
        let mut i = input(AssistedTask::NlToSql);
        i.question = Some("how many things are there".into());
        let ctx = TaskContext {
            tables: Some(json!(["orders", "customers"])),
            ..TaskContext::default()
        };
        let (_, user) = prompt(&i, &ctx);
        assert!(user.contains("## Tables"), "{user}");
        assert!(user.contains("orders"), "{user}");
    }

    /// The coupling rule, at the one place in assisted mode that reads rows.
    #[test]
    fn document_relation_includes_a_sample_only_when_the_scope_allows_rows() {
        let mut i = input(AssistedTask::DocumentRelation);
        i.table = Some("orders".into());
        let with_rows = TaskContext {
            relation: Some("public.orders".into()),
            structure: Some(json!([{ "name": "id" }])),
            indexes: Some(json!([{ "name": "orders_pkey" }])),
            sample: Some(json!({ "rows": [[1]] })),
            scope: DataScope::Rows,
            ..TaskContext::default()
        };
        let (_, user) = prompt(&i, &with_rows);
        assert!(user.contains("## Relation\npublic.orders"), "{user}");
        assert!(user.contains("## Columns"), "{user}");
        assert!(user.contains("## Indexes"), "{user}");
        assert!(user.contains("## Sample rows"), "{user}");

        // Metadata-only: the section is still there, saying it is not.
        let without = TaskContext {
            sample: None,
            scope: DataScope::MetadataOnly,
            ..with_rows.clone()
        };
        let (_, user) = prompt(&i, &without);
        assert!(user.contains("metadata-only"), "{user}");
        assert!(
            user.contains("say nothing about the values"),
            "a model handed no rows must not describe them anyway: {user}"
        );
        assert!(!user.contains("\"rows\""), "{user}");
    }

    /// The other three tasks were never going to have a sample, so its absence
    /// is not worth a paragraph of prompt.
    #[test]
    fn only_the_documentation_task_explains_a_missing_sample() {
        for task in [
            AssistedTask::ExplainQuery,
            AssistedTask::ExplainSlow,
            AssistedTask::NlToSql,
        ] {
            let mut i = input(task);
            i.statement = Some("SELECT 1".into());
            i.question = Some("x".into());
            let (_, user) = prompt(&i, &TaskContext::default());
            assert!(!user.contains("Sample rows"), "{task:?}: {user}");
        }
    }

    /// A wide table cannot be allowed to crowd out the section the question was
    /// about — and a truncated column list has to admit it is truncated, or the
    /// model concludes the table ends there.
    #[test]
    fn a_section_is_bounded_and_says_when_it_was_cut() {
        let long = "x".repeat(SECTION_BUDGET * 2);
        let rendered = section("Columns", &long);
        assert!(rendered.len() < long.len());
        assert!(rendered.contains("(truncated)"), "{rendered:.120}");

        let short = section("Columns", "id, name");
        assert!(!short.contains("truncated"));
        assert_eq!(short, "## Columns\nid, name\n");
    }

    #[test]
    fn an_empty_section_is_omitted_entirely() {
        assert_eq!(section("Columns", "   "), "");
        assert_eq!(json_section("Columns", None), "");
    }

    #[test]
    fn relevant_tables_matches_a_name_in_the_question() {
        let tables = vec![
            "ventas".to_string(),
            "clientes".to_string(),
            "productos".to_string(),
        ];
        assert_eq!(
            relevant_tables("dame las ventas por cliente", &tables, 6),
            vec!["ventas".to_string(), "clientes".to_string()],
        );
    }

    #[test]
    fn relevant_tables_is_case_insensitive_and_forgives_a_plural() {
        let tables = vec!["Orders".to_string(), "Customers".to_string()];
        assert_eq!(
            relevant_tables("one ORDER per customer", &tables, 6),
            vec!["Orders".to_string(), "Customers".to_string()],
        );
    }

    /// A two-letter name matches almost any sentence, which would put an
    /// irrelevant structure in every prompt.
    #[test]
    fn relevant_tables_ignores_names_too_short_to_mean_anything() {
        let tables = vec!["t".to_string(), "id".to_string(), "orders".to_string()];
        assert_eq!(
            relevant_tables("how many orders did we take", &tables, 6),
            vec!["orders".to_string()],
        );
    }

    #[test]
    fn relevant_tables_finds_nothing_rather_than_guessing() {
        let tables = vec!["orders".to_string()];
        assert!(relevant_tables("what can you do", &tables, 6).is_empty());
    }

    #[test]
    fn relevant_tables_stops_at_the_cap() {
        let tables: Vec<String> = (0..20).map(|i| format!("table{i}")).collect();
        let question = tables.join(" ");
        assert_eq!(relevant_tables(&question, &tables, 6).len(), 6);
    }

    #[test]
    fn table_names_reads_both_reply_shapes() {
        assert_eq!(
            table_names(&json!(["a", "b"])),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            table_names(&json!([{ "name": "a" }, { "table": "b" }, { "other": "c" }])),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(table_names(&json!({ "not": "an array" })).is_empty());
    }

    /// Five example values answer "what does this column hold"; fifty are a
    /// context window spent on repetition.
    #[test]
    fn the_sample_is_a_handful_of_rows_whatever_the_tool_cap_is() {
        assert_eq!(sample_rows(50), 10);
        assert_eq!(sample_rows(1000), 10);
        assert_eq!(sample_rows(3), 3);
        assert_eq!(sample_rows(0), 1);
    }

    #[test]
    fn a_task_missing_its_input_is_refused_with_a_readable_reason() {
        let err = require_statement(&input(AssistedTask::ExplainQuery))
            .expect_err("no statement")
            .to_string();
        assert!(err.contains("needs a statement"), "{err}");
    }

    /// The wire names the frontend sends.
    #[test]
    fn the_task_names_deserialise_in_camel_case() {
        for (wire, task) in [
            ("explainQuery", AssistedTask::ExplainQuery),
            ("nlToSql", AssistedTask::NlToSql),
            ("explainSlow", AssistedTask::ExplainSlow),
            ("documentRelation", AssistedTask::DocumentRelation),
        ] {
            let parsed: AssistedTask = serde_json::from_str(&format!("\"{wire}\"")).expect(wire);
            assert_eq!(parsed, task);
        }
    }
}
