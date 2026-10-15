---
id: 68
type: adr
status: accepted
date: 2026-09-09
tags: [mongodb, schema-tree, zustand]
triggered_by_external_trap: true
related: [64, 66]
supersedes: []
superseded_by: null
amends: []
---

# ADR #68: MongoDB's client is lazy, so `connect` could not fail — and the app announced success for a server that never answered

`Client::with_options` touches no network, and `mongo::open_pool` added no probe, so a broken MongoDB profile connected fine and failed ~8 s later inside the schema tree. `useSchema.refresh` records its failure on the slice instead of throwing, so `connectAndWarm` went on to raise `notify.success("Connected")`. The probe now runs at connect like the other four drivers', and the schema store reports its own failures.

**External trap behind it:** mongodb's Client::with_options performs no network round trip, so a client builds 'successfully' against an unreachable server; also mongodb::error::Error's Display drags a hex dump of the server reply.

**Decision:** mongo::open_pool pings at connect like the other drivers, and useSchema.refresh returns string|null and reports its own failures (opt-out via quiet), grouped per connection, with a 'failed' tree-match state that never dims or folds the row.

**Alternatives rejected:**

- Only a probe at connect: insufficient because later schema failures would stay silent.
- Only reporting from refresh: insufficient because connect still could not fail.
- Opt-in reporting at each call site: rejected in favour of opt-out at the seam.
- Setting initialized false on failure: rejected because the guard would re-fire forever.
- Unifying the Mongo error's display with its connection-limit classification: rejected; classification keeps scanning the full to_string().

## Detail

**The user-visible report was "MongoDB errors only show up in the schema tree".** The tree was the *symptom*; the app was actively claiming the opposite of what had happened.

- **MongoDB was the only one of five drivers whose `connect` could not fail.** `Client::with_options` parses, validates and spawns the driver's monitor tasks without a single round trip — the repo's own unit test builds a "connected" Mongo pool against `mongodb://127.0.0.1:1`, a port nothing can listen on, with the comment `"client construction is lazy"`. Meanwhile Postgres/MySQL/SQLite go through `db::pool::connect_probed` (ADR #66) and SQL Server does `pool.ping().await?` in `mssql::open_pool` under a comment naming this exact failure mode: *"instead of surfacing the error on first query"*. `connect_inner` has no ping of its own; `open_pool` is the only network-facing thing it does, and Mongo's returned before reaching any probe.
- **So the first real contact was `list_databases`, ~8 s later** (the `server_selection_timeout` set two lines above the construction), reached through `useSchema.refresh` — which is a *terminal* error consumer. It catches, writes `error: String(e)` and `initialized: true` onto the slice, and does **not** rethrow. That is deliberate and load-bearing: `refreshTree` fans out over a parent and every `::db::` child, and one unreachable child must not abort the rest.
- **The two facts compose into a lie.** `connectAndWarm` awaited `refresh` *inside* its `try`, so its `catch` — the only `notify.error` on that path — was unreachable for anything that failed after the pool opened, and it fell through to `notify.success("Connected")`. For MongoDB that was every broken connection. The only trace was a bare `<div className="text-xs text-destructive">{cs.error}</div>` in the tree, itself mounted only when the row is expanded *and* active, and folded away entirely when a filter is running. Three minutes later the keepalive would notice and raise the `connection-lost` card — the one correct notification in the flow, arriving 172 seconds late.
- **The fix is a probe at connect plus an observable `refresh`, and both halves are needed.** The probe alone leaves every *later* schema failure silent (a server that dies mid-session, a per-table read); the reporting alone leaves `connect` unable to fail, so the connection would still be listed as live. `mongo::open_pool` now calls the `schema::ping` that already existed — the same one `db::pool::smoke_test` has always run for "Test connection", which is the evidence that `admin.ping` is reachable wherever a profile works at all. And `refresh` returns `string | null` rather than throwing, so `refreshTree`'s tolerance survives while its callers stop being blind.
- **`quiet` is an opt-out at the seam, not an opt-in at the call sites.** The store reports its own failures (a `reportSchemaFailure` helper modelled on `environments.ts`'s `fail`), and the two callers that can do better pass `{ quiet: true }`: `connectAndWarm`, which names the profile and adds the wrong-driver hint, and `warmDatabases`, which reports one summary for a whole fan-out. Same shape as `DataGrid`'s `decorateCellSave(quiet)`, for the same reason — a rule spelled at every call site is a rule some call site will forget.
- **Grouped per connection, because a fan-out is the normal case.** `group: schema-load:<connectionId>` folds a forty-table expansion or a nineteen-database warm into one card with a counter. The anatomy stays `surfaceFor`'s decision alone (ADR #64); all the store passes is a message and a group.
- **A stale failure must not be reported.** All three catches already had `if (!current) return state` for the case where `drop(connectionId)` landed while the call was in flight — resurrecting a slice there is permanent damage, because it comes back `initialized: true` and no automatic path retries it. The report is skipped in exactly that case: the error describes a pool that no longer exists, and a card about it arrives after a disconnect the user asked for.
- **`AppError::Mongo` rendered a hex dump.** `mongodb::error::Error`'s `Display` is `"Kind: {kind}, labels: {labels:?}, source: {source:?}, server response: {server_response:?}"`, and `bson`'s `Debug for RawDocumentBuf` is `hex::encode` of its bytes — so any Mongo *command* error dragged an encoding of the whole server reply into a string the user reads, in a ~200 px tree row. The variant now renders `.0.kind` alone. **The classification still scans the full `to_string()`** for the connection-limit needles, where more text can only help; do not "unify" the two.
- **Two silent failures fell out of the same reading.** `MultiDbExplorer`'s per-database `error` renders inside its `effectiveExpanded` branch, so every context-menu action on a **collapsed** database node ("New query here", "New table", "Security", export, import, "New collection", "Refresh") wrote into a branch that was not mounted: the menu item did nothing and said nothing. A refused `DROP DATABASE` did the same, while its *success* path had notified since 1.21.3. And `warmDatabases` counted a database whose table list had failed as `loaded`, because `refresh` could not tell it otherwise — nineteen loaded, nineteen broken, reported as success — while discarding every non-limit error, so `skipped` was a number with no cause attached.
- **The tree's filter was the last place the failure could still vanish.**
  `SchemaSliceLike` — the four fields `treeMatches.ts` reads — had no `error`,
  so a failed slice (`initialized: true, tables: []`) was byte-for-byte an
  empty one and `rowMatchState` returned `none`: the row dimmed, showed a
  confident `0`, and `filterFoldsIgnoringOverride` folded it to a single line,
  taking the inline message off the screen. One level down, a child whose warm
  failed stopped being "cold", so it dropped out of what the warm button offers
  and was reported as an honest zero. The fix is a `failed` state ranked above
  `unloaded` (that one asks the user to look; this one says looking did not
  work) and below `matches` (a stale count is still a count — `refresh` does
  not wipe the tables it had, so the badge annotates with `+` rather than
  replacing a number), and the two places it is deliberately **absent** are the
  point: `filterFoldsIgnoringOverride` and the row's `dimmedByFilter`. A
  connection the server would not answer is the row the user most needs to see.
- **What deliberately did not change.** `initialized: true` on failure stays: the `!initialized && !loading` guard would otherwise re-fire forever, and the explicit refresh is the retry. The per-table inline retry row (`SchemaTableRow`) stays and is still the better affordance — the card is what makes the failure reachable when the node is collapsed, folded by a filter, or in a window nobody is looking at. And the connection-level red line stays as the explanation for an empty tree.
