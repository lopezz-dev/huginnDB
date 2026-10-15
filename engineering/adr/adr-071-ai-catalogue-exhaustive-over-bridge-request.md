---
id: 71
type: adr
status: accepted
date: 2026-09-10
tags: [ai, mcp, security]
triggered_by_external_trap: false
related: [49, 54]
supersedes: []
superseded_by: null
amends: []
---

# ADR #71: The AI tool catalogue is a second presentation over BridgeRequest, and its exposure match has no `_` arm

`src-tauri/src/ai/tools.rs` presents the same `BridgeRequest` enum `crate::mcp` presents through rmcp's `#[tool]` macros, so the AI panel refactored nothing to reach the data path — but its `exposure` match over all 28 variants is deliberately exhaustive, because `bridge::server`'s `policy_id_of`/`class_of` (convention #49) end in `_ => None` and now have two consumers.

**Decision:** src-tauri/src/ai/tools.rs is a presentation layer over BridgeRequest whose exposure function is an exhaustive match with no _ arm, cross-checked in to_request, with withheld variants documented in their arms and tool names mirroring the MCP connector's.

**Alternatives rejected:**

- Refactoring the data path out from behind the mcp feature (an earlier AI_ROADMAP draft): unnecessary because bridge/ was already ungated.
- Extending class_of with the AI mapping: rejected because class_of ends in _ => None and is not compiler-enforced.
- Exposing ListUsers/ListPrivileges, plumbing variants and extra Pulse reads: withheld as attack-shaped, unsafe plumbing, or costing small-model accuracy.

## Detail

**`src-tauri/src/bridge/` was already the universal, driver-agnostic data path, and it is *not* behind the `mcp` feature** — only `bridge::client` is gated. That single finding removed the risky refactor an earlier draft of `docs/AI_ROADMAP.md` called for: the desktop app can reach `BridgeRequest`'s 28 variants and `bridge::exec::execute` today, so phase 1 of the AI work added a *presentation* layer and moved nothing. `crate::mcp`'s `#[tool]` macros produce an MCP router over a transport for a client that speaks MCP; an OpenAI-compatible `/chat/completions` needs a JSON array of `{name, description, parameters}` plus a dispatcher. Same substance, different envelope, one data path. `bridge::server::check_policy` widened to `pub(crate)` and gained a doc line naming its second consumer; that is the entire change to pre-existing backend logic.

- **`ai::tools::exposure` is an exhaustive match with no `_` arm, and that is the whole enforcement mechanism.** It answers a sharper question than `class_of` does — not "which tier does this need" but "may a language model reach this at all, and does its reply carry rows" — and getting it wrong is how the metadata-only guarantee leaks. Because those two functions in `bridge/server.rs` end in `_ => None` and are not compiler-enforced (convention #49), a `BridgeRequest` variant added later would be silently unclassified in *three* places instead of two. Here it is a build error: nobody can add a variant without deciding, in writing, whether a model may call it. This is the pattern `MongoOp::class` uses for the same reason (ADR #54), and it is why the AI catalogue keeps its own mapping rather than extending `class_of`.
- **`to_request` cross-checks `needs_rows` against `exposure`.** A spec claiming to be metadata-only while mapping onto a row-returning variant would defeat `catalogue`'s filter silently; one mapping onto something a model may not reach at all would defeat `exposure`. Neither is a compile error, so both are asserted at build time in `to_request` and pinned by a test that walks the whole catalogue.
- **Withheld variants are withheld on the record, not by omission.** `ListUsers`/`ListPrivileges` are the most attack-shaped reads HuginnDB has and no task needs them. `EnsureConnected`/`ResolveMongoTarget`/`IsMongo` are plumbing a model could otherwise use to open pools and address synthetic connection ids. Four Pulse reads are useful but unearned — every extra tool costs a small model accuracy on every turn. Each has its reason in the match arm.
- **The tool names mirror the MCP connector's** wherever the two overlap. One product should not have two vocabularies for the same operation, and `BridgeRequest::label` is already that vocabulary.
