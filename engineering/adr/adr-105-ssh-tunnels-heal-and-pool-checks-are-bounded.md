---
id: 105
type: adr
status: accepted
date: 2026-10-06
tags: [ssh, sqlx]
triggered_by_external_trap: true
related: [104]
supersedes: []
superseded_by: null
amends: []
---

# ADR #105: an SSH tunnel redials its own session, views ride their parent's tunnel, and every pool check is bounded

`russh` sends no keepalive by default, and a tunnel was a single session for its whole life. When a firewall dropped it, every connection through it failed until the user reconnected by hand. Tunnels now keep themselves alive and redial a dead session (`db::ssh::TunnelSession`). A per-database view rides its parent's tunnel (`TunnelRoute::Through`) instead of dialling a new one. sqlx's pre-checkout ping had no timeout, so a silently dropped socket cost 30 s and then surfaced as *too many connections*. It is now replaced by a check that gives up after 5 s (`db::pool::check_before_use`).

**External trap behind it:** russh sends no keepalive by default, so a firewall-dropped session goes unnoticed; sqlx's test_before_acquire ping has no timeout (a silently dropped socket costs 30 s and surfaces as 'too many connections'); sqlx 0.8 also pings unconditionally on release.

**Decision:** db::ssh::TunnelSession keeps alive and redials a dead session, per-database views ride the parent's tunnel (TunnelRoute::Through), and test_before_acquire is replaced by a 5 s-bounded before_acquire check (also added to MsSqlPool); the heartbeat retries and reports restoration.

**Alternatives rejected:**

- Skipping the pre-checkout check for recently used connections — tried with a 30 s window and rejected because it handed out dead connections after a tunnel drop.
- Dialing a new tunnel per database view — replaced by riding the parent's tunnel.
- Treating TCP nodelay as the latency fix — measured to make no difference; kept only as standard practice.

## Detail

### The tunnel

- `Dialer` holds what a dial needs: the tunnel config, the secret and the known-hosts store.
- `TunnelSession::channel` opens each `direct-tcpip` channel. It redials only a session that is gone:
  - `is_closed()` is true, or
  - the channel open did not answer within `CHANNEL_OPEN_TIMEOUT` (10 s). A TCP connection dropped without a FIN looks alive until the keepalive notices.
- A channel the server *refuses* on a live session is a real answer and is returned as-is. That covers a closed remote port or `AllowTcpForwarding no`.
- The redial happens under the session mutex, with an `Arc::ptr_eq` check, so a pool opening five connections at once dials once.
- Host-key verification runs on every dial, the redial included. A server that comes back with a different key is refused exactly as it would be on first connect.
- **Keepalive.** `SSH_KEEPALIVE_INTERVAL` is 30 s and `keepalive_max` is 3. Before this, only the database heartbeat (`crate::keepalive`, every 180 s, top-level pools only) kept the bastion connection warm, and view tunnels had nothing at all.
- **`nodelay`** is set on both the SSH socket and the accepted local socket. Measured on a ~26 ms tunnel, it made **no** difference. It stays as the standard choice for request/response traffic, not as a fix; do not cite it as one.

### Views ride the parent's tunnel

- `open_database_view_inner` passes `TunnelRoute::Through(parent_port)` whenever the parent has a tunnel up (`ActiveConnections::tunnel_port`). It falls back to `Dial` when the parent is not open.
- Measured: opening a view drops from ~0.8 s to ~0.3 s, with one SSH session to the bastion instead of one per database.
- **The cost is ordering.** A view now *depends* on its parent's tunnel, so every teardown path must close views before their parent. They already did: `close_connection`, `reap_bridge_parent` and `close_all_pools` (ADR #104) all do. Keep it that way.

### Pool checks

- `test_before_acquire` is replaced by `before_acquire(check_before_use)`, which still pings **every** checkout but bounds the ping at `STALE_CHECK_TIMEOUT` (5 s).
- An `Err` makes sqlx `close_hard` the connection and open another (`sqlx_core::pool::inner::check_idle_conn`). The timeout error is an `Io` error, so it can never be classified as a limit refusal.
- `MsSqlPool::acquire` had no check at all; it now has the same one.
- **Do not skip the check for recently used connections.**
  - It was tried, with a 30 s window, and measured behind a tunnel. It saved ~12 ms per query.
  - After the tunnel's session was killed, it handed out connections that had died with it, and the next two queries failed outright.
  - The always-check version recovers on the first query: ~0.7 s, the redial.
- **sqlx also pings on release, unconditionally.** `PoolConnection::return_to_pool` has no option to turn it off in 0.8, so a pooled query is about three round trips: check, query, release ping. Over a 26 ms tunnel that is ~90 ms per `SELECT 1` through the pool, against ~26 ms on a held connection. It is inherent to sqlx 0.8, not something this code adds.

### Heartbeat

- `crate::keepalive` retries twice (`RETRY_AFTER`: 5 s, 15 s) before emitting `connection-lost`.
- It no longer ends at the first loss: it rechecks every `LOST_RECHECK` (30 s) and emits `connection-restored` when the connection answers.
- The frontend bridge then clears the lost state and calls `notify.dismissGroup` to retire the card, whose Reconnect button is no longer true.
- Recovery is usually automatic, because the pool replaces dead sockets and the tunnel redials.

## Follow-up (2026-10-19): the dial itself is bounded

- **`russh` bounds no part of a dial.** `client::connect` waits on the TCP connect for as long as the operating system does (about 21 s on Windows against a host that drops packets), and on a server that accepts and never sends its banner it waits forever. Authentication has no bound either.
- **Under the redial that was worse than slow.** `TunnelSession::channel` redials while holding the session mutex. A dial that never ended parked every later channel behind it, and each of them, once the lock came free with the session still dead, dialled the bastion again in turn.
- **`Dialer::dial` is now `dial_unbounded` inside `SSH_DIAL_TIMEOUT` (15 s)**, which covers connect, key exchange, host-key check and authentication. A timeout is an `AppError::Ssh` naming the SSH server, so it reads as the tunnel failing rather than the database.
- **The bound is a ceiling, not a delay.** A refused connect still fails at once with its own error. Both cases have tests in `db::ssh::tests`; the silent-server one uses a local listener that accepts and never writes, and fails (30 s) with the bound removed.
- **Not `russh::client::Config::inactivity_timeout`.** It would also bound an idle *established* session, which the 30 s keepalive already supervises; the problem is only the dial.
