---
id: 73
type: adr
status: accepted
date: 2026-09-10
tags: [llm, ai]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #73: A tool result must be bounded in size, not in rows — Ollama truncates from the front

A row cap is not a size budget: `ai::exec::compact_result` / `fit_to_budget` bound every tool reply to `MAX_TOOL_RESULT_CHARS`, because 50 wide rows overflowed the context window and Ollama evicted the *system prompt and the user's question* to make room, leaving the model to answer a conversation whose only surviving content was a table dump.

**External trap behind it:** Ollama truncates an over-long request from the front, evicting the system prompt and the user's question while the last tool result survives, with no error.

**Decision:** Every tool reply is compacted and bounded to MAX_TOOL_RESULT_CHARS (4000), the turn to AgentLimits::max_result_chars with a StopReason::ResultBudget, browse_table returns a total count, and assisted tasks use SECTION_BUDGET.

**Alternatives rejected:**

- A row cap (50 rows) as the budget: rejected because one row can be 4 KB and another three integers.

## Detail

**The failure looked like a model problem and was a budget problem.** In live testing against `gemma4:12b` the agent loop did everything right — picked `browse_table`, got 50 rows back, and then replied with a generic English greeting, in a Spanish conversation, about nothing. Nothing errored and no limit was reported, because from the model's point of view nothing was wrong: it answered the prompt it received. Ollama truncates an over-long request **from the front**, and the front is where the system prompt and the question live; the tool result, being last, survived intact. A row cap of 50 is meaningless as a budget when one row can be a 4 KB JSON document and another can be three integers.

- **`MAX_TOOL_RESULT_CHARS` (4000) bounds one tool reply, and `AgentLimits::max_result_chars` (3×) bounds the whole turn.** Both are needed: a single well-behaved reply within budget, repeated across the loop's six iterations, overflows in exactly the same way. `StopReason::ResultBudget` exists so the loop ends with a stated reason the user can read rather than degrading silently — the whole point of this gotcha is that the previous behaviour had no symptom.
- **Compaction narrows before it truncates.** `compact_result` drops the parts of a bridge reply a model does not need — echoed request fields, formatting metadata — before `fit_to_budget` cuts rows, so what gets sacrificed is redundancy rather than the tail of the data. A truncated result says so in the payload, so the model knows it is looking at a sample and can narrow its next read instead of concluding from it.
- **`with_count: Some(true)` on `browse_table` is part of the same fix.** Once results are samples, "20 of 41 892 rows" is a different answer from "20 rows", and only the first stops a model generalising a sample to a population. Giving it the total is far cheaper than giving it more rows.
- **Assisted mode has the same rule with its own constant.** `ai::tasks::SECTION_BUDGET` (6000) bounds each section of a task prompt for the same reason, and `sample_rows` exists so a task that benefits from real values gets a few rather than a page. One-shot prompts are not exempt: a schema with 300 columns overflows a small context just as effectively as a row dump does.
