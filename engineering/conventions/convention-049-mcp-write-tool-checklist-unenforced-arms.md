---
id: 49
type: convention
status: active
date: 2026-08-21
tags: [mcp, security, policy]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Convention #49: Three MCP write-tool wiring steps aren't compiler-enforced, unlike the rest

`bridged_connection_id`, `policy_id_of` and `class_of` all end in `_ => None`, so a forgotten write variant silently skips the app-side policy re-check or the audit `conn=` field rather than failing to build — and can let a read-only connection perform a write.



## Detail

**`bridged_connection_id` (`mcp/mod.rs`) has a `_ => None` arm, so it is the one step of the add-a-write-tool checklist the compiler cannot enforce.** Every other step is protected by an exhaustive `match` — `BridgeRequest::label`, `is_mutating`, `bridge::server`'s `connection_id_of`, and `bridge::exec`'s dispatch all fail to build if a variant is missed. **Correction worth knowing before you trust that list: `bridge::server`'s `policy_id_of` and `class_of` both end in `_ => None` too, so there are *three* unenforced steps, not one — and those two are worse than this one. A write variant missing from `policy_id_of` skips the app-side policy re-check entirely; missing from `class_of` does the same, since `check_policy` returns `Ok(())` the moment either is `None`. The symptom is not a bad log line, it is a write a `read-only` connection was allowed to make.** This one silently returns `None`, and the only symptom is `conn=-` on that write's line in `mcp-audit.log`: an audit-quality regression in a file nobody reads until they need it, long after the change that caused it. When adding a write variant, add it here too. (Do **not** add a read or a dry-run variant — `PreviewViewChange` is deliberately absent, since an unaudited call never reaches this function.) Related, and the reason the audit story needs care at all: writes are audited on *two* paths — bridged, by `AuditSink` in `Huginn::call`, and local, by the `_inner` writing through the `&dyn LogSink` it was handed — so a new write core that does not take a sink is invisible in `mcp-audit.log` whenever no desktop app is serving the bridge, which is the documented fallback rather than an edge case.
