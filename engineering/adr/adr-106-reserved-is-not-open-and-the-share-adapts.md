---
id: 106
type: adr
status: accepted
date: 2026-10-07
tags: [mongodb, sqlx, docs-viewer]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #106: a reservation is not an open connection, and a server's budget is shared adaptively

`EndpointRegistry` accounts **ceilings**: each pool reserves what it *may* grow to when it opens, and the budget is enforced on the sum. That is the right thing to enforce, but it was also the only number the UI showed ("5 of 10 reserved"), and people read it as five connections the server could see. The per-server row now shows both numbers: **open** (what the server counts) and **reserved** (the ceilings). Every person-opened connection to a server used to reserve 5, so three profiles on one server under the default budget of 10 meant the third was refused by our own accounting while the server saw two or three sockets. The share is now adaptive: the first connection reserves 5, each later one half of what is left (never below 2), and idle views on that server are reclaimed before anything is refused.

**Decision:** The per-server row shows open (per-driver count) and reserved (ceilings) separately; top-level reservations are adaptive (5, then half of what is left, floor 2); reserve_top_level reclaims idle per-database views LRU before refusing; UI-to-docs links carry headings through i18n and are pinned by a test.

**Alternatives rejected:**

- Showing only the reserved number — rejected because users read it as connections the server sees.
- Reserving a fixed 5 per person-opened connection — replaced because the third profile on a server was refused by our own accounting.
- Dividing usage by the global preference — rejected as wrong for servers with a profile override.
- Counting a Mongo view's sockets — rejected because it shares the parent's client and would double-count.

## Detail

### Open is counted per driver
`DbPool::open_connections` returns `None` for SQLite, which has no server.

| Driver | Count |
| --- | --- |
| sqlx (Postgres, MySQL) | `Pool::size()` |
| SQL Server | `MsSqlPool::open_sessions`: checked-out permits plus the idle list, `try_lock` so a stats poll never waits |
| MongoDB | `MongoConn::sockets`, kept by a CMAP event handler (`ConnectionCreated` / `ConnectionClosed`) installed in `db::mongo::open_pool` |

- **MongoDB:** the driver has no public pool size. CMAP covers *pooled* connections only, so the driver's own server monitors (one or two per host) are not counted. The user docs say so.
- Verified against a real deployment: 1 open after the opening ping, 4 after a 73-collection listing at concurrency 4 (pool of 5), 0 after `shutdown`.

### Summing per server
`ActiveConnections::open_by_endpoint` sums only over pools that hold a grant.

- A Mongo view shares its parent's client and counter, and holds no grant. Counting it would count the parent's sockets twice.
- SQLite has no endpoint key.

### The budget column was wrong
`EndpointRegistry` now keeps a `Ledger { in_use, budget }` per key. `usage()` returns `EndpointUsageRow`s carrying the budget the latest reservation was made under.

- The panel used to divide by the global preference, which was wrong for every server with a profile override.
- Profiles on one server can carry different overrides, so "latest" is a choice. It is the limit that will apply to the next reservation, which makes it the honest one to show.

### The adaptive share
`top_level_request_for(origin, policy, in_use)`:

- **`User` with nothing reserved:** the old `top_level_request` (5 under the default budget).
- **`User` otherwise:** `(budget - in_use) / 2`, clamped to `[MIN_MAX_CONNECTIONS, TOP_LEVEL_REQUEST]`. Under a budget of 10 that is **5, 2, 2: three connections**, not two. (It is not four: the fourth finds 1 left, below the floor of 2.)
- **`Bridge`:** unchanged.

The split is decided at connect time because neither sqlx nor the MongoDB driver can shrink a pool once it is open.

### Reclaim before refusing
`reserve_top_level` is async. When the budget is spent, it closes our own idle per-database views on the same endpoint, least recently used first, and retries. This is the reclaim `open_database_view` already did for views.

- A view reopens by itself on next use, so it is the cheap thing to lose.
- It does not help MongoDB, whose views reserve nothing. That is why the adaptive share exists alongside it.

### Linking the UI to the docs
Settings → Connections links to `docs/CONNECTIONS*.md` § "Reserved and open connections".

- Doc slugs are per language, so the link carries the **heading** through i18n (`settings.connections.live.docHeading`), and `lib/appInfo/docs.ts::docLocation` resolves it against the body the viewer will show.
- `docLocation.test.ts` pins every such link in both languages. A heading renamed in only one place fails CI instead of quietly opening the doc's cover.
- Add new UI-to-docs links to that test's list.
