//! Agent mode: the tool-call loop.
//!
//! Request → `tool_calls` → [`crate::ai::exec`] → tool results → repeat, until
//! the model answers without asking for anything or a budget stops it.
//!
//! # Why this is last, and gated
//!
//! It is the mode that needs a model most people cannot run. A small model
//! asked to chain tool calls does not degrade — it fabricates, or emits
//! `tool_calls` whose arguments are not JSON, and the assistant *looks* like it
//! is working right up to the point where nothing it claims to have read was
//! ever read. So [`crate::ai::probe`] measures the endpoint first and this
//! refuses to run unless the answer was
//! [`crate::ai::probe::Capability::ToolCapable`]. Assisted mode
//! ([`crate::ai::tasks`]) is what everyone else gets, and it is not a
//! consolation prize: for four common jobs it is *better*, because the context
//! was chosen deliberately rather than discovered.
//!
//! # The Console is the feature, not the logging
//!
//! Every iteration emits: the tools it was offered, each call with its
//! arguments, and each result's **size**. That is the roadmap's own claim and
//! it is worth restating, because it looks like instrumentation and is not — a
//! user who can watch what the assistant did and how much came back will
//! believe the metadata-only guarantee; one who cannot, will not. The result
//! *payload* is deliberately never logged: it is the row data the guarantee is
//! about, and writing it to a panel the user can copy out of would be an odd
//! way to keep it.
//!
//! # Budgets, and what happens at the end of one
//!
//! Four hard caps: iterations, total tool calls, the row and character caps
//! every reply already carries ([`crate::ai::exec`]), and a **turn-wide**
//! character budget across all of them. The last exists because the loop
//! re-sends its whole accumulated history on every iteration, so twelve replies
//! that each fit comfortably still add up to a context nobody can hold — the
//! per-reply cap bounds one read, and this bounds the turn.
//!
//! A loop that hits any of them stops and says so *in the transcript* rather
//! than silently returning half an investigation, because "the model gave up"
//! and "the model was cut off" are different facts and only one of them is
//! worth retrying.
//!
//! # The webview does not write the system prompt here
//!
//! The panel sends a chat prompt that tells the model it has no database
//! access, which is true of plain chat and false here. The loop drops whatever
//! system message arrived and supplies its own ([`system_message`]:
//! [`SYSTEM_PROMPT`] plus the connection's dialect brief). That is mostly
//! hygiene — the frontend is ours — but it also means the one instruction that
//! governs what the assistant may do with its tools is not something a page can
//! rewrite.

use crate::ai::exec::{AiCall, AiRuntime};
use crate::ai::provider::{self, Endpoint};
use crate::ai::scope::DataScope;
use crate::ai::stream::{AssistantMessage, ToolCall};
use crate::ai::tools;
use crate::error::AppResult;
use crate::log_bus::{LogEntry, LogKind, LogSink};
use reqwest::Client;
use serde_json::{json, Value};

/// What the loop is allowed to spend.
#[derive(Debug, Clone, Copy)]
pub struct AgentLimits {
    /// Model calls, including the final one that answers.
    ///
    /// Six is enough for "list the tables, describe two of them, answer" with
    /// room to recover from one mistake, and small enough that a model stuck in
    /// a loop costs seconds rather than a coffee break.
    pub max_iterations: usize,
    /// Tool calls across the whole turn, however they are distributed.
    ///
    /// A separate cap from the iterations because one iteration may ask for
    /// six tools at once, and the thing worth bounding is how much of the
    /// database a single question can touch.
    pub max_tool_calls: usize,
    /// Passed through to every tool. See `crate::ai::exec::effective_row_cap`.
    pub max_context_rows: i64,
    /// Characters of tool *results* one turn may accumulate.
    ///
    /// The cap the per-reply one cannot be: every iteration re-sends the whole
    /// history, so a turn's cost is the sum of its replies rather than the size
    /// of its largest. Three replies at the per-reply ceiling is where a
    /// 4096-token window stops having room for the question.
    pub max_result_chars: usize,
}

impl Default for AgentLimits {
    fn default() -> Self {
        Self {
            max_iterations: 6,
            max_tool_calls: 12,
            max_context_rows: crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS,
            max_result_chars: 3 * crate::ai::exec::MAX_TOOL_RESULT_CHARS,
        }
    }
}

/// The system prompt agent mode runs under.
///
/// # What the first version got wrong
///
/// It gave one sentence to "use the tools" and a whole paragraph, with
/// mechanics, to "propose the statement and leave it to the user". A 12B
/// weighted them the way they were written and generalised the loud one to
/// *every* statement: asked for the last three rows of a table, it explained
/// that it needed to know the ordering column and suggested the user run
/// `DESCRIBE logRecord` — while holding a `describe_table` tool. Twice in one
/// session it wrote out a `SELECT` and waited to be told to run it.
///
/// So the ordering and the scoping are the design here, not the phrasing:
///
/// * The reading instruction comes first, names the tools, and forbids the
///   specific failure (asking the user to run a read) rather than merely
///   encouraging the opposite.
/// * The write restriction is scoped **explicitly and by name** to statements
///   that change something. "You cannot write" alone is a sentence a small
///   model applies to SQL in general.
/// * "Never say you are showing data you did not receive" is separate from
///   both, because the observed failure was a model announcing "here are the
///   last three records" above a query it had not run.
///
/// The other load-bearing line is the older one: never claim to have read
/// something a tool did not return. A confident answer about a schema nobody
/// looked at is worse than no answer, because the user cannot tell them apart.
pub const SYSTEM_PROMPT: &str = concat!(
    "You are a database assistant embedded in HuginnDB. You have read-only ",
    "tools over the user's live connection, and you are expected to use them ",
    "without being asked.\n\n",
    "Look things up, then answer. Need a table's columns? Call ",
    "describe_table. Need rows, a count, or a sample? Call browse_table or ",
    "run_query. A count, an aggregate, a join or a filter is a run_query call: ",
    "write the statement and call the tool with it, in this connection's own ",
    "dialect. Never ask the user to run a query for you, never ask them to ",
    "paste a schema you can read yourself, and never end a turn by asking ",
    "permission to look — looking is your job. Do not re-read something you ",
    "already read earlier in this conversation.\n\n",
    "Never state a table name, a column, a type or a count that a tool did ",
    "not return. If a tool refuses, say what it refused and why rather than ",
    "working around it.\n\n",
    "You cannot change anything, and this applies ONLY to statements that ",
    "write: INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, ",
    "GRANT. For those, and only for those, put the statement in a fenced code ",
    "block tagged with the dialect and leave it for the user to run. Reads are ",
    "yours to run.\n\n",
    "Never say you are showing data you did not receive from a tool.\n\n",
    "A value that is JSON, XML or code goes in a fenced code block, never ",
    "inline in a sentence: a configuration table is full of them, and pasted ",
    "into prose they are unreadable.\n\n",
    "Be brief. Answer in the language the user writes in."
);

/// The nudge sent when an answer hands over a read instead of running it.
///
/// # Why a message and not more prompt
///
/// Because prompting had already been tried. The instruction to run reads is
/// first in [`SYSTEM_PROMPT`], the tool descriptions say it (gotcha #74), the
/// refusals no longer contradict it (ADR #77), the connection's dialect is
/// supplied so a statement stands a chance of working — and a 12B still ends
/// some turns by printing a `SELECT` and waiting. At that point the honest
/// reading is that the model's instruction-following is the limit, and the
/// answer is not a louder prompt: it is to notice the specific failure after
/// the fact and ask for the one call that was missing.
///
/// Sent with `role: "user"`, which is not a lie the user has to see — the panel
/// renders its own store, not the wire history — and is the role a small model
/// obeys most reliably. It is logged to the Console like everything else the
/// loop does, so the extra step is visible rather than magic.
pub const RUN_IT_YOURSELF: &str = concat!(
    "You wrote that statement instead of running it. Call run_query with it ",
    "now, then answer from the rows it returns. Do not print the statement ",
    "again — only a statement that writes is mine to run."
);

/// The read statement an answer proposes instead of running, if there is one.
///
/// Fenced code blocks first, because that is where the prompt tells the model
/// to put a statement. The unfenced fallback is deliberately narrow — a *whole
/// line* that classifies as a read and reads like a query rather than like
/// prose about one — because the cost of a false positive is a wasted
/// iteration, and a statement buried mid-sentence would mean guessing where
/// the prose ends. Guessing wrong nudges a model that was answering fine.
///
/// A write is never returned: proposing one is correct behaviour (D4), and a
/// nudge would be asking the model to do the one thing the assistant must not.
pub fn unrun_read(content: &str) -> Option<&str> {
    let fenced = fenced_blocks(content);
    let candidates: Vec<&str> = if fenced.is_empty() {
        content
            .lines()
            .map(str::trim)
            .filter(|line| looks_like_a_query(line))
            .collect()
    } else {
        fenced
    };
    candidates.into_iter().find(|candidate| {
        crate::db::sql::split_statements(candidate).len() == 1
            && crate::db::classify::classify_statement(candidate) == crate::db::sql::StmtClass::Read
    })
}

/// The bodies of ``` fences in `content`, info string dropped.
fn fenced_blocks(content: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut open: Option<usize> = None;
    for line in content.split_inclusive('\n') {
        if !line.trim_start().starts_with("```") {
            continue;
        }
        let offset = line.as_ptr() as usize - content.as_ptr() as usize;
        match open.take() {
            // The fence that closes a block: the body is everything between.
            Some(body_start) => blocks.push(content[body_start..offset].trim()),
            None => open = Some(offset + line.len()),
        }
    }
    blocks
}

/// Whether an unfenced line is a statement rather than prose mentioning one.
///
/// `SELECT` alone is a word an answer may well use in a sentence; `SELECT …
/// FROM …`, or a mongosh call, is a query somebody wrote out.
fn looks_like_a_query(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    (lower.contains(" from ") || lower.starts_with("db.")) && line.len() > 12
}

/// The system message the loop actually sends: [`SYSTEM_PROMPT`] plus, when we
/// know it, [`crate::ai::exec::target_brief`]'s two lines about the connection.
///
/// One message rather than two, because not every server honours a second
/// system message — some concatenate, some drop it, and llama.cpp's template
/// handling depends on the model's own chat template. Appending is the only
/// shape that behaves the same everywhere.
pub fn system_message(brief: Option<&str>) -> Value {
    let content = match brief {
        Some(brief) => format!("{SYSTEM_PROMPT}\n\n{brief}"),
        None => SYSTEM_PROMPT.to_string(),
    };
    json!({ "role": "system", "content": content })
}

/// What the caller is told as the loop runs.
///
/// Three callbacks rather than one enum so the command can route each to where
/// it belongs — text to the delta stream, calls and results to their own event
/// — without a match in the hot path.
/// `(call id, tool name, result, error)`. The result is the whole payload;
/// deciding how much of it to forward is the caller's — which is the point of
/// handing it over rather than a summary.
pub type ToolResultSink = dyn FnMut(&str, &str, Option<&Value>, Option<&str>) + Send;

pub struct AgentSinks<'a> {
    pub on_text: &'a mut (dyn FnMut(&str) + Send),
    pub on_tool_call: &'a mut (dyn FnMut(&ToolCall) + Send),
    pub on_tool_result: &'a mut ToolResultSink,
}

/// Why the loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The model answered without asking for anything else.
    Answered,
    /// [`AgentLimits::max_iterations`] was reached.
    Iterations,
    /// [`AgentLimits::max_tool_calls`] was reached.
    ToolCalls,
    /// [`AgentLimits::max_result_chars`] was reached — the turn had read more
    /// than it could carry into another iteration.
    ResultBudget,
}

impl StopReason {
    /// The sentence appended to the transcript when a budget ended the turn.
    ///
    /// Said out loud because "the model gave up" and "the model was cut off"
    /// are different facts, and only one of them is worth retrying.
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Answered => None,
            Self::Iterations => Some(
                "\n\n_Stopped: this turn reached its step limit. Ask a narrower \
                 question, or ask it to continue._",
            ),
            Self::ToolCalls => Some(
                "\n\n_Stopped: this turn reached its limit on how many reads one \
                 question may make._",
            ),
            Self::ResultBudget => Some(
                "\n\n_Stopped: this turn read more than it can carry. Ask about one \
                 table at a time, or lower the row budget in Settings → AI._",
            ),
        }
    }
}

/// One assistant turn that asked for tools, in the shape the wire expects.
///
/// Pure, and split out because getting it wrong is silent: a server handed a
/// tool result with no matching `tool_calls` entry before it either errors or —
/// worse — answers as though the call never happened.
pub fn assistant_turn(message: &AssistantMessage) -> Value {
    json!({
        "role": "assistant",
        "content": message.content,
        "tool_calls": message
            .tool_calls
            .iter()
            .map(|call| json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    // Back to text: the wire carries arguments as a JSON
                    // *string*, and a server handed an object here rejects the
                    // history on the next turn.
                    "arguments": call.arguments.to_string(),
                },
            }))
            .collect::<Vec<_>>(),
    })
}

/// One tool result, in the shape the wire expects.
pub fn tool_result_message(call: &ToolCall, payload: &str) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": call.id,
        "name": call.name,
        "content": payload,
    })
}

/// How many rows a tool reply carried, for the Console line.
///
/// The count and never the payload: that is the row data the metadata-only
/// guarantee is about, and writing it into a panel would be an odd way to keep
/// the promise.
pub fn result_rows(value: &Value) -> Option<u64> {
    value
        .get("rows")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as u64)
        .or_else(|| value.as_array().map(|items| items.len() as u64))
}

/// Run the loop.
///
/// `conversation` is the user/assistant history *without* a system message —
/// see the module docs for why this supplies its own.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    state: &crate::state::AppState,
    sink: &dyn LogSink,
    http: &Client,
    endpoint: &Endpoint,
    connection: &str,
    scope: DataScope,
    conversation: Vec<Value>,
    limits: AgentLimits,
    sinks: &mut AgentSinks<'_>,
) -> AppResult<(AssistantMessage, StopReason)> {
    // The catalogue `scope` advertises. `ai::exec` re-derives the scope per call
    // and refuses independently, so this decides what the model is *offered*
    // rather than what it is allowed — absence is the cheaper guarantee (see
    // `crate::ai::tools::catalogue`), and the refusal is still there behind it.
    let mut catalogue = tools::catalogue(scope);
    // The organization's policy takes free-form text away wherever it limits
    // which relations the AI may see (`crate::policy`, D3): no text classifier
    // can say which tables a query touches. Left out rather than offered and
    // refused, for the same reason as above — `bridge::exec` still refuses it
    // behind this.
    let free_sql_blocked = crate::ai::exec::resolve_connection(connection, &state.profiles.read())
        .is_ok_and(|id| crate::policy::free_sql_blocked(state, &id));
    if free_sql_blocked {
        catalogue.retain(|spec| spec.name != tools::RUN_QUERY && spec.name != tools::PULSE_EXPLAIN);
    }
    let runtime = AiRuntime {
        endpoint_trust: endpoint_trust_of(scope),
        max_context_rows: limits.max_context_rows,
    };

    // Orientation, before the first model call. The dialect brief says *where*
    // it is; the table map says what is *there* — see `crate::ai::orient` for
    // why a model that has to discover the map by spending iterations on it
    // will instead answer about whichever table the question named.
    let preamble = [
        crate::ai::exec::brief_for(state, connection),
        crate::ai::orient::overview(state, sink, runtime, connection).await,
        // Last, so the user's own words are the closest thing to the question:
        // they are the part no tool could have discovered.
        crate::ai::exec::notes_for(state, connection),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");

    let mut messages = Vec::with_capacity(conversation.len() + 4);
    messages.push(system_message((!preamble.is_empty()).then_some(&*preamble)));
    messages.extend(conversation);

    log(
        sink,
        connection,
        format!(
            "agent turn: {} tools offered ({}), up to {} steps",
            catalogue.len(),
            match scope {
                DataScope::Rows => "rows allowed",
                DataScope::MetadataOnly => "metadata only",
            },
            limits.max_iterations
        ),
        None,
    );
    log(
        sink,
        connection,
        format!("orientation: {} chars of preamble", preamble.len()),
        None,
    );

    let mut spent = 0usize;
    let mut carried = 0usize;
    // Row-returning calls that succeeded, and whether the backstop below has
    // already fired. Together they scope it to the failure it is for: a turn
    // that answered about data without ever reading any.
    let mut rows_read = 0usize;
    let mut nudged = false;
    let mut last = AssistantMessage::default();
    for step in 1..=limits.max_iterations {
        let body = provider::chat_body(endpoint, messages.clone(), &catalogue, true);
        let message = provider::stream_chat(http, endpoint, &body, sinks.on_text).await?;

        if message.tool_calls.is_empty() {
            // The backstop. An answer that hands over a read, from a turn that
            // read no rows, on a connection where rows are allowed, is the one
            // failure prompting could not fix — so ask for the call instead of
            // ending the turn on it. Once per turn, and never for a write.
            //
            // The abandoned text has already been streamed to the panel; it
            // disappears at the end, because `AiTurnResult` carries the final
            // message's content and the store replaces the turn's text with it
            // wholesale rather than patching (see `finishTurn`).
            if !nudged && rows_read == 0 && scope.allows_rows() {
                if let Some(statement) = unrun_read(&message.content) {
                    log(
                        sink,
                        connection,
                        format!(
                            "step {step}: the answer proposed a read instead of running it \
                             ({}) — asking for the call",
                            statement.chars().take(80).collect::<String>()
                        ),
                        None,
                    );
                    messages.push(json!({ "role": "assistant", "content": message.content }));
                    messages.push(json!({ "role": "user", "content": RUN_IT_YOURSELF }));
                    nudged = true;
                    last = message;
                    continue;
                }
            }
            return Ok((message, StopReason::Answered));
        }
        if spent + message.tool_calls.len() > limits.max_tool_calls {
            return Ok((message, StopReason::ToolCalls));
        }
        // The assistant's own turn goes into the history *before* its results,
        // or the tool messages below have nothing to attach to.
        messages.push(assistant_turn(&message));

        for call in &message.tool_calls {
            spent += 1;
            (sinks.on_tool_call)(call);
            log(
                sink,
                connection,
                format!("step {step}: {}({})", call.name, call.arguments),
                None,
            );

            let outcome = crate::ai::exec::execute(
                state,
                sink,
                runtime,
                &AiCall {
                    connection,
                    tool: &call.name,
                    args: &call.arguments,
                },
            )
            .await;

            match outcome {
                Ok(value) => {
                    let rows = result_rows(&value);
                    let payload = value.to_string();
                    carried += payload.len();
                    if matches!(call.name.as_str(), tools::RUN_QUERY | tools::BROWSE_TABLE) {
                        rows_read += 1;
                    }
                    // The size is logged alongside the row count because size
                    // is what actually ends a turn, and a user reading the
                    // Console to understand why should not have to infer it.
                    log(
                        sink,
                        connection,
                        match rows {
                            Some(n) => format!(
                                "step {step}: {} returned {n} rows, {} chars ({carried} carried)",
                                call.name,
                                payload.len()
                            ),
                            None => format!(
                                "step {step}: {} returned {} chars ({carried} carried)",
                                call.name,
                                payload.len()
                            ),
                        },
                        None,
                    );
                    (sinks.on_tool_result)(&call.id, &call.name, Some(&value), None);
                    messages.push(tool_result_message(call, &payload));
                }
                Err(e) => {
                    // A refusal is *content*, not a failure: the model is told
                    // what it may not do so it can answer around it, which is
                    // the whole point of removing tools rather than erroring.
                    let reason = e.to_string();
                    log(
                        sink,
                        connection,
                        format!("step {step}: {}", call.name),
                        Some(&reason),
                    );
                    (sinks.on_tool_result)(&call.id, &call.name, None, Some(&reason));
                    messages.push(tool_result_message(call, &reason));
                }
            }
        }
        // Checked after the results are in rather than before the next call, so
        // the reads the user already paid for are in the transcript either way:
        // the budget ends the *turn*, it does not discard what it bought.
        if carried >= limits.max_result_chars {
            log(
                sink,
                connection,
                format!("turn stopped: {carried} chars of results carried"),
                None,
            );
            return Ok((message, StopReason::ResultBudget));
        }
        last = message;
    }
    Ok((last, StopReason::Iterations))
}

/// The trust level that produces `scope`.
///
/// `ai::exec` takes an [`AiRuntime`] and derives the scope itself from the
/// endpoint's trust plus the connection's flag. The loop already knows the
/// answer, so this reverses it rather than threading the preference through:
/// `Trusted` yields `Rows` for any connection, `Untrusted` leaves the
/// connection's own opt-in to decide — which, when the scope here is `Rows`,
/// it already has.
fn endpoint_trust_of(scope: DataScope) -> crate::ai::scope::EndpointTrust {
    match scope {
        DataScope::Rows => crate::ai::scope::EndpointTrust::Trusted,
        DataScope::MetadataOnly => crate::ai::scope::EndpointTrust::Untrusted,
    }
}

fn log(sink: &dyn LogSink, connection: &str, message: String, error: Option<&str>) {
    let mut entry = LogEntry::new(LogKind::Ai)
        .connection_id(connection)
        .message(message);
    if let Some(error) = error {
        entry = entry.error(error);
    }
    sink.log(entry);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stream::ToolCall;

    fn call(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    /// The backstop's whole decision: which answers are a handed-over read.
    #[test]
    fn a_proposed_read_is_recognised_and_a_proposed_write_is_not() {
        let proposed = "Puedo mirarlo con esta consulta:\n\n```sql\nSELECT id, ts FROM \
                        logRecord ORDER BY ts DESC LIMIT 3\n```\n\n¿La ejecutas?";
        assert_eq!(
            unrun_read(proposed),
            Some("SELECT id, ts FROM logRecord ORDER BY ts DESC LIMIT 3")
        );
        // mongosh counts, and so does a fence with no info string.
        assert_eq!(
            unrun_read("```\ndb.logRecord.find({}).limit(3)\n```"),
            Some("db.logRecord.find({}).limit(3)")
        );
        // Unfenced, because a small model does not always fence — but only
        // when the line *is* the statement. A statement buried mid-sentence is
        // out of scope on purpose: recovering it would mean guessing where the
        // prose ends, and guessing wrong nudges a model that was doing fine.
        assert_eq!(
            unrun_read("Sería así:\nSELECT count(*) FROM orders WHERE total > 100"),
            Some("SELECT count(*) FROM orders WHERE total > 100")
        );
        assert_eq!(
            unrun_read("Sería: SELECT count(*) FROM orders WHERE total > 100"),
            None
        );

        // A write is the assistant's *correct* behaviour: never nudged.
        assert_eq!(unrun_read("```sql\nDELETE FROM logRecord\n```"), None);
        assert_eq!(unrun_read("```sql\nDROP TABLE logRecord\n```"), None);
        // A batch is refused by the tool anyway, so asking for the call would
        // only produce a refusal.
        assert_eq!(unrun_read("```sql\nUSE shop; SELECT 1\n```"), None);
        // Nothing statement-shaped: an ordinary answer, and prose that merely
        // uses the word.
        assert_eq!(unrun_read("La tabla tiene 41 892 filas."), None);
        assert_eq!(unrun_read("Puedes usar SELECT para filtrar."), None);
        assert_eq!(unrun_read("```json\n{\"a\": 1}\n```"), None);
    }

    /// The nudge has to name the tool and forbid the thing that produced it,
    /// or it is one more sentence a 12B reads past.
    #[test]
    fn the_nudge_asks_for_the_call_and_keeps_the_write_exception() {
        assert!(RUN_IT_YOURSELF.contains("run_query"));
        assert!(RUN_IT_YOURSELF.contains("Do not print the statement again"));
        assert!(RUN_IT_YOURSELF.contains("writes"));
    }

    /// One system message, with the connection brief appended rather than sent
    /// as a second one: servers disagree about what to do with two.
    #[test]
    fn the_brief_is_appended_to_the_one_system_message() {
        let brief =
            crate::ai::exec::target_brief(crate::state::Driver::Postgres, "Producción", "shop");
        let message = system_message(Some(&brief));
        assert_eq!(message["role"], "system");
        let content = message["content"].as_str().unwrap();
        assert!(content.starts_with(SYSTEM_PROMPT), "{content}");
        assert!(content.contains("PostgreSQL"), "{content}");

        // No connection resolved: the prompt alone, unchanged, so a turn that
        // cannot name its target does not send a half-built sentence.
        assert_eq!(system_message(None)["content"], SYSTEM_PROMPT);
    }

    /// The wire wants `arguments` as a JSON **string**. An object there is
    /// accepted by some servers and rejected by others, and the rejection
    /// arrives on the *next* turn, when the history is replayed.
    #[test]
    fn an_assistant_turn_carries_its_arguments_as_text() {
        let message = AssistantMessage {
            content: "looking".into(),
            tool_calls: vec![call("c1", "describe_table", json!({ "table": "orders" }))],
            finish_reason: Some("tool_calls".into()),
        };
        let turn = assistant_turn(&message);
        assert_eq!(turn["role"], json!("assistant"));
        assert_eq!(turn["content"], json!("looking"));
        let calls = turn["tool_calls"].as_array().unwrap();
        assert_eq!(calls[0]["id"], json!("c1"));
        assert_eq!(calls[0]["type"], json!("function"));
        assert_eq!(calls[0]["function"]["name"], json!("describe_table"));
        let arguments = calls[0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            json!({ "table": "orders" })
        );
    }

    /// A result with no matching call in the history is how a loop ends up
    /// answering as though the call never happened.
    #[test]
    fn a_tool_result_names_the_call_it_answers() {
        let message = tool_result_message(&call("c1", "list_tables", json!({})), "[\"orders\"]");
        assert_eq!(message["role"], json!("tool"));
        assert_eq!(message["tool_call_id"], json!("c1"));
        assert_eq!(message["name"], json!("list_tables"));
        assert_eq!(message["content"], json!("[\"orders\"]"));
    }

    /// The count reaches the Console; the payload never does.
    #[test]
    fn a_result_reports_its_row_count_in_both_reply_shapes() {
        assert_eq!(result_rows(&json!({ "rows": [[1], [2]] })), Some(2));
        assert_eq!(result_rows(&json!(["orders", "customers"])), Some(2));
        assert_eq!(result_rows(&json!({ "version": "16.2" })), None);
        assert_eq!(result_rows(&json!(null)), None);
    }

    #[test]
    fn a_budget_that_ended_the_turn_says_so_and_a_finished_one_does_not() {
        assert!(StopReason::Answered.note().is_none());
        assert!(StopReason::Iterations
            .note()
            .unwrap()
            .contains("step limit"));
        assert!(StopReason::ToolCalls
            .note()
            .unwrap()
            .contains("how many reads"));
    }

    /// The two failures a user would otherwise confuse: a model that finished
    /// and one that was cut off mid-investigation.
    #[test]
    fn the_stop_reasons_are_distinguishable() {
        let notes = [
            StopReason::Iterations.note(),
            StopReason::ToolCalls.note(),
            StopReason::ResultBudget.note(),
        ];
        let unique: std::collections::HashSet<_> = notes.iter().collect();
        assert_eq!(unique.len(), notes.len(), "two budgets read the same");
    }

    /// The cap a per-reply one cannot be: every iteration re-sends the whole
    /// history, so a turn costs the *sum* of its replies. Three replies at the
    /// per-reply ceiling is where the question stops fitting alongside them.
    #[test]
    fn the_turn_budget_is_a_few_replies_worth_not_one() {
        let limits = AgentLimits::default();
        assert_eq!(
            limits.max_result_chars,
            3 * crate::ai::exec::MAX_TOOL_RESULT_CHARS
        );
        assert!(limits.max_result_chars > crate::ai::exec::MAX_TOOL_RESULT_CHARS);
    }

    /// The prompt's job is to stop the one failure this feature exists to
    /// avoid: a confident answer about a schema nobody looked at.
    #[test]
    fn the_system_prompt_forbids_claiming_unread_facts() {
        assert!(SYSTEM_PROMPT.contains("Never state a table name"));
        assert!(SYSTEM_PROMPT.contains("Never say you are showing data you did not receive"));
    }

    /// The regression the first version had: a model that wrote the SELECT out
    /// and waited to be told to run it. The prompt has to forbid the specific
    /// behaviour, not merely encourage its opposite.
    #[test]
    fn the_system_prompt_forbids_delegating_a_read() {
        for required in [
            "Never ask the user to run a query for you",
            "paste a schema you can read yourself",
            "asking permission to look",
            "Reads are yours to run",
        ] {
            assert!(SYSTEM_PROMPT.contains(required), "missing: {required}");
        }
        // And it names the tools, because a small model picks them by name
        // rather than by working out which one applies.
        assert!(SYSTEM_PROMPT.contains("describe_table"));
        assert!(SYSTEM_PROMPT.contains("browse_table"));
        assert!(SYSTEM_PROMPT.contains("run_query"));
    }

    /// "You cannot write" alone is a sentence a small model applies to SQL in
    /// general — which is how the propose-instead rule leaked onto reads.
    #[test]
    fn the_write_restriction_is_scoped_to_statements_that_write() {
        assert!(SYSTEM_PROMPT.contains("ONLY to statements that write"));
        for verb in [
            "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE",
        ] {
            assert!(SYSTEM_PROMPT.contains(verb), "unnamed write verb: {verb}");
        }
    }

    /// Re-reading is not wrong, only wasteful — and with a turn-wide character
    /// budget, waste is what ends a turn early.
    #[test]
    fn the_system_prompt_discourages_re_reading() {
        assert!(SYSTEM_PROMPT.contains("Do not re-read something you already read"));
    }

    /// The reversal has to round-trip, or the loop would advertise row tools
    /// and then have every call to one refused underneath it.
    #[test]
    fn the_runtime_the_loop_builds_reproduces_its_own_scope() {
        for scope in [DataScope::Rows, DataScope::MetadataOnly] {
            let trust = endpoint_trust_of(scope);
            // `false` is the connection's own flag: under `Trusted` it is
            // ignored, and under `Untrusted` a metadata-only scope is what it
            // must produce.
            assert_eq!(crate::ai::scope::DataScope::resolve(trust, false), scope);
        }
    }

    /// Small enough that a stuck model costs seconds, big enough for "list,
    /// describe two, answer" with room for one mistake.
    #[test]
    fn the_default_budgets_are_the_documented_ones() {
        let limits = AgentLimits::default();
        assert_eq!(limits.max_iterations, 6);
        assert_eq!(limits.max_tool_calls, 12);
        assert_eq!(
            limits.max_context_rows,
            crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS
        );
    }
}
