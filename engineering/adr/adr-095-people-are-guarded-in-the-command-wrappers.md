---
id: 95
type: adr
status: accepted
date: 2026-09-24
tags: [policy, security, tauri]
triggered_by_external_trap: false
related: [94]
supersedes: []
superseded_by: null
amends: []
---

# ADR #95: A person is guarded in each `#[tauri::command]` wrapper, never in the `_inner` core, and a test proves every command says what it needs

Phase 2 of managed policy applies each role's `human` permissions to what a person does through the app. `policy::resolve::Ctx` now carries a `Subject` (`Human` / `Ai`), so the decisions made for the AI in phase 1 serve people unchanged. Every command that touches a database calls `commands::guard` first. Commands are not an enum, so `guard::HUMAN_POLICY` classifies each one, and two tests hold it to that.

**Decision:** Every database-touching command calls commands::guard in its wrapper, never in the _inner core; guard::HUMAN_POLICY classifies every registered command and two tests fail on unclassified or unguarded commands.

**Alternatives rejected:**

- Checking in the _inner cores — rejected because bridge::exec shares them and an AI request would be judged by the wider human block.
- Filters failing open on Pending/Broken policy (phase 1 behaviour) — replaced by a blocked answer for people.
- Reading profiles from disk for a person — rejected; a person's checks read state.profiles in memory.

## Detail

- **One decision, two subjects.** `Rule::grant_for(subject)` reads `human` for a person and `ai ∩ human` for the AI (D1). Every `ai_grant()` in `resolve.rs` became `self.grant(r)`; the refusal text changes by subject ("the AI may not…" / "you may not…"), and so does the alternative offered when free SQL is refused (the MCP tools, or the explorer). The AI-side names (`enforce`, `filter_tables`, `free_sql_blocked`) are thin wrappers, so `bridge/exec.rs`, `ai/agent.rs` and `mcp/mod.rs` did not change.
- **In the wrapper, never in `_inner`.** The `_inner` cores are shared with `bridge::exec`, which acts for an AI and is already bound by `policy::enforce` (ADR #94). A check in the core would judge an AI request by the person's `human` block, which is wider than the AI's. So listings are filtered after the core returns, and writes are refused before it runs.
- **`with_ctx` used to fail open.** Phase 1's filters returned the unmanaged answer for a `Pending` or `Broken` policy. That was harmless for the AI, because `enforce` had already refused, but it would have listed every table to a person whose policy share was down. They now take a separate `blocked` answer, which hides everything. `active()` words the refusal for the subject, and for a person it says the app is open but no connection reads or writes (§5.4).
- **Free SQL is more than the query editor.** These are all free SQL under a rule that limits relations, and are refused there:
  - `execute_query` / `execute_batch`. The second is also the SQL-file importer.
  - The query panel's `TableFilter.raw`. On SQL it is a `WHERE` fragment, and `validate_raw_where` says it is no security boundary: a subquery reads any table and a function call can write. On MongoDB the same field is a filter document over the one collection, so it is left alone (`guard::raw_filter`).
  - A view's body (`preview_view_change` / `apply_view_change`).
  - A MongoDB pipeline that joins through `$lookup` / `$unionWith` / `$graphLookup` (`guard::pipeline`). The scan is deliberately naive: the stage name anywhere counts. A pipeline that does not join is a read of its source and keeps working under a scoped rule.
- **Relations reached from another relation are checked in their own right:**
  - `fetch_fk_options` reads the key's *target* table.
  - `list_referencing_foreign_keys` drops keys coming from a hidden table.
  - `apply_structure_change` needs read on every table a foreign key names.
  - `rename_table` checks both ends, the destination database included (MongoDB can move a collection across databases).
  - `export_databases` refuses a table asked for by name that may not be exported, and a whole-database dump keeps only what may be.
- **`export` needs `select` too.** Exporting is reading plus letting the rows leave, so `Need::Export` checks both. `Need::DatabaseDdl(db)` asks for DDL on a rule whose `databases` glob covers `db`, which is what creating a database needs before the database exists.
- **Profiles come from memory for a person.** The AI's `profile_for` reads `profiles.json` from disk, so the sidecar sees edits made in the app. A person's runs on every grid page and cell edit, and the app is what writes that file, so it reads `state.profiles`.
- **`HUMAN_POLICY` and its two tests.** `every_registered_command_says_what_the_policy_asks_of_it` parses `generate_handler![…]` in `lib.rs`: an unclassified command fails it, and so does an entry for a command that no longer exists. `every_command_that_touches_a_database_calls_the_guard` finds each non-`none`, non-`ai` command's body in `src/commands/<module>.rs` and fails if it never calls `crate::commands::guard::`, so listing a command is not enough. This was checked by deleting `delete_rows`' guard: the test named it. `test_connection` is `none` on purpose: it runs `SELECT 1` against a profile being edited, reads nothing, and refusing it would stop a person finding out their password is wrong.
- **For the frontend.**
  - `policy_access` answers per connection: visible, free SQL, a verb upper bound, export and monitor, and the reason when locked.
  - `policy_relation_access` answers per relation, in one call per listing or tab, because the globs and the schema-is-the-database rule live only in Rust.
  - `policy::install` takes an `on_change`. The app emits `huginndb://policy-changed` when a reload's `Debug` fingerprint differs; the sidecar passes nothing.
  - All three are advisory. The commands refuse regardless, so a stale answer can show a control that then fails, but never let one through.
- **A guardrail, and the docs say so.** A person with the database password can open another client. Per-person database users with matching grants (phase 3) are what make it a wall.
