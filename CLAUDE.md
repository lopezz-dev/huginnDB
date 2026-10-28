# CLAUDE.md

Project context for Claude Code sessions on this repo. Skim this first; reach for `README.md` / `CONTRIBUTING.md` / `SECURITY.md` for the public-facing detail.

## Identity

- **HuginnDB** — desktop database manager, Tauri 2 (Rust backend) + React + TypeScript frontend.
- Targets PostgreSQL, MySQL, SQLite, **MongoDB**, and **Microsoft SQL Server**. Inspired by HeidiSQL but minimal-UI / keyboard-first / Monaco-everywhere.
- Public repo: <https://github.com/lopezz-dev/huginnDB>.
- License: MIT. Status: **1.36.x** (stable; SemVer applies). MongoDB support landed in 1.1.0; the headless MCP connector (`huginndb-mcp`) landed across the 1.5–1.9 line (per-connection write policy in 1.9.0); HuginnDB Pulse (live server health/performance monitoring, MySQL + MongoDB) landed in 1.20.0; the AI panel (local-first, read-only, off by default — Settings → AI, assisted actions and agent mode) landed in 1.22.0. Since 1.23.0 every dialog declares one of three anatomies (`prompt`/`panel`/`workbench`) through `DialogContent`, and `window.confirm` is retired in favour of the in-app `ConfirmHost` — do not reintroduce either a hand-written header rail or a native prompt. Since 1.24.0 a database's own actions live on a database node (`DatabaseNodeMenu`, rendered by both explorers) rather than on the connection, and a shared origin is consumed by slice (`tab_state::OriginScope` — connections / environments / JSON Schemas, the one per-resource flag that defaults to **on**; see ADR #83). Since 1.25.0 the workspace's current connection is *derived* from the focused tab by `src/stores/session/focusFollowsTab.ts` — do not add another `setSelectedConnectionId` call site to approximate it. Since 1.26.0 a VS Code colour theme can be imported (`.vsix` or a bare `*-color-theme.json`) or browsed and installed straight from Open VSX (Settings → Appearance's **Extensions** panel) — the registry URL is read from `ThemePrefs` inside the backend, never named by the frontend, the same addressing rule the AI panel already followed (see ADRs #87–#88). Since 1.27.0 the timeout on the reads the app issues on its own behalf (listing databases/tables, describing a relation, the liveness ping) is the user's — `ConnectionPrefs::operation_timeout_secs` globally, overridden by `ConnectionProfile::operation_timeout_secs`, resolved only through `db::pool::operation_timeout` — not a constant; a query the user runs stays unbounded. Since 1.28.0 the grid's server-side filter, projection, sort, collation and index hint are edited in one place, the inline **query panel** (`src/components/grid/QueryPanel.tsx`) — the advanced-filter dialog is gone, and its *Result* line and *Explain* are built by the same backend code the browse runs, so they cannot describe a different statement from the one that executes; do not bring back a second surface that edits the active filters. Since 1.29.0 a **managed policy** (`crate::policy`, `docs/POLICY.md`) can bound both people and their AI: the AI at the one `bridge::exec::execute` choke point (ADR #94), people in each `#[tauri::command]` wrapper — never in the `_inner` core, which `bridge::exec` shares — with `guard::HUMAN_POLICY` classifying every registered command and a test failing on one that is unclassified or never calls the guard (ADR #95). A new command that touches a database must state what the policy asks of it; the interface's locks are advisory and the backend refuses regardless (ADR #96). Since 1.36.0 an **app lock** (`crate::app_lock`, `crate::vault`, `docs/APP_LOCK.md`) can hold every secret in an encrypted vault instead of the OS keychain: secrets are reached only through `keychain::{get,set,delete}_password`, which route through the vault, and while the app is locked one dispatcher around `generate_handler!` (`app_lock::gate`) refuses every command not named in `app_lock::OPEN_WHILE_LOCKED` — a new command is closed behind the lock by default, so do not add it to that list or read a secret around `keychain.rs` (ADRs #118–#119). A managed policy can require the lock and only ever tightens it, resolved by `policy::app_lock` and enforced in Rust (ADR #120).

## Maintainer / collaboration notes

- Sole maintainer: **lopezz-dev** (formerly `Alexfp28`; `alexlopezdelafuente@gmail.com`). Security contact: `contact@shion.es`.
- **ALWAYS sign the maintainer's name — this is not optional and applies to every turn.** Anything that carries
  authorship is signed as **Alex López (lopezz-dev)** `<alexlopezdelafuente@gmail.com>`: commits, pull request bodies,
  GitHub comments, and any generated document or deliverable. The agent's own attribution trailer/footer is
  *additive* — it never replaces the signature.
  - **Commits:** author is the maintainer, never the agent —
    `git commit --author="Alex López <alexlopezdelafuente@gmail.com>" -F <msg-file>`.
    Leave the **committer** identity alone (`Claude <noreply@anthropic.com>`): the remote session's SSH signing key is
    registered to that address, so overriding `user.email` makes GitHub report every commit as *Unverified*. Author
    and committer are separate fields — `--author` is the whole mechanism, and `--amend --reset-author` undoes it.
  - **Pull requests / GitHub comments:** state the maintainer's authorship in the body, above the agent footer.
- User communicates in **Spanish**; reply in Spanish. Code, comments, commit messages, and docs are **English**.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, …) with **long-form bodies** explaining the *why*. The user explicitly values verbose commits — never punt with a one-liner on non-trivial changes.
- Keep `CHANGELOG.md` in sync (Keep a Changelog format). Add to `Unreleased` as you go; the user will cut releases manually.
- **`CHANGELOG.es.md` is the Spanish translation of `CHANGELOG.md` and must be updated in the same turn, never as a follow-up.** Every entry added to `CHANGELOG.md`'s `Unreleased` section gets its translated counterpart added to `CHANGELOG.es.md`'s `[Sin publicar]` section right away — this is the thing that keeps getting forgotten, so treat "update the changelog" as meaning both files unless told otherwise.

## Pull request workflow

- **Every commit lands via a pull request into `develop`, never a direct push — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, all of them.** This replaces the old commit-only history: GitHub's release-notes generator reads merged PRs, not raw commits, so PR-level traceability is what makes a minor release's GitHub Release notes assemble themselves instead of being hand-curated from `git log`.
- **Before touching any code, branch off `develop` first — never commit on `develop` directly.** The point is isolation: if a change breaks something mid-development, only that branch is broken and `develop` stays green. One branch per PR, one Conventional Commit type/scope per PR — don't mix an unrelated `chore:` into a `feat:` branch, it defeats the point of PR-level traceability. If a session starts with the working tree already on `develop`, cut the branch before the first edit, not after.
- **Squash merge only.** The squashed commit's message is the long-form why-focused body this file already requires — it's what lands in `develop`'s history and feeds the release notes, so it must stand on its own without the PR page next to it.
- **The maintainer reviews and merges manually in the GitHub UI — never auto-merge, even though he's the sole reviewer.** Open the PR (and push follow-up commits addressing review feedback if asked) but never click merge yourself; wait for Alex to do it.
- PR title mirrors the commit's `type(scope): …`; PR body states the maintainer's authorship above the agent's own footer, per the signature rule above.
- **The one exception: a version cut.** `chore(release): cut X.Y.Z` is committed directly on `develop` (no PR), `develop` is then fast-forwarded into `main`, and the annotated tag `vX.Y.Z` is pushed — the maintainer has done it this way since 1.26.0 and asks for it with `/release X.Y.Z` (project skill `.claude/skills/release/SKILL.md`; the manual version is in `RELEASING.md`). It runs end to end without asking for confirmation, never force-pushes, and never publishes the draft release — that click stays Alex's. This exception covers the cut commit only: any fix or feature that goes into a release still lands via its own PR beforehand.

## Tech stack quick reference

| Layer       | Choice                                                   |
| ----------- | -------------------------------------------------------- |
| Shell       | Tauri 2 (`@tauri-apps/cli`, `@tauri-apps/api`)           |
| Frontend    | React 18 + TS strict, Vite                               |
| Styling     | Tailwind CSS + shadcn-style Radix primitives             |
| State       | Zustand (with `persist` for theme / history / saved)     |
| Data grid   | TanStack Table v8                                        |
| Editor      | Monaco — **self-hosted, no CDN** (`src/lib/monaco/monaco-setup.ts`) |
| DB drivers  | `sqlx` 0.8 (`postgres`, `mysql`, `sqlite`) + `mongodb` 3 (`bson-3`) + `tiberius` 0.12 (SQL Server; `sqlx` has no MSSQL driver) |
| Credentials | `keyring` crate (Windows Credential Manager / libsecret) |
| Package mgr | **pnpm only**. Never suggest `npm` or `yarn`.            |

## Repo map (compressed; see `CONTRIBUTING.md` for the full version)

```
src/                       frontend
  components/              feature components, grouped by domain (each domain gets an optional
                           dialogs/ subfolder for its modal-only components — see convention #28)
    ui/                    shadcn primitives
    common/, connection/, schema/, query/, grid/, menus/, shell/, settings/,
                           aggregation/, indexes/, jsonSchema/
                           (the schema tree is one flat virtualised list —
                           lib/schema/flatTree.ts builds the rows, FlatTreeRow
                           dispatches each kind to DatabaseRow / SchemaNodeRows /
                           SchemaTableSection / SchemaTableRow, ADR #108;
                           a grid is one file per level: DataGrid →
                           GridToolbar + GridRow, hooks under lib/grid/)
  stores/                  Zustand stores, themselves grouped:
    session/               connections, tabs, schema, environments, ui, treeSearch,
                           persistedTabs
    preferences/, dialogs/, grid/, query/, sync/   (+ jsonSchemas.ts, update.ts)
  lib/                     tauri wrapper, themes, constants, pure helpers; grouped:
    monaco/, bridges/, db/, grid/, sql/, schema/, tabs/, transfer/, mongo/,
                           (schema/ owns the tree filter's pure core: matchesFilter,
                           filterScope, treeMatches + useTreeMatchCounts, and the
                           one warm scheduler — ADR #55)
    commandPalette/, connection/, jsonSchema/, appInfo/, i18n/, keybindings/
                           (keybindings/ is catalogue + key lexicon + resolver +
                           one dispatcher — see ADR #53)
                           (appInfo/ holds the docs registry and docOutline, which
                           derives the viewer's section tree from the markdown itself)
  types.ts                 shared TS types mirroring Rust DTOs

src-tauri/src/             backend (workspace root; see mcp-server/ below)
  commands/                Tauri command handlers (the public API)
  db/                      pool / sql / classify / values helpers (driver-agnostic;
                           classify.rs owns the one write-tier decision — ADR #54)
  keychain.rs              centralised keyring access
  state.rs, store.rs       state + disk persistence (profiles)
  prefs.rs                 user preferences → prefs.json
  tab_state.rs             per-connection tab state → tab_state.json
  error.rs                 AppError / AppResult
  mcp/                     MCP connector logic (behind the `mcp` feature)

src-tauri/mcp-server/     sibling crate: the `huginndb-mcp` binary shim
                           (kept out of the app's own Cargo.toml — ADR #20)
```

Two starter files for new contributors: `src-tauri/src/lib.rs` and `src/App.tsx`.

## Engineering notes: ADRs, gotchas, conventions

Lo que antes era una sola lista de "gotchas" vive en [`engineering/`](engineering/README.md), clasificado por lo que es cada entrada:

- **ADR** ([`engineering/adr/`](engineering/adr/README.md)): una *decisión* tomada entre alternativas, con su porqué. Se revisa con un ADR nuevo que la sustituye (`supersedes` / `superseded_by`); el antiguo no se reescribe.
- **Gotcha** ([`engineering/gotchas/`](engineering/gotchas/README.md)): un *hecho* de algo ajeno a nuestro diseño (librería, driver, plataforma, CI, un LLM) donde el código obvio falla. Prueba: *¿seguiría siendo cierto si reescribiéramos HuginnDB con otro diseño?* Si sí, es gotcha. Una trampa externa que forzó una decisión es un ADR con `triggered_by_external_trap: true`, y el índice de gotchas la lista igualmente por tecnología.
- **Convención** ([`engineering/conventions/`](engineering/conventions/README.md)): una *norma* de cómo se escribe el código aquí.

**Un único espacio de numeración global:** `#54` es un ADR y `#19` un gotcha, y ningún número se repite. El código y los changelogs publicados citan estos números (los textos antiguos dicen "gotcha #N" de cosas que hoy son ADR, y el número sigue resolviendo). Al citar, usa el sustantivo de su tipo (`ADR #54`, `gotcha #19`, `convention #28`). Una entrada nueva toma el siguiente número libre, sea del tipo que sea, y nace de [`engineering/templates/`](engineering/templates/). El front matter es la fuente de verdad: tras añadir o cambiar una entrada, ejecuta `node scripts/engineering-index.mjs`.

Antes de tocar código en un área con historial (Zustand, Monaco, tab_state, MySQL/MongoDB decoding, dockview, environments, MCP, policy, etc.), consulta los índices y lee completas las entradas relevantes: el resumen de una línea no basta.

Deliberadamente fuera de `docs/`: es documentación interna para agentes de IA y contribuidores, no para el visor de Documentación de la app (ver [ADR #50](engineering/adr/adr-050-docs-viewer-markdown-derived-navigation.md)).

## Workflow

```powershell
# dev (Tauri shell + Vite HMR)
pnpm tauri:dev

# production bundle (Windows .msi / Linux .deb / .AppImage)
pnpm tauri:build

# quick reality check (downloads the Chinook SQLite sample, ~1 MB)
mkdir -p sample-data
curl -L -o sample-data/chinook.db `
  https://github.com/lerocha/chinook-database/raw/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite
# then in HuginnDB: + connection → SQLite → path to chinook.db
```

`sample-data/` is gitignored on purpose — don't commit fixtures.

First build is **slow** (5–10 min) because Cargo compiles all three `sqlx` drivers + `keyring` + `tokio` from scratch. Incremental rebuilds are <10 s.

The Rust toolchain + MSVC Build Tools (Windows) are prerequisites; the user already has both. Tauri's per-platform deps are in the README.

## Architecture invariants

- The **frontend never talks to a database directly.** All DB I/O lives in Rust commands. The frontend uses the typed wrapper at `src/lib/tauri.ts` — do not call `invoke` from components.
- **Passwords never hit disk in plaintext.** `keyring` is the only persistence path. Profile metadata (host, port, db, username, SSL toggle, driver) lives in JSON inside the platform config dir; the password is keyed by `${profile.id}::${username}` in the OS keychain.
- **CSP is `null` on purpose** because Monaco loads its workers as blobs. Workers themselves are bundled (no remote fetch), so the relaxation is narrow. Tightening CSP is on the roadmap.

## On-disk state map (platform config dir)

| File                    | Owner                              | Notes |
| ----------------------- | ---------------------------------- | ----- |
| `profiles.json`         | `src-tauri/src/store.rs`           | Connection metadata only. Passwords in OS keychain. **This is also where every per-connection opt-in flag lives** — no subsystem gets a file for its allowlist: `mcp_exposed`/`mcp_write` (ADR #58), `pulse_enabled`, and the AI panel's `ai_enabled` + `ai_rows_allowed` (plus `ai_notes`, the one that is prose rather than a flag: what the user knows about the database that its schema does not say, prepended to every prompt for that connection). All are `#[serde(default)]` and all default to off, so a profile written by an older version is closed rather than open, and each is preserved across a shared-origin sync rather than being pushed by the publisher. Loading a file that exists but won't parse is a hard error on purpose (unlike every other file here) — silently substituting an empty list would show the user an app that has lost every saved connection, and the next save would make that true on disk. |
| `prefs.json`            | `src-tauri/src/prefs.rs`           | User preferences (editor / grid / ui / `AiPrefs`). `AiPrefs` holds the endpoint the AI panel talks to — `mode` (`AiMode`, `Off` by default), base URL, model, declared endpoint trust and `AiReasoningEffort` — but **never the API key**, which lives in the OS keychain under `ai::{origin}`. **The AI panel adds no file of its own** (spec decision D7): conversations are memory-only on purpose, since a transcript holds schema names and row snippets. Atomic temp-file + rename on write. Bad JSON falls back to `Preferences::default()` — never blocks startup. |
| `tab_state.json`        | `src-tauri/src/tab_state.rs`       | **v5** — `{ version, environments[], activeEnvironmentId, origins }`; each environment owns its `connections` map (LRU-pruned to 20 *per environment*; query bodies capped at 64 KB), its dockview geometry and its `launch` state, while `origins` is a **global** registry (ADR #40) whose entries also carry this machine's `role` for that file (`consumer` by default — ADR #56), its `scope` (which of the document's three slices this machine pulls — the one per-resource flag that defaults to **on**, because it describes what an origin was already doing rather than granting a permission; ADR #83) and the last-seen `maintainer`. Written only by the main window (see ADRs #8 and #27). v1–v4 blobs migrate: v1/v2/v3 fold into one unnamed environment (v2 "workspaces" still lose all but the active one), and v4's per-environment origins are hoisted and deduped by path. |
| `json_schemas.json`     | `src-tauri/src/json_schemas/`      | User JSON Schema library + per-column bindings. **Global**, not per environment, and never pruned (see ADR #39). Atomic temp-file + rename; bad JSON falls back to an empty library rather than blocking startup. Bodies are stored as source text and the backend never parses them. |
| `installed_themes.json` | `src-tauri/src/themes/store.rs`    | Themes imported from a `.vsix` or installed from an Open VSX registry: their **Monaco editor themes** (~20 KB each) plus what an update needs (registry, namespace, version, which variants were paired). **The palettes are not here** — they stay in `localStorage` with the rest of the theme store, because 30 hex values have to be read synchronously before first paint to avoid a FOUC while an editor theme tolerates arriving late. `palette_edited` is the field that makes updates safe: it survives every upsert, so an update refreshes the editor half and leaves a palette the user has touched alone. Bad JSON falls back to an empty library — unlike `profiles.json`, losing it costs the built-in presets and nothing else. See ADRs #87 and #88. |
| `updater-state.json` / `updater.log` / `updater.lock` | `src-tauri/src/updater/record.rs` | The silent updater's record (ADR #103): the latest schedule outcome (which layer — tasks, `Run` value, manual — and what Windows said) the latest headless run, read by Settings → About, and `available` — the newest version seen and not yet installed, and since when, which the MCP connector reads to tell the AI an update has waited over a day (it never contacts the feed itself); `updater.log` is one line per event capped at 200 lines, because the headless process has no console; `updater.lock` is held (`share_mode(0)`) for the length of a run. All best effort — failing to record never fails a run. The schedule itself lives outside the config dir: two per-user scheduled tasks named from `productName` and, as a fallback, a value under `HKCU\...\CurrentVersion\Run`. |
| `vault.json`            | `src-tauri/src/vault/`             | **The app lock's vault (ADR #118), and the one file here shared by the canary build** — it lives in `app_identity::KEYSTORE_DIR` (`"HuginnDB"`) whatever `APP_DIR` says, for the reason `keychain::SERVICE` is shared (ADR #26): it *is* where the keychain's entries go while the lock is on. Exists only while the lock is on; its keychain marker `vault::enabled` holds the vault's id, so a missing file with the marker present is a broken vault, refused like a locked one. AES-256-GCM over the account → secret map under a random vault key, wrapped per *slot* (master password: Argon2id 256 MiB/t=3/p=1; Windows Hello next). A file that cannot be parsed is a hard error, never an empty vault — the `profiles.json` rule. Written with `state_file::write_atomic` through `state_file::keystore_path`; every write re-reads and reseals it, since two processes may share it. A debug build started with `HUGINNDB_LOCK_SANDBOX=1` uses `HuginnDB-LockSandbox` and the keychain service `io.huginndb.lock-sandbox` instead. |
| `*.window-state.json`   | `tauri-plugin-window-state` v2     | Plugin-owned; do not parse manually. Removes need for a hand-rolled `window.rs`. Tracks the `main` window only (`window_chrome::remembers`) — secondary windows get one-shot uuid labels, so their entries could never be restored. The one exception to "do not parse": `window_chrome::forget_unremembered_windows`, a command-less plugin registered just before this one, drops leftover non-`main` top-level keys and passes every value through untouched. |
| `pulse.db`              | `src-tauri/src/pulse/store.rs`     | **The one file here that is not JSON.** Pulse's on-disk history — a SQLite database (WAL, single `samples(connection_id, ts_ms, metric, value)` table), appended to by `pulse::sampler`'s 60 s tick rather than rewritten whole like every file above it; `state_file::save_atomic`'s whole-blob-atomic-rename pattern is exactly the write amplification a time series needs to avoid. `state_file::path("pulse.db")` still resolves *where* it lives — that function only resolves a path and creates the parent directory, it never assumes JSON — so canary isolation (ADR #26) applies here for free. Opened lazily (first sampler tick or first Retrospectiva read), so an install where nobody has enabled Pulse on any connection never creates the file. Retention is a staircase: 60 s resolution for 48 h, downsampled to one point per 5 min out to `PulsePrefs::retention_days` (30 by default), then deleted; a `maxDiskMb` soft cap sheds the oldest tenth of what remains if the file is still over budget after that. Sampling itself is opt-in per connection (`ConnectionProfile::pulse_enabled`, off by default, preserved across a shared-origin sync the same way `mcp_write` is) and reads only what `pulse::sampler` needs in one round trip — `db::mysql::pulse::sample`/`db::mongo::pulse::sample`, not the two-round-trip `health()` the live panel uses. |

Theme + dockview layout still live in `localStorage` (keys `huginndb.theme.v2` and `huginndb.layout`) — synchronous read pre-mount avoids FOUC. Don't migrate these to disk without a plan for the flash.

## Current status (post-session 3)

- Released 0.5.0: workspace switcher with reorder/colour/icon, "Copy row as ▸ JSON/INSERT/UPDATE" submenu, connection-level filter in multi-DB explorer, and the fix for the cell-save row-mismatch bug under client filters.
- Released 0.6.0 right after: Ctrl+Enter restored, per-statement "▶ Run" CodeLens, driver-aware keywords in the autocomplete (Postgres `RETURNING`, MySQL `ON DUPLICATE KEY UPDATE`, …) with tables-first sort.
- Backend has ~300 `cargo test`s (tab-state migrations and prune semantics included). The frontend has Vitest (`pnpm test`) covering the pure `lib/` modules and the extracted hooks — characterization tests written alongside each refactor, not a blanket suite. CI (`.github/workflows/ci.yml`) runs typecheck + Vitest + `cargo fmt`/`clippy`/`test` on Linux and Windows.
- Released 1.4.0: removed workspaces in favour of native per-window instances — "New window" in the new **Window** menu opens a blank, ephemeral secondary window; see ADR #8 and the `CHANGELOG.md` 1.4.0 entry. Same cycle also split the topbar File/View menus into four (File/Window/View/Help — File had accumulated unrelated window/help actions), fixed two bugs (`open_new_window` must be an `async fn` on Windows — sync commands deadlock creating a `WebviewWindow`, a WebView2 issue — and CLI ad-hoc launches without `--password` now always attempt the connect instead of silently staying disconnected), added server-side users/permissions introspection (a "Security" panel, implemented for every driver including SQLite's explicit no-user-model empty state — `commands::schema::list_users`/`list_privileges`), and added a background connection keepalive + lost-connection reconnect UX (`src-tauri/src/keepalive.rs` — a 3-minute heartbeat per top-level connection; a failed ping flags the connection in `stores/session/connectionHealth.ts` and both `ConnectionList`/`StatusConnections` offer a one-click reconnect instead of the user hitting a cryptic driver error mid-query).
- macOS is not a primary target; build should work but unverified.

## Roadmap

`ROADMAP.md` (repo root) is the single source of truth for what's shipped and
what's open — don't duplicate its list here, it will drift. Detail-level
roadmaps for two subsystems are tracked separately and still current:
`docs/MONGODB_ROADMAP.md` and `docs/MCP_CONNECTOR_ROADMAP.md`.

## Explicitly out of scope (don't propose unless asked)

- Adding a linter beyond the existing `tsc --noEmit` + `cargo fmt` / `cargo clippy` advice in CONTRIBUTING.
- AI features **that are cloud-by-default**, and LLM-driven autocomplete in the Monaco editor (different latency/cost profile from a chat panel). The **AI panel** itself is in scope and **shipped** — local-first, read-only, off by default; `docs/AI_ROADMAP.md` is the spec it was built from and `docs/AI.md` documents what exists. Its invariants are not negotiable defaults: the frontend never addresses an endpoint (only `ai::provider::request` can), no write tool exists at all, endpoint trust is declared rather than sniffed, and metadata-only *removes* the row tools instead of refusing them (ADRs #71–#73 and gotcha #74). Consuming a user's Claude/ChatGPT *subscription* stays impossible rather than out of scope: it is not available to third-party apps, and the sanctioned path for "use my own licence" is the existing MCP connector.
- Cloud sync of profiles or saved queries.
- Mobile builds — the Tauri icon CLI generated iOS/Android directories during scaffolding, but desktop is the focus.

## Tasks that come from Muninn

Muninn is Alex's task board, reached through its MCP server (`list_tasks`, `move_task`, `update_task`; project **HuginnDB**, columns Backlog → Pendiente → En curso → Revisión → Hecho). **When a task comes from Muninn, keeping its state current is part of doing it — the default, not something to be asked for.**

- Starting it (or handing it to a child session): move it to **En curso** and note the session/branch in its description.
- A "Por aclarar" line that Alex answers is rewritten as "Aclarado con Alex: …" — the card is where the next agent will read the context.
- PR opened: move it to **Revisión** and add the PR link plus what is verified and what is not (CI, tested in the real app).
- **Hecho** only once Alex has merged it — he merges by hand, so an open PR is not done.
- A child session gets the task's id in its brief; whichever session receives the outcome updates the card, so it never lags behind the PRs.

## When the user asks for "the next thing"

- Default to the **top open item in `ROADMAP.md`'s numbered "Open" list** unless
  they say otherwise.
- **`ROADMAP.md` has a second list: "Fit and finish".** It is a standing track,
  not a backlog that waits for the numbered one to empty, and the convention is
  that **each minor release closes at least two of its entries**. Check it when
  planning a release, not only when asked for "the next thing" — the reason it
  exists is that polish was never in the queue at all, so the queue could never
  produce one. Entries name something observable (a file and line, a count, a
  behaviour) and fall into one of four classes; the adoption-debt class is
  machine-counted by `src/components/ui/uiAdoption.test.ts`, whose budgets are
  sorted by debt and double as its worklist.
- Always ask before adding new dependencies; the user prefers a small, audited tree.
- Keep PRs / commits scoped. The user values legible history and will read the long-form commit body.

## Communication style

- Replies in Spanish, terse, no fluff. The user reads diffs and runs commands themselves; they don't need a walkthrough.
- One sentence before a tool batch is enough.
- End-of-turn summary: ≤ 2 sentences. What landed, what's next.
- When proposing a non-trivial change, ask 1–2 scoping questions with `AskUserQuestion` rather than guessing.
