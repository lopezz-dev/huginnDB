---
id: 45
type: convention
status: active
date: 2026-08-21
tags: [ui, react, schema-tree]
related: [27, 55]
supersedes: []
superseded_by: null
amends: []
---

# Convention #45: Three frontend seams that must keep their intentional divergence

`useListNavigation`'s `wrap` flag and `useUi`'s `LaunchView` `undefined`-vs-`null` distinction were extracted with their divergence on purpose — collapsing either for "consistency" is a regression, and per-feature debounce constants are kept separate for the same reason.



## Detail

**Three frontend seams whose whole point is a difference the shared code must preserve.** Each of these was extracted *with* its divergence, not despite it — collapsing any of them is a regression, so they are parameters:
    - **`useListNavigation(count, { wrap })`** — the command palette wraps (a long result list is a ring you spin through), the tab switcher clamps (its list is short enough to see whole, and wrapping past the end reads as a jump).
    - **`useUi`'s `LaunchView` helpers** (`currentLaunchView` / `applyLaunchView` / `clearLaunchView` / `emptyLaunchView`) — the three view filters are always read, written and cleared together, but `undefined` (no override) and `null` (override to "show all") must stay distinct inside `databaseVisibility`, which is what ADR #27 calls the whole point of the two layers. `emptyLaunchView` is the single source of the neutral values so the "clear" and the "fall back" paths cannot drift.
    - **`lib/schema/warmDatabases.ts` vs the explorer's prefetch** — this entry recorded a *deliberate* duplication, and 1.19.0 removed the thing it was defending. They shared `DB_VIEW_WARM_CONCURRENCY` and nothing else, on the grounds that one was a one-shot awaited walk over a fixed list while the other was a re-entrant effect re-deriving its queue every pass, so the tree filled in progressively and a keystroke changed what still got warmed. That second behaviour only ever earned its keep while *typing* was what triggered a warm — which is exactly what ADR #55 forbids now. There is one scheduler; `lib/schema/warmForSearch.ts` is the tree's entry point into it and deliberately adds no scheduling of its own (it walks connections sequentially, since five at once would be fifteen simultaneous pool opens — the burst the per-connection bound exists to prevent). Kept here as the worked example of a shared-with-a-difference seam whose difference expired: the note is more useful as a record of that than deleted.
    Same family: `useDebouncedPreview`'s 400 ms is shared by the structure and view editors, while `AggregationTab` keeps its own 500 ms — each of its previews runs the pipeline *prefix* per stage, so the work per fire is not comparable. And the two four-hourly polls in `lib/schedule.ts`'s callers stay two constants for the same reason.
