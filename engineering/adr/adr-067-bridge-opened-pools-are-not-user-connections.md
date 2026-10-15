---
id: 67
type: adr
status: accepted
date: 2026-09-08
tags: [mcp]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #67: a pool the MCP bridge opened is not a connection the user opened, and the reaper's exemption assumed it was

`pool_reaper` never closes a top-level pool, on the grounds that the user opened it explicitly and the UI shows it as connected. Neither clause is true of a pool `bridge::server` opens for a sidecar — no window even lists it — so nothing in the product could release one. `ActivePool::origin` is the discriminator; `connections.bridgeIdleTtlSecs` defaults to the sidecar's own TTL so the connection behaves the same whichever process holds the pool.

**Decision:** ActivePool carries a PoolOrigin (User by default, Bridge only on the bridge path); the reaper closes idle bridge-opened parents after connections.bridgeIdleTtlSecs, which defaults to the sidecar's MCP_IDLE_TTL, and a user connect adopts a bridge pool.

**Alternatives rejected:**

- Defaulting PoolOrigin to Bridge: rejected because the reaper could then close a connection a window shows as live.
- A BridgeRequest::Disconnect: rejected because MCP clients routinely SIGKILL their sidecars.
- A close_pool sweep at sidecar exit: rejected because in bridge mode the sidecar owns no pools.
- Re-reserving endpoint budget on adoption: rejected as needing a second endpoint transaction.
- An app-side hook when a sidecar's socket closes: deferred because it needs a per-id refcount.

## Detail

**Two correct decisions, made eighteen months apart, contradicted each other.** `docs/CONNECTION_POOLING_ANALYSIS.md` §4.2 established that child pools are a cache and top-level pools are a commitment: the reaper closes `::db::` children on a TTL and never touches a parent, because "closing one behind their back would be a lie". P3 then shipped the bridge, whose `EnsureConnected` routes into the app's own `commands::connection::connect_inner` — deliberately, so the endpoint reservation, the session-secret cache and the Console entry could not drift from a second implementation. The consequence nobody wrote down is that a connection an MCP client asked for arrived in `ActiveConnections` indistinguishable from one a person had opened, and inherited its immortality.

- **It was worse than "the user will not disconnect it": no user could.** The frontend does not listen for `connection-opened` — on purpose, so a new window does not adopt another window's live connections (issue #50, `src/lib/bridges/connection-sync-bridge.ts`). So a bridge-opened connection appears in no connection tree, in no window. `release_idle_pools`, the remedy the app offers on a limit error, skips top-level pools by contract. `pool_reaper` skipped it. Restarting the app was the only thing that released one.
- **And the same connection was ephemeral in the other mode.** With the bridge off, the sidecar opens the pool itself and `mcp::spawn_idle_pool_reaper` closes it after five minutes — it reaps top-level pools precisely because there is no UI there to lie to. Five minutes in one mode and forever in the other, for the same connection, from the same tool call, is the shape users reported: idle pools sometimes come back and sometimes do not.
- **The cost was not one socket.** `connect_inner` reserves `top_level_request(10, 2)` = five of a ten-slot endpoint budget, so two connector-driven connections to one server spent the whole allowance and the third was refused by our own accounting. It also attached a keepalive, which pings *more often* than `IDLE_TIMEOUT` reaps by design, so one physical socket per such pool stayed open indefinitely — `min_connections(0)` could never decay it.
- **`PoolOrigin::User` is the default, and that direction matters.** A call site that forgets to classify itself leaks a pool, which the user can recover from by quitting; the opposite default would have the reaper close a connection a window is showing as live, which it cannot recover from. Only the bridge path says `Bridge`, and only in one place. `ActivePool::bare` stays `User` because origin is *irrelevant* to both shapes it serves: a `::db::` child is reaped by the child sweep, which keys on the id, and the sidecar's own pools are reaped origin-blind by `idle_pools` — which stays origin-blind on purpose, since a headless process has no UI contract to honour.
- **Adoption is the case that would otherwise be a regression.** If a person connects to a profile the connector already had open, `adopt_from_bridge` flips the origin and hands back the pool and its `last_used` stamp so the caller can start the keepalive the bridge path skipped. Without that step the adopted connection would be the one connection in the app with no lost-connection detection. It keeps its smaller bridge-sized grant: re-reserving would need a second endpoint transaction, and throughput is a nuance where being reaped mid-session is not. The operation is idempotent, so an ordinary second `connect` still falls through to the reuse path.
- **The teardown is not a child's teardown.** A bridge-opened parent may have `::db::` views under it and owns the SSH tunnel they were dialled through, so `reap_bridge_parent` closes the children first — while that tunnel is still up, the ordering `disconnect` already observes — then the parent as `PoolOwnership::Owned`, then the cached session secrets, then emits `connection-closed`. That event is a no-op in every window today (`markDisconnected` is documented as one for a window that never had the connection active), and emitting it anyway is what keeps this correct the day a window does list these.
- **Two things that look like the real fix and are not.** A `BridgeRequest::Disconnect` would not run on the path that matters: MCP clients routinely `SIGKILL` their sidecars. A `close_pool` sweep at the sidecar's own exit, after `service.waiting()`, buys nothing: in bridge mode the sidecar owns zero pools, and in direct mode process exit already drops the sockets and its own reaper already handles the idle case. The honest hook is app-side — `bridge::server::serve_connection`'s request loop ends exactly when a sidecar's socket closes, kill or not — but it needs a per-id refcount because several sidecars can be attached at once. Deferred to §7 of the pooling analysis; the TTL already bounds the leak to minutes after last use.
- **The default is derived, not written down twice.** `connections.bridgeIdleTtlSecs` defaults to `db::pool::MCP_IDLE_TTL`, which is also what `mcp::POOL_IDLE_TTL` is now defined as. The two values diverging *was* this bug, so a test asserts they are still equal — the kind of invariant that is invisible until someone tunes one of them.

## Follow-up (2026-10-06): three more ways the same promise broke

- **The fallback never ran for the first call.** `ensure_connected` went through `Huginn::call`, whose fallback for an unreachable app is `bridge::exec::execute`, and that function refuses `EnsureConnected` by design. Every tool call starts with `ensure_connected`, so with the app gone every call failed with "ensure_connected must be handled by the caller". The bridge half now lives in `ensure_via_bridge`, which returns `None` on `Unreachable` so the local open runs.
- **The first call after an app restart failed.** A write to a socket whose peer has closed usually succeeds, so `BridgeClient::call`'s reconnect-on-failed-write never fired. The request was written into the dead connection and came back as `Remote`. `connection_is_stale` peeks the read side with a zero-length timeout before writing; in this protocol anything readable before a request is EOF, an error or a desync, and the client reconnects first.
- **A sidecar decided once, at startup.** `BridgeSlot` re-attempts attachment on use, at most every `ATTACH_RETRY` (30 s). On the machine this was found on, 12 of 13 live sidecars predated the running app. Tests that exercise the local path use `BridgeSlot::never()`, because a slot that is merely unattached would find a developer's running app.
- **Pulse made bridge pools permanent.** The sampler read pools through `pool_for`, which stamps `last_used`, every minute. It now uses `ActiveConnections::peek`, which does not stamp. Background readers must never stamp.
- **The sidecar's reaper now takes a parent's views with it, views first.** Reaping a Mongo parent alone shut its shared client down and left a dead view in the map.
- **Testing these needs no running app.** `bridge::client::test_support::fake_app` stands in for one. The tests that could reach a real app skip themselves when a discovery file is published; run them with `--features canary` (a config directory no running app publishes into) to execute them for real on a developer machine.

