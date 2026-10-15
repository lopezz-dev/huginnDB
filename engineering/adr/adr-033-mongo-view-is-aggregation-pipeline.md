---
id: 33
type: adr
status: accepted
date: 2026-08-17
tags: [mongodb, mcp]
triggered_by_external_trap: false
related: [29]
supersedes: []
superseded_by: null
amends: []
---

# ADR #33: A MongoDB view is a stored pipeline, so its editor is the aggregation editor

The frontend never parses a pipeline — stage bodies cross IPC as source text parsed by `shell::parse_relaxed_value` — and reading a saved view back must use `bson_to_shell_text`, not the lossy display converter, or re-saving unchanged can silently break matching.

**Decision:** A MongoDB view is edited through the aggregation editor, stage bodies cross IPC as source text parsed only by shell::parse_relaxed_value, saved views are read back via bson_to_shell_text, and MCP view tools dispatch across both models.

**Alternatives rejected:**

- A JS-side pipeline parser: the two grammars would drift silently.
- Client-side splitting of stages vs text: an array literal cannot be split on commas.
- Reading a saved view back with bson_to_json: lossy, so re-saving unchanged could stop it matching.
- Separate MCP tools for SQL and Mongo views: an AI client wants one tool per verb.
- Running $out/$merge in previews or saved views: would overwrite a real collection mid-edit.

## Detail

**A MongoDB "view" is a stored pipeline, so the view *editor* for it is the *aggregation* editor — and there is exactly ONE parser for a pipeline, in Rust.** `commands/view.rs`'s `preview`/`apply` commands reject Mongo on purpose (nothing to diff: no `CREATE VIEW` body, just `{create|collMod, viewOn, pipeline}`); the parallel path is `db/mongo/aggregation.rs` + `commands/aggregation.rs` + `src/components/aggregation/`. **The two editors still diverge, but the MCP surface does not**: `get_any_view_definition_inner` / `save_any_view_inner` / `drop_view_inner` in `commands/view.rs` dispatch across both models, because an AI client cannot tell them apart from a `list_tables` row and wants one tool per verb, not two. That is the same call `drop_view` had already made for itself. The GUI's divergence is right (a pipeline builder and a SQL text editor are different surfaces); a headless caller's would not be. The invariants:
    - **The frontend never parses a pipeline.** Stage bodies cross the IPC boundary as the *source text* the user typed — relaxed JSON, `ObjectId(…)`, comments — and are read by `shell::parse_relaxed_value`, the query editor's own parser (now callable standalone, and comment-aware; `skip_ws` handles `//` and `/* */`). That is also why the stages ⇄ text mode switch is a backend call (`format_mongo_pipeline`) and not a client-side split: an array literal cannot be split on commas, a stage body is full of them. `lib/mongo/pipeline.ts::operatorOf` reads only as far as the first key — enough to label a card, never enough to be mistaken for a parser. Don't add a JS pipeline parser; the two grammars would drift and the drift would be silent.
    - **Reading a view back goes through `values::bson_to_shell_text`, not `bson_to_json`.** The stored pipeline is BSON; rendering it with the display converter would turn an `ObjectId` in a `$match` into a bare string and a `NumberLong` into a plain integer, so *opening a view and saving it unchanged* would quietly stop it matching anything (ADR #29's failure mode, one level up — and an `Int64` is written as `NumberLong(…)` even when it fits an `i32` for exactly that reason). The `pipeline_source_round_trips_through_bson` test is the guard. Types with no constructor in the grammar (`Binary`, `Timestamp`, `MinKey`/`MaxKey`) fall back to Extended JSON and are the documented lossy edge.
    - **`$out`/`$merge` are refused before dispatch** (`reject_write_stages`), in previews *and* in saved views. The editor previews on a debounce as you type, so running a write stage would overwrite a real collection mid-edit. Every preview also appends `{$limit: n}`, and the per-stage preview runs the pipeline *prefix* per stage — bounded work per keystroke, not a full materialisation.
    - `docs_to_result` is `pub(super)` so the aggregation module shapes its output identically to `find`/`aggregate` in the query editor, `row_types` included (ADR #29). Previews mount `DocumentListView` read-only: a pipeline's output is computed, there is no `_id` to write back through, and omitting `onFieldSave`/`onFieldDelete` is what keeps that component out of document-editing mode.
    - Aggregation tabs are ephemeral (filtered out of `persistedTabs`, like structure and view tabs) but ARE deduped in `useTabs.open` on (connection, schema, table, **view**) — so "Edit pipeline" on a view and a scratch pipeline over the same collection stay separate sessions, and re-opening either can't strand a pipeline mid-build.
