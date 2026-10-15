---
id: 38
type: adr
status: accepted
date: 2026-08-18
tags: [mongodb]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #38: MongoDB can rename a collection but genuinely cannot rename a view

`rename_table`'s Mongo arm uses the `admin`-database `renameCollection` run-command with `dropTarget` false, refuses views up front, and closes (rather than retitles) tabs on a cross-database move since the destination is a different connection id.

**External trap behind it:** MongoDB's renameCollection is an admin-database run-command on fully-qualified names that can move collections across databases, but a view cannot be renamed.

**Decision:** rename_table's Mongo arm uses the admin-database renameCollection run-command with dropTarget false, refuses views up front, is gated by supportsRenameTable, and closes tabs on a cross-database move.

**Alternatives rejected:**

- dropTarget true: would silently drop an existing target collection.
- Gating rename on supportsDdlEditing: rename needs no DDL builder.
- Retitling tabs on a cross-database move: the tab would keep querying the old database's connection id.

## Detail

**MongoDB *can* rename a collection; only a *view* genuinely can't.** `renameCollection` is an `admin`-database run-command taking fully-qualified `db.collection` on both sides, which is also why moving to another database is the same call (`db/mongo/schema.rs::rename_collection`, dispatched from `rename_table`'s Mongo arm). `dropTarget` stays `false` — a rename onto an existing collection must error, not silently drop it — and a view is refused before the round trip with a message telling the user to recreate it. The UI gate is `supportsRenameTable`, **not** `supportsDdlEditing`: rename needs no DDL builder, which is the whole reason MongoDB has it while structure editing stays read-only there. A cross-database move closes the collection's tabs instead of retitling them (`closeTabsForTable`) — the destination is behind a different `<parent>::db::<db>` connection id, so a retitled tab would keep querying the database the collection just left.
