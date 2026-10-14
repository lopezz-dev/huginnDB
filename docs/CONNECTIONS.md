# Connections

A **connection** is a saved profile: which driver, which host, which database,
which user. There is one global list of them, shared by every environment (see
[`ENVIRONMENTS.md`](ENVIRONMENTS.md) for how an environment picks a subset of it).

The profile itself is metadata and lives in `profiles.json`, inside your
platform's config directory. **The password never does.** It goes to the
operating system's keychain — Windows Credential Manager, or libsecret /
GNOME Keyring on Linux — and is read back at connect time. Nothing HuginnDB
writes to disk contains a password in plaintext.

## Creating one

**File → New connection…**, or `New connection` from the command palette
(`Ctrl+Shift+P`). The dialog adapts to the driver, because the five of them
don't need the same things:

| Driver | What it needs |
| --- | --- |
| PostgreSQL | Host, port, username, password. Database optional — see below. |
| MySQL / MariaDB | Same. |
| SQLite | Just the **database file path**. No host, no user, no password: the file *is* the database, and the filesystem's permissions are its access control. |
| MongoDB | The form builds the `mongodb://` URI live from host/port/database/user + **Auth source** + **Direct connection** (`directConnection=true`, for reaching one replica-set member on purpose — see [`MONGODB.md`](MONGODB.md)). **Edit connection string** unlocks the URI for the cases the form can't express: Atlas (`mongodb+srv://`), replica sets, extra URI options. |
| SQL Server | Host and port, plus **Instance name**, **Trust server certificate** and **Authentication** (SQL Server login, or Windows/NTLM on Windows only). See [`SQL_SERVER.md`](SQL_SERVER.md). |

**Name** and **Group** are display-only. A group is free text — type the same
label on several connections (a client, a site, a stage) and the list folds
them together. There is no group registry to maintain, and renaming one is a
matter of retyping the label.

When you edit an existing connection, leaving **Password** blank keeps the
stored one. Clearing a password means typing a new one, not blanking the field.

## Leave the database blank to get the whole server

For PostgreSQL, MySQL and SQL Server, an empty **Database** field is a
deliberate choice with its own behaviour: the explorer shows you the server's
databases and you open the ones you want. Each database you open gets its own
child pool, closed again when it has gone unused for a while.

Two consequences worth knowing:

- On PostgreSQL, connecting requires *some* database, so HuginnDB connects to
  the always-present `postgres` maintenance database and lists the rest from
  there.
- On MySQL, a session with no default database has no `DATABASE()`, so the
  top-level node itself lists no tables. That is expected, not a failure —
  the tables live under each database node.

Once a connection reaches more databases than you care about, narrow it with
the **Databases to show** picker in the connection's context menu. That filter can also be
set per environment, so a shared test server can show one client's database in
one environment and another's elsewhere without cloning the connection.

## SSL / TLS

The **SSL** checkbox is explicit in both directions. Unchecked means *no TLS*
(`sslmode=disable` on Postgres, TLS off on MySQL), not "try TLS and fall back":
a negotiation attempt against a server or connection pooler that doesn't speak
it fails outright with an unhelpful error, so an unchecked box has to mean
plaintext.

SQL Server encrypts by default and most on-premise instances present a
self-signed certificate, which is why it has its own **Trust server
certificate** switch instead of the shared SSL toggle.

## SSH tunnel

The **SSH tunnel** tab turns a connection into a tunnelled one: HuginnDB opens
a local listener, forwards it to `(host, port)` over an SSH `direct-tcpip`
channel, and points the driver at `127.0.0.1`. The database itself needs no
configuration for this.

- **Authentication** is a password or a private key file (with an optional
  passphrase). Either secret goes to the keychain, under an account namespaced
  apart from the database password so the two can never collide.
- **Local port** at `0` (Auto) lets the operating system pick a free port. If
  you pin a port and something else already holds it, HuginnDB falls back to an
  ephemeral one for that session rather than failing the connection — the saved
  profile is left alone.
- **SSH host verification** is *trust on first use* by default: an unknown host
  key is recorded, and a **changed** key is refused from then on. **Strict**
  requires a fingerprint you already trusted; **Accept any** skips the check
  and gives up MITM protection. Trusted fingerprints live in
  `known_hosts.json` and the dialog can forget one.
- Not available for SQLite (a local file has nothing to tunnel to) or for
  `mongodb+srv://` (an SRV record resolves to several replica-set hosts, and
  one tunnel can front only one of them — use a direct `mongodb://host:port`
  URI to tunnel MongoDB).

## Connection limits

**Settings → Connections** governs how many connections HuginnDB will hold —
and shows, at the top, how many are open right now. Worth remembering that
other clients on the same machine (an IDE's data sources, an application's own
pool, a `huginndb-mcp` sidecar) count against the *server's* limits too, even
though HuginnDB can't see them:

| Preference | What it bounds |
| --- | --- |
| Max connections per server | The **whole allowance** against one server, shared by every connection and database view that reaches it. |
| Max connections per database view | The ceiling for each per-database pool. These are the pools that multiply as you browse, so it is deliberately low. |
| Max open database views | How many database views one connection may keep at once; the longest-unused are closed past this. `0` means unlimited. |
| Close idle database views after | Seconds a database view may go untouched before its pool is closed. It reopens by itself next time you use it. `0` disables the reaping. |
| Keepalive interval | Seconds between liveness pings — see below. `0` turns the heartbeat off. |
| Operation timeout | Seconds a single schema read may take — listing databases and tables, describing a relation, the liveness ping. Never a query you run. |

Limits apply when a pool is *opened*; pools already open keep what they were
granted, so reconnect to apply a change immediately. And when a server's
allowance is spent, opening another connection or database view first closes
the database view you used least recently on that server, rather than failing.

### Reserved and open connections

Each server in **Settings → Connections** shows two numbers, for example
`2 open · 7 of 10 reserved`. They measure different things:

- **Open** is what the server itself counts: the connections HuginnDB actually
  holds against it right now. Pools open connections when a query needs one
  and close them after five idle minutes, so this number moves with what you
  are doing.
- **Reserved** is the most those connections are *allowed* to grow to. Every
  pool claims a ceiling from the server's allowance when it opens, and the
  allowance (the second number) is what keeps HuginnDB from ever exceeding the
  limit you set, however many connections and database views reach that server.

So `7 of 10 reserved` with `2 open` is normal: HuginnDB has promised itself up
to seven connections against that server, and is using two.

How the allowance is shared:

- The **first** connection to a server reserves 5, which leaves room for its
  database views.
- Each **further** connection to the same server — another profile pointing at
  the same host and port — reserves half of what is left, never fewer than 2.
  Under the default allowance of 10 that is 5, 2 and 2: three connections to
  one server instead of two.
- A **database view** (a database you expanded on a server-wide connection)
  reserves 2 of its own on SQL servers. MongoDB views share their connection's
  client and reserve nothing.
- A connection opened for the **MCP connector** reserves 2.

A pool's ceiling is fixed once it opens, which is why the split is decided at
connect time. If a server's allowance is spent, raise **Max connections per
server** (or the profile's own limit) and reconnect.

The MongoDB driver also keeps one or two monitoring connections per server
outside its pool. Those are not counted, so the server may see a couple more
than **open** shows.

A single server can also carry its own ceiling: **Max connections for this
server** in the connection dialog overrides the global preference for that
profile only. Connection capacity is a fact about a server rather than about
your session, which is why it is stored on the profile — it travels with it
into exports, into shared origins, and into the MCP connector.

**Operation timeout for this server** works the same way, and exists for the
same reason. A schema read is bounded so that a dead socket is reported rather
than leaving the tree spinning forever, but the bound is a guess about a server
we have never seen — and on a large one it is the wrong guess. A SQL Server
holding several hundred databases can take longer than the default just to list
them, and the failure then reads as a broken connection even though it opened in
under a second. Raise it on that connection and leave the rest alone. Blank
means "use the global preference".

It never bounds a query **you** run: that runtime is yours, and only metadata
reads the app issues on its own behalf are capped. Like the pool ceiling, it
travels with the profile — and unlike the MCP, Pulse and AI opt-ins, a shared
origin's refresh *does* update it, because how long a server takes to answer is
something the person publishing that server knows and you would otherwise have
to rediscover on every machine.

One more switch lives in the same section: **Share pools with the MCP
connector** lets a running `huginndb-mcp` sidecar borrow this app's connections
instead of opening its own, so the whole machine shares one allowance per
server. It opens a token-protected listener on localhost and is off by default
— see [`MCP.md`](MCP.md).

## Keepalive and lost connections

An idle connection can be dropped silently by a NAT gateway, a load balancer
or a corporate firewall. HuginnDB defends against that in layers:

- **A heartbeat** pings each top-level connection periodically
  (**Settings → Connections → Keepalive interval**; `0` disables it). That
  keeps the connection exercised and detects the drops it can't prevent.
- **Every connection is checked before a query uses it.** One that doesn't
  answer within five seconds is thrown away and replaced by a fresh one, so a
  query after a long pause gets a working connection instead of an error.
- **SSH tunnels keep themselves alive** with their own keepalive every 30
  seconds. If a tunnel's session dies anyway, it reconnects by itself the next
  time it is used, verifying the server's host key again.

When a ping does fail, it is retried twice before the connection is reported
lost, so a VPN reconnecting or a laptop waking up doesn't raise an alert. A
connection reported lost is marked in the connection list and the status bar,
with a one-click **Reconnect**. It is also still checked every 30 seconds, and
when it answers again — usually on its own, since dead connections are
replaced and tunnels reconnect — the warning goes away and you are told the
connection is back.

Per-database views are not pinged separately. They ride the same connection
— and the same SSH tunnel — as their parent, and reopen by themselves.

### Editing a connection that is open

Saving changes to a connection that is open does not close it: that would cut
a query that is running and drop grid edits you have not saved. When the
change is to *where* it connects — host, port, database, user, SSL, the SSH
tunnel or the connection string — the open session keeps using the old
settings, so the connection is marked in amber in the connection list and the
status bar, in every window, with the same one-click **Reconnect**. Renaming
it, moving it to another group or changing its MCP, Pulse or AI settings does
not need a reconnect and marks nothing. Pressing **Connect** in the connection
dialog after an edit reconnects it straight away.

## Opening a connection from the command line

| Flag | Meaning |
| --- | --- |
| `--connect-profile <name>` | Connect a saved profile by display name. |
| `--connect-profile-id <id>` | Same, by profile id — unambiguous when two profiles share a name. |
| `--host`, `--port`, `--database`, `--username` (`--user`) | Ad-hoc connection, no saved profile needed. |
| `--password` (`--pass`) | Optional. Overrides the stored password for a saved profile, or supplies one for an ad-hoc connection. |
| `--driver <name>` | `postgres`, `mysql`, `sqlite`, `mongodb`, `sqlserver` — plus the usual aliases (`postgresql`, `pg`, `mariadb`, `mssql`, `azuresql`, …). |
| `--connection-string` / `--uri` | Full URI. The primary path for MongoDB, and implies `--driver mongodb` when no driver is given. |
| `--auth-source` | MongoDB auth database, for the URI-less ad-hoc form. |
| `--name` | Display name for the ad-hoc connection. |

Both `--flag value` and `--flag=value` work, and the value is split on the
*first* `=` so a password containing one survives.

An ad-hoc connection is **ephemeral by construction**: it lives in memory so
the explorer and tabs treat it like any other connection, but it is filtered
out when profiles are saved, and a `--password` given this way is handed
straight to the connect call — it never reaches `profiles.json` or the
keychain. Close the app and it's gone.

Launching a second time doesn't open a second app: the arguments are forwarded
to the running instance, which connects in the window you already have.

## Export and import

**File → Export profiles…** writes a `.json` bundle from a checklist of
connections. **Include passwords (encrypted)** adds each secret — database
password and SSH secret alike — encrypted with AES-256-GCM under a key derived
from your passphrase (PBKDF2-HMAC-SHA256, 600 000 iterations). Each secret
carries its own salt and nonce, so one corrupted entry doesn't take the rest
of the file with it. The passphrase is not stored anywhere and cannot be
recovered.

**File → Import profiles…** reads one back. Conflicts are matched by profile
**id**, not by name — a connection renamed on either side is still the same
connection — and each one is resolved individually as **Overwrite**, **Skip**
or **Keep both**. A profile imported from a file exported *without* passwords
arrives without one, and the import summary says so: set it before connecting.

One caveat specific to MongoDB. The exported file carries every profile field
verbatim, `connection_string` included, and that string is **not** encrypted —
only keychain secrets are. A URI the form built for you doesn't embed the
password, so this is harmless; a URI you hand-edited to include `user:pass@`
would travel in cleartext. Strip the credentials from the URI before exporting,
or treat the file as a secret in its own right.

## Shared origins

**Settings → Origins** is the multi-person version of import: instead of
sending files around, one person curates an exported bundle on a path everyone
already mounts — a UNC share, a mapped drive, a synced folder — and everyone
else registers it as an **origin** and pulls from it.

- There is no protocol and no service. Reading an origin is a file read, and
  the share's own ACL is the access control. If the file is encrypted, its
  passphrase goes to your keychain (never to disk), and it travels
  out-of-band: whoever curates the share tells you.
- Be clear-eyed about what the encryption buys: read access to the share
  **plus** the passphrase yields every password in the file. The ACL is the
  real perimeter. See [`SECURITY.md`](../SECURITY.md).
- A connection pulled from an origin is **read-only in the app** — it is a copy
  of somebody else's entry, and editing it locally would be undone by the next
  sync. To vary one, duplicate it: the copy is an ordinary local connection.
  The one exception is the machine that publishes that origin: it can correct
  the connection in place (a wrong password, most often) and republish it from
  the origin document editor — no duplicate, same id.
- The registry is global — one registration per file, visible from every
  environment — and HuginnDB only ever *reads* an origin unless you explicitly
  mark it as one this machine publishes.
- When the curator stops publishing a connection you already pulled, it isn't
  deleted behind your back. It is flagged, and you decide: **Keep as mine**
  (it becomes a local, editable connection) or **Delete** (which also removes
  its stored password from your keychain).

### Choosing what to pull

A published file can carry three independent things: the **connections**, the
**environments** that group them, and the **JSON Schema** library with its
column bindings. You subscribe to each one separately, per origin, when you
register it and at any time afterwards under **Edit registration**.

That is the answer to the common split in a team: some people want the whole
configuration handed to them, and others already have their environments set up
the way they like and only want the servers. Both register *the same file* and
tick different boxes — which is the point, because the alternative is the
curator maintaining a second, connections-only copy that nothing keeps in step
with the first.

The form previews what the file actually holds before you choose, so a
subscription to "environments" isn't a guess about whether it publishes any. A
plain connection bundle offers only the first box, because that is all it can
ever contribute.

Two combinations are allowed but worth understanding, and the form says so:

- **Environments without connections** mirror with a membership list naming
  servers this machine does not have, so they look empty.
- **JSON Schemas without connections** land their bindings disabled, because a
  binding that names an unknown connection is disabled by design (see
  [`JSON_SCHEMAS.md`](JSON_SCHEMAS.md)).

**Unticking a box does not delete anything.** What a wider subscription already
brought in stays exactly where it is, still linked to the origin and still
read-only, and simply stops being refreshed. Releasing those into ordinary
local entries is a separate, deliberate step — one that cannot be undone, since
a connection you have detached is yours from then on and the origin will not
adopt it back.
