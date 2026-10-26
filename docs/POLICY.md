# Managed policy

When an organization manages HuginnDB, an administrator writes **one policy**
that every installation reads. It says, per role, what the AI may reach and do
on each database: which databases and relations it can see, and whether it may
read, insert, update, delete or change schema — each granted separately.

This guide is for the administrator who deploys it. If you are a user and want
to know what applies to you, open **Settings → Policy**.

## What this version enforces — and what it does not

**For the AI, the policy is enforced, not advisory.** The model never holds a
database password: HuginnDB does, and every request an AI makes — through the
MCP connector (`huginndb-mcp`) or the in-app AI panel — passes through one
point where the policy is checked. If the policy refuses it, the AI cannot do
it. That holds whether the app is running or the connector is running alone.

**For people, the policy is applied by the app, as a guardrail.** Every
command the app runs against a database checks the person's `human`
permissions first: the explorer only lists what their role may see, a write
they may not make is refused, and free-form queries — the query editor, the
query panel's hand-written expression, a view's body, a MongoDB pipeline that
joins other collections — are refused under a rule that limits relations. It is
a guardrail and not a wall, and it is worth being plain about why: a person who
holds a database password can open another client and ignore HuginnDB
entirely. The way to make people's restrictions impossible to bypass is for
each person to connect with their **own database user** whose grants match the
policy; generating those grants from the policy is the next phase.

What a person sees: a table or database their role does not reach is not
listed at all, and an action it does not allow stays where it was, disabled,
with a lock and the reason — in a menu, under the item's label; on a button,
on hover. A tab whose whole purpose is not allowed (the query editor without
free-form queries, Security or Pulse without `monitor`) shows a locked page
instead. While the policy is loading or cannot be applied, a bar across the
window says so and links to Settings → Policy.

Where a role may write only some columns, the table's header shows a lock on
the columns it can neither change nor fill, a "new rows only" mark on the ones
a new row may still fill, and a line above the rows names the columns that can
be changed. A locked cell still opens, read-only, so its value can be read in
full; a new row leaves the locked columns to their default.

The policy only ever **narrows**. The per-connection settings users already
have — which connections are exposed to MCP, their MCP write level, whether the
AI panel is enabled — still apply. What the AI may do is the policy *and* those.

## Where the policy goes

HuginnDB looks in two places, in this order, and uses the first that has a
policy:

1. **Registry** (Windows): `HKLM\SOFTWARE\Policies\HuginnDB`
   - `Policy` (REG_SZ): the policy JSON itself, or
   - `PolicySource` (REG_SZ): a path to the policy file, usually on a share —
     `\\fileserver\it\huginndb-policy.json`.

   This is what Group Policy and Intune write.
2. **File**: `managed-policy.json` in the system policy folder:
   - Windows: `C:\Program Files\HuginnDB\`
   - Linux: `/etc/huginndb/`
   - macOS: `/Library/Application Support/HuginnDB/`

   It can hold the policy itself, or only a pointer to the shared one:

   ```json
   { "source": "\\\\fileserver\\it\\huginndb-policy.json" }
   ```

Both places need administrator rights to write, which is the point: a standard
user cannot remove or replace them. `HKCU` is **not** read, because it is
user-writable. Nothing is read from environment variables either.

**Protect the shared file.** If the policy lives on a share, only
administrators may write to it — otherwise the people it restricts can edit it.
HuginnDB does not sign the file; the share's permissions are the protection.

HuginnDB reads the policy at startup and again **every 5 minutes**, so a change
reaches running installations without a restart.

## If the policy cannot be read

It **blocks**. If an anchor exists but the file it points to cannot be read
(the share is down, the file was moved) or is not valid, every AI request is
refused, and a person can open the app and its settings but no connection reads
or writes — each refusal names the file and the error, and Settings → Policy
shows it in red. HuginnDB never falls back to "no policy", and it keeps no
local copy to fall back to.

While a policy on a share is being read for the first time, both are paused
the same way, usually for well under a second.

## The format

```json
{
  "version": 1,
  "defaultRole": "none",
  "users": {
    "ana": "sales",
    "pau": "production",
    "CORP\\scara": "admin"
  },
  "roles": {
    "none": {},
    "sales": {
      "rules": [{
        "endpoint": { "driver": "mysql", "host": "erp.corp.local", "port": 3306 },
        "databases": ["billing"],
        "relations": { "allow": ["invoices", "v_invoice_*"], "deny": ["v_invoice_cards"] },
        "human": ["select", "insert", "update"],
        "ai": ["select"]
      }]
    },
    "production": {
      "rules": [{
        "endpoint": { "host": "erp.corp.local" },
        "databases": ["prod_*"],
        "human": ["select", "insert", "update", "delete"],
        "ai": ["select", "insert"]
      }]
    },
    "admin": {
      "rules": [{
        "endpoint": "*",
        "human": ["select", "insert", "update", "delete", "ddl", "export", "monitor"],
        "ai": ["select", "monitor"]
      }]
    }
  },
  "unmanagedConnections": "deny"
}
```

Any field HuginnDB does not recognise — a typo such as `"relatons"` — makes the
whole policy invalid, and it blocks. A misspelled restriction is never read as
"no restriction".

### Users and roles

- A user is the **operating-system account** HuginnDB runs as, read from the OS
  itself. Names are compared ignoring case, with or without a `DOMAIN\` prefix.
  HuginnDB shows the account without the domain (`alopez` for
  `ITBACKING\alopez`), and either spelling in the policy matches it.
- **The policy assumes one domain.** Because the domain is dropped before
  comparing, `ITBACKING\alopez` and `CLIENT\alopez` are the same user to the
  policy and get the same role. That is fine for an organization with a single
  domain. If yours has several trusted domains with overlapping account names,
  do not deploy the policy until HuginnDB compares domains too: it does not
  yet. A local Windows account named like a domain one is not a way around
  it, because creating one needs administrator rights on the computer, and an
  administrator can already remove the policy.
- Each user has **exactly one role**. Listing the same account twice (for
  example `ana` and `CORP\ana`) is an error.
- Anyone not listed gets `defaultRole`. Make it the most restrictive role —
  here `none`, which reaches nothing.

### Rules

A role is a list of rules. Each rule says which server it is about and what it
allows there.

- **`endpoint`** — `"*"` for every server, or an object:
  - `host` (required), with optional `driver` (`postgres`, `mysql`,
    `sqlserver`, `mongodb`) and `port`. Hosts are compared ignoring case and
    surrounding spaces; no DNS lookup. A blank port in a user's connection
    counts as the driver's default.
  - `path` for a SQLite file (either slash, any case).

  Rules match the **server**, not the saved connection: a user who re-creates a
  connection by hand is still covered.
- **`databases`** — database names, `*` as wildcard. Omit it for every
  database on the server.
- **`relations`** — tables and views: `allow` (omit it for all) and `deny`
  (always wins). A pattern with a dot is matched against `schema.name`
  (`public.*`), one without against the name alone. On MySQL and MongoDB a
  relation's schema *is* its database, so `billing.invoices` works there too.
  Matching ignores case.
- **`human`** and **`ai`** — what the person and the AI may do:
  | Permission | Allows |
  |---|---|
  | `select` | reading rows, describing relations |
  | `insert`, `update`, `delete` | each row-level write, separately |
  | `ddl` | schema changes: create, alter, drop, truncate, indexes, views |
  | `monitor` | Pulse, server sessions, users and privileges — they show *other people's* statements, which can carry data this role cannot read |
  | `export` | writing a table's rows out to a file — needs `select` on it too |

  The AI never gets more than the person: whatever `ai` lists beyond `human` is
  ignored, and Settings → Policy shows a warning.
- **`columns`** — which columns `insert` may give a value to and `update` may
  change, on every relation the rule reaches: `"columns": { "insert": ["customer",
  "amount", "status"], "update": ["status", "notes"] }`. A verb left out of
  `columns` reaches every column; an empty list reaches none. Patterns work as
  for relations (`notes_*`, ignoring case). Reading is not limited: everyone who
  may read the table still sees every column. On MongoDB a column is a field
  and is judged by its top-level name — changing `address.zip` changes
  `address` — and a document's `_id` may always be given on insert. To give one
  table other columns than the rest, write a separate rule for it.

  Two rules on the same table add up: a column either of them allows is
  allowed, and a rule that does not limit a verb allows it on every column.
  The limit applies to the person and to their AI alike.
- **`dbUser`** — the database user a person signs in to this server as; see
  [Each person with their own database user](#each-person-with-their-own-database-user).

A statement that does two things needs both permissions: an upsert needs
`insert` and `update`, MySQL's `REPLACE` needs `insert` and `delete`.

### Free-form queries under a limited rule

If a rule limits **which databases or relations** can be seen (`databases`,
`relations.allow` or `relations.deny`), the AI **cannot run free-form queries**
on that connection — only the table tools (list, describe, browse, and the
row-level writes the rule allows). No tool can reliably tell from a query's text
every table it touches: views, functions, dynamic SQL and system catalogs such
as `INFORMATION_SCHEMA` or `master` would all be ways around the restriction.
A rule over a whole server keeps free-form queries, bounded by its permissions.

**Column limits close free-form writes, not reads.** Under a rule that limits
`columns.update`, a free-form `UPDATE` is refused for the same reason — a
statement's text does not reliably say which columns it writes (triggers,
views, dynamic SQL) — and likewise `INSERT` under `columns.insert`. Free-form
reads stay available unless the rule also limits databases or relations; then
the paragraph above applies.

Discovery is filtered too: the AI's list of databases and tables only contains
what the role can reach, so it does not learn the names of the rest.

**The `mongosh` terminal** (see `MONGODB.md`) is free-form text with every
verb: once it is open, any collection can be read and anything can be written
or dropped, and nothing typed into it can be checked against the policy. So it
is offered to a person only on a connection where their role allows free-form
queries with `select`, `insert`, `update`, `delete` and `ddl` — and HuginnDB
refuses to start it otherwise, whatever the interface shows. A plain shell in
the same panel carries no credential and is not affected.

### Connections the policy does not name

`unmanagedConnections` decides what happens on a connection no rule of the
user's role matches:

- `"deny"` (the default): the AI cannot use it. This is also what makes it
  pointless to reach a server under another name (an IP address instead of its
  hostname) to get around a rule.
- `"allow"`: the policy leaves it alone, and only the user's local settings
  apply.

### Downloading tools

`"allowToolDownloads": true` on a **role** lets the people in it have HuginnDB
download a tool for them — today, the `mongosh` the Terminal can fetch from
MongoDB's download site (see `MONGODB.md`). **It is off unless the role says
so**: a managed computer does not fetch and run an executable from the internet
just because nobody thought to forbid it. Without the permission the Terminal
shows no **Download mongosh** button and says why, HuginnDB refuses the request
whatever the interface shows, and a `mongosh` the person installed themselves
(or you deployed) is used as before. A policy that is still being read, or that
cannot be applied, blocks downloads too. Without any policy, downloading is on.

```json
"roles": { "analyst": { "allowToolDownloads": true, "rules": [ … ] } }
```

## Each person with their own database user

The app's policy is a guardrail for people, because the database password
itself opens any client. What closes that is giving **each person their own
database user**, with grants that match their role — then the database
enforces the policy, and the shared password never needs to reach anyone's
computer.

- **`dbUser`** on a rule fixes the user a person signs in to that server as.
  It is a template whose one token, `{user}`, is their Windows account without
  the domain and in lower case: `"dbUser": "{user}"` signs `ACME\ALopez` in as
  `alopez`; `"erp_{user}"` as `erp_alopez`. It applies to the whole server the
  rule names (its `databases` do not narrow it), and the first rule of the role
  for that server that has one wins. A person cannot change it: the connection
  dialog shows it with a lock.
- Without `dbUser`, a person can still choose their own user on a connection
  that comes from a shared origin (the dialog's **Your credentials**). It stays
  on their computer: it is never published, exported or synced.
- The first time a person connects with their own user, HuginnDB asks for its
  password and, if they tick it, remembers it in their keychain under that user.
- While a person signs in with their own user, the shared origin's password
  for that connection is **not** stored on their computer. To keep it off every
  computer, publish the connection without a password.

> **Update HuginnDB everywhere before you add `dbUser` or `columns`.** Versions
> that predate a field do not know it, treat the policy as invalid and block
> every connection until they are updated.

### Generating the grants

A database user per person only enforces the policy if its grants match the
role. **Settings → Policy → Generate grants** writes them: pick a role and a
server you are connected to with an administrator account, and HuginnDB builds
the script from the server's catalog —

- PostgreSQL, MySQL and SQL Server: a database role `huginn_<role>` with its
  `GRANT`s; MongoDB: a `createRole` with the actions on each collection.
- A rule over every relation of a database grants at the database or schema
  level, which also covers tables created later. A rule that names relations
  (or has a `deny`) is expanded into the tables that exist now — a `GRANT`
  takes no wildcards — so generate the script again after creating tables.
- A rule with `columns` grants per column, `GRANT UPDATE (status, notes) ON
  orders`, against the columns each table has now — so generate the script
  again after adding columns too. **SQL Server cannot limit `INSERT` by
  column** (its column permissions are `SELECT`, `UPDATE` and `REFERENCES`):
  the script grants `INSERT` on the whole table and says so, and
  `columns.insert` then holds only inside HuginnDB. To have SQL Server enforce
  it, grant `INSERT` on a view with just those columns instead. MongoDB has no
  field privileges at all, so there both limits hold only inside HuginnDB.
  PostgreSQL and MySQL enforce both.
- The people the policy gives the role are listed at the end, commented out,
  as they sign in (`dbUser`, or their account): check the names and uncomment.
- The script's notes say what the engine cannot hide: PostgreSQL shows every
  relation's name in `pg_catalog`; SQL Server lists every database unless
  `VIEW ANY DATABASE` is revoked from `public` (offered, commented); `export`
  has no database equivalent.

**HuginnDB never runs the script.** Copy it or save it, review it, and run it
yourself as an administrator.

## Editing the policy in HuginnDB

You do not have to write the JSON by hand. **Settings → Policy → Edit policy**
opens it as a form — roles and their rules, accounts, the default role — with
the JSON one pane away; both edit the same draft.

- **Who can save is decided by the share, not by HuginnDB.** The editor opens on
  any computer, and saves only where Windows lets that account write the
  policy's folder; everywhere else it is read-only and shows Windows' own
  reason. That is the same permission that already protects the file.
- **A draft that is not a valid policy cannot be saved.** Every change is
  checked by the same parser that applies the policy, and the error names the
  role and rule. A typo can no longer lock every computer out.
- **View as** shows what any account — and its AI — would get on each saved
  connection under the draft, before anything is saved, with the columns each
  limited verb may write.
- Under `insert` and `update`, **All columns / Only these** limits the verb to
  the columns picked from the rule's own tables. Each one is marked when it is
  required (no default, no NULL), set by the server, or missing from some of
  the tables. The editor warns, with a button that fixes it, when a required
  column is left out of `insert` — no row could be added — and when `delete`
  sits beside a limited `update`, since deleting a row and adding it back
  writes any column.
- A rule's server is picked from this computer's saved connections, and its
  databases and tables from that server's own list (the rule offers to connect
  to it). A pattern such as `v_factura_*` can also be added: the field shows
  which real names it matches first, and flags a name the server does not have.
  A server with no saved connection can still be given by hand.
- Saving keeps the previous version as `<file>.bak`, refuses to overwrite a
  change someone else saved in the meantime (your version goes to the
  clipboard), and applies on this computer at once — on the others within five
  minutes.
- **No policy yet?** *Create policy* starts from a template in which nobody
  unlisted gets anything and you keep full access, writes it where you choose,
  and gives you the `reg add` command and the Group Policy value that point the
  computers at it. A policy embedded in the registry or in Program Files can be
  moved to a file the same way, to be edited here from then on.

## Checking it

- **Settings → Policy** on any machine shows where the policy was read from,
  which account and role HuginnDB sees, and what each connection allows for the
  AI and for people.
- The MCP connector's audit log (`mcp-audit.log` in the user's config folder)
  records `user=` and `role=` on every write the AI makes.

## Limits, on the record

- A **local administrator** can edit the registry and the system folder, so
  this protects against standard users, not against the machine's owner.
  Redeploying the policy through Group Policy or your device management tool
  keeps it in place.
- The policy is read by versions of HuginnDB that support it. Keep the
  installed version under IT's control, as with any managed software.
- Server names are compared as written. A rule for `erp.corp.local` does not
  cover the same server reached as `10.0.0.5`; with `"deny"` for unmanaged
  connections, that alias is simply refused.
