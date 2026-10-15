---
id: 72
type: adr
status: accepted
date: 2026-09-10
tags: [ai, llm, security]
triggered_by_external_trap: true
related: [73]
supersedes: []
superseded_by: null
amends: []
---

# ADR #72: Metadata-only removes the row tools from the catalogue instead of refusing them at call time

`ai::tools::catalogue(scope)` filters `needs_rows` tools out of the array sent to the model rather than letting the model call them and having `ai::exec` return an error, because a refusal is an instruction a model has to obey and a tool it never saw is one it cannot try.

**External trap behind it:** A language model will try any tool it can see, and treats a refusal it reads as something to negotiate or route around.

**Decision:** ai::tools::catalogue(scope) removes needs_rows tools from the array sent to the model under metadata-only, while ai::exec keeps an available() gate as an assertion; DataScope is resolved from declared endpoint trust and a per-connection row allowance.

**Alternatives rejected:**

- Sending the whole catalogue and refusing row tools in the dispatcher: rejected because models retry, ask to lift the restriction or route around via run_query, and the refusal leaks into prompt content.
- Inferring endpoint trust from the URL (e.g. localhost): rejected; trust is declared, never sniffed.

## Detail

**A tool the model can see is a tool it will try, and a refusal it reads is a negotiation.** The obvious implementation of the metadata-only guarantee is to send the whole catalogue and check `scope` inside the dispatcher: one gate, one place, easy to test. It is also the version that spends the user's turn arguing. A model that asks for `browse_table` and reads back "not permitted under this scope" has three plausible next moves — retry with different arguments, ask the user to lift the restriction, or route around it via `run_query` — and small models take all three. Worse, the refusal string itself becomes prompt content the model reasons about, so the shape of what it is not allowed to do leaks into the answer even when nothing leaks out of the database. Removing the tools is not defence in depth over the gate; it is the difference between a boundary the model works within and a boundary it works against.

- **The gate still exists, and both layers are load-bearing.** `available(name, scope)` is checked in `ai::exec` before dispatch, because the catalogue is assembled once per turn while a conversation can outlive a preference change, and because a model can name a tool it was never offered — either from its training data or because a previous turn's tool result is still in the transcript. What changed is which layer is expected to fire: the filter is the mechanism, and the gate is the assertion that the mechanism held.
- **`refuse_unless_read` is a different rule with the same shape.** Its `PROPOSE_INSTEAD` text does reach the model, and deliberately: a write is something the *user* asked for through the model, so the useful reply is "hand this to the user's editor", not silence. The distinction is who wanted the operation. Scope decides what the assistant may read on its own initiative; the write refusal answers a request that came from the person.
- **`DataScope` is resolved from two axes and never sniffed.** `DataScope::resolve(trust, rows_allowed)` needs *both* — an endpoint the user declared as their own infrastructure *and* a per-connection row allowance. Endpoint trust is declared, never inferred from the URL: `localhost` is not proof of anything a hostname cannot lie about, and a corporate proxy on port 11434 resolves wherever DNS says it does. Defaults are `Untrusted` and `MetadataOnly`, so a profile written by an older version, or a `TaskContext` built by `Default::default()`, is closed rather than open.
- **`ai::exec::cap_rows` bounds what the row tools return even when they are offered.** Scope answers "rows at all"; the cap answers "how many". Conflating them is how a legitimate `Rows` scope turns into a fifty-row dump that evicts the system prompt — see ADR #73.
