# Connection & pool management — analysis and proposed architecture

Status: written against `1.12.1` (`3e1c0a1`) as an analysis. **P0, most of P1,
the P2 endpoint layer and the P3 bridge have since shipped** — see §5 for what landed and what
is still open, and the `Unreleased` section of `CHANGELOG.md` for the
user-facing summary. The findings below are kept as written so the reasoning
behind each change stays readable; §5 marks each one's current state.

Motivation: several users report `FATAL: sorry, too many connections already`
(Postgres) / `ER_CON_COUNT_ERROR` (MySQL) on servers they share with other
tooling — typically a JetBrains IDE data source *plus* an application backend
with its own HikariCP pool *plus* the `huginndb-mcp` sidecar under one or more
MCP clients *plus* the HuginnDB desktop app itself, all authenticating as the
same database user against the same endpoint.

The honest framing: HuginnDB is usually **not** the largest consumer in that
picture — a Spring backend's default Hikari pool is 10 connections and an
IntelliJ data source keeps a handful. But HuginnDB is currently the *least
predictable* consumer: its footprint is unbounded, invisible to the user, and
multiplied across processes it doesn't coordinate with. It is very often the
marginal straw, and it is the only one of those consumers we control.

This document maps what the engine does today, quantifies the worst case,
and proposes a target architecture.

---

## 1. How it works today

### 1.1 The pool

`src-tauri/src/db/pool.rs` is the only place a SQL pool is constructed:

```rust
const MAX_CONNECTIONS_SERVER: u32 = 5;   // pool.rs:26
const MAX_CONNECTIONS_SQLITE: u32 = 1;   // pool.rs:30
```

`open_pool` (`pool.rs:117`) builds `PgPoolOptions` / `MySqlPoolOptions` /
`SqlitePoolOptions` with **only** `max_connections` set. Nothing else is
configured, anywhere in the repo — verified by grep: there is no
`min_connections`, `idle_timeout`, `max_lifetime`, `acquire_timeout`,
`test_before_acquire` or `after_connect` call in the tree. Everything else is
whatever `sqlx` 0.8 defaults to (`min_connections` 0, `idle_timeout` 10 min,
`max_lifetime` 30 min, `acquire_timeout` 30 s, `test_before_acquire` true).

Those defaults are *reasonable*. The problem is that they are implicit,
undocumented, and — critically — that `max_connections` is a **per-pool**
number in a system that creates a lot of pools.

MongoDB (`src-tauri/src/db/mongo/mod.rs:43`) sets `server_selection_timeout`
and `app_name` and **nothing about pool size**. The `mongodb` 3.x default is
`maxPoolSize = 100` **per host**, so a three-node replica set is a ceiling of
300 application sockets plus the driver's own monitoring connections — a 20×
divergence from the SQL drivers' 5, entirely by omission.

### 1.2 The unit of accounting is a profile, not a server

`ActiveConnections` (`src-tauri/src/state.rs:302`) is
`HashMap<String, ActivePool>` keyed by **profile id**. Nothing in the backend
knows or asks "how many sockets do I currently hold against `host:port`".

Two consequences:

- Three saved profiles pointing at the same server (a very common setup: same
  host, different default database or different user) are three independent
  pools with three independent budgets of 5.
- `connect`'s idempotency guard (`commands/connection.rs:314`) dedupes by
  profile id only. It correctly prevents a second window from tearing down the
  first window's pool, but it cannot dedupe two *profiles* that resolve to the
  same endpoint.

### 1.3 Per-database child pools multiply the budget

For a multi-database connection (empty `database` field), every database the
user touches spawns a **whole extra pool**:

`open_database_view` (`commands/connection.rs:541`) clones the parent profile,
substitutes `database`, calls `open_pool` again — another `max_connections: 5`
— and registers it under `<parent>::db::<name>`. This is the mechanism that
lets every downstream command keep a single `connection_id` argument, which is
a good design; the cost is that pools scale with *databases browsed*, not with
*servers connected*.

MongoDB is exempt: `resolve_mongo_database_view` (`connection.rs:498`) clones
the parent's `Client` and only re-tags the target database. That is exactly the
right shape — the SQL drivers should converge on it as far as the wire protocol
allows (see §4).

**Child pools are never released.** The only removal paths are:

- `disconnect` (`connection.rs:436`), which sweeps `<id>::db::` children when
  the *parent* goes away;
- `drop_database` (`commands/schema.rs:237`), which closes exactly the one
  child whose database is being dropped.

There is no TTL, no LRU, no cap on how many children a parent may accumulate.
A child opened by a single search keystroke at 09:00 is still registered at
18:00.

### 1.4 Three call sites fan out across every database

1. **Cross-database search** — `SchemaExplorer.tsx:902-926`. Once the debounced
   needle reaches 2 characters and no database is "active", the effect loops
   over *every* visible database and fires `openDatabaseView` + `list_tables`
   **concurrently, unbounded**. On a server with 19 databases that is 19
   simultaneous connection attempts from a single keystroke. There is a
   dedupe-by-in-flight guard, but no concurrency limiter.
2. **Multi-database export** — `ExportDatabaseDialog.tsx:128` and `:192`. One
   `openTrackedDatabaseView` per checked database. Sequential (awaited in a
   `for`), so no burst, but each pool it opens is permanent.
3. **SQL import** — `ImportSqlDialog.tsx:77`, same shape.

The comment at `SchemaExplorer.tsx:886` records that the *eager* warm on
connect was removed for being slow. The search fan-out reintroduced the same
cost, on a trigger the user doesn't associate with opening connections.

### 1.5 The keepalive pins one backend per connection, forever

`keepalive.rs:38` pings every **180 s**. `sqlx`'s default `idle_timeout` is
**600 s**. Because the ping acquires a pooled connection, the heartbeat
guarantees that at least one physical connection per top-level pool is never
idle long enough to be reaped — for the entire life of the app.

With `reconnect_on_launch` enabled (`prefs.rs:112`) and six previously-active
connections, HuginnDB holds six backends permanently from the moment it boots,
before the user runs a single query.

The heartbeat exists for a real reason (NAT/LB idle drops, SSH channel
liveness, and detecting the drops it can't prevent). But it is applied
uniformly to every connection, including plain LAN Postgres connections that
never needed it.

### 1.6 Teardown is by `Drop`, not by an awaited close

`disconnect` is a **synchronous** command that removes the `ActivePool` from
the map and lets `Drop` do the rest. `sqlx` cannot perform a graceful
close from a `Drop` impl; the codebase already knows this — see the comment at
`commands/schema.rs:229-235`, where `drop_database` explicitly does
`p.close().await` because "`Pool::close().await` waits for those connections to
actually go away rather than relying on the lazy drop of the `ActivePool`".

That reasoning applies to every disconnect, not just the drop-database case.
It matters most in exactly the burst scenarios:

- **Environment switching** (`stores/session/environments.ts`, `switchTo`)
  disconnects every pool and then immediately reconnects the incoming
  environment's set. For a moment you can hold both.
- **Reconnect after a lost connection** (`ConnectionsTree.tsx:182`) does
  `disconnect` → `connect` back to back.
- **App exit**: there is no `RunEvent::ExitRequested` / window-close hook in
  `lib.rs` that closes pools. Process exit closes the sockets, so the server
  does reap them — but not gracefully, and not at all promptly when an SSH
  tunnel or a connection pooler sits in the middle.

### 1.7 The MCP sidecar is a second, uncoordinated client

`huginndb-mcp` is a **separate OS process** with its **own** `AppState` and its
**own** `ActiveConnections` map (`mcp/mod.rs:452`, `ensure_connected`). It:

- opens pools through the same `open_pool`, therefore with the same
  `max_connections: 5` per exposed profile;
- **never removes a pool** — grep confirms `connections.write()` in
  `mcp/mod.rs` only ever calls `insert`. Pools live as long as the process,
  and the process lives as long as the MCP client keeps it (days);
- cannot see the desktop app's pools, and the desktop app cannot see its.

One user running Claude Code *and* Claude Desktop against the same profile has
**two** sidecar processes, each with its own budget of 5, on top of the GUI's.
Nothing in the product surfaces this. `docs/MCP.md` documents the write policy
in detail and says nothing about connection cost.

The one mitigating factor: sidecar pools get `_keepalive: None`, so `sqlx`'s
10-minute `idle_timeout` does reap their physical connections down to
`min_connections: 0` between tool calls. The pool object survives and
re-expands on the next call, but an idle sidecar is not holding sockets. This
is the correct behaviour and should be preserved.

### 1.8 `too many connections` gets no special treatment

`AppError` has no classifier for it. The driver's raw string goes to a
`toast.error` (`lib/connection/connectFlow.ts:37`). Concretely:

- The user sees a message that names the *server's* limit and gives no hint
  that HuginnDB itself is holding 14 pools.
- Nothing throttles. The search fan-out at `SchemaExplorer.tsx:902` will re-fire
  every failed `openDatabaseView` on the next keystroke, hammering a server
  that is already refusing connections.
- There is no "close idle pools and retry" affordance because there is no
  concept of an idle pool.

### 1.9 No user-facing control or visibility

`prefs.rs` has ~30 preferences covering editor, grid and UI. **Not one is about
connections.** There is no per-profile override either — `ConnectionProfile`
(`state.rs:100`) carries `ssl`, `ssh_tunnel`, `visible_databases`,
`mcp_write`… but no pool sizing. A user who knows their shared staging box
tolerates three sessions has no way to say so.

There is also no way to *see* what is open. The Console logs connect/disconnect
events, but there is no live view of pools, their in-use/idle counts, or when
each was last used — even though `ActiveConnections` holds everything needed
and `sqlx` exposes `Pool::size()` / `Pool::num_idle()`.

### 1.10 Incidental: `pool_for` is duplicated seven times

`commands/{query,schema,dump,view,structure,bulk,mongo}.rs` each define a
private `fn pool_for(state, id)`. They are the natural single interception
point for last-used tracking, per-endpoint accounting and lazy re-open — and
right now there are seven of them to keep in sync.

---

## 2. Worst-case arithmetic

One developer, one Postgres server with 12 databases, default
`max_connections = 100` (minus `superuser_reserved_connections = 3`).

| Consumer | Connections |
| --- | --- |
| HuginnDB GUI — parent pool | up to 5 |
| HuginnDB GUI — 12 child pools after one cross-database search | up to 60 |
| `huginndb-mcp` under Claude Code | up to 5 per exposed profile |
| `huginndb-mcp` under Claude Desktop | up to 5 per exposed profile |
| IntelliJ data source | ~1–3 idle, more while querying |
| Their Spring backend (HikariCP default) | 10 |
| **Ceiling from HuginnDB alone** | **~70** |

The ceiling is rarely reached — `min_connections: 0` plus the 10-minute
`idle_timeout` means steady-state is far lower, typically 1 per pool plus
whatever is in flight. But the *burst* is real and is exactly what trips the
limit: a cross-database search opens 12 pools **concurrently**, each of which
establishes at least one connection immediately, on a server that already has
~15 sessions from the rest of the toolchain.

And once those 12 pools exist, they never go away.

MySQL's default `max_connections` is 151, so the same scenario is less acute
but not safe. MongoDB's server-side limit is high enough not to matter
directly; the 100-per-host client default matters for Atlas tier limits and
for connection-storm behaviour during replica-set failover.

---

## 3. Findings, ranked

| # | Finding | Severity | Where |
| --- | --- | --- | --- |
| F1 | Pools scale with databases browsed, not servers connected | **High** | `connection.rs:541` |
| F2 | Unbounded concurrent fan-out on cross-database search | **High** | `SchemaExplorer.tsx:902` |
| F3 | Child pools are never evicted (no TTL, no LRU, no cap) | **High** | `connection.rs:448` |
| F4 | MCP sidecar is a second uncoordinated budget, ×N clients | **High** | `mcp/mod.rs:452` |
| F5 | No per-endpoint accounting; per-profile budgets stack | **High** | `state.rs:302` |
| | *(fixed — `db/endpoint.rs`)* | | |
| F6 | MongoDB pool is unbounded (driver default 100/host) | **Medium** | `mongo/mod.rs:43` |
| F7 | Keepalive (180 s) defeats idle reaping (600 s) | **Medium** | `keepalive.rs:38` |
| F8 | `too many connections` is unclassified; retry paths re-fire | **Medium** | `connectFlow.ts:37` |
| | *(classified in P0; the signal itself was masked by `sqlx` until 1.21.x — see §4.6's amendment and ADR #66)* | | |
| F9 | Teardown relies on `Drop` instead of `close().await` | **Medium** | `connection.rs:436` |
| F10 | No preference, no per-profile override, no live visibility | **Medium** | `prefs.rs` |
| F11 | Export/import dialogs leave a permanent pool per database | **Low** | `ExportDatabaseDialog.tsx:128` |
| F12 | Seven copies of `pool_for` | **Low** | `commands/*.rs` |

---

## 4. Target architecture

The single reframing that makes everything else fall out:

> **The unit of resource accounting must be the server endpoint, not the
> connection profile.**

### 4.1 An `Endpoint` layer

Define an endpoint key derived from the profile:

```
(driver, resolved_host, port, username, ssl, tunnel_identity)
```

`tunnel_identity` is `None` for direct connections and
`(ssh_host, ssh_port, ssh_user)` otherwise — two profiles through the same
tunnel to the same server are the same endpoint; through different tunnels they
are not.

Every pool then belongs to an endpoint, and the endpoint owns the budget:

- **MySQL** — a connection is not bound to a database (`USE db`, or qualified
  identifiers). One pool per endpoint, full stop. The per-database child pools
  disappear entirely; `open_database_view` returns a handle that carries the
  target database and every query qualifies or issues `USE`. **This is the
  single biggest win available** and it removes F1/F3 for MySQL outright.
- **PostgreSQL** — a connection *is* bound to one database, so one pool per
  `(endpoint, database)` is unavoidable. But the endpoint holds a shared
  `tokio::Semaphore` of `max_total` permits that every one of its pools must
  acquire from before checking out a connection. Twelve databases then share
  one budget instead of owning twelve.
- **MongoDB** — already one client per endpoint (`resolve_mongo_database_view`
  does the right thing). Only needs an explicit `max_pool_size`.
- **SQLite** — per file, unchanged.

### 4.2 Lifecycle: idle pools are a cache, not a commitment

Add `last_used: AtomicInstant` to `ActivePool`, touched by a **single**
consolidated `pool_for` (F12 pays for itself here). A background reaper then:

- `close().await`s and removes any `::db::` child pool untouched for
  `child_pool_idle_ttl` (default 5 min);
- enforces a hard cap of live child pools per parent (default 8), LRU-evicted;
- never touches top-level pools, which stay until the user disconnects.

**Amendment (1.21.x): that last bullet needed a qualifier the moment P3
shipped.** "Stay until the user disconnects" assumes a user who opened the
connection and can therefore close it. A pool the MCP bridge opens on a
sidecar's behalf goes through the app's own `connect_inner`, so it landed here
as an ordinary top-level pool — but nobody opened it, no window lists it (the
frontend deliberately does not listen for `connection-opened`, so a window only
shows what it opened itself), and `release_idle_pools` skips top-level pools by
contract. Nothing in the product could release one: the same connection was
reaped in five minutes when the sidecar owned the pool and lived until the app
exited when the app did. `ActivePool::origin` is now the discriminator and
`connections.bridgeIdleTtlSecs` (defaulting to the sidecar's own TTL) the
schedule; the exemption still holds, unconditionally, for the pools a person
opened. See ADR #67.

Reopening a reaped child is one `open_pool` call and the schema cache in
`useSchema` is untouched, so the user cannot tell the difference.

### 4.3 One budget per machine, across processes

The GUI and every `huginndb-mcp` sidecar are separate processes competing for
the same server. Three levels of fix, in increasing order of effort:

1. **Declare a smaller footprint** (trivial). The sidecar gets
   `--max-connections N`, defaulting to **2**, not 5. A request/response AI
   connector does not need five concurrent sockets. Document the cost in
   `docs/MCP.md`.
2. **Idle shutdown** (small). The sidecar closes a pool after K minutes with no
   tool call. `sqlx` already reaps the physical connections; this removes the
   pool object too and makes the sidecar's steady-state footprint provably
   zero.
3. **Proxy to the running app** (the real fix). When the desktop app is up, the
   sidecar stops opening pools and forwards its data-path calls to it over a
   local IPC socket (Unix socket / named pipe, token-authenticated), falling
   back to direct pools when the app is not running. This makes the GUI the
   single owner of every connection on the machine: one budget, one place to
   see it, one place to cap it — and, as a bonus, MCP-driven writes become
   visible in the app's Console in real time instead of only in
   `mcp-audit.log`. This is a real project (socket, handshake, auth, fallback,
   Windows named-pipe path) and should be scoped on its own.

### 4.4 Policy is per-server, so it lives on the profile

Connection capacity is a fact about a server, and `ConnectionProfile` is where
server facts already live. Add:

```rust
/// Maximum simultaneous connections HuginnDB may hold against this
/// server, across every database view and every HuginnDB process.
/// `None` → the global preference.
#[serde(default)]
pub max_connections: Option<u32>,
```

This ships in `profiles.json`, so it exports/imports for free (`transfer.rs`),
syncs through shared origins, and — because the sidecar reads the same file —
applies to the MCP connector automatically with no extra plumbing. Note
gotcha #14: the field must be declared on both the Rust struct and
`src/types.ts` or serde drops it.

Global fallbacks in `prefs.rs` under a new `connections` section:
`max_per_endpoint` (default 5), `child_pool_idle_ttl_secs` (default 300),
`keepalive_secs` (default 180, `0` = off).

### 4.5 Make it visible

A "Connections" section in Settings (or a status-bar popover) listing every
live pool: endpoint, database, in-use / idle / max, last used, and which
process owns it once §4.3.3 lands. Plus a "Close idle pools" button.
`ActiveConnections` already holds everything; `Pool::size()` /
`Pool::num_idle()` supply the counts.

This is the difference between "HuginnDB broke my database" and "HuginnDB
showed me I had 14 pools open and let me close them".

### 4.6 Fail loudly and stop retrying

Classify the error in `AppError`:

| Driver | Signal |
| --- | --- |
| Postgres | `SQLSTATE 53300` (`too_many_connections`), `53400` |
| MySQL | error `1040` (`ER_CON_COUNT_ERROR`), `1203` |
| MongoDB | connection-pool / server-selection timeout |

On detection: a dedicated message that names HuginnDB's own footprint
("HuginnDB currently holds 14 pools against 3 servers"), a "close idle pools
and retry" action, and — importantly — a circuit breaker that makes the search
fan-out (F2) **stop** instead of re-firing on the next keystroke.

**Amendment (1.21.x): the table above is only sound if the signal reaching it is
the driver's own.** It was not, on the connect path. `sqlx`'s eager
`PoolOptions::connect` retries anything it deems transient — a refused connect,
and a database error whose `is_transient_in_connect_phase()` holds, which on
Postgres includes the very `53300` this table asks for — until
`acquire_timeout` and then returns `PoolTimedOut` with the cause discarded. Two
consequences, in opposite directions: an unreachable host was classified as a
connection limit (and therefore got the retry-stopping circuit breaker and the
"close idle pools" action, neither of which applies to it), and a genuinely full
Postgres was reported as *our* pool timing out rather than in the server's own
words. `db::pool::connect_probed` now proves the endpoint with one un-pooled
`Connection::connect` and builds the pool with `connect_lazy`, so the signal
this table classifies is the raw driver error and `PoolTimedOut` is an
acquire-time-only condition. See ADR #66.

The footprint clause is also omitted when the footprint is zero, which is the
state the first failing connect of a session is always in — quoting "0 connection
pool(s)" is how the misdiagnosis became persuasive.

---

## 5. Sequencing, and what has shipped

### P0 — ship independently, no refactor — **done**

| Change | Files | Kills |
| --- | --- | --- |
| Bound the search fan-out to 3 concurrent, draining as a queue | `SchemaExplorer.tsx` | F2 ✅ |
| Set `max_pool_size` on the Mongo client (same budget as SQL) | `mongo/mod.rs` | F6 ✅ |
| Sidecar `--max-connections`, default 2 + idle pool shutdown | `mcp/mod.rs` | F4 ✅ (single-budget still open) |
| Classify `too many connections`; circuit-break the fan-out | `error.rs`, `driver.ts`, `SchemaExplorer.tsx` | F8 ✅ |
| Smaller child pools: `max_connections: 2` for `::db::` children | `pool.rs`, `connection.rs` | F1 ✅ (partly) |
| Document the multi-process footprint | `docs/MCP.md` | ✅ |

The child-pool change alone takes the 12-database ceiling from 65 to 29; with
the per-connection view cap of 8 it lands at 21.

### P1 — bounded lifecycle — **mostly done**

- ✅ Idle child-pool reaper: TTL + per-parent LRU cap (`pool_reaper.rs`), plus a
  manual `release_idle_pools` for the recovery action (F3).
- ✅ `disconnect` is `async` and closes each pool with an awaited, timed-out
  `close()`; the same path is used by the child sweep (F9).
- ✅ Explicit `min_connections(0)` / `idle_timeout` / `max_lifetime` /
  `acquire_timeout` on every `PoolOptions`, via one shared `tuned()` helper so
  the four driver call sites cannot drift (§1.1).
- ✅ `connections` preferences, `ConnectionProfile.max_connections`, and the
  Settings → Connections panel with live pool counts (F10).
- ✅ Keepalive interval is a preference (`0` = off) and a tick is skipped when
  the user's own traffic already proved liveness (F7). Still holding one socket
  per open connection by design — see the preference's docs for the tradeoff.
- ⬜ Consolidate the seven `pool_for` into one (F12). Sidestepped rather than
  done: `last_used` is stamped inside `ActiveConnections::get`, which all seven
  already funnel through, so the tracking is correct without the refactor. The
  duplication itself is still there.
- ⬜ App-exit close hook. Process exit closes the sockets anyway; this only
  matters behind a pooler or tunnel.
- ⬜ Cap the export/import dialogs' per-database pools (F11). The reaper now
  bounds them after the fact, which is most of the value.

### P2 — the endpoint layer — **shipped, minus the MySQL collapse**

- ✅ Endpoint key + registry (`db/endpoint.rs`), and per-endpoint budgets
  (F5). `connections.maxConnections` changed meaning from "ceiling for one
  pool" to "total for one server", which is the whole point of the layer: every
  pool that will really open connections now reserves from its server's
  allowance and holds an RAII `EndpointGrant` that releases on `Drop`.
- ✅ Postgres (and MySQL, and Mongo) keep per-database pools but share the
  endpoint budget, as designed.
- ✅ Better than the original sketch: when a server's budget is spent,
  `open_database_view` **reclaims** from HuginnDB's own least-recently-used
  views *on that same endpoint* before giving up. Browsing a twelve-database
  server under a ten-connection budget therefore works — the view you haven't
  looked at in a while pays for the one you just clicked — instead of the
  twelfth click failing.
- ⬜ **MySQL: collapse per-database views into one endpoint pool** (F1's
  remainder). Deliberately deferred. A MySQL connection isn't database-bound,
  so one pool per server is expressible — but it means either `USE` on checkout
  (stateful, and hostile to a shared pool: any connection could be left
  pointing anywhere) or fully-qualifying `` `db`.`table` `` in every generated
  statement, which touches every SQL builder and still leaves user-typed SQL in
  the query editor needing a bound database. The endpoint budget already caps
  the *connections*, which was the actual complaint; what the collapse saves on
  top is pool *objects*. Not worth that blast radius without integration tests
  against a real MySQL server.

**Admission control, not checkout interception.** The reservation is taken when
a pool is opened, sized by that pool's ceiling — not per connection checkout.
Intercepting checkouts would mean wrapping every `execute`/`fetch` in the
command layer, hundreds of call sites each a chance to forget, and would still
not bound what a pool is *allowed* to grow to. Reserving up front is coarser (a
pool that never fills holds budget it isn't using) but gives a guarantee that is
easy to reason about and impossible to bypass: HuginnDB never has more than
`budget` connections' worth of pool capacity open against one server, however
many profiles or database views point at it. The slack is bounded by the same
things that bound everything else here — pools are small, and idle ones are
reaped.

### P3 — cross-process — **shipped**

- ✅ The sidecar proxies to the running app over local IPC (§4.3.3), with a
  direct fallback (`src-tauri/src/bridge/`). Opt-in
  (`connections.mcpBridge`, default off) because it opens a listener that
  fronts every saved database.
- Two design points worth recording, both departures from the sketch in §4.3.3:
  - **Loopback TCP + token, not a Unix socket.** A Unix socket gives peer
    credentials for free — on Linux and macOS. HuginnDB's primary platform is
    Windows, where the equivalent is a named pipe with an entirely different API
    that cannot be compiled or tested from a Unix box. Shipping the strong path
    only where it can be tested, and an untested `#[cfg(windows)]` branch on the
    platform most users are on, is the wrong trade for a project that has
    already been burnt twice by Windows-only build paths (ADRs #20, #21). The
    token file is `0600`, so another local user can reach the port but cannot
    authenticate.
  - **The fallback rule is the load-bearing detail.** A transport failure falls
    back to a local pool; a failure *reported by the app* does not, because
    re-running a write whose reply was merely lost would double-apply it. What
    makes the fallback provably safe is the newline framing: the newline is a
    separate write from the payload, so any send error leaves an incomplete line
    the app can never parse into a request. If that framing changes, the
    reasoning goes with it.
- Both sides run the same executor (`bridge/exec.rs`) rather than two
  transcriptions of the same fifteen calls — drift there would only surface
  when the app happened not to be running.
  - **A third design point, learned the hard way in 1.21.x.** Routing
    `EnsureConnected` through the app's own `connect_inner` was right, and
    reusing it wholesale was not: the app's lifecycle rules for a top-level pool
    are written for a connection a person opened and can see, and none of that
    was true here. §4.2's amendment has the detail. The general shape is that
    "the app owns every connection on the machine" (§4.3.3's stated goal) needs
    to say *on whose behalf*, because that is what decides when the connection
    is released — and the answer must not be "when the app exits".

---

## 6. Explicitly rejected

- **Just raising `max_connections`.** The complaint is the opposite direction.
- **Dropping to `max_connections: 1`.** The batch runner
  (`query.rs:679`) holds one connection for a whole multi-statement batch to
  preserve session semantics; a background schema refresh during a long batch
  would deadlock on a single-connection pool. Two is the floor for a pool that
  can be used interactively.
- **Reference-counting profiles onto a shared pool without an endpoint key.**
  It looks like a shortcut to §4.1 but gets tunnels and differing credentials
  wrong. The endpoint key is the part that has to be right.
- **A connection pooler as a hard dependency** (pgbouncer et al.). Out of scope
  for a desktop client, though ROADMAP item 4 already tracks *tolerating* one
  correctly (transaction-mode poolers reject prepared statements, which `sqlx`
  assumes) — and a small per-endpoint budget is strictly better behaviour
  through a pooler too.

---

## 7. Open questions

1. **MySQL `USE` vs. qualified identifiers** for §4.1. `USE` is stateful and
   therefore hostile to a shared pool (any connection could be left pointing
   anywhere); fully-qualified `` `db`.`table` `` in every generated statement is
   safer but touches every SQL builder, and user-typed SQL in the query editor
   still needs a bound database. Likely answer: qualify what we generate, and
   `USE` on checkout for the query editor's own connection.
2. ~~**Does the endpoint key include the username?**~~ Resolved: **no**. The
   key is `(driver, host, port, tunnel)`. Since the layer meters budget rather
   than sharing pools, and a server's limit is global, two profiles connecting
   as different users must compete for the same allowance rather than each
   getting their own. (Two profiles behind *different SSH tunnels* naming the
   same `localhost:5432` are still separate endpoints — each tunnel resolves its
   remote relative to its own SSH host.)
3. **How aggressive should the child TTL be?** Five minutes is a guess. Worth
   instrumenting before picking.
4. **Should `visible_databases` gate pool creation, not just display?** Today
   it scopes the search fan-out but nothing stops another path from opening a
   view on a hidden database.
5. **Should a bridge session's connections be torn down when that sidecar
   detaches, rather than only on the idle TTL?** The honest hook exists:
   `bridge::server::serve_connection`'s request loop ends exactly when a
   sidecar's socket closes, kill or not. What it needs is a per-id refcount in
   `AppState`, because several sidecars can be attached at once and the first to
   go must not close a connection the others are using. Deferred in 1.21.x
   because `connections.bridgeIdleTtlSecs` already bounds the leak to a few
   minutes after last use, and because a cooperative `Disconnect` *request* is
   explicitly not the answer — MCP clients routinely `SIGKILL` their sidecars,
   so the message would not be sent on the path that matters.
