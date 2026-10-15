---
id: 108
type: adr
status: accepted
date: 2026-10-15
tags: [schema-tree, ui, react]
triggered_by_external_trap: false
related: [1, 27, 36, 55, 68]
supersedes: []
superseded_by: null
amends: []
---

# ADR #108: The schema tree is one flat, virtualised list, and its side effects follow the expanded structure, not mounted components

The Schema panel, from folders down to columns, is built by a pure `buildFlatTree()` into one array of rows and rendered by a single `@tanstack/react-virtual` virtualiser in `ConnectionsTree`. Only rows near the viewport are mounted, so a section with ten thousand tables costs what its visible thirty cost. Everything the old component tree did *because a component was mounted* — first reads, opening per-database views, size requests — is reported by `buildFlatTree` as `needs` and run by one effect, because in a virtualised list "mounted" means "near the viewport", which is the wrong condition for any of them.

**Decision:** Flatten the whole tree into rows with a pure function, render them through one virtualiser, move per-node state that must outlive a row (per-database view status, dialogs) into stores, and drive loads from the expanded structure rather than from mounts.

**Alternatives rejected:**

- Virtualise only the table list inside each section (one `useVirtualizer` per `TableSection` against the outer scroll element with `scrollMargin`) — smaller change, but N virtualisers measuring against one scroll container, each needing its own offset bookkeeping as everything above it expands and collapses, and every other level still mounted whole. It treats the symptom at the one level where it was first seen.
- Cap each section at N rows with a "show more" row — cheap, but it is a patch: the user has to page through a schema to find a table the filter does not reach, and it leaves the mount-per-row architecture in place for the next level that grows.
- Keep the component tree and only make rows cheaper (one shared context menu instead of one Radix `ContextMenu` per `TableRow`, hoisting the per-row store subscriptions) — still mounts ten thousand components; it halves a freeze rather than removing it.
- `content-visibility: auto` on the subtrees (what the tree had) — saves style, layout and paint for off-screen rows, but React still creates and reconciles every one of them, which is where the time went.

## Context

A SQL Server database with more than 10,000 tables froze the panel when the user expanded its tables section. Two costs were stacked: the backend listing waited for the per-table statistics before returning any name (fixed separately, by making every driver list names first and fold `get_table_stats` in afterwards), and the frontend mounted one `TableRow` per table — each with its own Radix context menu, `useTranslation`, `usePolicyLocker` and `useState` — the moment the section opened. The tree was a tree of components (`ConnectionTreeRow` → `SchemaExplorer` → `MultiDbExplorer` → `DatabaseRoot` → `SingleDbExplorer` → `TableSection` → `TableRow`), each mounting all of its children, so the only way to stop mounting rows nobody can see was to stop expressing the tree as nested components.

## Consequences

- **`lib/schema/flatTree.ts` owns every structural decision** the explorers used to make inline: which schema header a nested single-schema database suppresses, when a database auto-expands under a search, the bound-database node for drivers whose schema is not the database, the filter's forced expansion and "no matches" rows, the visible-databases note and the empty-server state. It is pure and covered by `flatTree.test.ts`; a change to how the tree looks starts there. Its table grouping is memoised per `(tables, patterns)` identity (gotcha #1), so the rebuild that follows any schema write regroups nothing.
- **Side effects come from `needs`, run by `useSchemaTreeNeeds`.** `useEnsureSchemaLoaded` in each explorer, `DatabaseRoot`'s open-view effect and the size requests are gone from the tree; the flattener reports which slices need a first read, which expanded databases need their view opened, which sizes to ask for and which view failures to forget. Every action is idempotent and guarded where it lives. This is also what still restores, after a restart, the tabs of a database view whose node was expanded but is scrolled far out of the window (`hydrateWorkspaceLayout` in `lib/dockview.ts`).
- **Per-node state that must outlive its row lives in stores**: `useDatabaseViews` (opening / open / error per `<parent>::db::<db>`, with an in-flight join, forgotten per parent in `markDisconnected` and per database on drop) and `useSchemaTreeDialogs` (rename, drop, empty, create database, database visibility — one host, `SchemaTreeDialogs`). State that only matters while the row is on screen (a context menu's open ring) stays local to the row.
- **Table actions are a pure function of `(connectionId, driver)`** (`tableActionsFor` in `lib/schema/tableActions.ts`), reading stores at call time, so one cached bundle per connection keeps `TableRow`'s `memo()` effective. Opening a table from a per-database view still marks that database as the active accent and folds its siblings outside a search (`activateDatabase`).
- **Keyboard movement between connection rows walks the row array, not the DOM** (`moveRowFocus` in `ConnectionsTree`), scrolling the target into the window before focusing it. Anything new that finds tree rows with `querySelectorAll` will only see the mounted ones.
- **Tree guides are drawn per row** by wrapping each row in as many `ml-3 border-l pl-0.5` containers as it had ancestor subtrees, and a column row draws its own `ml-8 border-l` segment; adjacent rows' borders meet, so the hairlines look as they did.
- **`ConnectionsTree` holds the one subscription to `useSchema.byConnection`** and passes it to `useTreeMatchCounts`, `useLoadingConnectionIds` and `buildFlatTree` (ADR #55's single-subscription rule, kept).
- Removed: `SchemaExplorer.tsx`, `SingleDbExplorer.tsx`, `MultiDbExplorer.tsx`. Their row-level pieces now live in `DatabaseRow.tsx`, `SchemaNodeRows.tsx`, `SchemaTableSection.tsx` (header only) and `SchemaTableRow.tsx` (table, column, column-error and column-loading rows); `FlatTreeRow.tsx` dispatches a row to its component.
- Cost accepted: a database row's context-menu dialogs (create collection, export, import) are still mounted by `DatabaseNodeMenu` inside the row. A modal blocks scrolling, so the row cannot scroll away under it, but a refresh that removes the row while one is open would take the dialog with it.
