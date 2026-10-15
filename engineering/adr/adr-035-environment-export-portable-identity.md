---
id: 35
type: adr
status: accepted
date: 2026-08-18
tags: [environments, origins, state-files]
triggered_by_external_trap: false
related: [10]
supersedes: []
superseded_by: null
amends: []
---

# ADR #35: An environment's export is cosmetics + connections + origins, never session state

`export_environments`/`import_environment` round-trip a dedicated file format that excludes tabs, layout and launch state as machine-local artifacts, dedupes shared connection profiles across bundled environments, and import always mints fresh environment ids rather than merging.

**Decision:** An environment export is cosmetics + connections + origins (deduplicated profile pool, multi-environment bundles), never tabs/layout/launch state, and import always mints new environments with profile conflicts resolved once per file.

**Alternatives rejected:**

- Exporting tabs/dockview geometry/launch state: machine-local session artifacts.
- One copy of profiles per bundled environment: would duplicate profiles, secrets and keychain entries.
- Merging on import: every bundle mints a fresh environment id instead.
- Exporting origin passphrases: the secret travels out-of-band.
- Auto-connecting imported connections: must not silently open N live connections.

## Detail

**An environment's export is its *portable identity* — cosmetics + connections + origins — never its tabs, layout or launch state, and import always creates NEW environments.** `export_environments`/`analyze_environment_import`/`import_environment` (`commands/prefs.rs`) round-trip an `EnvironmentExportFile` (`transfer.rs`), which shares `ExportMetadata` with the plain profile-bundle `ExportFile` via a `meta.kind` discriminant (`"profiles"` vs `"environment"`, defaulting to `""` ≡ `"profiles"` for files written before the field existed) — each importer rejects the other's file with a clear error instead of silently importing half of it.
    - **A single export can bundle more than one environment.** `EnvironmentExportFile.environments: Vec<ExportedEnvironmentBundle>` plus one **deduplicated** `profiles: Vec<ExportedProfile>` pool — not one copy of `profiles` per environment. Two selected environments sharing a connection (a common "Producción"/"Staging" split against the same jump box) would otherwise duplicate that profile, its secrets, and, on import, its keychain entry. Each bundle instead lists which of the shared pool it references via `connection_ids` (original, pre-import ids). `export_environments(ids: Vec<String>, …)` takes the whole selection at once — the frontend's `ExportEnvironmentDialog` is a checklist (mirroring `ExportProfilesDialog`), reachable both from File → "Export environments…" (defaults to everything checked) and from a per-row shortcut in `EnvironmentSwitcher` (pre-checks just that row) via the shared `useEnvironmentTransfer` store's `openExport(ids?)`.
    - **Tabs/dockview geometry/launch state are deliberately excluded.** They're session artifacts tied to the machine that produced them (ADR #10's dockview blob is keyed to that machine's `useTabs` panel ids), not part of what makes an environment portable. What travels is the environment's cosmetics (name/color/icon/theme) plus the connection profiles it references — resolved by `referenced_profile_ids` as the union of `connections` map keys, `launch.active_connections`, `selected_connection_id`, `visible_connections` and `database_visibility` keys, since none of those individually is guaranteed to list every connection the environment has ever touched.
    - **Import never merges.** Every bundle in the file mints a fresh environment id, which is what makes conflicts a non-issue for everything except connection profiles (`profiles.json` is global, so those genuinely can collide) — resolved **once for the whole file**, not per environment, reusing `import_profiles`'s exact `ConflictAction`/`ImportResult` machinery via the extracted `apply_profile_imports` (`commands::connection`). That function's second return value is an original-id → new-id map, which `import_environment` uses to translate each bundle's `connection_ids` into `launch.visible_connections` for its new environment — a skipped profile simply has no entry and is dropped from that environment's filter. Origins and each environment's own cosmetics never need a resolution step: there is nothing pre-existing for a brand-new environment to conflict with.
    - **An origin's export is name + path only, never a passphrase** — same threat model `origins.rs` already documents (the secret travels out-of-band). An imported encrypted origin surfaces the same "no passphrase stored" state a freshly `add_origin`-ed one would; there is no special "needs passphrase" step in the import result, because the existing per-origin sync-error surfacing (`useOriginSync.errors`) already covers it.
    - **Each new environment's connection tree is scoped via `launch.visible_connections`**, not a new mechanism — set to exactly its bundle's (translated) profile ids so the environment reads as "these connections", the same DataGrip-style filter #107 already added. None are auto-connected (`launch.active_connections` stays empty): importing an environment must not silently open N live database connections.
