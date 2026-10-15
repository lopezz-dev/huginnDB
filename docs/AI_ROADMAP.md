# HuginnDB AI panel — design rationale and phased build-out

Status: **planned, not started.** This document is the executable specification
for the in-app AI assistant (working name: the *AI panel*), a third occupant of
the right dock alongside Saved Queries and Pulse.

It is written to be executed by an agent working one phase at a time. Every
phase states what to build, which files to touch, what "done" means, and what
*not* to do. Read the whole document before starting phase 1 — several
decisions in later phases constrain earlier ones.

Companion documents:

- [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) — the headless
  connector. The AI panel is **not** a replacement for it; the two answer
  different questions (see "Why both" below).
- [`PULSE.md`](PULSE.md) / the Pulse source tree — the template this feature
  copies for panel shape, per-connection opt-in, prefs, and settings UI.
- [`PRIVACY.md`](PRIVACY.md) — must be updated by phase 7.

---

## 1. The problem this feature has to solve

HuginnDB's users are disproportionately consultants and in-house developers
working against **client** databases. The single most common objection to an
AI feature in a database tool is not "I don't want AI", it is *"my client's
data is not going to a third party"*. That objection is correct and the design
has to answer it structurally, not with a checkbox and a promise.

Two secondary constraints, both learned the hard way:

- **Subscription licences cannot be reused.** A user with Claude Pro/Max or a
  ChatGPT/Codex plan cannot spend that licence through HuginnDB. Anthropic's
  terms state OAuth is "intended exclusively for … ordinary use of Claude Code
  and other native Anthropic applications" and that developers building
  products "including those using the Agent SDK, should use API key
  authentication". Headless/bare mode does not read OAuth credentials at all.
  OpenAI's ChatGPT sign-in is equivalently scoped to their own clients. So the
  only sanctioned credential HuginnDB may hold is an **API key the user
  supplies** (BYOK), or none at all.
- **Office hardware cannot run a capable local model.** Roughly, at Q4:

  | Machine | Viable model | Reliable multi-step tool calling |
  | --- | --- | --- |
  | No GPU, 8–16 GB RAM | 3B–4B; 7–8B at 2–6 tok/s | No |
  | GPU 8 GB | 7–8B | Marginal |
  | GPU 12–16 GB | 14B | Yes |
  | GPU 24 GB+ / vLLM host | 32B | Yes, comfortably |

  Small models are precisely the ones that fail at chained tool calls, so
  "just use a smaller model" is not a degradation path — it is a broken
  feature.

### The two answers that make it work

**Answer A — the endpoint is shared, not per-machine.** The real requirement
was never "the data never leaves this laptop", it was "the data never leaves
our infrastructure". Ollama, llama.cpp's `llama-server` and vLLM all expose an
OpenAI-compatible endpoint **over the network**. The deployment that works in
an office is one GPU box serving every HuginnDB on the LAN
(`http://ai-internal:11434/v1`). This is the primary documented deployment
pattern, not a footnote — it is what makes local inference viable for users
whose laptops cannot host a model.

**Answer B — shrink the job, not the model.** Two capability modes:

- **Assisted mode.** Rust assembles the context deterministically, makes
  **one** model call, and runs **no** tool loop. Works on a 4B. Covers
  explain-this-query, natural-language→SQL, why-is-this-slow (with the
  `EXPLAIN` Pulse already collects), and document-this-relation.
- **Agent mode.** A real tool-call loop over the existing data path. Requires
  a tool-capable model (14B+ local, or BYOK).

Agent mode is gated behind a **capability probe** so the UI can say *"this
model does not emit reliable tool calls — assisted mode is available, agent
mode is not"* instead of silently producing garbage.

### Why both this and the MCP connector

| User wants | Surface | Data egress |
| --- | --- | --- |
| To use their existing Claude/Codex licence | `huginndb-mcp` in Claude Code/Desktop/Cursor (**shipped since 1.7.0**) | Yes, to that vendor |
| A chat inside HuginnDB with nothing leaving their infrastructure | **the AI panel**, local/self-hosted endpoint | No |
| A chat inside HuginnDB with a frontier model | the AI panel, BYOK | Yes |

The AI panel's empty state must point at row 1 (Settings → MCP) rather than
pretend it is the only option. That is the honest answer to "I already pay for
Claude" and it costs one paragraph of copy.

---

## 2. Locked decisions

These were settled in design discussion. Do not relitigate them mid-execution;
if one turns out to be wrong, stop and raise it.

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Providers: local/self-hosted *and* BYOK cloud**, one OpenAI-compatible client for both | One `/v1/chat/completions` implementation covers Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Azure OpenAI and OpenAI itself. No per-vendor SDK, no new dependency tree. |
| D2 | **The agent loop lives in Rust**, over the existing `BridgeRequest` data path | Keeps the "frontend never talks to a database" invariant, keeps the API key out of the webview, makes egress auditable in one place, and makes the loop testable with `cargo test`. |
| D3 | **One permissions axis: `McpWritePolicy`.** No new permission model, no second settings UI | It already exists, is re-read from disk per call, and `db/classify.rs` is already the single source of truth for a statement's tier. |
| D4 | **v1 is read-only + *proposed* SQL.** The assistant never writes | Any mutation is emitted as SQL in a Monaco block the user runs themselves with the existing per-statement ▶ Run CodeLens. This is the posture that does not frighten the target user. |
| D5 | **Chat UI built from repo primitives**, no `assistant-ui` / AI SDK UI layer | `react-virtuoso`, Radix, Tailwind and a self-hosted Monaco are already here; Monaco gives better SQL blocks than any generic library; both candidate libraries assume a streaming HTTP server that Tauri does not have, so the adapter cost is paid either way. Adopt assistant-ui's *message anatomy* (text / tool-call / tool-result parts) as TS types so a later migration is mechanical. |
| D6 | **Two independent axes, safely coupled** (§3) | "Read-only" does not mean "no data leaves" — a `SELECT` puts rows in the prompt. |
| D7 | **No new on-disk state file in v1.** Conversations live in memory only | A `conversations.json` would hold schema and row snippets on disk, which is exactly what this feature promises not to accumulate. It also avoids a `tab_state.json` migration. Persistence is a v2 question (§9). |
| D8 | **No new npm dependency. No new Rust crate.** | `reqwest` is already a direct dependency (`commands::feedback`) with `rustls-tls` + `json`; it needs only the `stream` feature added. SSE is parsed by hand. Per `CLAUDE.md`, ask before adding anything else. |

---

## 3. The two axes, and the coupling rule

This is the core of the security story. Get it wrong and the rest is theatre.

- **Axis A — where inference runs.** Loopback / LAN / the user's own gateway,
  versus a third-party cloud.
- **Axis B — what enters the model's context.** Metadata only (table and
  column names, types, indexes, view definitions, `EXPLAIN` output) versus
  metadata **plus rows**.

The two are orthogonal, and conflating them is the mistake. A read-only agent
that runs `SELECT * FROM patients LIMIT 50` has sent fifty patient records to
whatever endpoint is configured.

**The coupling rule, enforced in Rust:**

> A **trusted** endpoint (loopback, or one the user has declared as their own
> infrastructure) may read rows. An **untrusted** endpoint gets
> metadata-only, and rows require an explicit per-connection opt-in
> (`ConnectionProfile::ai_rows_allowed`, default `false`).

Two implementation notes that matter:

1. **Trust is declared, not sniffed.** A hostname like `ai-internal` can
   resolve anywhere, and DNS is not a security boundary. The Settings UI asks
   the user to declare the endpoint's trust level, pre-filling the guess from
   loopback / RFC1918 detection. Honest and auditable beats clever.
2. **Under metadata-only, row-reading tools are *removed from the catalogue*,
   not refused at call time.** A small model that can see a tool it is not
   allowed to use will burn its turns trying. Absence is cheaper than
   refusal — and it is also a stronger guarantee.

**Plain http must stay allowed.** Unlike `tauri-plugin-opener`'s capability
(scoped to https/http for external URLs), the primary case here is
`http://localhost:11434` or `http://ai-internal:11434` on a LAN. An
https-only rule would break the deployment pattern this feature is built
around. `file://` and every other scheme stay blocked.

### The egress invariant

> **The webview never talks to the model.** All HTTP to an inference endpoint
> happens in Rust, through one client, against an allowlist derived solely
> from `AiPrefs::base_url`.

This is the same invariant as "the frontend never talks to a database",
applied to the network — and it is load-bearing here because `csp` is `null`
(Monaco loads its workers as blobs), so the webview is not a barrier to
anything. Egress is only auditable if exactly one Rust function can make the
call.

---

## 4. What already exists (read this before phase 1)

The single most important finding from the design pass, because it removes the
risky refactor an earlier draft of this plan called for:

**`src-tauri/src/bridge/` is already the universal, driver-agnostic data path,
and it is *not* behind the `mcp` feature.** Only `bridge::client` is gated:

```rust
// src-tauri/src/bridge/mod.rs
#[cfg(feature = "mcp")]
pub mod client;
pub mod exec;      // <- unconditional
pub mod protocol;  // <- unconditional
pub mod server;    // <- unconditional
```

Which means the desktop app can reach the whole surface today:

- **`bridge::protocol::BridgeRequest`** — 28 variants covering every read and
  write the MCP tools expose: `ListDatabases`, `ListTables`,
  `GetTableStructure`, `ListIndexes`, `ServerVersion`, `ListUsers`,
  `ListPrivileges`, `GetViewDefinition`, `RunStatement`, `FetchTableData`, the
  seven `Pulse*` reads, and the write variants (`InsertRow`, `UpdateCell`,
  `DeleteRows`, `PreviewViewChange`, `ApplyViewChange`, `DropView`,
  `CreateMongoIndex`, `DropMongoIndex`).
- **`bridge::exec::execute(&AppState, &dyn LogSink, &BridgeRequest)`** — one
  request in, one `serde_json::Value` out, delegating to the same `_inner`
  functions the Tauri commands call. Takes a `LogSink`, so Console/audit
  integration is free.
- **`bridge::server::{check_policy, policy_id_of, class_of}`** — the
  per-connection write-policy gate, re-read from `profiles.json` on every
  call, already unit-tested. Currently **private**; phase 1 widens
  `check_policy` to `pub(crate)`.

So the `#[tool]` macros in `src-tauri/src/mcp/mod.rs` are rmcp-specific
*presentation*. The substance is already shared. **Phase 1 does not refactor
`mcp/mod.rs`.** It writes a second, thin presentation layer — a tool catalogue
for an LLM — over the same enum.

> ⚠️ This raises the stakes on [gotcha
> #49](../engineering/conventions/convention-049-mcp-write-tool-checklist-unenforced-arms.md).
> `policy_id_of` and `class_of` both end in `_ => None`, which is not
> compiler-enforced, and they will now have **two** consumers instead of one.
> Phase 1 must make the AI catalogue's mapping an **exhaustive match** over
> `BridgeRequest` (the pattern [gotcha
> #54](../engineering/adr/adr-054-statement-classify-text-based-single-source.md) uses
> for `MongoOp::class()`), so a new variant is a build error rather than a
> silently unclassified tool.

Other pieces to copy rather than reinvent:

| Need | Copy from |
| --- | --- |
| Right-dock occupant, own width, deferred mount | `stores/session/panelLayout.ts` (`RightPanelId`, `PANEL_CLAMPS`, `rightPanelSizeKey`), `components/shell/AppShell.tsx` (`pulseMounted`) |
| One clock in a store, not per component | `lib/pulse/usePulseLive.ts`, `stores/session/pulse.ts` |
| Per-connection opt-in flag + bulk setter | `ConnectionProfile::pulse_enabled`, `commands::connection::set_pulse_enabled` (uses `set_local_flag`) |
| Prefs sub-struct | `prefs::PulsePrefs` + `Preferences::pulse` |
| Settings section with a connection tree | `components/settings/sections/PulseSection.tsx`, `PulseConnectionTree.tsx` |
| Console/audit emission | `log_bus::{LogEntry, LogKind, LogSink, TauriSink}` |
| Secret storage | `keychain::{set_password, get_password, delete_password}` |

---

## 5. Phases

Each phase is independently shippable and independently revertable. Do not
start a phase before its predecessor's acceptance criteria pass.

### Phase 0 — planning artefacts

**Goal.** Unblock the executing agent and record the decision.

- This document.
- `ROADMAP.md`: add the AI panel to the numbered **Open** list.
- `CLAUDE.md`: the "Explicitly out of scope" list currently says *"AI features
  (autocomplete suggestions via LLM, 'explain this query', etc.)"*. **Narrow
  it, do not delete it** — what stays out of scope is AI that requires cloud
  egress by default, and LLM-driven autocomplete in the editor (which is a
  different feature with a different cost profile).

**No `CHANGELOG` entry** — nothing user-facing lands in this phase.

**Done when.** The three files are committed and an agent reading
`ROADMAP.md` + `CLAUDE.md` is not told the feature is forbidden.

---

### Phase 1 — the tool catalogue and the executor

**Goal.** A Rust module that can describe HuginnDB's read surface to an LLM and
execute a tool call the model emits, under the existing policy gate. No
provider, no UI, no network.

**Create** `src-tauri/src/ai/` with:

- `mod.rs` — module docs stating the egress invariant and the coupling rule.
- `tools.rs` — the catalogue:

  ```rust
  pub struct ToolSpec {
      pub name: &'static str,
      pub description: &'static str,
      pub schema: fn() -> serde_json::Value, // JSON Schema for arguments
      pub needs_rows: bool,                  // gated by DataScope
  }

  pub fn catalogue(scope: DataScope) -> Vec<&'static ToolSpec>;
  pub fn to_request(name: &str, args: &serde_json::Value, ctx: &ToolCtx)
      -> AppResult<BridgeRequest>;
  ```

  v1 exposes **read-tier variants only**: `ListDatabases`, `ListTables`,
  `GetTableStructure`, `ListIndexes`, `ServerVersion`, `GetViewDefinition`,
  `PulseExplain`, `PulseTopQueries`, plus `RunStatement` and `FetchTableData`
  (both `needs_rows: true`). **No write variant is in the catalogue at all**
  (D4).

- `scope.rs` — `enum DataScope { MetadataOnly, Rows }` and the resolver that
  derives it from `AiPrefs` endpoint trust + `ConnectionProfile::ai_rows_allowed`.
- `exec.rs` — the executor:
  1. resolve the connection reference (id **or** name, like
     `Huginn::canonical_connection`),
  2. verify `ConnectionProfile::ai_enabled`,
  3. build the `BridgeRequest` via `tools::to_request`,
  4. `bridge::server::check_policy`,
  5. for `RunStatement`, additionally require
     `classify::classify_statement(sql) == StmtClass::Read` — refuse writes
     with a message telling the model to *propose* the SQL instead,
  6. `bridge::exec::execute` with a `TauriSink` so it lands in the Console,
  7. cap the result: reuse the `DEFAULT_MAX_ROWS` idea from `mcp/mod.rs`
     (1000) and add a **context** cap (`AiPrefs::max_context_rows`, default 50)
     — the model's context is a much tighter budget than an MCP client's.

**Modify:**

- `src-tauri/src/bridge/server.rs` — `check_policy` becomes `pub(crate)`.
  Nothing else. Add a doc line naming its second consumer.
- `src-tauri/src/lib.rs` — `pub mod ai;`.

**Do not:** touch `src-tauri/src/mcp/mod.rs`. Do not add write tools. Do not
introduce a second policy type.

**Tests** (`cargo test`):

- `to_request` mapping is an **exhaustive match** over the variants it
  accepts; adding a `BridgeRequest` variant fails the build.
- `catalogue(DataScope::MetadataOnly)` contains no spec with `needs_rows`.
- A write statement through the `RunStatement` tool is refused, with the
  refusal text naming the propose-instead path.
- A connection with `ai_enabled == false` is unreachable even when named
  correctly.
- Per [convention #52](../engineering/conventions/convention-052-cargo-test-real-state-directory-risk.md),
  **no test may reach `state_file::path` / `save_profiles`**. Use the pure
  seams; extract one if you need it.

**Done when.** `cargo test` passes, `cargo clippy` is clean, and the desktop
build is unchanged in behaviour (nothing calls this module yet).

---

### Phase 2 — the provider client and the capability probe

**Goal.** Stream a completion from an OpenAI-compatible endpoint, with tool
calls, behind the egress allowlist.

**Create:**

- `src-tauri/src/ai/provider.rs`:
  - one `reqwest::Client` (add the `stream` feature to the existing
    dependency — do **not** add a new crate),
  - `POST {base_url}/chat/completions` with `stream: true`,
  - a hand-rolled SSE frame parser (`data: ` lines, `[DONE]` sentinel,
    multi-byte UTF-8 split across chunks, comment/keepalive lines),
  - incremental assembly of `tool_calls` deltas (arguments arrive as
    fragments across frames — this is the single most bug-prone part; test it
    with captured real fragments from Ollama *and* from an OpenAI-shaped
    server, they differ),
  - `fn allows(url: &Url) -> bool` — scheme is http or https, host+port
    matches `AiPrefs::base_url` exactly. Every other URL is unreachable.
- `src-tauri/src/ai/probe.rs`:
  - `GET {base_url}/models` — **must not be fatal**, several servers do not
    implement it,
  - a tool-call smoke test: one completion with a single trivial tool and
    `tool_choice: "auto"`, asserting a well-formed `tool_calls` comes back,
  - `enum Capability { Unreachable(String), ChatOnly, ToolCapable }`, cached
    in `AppState` and surfaced to the UI.

**Secrets.** The BYOK key goes to the keychain via `keychain::set_password`
under a dedicated account key (e.g. `ai::<provider-id>`), never to
`prefs.json`. It is never returned to the frontend — the frontend learns only
*whether* a key is stored.

**Tests.** SSE parser (including a frame split mid-UTF-8-sequence and
arguments split across three frames), allowlist accept/reject table, probe
degradation when `/models` 404s.

**Done when.** A `cargo test` unit suite covers the parser and the allowlist,
and a manual smoke test against a local Ollama streams tokens and produces one
valid tool call.

---

### Phase 3 — prefs, profile flags, settings UI

**Goal.** The feature is configurable and off by default.

**Backend:**

- `prefs.rs`: `AiPrefs` + `Preferences::ai`. Fields: `enabled` (default
  `false`), `base_url`, `model`, `endpoint_trust`, `mode`
  (`assisted` | `agent`), `max_context_rows` (50), `request_timeout_secs`.
  `Preferences` already carries `#[serde(default)]`, so old `prefs.json` files
  load unchanged — verify with a test.
- `state.rs`: `ConnectionProfile::ai_enabled: bool` and
  `ai_rows_allowed: bool`, **both `#[serde(default)]` false** so no existing
  profile comes back enabled (the same reasoning that makes
  `McpWritePolicy::ReadOnly` the `Default`).
- `commands/connection.rs`: `set_ai_enabled` and `set_ai_rows_allowed`,
  calqued on `set_pulse_enabled` (via `set_local_flag`).
- ⚠️ **`merge_profiles_bundle` must preserve both new flags across a
  shared-origin sync**, exactly as it preserves `mcp_write` and
  `pulse_enabled`. An origin's publisher does not decide what this machine's
  AI may reach. This is not compiler-enforced — add a test.
- `commands/ai.rs`: the command surface (`ai_probe`, `ai_send`, `ai_cancel`,
  `ai_set_key`, `ai_has_key`, `ai_clear_key`). Register in `lib.rs`.

**Frontend:**

- `src/lib/tauri.ts` — typed wrappers. Components never call `invoke`.
- `src/types.ts` — DTOs mirroring the Rust types.
- `components/settings/sections/AiSection.tsx` +
  `AiConnectionTree.tsx`, calqued on the Pulse pair. Show the probe result
  verbatim; when `ChatOnly`, disable agent mode with the explanation.
- The empty/disabled state links to Settings → MCP for the "I already have a
  Claude/Codex licence" path (§1).

**Note.** `prefId` is derived from `Preferences` ([gotcha
#47](../engineering/adr/adr-047-prefid-compile-time-derived.md)), so adding `AiPrefs`
extends the settings-navigation union automatically and a typo'd `prefId`
fails to compile. Free correctness — don't hand-maintain a parallel list.

**Done when.** `pnpm typecheck` and `pnpm test` pass; the section renders; the
feature is off on a fresh profile and on every migrated one.

---

### Phase 4 — the panel

**Goal.** The chat surface, in the right dock.

**Modify** `src/stores/session/panelLayout.ts`:

- `RightPanelId` gains `"ai"`,
- `AI_WIDTH_DEFAULT` (start at 360 — wider than Pulse's 320; a chat needs the
  measure) and `PANEL_CLAMPS.aiWidth`,
- `rightPanelSizeKey` currently returns a two-member union — **widen it**;
  it is the one place the mapping is spelled.

**Modify** `src/components/shell/AppShell.tsx` — a third activity-bar entry and
a deferred mount mirroring `pulseMounted` (a user who never opens the panel
pays nothing).

**Create:**

- `src/stores/session/ai.ts` — messages, streaming buffer, per-conversation
  state. Persist **only** UI folds (`STORAGE_KEYS.ai = "huginndb.ai.v1"`), never
  message content (D7). Every consumer reads primitive fields as selectors, per
  the Zustand rule in `CLAUDE.md`.
- `src/lib/ai/useAiStream.ts` — **one** Tauri event subscription in the store,
  not one per component, for the same reason `usePulseLive` centralises its
  clock: the panel and any future expanded window must not double-cost.
- `src/lib/ai/parts.ts` — the message anatomy (text / tool-call / tool-result
  parts) plus a pure reducer that folds stream deltas into parts. Pure, so it
  is Vitest-able (this is where the repo's test convention pays off).
- `src/components/ai/AiPanel.tsx`, `components/ai/parts/*` for the part
  renderers, `components/ai/dialogs/` if a modal appears (per the domain
  folder convention).

**SQL blocks.** Render them in Monaco and reuse the existing per-statement ▶ Run
CodeLens so a proposed statement is one click from the editor's normal
execution path. Follow the per-model provider registry pattern from [gotcha
#57](../engineering/adr/adr-057-mongo-pipeline-completion-context-scanner.md) to avoid
registering duplicate providers.

**Constraints.** `components/ui/` may only import
`react`/`@radix-ui/*`/`lucide-react`/`cva`/`@/lib/utils` ([gotcha
#60](../engineering/conventions/convention-060-ui-library-dependency-rule-density-focus.md)) — panel
components live in `components/ai/`, not `ui/`. `uiAdoption.test.ts` asserts
its budget maps **exactly**, so new files carrying a counted pattern fail the
build; write the new code against the primitives instead of adding debt. Every
string goes in **both** `src/lib/i18n/locales/en.json` and `es.json`
(`panels.ai` + an `ai.*` block).

**Done when.** The panel opens, streams a reply from a local endpoint, renders
tool-call cards, and a proposed `SELECT` runs from its Monaco block.

---

### Phase 5 — assisted actions

**Goal.** The feature is useful on an office laptop. **This ships before agent
mode**, because it is the mode most users can actually run (§1, Answer B).

**Create** `src-tauri/src/ai/tasks.rs`:

```rust
pub enum AssistedTask {
    ExplainQuery,       // the editor's current statement
    NlToSql,            // NL + the relevant tables' structure, injected by Rust
    ExplainSlow,        // statement + EXPLAIN (reuse PulseExplain)
    DocumentRelation,   // structure + indexes + a bounded sample
}
```

Each variant owns a **deterministic context builder** that goes through the
same `bridge::exec` paths and produces a bounded prompt. One model call, no
tool loop, no iteration. Under `DataScope::MetadataOnly`, `DocumentRelation`
drops its sample rather than being unavailable.

Entry points in the UI: the query editor's context menu, the schema tree's
context menu, and Pulse's slow-statement rows (which already have the
`EXPLAIN`).

**Tests.** The context builders are pure given a fixed `BridgeRequest`
response — snapshot them. This is what catches a prompt regression.

**Done when.** All four actions produce a useful answer against a 4B local
model. If they do not, the prompt is wrong, not the model — iterate on the
builder.

---

### Phase 6 — agent mode

**Goal.** The tool-call loop, behind the probe.

- The loop lives in `ai/agent.rs`: request → `tool_calls` → `ai::exec` →
  tool results → repeat, with a hard iteration cap and a hard token/row budget.
- Unavailable unless `Capability::ToolCapable`.
- Every iteration emits to the Console via `log_bus` — the prompt, each tool
  call, each result size. **This is the trust feature**: a user who can watch
  what the assistant did and what it sent will believe the guarantee; one who
  cannot, will not.
- Cancellation must actually abort the in-flight request, not just stop
  rendering.

**Done when.** A 14B local model completes a three-tool investigation, the
Console shows every step, and cancelling mid-stream aborts the HTTP request.

---

### Phase 7 — documentation and release

- `docs/AI.md` **and** `docs/AI.es.md` — docs in this repo come in pairs
  (`CONNECTIONS`, `PULSE`, `MCP`, `MONGODB`, …). Must contain: the hardware
  table, the shared-LAN-endpoint deployment pattern, the two axes and the
  coupling rule, exactly what leaves the machine in each configuration, and
  the "use your own Claude/Codex licence via MCP" path.
- `docs/PRIVACY.md` — update. This feature changes the answer to the question
  that document exists to answer.
- `README.md` — a short mention with the local-first framing.
- `CHANGELOG.md` **and `CHANGELOG.es.md` in the same turn** — per `CLAUDE.md`,
  the Spanish changelog is not a follow-up task.
- New ADRs in `adr/` for whatever bit anyone during execution. Strong
  candidates already visible: the tool-catalogue-over-`BridgeRequest`
  decision, and the metadata-only-removes-tools-rather-than-refusing rule.
- `CLAUDE.md`: add `AiPrefs` to the prefs description and the two new profile
  flags where `pulse_enabled` / `mcp_exposed` are described. **No new row in
  the on-disk state map** — v1 adds no file (D7).

---

## 6. Release shape

This is a 2–3 minor-release arc, not one:

- Phases 1–4 → the panel exists, assisted-only in practice.
- Phase 5 → the feature becomes useful on modest hardware.
- Phase 6 → agent mode for those who can run it.

Per `CLAUDE.md`, each minor release should also close at least two
`ROADMAP.md` "Fit and finish" entries — the AI work does not exempt a release
from that track.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| **Tool-call delta assembly.** Servers fragment `tool_calls` arguments differently; a naive concatenation works on one and corrupts another. | Test against captured fragments from at least two server implementations before phase 6. This is the most likely source of "the AI is broken" reports. |
| **Small models make the feature look bad.** | Phase 5 before phase 6; the probe gates agent mode; the docs are honest about hardware. |
| **The metadata-only guarantee leaks.** A tool added later that returns rows but is not marked `needs_rows`. | `needs_rows` on `ToolSpec` plus the exhaustive-match requirement in phase 1; a test asserting the metadata-only catalogue is row-free. |
| **`policy_id_of` / `class_of`'s `_ => None` arms** now serve two consumers ([convention #49](../engineering/conventions/convention-049-mcp-write-tool-checklist-unenforced-arms.md)). | Do not extend them for the AI path — the AI catalogue keeps its own exhaustive mapping, and calls `check_policy` rather than re-deriving a tier. |
| **Scope creep into writes.** | D4 is locked. A write-capable assistant is a separate decision with a separate threat model, not a phase 8 someone bolts on. |

---

## 8. Explicitly out of scope

- The assistant performing writes (D4).
- LLM-driven autocomplete in the Monaco editor — different feature, different
  latency and cost profile, still out of scope per `CLAUDE.md`.
- Embedded in-process inference (`llama.cpp` bindings, `candle`, `mistral.rs`).
  It would ship a heavy native dependency, a GPU/CPU feature matrix and a
  model-download UX, against the project's small-audited-tree principle. A
  local *endpoint* gets the same privacy result for none of that cost.
- Consuming a user's Claude/ChatGPT **subscription** (§1). Not available to
  third-party applications; the MCP connector is the sanctioned path.
- Any cloud sync of conversations, prompts or keys.

---

## 9. Open questions for after v1

- **Conversation persistence.** D7 keeps everything in memory. If users ask
  for history, the design question is not *where* but *what*: a transcript
  containing schema and rows is a new sensitive artefact on disk, and would
  need its own retention story (Pulse's `pulse.db` staircase is the closest
  precedent).
- **User-supplied MCP servers.** Once the agent loop exists, letting users
  point it at their *own* MCP servers is a small increment with a large payoff
  — and it inverts the current relationship pleasantly.
- **OpenRouter OAuth PKCE.** OpenRouter documents a PKCE flow for desktop
  apps that yields a user-controlled key without anyone pasting one. It is the
  only "connect account" button available to us that is actually sanctioned.
  Worth considering once BYOK has proven itself.
