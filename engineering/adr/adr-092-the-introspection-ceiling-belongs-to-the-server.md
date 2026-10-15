---
id: 92
type: adr
status: accepted
date: 2026-09-22
tags: [mssql, state-files, origins]
triggered_by_external_trap: false
related: [77]
supersedes: []
superseded_by: null
amends: []
---

# ADR #92: A timeout is a claim about someone else's server, so it cannot be a constant — and the function that applies it must know which connection it is bounding

`OPERATION_TIMEOUT` was a hard 20 s applied by a `with_timeout(what, fut)` that took no connection. On a SQL Server holding several hundred databases that turned a connection which opened in under a second into "the connection may be unresponsive", with nothing the user could do about it. The ceiling is now per profile over a global preference, and the default-taking wrapper was **deleted** rather than kept — a function that cannot see which server it is calling cannot choose the bound correctly.

**Decision:** The operation timeout is ConnectionProfile::operation_timeout_secs over ConnectionPrefs, resolved by operation_timeout (clamped, via parent connection id), synced by shared origins, and passed to the keepalive as a resolved Duration.

**Alternatives rejected:**

- A hard-coded OPERATION_TIMEOUT constant — rejected as asserting a fact about someone else's server.
- Keeping the default-taking `with_timeout(what, fut)` wrapper as a convenience — deleted because it leaves a correct-looking way to reintroduce the bug.
- Putting the timeout on the origin sync's preserve list — rejected because it describes the shared server, which the publisher knows.

## Detail

**The report.** A new user connected to a SQL Server quickly, expanded the tree, and got `list_databases took longer than 20s — the connection may be unresponsive`. The connection was fine. The server was large: `sys.databases` filtered by `HAS_DBACCESS(name)` evaluates a permission check per database, and the `pool.acquire()` inside the same bound can be opening a fresh `tiberius` session over a WAN before any of that starts.

- **Nothing in the query was the problem, which is what made the knob the right answer.** There is no index to add and no round trip to remove; the server takes as long as it takes. Twenty seconds was never measured against this server — it was measured against none, because it was a constant. The honest description is that HuginnDB was asserting a fact about somebody else's infrastructure.
- **The failure mode is worse than slowness, because the message points away from the cause.** "The connection may be unresponsive" sends the user to check the network, the credentials and the firewall for a connection that opened instantly. Per ADR #77 — text a person acts on has to name the action — the message now ends by naming the setting that fixes it, in the place they will look for it.
- **It lives on the profile, over a preference, exactly like `max_connections`.** Both answer the same shape of question about one server: how much of it we may use, and how long it is allowed to take. The placement buys three things without any extra plumbing — it exports and imports with the profile (`transfer.rs`), it syncs through shared origins, and the headless MCP sidecar honours it because it reads the same `profiles.json`. `operation_timeout(profile, preference)` is a deliberate twin of `endpoint_budget`, clamp included: a hand-edited `0` is raised to the floor rather than making every metadata call fail instantly, which is the one edit that would look exactly like the bug it is meant to fix.
- **And it is *not* on the origin sync's preserve list.** `merge_into` protects `mcp_write`, `mcp_exposed`, `pulse_enabled` and the `ai_*` pair because those are local decisions about trust or about this machine's resources, which a publisher cannot know. This one describes the shared server, which is precisely what the publisher *does* know — so a refresh is allowed to correct it, and a team does not rediscover the same number on every workstation. The preserve list is a list rather than a rule, and this is the case that shows why; there is a test asserting the value follows the file, sitting directly beneath the three asserting the others do not.
- **The default-taking wrapper is gone, not deprecated.** `with_timeout(what, fut)` would still compile and still be wrong at every call site that has a connection in scope — which, after the migration, is all of them. Keeping it as a convenience would leave a correct-looking way to reintroduce the bug. What remains is `with_timeout_secs(limit, …)` for a caller that has already resolved the limit, and `with_timeout_for(state, connection_id, …)` for one that has the id.
- **`connection_id` is not always a profile id.** A per-database view is the synthetic `<parent>::db::<name>`, which no profile is stored under, and those views are where most metadata calls actually happen. `connection_timeout` resolves through `state::parent_connection_id` first; without that, the setting would appear to work from the connection list and silently do nothing everywhere the user actually browses. An id matching no profile at all — an ad-hoc CLI connection — falls back to the clamped preference rather than to the raw constant.
- **The keepalive takes the resolved `Duration` as an argument**, because `keepalive::spawn` holds a pool and an id, not an `AppState`, and the caller is holding the profile at the one moment the connection is opened. This is not tidiness: a failed ping is *reported*, flagging the connection as lost in the UI, so a heartbeat still giving up at 20 s against a server the user told the app to wait 90 s for would mark a healthy connection dead — the original bug, moved into a background task where it is harder to attribute.
