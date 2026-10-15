---
id: 59
type: adr
status: accepted
date: 2026-09-01
tags: [mcp, security]
triggered_by_external_trap: true
related: [49, 58]
supersedes: []
superseded_by: null
amends: []
---

# ADR #59: MCP tool annotations are read once at startup, so they must be constants

Deriving `readOnlyHint` from live policy would leave a stale, unsafe-looking hint cached by the client for the session, so `run_query` and `run_write` are two separate tools instead of one dynamically-annotated one.

**External trap behind it:** MCP clients fetch tools/list (and its annotations) once at startup and cache it for the session, and destructiveHint defaults to true when absent.

**Decision:** Every MCP tool annotation is a constant; reads and writes are two tools (run_query with readOnlyHint, run_write with destructiveHint) over one executor and policy gate, and only the --read-only process argument may vary the tool surface.

**Alternatives rejected:**

- Deriving run_query's readOnlyHint from live write policies: rejected because a client caches tools/list at startup, so a mid-session policy raise would silently remove the client-side confirmation.
- Policy-driven tool surface: would require a tools/list_changed notification behind a watch on profiles.json, not done.

## Detail

**A tool annotation is read ONCE, at startup, so it may only ever encode something that cannot change for the life of the process — which is why `run_query` and `run_write` are two tools.** Every MCP tool carries a title plus `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`, and every one of them is a constant. Getting there meant rejecting the refinement that looks obviously right:
    - **Deriving `run_query`'s annotation from the exposed connections' write policies is a safety regression, not an improvement.** It is tempting — in a deployment where everything is `read-only`, a single statement runner really is a read tool, and annotating it destructive puts write-shaped friction in front of nearly every `SELECT`. But a client fetches `tools/list` at startup and caches it for the session, while ADR #58's entire design is that exposure and policy are re-read *per call* so they can change under a running client. Raise a connection to `data` mid-session and the cached hint still says "cannot write": `require_class` still refuses nothing it should, so the **gate** holds — what silently disappears is the client-side confirmation the user believed they had. A stale hint in the safe direction is friction; in this direction it is a missing prompt.
    - **The fix was to split the tool, not to make the annotation clever.** `run_query` takes reads (`readOnlyHint`), `run_write` takes writes (`destructiveHint`), both over one executor (`Huginn::run_statement`) and one policy gate. That also buys the thing the single tool could never express: a client's permission rules key on the tool **name**, so "let the SELECTs run, ask me about the rest" is now a rule someone can write. **Enforcement runs both ways** — `run_write` refuses a read and points at `run_query`, or a model routes everything through the write tool and the split buys nothing.
    - **`--read-only` is the only input allowed to vary the surface**, because it is a process argument and cannot change without restarting the sidecar. Under it `disable_write_tools` takes all eight off `tools/list`; `ToolRouter::call` refuses a disabled route as well, so it is a gate, not a presentation trick. Anything policy-driven would need a real `tools/list_changed` notification behind a watch on `profiles.json`.
    - **`destructiveHint` defaults to TRUE when absent**, so "this tool only ever adds" has to be said out loud — `insert_row` and `create_index` set it `false` explicitly, and a test pins that down.
    - **The compiler cannot enforce any of this**: `Tool::annotations` is `Option`, so a new tool builds fine with none and merely tells clients nothing about itself. Three tests in `mcp/mod.rs` are the enforcement (same family as convention #49's unenforced steps): every tool has a title, a `read_only_hint` and an `open_world_hint`; no write tool claims read-only; and `--read-only` really does remove them.
