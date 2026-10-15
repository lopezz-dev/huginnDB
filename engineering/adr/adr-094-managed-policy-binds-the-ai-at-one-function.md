---
id: 94
type: adr
status: accepted
date: 2026-09-24
tags: [policy, ai, mcp]
triggered_by_external_trap: false
related: [49, 58, 59, 71, 74, 89]
supersedes: []
superseded_by: null
amends: []
---

# ADR #94: A managed policy binds the AI at `bridge::exec::execute`, only ever narrows, and fails closed

`crate::policy` is phase 1 of `docs/POLICY_ROADMAP.md`: per-role permissions an administrator sets once, applied to everything an AI can ask for. The check is one call at the top of `bridge::exec::execute`, whose four callers all act for an AI. Three paths that do not reach it are checked where they are. The policy is intersected with the per-connection settings, never used in their place. An anchor that exists but cannot be read blocks every AI request.

**Decision:** The AI is bound by one policy check at the top of bridge::exec::execute (plus three named side paths), intersected with per-connection settings, matched on endpoints, failing closed with no cache.

**Alternatives rejected:**

- Checking in bridge::server::check_policy — rejected because it misses the standalone sidecar, AI-panel tasks and every read.
- A `_` default arm in needs_of — rejected; exhaustive match so new variants must declare needs.
- Matching rules on profile id — rejected because profile ids are local and free to mint.
- Caching the policy when unreadable — rejected (D6); Pending/Broken refuse every AI request.
- Reading the account or Program Files from environment variables, or HKCU — rejected because a user could spoof them.

## Detail

- **Why `execute` and not `bridge::server::check_policy`.** `check_policy` sits in the server's `dispatch`, which misses three of the four paths: the sidecar running alone (`Huginn::call`'s local fallback), the AI panel's assisted tasks (`ai/tasks.rs` calls `execute` directly and never ran `check_policy` at all), and every read, since `check_policy` returns early for variants `class_of` does not tier. `execute` is where all four meet. Its callers are, exhaustively, `bridge/server.rs`, `mcp/mod.rs`, `ai/exec.rs` and `ai/tasks.rs`. **Adding a caller that acts for a person would make the policy bind people through a function written for AIs** — if one is ever needed, it takes a subject parameter first.
- **What does not pass through `execute`, and where it is checked instead:**
  - `EnsureConnected` is intercepted by `bridge::server::dispatch` and by the sidecar's `ensure_connected` before `execute`. Both call `policy::enforce` on it, so a connection the role cannot reach is never opened.
  - The MCP `list_connections` tool builds no `BridgeRequest`, so it filters by `policy::reachable_by_ai`.
  - The AI panel's catalogue drops `run_query` / `pulse_explain` when `policy::free_sql_blocked`. That covers what a model is *offered*; `execute` still refuses behind it.
- **`needs_of` is an exhaustive match with no `_` arm**, for the reason convention #49 and ADR #71 give. A new `BridgeRequest` variant must state what it needs before it compiles, because the failure mode of a default is an AI reaching a relation its role hides.
- **Refused over MCP, removed in the panel.** An MCP client caches `tools/list` for the session (ADRs #58, #59), so the connector cannot drop `run_query` for one connection. There it is refused at call time, with a message naming the table tools to use instead. The AI panel builds its catalogue per turn and leaves the tool out (gotcha #74's absence-over-refusal).
- **Free SQL is withheld under any scoped rule (D3), whatever its verbs.** `db::classify::verbs_of` can say what a statement *does* (PR #188), but not which relations it touches. Discovery through catalogs (`INFORMATION_SCHEMA`, `master`, `pg_catalog`) is exactly how a text check would be bypassed. A rule over a whole endpoint keeps free SQL, bounded by `verbs_of`.
- **Discovery is filtered, not refused.** `ListDatabases` and `ListTables` are filtered on the typed `Vec` inside `execute`, before `to_value`. That is the one place all four paths see the same list, so a model never learns a hidden relation's name.
- **On MySQL and MongoDB a relation's schema *is* its database.** `Ctx::database_for` lets a qualified name win over the connection's default there. Without it, a root connection with no default database (the multi-database explorer's) matched no `databases` rule, and the AI saw nothing.
- **Rules match the endpoint, not the profile id.** A profile id is local and free to mint. Matching uses `db::endpoint::normalise_host` and `effective_port` (ADR #89) — the same notion of "the same server" the endpoint budget uses. An alias (an IP for a hostname) matches no rule, and `unmanagedConnections` defaults to `deny`. That default is what makes the alias useless as a way around a rule.
- **It only narrows.** `mcp_exposed`, `mcp_write` and `ai_enabled` are still checked where they always were. `enforce` is an additional refusal, so what the AI may do is the policy ∩ the local settings. That needs no merging code at all.
- **Fails closed, with no cache (D6).** `Pending` (a share not read yet) and `Broken` (unreadable, invalid, a newer `version`) refuse every AI request, because which endpoints they would have governed is unknowable. `deny_unknown_fields` on every struct makes a typo like `"relatons"` an error rather than a missing restriction.
- **Nothing reads the environment.** The account comes from `whoami::fallible::username` (`GetUserNameW`); `USERNAME=admin` must not buy the admin role. `Program Files` comes from `HKLM\...\CurrentVersion\ProgramFilesDir`, never `%ProgramFiles%`. A user who could point that at an empty folder would turn a managed machine into an unmanaged one. `HKCU` is not a source.
- **`AppState::new` leaves the policy unmanaged.** Only the app's `setup` and `mcp::serve` call `policy::install`. A test suite must not inherit the policy of the machine it runs on. The same reason keeps `install` off the startup path for a share: the local anchors are read synchronously, and a `Source` is left `Pending` for the reload thread, which re-reads every five minutes. A plain `std::thread`, because the reads block and the app and the sidecar do not share a runtime.
- **The audit line gained `user=… role=…`** — `AuditSink::new` takes the state for it. The bridged path's `audit_entry` goes through the same sink, so both paths record it.
- **Not done here, on purpose:** applying `human` to people (phase 2), per-user credentials and `GRANT` generation (phase 3), an editor for the document (phase 4).
