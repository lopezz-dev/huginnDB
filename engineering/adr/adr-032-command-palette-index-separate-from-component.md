---
id: 32
type: adr
status: accepted
date: 2026-08-13
tags: [ui, zustand]
triggered_by_external_trap: false
related: [1]
supersedes: []
superseded_by: null
amends: []
---

# ADR #32: The command palette's index lives in lib/; settings navigation is a string contract

`CommandPalette.tsx` is presentation-only; entries, mode prefixes and fuzzy scoring live in `lib/commandPalette/`. An entry's `id` doubles as its MRU key, and `SETTINGS_INDEX[].prefId` must exactly match the `PrefRow` prop it targets.

**Decision:** The palette's index (entries, mode prefixes, fuzzy scoring, settings registry) lives in src/lib/commandPalette/ with CommandPalette.tsx presentation-only, entry ids double as MRU keys, useCommands returns [] when closed, and settings navigation joins SETTINGS_INDEX[].prefId to PrefRow's prefId.

**Alternatives rejected:**

- Position-based entry ids: MRU key must describe what the entry is.
- Indexing while the palette is closed: pure waste since it is mounted for the app's lifetime.
- Selecting a synthetic <parent>::db::<db> child id: undone a render later by App.tsx's sync effect.
- Automatic per-keystroke fan-out to warm all databases: replaced by an explicit bounded 'index all databases' entry.
- Remembering keepOpen Alt+Enter actions in the MRU: would slide rows under the cursor.

## Detail

**The command palette's *index* lives in `src/lib/commandPalette/`, never in the component — and "go to this setting" is a string contract between two files.** `CommandPalette.tsx` is presentation + keys only; `useCommands.tsx` builds the entries, `types.ts` owns the group order and the `>`/`@`/`#`/`?`/`:` mode prefixes, `fuzzy.ts` scores them, `settingsRegistry.ts` indexes the individual preferences. Things that will bite:
    - **A palette entry's `id` is the MRU key** (`stores/dialogs/commandPalette.ts` persists the last 12 to `localStorage`), so it must describe *what the entry is* (`table:<conn>:<schema>.<name>`), never its position in the list. A stale id — deleted connection, closed tab — is skipped when the list is rebuilt, which is why no pruning exists.
    - **`SETTINGS_INDEX[].prefId` must equal the `prefId` passed to that setting's `PrefRow`.** That string is the entire join: `useSettingsDialog.openAtPref(section, prefId)` opens the section, and the matching `PrefRow` scrolls itself into view and flashes. A typo degrades silently to "the section opens, nothing is highlighted" — there is no compile-time link. Adding a preference means touching both (and `ShortcutRow` already emits `keybinding.<ActionId>` for every entry in `ACTIONS`, so shortcuts come for free).
    - `PrefRow` consumes `highlightPrefId` immediately (`clearHighlight` on match, not after the timeout) so re-opening the same section later doesn't replay the flash, and `setSection` drops a pending highlight — the user navigated elsewhere.
    - **`useCommands(enabled)` returns `[]` when the palette is closed.** It is mounted for the app's whole life; indexing every table of every connected database on unrelated store changes would be pure waste. Keep new providers inside that gate, and keep reading raw store state (gotcha #1) — the memo derives, the selectors don't.
    - **Alt+Enter is a per-entry second action** (`PaletteCommand.alt`), and a `keepOpen` one is deliberately *not* remembered in the MRU: reordering the empty-query view mid-toggle would slide the row out from under the cursor.
    - **`useUi.selectedConnectionId` must always name a real profile — pass every cross-connection navigation through `parentConnectionId` (`lib/connectionLabel.ts`).** A tab or table of a multi-DB server carries the synthetic `<parent>::db::<db>` id, but `useConnections.active` only holds top-level ids (`markConnected` runs in `connect()`, never for `open_database_view`), and `App.tsx`'s sync effect clears any selection missing from that set — so selecting a child id is undone a render later and replaced by whichever pool came first. This bit the tab switcher silently before the palette ever existed.
    - **The table index is only as warm as the tree.** A server-wide connection's per-database tables live under child slices that exist only once a view is opened, so `@` also offers an explicit "index all databases" entry (`warmSchema.ts`) — bounded to 3 concurrent opens with a connection-limit circuit breaker, because each view is another pool. Never make this an automatic per-keystroke fan-out; that is exactly the bug the explorer's prefetch had to fix.
    - Three dialogs the palette needs were local `useState` in `FileMenu` and now live in `stores/dialogs/connectionDialog.ts`; `FileMenu` is still their only mount point. `TabbedArea`'s own `ConnectionDialog` is a separate, tab-scoped flow and intentionally stays local.
