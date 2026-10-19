---
id: 111
type: adr
status: accepted
date: 2026-10-19
tags: [ssh]
triggered_by_external_trap: false
related: [105, 110]
supersedes: []
superseded_by: null
amends: [105]
---

# ADR #111: a tunnel whose redial failed waits before dialling again, and fails every channel at once meanwhile

ADR #105 made a tunnel redial a dead session on the next channel, with no memory of how the last redial went. When the bastion was down or refusing, every channel dialled it: the heartbeat's retries and then one every 30 s, Pulse once a minute, MongoDB's monitor every 10 s (every 0.5 s while a query waited), every click. A connection queued behind a failing dial dialled again the moment it got the lock. Against a server that bans an address for repeated SSH logins, that stream kept the ban alive for as long as the connection stayed open in HuginnDB. A failed redial now earns a wait (5 s, doubling to 5 min), and until it runs out every channel fails immediately without touching the network.

**Decision:** `TunnelSession` carries a `Backoff` (consecutive failures, the instant a redial may next be tried, the last error), read and written only under the session mutex; a redial inside the wait returns an `AppError::Ssh` that names the server, the last error and the seconds left, a failed redial extends the wait (`REDIAL_BACKOFF_BASE` 5 s doubling to `REDIAL_BACKOFF_MAX` 300 s), and a successful one clears it.

**Alternatives rejected:**

- Rate-limiting the callers (heartbeat, Pulse, the Mongo monitor) instead — rejected because there are at least five of them, the Mongo monitor is the driver's own and not ours to pace, and a new caller would reintroduce the storm; the tunnel is the one place every attempt passes through.
- Giving up on the tunnel after N failures and requiring a manual Reconnect — rejected because the point of ADR #105 was recovery without a click; a capped wait still finds a bastion that comes back within five minutes.
- Applying the wait to the first dial (`open_tunnel`) too — rejected because that dial is a person pressing Connect, and an explicit action should always reach the server; a fresh connection gets a fresh `TunnelSession` and no inherited wait.

## Context

The review of Sergio's report on servers blocking SSH (a "5-6 connections per server" rule) found that HuginnDB's own retries could turn a temporary block into a permanent one. Nothing between the callers and `Dialer::dial` remembered a failure, so the rate of logins against a refusing bastion was the sum of every background reader's schedule, and the mutex only serialised them: a burst of N connections became N sequential dials.

## Detail

- **The check is under the lock, after the `Arc::ptr_eq` test.** Connections that queued behind a failing dial find the wait in force when they get the lock and fail at once; that is what turns N queued dials into one.
- **The session left in `current` is the retired one** (ADR #110), which reports `is_closed()`, so every later channel goes straight to the check without trying it.
- **The error says why and when:** the server, the last dial error (a refused login, a timeout) and the seconds until the next attempt, so the Console line explains the silence rather than repeating a driver error.
- **A refused or slow channel on a live session is not a redial** (ADR #110's `verdict`) and does not touch the wait.
- **Schedule:** 5, 10, 20, 40, 80, 160, then 300 s for as long as it fails. The exponent is capped so the arithmetic cannot overflow however long the server stays down.

## Consequences

- A bastion that refuses or has banned us sees about a dozen attempts in the first hour from one tunnel, then one every five minutes, instead of several a minute per open connection.
- Recovery after the bastion returns can take up to the current wait (at most five minutes) unless the person reconnects, which builds a new tunnel with no wait.
- **Tests:** `the_redial_wait_doubles_up_to_its_ceiling_and_a_success_clears_it` pins the schedule. `a_failed_redial_holds_off_the_next_ones_instead_of_one_per_connection` uses ADR #110's in-process bastion, now able to refuse logins and drop every session. One refused redial, then five simultaneous connections, must leave the bastion at two login attempts; one more after the wait; then a successful redial with one live session. Without the check, the burst reaches the bastion (seven attempts).
