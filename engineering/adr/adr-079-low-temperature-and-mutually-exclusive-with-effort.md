---
id: 79
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

# ADR #79: A data assistant asks for a low temperature, and `temperature` / `reasoning_effort` are mutually exclusive

`ai::provider::chat_body` sends `temperature: 0.15` — Ollama and llama.cpp both default to **0.8**, a creative-writing setting for an assistant whose job is reporting what a table contains — and it sends it *only* when no `reasoning_effort` is going out, because the two fields' rejections are complementary.

**External trap behind it:** Ollama and llama.cpp default to temperature 0.8, and OpenAI reasoning models reject any temperature other than 1 while ordinary models reject reasoning_effort.

**Decision:** ai::provider::chat_body sends a constant temperature of 0.15, and only when no reasoning_effort is being sent.

**Alternatives rejected:**

- Leaving temperature unset: rejected because it inherits a 0.8 default chosen for chatbots.
- Temperature 0 (greedy): rejected because small models repeat themselves, especially in tool-call loops.
- Making temperature a user preference: rejected because the right value is the same for every user and a wrong setting looks like a broken product.
- Sending both temperature and reasoning_effort: rejected because each model family 400s on the other's field.

## Detail

**High-entropy sampling is a mechanism for hallucination, not a style choice.** Every token an answer contains is a sample from a distribution, and at 0.8 a plausible column name that does not exist can beat the one that does. A small model is where this bites hardest: it has less margin in the logits to begin with, so the temperature does more of the deciding. Nothing about a database client wants that, and leaving the field unset was inheriting a default chosen for a chatbot.

- **Not zero.** Greedy decoding makes a small model repeat itself — the same sentence, or the same tool call with the same arguments until a budget ends the turn — and a tool-call loop is exactly the shape that exposes it. 0.15 is low enough that the top token wins essentially always and high enough to break a tie.
- **The mutual exclusion is a compatibility requirement, not tidiness.** OpenAI's reasoning models accept `reasoning_effort` and **400 on any `temperature` but 1**; their ordinary models accept a temperature and 400 on an effort. The user *choosing* an effort is the declaration that this is a reasoning model, so it is also the signal to stop sending a temperature. One field or the other, never both — the same trap `AiReasoningEffort::Auto` exists for, arriving from the other side.
- **Deliberately a constant, not a preference.** A dial whose right setting is the same for every user of a database client is not a setting; it is a default someone would eventually set wrong, and a wrong setting here looks like a broken product rather than like a choice they made. The rationale lives on the constant so that "why is this hardcoded" has an answer at the call site.
- **It is not a fix for hallucination**, only a large reduction in its rate. The structural answers are elsewhere and complementary: the system prompt forbids stating anything a tool did not return, the loop refuses to run at all on an endpoint the probe found not tool-capable, and the tool card shows the rows under the claim (`lib/ai/toolResult.ts`) so a user can check rather than trust.
