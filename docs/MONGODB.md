# MongoDB

MongoDB is a first-class driver, not a bolt-on: the same explorer, grid, tabs
and MCP connector serve it. But it is the one engine with no SQL, so several
surfaces work differently, and a few SQL-only ones don't exist there at all.
This page is what changes.

## Connecting

The connection dialog is field-driven (host, port, database, username, **Auth
source**, **Direct connection**) and builds the `mongodb://` URI live from what
you type. The password is stored in the OS keychain and is *not* embedded in the
URI.

**Direct connection** adds `directConnection=true`. Turn it on when you are
reaching one member of a replica set on purpose — through a jump box, or to read
from a specific secondary. Without it the driver takes the host you gave as a
seed, reads the set's real member addresses from it, and tries to reach *those*
instead; when they are internal names this machine cannot resolve, the connect
fails even though the host you typed was perfectly reachable. Leave it off for a
normal replica-set or standalone connection.

**Edit connection string** unlocks the URI for what the form can't express:
Atlas (`mongodb+srv://…`), replica sets, and any extra URI option. Once you
edit it by hand, that string is what gets used verbatim — the discrete fields
become best-effort conveniences.

Two limits worth knowing up front:

- **SSH tunnelling works for `mongodb://host:port`, not for
  `mongodb+srv://`.** An SRV record resolves to several replica-set hosts and
  one tunnel can only front one of them.
- Leaving the database blank is fine: the connection opens at cluster level and
  the explorer lists the databases. Collections live under each database node.

## Browsing

Databases → collections → fields and indexes, same tree as everywhere else. The
field list is **inferred** from a sample of documents, because a collection has
no declared schema; it is a reading aid, not a contract, and a field only some
documents carry is still shown.

Collection sizes and index sizes/usage come from `$collStats` and `$indexStats`
and are **best-effort**: a role without the privilege leaves the column out
entirely rather than showing zeros that would read as "unused".

**Creating a database asks for its first collection.** MongoDB has no empty
database — the server materialises the namespace when the first collection is
written, and forgets it again when the last one is dropped — so "New database"
on a cluster-level connection takes two names and creates both. That is also
why a cluster with no databases at all is not a broken tree: the explorer says
so and offers the dialog, rather than rendering nothing.

**Dropping a database is offered like anywhere else**, from the database node's
context menu, and asks for confirmation regardless of the "confirm destructive
actions" preference. It runs `dropDatabase` against that database only.

## The query editor speaks `mongosh`, in a bounded dialect

The editor takes shell syntax, not SQL:

```js
db.orders.find({ status: "open", total: { $gt: 100 } }).sort({ createdAt: -1 }).limit(50)
```

- **Read methods**: `find`, `findOne`, `aggregate`, `countDocuments` (`count`),
  `distinct`.
- **Write methods**: `insertOne`, `insertMany`, `updateOne`, `updateMany`,
  `replaceOne`, `deleteOne`, `deleteMany`.
- **Schema methods** (since 1.19.0): `createIndex({field: -1}, {unique: true})`,
  `dropIndex("name")`, `hideIndex("name")` / `unhideIndex("name")`, `drop()`,
  and `renameCollection("newName")`. The rename stays **within the current
  database** — the form `mongosh` accepts too; a cross-database *move* is the
  explorer's Rename dialog (see below), deliberately not the grammar's, because
  a collection name may itself contain dots (`system.views`, `logs.2024`) and
  reading `renameCollection("logs.2024")` as "move to the database `logs`"
  would be silently wrong. `renameCollection` never drops an existing
  destination: a collision is an error, and passing `dropTarget: true` is
  refused. Over MCP these need the connection's write policy at `full`; the same
  operations are also available from the index manager and the explorer's
  context menus.
- **Chained modifiers**: `.sort({…})`, `.limit(n)`, `.skip(n)`,
  `.projection({…})`.
- **Relaxed JSON**: unquoted keys, single quotes, trailing commas, `//` and
  `/* */` comments.
- **BSON constructors**: `ObjectId(…)`, `ISODate(…)` / `new Date(…)`,
  `NumberLong/Int/Double/Decimal(…)`.

**Several statements in one script.** As in `mongosh`, the `;` is optional: end a
statement with one, or just start the next call on a new line. Each statement
gets its own result tab (`#1`, `#2`, …), including calls that return a single
value such as three `countDocuments`. A `.sort(…)` / `.limit(…)` that starts a
line continues the statement above it, and a line break inside an open `(`, `[`
or `{` does not end anything. Outside the editor's batch run — MCP `run_query`,
the AI panel — a call takes exactly one statement and refuses trailing text
instead of silently running only the first.

It is deliberately **not** a JavaScript engine. There are no variables, no
expressions, no `for` loops. Anything outside the grammar — an unknown method, a
JS expression — is refused with a clear error rather than half-parsed into
something that runs. Still open on the roadmap: `explain`, `bulkWrite`,
`findAndModify`, change streams, GridFS.

For a script that needs all of that — the kind an AI tool writes when you ask it
to check something in MongoDB — use the terminal below.

## The terminal: `mongosh` as it is

The **Terminal** icon in the right activity bar (or `` Mod+Shift+` ``) opens a
terminal in the bottom dock, next to the Console. Its **+** menu starts either:

- **`mongosh` on the current connection** — the MongoDB connection the
  workspace is on, opened on the database of the tab you were looking at. It is
  the real `mongosh`, so variables, loops, `printjson`, `use other_db` and
  multi-line scripts pasted from an AI tool run exactly as written.
- **Your shell** — PowerShell 7 if installed, else Windows PowerShell, on
  Windows; your `$SHELL`, else `bash`, elsewhere.

Each session is a tab; switching tabs or collapsing the dock keeps them
running, and closing a tab ends it. Disconnecting a connection closes the
`mongosh` sessions signed in to it.

**`mongosh` is not bundled.** HuginnDB uses the one you installed (from
<https://www.mongodb.com/try/download/shell>), found on `PATH` or where the
official installers put it; Settings → **Terminal** shows which one it found
and its version, and takes a path if it guessed wrong.

**No `mongosh` installed? Download it.** When none is found, the Terminal's empty
state, its **+** menu and Settings → **Terminal** offer **Download mongosh**. It
fetches the latest stable official build for your system from MongoDB's download
site, verifies it against the SHA-256 MongoDB publishes for that file, and
unpacks it into HuginnDB's own data folder (`%LOCALAPPDATA%HuginnDBmongosh` on
Windows; nothing is installed system-wide and no administrator rights are
needed). Progress is shown and the download can be cancelled. One you installed
yourself is always preferred; when HuginnDB's own copy is in use, Settings offers
**Update to X** when a newer release exists. Linux needs a glibc distribution
(the official build is not built for musl, e.g. Alpine).

**How it signs in.** With the connection's own credentials — the same user,
password and SSH tunnel its pool uses, a personal database user included — so
the connection has to be open first. The password is handed to `mongosh` in
its environment, never on its command line, where other users of the machine
could read it, and it is removed from `process.env` before the prompt appears.

**Keys.** With the focus in a terminal, the keyboard belongs to it: `Ctrl+R`,
`Ctrl+K` or `Ctrl+B` do what they do in a shell. The command palette,
Preferences and the Console / Terminal toggles still work. Copy and paste with
`Ctrl+Shift+C` / `Ctrl+Shift+V`, since `Ctrl+C` interrupts.

Under a managed policy, `mongosh` is offered only on connections where you may
run free-form queries that read and write anything; see `POLICY.md`. To hide
the terminal altogether, turn it off in Settings → **Terminal**.

## Editing documents

The grid's **List view** turns into a document editor for MongoDB: nested values
fold, each field edits in place, and there are affordances a SQL row doesn't
need — add a field (`$set`), delete a field (`$unset`), and a **BSON type
picker**.

Three things about it are deliberate:

- **A field is addressed by its path** (`customData.format`, `tags.2`), not by
  its position in the display. Filtering or sorting the view can't misdirect a
  write.
- **Edits keep the server's type.** The display is lossy on purpose — `Int32`,
  `Int64` and `Double` all arrive as plain JSON numbers, `ObjectId`, `Date` and
  `Decimal128` all as strings — so the type is carried alongside each value
  rather than guessed from it. Fixing a typo in a `NumberLong` writes a
  `NumberLong` back, not an `Int32` that happens to fit. Use the type picker
  when you actually *want* to change a field's type.
- **Values whose display form can't be parsed back are not editable inline**:
  `Binary`, `DbPointer`, `MinKey`, `MaxKey`. The grid shows
  `Binary(Generic, 12 bytes)`, and committing that text is not a thing anyone
  wants. The type picker is their escape hatch — it writes a fresh value of the
  chosen type.

**Unfolding is one gesture, not one per level.** Every document card carries a
chevron beside its field count that opens (or folds) every nested object in that
document at once, at any depth — the case the per-line chevrons handled badly was
a value three levels down, which took three clicks to reach and three more in the
next document. The grid footer has the same pair for *every* document on the
page, next to the row-height zoom, and the aggregation preview carries it
floated over its documents. Both are one-off gestures: neither writes the
**Expand nested values by default** preference (Settings → Appearance), which is
what decides how a document opens in the first place.

**Sorting works without column headers.** The list view has none, so the sort
lives in two other places, in both view modes. The **Sort** button (⇅) in the
toolbar builds a multi-level sort from the fields on the page, nested paths
included, and the active sort shows as chips beside the filter chips: click one
to reverse it, ✕ to drop it. Right-click any field for **Sort ascending /
descending by …** (which replaces the sort, like a plain header click) and
**Filter by this value**. Inside an array the index is dropped: filtering on an
element of `tags` asks for documents whose `tags` *contains* that value, and
sorting on `items.0.sku` sorts on `items.sku`, since `sort()` does not read a
positional index.

**Projection returns only the fields you ask for.** The query panel's
*Projection* row includes or excludes fields (nested paths too), and the
browse sends it as `find()`'s projection document, so a large sub-document
stops travelling with every page. `_id` always comes back — the list view
addresses every edit by it — and a **Fields** chip under the toolbar names the
projection while it is on. *Export query results* writes the projected
documents, in the grid's order.

**Anything the conditions cannot say goes in the expression.** Below the
conditions, *JSON expression* takes a filter document in the query tab's own
syntax — `{ qty: { $gt: 3 }, code: /^IMPCR/ }` — ANDed with the conditions and
the search. The panel's *Result* row shows the whole `db.<collection>.find(…)`
the draft would run, projection, sort and page included, and **Open in editor**
hands it to a query tab that runs it as written.

**Collation and index hint live under *Advanced*.** A collation document
(`{ locale: 'es', strength: 1 }`) changes how strings compare in the filter and
the sort alike — the footer's count included — and the hint forces an index by
name. Both appear in the *Result* line as `.collation(…)` / `.hint(…)`, which
the query tab also accepts. **Explain**, beside them, reads the plan the
draft would use (`queryPlanner` verbosity, so nothing runs).

One limit: **a field's key cannot be renamed in place**. A rename is a `$set` of
the new key plus an `$unset` of the old one, and doing that safely needs one
atomic document-level update rather than the per-field writes this view uses.

## Aggregation pipelines and views

A MongoDB view *is* a stored aggregation pipeline, so there is no separate view
editor: **New aggregation…** on a collection and **Edit pipeline…** on a view
open the same surface.

- **Stages** mode gives one card per stage: pick the operator, write the body,
  drag to reorder, and toggle a stage off without deleting it. **Text** mode is
  the whole pipeline as one array. Switching modes requires the pipeline to
  parse, and text mode has nowhere to keep a disabled stage — you get told
  before it's dropped.
- The **preview** runs as you type, on a debounce, over a bounded sample (the
  **Sample** control), and each stage card shows what *its* prefix of the
  pipeline emitted. So you see where a stage stopped matching, not just the
  final output.
- **`$out` and `$merge` are refused**, in previews and in saved views alike. The
  preview runs while you type; a write stage would overwrite a real collection
  mid-edit.
- **Save as view…** stores the pipeline as a view (`create`), and re-saving an
  open view updates it (`collMod`). Preview output is read-only — a computed
  document has no `_id` to write back through.
- Pipeline text is parsed by the same parser the query editor uses, so
  `ObjectId(…)` in a `$match` stays an `ObjectId` on the round trip. Opening a
  view and saving it unchanged does not quietly stop it matching anything.
  Types with no constructor in the grammar (`Binary`, `Timestamp`, `MinKey`,
  `MaxKey`) fall back to Extended JSON — the documented lossy edge.

## Indexes

**Indexes…** on a collection opens a dedicated index manager. MongoDB is the
only driver with one, and not because the others lack indexes: theirs live
inside the structure editor, diffed into `CREATE INDEX` / `DROP INDEX` along
with the rest of the table. MongoDB has no DDL to diff.

- The list is read from the raw `listIndexes` reply, so **everything survives a
  round trip**: per-key direction (`1` / `-1`) and type (`text`, `2dsphere`,
  `hashed`), `unique`, `sparse`, TTL (`expireAfterSeconds`),
  `partialFilterExpression`, `collation`, `weights`, `hidden` — and anything not
  modelled explicitly is kept as source text. Rebuilding `{ createdAt: -1 }`
  from a list of field names would recreate it *ascending*: invisible in
  testing, permanent in the data.
- An index whose keys the picker can't express opens in **raw** mode instead of
  being flattened into something it can show.
- **Edit is drop + create.** MongoDB can't alter an index in place, so the new
  spec is parsed and validated *before* the old one is dropped, and the
  confirmation says the collection runs without that index while the new one
  builds.
- **Hide** is the reversible rehearsal for **Drop**: a hidden index is kept up
  to date but ignored by the planner, so you can measure what dropping it would
  cost and undo it instantly. That is why it sits next to Drop in the menu.
- `_id_` can't be edited, hidden or dropped — the server owns it, and the
  backend refuses it rather than only greying out the button.
- **Size** and **Uses** are best-effort, as above.
- Index writes are **not** exposed over the MCP connector.

## Renaming and moving a collection

**Rename…** works on collections (`renameCollection` on the `admin` database),
which is also how a collection *moves*: rename it to `otherDb.name` and the
documents are copied server-side. That takes as long as the collection is big
and needs privileges on both databases, so the dialog says so. Renaming onto an
existing collection errors rather than dropping it.

A cross-database move **closes the collection's open tabs** instead of
retitling them: the destination sits behind a different connection node, and a
retitled tab would keep querying the database the collection just left.

A **view** can't be renamed — recreate it under the new name.

## What isn't there (and why)

| Surface | State |
| --- | --- |
| Structure editor (`ALTER TABLE`-style) | Not applicable. There is no schema to alter; fields are created by writing them. Structure is read-only, indexes have their own manager. |
| `.sql` export / import | Not applicable. A collection exports and imports as **JSON** instead (**Export collection (JSON)…** in its context menu). |
| `$jsonSchema` validator editor | Open on the roadmap. Read/write a collection's validator via `collMod`. |
| Multi-document transactions | Open. Needs an explicit `ClientSession` threaded through the CRUD helpers; a replica set is required server-side. |
| Typed `_id` round-trip | Open. A 24-hex-character `_id` is treated as an `ObjectId`; a genuine 24-hex *string* `_id` is the one ambiguous case. |
| `explain` | Open. The aggregation editor previews output but shows no query plan. |
| `mongodb+srv://` through an SSH tunnel | Open. See "Connecting" above. |

`docs/MONGODB_ROADMAP.md` tracks the full done/deferred split with the
implementation hooks for each.

## Over MCP

Every read tool works against MongoDB: `list_databases`, `list_tables`
(collections), `describe_table`, `list_indexes`, `browse_table`, and `run_query`
with the same `mongosh` grammar (reads are `find` / `aggregate` /
`countDocuments` / `distinct`). The write tools work too, gated by the same
per-connection write policy as the SQL drivers. On a connection with no
database bound, pass `schema` — the database name — or the collection list comes
back empty. See [`MCP.md`](MCP.md).

`create_index` and `drop_index` are MongoDB-only tools — on the SQL drivers an
index is created with `CREATE INDEX` through `run_write`, which is more
expressive than any portable form. Read the existing indexes with
`list_indexes` first: on MongoDB each entry carries a `mongo` object with the
real definition, and the column list alone cannot tell `{createdAt: -1}` from
`{createdAt: 1}`.
