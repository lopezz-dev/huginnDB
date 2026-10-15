---
id: 93
type: adr
status: accepted
date: 2026-09-24
tags: [security, mcp, ai]
triggered_by_external_trap: true
related: [54]
supersedes: []
superseded_by: null
amends: []
---

# ADR #93: A statement's tier is read from its text, so a read an AI sends must also be run where the database refuses to write

`db::classify` decides the tier a statement needs from its text, and three shapes that write read as a `SELECT` by their first keyword: a `WITH` carrying DML, `EXPLAIN ANALYZE`, and a MongoDB `aggregate` ending in `$out`/`$merge`. All three passed a `read-only` MCP connection and the AI panel's no-write rule, and the server ran them. The classifier now recognises them — and, because a text classifier will be wrong again, a statement an AI sends that is classified as a read now runs inside a read-only transaction (PostgreSQL, MySQL) or with `PRAGMA query_only` (SQLite), so the next miss fails on the server instead of executing.

**External trap behind it:** Statements whose first keyword reads as a read can write: a WITH carrying DML, EXPLAIN ANALYZE (executes the statement), and a MongoDB aggregate ending in $out/$merge; on MySQL DDL implicitly commits an open transaction.

**Decision:** classify_one recognises disguised writes, and every AI-sent statement classified as a read runs in a read-only transaction (PostgreSQL, MySQL) or under PRAGMA query_only (SQLite) via bridge::exec::execute.

**Alternatives rejected:**

- Fixing is_read_only itself — rejected because it also decides whether the GUI fetches a result set and WITH … DELETE … RETURNING returns rows.
- Applying the read-only barrier to the GUI's own editor — deliberately not done; a person there chose to run the statement.

## Detail

**How it was found.** Mapping every call site of `StmtClass` for the managed-policy work (`docs/POLICY_ROADMAP.md`), which splits `DataWrite` into verbs and therefore has to trust what `classify` says. It could not: `is_read_only` accepts anything starting with `with` or `explain`, and `MongoOp::class` put `Aggregate` in `Read` by name while `query::execute` ran the pipeline as given. `reject_write_stages` existed, but only the aggregation editor and the view editor called it.

- **The fix lives in `classify_one`, not in `is_read_only`.** `is_read_only` also decides whether the GUI fetches a result set, and a `WITH … DELETE … RETURNING` *does* return rows — changing it would blank the grid for a statement that has one. `read_or_disguised_write` runs only once `is_read_only` said yes, and answers the separate question of which tier the statement needs. This is the same split `is_select_into` already made for T-SQL.
- **The `WITH` check looks at code, not at text.** `mask_non_code` blanks literals, quoted identifiers, comments and dollar bodies while keeping byte offsets, and `split_statements` now cuts on the mask. One lexer serves both, so "where does this string end" cannot be answered two ways. It returns bytes rather than a `String` because a classifier is a security boundary and must not have a panic path on odd input.
- **Three spellings borrow the keywords without being DML** and are excluded: `FOR UPDATE`, `FOR NO KEY UPDATE`, and T-SQL's `MERGE JOIN` hint. Everything else errs towards the write, which is the direction a boundary may err in.
- **`EXPLAIN ANALYZE` takes the tier of the statement it measures**, a plain `EXPLAIN` stays a read — it only plans. Any mention of `ANALYZE` in the parenthesised options counts, `ANALYZE false` included: rare enough that erring towards "it runs" costs nothing.
- **`$out` is DDL, `$merge` a data write.** `$out` creates or replaces a whole collection, which is what `CREATE TABLE … AS` / `DROP` get on the SQL side; `$merge` writes documents into one. `aggregation::write_stage` is the one definition of a write stage, shared by the editor's guard and by `MongoOp::class`, so what the editor refuses to preview is never what a read-only connection may run. `is_read()` stays derived from `class()` (ADR #54), so the batch executor now treats such an aggregation as a write — correct, since it returns no documents.
- **The second barrier is the part that matters beyond this fix.** `bridge::exec::execute` has exactly four callers and all of them act for an AI, so its `RunStatement` arm sends a `Read` statement to `execute_read_with_state`: `BEGIN READ ONLY` on PostgreSQL, `START TRANSACTION READ ONLY` on MySQL (both through sqlx's `Pool::begin_with`, always rolled back), `PRAGMA query_only` on SQLite. A function with side effects called from a `SELECT` — opaque to any text classifier — is refused by the server too.
- **SQLite's mode is per connection**, so the one thing that must not happen is handing the connection back to the pool still in it: the user's next write from the editor would fail for no visible reason. If switching it off fails, the connection is closed on drop instead of being returned. There is a test that runs a read and then writes through the pool's only connection.
- **What the barrier does not cover, on the record:**
  - SQL Server has no read-only transaction.
  - MongoDB has no read-only mode.
  - On MySQL a DDL statement commits the open transaction implicitly before it runs, so there the barrier stops DML but not DDL. The DDL-first check in `classify_one` is what has to catch that.
- **The GUI's own editor is deliberately untouched.** A person running a statement there chose to run it, and the editor has no read-only policy to enforce. The barrier is for the paths where the text came from a model.
