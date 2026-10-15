---
id: 77
type: adr
status: accepted
date: 2026-09-10
tags: [ai, llm]
triggered_by_external_trap: true
related: [36, 74, 76]
supersedes: []
superseded_by: null
amends: []
---

# ADR #77: A refusal is prompt text too — it must name the fix the model can apply, and the classifier is part of the prompt

Gotcha #74 was about tool *descriptions* being read at the decision point. Refusals are read there too, one step later: `ai::exec` returned one message — "present the statement to the user as a proposal" — for a write, for a two-statement batch, and for a `USE`, so a model that had merely written one statement too many dutifully handed over a read it was entitled to run.

**External trap behind it:** A model reads refusal text as an instruction and follows it literally, and without being told the engine it writes whatever SQL dialect it has seen most.

**Decision:** ai::exec returns three distinct refusals (ONE_STATEMENT, NO_SESSION_STATE, PROPOSE_INSTEAD, only the last mentioning proposals), is_read_only recognises DESCRIBE/DESC and a leading '(', target_brief is appended to the single system message, and synthetic ::db:: ids resolve to their parent.

**Alternatives rejected:**

- One write refusal for batches, session statements and writes: rejected because it told the model to hand reads to the user.
- Sending the target brief as a second system message: rejected because servers disagree about how to handle two.

## Detail

**Three different problems shared one answer, and only one of them was a write.** `USE shop; SELECT …` is not a mutation the user must approve; it is one statement too many. `SET NAMES utf8` is not a mutation either; it is a statement the model did not need, because the connection is already open on its database and each tool call may land on a different pooled connection anyway. Both classify as non-reads — correctly, per ADR #76 — and both therefore hit the write refusal, whose text is the single loudest instruction in the loop: *give it to the user*. The reported symptom was an assistant that "infers the tools but struggles to run queries", and the mechanism was our own refusal telling it not to.

There are now three refusals, and only the write one mentions proposing:

- `ONE_STATEMENT` — send just the read, call the tool again.
- `NO_SESSION_STATE` — you do not need this; qualify the name instead. It ends with "do not hand this to the user", because the alternative is what the model was doing.
- `PROPOSE_INSTEAD` — unchanged, and now reached only by an actual write.

A test asserts the negative directly: the batch and session refusals must **not** contain "proposal".

**The classifier is prompt text as well, arriving indirectly.** `DESCRIBE logRecord` is how a model asks MySQL for a table's shape; `db::sql::is_read_only` did not recognise it, so it classified as a write, so the assistant was refused its own read and told to delegate it. Nothing in the AI layer was wrong — the sentence the model read came from a keyword list in `db/sql.rs`. Two additions fix it, and both improve the editor as well: `DESCRIBE`/`DESC` (which the editor had been running down the DML path, showing a row count instead of the columns), and a leading `(`, because `(SELECT …) UNION (SELECT …)` is an ordinary query that `starts_with("select")` will never match.

**The model was also never told which engine it was talking to.** Nothing in the prompt named the driver, so it wrote whichever dialect it had seen most — `LIMIT` at SQL Server, backticks at Postgres, SQL at MongoDB — and one failed call is enough for a small model to stop trusting itself and print the query for the user to fix instead. `ai::exec::target_brief` is two lines, appended to the system prompt: the connection's name, its engine, its database, how identifiers are quoted, how to page, and the reminder that one statement per call is the contract. Appended to the single system message rather than sent as a second one, because servers disagree about what to do with two.

**And the panel could hand the backend a connection id the backend rejected.** A MongoDB connection opened *at a database* is the synthetic `<parent>::db::<name>` (ADR #36) that carries no profile, so `resolve_connection` answered "no connection named …::db::…" and agent mode simply did not work there. It resolves the parent now, and the database half is carried into `resolve_target` as the default target rather than discarded.
