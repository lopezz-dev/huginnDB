---
id: 54
type: adr
status: accepted
date: 2026-08-25
tags: [mcp, policy, mongodb]
triggered_by_external_trap: false
related: [30]
supersedes: []
superseded_by: null
amends: []
---

# ADR #54: A statement's write tier is classified from its text in exactly one place

`db/classify.rs`'s `MongoOp::class()` is an exhaustive match so a new mongosh operation without a stated tier is a build error — fixing a real privilege-escalation bug where the old SQL-keyword heuristic tiered every Mongo read as `DataWrite` because the pool wasn't available to ask.

**Decision:** db/classify.rs is the single place a statement's write tier is decided, choosing the grammar from the statement text (not the pool) with an exhaustive MongoOp match; since the 2026-09-24 addendum it answers in Verbs and derives StmtClass from them.

**Alternatives rejected:**

- The first-keyword SQL heuristic for all statements: tiered every Mongo read as DataWrite and would have under-tiered Mongo DDL.
- Deriving the grammar from the pool: the connections map is empty when the desktop app serves the bridge.
- An independently maintained is_read list: now derived from class()/verbs().
- Putting the Mongo branch in db/sql.rs: a module named sql dispatching on mongosh is what gotcha #30 warns about.
- SQL create_index/drop_index MCP tools: IndexDef exists to be diffed; CREATE INDEX via run_query at full serves SQL better.
- A nested spec object in MCP args: schemars renders it as a $ref that made clients drop every tool.

## Detail

**A statement's write tier is decided in exactly one place (`db/classify.rs`), and the grammar is chosen from the statement TEXT, never from the pool.** Two enforcement points ask the question — the connector's `run_query` (`mcp/mod.rs`) and the app's independent re-check (`bridge::server::class_of`) — and both used to answer it with `db::sql::classify`, a first-keyword heuristic that knows nothing of mongosh. What that cost, and why the fix is shaped this way:
    - **The pool is not available to the question.** `run_query` derived `is_mongo` from `self.state.connections`, and that map is **empty whenever the desktop app is serving the shared pool** (`resolve_mongo_target`'s own comment says so — it pays a `BridgeRequest::IsMongo` round trip for exactly this reason). So every bridged Mongo statement fell through to the SQL classifier, where `db.users.find({})` matches none of `select`/`with`/`show`/`explain`/`pragma` and therefore lands on `DataWrite`: **a `read-only` MongoDB connection was refused its own reads.** `class_of` agreed, for the same wrong reason. Classification now needs no pool at all, which also removes a round trip.
    - **It was a privilege escalation waiting for the grammar to grow.** While `db/mongo/shell.rs` had no DDL, "every Mongo write is `DataWrite`" was merely too strict. The moment `createIndex` / `drop()` / `renameCollection` were added (1.19.0), both sides would have tiered them `DataWrite` and handed a `data` connection the schema changes its policy denies — the exact failure `docs/MCP_CONNECTOR_ROADMAP.md` calls the bar any new write path must clear. `MongoOp::class()` is an **exhaustive** match returning `StmtClass`, so adding an operation without stating its tier is a build error; `is_read()` is now derived from it (`class() == Read`) rather than being a second, independently-maintained list.
    - **An unparseable `db.…` statement is reported as `Ddl`** — the strictest tier. It will fail at parse time anyway when it runs, so the only thing the choice affects is which policies get to *reach* that error, and the safe direction for an authorisation decision is to assume the most.
    - **The whole-relation guard lives here too, and covers both grammars.** `deleteMany({})` used to be accepted at `data` while `DELETE FROM users` was refused at every tier. The opt-in is a trivially-true predicate (`{_id: {$exists: true}}`), mirroring `WHERE 1=1`. `drop()` is deliberately *not* covered: its scope is unambiguous and it already sits behind `full`, exactly as the SQL guard leaves `DROP TABLE` alone.
    - **Don't put the Mongo branch in `db/sql.rs`.** `StmtClass` lives there and that is fine, but a module named `sql` dispatching on a mongosh prefix is what ADR #30 warns about; the split mirrors `db/exec.rs` vs `db/sql.rs` ("run" vs "build").
    - Related, on the tools added alongside: `create_index` / `drop_index` are **MongoDB-only**, and the reason is the same DTO argument that deferred a structure-editor tool. `db::ddl::IndexDef` is `{name, columns, unique}` because it exists to be *diffed* by the structure editor — `create_index_stmt` / `drop_index_stmt` are private to `build_ddl`, SQL Server has no path at all, and `diff_indexes` is name-based so a same-name column change emits nothing. A SQL client is strictly better served by `CREATE INDEX` through `run_query` at `full`. `NewMongoIndexSpec` is on the other side of that line (a key document as source text plus flags), but the MCP **args struct is flat**, not a nested `spec` object: `schemars` renders a nested struct as a `$ref` into `$defs`, which is what made clients drop every tool in #83.

## Addendum (2026-09-24): the one place now decides verbs, and the tier is derived

The managed-policy work (`docs/POLICY_ROADMAP.md`) needs the row writes granted separately, so the single place this ADR describes now answers in `db::sql::Verbs` — `select`, `insert`, `update`, `delete`, `ddl` — and `StmtClass` is **derived** from them (`Verbs::class`). Nothing about the rule changed, only its grain:

- `db::classify::verbs_of` is the one dispatcher; `classify_statement` is `verbs_of(..).class()`. `MongoOp::verbs()` is the exhaustive match now, and `class()` / `is_read()` are derived from it — still one list, never two.
- An unparseable `db.…` statement is `Verbs::ALL`, whose class is `Ddl`: the same strictest answer as before.
- Mixed statements claim every verb they can perform (upsert → insert + update, `REPLACE` / `INSERT OR REPLACE` → insert + delete, `MERGE` → what its `WHEN … THEN` branches say), and anything unrecognised claims every row write — the verb-level form of the old `DataWrite` default.
- The structured tools name their own verb (`InsertRow` → insert, `UpdateCell` → update, `DeleteRows` → delete). The rule above — a structured tool must never be classified lower than the same operation through `run_query` — holds per verb now.
- `McpWritePolicy::allows` takes the needed verbs; `data` grants all three writes together, so the per-connection policy admits exactly what it did.
