---
id: 48
type: adr
status: accepted
date: 2026-08-21
tags: [mongodb, mcp, security]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #48: drop_view must verify the name is actually a view before dropping it

A view and a collection share one namespace, so `view_presence` resolves `Absent`/`Collection`/`View` in one `listCollections` round trip and `drop_view` refuses anything but a confirmed view — critical once a caller, like the MCP tool, can pass a merely-guessed name.

**External trap behind it:** A MongoDB view and a collection share one namespace and dropping either is the same db.collection(name).drop() call, so a mistyped name silently deletes a collection's data.

**Decision:** drop_view resolves the name via view_presence (Absent | Collection | View) in one listCollections round trip and refuses anything but a confirmed view, treating a spec with no type field as a collection and an absent name as NotFound.

**Alternatives rejected:**

- Relying on the caller's intent with no type check: an MCP caller passing a guessed name could drop a real collection.
- Treating a spec without a `type` field as a view: unrecognised replies must fall to the safe answer.
- Keeping MongoDB's silent idempotent success for an absent name: NotFound keeps it consistent with the SQL drivers.

## Detail

**A MongoDB view and a collection share ONE namespace, so `drop_view` needs a type check the SQL drivers get from their engine for free.** `db::mongo::aggregation::drop_view` is `db.collection(name).drop()` — literally the same call as dropping a collection. It carried no check for a long time, on the stated grounds that it was "kept separate so the caller's intent is explicit", which is true of the *caller* and says nothing about the *argument*. Intent was actually being supplied by the only caller: `SchemaTableRow` renders "Drop view" only under `isMongo && isView`, so the user had clicked a row the tree already knew about. The moment a caller can pass a name it merely guessed — which is exactly what the MCP connector's `drop_view` tool is — a mistyped plural deletes every document in a real collection and reports success. `view_presence` now resolves a name to `Absent | Collection | View(def)` in one `listCollections` round trip and `drop_view` refuses all but the third; the predicate behind it (`spec_is_view`) is pure so the thing standing between that function and a collection's data is testable without a server, and it treats a spec with **no `type` field as a collection** (the field only appeared in MongoDB 3.4, and an unrecognised reply must fall to the safe answer, not the destructive one). Two consequences to keep: all three states are load-bearing — `save_view` needs `Absent` vs `View` to choose `createView` vs `collMod`, and `describe_table` treats both non-view answers as "no view body" rather than an error — and an absent name is now `NotFound` rather than MongoDB's silent idempotent success, which is what makes the driver *consistent* with the other four (every SQL driver builds a bare `DROP VIEW` with no `IF EXISTS`) instead of the odd one out. The SQL drivers need no equivalent guard: `DROP VIEW` against a table errors on all four.
