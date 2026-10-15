---
id: 78
type: adr
status: accepted
date: 2026-09-10
tags: [ai, llm]
triggered_by_external_trap: true
related: [74, 77]
supersedes: []
superseded_by: null
amends: []
---

# ADR #78: When a small model will not follow an instruction, detect the failure instead of writing the instruction again

Four rounds of prompt work did not stop a 12B ending some turns by printing a `SELECT` and waiting for the user to run it. `agent::run` now notices that specific shape — an answer that hands over a *read*, from a turn that read no rows, on a connection where rows are allowed — and asks for the missing call, once per turn.

**External trap behind it:** A 12B model sometimes ends a turn by printing a SELECT for the user to run despite clear instructions to run reads itself.

**Decision:** agent::run detects an answer that hands over an unrun read (rows_read == 0, rows allowed, not yet nudged) via unrun_read and sends one user-role nudge per turn asking for the missing call.

**Alternatives rejected:**

- Rewriting the prompt instruction louder again: rejected after four rounds of prompt work did not eliminate the behaviour.
- Recovering a statement buried mid-sentence: deliberately out of scope because guessing wrong nudges a model that was answering fine.
- Sending the nudge as a mid-conversation system message: rejected because servers treat it inconsistently.
- Nudging under metadata-only scope or for writes: rejected because proposing is the correct behaviour there.

## Detail

**Everything upstream of this was already right, which is how we know the limit is the model's.** The instruction to run reads is first in `SYSTEM_PROMPT` and names the tools; the tool descriptions stopped telling the model to delegate their own job (gotcha #74); the refusals stopped contradicting them (ADR #77); the connection's engine, database and quoting rules are supplied so a statement stands a chance of running; `DESCRIBE` is no longer refused as a write. Each of those fixed a real defect *of ours* and each made the behaviour better without eliminating it. At some point the honest reading of "the model does practically the same as before" is that the model's instruction-following is the constraint, and the answer is not a louder prompt.

- **The trigger is narrow on purpose, and every clause earns its place.** `rows_read == 0` means the answer made a claim about data without reading any — a turn that browsed and *also* suggested a query for the user is legitimate. `scope.allows_rows()` matters because under metadata-only, proposing a statement is the *correct* behaviour and nudging would be asking the model to do the one thing it may not. `!nudged` bounds it to one extra iteration, so a stubborn model costs one step rather than the whole budget. And `unrun_read` never returns a write: proposing a mutation is decision D4 working as designed.
- **`unrun_read` reads fences first and falls back to whole lines.** A statement buried mid-sentence is deliberately out of scope: recovering it means guessing where the prose ends, and guessing wrong nudges a model that was answering fine. `looks_like_a_query` (a `FROM`, or a `db.` prefix) is the whole heuristic, and `split_statements` plus `classify_statement` do the rest — the same two functions the executor gates on, so the backstop cannot ask for a call the executor would refuse.
- **The nudge is a `user` message.** Not a lie the user has to see — the panel renders its own store, never the wire history — and it is the role a small model obeys most reliably; a mid-conversation `system` message is treated inconsistently across servers. It is logged to the Console like every other step, so the extra call is visible rather than magic.
- **The abandoned answer cleans itself up.** Its text has already been streamed to the panel, but `AiTurnResult` carries the *final* message's content and the store's `finishTurn` replaces a turn's text wholesale rather than patching it (that behaviour exists because a dropped delta leaves a gap in the middle). So the discarded draft is visible while the turn is in flight and gone when it ends — which is also the honest rendering of what happened.
- **The general shape.** A prompt is a request; a loop is a mechanism. When a request has been made correctly and clearly and still is not honoured, encode the outcome you need as a check on the result. This is the same move `probe` makes for tool-calling at all: measure, do not hope.
