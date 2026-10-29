# MongoDB roadmap

The MongoDB driver started as a **read + basic-edit MVP** in HuginnDB 1.1.0.
This document tracks what is done and what was deliberately deferred — with the
technical hook each deferred item depends on — so the eventual "complete the
MongoDB driver" pass can lean on it without rediscovering the context.

See `CLAUDE.md` for the architecture and `src-tauri/src/db/mongo/` for the
driver code. Per-release scope lives in `CHANGELOG.md`.

**Status legend:** ✅ done · ⏳ deferred (still open as of 1.8.0).

## Done (as of 1.8.0)

Verified against the 1.8.0 tree; grouped by the version that shipped it.

### 1.1.0 — MVP
- Connect via connection string (`mongodb://` / `mongodb+srv://`), browse
  databases → collections, inspect documents in the grid + JSON cell preview
  (`db/mongo/mod.rs`, `schema.rs`).
- `mongosh`-style editor: `find` / `findOne` / `aggregate` / `countDocuments` /
  `distinct` + the write methods (`insertOne/Many`, `updateOne/Many`,
  `replaceOne`, `deleteOne/Many`), chained `.sort()/.limit()/.skip()/.projection()`
  and, since the query panel, `.collation()/.hint()`,
  relaxed JSON and common BSON constructors (`shell.rs`, `query.rs`).
- Edit / insert / delete by `_id`; field-type-aware value coercion (`query.rs`,
  `values.rs`).
- Read-only structure (inferred fields + real indexes); collection drop
  (`schema.rs::table_structure`).
- SSH tunnel for single-host `mongodb://`; CLI `--driver mongodb` +
  `--uri`/`--connection-string`.

### 1.1.1 — connection UX
- Field-driven connection form (Compass-style) that builds the URI live, with an
  **Edit connection string** escape hatch for cases the form can't express.
- Dedicated **auth source** field + CLI `--auth-source`.

### 1.21.x — connect actually connects
- `mongo::open_pool` pings the server before handing back a pool. The driver's
  `Client::with_options` is lazy — it spawns monitor tasks without a round trip
  — so until this landed MongoDB was the only one of the five drivers whose
  `connect` could not fail, and a broken profile reported itself as connected
  while the real error surfaced eight seconds later in the schema tree. See
  ADR #68 for the whole chain, including why the frontend then announced
  success.
- `AppError::Mongo` renders the error's `kind` alone. The driver's own `Display`
  appends `labels`, `source` and a `Debug` of the server reply, and that last
  one is hex-encoded — so every Mongo *command* error used to carry a dump of
  the whole reply into a user-facing string.

### 1.4.0 — introspection
- Users & privileges introspection for the Security panel via `usersInfo`
  (`schema.rs::list_users` / `list_privileges`).

### 1.6.x — data grid parity
- Multi-column sort in the browse path (multi-key sort document, from the
  ordered `order` list on the fetch command).
- Skips `count_documents` on pure sort/page changes, mirroring the SQL
  `COUNT(*)` skip (`with_count` flag).

### 1.7.0 — multi-DB connections
- Multi-database connections show a name in the title bar instead of a blank
  breadcrumb (#51).
- Opening a MongoDB connection with no preselected database no longer errors:
  `list_collections` returns `[]` at the cluster level, mirroring the SQL
  drivers, instead of failing the whole tree (#52).

### 1.8.0 — multi-DB + MCP parity
Closes the gaps #51/#52 left open, and generalizes the MCP connector
(`huginndb-mcp`, see `docs/MCP_CONNECTOR_ROADMAP.md`) for MongoDB, which had
been getting noticeably less attention than the SQL drivers.

- **Security panel in multi-DB connections.** `list_users`/`list_privileges`
  (`schema.rs`) still called `resolve_db(conn)?` unconditionally — the #52 fix
  only covered `list_collections`, not these two sibling functions, so opening
  the Security tab on a cluster-level connection (no database selected) still
  threw "no database selected". Both now run cluster-wide via `usersInfo` with
  `forAllDBs: true` against the `admin` database when no database is selected
  (mirroring `ping()`'s existing cluster-level probe), falling back to today's
  per-database behavior otherwise.
- **MCP `run_query` no longer blocks MongoDB reads.** The read-only gate in
  `mcp/mod.rs` used the plain-SQL keyword classifier
  (`db::sql::is_read_only`, recognising only `select/with/show/explain/pragma`)
  before dispatching — a mongosh read like `db.coll.find({...})` never matches
  any of those, so **every** MongoDB `run_query` call was rejected by default,
  unless the server ran with the global `--allow-writes` flag (which also
  unlocks real SQL writes). The desktop query editor never had this problem
  because it dispatches Mongo before the generic gate and lets
  `MongoOp::is_read()` (`shell.rs`) classify the statement; `run_query` now
  does the same for Mongo connections.
- **Per-column BSON type in query/browse results** (was deferred item #11
  below — see its former write-up for the reasoning). `docs_to_result` /
  `scalar_result` / the `distinct` result in `db/mongo/query.rs` now infer each
  column's real BSON type (`int`, `string`, `date`, `objectId`, …, or `mixed`
  on disagreement) instead of the generic `"bson"` label — this also improves
  what an MCP client sees from `run_query`/`browse_table`.
- **Collection size in the explorer** (was deferred item #7 below). A single
  `$collStats` aggregation run at the database level (`db.aggregate([{$collStats:
  {storageStats: {}}}])`) returns storage stats for every collection in one
  round trip, avoiding the N+1 cost the original deferral was worried about.
  Best-effort: an older server or an insufficiently-privileged role just leaves
  sizes unknown instead of failing the listing.
- **MCP tools can finally target a database on a multi-DB MongoDB connection.**
  A real-world MCP session against a multi-DB Mongo connection surfaced that
  `list_tables`, `describe_table`, `list_indexes`, and `browse_table` all
  accepted (or, for `list_tables`, didn't even have) a `schema` parameter that
  was silently **ignored** for MongoDB in `list_tables_inner` /
  `get_table_structure_inner` / `list_indexes_inner` / `fetch_table_data_inner`
  — every call on a database-less connection failed with "no database
  selected", with no way to say which database to use. `run_query` hit the
  identical error for a bare `db.coll.find()`, and had no parameter for a
  database at all. The desktop app solves this with `open_database_view`
  (`commands/connection.rs`), which opens a synthetic per-database pool
  (`<id>::db::<name>`) when a user expands a database in the explorer — the
  MCP server had no equivalent gesture. The Mongo half of that function needed
  no `AppHandle`/`Window` to begin with (a single `mongodb::Client` reaches
  every database; it's a client clone + database re-tag, no re-auth), so it's
  now a shared free function (`resolve_mongo_database_view`) the MCP server
  calls whenever `schema` (or `run_query`'s new `database` parameter) names a
  database for a Mongo connection with none bound. `getSiblingDB(...)`
  mid-statement support was considered and deliberately deferred — it needs
  the executor itself to switch databases per-statement, a bigger change than
  a resolved-at-call-time parameter; see item #9 below if revisited.
- **`browse_table`'s `limit`/`offset` now tolerate a numeric string.** Not a
  MongoDB-specific bug, but found in the same live session: some MCP clients
  serialize integer arguments as JSON strings despite the advertised
  `integer` schema, and `serde`'s strict typing rejected `"200"` outright.
  Both fields now accept either a JSON number or a numeric string.

**Remaining MCP/MongoDB gap, deliberately not addressed here:** `describe_table`
still reports the heuristic, sample-based columns from `infer_columns` (no real
catalog to read, unlike the SQL drivers — see item #9's schema-variance note for
the related idea of surfacing sample confidence), and the MCP server has no
per-driver capability negotiation — every tool advertises identically
regardless of which driver a connection uses. Both are real generalization
work but a larger scope than this pass; flagging them here rather than in
`docs/MCP_CONNECTOR_ROADMAP.md`, which is scoped to the (now fully-implemented)
MCP server build-out itself, not per-driver tool quality.

## Deferred (⏳ still open as of 1.8.0)

### 1. Index editor
✅ **Shipped** — as a dedicated **index manager** tab, not as a branch of the
structure editor. The hook noted here originally ("add a mongo branch to
`apply_structure_change` that diffs `IndexDef`s") was rejected on contact with
the DTO: `IndexDef` carries a name, a list of *column names* and `unique`, and
a Mongo index also has a direction or type per key, a TTL, a partial filter, a
collation, text weights and a hidden flag. Widening the shared struct to hold
all of that would have made it wrong for the SQL drivers too, and rebuilding
`{ createdAt: -1 }` from a bare field-name list would have silently recreated
it ascending — ADR #29's failure mode again.

The parallel path is `db/mongo/indexes.rs` + `commands/mongo_indexes.rs`, with
the UI in `src/components/indexes/`:

- **The catalogue is read from raw `listIndexes` documents**, not through
  `mongodb::IndexModel`. A raw document preserves key order, key values and
  every option, including ones the driver's typed `IndexOptions` doesn't model;
  what the DTO doesn't name explicitly survives in `extraOptions` as source
  text, so nothing the server reports is dropped in silence.
  `schema.rs::list_indexes` stays as it was — it feeds the SQL-shaped explorer
  DTO and is deliberately lossy.
- **One grammar, both directions**, as for pipelines: key documents, partial
  filters, collations and weights cross as source text and are parsed by
  `shell::parse_relaxed_value` / rendered by `values::bson_to_shell_text`. The
  frontend never parses BSON. Writes go through `createIndexes` /
  `dropIndexes` / `collMod` run-commands rather than `Collection::create_index`,
  which would be lossy outbound for the same reason.
- **Sizes and usage** come from `$collStats` (`indexSizes`) and `$indexStats`
  (`accesses.ops` / `since`), both best-effort: a role without the privilege
  leaves the columns out instead of failing the listing. An index with a long
  uptime and zero operations is the thing this view exists to show.
- **Hide/unhide** sits next to drop as its reversible rehearsal — the planner
  stops using a hidden index while the server keeps maintaining it.
- `_id_` is refused for drop, hide and replace in the backend, not only greyed
  out in the UI.

Known limits, deliberate:
- **"Edit" is a drop plus a create.** MongoDB cannot alter an index in place
  (`collMod` reaches `hidden` and nothing else), so the collection runs without
  the index while the replacement builds. The new spec is parsed *before* the
  drop, and a failure after it names the now-missing index explicitly.
- **No index build progress.** A large `createIndexes` blocks the call rather
  than reporting progress. Hook: `currentOp` filtered to the index build.
- **Creating and dropping are exposed over MCP (1.19.0); hiding and replacing
  are not.** The write-policy decision this bullet used to defer resolved to
  `full` — an index is schema — and it was *forced* rather than chosen:
  `db.coll.createIndex(…)` through `run_query` is classified DDL, so a
  `data`-tier tool would have handed back exactly what the statement path
  denies. `create_index` / `drop_index` in `mcp/mod.rs`, `CreateMongoIndex` /
  `DropMongoIndex` in `bridge/protocol.rs`, both through the new
  `create_mongo_index_inner` / `drop_mongo_index_inner` cores so the write is
  logged whoever owns the pool. Hiding stays UI-only (`collMod` reaches
  `hidden` and nothing else, and `hideIndex` is reachable through `run_query`),
  and replacing stays UI-only because it is a drop plus a create — two calls an
  AI client can make itself, with the gap visible to it.
- **`list_indexes` over MCP had to grow with them.** It reported the SQL-shaped
  `{name, columns, unique}`, so a client that read `["createdAt"]` and wrote it
  back recreated the index *ascending* — the same failure this item already
  records for the shared `IndexDef` DTO. Its bridge arm now answers from the
  rich reader on MongoDB (`list_indexes_detailed_inner`), adding a `mongo`
  object per entry. The explorer still calls the lossy reader, so the two stay
  two and the `$collStats`/`$indexStats` cost is paid only on the MCP path.

### 2. JSON Schema validator editor
View and edit a collection's `$jsonSchema` validator.
- **Why deferred:** needs a dedicated editor surface (Monaco JSON) and a
  `collMod` apply path; out of scope for the MVP's read-only structure view.
- **Hook:** `db.run_command({collMod, validator})`; read the current validator
  from `listCollections` options.

### 3. Typed `_id` round-trip
Today a displayed `_id` is reconstructed heuristically (a 24-hex-char string is
treated as an `ObjectId`). A genuine 24-hex-character *string* `_id` is the one
ambiguous case.
- **Why deferred:** display renders `ObjectId` as a bare hex string for
  readability (`bson_to_json`); making it unambiguous on write needs the field's
  `_id` BSON type threaded into `update_cell`/`delete_rows`.
- **Hook:** carry the `_id` type from `infer_columns` into the edit payload, or
  tag `_id` cells with Extended JSON in the result.

### 4. Transactions / sessions
Multi-document transactions (require a replica set).
- **Why deferred:** the SQL batch path uses a single pooled connection with
  user-driven `BEGIN/COMMIT`; MongoDB needs an explicit `ClientSession` with
  `start_transaction` / `commit_transaction`.
- **Hook:** `Client::start_session`; thread a session through the mongo CRUD
  helpers in `db/mongo/query.rs`.

### ~~5. Profile transfer / export for MongoDB~~ — done
MongoDB profiles had in fact been exported, imported and synced through shared
origins all along: `transfer.rs` excludes no driver. What stayed open was the
inline-credential URI, and that was a leak rather than a missing feature: the
password rode in clear in `profiles.json`, in "encrypted" exports and in
published origins. Resolved by **stripping it**: wherever a profile is written,
the password leaves the URI for the keychain, and an export or a published
origin carries it in the encrypted `ExportedSecret` slot (ADR #122).

### 6. SRV + SSH tunnel
Tunnel `mongodb+srv://` (Atlas) connections.
- **Why deferred:** an SRV record resolves via DNS to several replica-set hosts;
  the current single-port tunnel (`db/ssh.rs`) can front only one host.
- **Hook:** resolve the SRV record manually, open one tunnel per resolved host,
  and rewrite `ClientOptions.hosts` to the local endpoints with
  `direct_connection = false`.

### 7. Collection size in the explorer
✅ **Fixed in 1.8.0 — see the "1.8.0 — multi-DB + MCP parity" entry above.**
(Number kept stable so cross-references elsewhere don't drift.)

### 8. Table ⇄ JSON view toggle
✅ **Shipped.** The toolbar toggle landed in 1.11.0 as a read-only list view;
the pass after it turned that view into a Compass-style **document editor** —
folded nested values, inline per-field editing, a BSON type picker, add field
(`$set`) and delete field (`$unset`, the new `unset_field` command) — and made
it available on every driver. See the `CHANGELOG.md` entries and
`src/components/grid/DocumentListView.tsx` + `src/lib/grid/documentTree.ts`.

Two limits are deliberate and worth knowing before extending it:
- A field's **key cannot be renamed** in place (Compass allows it). A rename is
  a `$set` of the new key plus an `$unset` of the old one, i.e. a two-write
  operation that has to be atomic to be safe — that wants a document-level
  update command rather than the per-field one this view uses.
- Types whose display form isn't round-trippable (`Binary`, `DbPointer`,
  `MinKey`, `MaxKey`) are not editable inline: the grid shows
  `Binary(Generic, 12 bytes)`, not the bytes. Replacing such a field goes
  through the type picker, which writes a fresh value of the chosen type.
  Rendering real binary content would need `bson_to_json` to stop being lossy
  for them (see this file's header note on display-vs-fidelity).

### 9. Richer query surface
`explain`, `bulkWrite`, `findAndModify`, change streams, GridFS, and per-field
schema-variance analysis (type distribution across a sample).
- **Why deferred:** beyond the MVP's bounded `mongosh` grammar
  (`db/mongo/shell.rs`).
- **Hook:** extend the `shell.rs` parser + `query.rs` executor; the parser is
  designed to reject unknown methods with a clear error, so additions are
  additive.
- Arbitrary JavaScript (variables, loops, `printjson`) is deliberately **not**
  on this path: the terminal panel runs the user's own `mongosh` signed in as
  the connection (ADR #107), which is where a script an AI tool wrote
  belongs. What stays here is what the editor should do *natively* — grid
  results, `explain`, per-statement tabs.
- The **visual aggregation builder** that used to be listed here is ✅ **done** —
  see item #12 below.
- `explain` is ✅ **done for `find`**: the grid's query panel reads the plan of
  its own draft (`explain_table_query`, through Pulse's `explain` at
  `queryPlanner` verbosity, collation and hint included). The **aggregation
  editor** still previews output but shows no plan. Hook: the same Pulse reader
  already accepts an `aggregate` statement, so the editor only needs the button
  and a statement to hand it.

### 12. View editing / aggregation builder
✅ **Shipped.** A MongoDB view is a stored aggregation pipeline, which is why
`commands/view.rs` rejects Mongo (there is no `CREATE VIEW` body to diff). The
parallel path lives in `db/mongo/aggregation.rs` + `commands/aggregation.rs`,
with the UI in `src/components/aggregation/`:

- Read a view (`listCollections` → `options.viewOn` / `options.pipeline`),
  preview a pipeline whole or **per stage** (each stage sees the pipeline
  truncated after it), and save with `{create|collMod, viewOn, pipeline}`.
  Dropping a Mongo view is handled inside the shared `drop_view` command — it
  needs no DDL, so it did not warrant a second command.
- **One grammar, both directions.** Stage bodies are parsed by
  `shell::parse_relaxed_value` (the query editor's own parser, now reachable
  standalone, and now comment-aware) and rendered back by
  `values::bson_to_shell_text`, which writes typed values as the constructors
  that parser reads. That round trip is what stops "open a view, save it
  unchanged" from rewriting an `ObjectId` as a string or a `Long` as an `Int`
  — ADR #29's failure mode, one level up. The frontend never parses a
  pipeline; even the stages ⇄ text mode switch is a backend call
  (`format_mongo_pipeline`).
- `$out`/`$merge` are refused before dispatch (`reject_write_stages`): the
  editor previews on a debounce, so running a write stage would overwrite a
  collection mid-keystroke.

Known limits, deliberate:
- **A view cannot be renamed.** MongoDB has no rename for a view; the only path
  is drop + recreate, which is a destructive gesture rather than a rename, so
  the explorer offers no "Rename view" for Mongo. A *collection* can be renamed
  — see the entry below — and `rename_collection` refuses a view up front with
  a message saying so, rather than relaying the server's own error.
- **`collation` is not round-tripped.** `createView` accepts one; the editor
  neither shows nor preserves it, so redefining a view that has a collation
  through `collMod` drops it. Hook: carry `options.collation` on
  `MongoViewDefinition` and pass it back through `save_view`.
- **Types with no constructor in the grammar** (`Binary`, `Timestamp`,
  `MinKey`/`MaxKey`) render as Extended JSON and re-save as plain documents.
  Pipelines carry filters and field paths rather than stored data, so this is
  rare; the fix is the same one item #8 needs — a non-lossy display form.
- **No `explain` in the aggregation editor.** `find` has one now (the query
  panel); see item #9 for the hook that would give the editor one too.

### 13. Rename a collection
✅ **Shipped.** `renameCollection` is a run-command on the `admin` database
that qualifies both sides with a database name (`db.collection`), so moving a
collection to another database is the same operation as renaming it and the
explorer offers both from one dialog. Lives in `db/mongo/schema.rs`
(`rename_collection`) and is dispatched from the shared `rename_table`
command's MongoDB arm, so the tree, the tab retitling and the refresh are the
driver-agnostic ones the SQL drivers already use.

Three rules worth keeping:
- **`dropTarget` is always `false`.** Renaming onto an existing collection has
  to surface as an error, not as a silent drop of whatever was there.
- **Views are refused before the round trip**, with a message that says to
  recreate instead (see item #12's note).
- **A cross-database move copies the documents server-side**, so it costs time
  proportional to the collection and needs privileges on both databases. The
  dialog says so before submitting, and closes the collection's open tabs
  afterwards — the destination lives behind a different `<parent>::db::<db>`
  connection id, so a retitled tab would keep querying the database the
  collection just left.

Since 1.19.0 the same-database rename is also reachable from the query editor
and over MCP as `db.coll.renameCollection("clients")`, delegating to the same
function so all three rules above still apply — no dedicated tool was added, and
`dropTarget: true` is refused by the grammar rather than passed through. The
**cross-database move stays dialog-only**, and that is a decision rather than an
omission: `mongosh` does not accept a qualified destination there either, and a
collection name may contain dots (`system.views`, `logs.2024`), so treating
`"a.b"` as `db=a, coll=b` would make a legitimate rename silently mean a move.
The grammar passes the name through whole with `to_db: None`.

### 10. Proper editor language for MongoDB
The editor reuses Monaco's `sql` language for syntax highlighting; mongosh would
read better with a JavaScript/JSON grammar.
- **Why deferred:** keeping `sql` preserved the existing CodeLens "▶ Run",
  `Ctrl+Enter`, and completion wiring with minimal churn for the MVP.
- **Hook:** `src/lib/monaco/monacoSql.ts` providers are language-scoped; register a
  parallel set for `javascript` and switch the model language per driver in
  `QueryEditorTab.tsx`.

### 11. Per-column BSON type in the data grid
✅ **Fixed in 1.8.0 — see the "1.8.0 — multi-DB + MCP parity" entry above.**
(Number kept stable so cross-references elsewhere don't drift.)
