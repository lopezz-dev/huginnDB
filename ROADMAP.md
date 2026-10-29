# HuginnDB roadmap

The single, current source of truth for "what's left." Historical per-version
planning docs (`1.4.0_ROADMAP.md`, `1.5.0_ROADMAP.md`) have been retired now
that their work has shipped — see `CHANGELOG.md` for the record of what each
release actually contained. Three living, detail-level roadmaps are still
maintained separately because they track a single subsystem in depth:

- [`docs/MONGODB_ROADMAP.md`](docs/MONGODB_ROADMAP.md) — MongoDB driver, done
  vs. deferred, with the technical hook for each deferred item.
- [`docs/MCP_CONNECTOR_ROADMAP.md`](docs/MCP_CONNECTOR_ROADMAP.md) — the
  `huginndb-mcp` connector's design rationale and phased build-out (now fully
  shipped, kept for the "why" behind its architecture).
- [`docs/POLICY_ROADMAP.md`](docs/POLICY_ROADMAP.md) — managed policy:
  per-role permissions for people and the AI, administered once for every
  installation (phase 1, the AI, shipped; people next).

This document covers everything else: the top-level feature roadmap that used
to live in the README.

## Shipped milestones

Not exhaustive — `CHANGELOG.md` is the authoritative, per-release record.
This is the "yes, that's actually done" list for the items that used to sit
in a roadmap and now don't:

| Item | Shipped | Notes |
| --- | --- | --- |
| SSH tunnel support | 0.7.0 | PostgreSQL/MySQL/MongoDB (single-host); see ADR #18 for the local-port fallback behaviour. |
| Table structure editor (visual `ALTER TABLE`) | 1.0.2 | `db/ddl.rs` + `StructureEditorTab.tsx`; see ADR #16. |
| Bulk row delete + multi-select in the data browser | 1.0.2 | Bulk **insert** is still open — see below. |
| MongoDB driver | 1.1.0, hardened through 1.8.0 | See `docs/MONGODB_ROADMAP.md` for the full done/deferred split. |
| Server-side users/privileges introspection | 1.4.0 | Every driver, including SQLite's explicit no-user-model empty state. |
| Native multi-window ("New window"), replacing workspaces | 1.4.0 | |
| Connection keepalive + lost-connection reconnect UX | 1.4.0 | |
| View editor (create/edit/rename/drop, live preview) | 1.10.0 | SQL drivers. MongoDB views go through the aggregation editor instead — see the next row. |
| MongoDB aggregation editor + view editing | 1.16.0 | Stage-by-stage and text modes with live per-stage previews; "Save as view" / `collMod`. See ADR #33 and `docs/MONGODB_ROADMAP.md` item #12. |
| MongoDB index manager (list, create, hide, replace, drop) | 1.16.0 | Read from raw `listIndexes` documents (not the lossy typed `IndexModel`), so any option beyond name/keys/`unique` round-trips. See ADR #34 and `docs/MONGODB_ROADMAP.md` item #1. |
| JSON Schema library + per-column bindings | 1.17.0 | User-defined schemas attached to columns, driving completion, hover documentation and advisory validation in the cell editor. Global rather than per-environment, resolved by a most-specific-wins cascade that exists only in Rust. See ADR #39 and `docs/JSON_SCHEMAS.md`. |
| MCP connector (`huginndb-mcp`) | 1.7.0 (binary) → 1.9.0 (per-connection write policy) → view management → MongoDB index/DDL | Read-only by default; `read-only`/`data`/`full` policy per connection, audited writes. Views are readable, editable and droppable on all five drivers at the `full` tier — no separate permission axis. MongoDB index creation/removal is reachable too (its mongosh grammar had no DDL at all before 1.19.0); SQL index and table DDL stay with `run_query`, which is more expressive than any portable form. See `docs/MCP_CONNECTOR_ROADMAP.md` and `docs/MCP.md`. |
| Canary pre-release channel | 1.11.0 | Side-by-side opt-in build for dogfooding against real profiles before a stable release. See `docs/CANARY.md`. |
| Reconnect-on-launch + session-level workspace layout | 1.11.0 | Restores live connections, focus, and pane geometry at startup. |
| Microsoft SQL Server driver | 1.13.0 | Read + edit-data MVP via `tiberius` (`sqlx` has no MSSQL driver). The structure editor and table rename followed in a later release; view editing and `.sql` export are still deferred — see Open #2. Requires SQL Server 2012+. |
| **HuginnDB Pulse** — live server health/performance monitoring | 1.20.0 | Vital signs, top time-consuming statements (with `EXPLAIN`), storage, sessions and index usage for **MySQL and MongoDB**, docked next to the workspace or expanded into its own window; an opt-in per-connection history sampler (`pulse.db`) answers "was this slow yesterday too"; reachable over MCP through seven read-only tools. Postgres/SQLite/SQL Server show an explicit "not supported yet" state. See `docs/PULSE.md`. |
| **AI panel** — an in-app, local-first assistant | 1.22.0 | Docked beside Pulse, off by default. Two independently declared axes (where inference runs, whether rows may enter the context) gate everything; four assisted actions run on one model call each, agent mode drives the read-only tool catalogue and is gated on a measured tool-capable endpoint, and no write tool exists at all. Conversations are memory-only. See `docs/AI.md` for what exists, `docs/AI_ROADMAP.md` for the design rationale and the questions deferred past v1, and ADRs #71–#73 and gotcha #74 for the invariants. |
| Open VSX theme browser | 1.26.0 | An **Extensions** panel in the right dock: search the registry, install a theme, apply it, and update the installed ones. Icon themes are filtered out by reading each candidate's manifest (1–11 KB) rather than its package, downloads are verified against the registry's published `sha256`, and the destination is read from preferences inside the backend so the kill-switch cannot be bypassed. An update never overwrites a palette the user has edited. See ADR #88. |
| VS Code theme import | 1.26.0 | `Import theme…` in Settings → Appearance accepts a `.vsix` or a bare `*-color-theme.json`. One file yields two things of different kinds: the editor gets a **translation** (Monaco *is* VS Code's editor), the chrome gets a **derivation** — ~230 widget-named keys read into 30 role-named tokens — which lands as an editable custom family rather than being presented as "your theme". Built against five real open-vsx themes kept as fixtures. Browsing the registry in-app is still open, see below. See ADR #87. |
| **Query panel** — a Compass-style query bar for every driver | Unreleased (next minor) | Started from a user comparing the list view with MongoDB Compass: the list view could not be sorted at all, and there was no projection. Shipped in six PRs (#177–#182), one design, one panel under the grid toolbar that replaced the advanced filter dialog: sort chips and a field context menu that work in both view modes; conditions plus a hand-written **expression** ANDed with them (a `WHERE` fragment on SQL, a filter document on MongoDB) rather than a lossy "conditions ⇄ JSON" toggle; **projection** with the key columns always kept; **collation** and an **index hint** in each engine's own spelling (PostgreSQL's missing hints are disabled with the reason); a **Result** line built by the code the browse runs, with *Copy*, *Open in editor* and **Explain** (SQL Server refused: its plan needs `SHOWPLAN` in a batch of its own); **Go to row** in place of Compass's Skip/Limit; and an export that writes what the grid shows. Deliberately *not* copied: a per-query `maxTimeMS` (the browse stays unbounded, ADR #92) and free Skip/Limit fields, which would fight the pager. Everything is saved with the tab. |
| **Managed policy — phase 1: the AI** | Unreleased (next minor) | The objection an enterprise buyer raised: configuring and auditing permissions workstation by workstation. An administrator writes one policy — `HKLM\SOFTWARE\Policies\HuginnDB` or `managed-policy.json` in the system folder, inline or pointing to a share — giving each OS account one role and each role per-server rules: visible databases and relations, and select / insert / update / delete / ddl granted separately, plus `monitor`. Enforced for the AI at the one function every AI request passes through, with discovery filtered, free SQL withheld under scoped rules, `ai ⊆ human`, fail-closed, and only ever narrowing the local settings; Settings → Policy shows what applies. Preceded by a classifier fix (three writes that passed as reads) and the INSERT/UPDATE/DELETE verb split. Phase 2 applies it to **people** as a guardrail: every command checks the role's `human` permissions, and the interface locks what they do not allow, with the reason (ADRs #95–#96). Phase 3 makes it a wall: each person signs in with their own database user (a rule's `dbUser`), and HuginnDB generates the `GRANT` / `createRole` script that makes the database agree with the role (ADRs #97–#98). Phase 4 edits it in the app: a form and the JSON over one draft, checked by the parser that applies it, with "view as", saved only where the share accepts a write (ADRs #99–#100). See `docs/POLICY.md`, `docs/POLICY_ROADMAP.md` and ADRs #93–#100. |
| Bulk row insert | 1.25.0 | "Paste rows as JSON…", behind the grid's Insert button, on all four SQL drivers: an object is one row, an array is many, and the backend turns either into one multi-row `INSERT` per bind-ceiling chunk inside a single transaction. Bulk *delete* had shipped in 1.0.2 and MongoDB had been covered since its document dialog accepted an array; this is the SQL half. Keys are validated against the catalogue before they can become identifiers, and a row whose column set differs from the first is refused rather than silently defaulted. See ADR #84. |
| **Terminal panel** — `mongosh` signed in as a connection, plus the user's shell | Unreleased (next minor) | Started from a user whose AI tools answer "check this in MongoDB" with `mongosh` scripts the query editor's bounded grammar refuses. A PTY per tab (`portable-pty`) rendered by xterm.js in the bottom dock; `mongosh` is the user's own, signed in with the open pool's credentials and tunnel, password via the environment. Pulse gained the same on/off module switch the AI panel had. See `docs/MONGODB.md` and ADR #107. |

## Open (priority order)

1. **Schema diff & export** — DDL extraction and a side-by-side compare
   between two schemas or two points in time. No backend or UI work started.
2. **More drivers** — ClickHouse, DuckDB. Recipe for adding a driver is in
   `CONTRIBUTING.md`. Microsoft SQL Server shipped (see above), and its
   structure editor and table rename now have a T-SQL builder in `db/ddl.rs`
   (`IDENTITY` on an existing column is refused: it takes a table rebuild).
   What is left there is the view editor and view rename (`db/view_ddl.rs` —
   `sp_rename` would leave the old name inside the view's stored definition)
   and `.sql` export/import (`db/dump.rs`).
3. **Cloud/managed database support (Supabase, Neon, PlanetScale, ...)** — a
   Supabase project's Postgres endpoint already connects today through the
   existing PostgreSQL driver (it's plain Postgres on the wire), so this
   isn't a new driver — it's ergonomics and pooler-awareness on top of the
   one that exists. Candidate scope: (a) a "cloud provider" connection mode
   that takes a project URL/API key instead of hand-entered host/port/user/
   password; (b) correct handling of Supabase's pgbouncer **transaction-mode**
   pooler, which doesn't support prepared statements — `sqlx`'s default
   Postgres protocol assumes them, so connecting through port 6543 needs a
   simple-query fallback or the direct-connection port documented as the
   supported path; (c) optionally surfacing project-level metadata (RLS
   policies, branches) the way the existing users/privileges panel does for
   plain Postgres. No design work started; needs scoping (Supabase-only vs.
   a generic "cloud Postgres" abstraction covering Neon/PlanetScale too)
   before implementation begins.
4. **Tighter CSP** for the webview. Currently `csp: null` (`tauri.conf.json`)
   because Monaco loads its workers as blobs — see `CLAUDE.md`'s architecture
   invariants for why the relaxation is considered narrow today.
5. **Automated tests, wider coverage.** Backend unit tests already cover a
   meaningful slice (`tab_state` migrations, `db::ddl`/`view_ddl` builders,
   `db::sql`, the Mongo shell parser/value coercion/aggregation/indexes,
   `mcp::mod`, `bridge`, prefs, store, SQL Server's pool/schema/values — see
   `#[test]` in `src-tauri/src/{lib,store,prefs,tab_state,commands/query,
   commands/origins}.rs`, `db/{sql,ddl,view_ddl,pool,endpoint}.rs`,
   `db/mongo/{shell,values,query,aggregation,indexes}.rs`, `db/mssql/{mod,
   schema,values}.rs` and `bridge/{protocol,server}.rs`). Still missing:
   integration tests against ephemeral Postgres/MySQL (`testcontainers-rs`),
   and any frontend test coverage (Playwright).
7. **Broaden Linux distribution.** The `ubuntu-22.04` leg in
   `.github/workflows/release.yml` is now **enabled**, so a tagged build
   publishes `x86_64` `.deb` + `.AppImage` alongside the Windows installer,
   and the README documents both. One caveat before treating this as closed:
   the leg has not yet been exercised by a real tagged run — use the
   workflow's `workflow_dispatch` input with a throwaway tag like
   `v0.0.0-test` to smoke-test it, then delete the draft. (The updater is
   *not* a concern: tauri-action fetches the existing `latest.json` and merges
   its own entries into `platforms` rather than replacing the asset, so the
   second leg to finish preserves the first one's entry. Its known race
   between parallel legs — tauri-apps/tauri-action#1270 — is mitigated with
   `retryAttempts: 3`; see the comment on that step.)

   **Dated follow-up: move the Linux leg to `ubuntu-24.04` before March
   2027.** `ubuntu-22.04` is GA today but retires on 2027-04-17, with
   deliberate brownouts from late March (actions/runner-images#14254). It is
   the right image *now* because it has the oldest glibc still available
   (2.35) and that maximises AppImage compatibility, so this is a deadline to
   track rather than something to do early.

   **`.rpm` target added** (Fedora/openSUSE/RHEL-family) — `bundle.targets`
   in `tauri.conf.json` now includes `"rpm"`. Tauri's rpm bundler is the pure
   Rust `rpm` crate, so it builds from the same `ubuntu-22.04` leg with no
   extra system packages or CI changes. Smoke-tested via `workflow_dispatch`
   with the `v0.0.0-test` throwaway tag (run
   [#32025472960](https://github.com/lopezz-dev/huginnDB/actions/runs/32025472960)):
   both legs completed successfully and the draft release carried a valid
   `HuginnDB-1.16.0-1.x86_64.rpm` + `.sig` alongside the existing assets.
   What that confirms is that the bundler produces a well-formed package —
   it does **not** confirm the package actually installs and launches on a
   real Fedora/openSUSE box, which is still unverified.

   What genuinely remains beyond that: an `aarch64`/arm64 leg, and any
   distribution beyond raw GitHub Releases (Flatpak/Flathub, Snap, an AUR
   package) — all with zero existing scaffolding. Arch is a special case:
   the `.AppImage` already runs there unmodified (Arch's glibc is always
   newer than the `ubuntu-22.04` baseline it's built against), so "Arch
   support" doesn't need a new Tauri bundle target — it needs someone to
   write and maintain a `PKGBUILD` for the AUR, which is an external
   packaging/publishing step (an aur.archlinux.org account + SSH key), not a
   change to this repo's build.
8. **macOS bundle with code signing.** The build is expected to work but is
   unverified, and there's no Apple Developer signing/notarization yet
   (parallels the Windows SmartScreen situation documented in the README).
9. **Visual query builder** — low priority. Monaco is fast enough that most
   users probably don't want one; only pursue if there's real demand. The query
   panel (see *Shipped milestones*) already covers the single-relation case —
   conditions, projection, sort, collation, hint — so what is left for a
   builder is what the panel deliberately does not model: OR groups (today an
   expression), joins, and aggregation. Its *Open in editor* is the intended
   way out for those, which is another reason this stays low.
10. **Keyset (seek) pagination for deep table navigation** — low priority.
   The data browser paginates with `LIMIT/OFFSET` (and `.skip()` on MongoDB),
   which is O(offset): jumping deep into a multi-million-row table makes the
   engine scan and discard every skipped row. A `WHERE (sort_key) > :last`
   seek would make deep pages O(1), but it doesn't compose with "jump to page
   N" or arbitrary multi-column sort, so it's a targeted optimisation, not a
   drop-in replacement for the current offset model. Deferred deliberately:
   the 1.11.0 row-count decoupling + whole-table estimate (issue #77)
   already removed the *actual* first-paint stall, so the offset cost only
   bites a user who pages very deep, which is rare in practice. Revisit only
   if a real deep-navigation complaint appears. **One thing changed the odds:**
   the footer's *Go to row* makes an offset of millions one keystroke away,
   where it used to take a thousand clicks on *Next*. It is still O(offset)
   underneath, so a deep jump on a big table is exactly the slow case this item
   describes — the first complaint is now more likely to arrive, and this is
   the item it belongs to.

## Fit and finish

A standing track, deliberately separate from the numbered list above.

**Why it needs its own section rather than a place in that queue.** The
convention for "what's next" is the top open item above, and until this section
existed every item there was a feature or a piece of infrastructure. Polish did
not lose that queue on merit — it was never in it, so the standing instruction
for what to work on was structurally incapable of surfacing one. The practical
consequence is visible in the 1.20.x history: every fix in that pass arrived
because someone using the app noticed and said so. That is a fine way to find
problems and a bad way to be the *only* way to find them.

The section is a queue, not a wishlist. An entry earns a place by naming
something observable — a file and line, a count, a reproducible behaviour — and
by falling into one of the four classes below. "The grid feels clunky" is not
an entry; the four things that make it feel clunky are.

**Cadence: each minor release closes at least two of these.** Small enough that
it never competes with a driver, regular enough that the list cannot only grow.

### The four classes

They are worth keeping apart because they fail differently, and three of the
four look like styling problems while having nothing to do with styling.

1. **Adoption debt.** A primitive already answers the question and the call
   site never migrated. Cheap, mechanical, and the only class with a machine
   count: `uiAdoption.test.ts` holds the budgets, sorted by debt, so it doubles
   as this class's worklist.
2. **Global behaviour with no owner.** A library default nobody chose, applied
   app-wide. Usually one line; the cost is that it takes a user report to find,
   because there is no file it is "missing from".
3. **State that cannot express what the UI needs to say.** Looks like a
   rendering bug and is not — no amount of styling fixes a store that does not
   hold the fact being rendered.
4. **A genuine interaction gap.** The app cannot do the thing. These are the
   only ones that are features, and they are sized like features.

### Open

**Adoption debt.** 133 raw `<button>` elements across 72 files and 67 native
`title=` attributes across 39, both counted and ratcheted by
`src/components/ui/uiAdoption.test.ts`. The budgets can only shrink, so this
entry needs no separate tracking — read the maps. **They are not all
migratable, and the target is not zero**: working `DocumentListView` established
that a real class of text-level actions sits below the primitive layer's
density floor (`IconButton`'s smallest shape is a fixed `h-6 w-6`, which inside
a monospace field row pins the height and breaks the grid's Ctrl+wheel zoom),
alongside affordances that render a glyph or a word rather than a Lucide icon.
Those are documented exceptions in the test, not work. Read the reason before
pushing a count down. Worth naming individually:

- ~~`GridToolbar.tsx:166`'s OS tooltip on the Insert button~~ — **fixed**; it
  became a `SimpleTooltip` while that button was being rebuilt as a split
  control. Worth keeping the note for the rule it exposed:
  `uiContracts.test.ts`'s rule H exists for exactly this shape and misses it,
  because it fires only on `size="icon"`. **Widening rule H is still blocked**
  — as a contract it would fail on the 79 remaining — so it stays a one-line
  change for the moment that budget empties. That ordering is the point: the
  budget is what makes the contract mergeable later.
- ~~**A `Separator` primitive is a candidate.**~~ — **closed.** By the time it
  was done there were twelve, not nine, in four heights (`h-3`/`h-3.5`/`h-4`/
  `h-5`). `ui/separator.tsx` reconciles them to two: `h-4` between groups of
  controls, `size="sm"` (`h-3`) between runs of `text-2xs` text — the
  console's `h-5` and the chip row's `h-3.5` were outliers, not sizes. It
  carries no margin: spacing is the row's `gap`, and the three `gap-1` rows pass
  `mx-1` to land on the same 8px the `gap-2` toolbars get (the `mx-0.5` ones
  move by 2px, the chip row loses its extra `mx-1`). Graduated straight to a
  contract — `uiContracts.test.ts` rule G now refuses a class string with a
  height, `w-px` and `bg-border` outside `ui/`, with an empty allowlist; the
  aggregation editor's two `PanelResizeHandle`s are `w-px bg-border` too but
  have no height, which is how the rule tells a handle from a divider.
- The heaviest single files were `DocumentListView.tsx` (6 raw buttons, 4 OS
  tooltips) and `ConnectionTreeRow.tsx` (8 OS tooltips). Both are row/list
  components, so one pass over each clears a visible share of both budgets.
  **`ConnectionTreeRow.tsx` is down to 3**, done while adding the `failed`
  match state below: `MatchBadge`'s six arms became one `SimpleTooltip`, and
  the reason they were worth migrating rather than counted is that every one of
  them explains a state its glyph cannot carry — "—" means four different
  things across those branches — so the label *is* the badge, and an OS tooltip
  is the wrong vehicle for it. The three left are the row's own controls.
  `DocumentListView.tsx` is still open, and its raw buttons are the documented
  exception, not work.
- `ConnectionsTree`'s visible-databases button cannot become an `IconButton` as
  it stands: it paints a subset badge over its glyph, and `IconButton` takes
  the icon as a component with no room for a child. Either it gains a badge
  slot or this one stays hand-rolled with a written reason — the decision, not
  the migration, is the work.

**Token adoption.** The design tokens exist and are almost unused:
`brand-flash` (the "short blue pulse on a completed action" the visual brief
asked for) has **two** call sites in the whole app, and the 180/220 ms motion
band has **three** between both ends. This is the same shape as the class above
one level down — a vocabulary written and then not spoken. The work is not
"add animations": it is deciding which completions deserve confirmation at all,
then either adopting the token or deleting it. A token with two uses is not a
system.

~~**Discoverability of the grid's sizing gestures.**~~ — **closed.** "Fit to
content" and "fit to visible width" are `fitColumnsToContent` /
`fitColumnsToWidth` in `ACTIONS`, so they are bindable and listed in Settings
(ADR #53). One correction to what this entry assumed: the palette did *not*
come for free — its action entries are hand-written in `useCommands.tsx`, and
only the "shortcut for …" settings rows are generated from the catalogue — so
both got an entry there too. The other thing worth knowing is which grid
answers: a `DataGrid` has no tab id (a table tab, every query result set and
the view editor's preview each mount one), so `lib/grid/gridSizing.ts`
registers each grid's root and resolves the focused one, else the visible one
used last, and declines rather than guess between two nobody has touched.

**A class 4 instance, found and closed:** the schema tree and the tab area
stayed fully interactive for the whole of an environment switch — seconds, on a
set of connections that includes an SSH tunnel — while `switchTo` emptied the
tab store and closed every pool one at a time underneath them. The state was
not the problem this time (`switchingTo` already named its subject correctly);
the gap was that nothing outside the three environment *pickers* consumed it,
so the app could not act on a fact it already held. Closed by
`EnvironmentSwitchGuard`, one seam over both regions, and by widening
`switchingTo` to cover `createAndEnter`'s seeding pass, which was the slower of
the two routes into an environment and the unguarded one. **Superseded in 1.25.0**:
`switchTo` now hands the backend over to the incoming environment *before* a
single outgoing pool is asked to close, so the outgoing tree is already off
screen by the time any teardown starts and the guard had nothing left to seal —
it was deleted rather than kept.

**A second class 3 instance, found and closed.** `SchemaSliceLike`
(`src/lib/schema/treeMatches.ts`) was `{ databases, tables, loading,
initialized }` — no concept of a slice whose read **failed**. So a connection
whose schema could not be loaded was `initialized: true, loading: false,
tables: []`, which `rowMatchState` read as `"none"`: the row dimmed, grew a
confident `0` badge, and the filter *folded* it away — unmounting the one place
`cs.error` was rendered. In a multi-DB tree the same thing happened one level
down: a child whose warm failed is no longer "cold", so it dropped out of what
the warm button offers and was reported as an honest zero. That is precisely
the failure mode the header of `treeMatches.ts` and `MatchBadge`'s doc were
written to argue against — saying `0` about something nobody read is what makes
a user abandon a search — and, like the environment switch before it, the tree
could not act on a fact the store already held. Found while fixing ADR #68
and closed by a `failed` member of `RowMatchState`, ranked above `unloaded`
(looking did not work) and below `matches` (a stale count is still a count),
plus the `error` field on the slice shape to back it. The two places it is
deliberately *absent* — `filterFoldsIgnoringOverride` and the row's
`dimmedByFilter` — are the fix.

**Two more class 4 instances, found and closed — the credential direction of
a shared origin.** An origin's whole value is that one person curates the
connections; its whole failure mode is that a server resets a password and the
app had no way to say so in either direction. Neither half was a rendering
problem and neither was in this queue: both arrived the way the preamble above
says they do, from someone using the app.

- **A publisher could correct a connection but not publish the correction.**
  `save_profile` writes `profiles.json` and the local keychain and stops there,
  so a fixed password reached nobody until somebody walked Settings → the origin
  editor → find the row → flip its secret to "from the keychain" → publish. One
  intent expressed twice, with every consumer locked out for the length of the
  detour and no reminder that the second half existed. Closed by
  `republish_profile_to_origin`, which is `save_inner` with one row pre-filled
  rather than a second write path — same role check, write probe, hash conflict
  check, `.bak` and impact report. The load-bearing detail is that it
  re-encrypts **only** when the password itself changed: ADR #69 has why a
  fresh envelope for an unchanged secret is a correctness problem and not a
  performance one.
- **A consumer could not do anything at all.** `connect` takes a password
  ad-hoc and persists nothing, and saving an origin-owned profile is refused
  because the next sync would undo it — so the only response to a rotated
  credential was retyping it on every single connect, indefinitely. Closed by
  `ConnectionProfile::secret_override`, scoped to the secret and nothing else,
  and expiring on its own once the origin publishes a different ciphertext. It
  is the first piece of local state here that is *temporary*; see ADR #69 for
  why it is preserved across a merge in order to be expired by one.

**A third class 3 instance, found and closed: MongoDB's raw-edit toggle had
nowhere to put "I can't".** Leaving raw-edit mode re-parsed the URI and, when
the parse failed, did nothing — the switch flipped back under the cursor with no
state
holding the reason anywhere, so a profile saved from a pasted string could never
be edited as a form again. Closed by `parseMongoUriLossy`, which always returns
fields plus the reasons it could not keep everything, and by
`mongoFoldConflict`/`MongoUriFoldDialog` turning those reasons into a
confirmation. The other half was smaller and worse: the strict parse refused any
query option outside `authSource`/`directConnection`, which is every Atlas URI,
so those connections were *born* in raw-edit. Unmodelled options now ride
through the form untouched. ADR #70.

**Still open from that pass: a local password override is invisible outside the
connection dialog.** `ConnectionRailRow` marks an origin-owned connection as
shared and stops there, so "which of my connections are running on a password I
typed rather than the published one" can only be answered by opening each one.
Class 3 shaped — the store holds `secret_override` and no list-level surface
consumes it — and the fix is one badge plus a decision about whether the
connection rail or Settings → Origins is the right place to answer it at a
glance.

**Two class 1 instances and a class 2, found and closed: the modal plane.**
Seven dialogs had hand-copied their own header rail, in five spellings between
them, and the reason is not carelessness — `DialogContent` had exactly one
anatomy, so a call site that needed a different shape had nowhere to say so and
rebuilt the rail instead. Closed by a `tier` prop (`prompt` for the ~11 one-line
confirms, `panel` for the ~18 forms, `workbench` for Settings, the connection
manager, the shared-origin editor, Documentation and the fullscreen cell editor)
plus a `DialogHeader`/`DialogBody`/`DialogFooter` trio that reads it from a
private context: the rail, the body padding, the radius and the close button's
gap are now declared once and a call site cannot re-declare them. The second
class 1 member is smaller and the same shape — `DialogActions` carried a `size`
prop whose two values split the app's footers down the middle, and dropping it
settles the divergence rather than recording it.

The class 2 member in that pass is `window.confirm`: the browser's own prompt,
unthemed and window-freezing, in ten places — dropping a database, an SQL
import, an index rebuild, an MCP-sidecar warning before installing an update,
among them. A default nobody chose, applied app-wide, with no file it was
missing from, which is the class exactly. Closed by `ConfirmHost`, keeping the
same wording and the same type-to-confirm gate. Two more fell out of the same
work and are worth naming because both had been shipping silently: `--scrim`
was a literal `bg-black/60` hard-coded in the two places the modal stack is
built, and so the one point where that stack escaped the theme system entirely
(a light theme got a blackout rather than a dim); and the open/close animation
had been broken since shadcn's default `Dialog` was adopted, because centring
and the zoom both wrote `transform` and one replaced the other — every dialog
entered from the viewport's top-left corner rather than its own centre.

**Class 2 has no known open instances.** Stated rather than omitted, because an
empty class is information: its two confirmed members — the tooltip-provider
default and `window.confirm` — are both fixed. The connection surfaces were
checked at the same time and already model their targets correctly
(`connecting: string | null`, `disconnecting: Set<string>`);
`useSchema.loading` is per-connection inside its slice, and
`useOriginSync.syncing` is a genuine batch flag over a pass that really does
sweep every origin. The classes stay in the taxonomy because they
describe how those two bugs happened and what the next one will look like, not
because there is a backlog behind them.

**A class 1 and a class 4, found and closed: the schema tree's rows, and the
database node it never had.** Two findings from one pass over the tree, and
only one of them was a styling problem.

The class 1 member is the row itself. Four call sites had hand-written the same
`<button>` — full width, the same padding, the same `hover:bg-accent`, and the
same focus ring driven by "is my context menu open on me". `ui/tree-row.tsx`
owns that chrome now and each row keeps the part that actually differs, which
takes the raw-button budget from 136 to 134.

The class 4 member is the one that was reachable, and it is a gap rather than a
rendering bug: a profile with a `database` set showed no database node at all —
its top node is a *schema* — so "Drop database…", which lives on a database
node, existed **nowhere**, while "New database" sat in the connection's menu.
You could create a database from a connection and then have no way to delete it
from anywhere in the app. The same want-of-anywhere-else had put "New
collection" on the connection too. Closed by the node rather than one more entry
on the connection: `DatabaseNodeMenu` is rendered by both explorers, merged into
the top node on MySQL and MongoDB and drawn above `public`/`dbo` on Postgres and
SQL Server. Its neighbour is the same gap one step earlier — a server with no
databases rendered literally nothing, no row and no sentence, which reads as a
connection that failed rather than a server that is empty. The tree now tells
the two reasons it can be empty apart: nothing on the server offers "New
database", everything hidden by the visible-databases subset offers the picker.

Have a different priority? Open a
[feature request](.github/ISSUE_TEMPLATE/feature_request.md).

## Explicitly out of scope

Don't propose these unless the user asks first:

- A linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy`
  advice in `CONTRIBUTING.md`.
- AI features that are cloud-by-default, and LLM-driven autocomplete in the
  Monaco editor (a different latency and cost profile from a chat panel). The
  in-app **AI panel** is not this: it shipped in 1.22.0, local-first,
  read-only and off by default (see `docs/AI.md`).
- Cloud sync of profiles or saved queries. **Shared origins** (#108, shipped) are
  not this and don't open the door to it: a file on a path the OS already mounts,
  curated by hand, read one way with no service, account or background upload
  behind it. HuginnDB never writes to the share.
- Mobile builds — Tauri's icon CLI generated iOS/Android directories during
  scaffolding, but desktop is the only target.
