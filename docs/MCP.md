# HuginnDB MCP connector

`huginndb-mcp` is a headless [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the databases HuginnDB already knows about — the profiles in
`profiles.json`, with passwords read from the OS keychain — to an MCP client such
as Claude Code, Claude Desktop, Cursor, Antigravity, or Codex. The assistant can
then inspect the *actual* state of your databases (schema, sample rows, row
counts, server version, privileges) instead of guessing.

Because it's a standard stdio MCP server with no client-specific code, **any**
spec-compliant MCP client can drive it — the sections below cover the ones
with their own config quirks worth documenting; anything else that speaks MCP
(an editor's built-in agent, a custom harness, …) works the same way once you
point it at the binary.

It is a **separate process**. By default it opens its own pools lazily, on
demand, and only for the connections you explicitly expose — it does not share
the running desktop app's. It *can*, if you turn on **Settings → Connections →
Share pools with the MCP connector**, which gives the whole machine a single
connection budget per server; see [Sharing the app's
pools](#sharing-the-apps-pools). Each exposed connection has a **write
policy** — `read-only` (the default), `data`, or `full` — set per connection in
**Settings → MCP**; reads always work, and writes only succeed when that
connection's policy allows them. See [Security](#security).

See [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) for the design
rationale.

## Quick start

Four steps, once. Nothing here needs a terminal unless you want one.

**1. Install HuginnDB.** The connector ships inside the installer as a sidecar
binary — there is nothing extra to download and nothing to build.

**2. Choose what the assistant may reach.** Open **Settings → MCP** and tick
the connections you want it to see. **Nothing is reachable until you tick
it**, and that is the whole access decision: the AI client's configuration
never names a connection.

**3. Choose what it may do.** Each ticked connection has a write policy in the
same panel:

| Level | What it allows |
| --- | --- |
| `read-only` *(default)* | Reads only. Every write tool is refused. |
| `data` | Adds `INSERT` / `UPDATE` / `DELETE`. No schema changes. |
| `full` | Adds `CREATE` / `DROP` / `ALTER`, views and indexes. |

Leave everything at `read-only` until you have a reason not to. Both this and
step 2 are re-read on **every call**, so you can change your mind later
without restarting anything.

**4. Point your client at it.**

- **Claude Code** — click **Add to Claude Code** in Settings → MCP. That is the
  whole step. (It runs `claude mcp add` for you; see
  [Claude Code (CLI)](#claude-code-cli) to do it by hand.)
- **Claude Desktop** — download the `.mcpb` from the
  [latest release](https://github.com/Alexfp28/huginnDB/releases) and drop it
  into **Settings → Extensions**. See
  [Claude Desktop (one-click extension)](#claude-desktop-one-click-extension).
- **Anything else** — copy the JSON snippet from Settings → MCP into your
  client's config. It contains a path and nothing else, so it is the same on
  every machine and you paste it once.

**Check it worked.** Ask the assistant: *"with huginndb, list my connections,
then list the tables in \<name\> and show me 5 rows of the first one."* If it
answers with real table names, you are done.

### Coming from a setup made before 1.21

Your existing configuration keeps working exactly as it is — no action
required. But it is worth knowing what changed, because the old way is no
longer the good way.

The exposed connections used to live in the client's own config as
`--connections <uuid>,<uuid>`, which is why adding a connection meant editing
that file (per client) and restarting it. That list now lives in the app, in
step 2 above.

**A client launched with `--connections` is pinned to that list** and ignores
the checkboxes, deliberately: an argument you typed outranks a checkbox, in
both directions. To switch a client over to the checkboxes, remove the flag
from its config — the command becomes a bare path — and tick what you want in
Settings → MCP. To keep one client deliberately narrower than the rest, leave
the flag; see [Pinning one client to a fixed
set](#pinning-one-client-to-a-fixed-set).

One behaviour change to know about: `run_query` no longer accepts statements
that write. Those go to `run_write`, and the refusal says so.

## Getting the binary

**Packaged installs (the normal case):** `huginndb-mcp` ships as a Tauri
sidecar, installed right next to the main executable — nothing to build.
Open **Settings → MCP** in the app: it shows the resolved path, lets you pick
which saved connections to expose, and generates ready-to-paste config for
Claude Code / Claude Desktop / other clients. The rest of this doc is the
reference for what that panel gives you, plus clients it doesn't generate a
snippet for (Codex).

**Linux AppImage.** An AppImage runs from a temporary mount
(`/tmp/.mount_Huginn…`) that is renamed on every launch and removed when the
app closes, so the sidecar inside it has no path a client could keep. From an
AppImage, Settings → MCP therefore gives the `.AppImage` file itself plus a
`--mcp` argument, which starts the connector inside the image:

```bash
claude mcp add huginndb -s user -- /path/to/HuginnDB.AppImage --mcp
```

```json
{ "mcpServers": { "huginndb": { "command": "/path/to/HuginnDB.AppImage", "args": ["--mcp"] } } }
```

That path survives restarts and in-app updates (which replace the file in
place). Moving or renaming the `.AppImage` breaks it, as it would any path —
register it again. Anything else you pass (`--connections`, `--read-only`, …)
goes after `--mcp`.

**Staying up to date without opening the app.** On Windows, HuginnDB installs
new versions in the background: a scheduled task checks at sign-in and another
once a day, and installs quietly with the same signed feed the app uses. The
connector updates with it — including the one inside the Claude Desktop
extension, which hands its sessions to this copy. It waits while HuginnDB is
open, and the daily check also waits while an AI client has the connector
running; the sign-in check installs regardless, so if a client loses the
connector afterwards, restart the client. Settings → About → **Background
updates** turns it off and shows which mechanism is in force on the machine;
where a domain administrator forbids scheduled tasks it falls back to a
startup entry, and where that is forbidden too it says so and leaves updates
to the in-app button. If an update has been waiting for more than a day, the
connector's instructions say so and the AI tool passes it on; the connector
learns that from what the app recorded, and never contacts the update feed
itself. `huginndb.exe --update` runs the same check by hand.

**Building from source (development only):** the connector lives in its own
workspace crate (`src-tauri/mcp-server/`), kept out of the desktop app's own
`Cargo.toml` so a normal `pnpm tauri:build` never compiles or bundles it on
its own (see the tauri-bundler multi-`[[bin]]` gotcha in `CLAUDE.md` for why;
the release workflow stages it separately as the sidecar). Build it
explicitly:

```bash
cd src-tauri
cargo build --release -p huginndb-mcp
# binary at: src-tauri/target/release/huginndb-mcp[.exe]
```

## Configuring a client

Every client points at the connector's **absolute path** — get it from
Settings → MCP in a packaged install, or see [Getting the
binary](#getting-the-binary) for a source build (on Windows,
`…\target\release\huginndb-mcp.exe`).

**Which connections it can reach is picked in the app**, not in the client
config: open **Settings → MCP** and tick them. The connector re-reads that
choice from `profiles.json` on every call, so exposing one more connection is a
checkbox — no config to edit, no client to restart. Nothing is exposed until you
tick it.

That is why none of the snippets below carry a connection id: they are the same
on every machine, and you paste them once. (Before 1.21 the exposed set lived
here as `--connections <uuid>,<uuid>`; those configs keep working — see
[Pinning one client to a fixed set](#pinning-one-client-to-a-fixed-set).)

**Addressing a connection in a prompt.** Every tool takes the connection's
**name** as shown in HuginnDB — *"with huginndb, list the tables in Producción
MySQL"* — or its profile id. `list_connections` reports both. Names are matched
case-insensitively; if two exposed connections share one, the connector says so
and asks for the id instead of guessing.

### Claude Code (CLI)

**Settings → MCP has an "Add to Claude Code" button** that runs exactly this
for you, when the `claude` CLI is on your `PATH`. Clicking it twice is
harmless — it reports that the server is already registered rather than
failing. Undo it with `claude mcp remove huginndb`.

The same thing by hand:

```bash
claude mcp add huginndb -s user -- /absolute/path/to/huginndb-mcp
```

- The `--` separates the server's command+args from `claude`'s own flags.
- `-s user` makes it available in every project; use `-s local` (the default)
  for just the current repo.
- Check it with `/mcp` inside a session, then try *"with huginndb, list the
  tables in `<name>` and show me 5 rows of the first one"*.

Equivalent hand-written config (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": []
    }
  }
}
```

### Claude Desktop (one-click extension)

Each release attaches an **MCP Bundle** — `huginndb-mcp-<version>-win32.mcpb`
(and a `-linux` one) on the
[releases page](https://github.com/Alexfp28/huginnDB/releases). Download it and
open Claude Desktop's **Settings → Extensions**, then drag the file in or use
*Install extension*. No path to copy and no JSON to edit.

The bundle carries its own copy of the connector, but it is not standalone:
**HuginnDB must be installed on the same machine**, because that is where the
connection profiles and their keychain entries live. Which connections it may
reach is still Settings → MCP in the app, and still re-read per call — the
extension has no settings of its own, which is the point.

**Install the extension once; updates arrive with the app.** On Windows the
bundle's copy hands the session to the connector installed next to
`huginndb.exe` (found through the installer's uninstall key, then
`%LOCALAPPDATA%\HuginnDB\`), so updating HuginnDB updates what Claude Desktop
runs, down to the managed policy that connector enforces. The bundle's own copy
serves the session only when no installed one is found. `HUGINNDB_MCP_PATH`
names a different installed copy, or, set but empty, turns the hand-over off.

Prefer the manual route below if you want one client pinned to a subset of
connections with `--connections`, which the bundle does not pass.

### Claude Desktop (manual)

Settings → Developer → **Edit Config** opens `claude_desktop_config.json`
(`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on
macOS). Add the server and **restart the app**:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "C:\\path\\to\\huginndb-mcp.exe",
      "args": []
    }
  }
}
```

On Windows, double the backslashes in the JSON path (`\\`).

### Cursor

Cursor reads MCP servers from a `mcp.json` with the same `mcpServers` shape as
Claude Desktop — either `.cursor/mcp.json` in a project root (scoped to that
project) or `~/.cursor/mcp.json` (global, every project):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": []
    }
  }
}
```

You can also add it from Cursor's Settings → MCP UI ("Add new global MCP
server") if you'd rather not hand-edit the file. Either way, the JSON snippet
Settings → MCP generates in the app pastes in as-is.

### Antigravity (Google)

Antigravity — Google's Gemini-powered agentic IDE — uses the same
`mcpServers`/`command`/`args` shape. Rather than hunting for the config file
(its location has moved between Antigravity releases), add the server from
the UI: **Agent panel → "…" menu → MCP Servers → Manage MCP Servers → View
raw config**, then paste:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/absolute/path/to/huginndb-mcp",
      "args": []
    }
  }
}
```

Save and hit refresh in the Installed MCP Servers list. (Antigravity's one
real divergence from Cursor/Claude Desktop is remote HTTP servers, which use
`serverUrl` instead of `command`/`args` — doesn't apply here, since
`huginndb-mcp` is a local stdio process.)

### Codex CLI

Codex reads MCP servers from `~/.codex/config.toml` (TOML — not Claude's JSON).
Add a `[mcp_servers.<name>]` table:

```toml
[mcp_servers.huginndb]
command = "C:\\path\\to\\huginndb-mcp.exe"
args = []
# optional: startup_timeout_sec = 20
```

Or add it from the CLI (stdio servers take a `--`-separated command):

```bash
codex mcp add huginndb -- /absolute/path/to/huginndb-mcp
```

The tools then show up under the `huginndb` server inside Codex.

## Command-line flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--connections <a,b,c>` | *(none)* | Pin this client to exactly these profile ids, ignoring the Settings → MCP checkboxes. Without the flag the server defers to those checkboxes and re-reads them per call, which is the normal setup. `--connections ""` pins an empty set — an explicit "expose nothing". |
| `--max-rows <n>` | `1000` | Upper bound on rows returned by a single `run_query` / `run_write` / `browse_table` call, so a tool call can't dump a whole table into the model's context. |
| `--max-connections <n>` | `2` | Budget per **server**, within this process. See [Connection footprint](#connection-footprint) — the default is deliberately well below the desktop app's. A connection that pins its own limit in HuginnDB still wins when it is the stricter of the two. |
| `--read-only[=true\|false]` | `false` | Global kill-switch: force **every** connection to read-only regardless of its saved write policy, and take the eight write tools off `tools/list` entirely — they could only refuse, and a tool the model never sees is a turn it never wastes. A quick way to expose the connector in a guaranteed-safe mode without touching any profile. |
| `--allow-writes` | — | **Deprecated and ignored.** Writes are now governed per connection by the write policy set in Settings → MCP (see [Security](#security)); this flag no longer grants anything and only prints a one-time deprecation notice. |

Flags accept both `--flag value` and `--flag=value`.

### Pinning one client to a fixed set

`--connections id1,id2` overrides the Settings → MCP checkboxes for that client
only, for the life of the process. Use it when one client should see a narrower
set than the rest — a scratch agent restricted to a staging database, say — or
to keep a pre-1.21 config working unchanged.

The pin is absolute in both directions: ticking a connection in the app will not
widen a pinned client, and unticking one will not narrow it. An argument the
user typed outranks a checkbox, so the only way to change what a pinned client
sees is to edit its config and restart it — which is exactly the friction the
checkboxes exist to remove, so prefer them unless you specifically want one
client held to a different set.

Find a profile id in Settings → MCP, or in `profiles.json` in your platform
config dir (`%APPDATA%\HuginnDB` on Windows, `~/.config/HuginnDB` on Linux,
`~/Library/Application Support/HuginnDB` on macOS) — it's the `id` field, not
the display `name`.

## Connection footprint

The connector is a **separate process** from the HuginnDB desktop app, with its
own connection pools. It does not share the app's. That has a consequence worth
knowing before you point it at a database somebody else is also using:

- Every MCP client that has `huginndb-mcp` configured spawns **its own copy**.
  Claude Code and Claude Desktop configured against the same profile means two
  processes, each with its own pool.
- Those pools are additional to the desktop app's, to your IDE's data source,
  and to any application backend pointing at the same server. They all count
  against the same server-side `max_connections`.

Two defaults keep that bounded:

- **`--max-connections` defaults to `2`** per exposed connection, rather than
  the desktop app's `5`. MCP is request/response over stdio and tools are
  dispatched one at a time, so a bigger pool buys nothing here. It is also a
  *per-server* budget within this process: two exposed connections pointing at
  the same host share it rather than getting one each.
- **Idle connections are closed after 5 minutes** with no tool call. The
  connector is long-lived but its work is bursty; a connection opened for one
  question is not held for the rest of the week. It reopens transparently on
  the next call. This holds in both modes — when the connector owns the pool
  and when the app does on its behalf (see below); before 1.21 the second case
  never released anything.

### Sharing the app's pools

If the desktop app is running, it can serve the connector's queries out of its
*own* pools instead — turn on **Settings → Connections → Share pools with the
MCP connector**. Then:

- The whole machine has one budget per server. The app owns every connection;
  the connector (and every other connector, one per MCP client) opens none.
- The connector's activity shows up in the app's **Console** live — every
  browse, query and write, as it happens — instead of only in `mcp-audit.log`
  after the fact. Writes are still audited to that file too.
- The write policy is re-checked by the app, independently of the connector's
  own check.
- A connection the connector asks for is **not** treated as one you opened. It
  takes the smaller, database-view-sized share of the server's budget rather
  than a full desktop connection's, gets no keepalive heartbeat, and is closed
  once it has been idle for **Settings → Connections → Close idle connector
  connections after** (5 minutes by default, matching what the connector does
  to its own). If you later connect to that same connection yourself, the app
  adopts it: it becomes an ordinary connection of yours, heartbeat included, and
  stops being closed automatically.
- **Settings → Connections shows how many of the app's connections the
  connector opened**, next to the bridge toggle. Worth knowing about, because no
  window lists them in the connection tree — a window only shows connections it
  opened itself.

It is **off by default**, because it opens a listener (loopback only,
token-protected) that fronts every database you have saved. When the app isn't
running — or the setting is off — the connector opens its own pools exactly as
described above, and says so on stderr if it loses the app mid-session.

If a server is still tight, set a per-connection ceiling in HuginnDB
(Settings → Connections, or the connection's own **Max connections** field).
It is stored in `profiles.json`, which this connector reads, so it applies to
the sidecar with no extra configuration. Settings → Connections also shows how
many pools the desktop app is holding right now, and **Release idle pools**
closes both the per-database ones and every connection opened for the
connector — leaving only the connections you opened yourself.

## Tools

| Tool | What it does |
| --- | --- |
| `list_connections` | Which databases this server is allowed to reach. |
| `list_databases` | Databases / schemas / catalogs on a connection. |
| `list_tables` | Tables and views, with approximate row counts and sizes. |
| `describe_table` | Full structure: columns, types, nullability, PK, FKs, indexes. Works on a view too, and adds a `view` object with the view's definition when the relation is one — `query` (the SELECT body) on SQL, `viewOn` + `pipeline` on MongoDB. |
| `list_indexes` | Indexes on a table and the columns each covers. On MongoDB each entry also carries a `mongo` object with the full definition — per-key direction and type, `sparse`, TTL, partial filter, collation, weights, size and usage. Read it before recreating an index: the column list alone cannot tell `{createdAt: -1}` from `{createdAt: 1}`. |
| `run_query` | Run a single **read-only** statement (SQL for Postgres/MySQL/SQLite/SQL Server, mongosh-style for MongoDB). Anything that writes is refused here whatever the policy says. |
| `run_write` *(write)* | Run a single statement that **changes** the database. DML needs `data`, DDL needs `full`. A read is refused here too — it belongs in `run_query`, which needs no write permission. |
| `browse_table` | Browse one page of rows without writing SQL. |
| `server_version` | The connected engine and version. |
| `list_users` / `list_privileges` | Server-side users/roles and their grants. |
| `pulse_health` | Live vital signs — queries/s, connection pressure, cache hit rate — normalised to one metric catalogue regardless of engine. MySQL and MongoDB only. |
| `pulse_metrics` | One metric's stored history from Pulse's on-disk sampler, oldest first. Empty unless the connection has Pulse's history sampler turned on in Settings. |
| `pulse_top_queries` | Statements the server has spent the most time on, each carrying a runnable `sample` when one is available. |
| `pulse_explain` | The plan the server would use for one statement — typically a `pulse_top_queries` row's own `sample` — without running it. Refuses anything that isn't read-only, single-statement, and not itself `EXPLAIN`/`ANALYZE`. |
| `pulse_storage` | The connection's biggest relations, largest first, split into data / index / free space. |
| `pulse_sessions` | Every session or operation currently open on the server, with a best-effort blocking chain on MySQL. |
| `pulse_index_usage` | Index usage across the biggest relations, least-read first — the fastest way to spot an index nobody reads. |
| `insert_row` *(write)* | Insert one row (values as text; database defaults for omitted columns). Requires `data` or `full`. |
| `update_cell` *(write)* | Update one column of the single row addressed by its full primary key. Requires `data` or `full`. |
| `delete_rows` *(write)* | Delete one or more rows, each addressed by its full primary key. Requires `data` or `full`. |
| `save_view` *(write)* | Create a view, redefine an existing one, or rename one. Pass just `name` and `query` — it reads the current definition itself to work out which. `preview: true` returns the statements without running them, and is a read. Requires `full`. |
| `drop_view` *(write)* | Drop a view. Refuses anything that isn't one. Requires `full`. |
| `create_index` *(write)* | **MongoDB only.** Create one index. `keys` is source text (`{createdAt: -1}`, `{location: "2dsphere"}`), plus the usual options — unique, sparse, hidden, TTL, partial filter, collation, text weights, and an `extraOptions` escape hatch. Requires `full`. |
| `drop_index` *(write)* | **MongoDB only.** Drop one index by name. `_id_` is refused. Requires `full`. |

`list_connections` reports each connection's effective write policy so the
assistant knows up front what it may do.

Every tool also carries a **title** and MCP **annotations** — `readOnlyHint`
for the seventeen that only read, and `destructiveHint` / `idempotentHint` on
the eight that write (`insert_row` and `create_index` are marked additive
rather than destructive). Clients use these to decide how much friction a call
deserves, so a `list_tables` no longer looks as risky as a `delete_rows`.

Reading and writing are **two tools** — `run_query` and `run_write` — rather
than one that spans both. A client's permission rules key on the tool name, so
a single statement runner made "let the SELECTs through, ask me about the rest"
impossible to express, and forced the annotation to describe the more dangerous
of the two tiers. Split, both are honest constants that no policy change can
make stale: `run_query` is `readOnlyHint`, `run_write` is `destructiveHint`.
Each refuses the other's traffic and names the tool to use instead.

### Indexes: why the two write tools are MongoDB-only

On the SQL drivers an index is created with `CREATE INDEX`, which `run_write`
reaches at `full` and which is strictly more expressive than any portable form —
`USING gin`, `INCLUDE`, a partial predicate, an expression index. A tool would
have to flatten all of that into a fixed set of fields, and HuginnDB's own
SQL-side index vocabulary is deliberately narrow (name, columns, unique) because
it exists to be *diffed* by the structure editor, not to describe every index a
server can build. Exposing that as a tool would be a downgrade.

MongoDB is the opposite case: until 1.19.0 the mongosh grammar had no
`createIndex` at all, so the operation was not reachable *by any route*. Both
routes exist now — the two tools, and `db.coll.createIndex(...)` through
`run_query` — and they share one implementation.

There is no "edit an index" tool because MongoDB cannot alter one in place: a
replacement is `drop_index` then `create_index`, and leaving it as two calls
keeps the window where the index is missing visible to the caller. Hiding an
index (`collMod`) is reachable through `run_write` as
`db.coll.hideIndex("name")` — the reversible way to rehearse a drop.

### Pulse: how `pulse_metrics` reaches the sampler's history

`pulse_metrics` reads `pulse.db` — the SQLite file HuginnDB's own background
sampler writes a tick to every 60 seconds for each connection with Pulse's
history sampler turned on (Settings → Pulse). Reaching it needs no special
handling for either way this connector runs:

- **With the desktop app's bridge active**, this tool (like every other one)
  is served by the app, so it reads the app's own `pulse.db` handle directly.
- **In standalone sidecar mode**, the connector opens the *same* file at the
  same path — `pulse.db` lives next to `profiles.json` in the platform config
  dir, resolved identically by both processes — and only ever runs a `SELECT`
  against it. It never runs the sampler itself (that loop only starts inside
  the desktop app's own launch sequence), so there is no write path to guard
  against; SQLite's WAL journal mode, which this file always uses, already
  allows any number of concurrent readers alongside the app's one writer.

Either way, an empty reply means Pulse's sampler has never run for that
connection — turn it on in Settings, wait for a tick or two, and ask again.

## MongoDB: targeting a database on a multi-database connection

A MongoDB connection with no default database (`list_connections`'
`database: ""` — the URI has no `/dbname`) can't run any table-scoped tool
until it knows which database to use, since there's nothing equivalent to a
SQL catalog to fall back to. Pass the database name via:

- `schema` on `list_tables`, `describe_table`, `list_indexes`,
  `browse_table`, `save_view` and `drop_view`.
- `database` on `run_query` / `run_write` (their bare `sql` has no field for this).

The server resolves this the same way the desktop app's schema explorer does
when you expand a database — reusing the same MongoDB client and re-tagging
it, no new connection or re-authentication — and caches it, so repeated calls
for the same database on the same connection are cheap. A single-database
connection (one with `/dbname` already in its URI) ignores these — they're
only needed when `list_connections` shows an empty `database`.

## Security

- **Writes gated per connection.** Every exposed connection has a write policy,
  set in **Settings → MCP** and saved in `profiles.json`:
  - **`read-only`** (default) — only reads succeed. `run_query` accepts
    `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` (SQL) or
    `find`/`aggregate`/`countDocuments`/`distinct` (MongoDB), classified with
    the same operation classifier the desktop query editor uses — not a
    plain-SQL keyword match, so mongosh reads aren't mistaken for writes. Every
    write tool is refused.
  - **`data`** — adds row-level DML: `INSERT`/`UPDATE`/`DELETE` through
    `run_write`, plus the `insert_row` / `update_cell` / `delete_rows` tools.
    No schema changes.
  - **`full`** — adds DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) through
    `run_write`, plus the `save_view` / `drop_view` / `create_index` /
    `drop_index` tools. On MongoDB this is also the tier for
    `createIndex`/`dropIndex`/`hideIndex`, `drop()` and `renameCollection`
    through `run_write`.

  An index and a namespace are schema too, for the same reason and with the
  same consequence: `create_index` and `drop_index` sit at `full`, and so does
  every MongoDB statement that touches an index or a collection's existence.

  A view is schema, which puts managing one at `full` rather than `data`. That
  reads oddly for a second — dropping a *view* needs `full` while deleting
  *rows* only needs `data` — and it is the same asymmetry `DROP TABLE` and
  `DELETE FROM` already have. It is also the only consistent answer: the
  `CREATE OR REPLACE VIEW` you could write by hand through `run_write` is
  classified as DDL, so a `data` connection is refused it, and a tool that
  allowed the same change anyway would hand back what the policy just denied.
  `save_view`'s `preview: true` is a genuine exception rather than a loophole:
  it builds the statements and runs nothing, so it is classified as a read and
  works at any level.

  The policy is re-read from disk on **every write attempt**, so changing a
  connection's level in the app takes effect without restarting the AI client.
- **Approval stays with the client.** The connector is a headless process your
  MCP client spawns; it can't show a prompt. The per-action "allow this tool?"
  approval is the client's job (Claude Code / Desktop / Cursor all ask). The
  connector's role is *policy* (what's allowed) plus *audit*. The two gates are
  independent, and a write policy of `full` is a *ceiling*, not an instruction
  to the client — see [When the client blocks the call, not the
  connector](#when-the-client-blocks-the-call-not-the-connector).
- **Audit log.** Every write (success or failure) appends a line to
  `mcp-audit.log`, in the same config directory as `profiles.json`. Reads are
  not logged, so the file is a clean record of state-changing operations.
- **Whole-relation guard.** A `run_write` `UPDATE`/`DELETE` with no `WHERE`
  clause is refused outright, at any level — add an explicit predicate
  (`WHERE 1=1` if you truly mean every row). MongoDB is covered by the same
  guard: `updateMany({})` and `deleteMany({})` are refused, and the way to say
  you mean it is a predicate that is trivially true, e.g.
  `deleteMany({_id: {$exists: true}})`. `drop()` is not covered — it is
  unambiguous about its scope and already behind `full`, exactly like
  `DROP TABLE`.
- **Global kill-switch.** `--read-only` forces every connection to read-only
  regardless of its saved policy, and removes every write tool from the
  surface. It is the only thing that varies the tool list, because it is a
  process argument and so cannot go stale under a client that cached
  `tools/list` at startup.
- **Opt-in exposure.** Only connections ticked in Settings → MCP (or named by
  `--connections`) are reachable; a tool call for any other is refused, and a
  connection's *name* can only ever resolve to one that is already exposed.
  Exposure is re-read per call, so unticking one takes access away from a
  running client immediately. It is also strictly local: it is never changed by
  a shared-origin sync, and it is cleared on profile import, so neither a
  publisher nor a file you imported can expose a database on your machine.
- **No new plaintext.** Passwords are read from the OS keychain at connect time,
  exactly like the desktop app. The connector never logs or persists them (the
  audit log records statements and row counts, never credentials).
- **Row cap.** `--max-rows` bounds every result set.

### When the client blocks the call, not the connector

A write can be refused by *either* gate, and they answer to different owners.
The symptom that trips people up: a connection set to `full` in Settings → MCP,
and the AI assistant still reports it can't run a `CREATE`/`ALTER`/`DROP`.

Telling them apart takes a second:

| | Refused by the connector | Blocked by the client |
| --- | --- | --- |
| What you see | A tool *result* naming the level: *"connection … has MCP write policy "read-only", which does not permit this operation (needs at least "full")"* | The client's own denial. In Claude Code's auto mode the reason is usually the fixed text `Blocked by classifier` |
| `mcp-audit.log` | A line was appended (refusals are logged too) | **Nothing** — the call never reached the connector |
| Who changes it | You, in HuginnDB → Settings → MCP | Whoever runs the AI client, in *their* client config |

Claude Code specifically: in [auto mode](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)
a second model — the classifier — reviews each action instead of prompting the
user, and MCP tool calls go through it. Its default block list includes
*"production deploys and migrations"* and *"modifying shared infrastructure"*,
and until you name concrete targets it treats any host or namespace whose name
carries `prod` as a sensitive remote target. Schema DDL against a live database
server reads as exactly that, whatever HuginnDB's own policy says — and the
classifier has no way to know the server is a disposable test instance unless
someone tells it.

The fixes all live on the client side, and all of them are the human's call to
make — the connector cannot and should not try to influence them:

- **One-off:** open `/permissions` → **Recently denied**, press `r` on the
  entry to retry it with a manual approval.
- **Be specific in the request.** Explicit user intent clears the classifier's
  soft blocks; a general one doesn't. *"tidy up the schema"* won't authorise a
  DDL, *"run this `ALTER TABLE` on the `sandbox` database"* does.
- **Pre-approve the tool** with an [allow
  rule](https://code.claude.com/docs/en/permissions#permission-rule-syntax) in
  `~/.claude/settings.json`, which resolves *before* the classifier runs. The
  server segment has to be literal — an unanchored glob is ignored:

  ```json
  {
    "permissions": {
      "allow": ["mcp__huginndb__run_query"]
    }
  }
  ```

- **Give the classifier context** about the database with
  [`autoMode`](https://code.claude.com/docs/en/auto-mode-config) entries (user
  or managed settings only — the classifier deliberately ignores a repo's
  `.claude/settings.json`). Keep `"$defaults"` or you replace the built-in
  rules wholesale:

  ```json
  {
    "autoMode": {
      "environment": ["$defaults", "Key internal services: the `sandbox` SQL Server instance at db-test.example.internal is a disposable test database, restored nightly from a fixture"],
      "allow": ["$defaults", "Schema changes on the `sandbox` database through the huginndb MCP connector are allowed: it holds no production data"]
    }
  }
  ```

- **Or leave auto mode** (Shift+Tab → Manual) and approve each call yourself.

None of this loosens the connector: its own policy is re-read from disk on
every write attempt and applies *after* the client has approved the call, so a
connection left at `read-only` stays read-only no matter how permissive the
client's config is. That asymmetry is the point — the client gates *this
assistant on this machine*, the write policy gates *the database*.

## Supported drivers

PostgreSQL, MySQL, SQLite, MongoDB, and Microsoft SQL Server — the same
drivers as the desktop app, via the same backend code.

The read tools work identically across all of them, and so do the row-level
write tools (`insert_row`, `update_cell`, `delete_rows`).

The one gap is `save_view` on SQL Server, whose T-SQL view DDL builder is not
written yet — it returns an "unsupported driver" error there. Everything else
about views works on all five: `describe_table` reports a view's definition on
every driver, and `drop_view` works on every driver.

`create_index` and `drop_index` are MongoDB-only and return an "unsupported
driver" error elsewhere; `list_indexes` reads on all five. See [Indexes: why the
two write tools are MongoDB-only](#indexes-why-the-two-write-tools-are-mongodb-only).

There is no tool for editing a *table's* structure on any driver. That was
deferred deliberately (see
[`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md)): making an assistant
synthesise a whole column list, with types, nullability, defaults and keys, is
worse than having it emit `ALTER TABLE` through `run_write`, which `full`
allows. That argument is about the *size of the DTO*, which is why it did not
carry over to indexes on MongoDB: an index spec is a key document plus a handful
of flags, closer in shape to `save_view` than to a table.
