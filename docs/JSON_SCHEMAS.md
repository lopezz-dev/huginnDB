# JSON Schemas

Attach a JSON Schema to a column and the cell editor starts helping: it completes
property names, suggests enum values, shows each property's description on hover,
and underlines values that do not fit.

This exists for a specific, common situation — a database used as a
**configuration store**. Columns of type `json`, `jsonb` or plain `TEXT` end up
holding documents hundreds of lines long that describe widgets, charts, dashboards
or feature flags. Those documents have a real contract; it is just written down
nowhere. Until now HuginnDB treated every one of them as anonymous JSON: syntax
highlighting, a valid/invalid badge, nothing more.

Two things to know before anything else:

- **Validation never blocks a save.** The database is the authority; a schema is
  an aid. If your schema turns out to be slightly wrong, you can still edit your
  own data.
- **Nothing is ever fetched from the network.** Schemas live on your machine, and
  a `$ref` pointing at a public registry is not downloaded. See
  [Limits](#what-this-is-not) for what that means in practice.

## The 30-second route

1. Open a cell holding a JSON document and click the expand button to get the
   Monaco editor (or use the docked side editor).
2. In the editor's header, next to the `valid JSON` chip, find the schema badge.
   With nothing attached it reads **no schema**.
3. Click it → **Create from this value**. HuginnDB drafts a schema from the
   document in front of you.
4. Give it a name and press **Create**. It is saved to your library and linked to
   this column in one step.

Type a `"` inside the document now and the property names from your own data are
offered. That is the whole feature working.

Refine the draft later in **Settings → JSON Schemas**.

## The library

A library entry is a name, an optional description, and the schema document
itself. Entries live in `json_schemas.json` in HuginnDB's configuration
directory.

The library is **global**. It is not part of an environment, and it is not synced
anywhere. That is deliberate: a binding says "this table's column looks like
this", which is a fact about the *server*, not about whether you are looking at
Production or Staging. If the library lived inside an environment, the same table
would have a schema in one environment and not in another.

The document is stored exactly as you typed it, character for character. That
means a half-written schema still saves — it simply does not apply until it parses
as JSON, and Settings flags it with a `⚠` until then.

## Linking a column

Three places can create a binding. They write to the same list; use whichever is
in front of you.

**The badge in the cell editor.** The one that matters. It works with every
driver, it tells you which schema is in effect, and its dropdown links any entry
in your library, drafts a new one from the current value, or unlinks. This is the
only surface available for MongoDB and SQL Server.

**Settings → JSON Schemas.** The canonical view: the library on one side, the
selected entry's document on the other, and the full list of bindings underneath
in the order they are resolved.

**The table structure editor.** A small `{}` button per column, behind a dashed
divider and tagged `local`. It saves the moment you pick something and is **never
part of the DDL** shown below it — a binding is editor metadata, not a schema
change, so pressing *Apply* neither includes it nor is needed for it. This tab
does not exist for MongoDB or SQL Server, which is why it is an extra rather than
the main route.

The expand button on an inline cell also changes: when the column has a schema, it
shows a `{}` icon and names the schema in its tooltip. Double-clicking a cell
still opens the same one-line inline editor it always has.

## The cascade

A binding names four things, and every one but the column may be left as
**any**:

| Axis | Meaning |
| --- | --- |
| Connection | One saved connection, or any |
| Schema / database | A Postgres schema, a MySQL or MongoDB database, `main` on SQLite, or any |
| Table | One table, a pattern, or any |
| Column | Required. One column, or a pattern |

When more than one binding matches a column, the **most specific one wins**.
Specificity is decided axis by axis, in this order of importance:

    column  >  table  >  schema/database  >  connection

and within each axis an exact name beats a pattern, which beats *any*.

That ordering is what makes the motivating case work. Suppose `configuration` is a
JSON column on a dozen tables, mostly with the same shape, but `widgets` is
different:

| # | Connection | Schema | Table | Column | Schema |
| --- | --- | --- | --- | --- | --- |
| 1 | `*` | `*` | `widgets` | `configuration` | widget-config |
| 2 | `*` | `*` | `*` | `configuration` | base-config |

Row 1 wins on `widgets`; row 2 covers everywhere else. One extra rule, not twelve.

Connection is the *least* important axis, which surprises people. It is meant for
telling apart two otherwise identical rules — "this same table and column, but
only on the production server". A blanket rule over a whole connection should not
beat a rule that names the exact table and column, and it does not.

If two bindings are equally specific, the one listed first in Settings wins. Drag
order is what breaks that tie.

### Patterns

Only `*` is special, and it matches any run of characters:

- `*_json` matches `payload_json` and `settings_json`
- `widget_*` matches `widget_layout`
- `*` on its own is the same as *any*

Matching **ignores case**, so you do not need to know how your engine folds
identifiers (Postgres lower-cases them, MySQL depends on the filesystem, MongoDB
distinguishes them).

A `.` is **not** special. That matters on MongoDB, where a nested field is
addressed by its dotted path, the same form `$set` takes: a binding on
`customData` applies to that field only, and `customData.*` is what reaches the
fields inside it.

### Why is my rule not applying?

Settings has a **Test a column** box. Type `schema.table.column` (or just a column
name) and it tells you which schema that resolves to, using the very same resolver
the editor uses — so the answer cannot disagree with what you see while editing.

The two usual causes:

- **The schema/database axis does not match what the tab calls it.** For MySQL and
  MongoDB that value is the *database*; for Postgres it is the schema; for SQLite
  it is usually `main`. When in doubt, leave it as *any*.
- **The document declares its own `$schema`.** See below.

## What the editor does with a schema

Three switches in Settings → JSON Schemas, split because the editor splits them —
a rough schema is useful for completion long before you want red underlines:

- **Validate against the attached schema** — the underlines. Turning it off leaves
  completion and hover working. It never gates a save either way.
- **Suggest keys and values** — property names and enum values as you type.
- **Show descriptions on hover** — reads each property's `description`.

Adding a `description` to your properties is the single highest-value thing you can
do to a schema here: it turns a 300-line configuration blob into something a
colleague can read.

## Limits of the drafted schema

"Create from this value" inspects the document and writes a permissive schema. It
is a starting point, and knowing its rules saves surprises:

- Every property seen becomes a property. Extra keys stay allowed unless you tick
  **Strict object**.
- `required` lists only the keys present in **every** sample. Anything else would
  produce a schema that rejects the rows it was drafted from.
- A whole number becomes `integer` until a fractional value appears, at which
  point it becomes `number`.
- A field that is sometimes `null` gets both types.
- A field that held both an object and a plain value becomes `anyOf`, and the
  dialog says which fields those were.
- An `enum` is only written when a value actually **repeated**. Three different
  values across three rows is a sample size, not a closed set.
- A `format` (`date`, `date-time`, `uuid`, `email`) is written only when at least
  two samples agree and all of them match.
- Arrays are sampled to 50 elements and nesting is cut off at 12 levels deep; the
  dialog says when either happened.
- A field seen only as `null` is typed `null` — usually worth editing by hand.

The result is deterministic: drafting twice from the same document gives you a
byte-identical schema, so regenerating produces a readable diff.

## Sharing

**Export / import a file.** File → *Export JSON Schemas* writes the entries you
pick, optionally with their bindings. There is no passphrase, because there is
nothing secret in a schema.

**Include them with an environment export.** The environment export dialog has an
opt-in switch. Schemas are global rather than owned by the environment, so this
packs the whole library alongside it — convenient for setting up a new machine
from a single file.

**Through a shared origin (1.19.0).** A shared origin pointed at an environment
export now syncs the schemas that file carries along with its connections, so one
file does keep a team's library up to date. The rules are the same ones the
connections follow: an entry is matched by **id**, not by name, so re-syncing the
same file every few hours refreshes it in place instead of accumulating
`cfg (2)`, `cfg (3)`, …; only entries the origin already owns are ever
overwritten, so a schema you wrote yourself is never touched, and one whose name
collides with yours steps aside rather than renaming yours; and nothing is
deleted — an entry that disappears from the file is reported, never removed, for
the same reason a vanished connection is.

If you are the one publishing, Settings → Shared origins → "Edit the document"
is where you choose which schemas and which bindings ride along; see
`docs/ENVIRONMENTS.md`.

**One caveat, in both directions.** A binding pinned to a *connection* references
that connection by an identifier local to the machine that created it. On import
elsewhere, such a binding arrives **switched off**, with its scope preserved so
you can see what it meant and point it at the right connection. It is not widened
to "any connection" (that would change what the rule means) and not dropped
silently. The import wizard tells you the count before it writes anything.

Bindings that are not pinned to a connection travel without any of this, which is
a good reason to leave that axis as *any* for schemas you intend to share.

## What this is not

- **Not a server-side constraint.** Nothing is written to the database. Validation
  is local, advisory, and never blocks a save.
- **Not an online schema registry.** A `$ref` to an `http://` or `https://` URL is
  never downloaded. Worse, one unresolvable reference stops the whole document
  being validated, so the schema appears to do nothing at all — Settings warns you
  about exactly this, and the fix is to inline the referenced part. References
  between two of your own library entries do work.
- **Not the MongoDB collection validator.** MongoDB's `$jsonSchema` is a
  server-side rule enforced on writes, and a different (BSON-flavoured) dialect. It
  is a separate feature, not yet implemented.
- **Not per-environment.** See [The library](#the-library).

One more behaviour worth knowing, because it is the likeliest surprise in the
configuration-store case: if the document itself contains a top-level `"$schema"`
key, that declaration **takes precedence over your binding**, and the editor says
so in the badge. If the URL it names happens to match one of your library entries,
everything works locally; otherwise nothing is validated, since the reference
cannot be resolved offline.

## Where things live

| What | Where |
| --- | --- |
| The library and its bindings | `json_schemas.json` in the configuration directory |
| The three behaviour switches | `prefs.json`, with the rest of the editor settings |
| The resolution rules | Implemented once, in the Rust backend — the interface never re-derives them |

Deleting a connection removes the bindings pinned to it, and says how many. The
schemas themselves are never touched: a connection identifier is never reused, so
such a binding could never match again, whereas a schema is something you wrote.

Deleting a schema removes the bindings that point at it, and tells you how many
before you confirm.
