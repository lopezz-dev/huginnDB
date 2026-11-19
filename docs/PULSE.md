# Pulse

HuginnDB can already tell you what's *in* a database. Pulse answers a
different question: how is the *server* doing right now, and how has it been
doing over the last few days? Live vital signs, the statements it has spent
the most time on, its biggest tables, who's connected, and which indexes
nobody reads — all in one place, without leaving the app.

Pulse works with **MySQL and MongoDB** today. Opening it against Postgres,
SQLite or SQL Server shows an explicit "not supported yet" state rather than
a wall of zeroes — the other drivers simply don't expose the statistics Pulse
needs.

## Opening Pulse

Click the pulse icon in the right activity bar to dock the panel next to your
workspace — it follows whichever connection is selected, or click the pin to
lock it to one connection regardless of what you click on elsewhere.

The dock panel is deliberately compact: four sections (Status, Alerts, Time
spent, Storage), each showing the top few rows and a **↗** button in the
header. Click it to open Pulse in a window of its own — wider, with the full
tables and two more views (Sessions, Indexes) that don't fit in a side panel.
That window measures one connection and closes independently of the main
one; nothing about it is saved as a tab.

## What each view shows

### Status

Queries per second, connection pressure, threads running and buffer-pool (or
WiredTiger cache) hit rate, each with a small live chart, plus the alerts
derived from them — approaching the connection ceiling, a low cache hit
rate, temp tables spilling to disk, refused connections. The live numbers
refresh every five seconds **only while the panel or window is on screen** —
switch away, collapse the dock, or minimise the app, and the polling stops
with it.

### Time spent

The statements the server has spent the most time on ("Consultas"): MySQL
reads this from `performance_schema`'s digest table; MongoDB from the
database profiler's `system.profile` collection — turn the profiler on for
this to show anything (the Status view's alerts say so when it's off). Each
row shows how many times a statement ran, its average and slowest duration,
rows examined vs. sent, and a red badge when it resolved without using any
index.

A row with a **Plan** button has a real, runnable example of that statement
kept alongside it — click it to see the plan the server would use, without
running the statement for real.

### Storage

The connection's biggest tables/collections, ranked, split into data,
indexes and free space — space a rebuild would hand back.

### Sessions

*Expanded window only.* Every session or operation currently open on the
server: MySQL's `SHOW FULL PROCESSLIST`, MongoDB's active or lock-waiting
operations. On MySQL, a session waiting on a lock shows which other session
it's blocked on. This is a live snapshot with its own refresh button, not
something that auto-updates — a five-second poll on a full session list
would cost more than it's worth.

### Indexes

*Expanded window only.* Every index across your biggest tables, ranked by
how often it's actually been read since the counters were last reset. An
index reading **unused** has seen zero reads — worth a look, never a
suggestion Pulse makes for you to drop it outright: "unused since the server
last restarted" is not the same claim as "safe to remove," and Pulse only
ever tells you the first one.

### History

*Expanded window only.* The same live numbers, but over the last 24 hours, 7
days or 30 days, so you can answer "was this slow yesterday too?" instead of
only "is it slow right now?" This view needs history to have actually been
recorded — see [Keeping history](#keeping-history).

## Enabling the required instrumentation

The Time spent view (and, on MySQL, the "blocked by" column in Sessions) reads
from server-side instrumentation that isn't always on by default. If a
connection shows the `performanceSchemaOff` / `profilerOff` alert in Status,
here's what to turn on.

### MySQL: `performance_schema`

Most modern installs ship with it on (default since 5.6.6), but some managed
providers and minimal images disable it. Check with:

```sql
SHOW VARIABLES LIKE 'performance_schema';
```

It's **not** settable at runtime — `SET GLOBAL performance_schema = ON` fails
outright — because MySQL allocates the instrumentation's memory at startup.
Turning it on means editing the server's config file and restarting:

```ini
[mysqld]
performance_schema = ON
```

Once it's on, the digest table Pulse reads
(`performance_schema.events_statements_summary_by_digest`) is fed by the
`statements_digest` consumer, which is enabled by default too. Confirm it —
or flip it back on if something disabled it — with:

```sql
SELECT * FROM performance_schema.setup_consumers WHERE NAME = 'statements_digest';
UPDATE performance_schema.setup_consumers SET ENABLED = 'YES', TIMED = 'YES'
  WHERE NAME = 'statements_digest';
```

Nothing further is needed for the Indexes view (`sys.schema_index_statistics`)
or the blocking-session lookup (`performance_schema.data_lock_waits`) — both
sit on top of the same schema and come alive as soon as it's on. Unlike
MongoDB's profiler below, `performance_schema` is designed to stay on
permanently; the overhead is low and MySQL enables it by default for exactly
that reason.

### MongoDB: the database profiler

Off by default, and **per database** — enabling it for one database never
starts profiling another, and a sharded cluster needs it set on each shard's
primary (`profile` doesn't run through `mongos`). Unlike `performance_schema`,
this one is not meant to be left at its most verbose setting: level 2 records
*every* operation, which is real overhead on a busy server. Level 1 (slow
operations only) is what Pulse expects to see in production:

```js
use myapp
db.setProfilingLevel(1, { slowms: 100 })
```

Tune `slowms` to whatever "slow" means on that server — lower it temporarily
while chasing a specific problem, then raise it back.

To survive a restart without re-typing that in a shell, set it in
`mongod.conf` instead — this becomes the default profiling level for every
database on that process:

```yaml
operationProfiling:
  mode: slowOp
  slowOpThresholdMs: 100
```

Check the current level any time with `db.getProfilingStatus()` (the same
`{ profile: -1 }` command Pulse's own health read uses). `system.profile` is a
capped collection, 1 MiB by default — enough headroom for what Pulse scans
(the newest 5,000 entries), but if a busy database is cycling through it
faster than you'd like, resize it before re-enabling profiling:

```js
db.setProfilingLevel(0)
db.system.profile.drop()
db.createCollection("system.profile", { capped: true, size: 4_000_000 })
db.setProfilingLevel(1, { slowms: 100 })
```

## Keeping history

Everything above the History view is live-only — close the window and it's
gone. To keep a record, turn on Pulse's history sampler for a connection in
**Settings → Pulse**: a tree of your connections, each with a toggle, next to
the sampler's own knobs (how often it samples, how long it keeps history, a
disk-size cap, and whether it keeps sampling while HuginnDB is minimised).

It's **off by default, per connection** — turning it on for one connection
never starts tracking another. Once on, HuginnDB reads that connection's
vital signs in the background (once a minute by default) and appends them to
a small local database, entirely separate from anything the connection
itself stores. History older than 48 hours is gradually thinned out to keep
the file small, and anything past the retention window is deleted outright.

## Asking an AI assistant

Everything Pulse shows is also available to an AI client connected through
HuginnDB's [MCP connector](MCP.md) — `pulse_health`, `pulse_metrics`,
`pulse_top_queries`, `pulse_explain`, `pulse_storage`, `pulse_sessions` and
`pulse_index_usage`. All seven are read-only: an assistant can ask "why is
this server slow" or "what happened to it last week" and get real numbers
back, but it can never change anything through them. See the connector's own
guide for how to connect a client in the first place.

One of them reaches further than the panel: `pulse_explain` also answers on
SQL Server, with the estimated plan summarised (see [MCP](MCP.md)), although
Pulse itself does not monitor SQL Server yet.
