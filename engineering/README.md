# Engineering notes

Internal documentation for AI coding agents (Claude Code and similar) and contributors working on HuginnDB. It is deliberately kept **outside `docs/`**: `docs/*.md` is auto-indexed into the app's own Documentation viewer (see [ADR #50](adr/adr-050-docs-viewer-markdown-derived-navigation.md)), and none of this is meant for end users.

Before touching code in an area with history (Zustand, Monaco, tab_state, MySQL/MongoDB decoding, dockview, environments, MCP, policy, …), find the entries for that area and read them in full — a one-line summary is not a substitute.

## Three kinds of entry

These notes used to be one list of "hard-earned gotchas". Read one by one, most of them were not gotchas at all: they were decisions, plus a handful of house rules. They are now filed by what they are, because each kind is read, written and retired differently.

| | [**ADR**](adr/README.md) | [**Gotcha**](gotchas/README.md) | [**Convention**](conventions/README.md) |
| --- | --- | --- | --- |
| What it records | A **choice** we made among alternatives, and why | A **fact** about something outside our design (a library, driver, platform, CI, an LLM) where the obvious code breaks | A **rule** for how code is written here |
| Could it be otherwise? | Yes — revisit it when the context changes, and leave a record | No — it holds for as long as the dependency behaves this way | Yes, by agreement |
| Shape | Context → decision → alternatives rejected → consequences | Symptom → cause → what to do | The rule, then why |
| How it ends | **Superseded** by a newer ADR | **Obsolete** when the dependency fixes it, or superseded by a better note | Edited in place, or superseded |

**The test:** *would this still be true if HuginnDB were rewritten from scratch with a different design?* Yes → gotcha. No → ADR or convention. A convention governs many call sites ("`components/ui/` imports nothing stateful"). An ADR settles one question ("origins are a global registry, not per-environment state").

**Traps that drove a decision are ADRs.** "WiX's `light.exe` fails on CI runners, so the installer is NSIS" is an ADR whose context is an external trap. What you would revisit is the choice, not the fact. Those ADRs set `triggered_by_external_trap: true`, and the [gotchas index](gotchas/README.md) lists them next to the pure gotchas, so it still works as "everything that bites, by technology".

## Numbering

**Every entry keeps one number from one global sequence, whatever its kind.** `#54` is an ADR and `#19` is a gotcha, and no two entries share a number. Code comments, docs and released changelog entries cite these numbers. Older text says "gotcha #54" for what is now ADR #54, and the number still resolves: look it up in the table below. A new entry takes the next free number, whatever its kind.

Files are named `<type>-NNN-<slug>.md` and live in the folder for their kind. When citing one, use its kind's noun: `ADR #54`, `gotcha #19`, `convention #28`.

## Lifecycle

- **Front matter is the source of truth** for type, status, date, tags and links between entries. The indexes are generated from it: run `node scripts/engineering-index.mjs` after adding or changing an entry (`--check` reports a stale index without writing).
- **A changed decision is a new ADR.** Set `supersedes: [N]` on the new one, and `status: superseded` plus `superseded_by: M` on the old one. Leave the old body alone: it is the record of why things were the way they were. Use `amends` when a later entry replaces only part of an earlier one (ADR #47 turns one bullet of ADR #32 into a compile error and leaves the rest standing).
- **Addenda** (a dated `## Addendum (YYYY-MM-DD)` section) are for clarifications and changes of grain that leave the decision itself standing, as ADR #54's does. If the decision itself changes, write a new ADR.
- **`date`** is when the entry was first recorded. For entries that predate this folder, it was recovered from `CLAUDE.md`'s history.
- Templates: [`templates/`](templates/).

## Index

<!-- index:start -->
117 entries: 93 ADRs, 15 gotchas, 9 conventions.

| # | Type | Title | Status | Date |
| - | ---- | ----- | ------ | ---- |
| 1 | Gotcha | [Zustand selectors must be reference-stable](gotchas/gotcha-001-zustand-selector-stability.md) | active | 2026-05-13 |
| 2 | ADR | [Monaco is bundled, never CDN-loaded](adr/adr-002-monaco-bundled-not-cdn.md) | accepted | 2026-05-13 |
| 3 | Gotcha | [tauri::State does not auto-deref into &T](gotchas/gotcha-003-tauri-state-inner-deref.md) | active | 2026-05-13 |
| 4 | Convention | [quote_ident is for catalog identifiers, not user input](conventions/convention-004-quote-ident-catalog-only.md) | active | 2026-05-13 |
| 5 | ADR | [update_cell's value is Option<String> end-to-end](adr/adr-005-update-cell-option-string.md) | accepted | 2026-05-13 |
| 6 | ADR | [MySQL order_clause no longer string-rewrites identifiers](adr/adr-006-mysql-order-clause-quoting.md) | accepted | 2026-05-13 |
| 7 | ADR | [DataGrid mutation callbacks use row values, not a row index](adr/adr-007-datagrid-row-identity-not-index.md) | accepted | 2026-05-20 |
| 8 | ADR | [tab_state.json is v5 environments, main-window-only](adr/adr-008-tab-state-environments-main-window-only.md) | accepted | 2026-05-20 |
| 9 | Gotcha | [Monaco commands are per-editor; providers are global to the language](gotchas/gotcha-009-monaco-ctrl-enter-global-providers.md) | active | 2026-05-20 |
| 10 | ADR | [The nested workspace dockview is synced from useTabs one way](adr/adr-010-dockview-synced-to-usetabs.md) | accepted | 2026-05-27 |
| 11 | Gotcha | [sqlx rejects Vec<u8> reads on a MySQL BIT column](gotchas/gotcha-011-mysql-bit-vecu8-rejected.md) | superseded → #15 | 2026-05-30 |
| 12 | ADR | [Double-click on a grid cell edits inline, not in a modal](adr/adr-012-datagrid-inline-cell-edit.md) | accepted | 2026-05-30 |
| 13 | ADR | [Grid "zoom" is one persisted rowHeight preference](adr/adr-013-grid-zoom-row-height-pref.md) | accepted | 2026-05-30 |
| 14 | Gotcha | [An undeclared field on a typed IPC struct is silently dropped](gotchas/gotcha-014-serde-drops-undeclared-fields.md) | active | 2026-06-01 |
| 15 | Gotcha | [MySQL integer and BIT decoding is width- and type-specific](gotchas/gotcha-015-mysql-integer-bit-decoding.md) | active | 2026-06-01 |
| 16 | ADR | [The structure editor builds DDL in Rust, never in the component](adr/adr-016-structure-editor-ddl-in-rust.md) | accepted | 2026-06-02 |
| 17 | Gotcha | [MySQL BLOB vs TEXT is decided by content, not the type name](gotchas/gotcha-017-mysql-blob-text-content-sniffing.md) | active | 2026-06-06 |
| 18 | ADR | [SSH tunnel bind falls back to an ephemeral port on collision](adr/adr-018-ssh-tunnel-port-fallback.md) | accepted | 2026-06-06 |
| 19 | Gotcha | [Building a WebviewWindow must happen inside an async Tauri command](gotchas/gotcha-019-webview-window-builder-async-fn.md) | active | 2026-07-01 |
| 20 | ADR | [huginndb-mcp lives in its own workspace crate, never a second [[bin]]](adr/adr-020-mcp-sidecar-separate-workspace-crate.md) | accepted | 2026-07-14 |
| 21 | ADR | [Windows installer target is NSIS, not MSI/WiX](adr/adr-021-windows-installer-nsis-not-msi.md) | accepted | 2026-07-14 |
| 22 | ADR | [huginndb-mcp ships as a Tauri externalBin sidecar staged by CI](adr/adr-022-mcp-sidecar-external-bin-staging.md) | accepted | 2026-07-14 |
| 23 | Gotcha | [A running huginndb-mcp.exe blocks the self-updater's overwrite](gotchas/gotcha-023-mcp-sidecar-blocks-updater.md) | active | 2026-07-15 |
| 24 | ADR | [The updater polls periodically but only installs on an explicit click](adr/adr-024-updater-periodic-checks-install-gating.md) | accepted | 2026-07-15 |
| 25 | Gotcha | [An untargeted frontend listener receives every window's emit_to](gotchas/gotcha-025-tauri-listen-target-scoping.md) | active | 2026-07-20 |
| 26 | ADR | [Canary isolates on-disk state but deliberately shares the keychain](adr/adr-026-canary-state-isolation-shared-keychain.md) | accepted | 2026-07-23 |
| 27 | ADR | [An environment scopes session state, not which connections exist](adr/adr-027-environment-scopes-session-not-connections.md) | accepted | 2026-07-29 |
| 28 | Convention | [components/ is grouped by domain with an optional dialogs/ subfolder](conventions/convention-028-components-domain-grouped-dialogs.md) | active | 2026-07-31 |
| 29 | ADR | [The Mongo list view edits using row_types, not the display JSON's types](adr/adr-029-document-list-view-row-types.md) | accepted | 2026-08-12 |
| 30 | ADR | [All per-engine SQL text goes through db::sql::Dialect](adr/adr-030-dialect-single-sql-builder.md) | accepted | 2026-08-05 |
| 31 | ADR | [SQL Server needs its own pool (tiberius) and four T-SQL divergences](adr/adr-031-mssql-tiberius-pool-and-tsql.md) | accepted | 2026-08-05 |
| 32 | ADR | [The command palette's index lives in lib/; settings navigation is a string contract](adr/adr-032-command-palette-index-separate-from-component.md) | accepted | 2026-08-13 |
| 33 | ADR | [A MongoDB view is a stored pipeline, so its editor is the aggregation editor](adr/adr-033-mongo-view-is-aggregation-pipeline.md) | accepted | 2026-08-17 |
| 34 | ADR | [MongoDB indexes are read from raw listIndexes, never mongodb::IndexModel](adr/adr-034-mongo-indexes-raw-not-indexmodel.md) | accepted | 2026-08-17 |
| 35 | ADR | [An environment's export is cosmetics + connections + origins, never session state](adr/adr-035-environment-export-portable-identity.md) | accepted | 2026-08-18 |
| 36 | ADR | [Schema refresh must target the child slice, not the parent connection id](adr/adr-036-schema-refresh-multi-db-scoping.md) | accepted | 2026-08-18 |
| 37 | ADR | [SQL Server accepts SSMS's HOST\INSTANCE in either field, split centrally](adr/adr-037-mssql-host-instance-splitting.md) | accepted | 2026-08-18 |
| 38 | ADR | [MongoDB can rename a collection but genuinely cannot rename a view](adr/adr-038-mongo-rename-collection-not-view.md) | accepted | 2026-08-18 |
| 39 | ADR | [JSON Schema bindings are global metadata resolved by a Rust-only cascade](adr/adr-039-json-schema-binding-cascade-global.md) | accepted | 2026-08-19 |
| 40 | ADR | [Shared origins are a global registry, not per-environment state](adr/adr-040-shared-origins-global-registry.md) | accepted | 2026-08-20 |
| 41 | ADR | [Every JSON state file's path, load and atomic save go through state_file.rs](adr/adr-041-state-file-single-io-module.md) | accepted | 2026-08-20 |
| 42 | ADR | [db::exec is the one place SQL actually runs, not scattered pool matches](adr/adr-042-db-exec-single-execution-layer.md) | accepted | 2026-08-21 |
| 43 | ADR | [Catalog SQL lives in db/<driver>/schema.rs; DTOs stay with the command](adr/adr-043-catalog-sql-driver-owned-dtos-command-owned.md) | accepted | 2026-08-21 |
| 44 | ADR | [useAsyncSubmit deliberately keeps submitting true after success](adr/adr-044-use-async-submit-stays-true-on-success.md) | accepted | 2026-08-21 |
| 45 | Convention | [Three frontend seams that must keep their intentional divergence](conventions/convention-045-intentional-shared-code-divergences.md) | active | 2026-08-21 |
| 46 | ADR | [The three import dialogs share useImportWizard with one default conflict action](adr/adr-046-import-wizard-shared-skip-default.md) | accepted | 2026-08-21 |
| 47 | ADR | [PrefId is derived from Preferences, making ADR #32's contract a compile error](adr/adr-047-prefid-compile-time-derived.md) | accepted | 2026-08-21 |
| 48 | ADR | [drop_view must verify the name is actually a view before dropping it](adr/adr-048-mongo-drop-view-type-check.md) | accepted | 2026-08-21 |
| 49 | Convention | [Three MCP write-tool wiring steps aren't compiler-enforced, unlike the rest](conventions/convention-049-mcp-write-tool-checklist-unenforced-arms.md) | active | 2026-08-21 |
| 50 | ADR | [The docs viewer slices navigation from the markdown itself, in one scan](adr/adr-050-docs-viewer-markdown-derived-navigation.md) | accepted | 2026-08-24 |
| 51 | ADR | [Markdown's navigator is React context, and its scroll-to-anchor clears last](adr/adr-051-markdown-navigator-context-scroll-order.md) | accepted | 2026-08-24 |
| 52 | Convention | [cargo test writes to the real state directory unless a seam prevents it](conventions/convention-052-cargo-test-real-state-directory-risk.md) | active | 2026-08-25 |
| 53 | ADR | [A keystroke resolves in exactly one place; scope comes from the DOM](adr/adr-053-keybinding-dispatch-single-resolver-dom-scope.md) | accepted | 2026-08-25 |
| 54 | ADR | [A statement's write tier is classified from its text in exactly one place](adr/adr-054-statement-classify-text-based-single-source.md) | accepted | 2026-08-25 |
| 55 | ADR | [The schema tree filter never opens connections and has one owner](adr/adr-055-schema-tree-search-single-owner-no-prefetch.md) | accepted | 2026-08-26 |
| 56 | ADR | [The shared-origin editor edits a document with three load-bearing rules](adr/adr-056-origin-doc-editor-merge-rules.md) | accepted | 2026-08-26 |
| 57 | ADR | [The Mongo completion provider uses a cursor scanner, not a parser](adr/adr-057-mongo-pipeline-completion-context-scanner.md) | accepted | 2026-08-31 |
| 58 | ADR | [MCP exposure lives on the profile; --connections has three distinct states](adr/adr-058-mcp-exposed-set-profile-tri-state-flag.md) | accepted | 2026-09-01 |
| 59 | ADR | [MCP tool annotations are read once at startup, so they must be constants](adr/adr-059-mcp-tool-annotation-constants-split.md) | accepted | 2026-09-01 |
| 60 | Convention | [components/ui/ has a strict dependency rule, one density scale, three focus styles](conventions/convention-060-ui-library-dependency-rule-density-focus.md) | active | 2026-09-01 |
| 61 | Convention | [Feedback and transition state follow a written doctrine in CONTRIBUTING.md](conventions/convention-061-feedback-transition-state-doctrine.md) | active | 2026-09-02 |
| 62 | Gotcha | [Windows' default 1 MiB main-thread stack is too small for the structure/view introspection chain in release](gotchas/gotcha-062-windows-main-thread-stack-reserve.md) | active | 2026-09-04 |
| 63 | ADR | [The clipboard is read and written natively, never through `navigator.clipboard`](adr/adr-063-clipboard-native-plugin-not-webview.md) | accepted | 2026-09-07 |
| 64 | ADR | [Notifications have two anatomies and one escalation rule, decided at the seam](adr/adr-064-notification-pill-card-escalation.md) | accepted | 2026-09-07 |
| 65 | ADR | [A describe has two halves, and the best-effort half must never decide whether the authoritative one runs](adr/adr-065-describe-relation-two-halves-lenient-view.md) | accepted | 2026-09-07 |
| 66 | ADR | [sqlx's eager `connect()` discards why it failed, so an unreachable host was reported as "too many connections"](adr/adr-066-sqlx-eager-connect-masks-the-real-cause.md) | accepted | 2026-09-08 |
| 67 | ADR | [a pool the MCP bridge opened is not a connection the user opened, and the reaper's exemption assumed it was](adr/adr-067-bridge-opened-pools-are-not-user-connections.md) | accepted | 2026-09-08 |
| 68 | ADR | [MongoDB's client is lazy, so `connect` could not fail — and the app announced success for a server that never answered](adr/adr-068-mongo-lazy-client-connect-cannot-fail.md) | accepted | 2026-09-09 |
| 69 | ADR | [A shared origin's credentials move in two directions, and each has exactly one door](adr/adr-069-secret-write-through-and-local-override.md) | accepted | 2026-09-09 |
| 70 | ADR | [The MongoDB form owns the options it models and carries the rest; raw-edit is not a one-way door](adr/adr-070-mongo-uri-form-raw-round-trip.md) | accepted | 2026-09-09 |
| 71 | ADR | [The AI tool catalogue is a second presentation over BridgeRequest, and its exposure match has no `_` arm](adr/adr-071-ai-catalogue-exhaustive-over-bridge-request.md) | accepted | 2026-09-10 |
| 72 | ADR | [Metadata-only removes the row tools from the catalogue instead of refusing them at call time](adr/adr-072-metadata-only-removes-tools-not-refuses.md) | accepted | 2026-09-10 |
| 73 | ADR | [A tool result must be bounded in size, not in rows — Ollama truncates from the front](adr/adr-073-tool-result-budget-is-bytes-not-rows.md) | accepted | 2026-09-10 |
| 74 | Gotcha | [A tool's description is read at the decision point, so it must never tell the model to delegate the tool's own job](gotchas/gotcha-074-tool-description-read-at-decision-point.md) | active | 2026-09-10 |
| 75 | Convention | [A feature-gated test fixture rots invisibly when CI only runs on main and pull requests](conventions/convention-075-feature-gated-fixtures-rot-invisibly.md) | active | 2026-09-10 |
| 76 | ADR | [A statement's tier is the strictest tier in the whole string, not the tier of its first keyword](adr/adr-076-statement-tier-is-the-max-over-a-batch.md) | accepted | 2026-09-10 |
| 77 | ADR | [A refusal is prompt text too — it must name the fix the model can apply, and the classifier is part of the prompt](adr/adr-077-a-refusal-is-prompt-text-and-must-name-the-fix.md) | accepted | 2026-09-10 |
| 78 | ADR | [When a small model will not follow an instruction, detect the failure instead of writing the instruction again](adr/adr-078-detect-the-failure-instead-of-prompting-harder.md) | accepted | 2026-09-10 |
| 79 | ADR | [A data assistant asks for a low temperature, and `temperature` / `reasoning_effort` are mutually exclusive](adr/adr-079-low-temperature-and-mutually-exclusive-with-effort.md) | accepted | 2026-09-10 |
| 80 | ADR | [An agent needs breadth before depth — hand it the table map, and let the user write down what the schema cannot say](adr/adr-080-breadth-before-depth-map-and-notes.md) | accepted | 2026-09-10 |
| 81 | ADR | [MongoDB's filterable fields are a sample of the page, not a catalog — and a query path must not carry an array index](adr/adr-081-nested-field-paths-in-the-filter-are-a-page-sample.md) | accepted | 2026-09-10 |
| 82 | Convention | [Dialogs have three tiers and one seam contract, decided in `ui/dialog.tsx`](conventions/convention-082-dialog-tiers-scrim-and-coupled-tabs.md) | active | 2026-09-11 |
| 83 | ADR | [An origin's consumption scope is the one per-resource flag that defaults to ON](adr/adr-083-origin-consumption-scope-defaults-open.md) | accepted | 2026-09-14 |
| 84 | ADR | [Pasted JSON rows are catalogue-gated, refused when heterogeneous, and chunked inside one transaction](adr/adr-084-json-row-insert-catalogue-gated-and-transactional.md) | accepted | 2026-09-15 |
| 85 | Gotcha | ["Adjust state when a prop changes" must remember the previous prop in *state* — a ref survives the render StrictMode throws away](gotchas/gotcha-085-adjust-state-during-render-needs-state-not-a-ref.md) | active | 2026-09-16 |
| 86 | ADR | [Formatting a cell *on open* must refuse any reformat that changed more than whitespace](adr/adr-086-auto-format-on-open-must-refuse-a-lossy-reformat.md) | accepted | 2026-09-17 |
| 87 | ADR | [A VS Code theme is *translated* into Monaco and *derived* into the chrome — and alpha is resolved at import, not in the pipeline](adr/adr-087-vscode-theme-import-derives-chrome-translates-editor.md) | accepted | 2026-09-17 |
| 88 | ADR | [The theme registry is a dock panel, its destination is decided in Rust, its packages are verified, and the library splits from the palettes by *shape*](adr/adr-088-theme-registry-backend-owns-the-destination.md) | accepted | 2026-09-17 |
| 89 | ADR | [A blank port means the driver's default, and `tiberius` aims its SQL Browser lookup at whatever port the `Config` carries](adr/adr-089-a-blank-port-means-the-drivers-default.md) | accepted | 2026-09-18 |
| 90 | ADR | [An id validated against an asynchronously-filled registry must be *derived* from a store, not sampled from a module-level `Map`](adr/adr-090-async-registry-id-must-be-derived-not-sampled.md) | accepted | 2026-09-18 |
| 91 | ADR | [A filter's value type must come from the same sample the grid header shows — and on a schemaless store the user gets the last word](adr/adr-091-filter-value-type-comes-from-the-page.md) | accepted | 2026-09-22 |
| 92 | ADR | [A timeout is a claim about someone else's server, so it cannot be a constant — and the function that applies it must know which connection it is bounding](adr/adr-092-the-introspection-ceiling-belongs-to-the-server.md) | accepted | 2026-09-22 |
| 93 | ADR | [A statement's tier is read from its text, so a read an AI sends must also be run where the database refuses to write](adr/adr-093-a-read-is-proven-by-the-database-not-the-text.md) | accepted | 2026-09-24 |
| 94 | ADR | [A managed policy binds the AI at `bridge::exec::execute`, only ever narrows, and fails closed](adr/adr-094-managed-policy-binds-the-ai-at-one-function.md) | accepted | 2026-09-24 |
| 95 | ADR | [A person is guarded in each `#[tauri::command]` wrapper, never in the `_inner` core, and a test proves every command says what it needs](adr/adr-095-people-are-guarded-in-the-command-wrappers.md) | accepted | 2026-09-24 |
| 96 | ADR | [A policy lock in the interface is advisory, reads as allowed until answered, and is asked for in batches](adr/adr-096-policy-locks-are-advisory-and-batched.md) | accepted | 2026-09-24 |
| 97 | ADR | [A person's own database user is decided in one function, keys the keychain, and stops the shared secret from landing](adr/adr-097-a-personal-database-user-is-decided-in-one-place.md) | accepted | 2026-09-24 |
| 98 | ADR | [A role's grants are built by a pure function from the live catalog, expand every pattern, and are never run by HuginnDB](adr/adr-098-grants-are-built-pure-from-the-live-catalog.md) | accepted | 2026-09-24 |
| 99 | ADR | [The policy editor lets the share decide who edits, validates text it never re-serializes, and never leaves the path without a file](adr/adr-099-the-policy-editor-trusts-the-share-and-never-reserializes.md) | accepted | 2026-09-24 |
| 100 | ADR | [The policy editor's draft is text, the form is a view of it, and it opens for everyone](adr/adr-100-the-policy-editor-draft-is-text.md) | accepted | 2026-09-24 |
| 101 | ADR | [A full-screen editor puts aside the workbench it was opened from, then gives it back](adr/adr-101-full-screen-editors-suspend-and-resume-settings.md) | accepted | 2026-09-25 |
| 102 | ADR | [The `.mcpb` hands the session to the connector installed with the app](adr/adr-102-the-mcpb-hands-over-to-the-installed-connector.md) | accepted | 2026-09-28 |
| 103 | ADR | [The headless updater installs unattended, branches off before the Builder, and is launched in layers](adr/adr-103-headless-updater-installs-unattended.md) | accepted | 2026-09-28 |
| 104 | ADR | [a connection belongs to the windows holding it, and the app closes every pool on the way out](adr/adr-104-a-pool-belongs-to-the-windows-holding-it.md) | accepted | 2026-10-06 |
| 105 | ADR | [an SSH tunnel redials its own session, views ride their parent's tunnel, and every pool check is bounded](adr/adr-105-ssh-tunnels-heal-and-pool-checks-are-bounded.md) | accepted | 2026-10-06 |
| 106 | ADR | [a reservation is not an open connection, and a server's budget is shared adaptively](adr/adr-106-reserved-is-not-open-and-the-share-adapts.md) | accepted | 2026-10-07 |
| 107 | ADR | [the terminal's sessions are owned by the component that shows them, and `mongosh` signs in as the open pool](adr/adr-107-the-terminal-owns-its-sessions-and-mongosh-signs-in-as-the-pool.md) | accepted | 2026-10-15 |
| 108 | ADR | [The schema tree is one flat, virtualised list, and its side effects follow the expanded structure, not mounted components](adr/adr-108-the-schema-tree-is-one-flat-virtualised-list.md) | accepted | 2026-10-15 |
| 109 | ADR | [`mongosh` is downloaded on request from MongoDB's own feed, verified against its published SHA-256, and kept in a per-user directory — never bundled in the installer](adr/adr-109-mongosh-is-downloaded-on-request-from-mongodb-not-bundled.md) | accepted | 2026-10-16 |
| 110 | ADR | [a tunnel holds one SSH session — a slow channel is not a dead session, and a replaced session is closed](adr/adr-110-a-tunnel-holds-one-ssh-session.md) | accepted | 2026-10-19 |
| 111 | ADR | [a tunnel whose redial failed waits before dialling again, and fails every channel at once meanwhile](adr/adr-111-a-failed-redial-backs-off.md) | accepted | 2026-10-19 |
| 112 | ADR | [a write batch is one transaction of single row writes, and its verify reads run after the commit as ordinary reads](adr/adr-112-a-write-batch-is-one-transaction-and-verify-runs-after-it.md) | accepted | 2026-10-20 |
| 113 | ADR | [a policy rule limits columns per verb, judged as a union beside the relation's verb, and free-form writes close under a limited verb](adr/adr-113-policy-column-limits-are-per-verb-and-unioned.md) | accepted | 2026-10-25 |
| 114 | ADR | [a pasted block is planned in the grid, confirmed, and written by the backend in one transaction](adr/adr-114-a-pasted-block-is-planned-in-the-grid-and-written-in-one-transaction.md) | accepted | 2026-10-25 |
| 115 | Gotcha | [`russh` signs an RSA key with `ssh-rsa` (SHA-1) unless it is told the hash, and OpenSSH 8.8+ refuses that](gotchas/gotcha-115-russh-rsa-key-without-hash-signs-sha1.md) | active | 2026-10-26 |
| 116 | Gotcha | [tiberius 0.13 bounds every query at 30 s and the handshake at 15 s by default, and its connect future is three times larger](gotchas/gotcha-116-tiberius-013-default-timeouts.md) | active | 2026-10-26 |
| 117 | ADR | [the tunnel never asks for a host certificate, and one that arrives anyway is pinned by the key it certifies](adr/adr-117-a-host-certificate-is-pinned-by-the-key-it-certifies.md) | accepted | 2026-10-26 |
<!-- index:end -->
