---
id: 66
type: adr
status: accepted
date: 2026-09-08
tags: [sqlx, postgres, mysql]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #66: sqlx's eager `connect()` discards why it failed, so an unreachable host was reported as "too many connections"

`sqlx`'s pool retries what it deems transient until `acquire_timeout` and then returns `PoolTimedOut`, throwing the real error away — and HuginnDB classified that variant as a connection-limit refusal. `db::pool::connect_probed` therefore proves the endpoint with one un-pooled `Connection::connect` and builds the pool with `connect_lazy`, so `PoolTimedOut` now means exactly one thing: `acquire()` starving on a pool that already exists.

**External trap behind it:** sqlx's eager PoolOptions::connect_with retries what it deems transient (ConnectionRefused, Postgres 53300/57P03) until acquire_timeout and then returns PoolTimedOut, discarding the real error.

**Decision:** db::pool::connect_probed makes one un-pooled Connection::connect bounded by ACQUIRE_TIMEOUT and then builds the pool with connect_lazy, so the open path can never produce PoolTimedOut.

**Alternatives rejected:**

- Relying on acquire_timeout to make an eager connect fail fast: wrong, since sqlx retries transient errors until the deadline.
- Mapping PoolTimedOut differently per call site: rejected because both meanings would stay alive with a guess between them.
- Probe followed by an eager connect: rejected because it costs two handshakes.

## Detail

**The reported symptom was a lie the code told confidently.** A MySQL profile pointed at a closed port, a host behind a firewall that drops SYNs, or a dead SSH forward produced, thirty seconds later:

```
too many connections: HuginnDB's own connection pool timed out waiting for a free slot
— HuginnDB is currently holding 0 connection pool(s) and 0 per-database pool(s).
```

Every clause of that is wrong for the actual failure, and the frontend acted on it: `isTooManyConnections` (`src/lib/db/driver.ts`) matches the tag by substring, so the app offered "release idle pools and retry" — a remedy for a server that was not full — and `warmDatabases.ts` tripped the schema explorer's cross-database circuit breaker on a diagnosis that had nothing to do with capacity.

- **The masking is in `sqlx`, not in us.** `PoolOptions::connect_with` is eager: it builds the pool and then `acquire()`s one connection. `PoolInner::connect` loops, and retries with backoff anything it treats as transient — an `Error::Io` whose kind is `ConnectionRefused` ("an IO error while connecting is assumed to be the system starting up"), and an `Error::Database` whose `is_transient_in_connect_phase()` holds. When the acquire deadline passes it returns `Error::PoolTimedOut` and the cause is gone; it was only ever logged. So `.acquire_timeout(ACQUIRE_TIMEOUT)` does **not** make an eager connect "fail fast on an unreachable host", which is what `db::mssql`'s doc comment used to claim as its justification for hand-rolling a bound. That comment was this bug written down as a reason.
- **The classification it fed was defensible in isolation.** `error.rs` maps `PoolTimedOut` to `TooManyConnections` because on an established pool that is exactly right, and the sidecar — sizing pools as small as one — genuinely hits it. The bug is that one variant carried two unrelated meanings and only the call site knew which.
- **`is_transient_in_connect_phase` also breaks the arm that was supposed to catch the real thing.** On Postgres it returns true for `53300` (`too_many_connections`) and `57P03`, so a genuinely full Postgres was retried for thirty seconds and then reported as *our* pool timing out — the `53300` arm in `sqlx_connection_limit_detail` was effectively dead on the connect path. MySQL does not override the method, which is why `1040`/`1203` were the only limit refusals ever reported in the server's own words.
- **The fix is a raw probe, and `connect_lazy` is the load-bearing half.** `connect_probed::<DB>` makes one un-pooled `<DB::Connection as Connection>::connect(url)` bounded by `ACQUIRE_TIMEOUT`, closes it, and then hands back `tuned(...).connect_lazy(url)`. A single connection has no retry loop, so its error is whatever happened: refused stays refused (immediately, not after thirty seconds of backoff), a wrong password stays a wrong password, a real `53300` arrives as a `Database` error and is still classified as a limit refusal *with the server's message*, and only a silent host reaches the timeout. Using `connect_lazy` rather than a second eager `connect` is what makes this structural instead of a second classification: **after it, the open path cannot produce `PoolTimedOut` at all.** Mapping the variant differently per call site would have left both meanings alive and one guess between them. It also keeps the cost at one handshake, where probe-then-eager-connect would be two.
- **Nothing about this is a compile error.** Replacing `connect_probed` with `connect_lazy` alone, or "simplifying" it back to `.connect()`, restores the misdiagnosis silently — `PoolTimedOut` would start arriving at `error.rs` again from the open path and be dressed as a capacity problem. The enforcement is four tests in `db::pool`: a pending connect times out as `OperationTimedOut` and is **not** `is_too_many_connections()`; a `1040` string still is; a refused connect stays a `Database` error; and the wording names the endpoint and the bound. The bound is a parameter of `bounded_connect` purely so the timeout branch is testable in milliseconds — the same trick as `mssql::bound_by_acquire_timeout`.
- **`OperationTimedOut` was already the right variant** and its doc already said so ("no driver error was ever raised, the call simply never came back"). SQL Server, which has no pool and so no `acquire_timeout` to be misled by, had had to solve this first and had arrived at the honest wording; the sqlx drivers now emit that same sentence for the same condition instead of each inventing one.
- **`annotate_connection_limit` stops quoting an empty footprint.** "0 connection pool(s) and 0 per-database pool(s)" is what made the wrong diagnosis convincing, and it appears precisely when it is least useful: the pool that just failed is never in the map (insertion only happens on the success arm), so the first connect of a session always reports zero. The sentence exists to disclose HuginnDB's own share, so it is now omitted when there is no share to disclose; the hint about the machine's other occupants stays, because that one still explains a server we did not fill.
