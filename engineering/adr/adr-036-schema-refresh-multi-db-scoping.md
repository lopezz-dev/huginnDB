---
id: 36
type: adr
status: accepted
date: 2026-08-18
tags: [schema-tree, mysql]
triggered_by_external_trap: false
related: [32]
supersedes: []
superseded_by: null
amends: []
---

# ADR #36: Schema refresh must target the child slice, not the parent connection id

A server-wide connection's tables live under synthetic `<parent>::db::<db>` child slices, so `refreshTree` fans out to every opened child; refresh must also invalidate cached columns/indexes/errors, not just replace the databases/tables lists.

**Decision:** Callers holding a profile id refresh via refreshTree, which fans out to every opened <parent>::db::<db> child slice, and refresh invalidates cached columns/indexes/errors while re-loading still-expanded tables.

**Alternatives rejected:**

- refresh(parentId): re-fetches a list nobody renders, leaving the visible subtree stale.
- Replacing only databases/tables on refresh: cached columns stay permanent until disconnect.
- Spelling `::db::` out a second time: use databaseViewId/isDatabaseViewOf in lib/connectionLabel.ts.

## Detail

**`refresh` in `useSchema` means the whole schema, and on a multi-DB connection the id you hold is almost never the one to refresh.** Two independent traps, both fixed but easy to reintroduce:
    - **The tables of a server-wide connection live in the synthetic `<parent>::db::<db>` child slices, never in the parent's.** The parent's `list_tables` answers for the login's default database on Postgres and for *nothing* on MySQL (`SELECT DATABASE()` is NULL → `Ok(vec![])` by design — issue #52). So `refresh(parentId)` re-fetches a list nobody renders and leaves the visible subtree untouched — which is exactly why "Refresh" looked broken for a table created outside the app. **Anything holding a profile id (the connection row's menu, the command palette, the `refreshSchema` keybinding — `useUi.selectedConnectionId` can only ever be a profile id, ADR #32) must call `refreshTree`, which fans out to every child slice opened beneath it.** The Database node refreshes its own child explicitly via `resolveChildId`. `databaseViewId`/`isDatabaseViewOf` live in `lib/connectionLabel.ts` next to `parentConnectionId` — don't spell `::db::` out a second time.
    - **`refresh` must invalidate `columns`/`indexes`/`columnErrors`/`indexErrors`, not just replace `databases`/`tables`.** `TableRow` loads a table's columns only when the key is *absent* (`if (!cols && !colError)`, a deliberate guard so collapsing and re-expanding doesn't re-query), so anything left in those maps is permanent until `drop()` on disconnect: an `ALTER TABLE ADD COLUMN` performed outside the app was invisible forever. The wipe is paired with an immediate re-load of the tables whose node is still in `expanded`, captured *before* the wipe — without that, an open node comes back empty and nothing would ever fill it.
