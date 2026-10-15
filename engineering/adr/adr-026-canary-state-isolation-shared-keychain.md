---
id: 26
type: adr
status: accepted
date: 2026-07-23
tags: [state-files, build, security]
triggered_by_external_trap: false
related: [8, 41]
supersedes: []
superseded_by: null
amends: []
---

# ADR #26: Canary isolates on-disk state but deliberately shares the keychain

`app_identity::APP_DIR` flips to `"HuginnDB-Canary"` under the `canary` feature so every state file lands in a separate config dir, while the keychain service stays build-unaware on purpose so canary can dogfood real profiles. Never hardcode `"HuginnDB"` for a new state file.

**Decision:** Under the canary feature APP_DIR flips to "HuginnDB-Canary" so every state file lives in a separate config dir, while keychain::SERVICE stays io.huginndb.app so canary reuses production passwords.

**Alternatives rejected:**

- A build-aware keychain service: canary could not reuse production passwords, defeating dogfooding real profiles.
- Aliasing or hardcoding "HuginnDB" in each state module (six of them): six chances to break canary isolation, replaced by state_file::path and APP_DIR.
- Building the bundled MCP sidecar as canary: not worth a feature passthrough in the mcp-server crate.

## Detail

**The canary channel isolates on-disk state but shares the keychain — and the state-dir name has ONE source of truth (`src-tauri/src/app_identity.rs`).** The canary build (Cargo feature `canary` + `tauri.canary.conf.json`, workflow `.github/workflows/canary.yml`, docs `docs/CANARY.md`) exists so a maintainer can dogfood a pre-release against production profiles without cutting a release. It's a *separate app*: distinct bundle identifier (`io.huginndb.canary`), product name, and its own rolling updater feed (the `canary` GitHub release's `latest.json`), installable side-by-side with stable. The one thing that makes it safe is that `crate::app_identity::APP_DIR` flips to `"HuginnDB-Canary"` under `#[cfg(feature = "canary")]`, so every state file lands in a separate config dir and a destructive one-way migration (e.g. tab-state v2→v3, ADR #8) can't corrupt the stable install. **`APP_DIR` used to be aliased into all six state modules, which was six chances to get it wrong; the five JSON state files now resolve their paths through `state_file::path` (ADR #41), so `APP_DIR` has exactly four consumers left: `state_file.rs`, `bridge/mod.rs`'s discovery file, `mcp/mod.rs`'s audit log, and `commands/app.rs` (which just reports the directory to the UI). Do NOT re-hardcode `"HuginnDB"` anywhere — a new JSON state file goes through `state_file`, and anything else takes `crate::app_identity::APP_DIR`, or the canary isolation silently breaks for that file.** Conversely, the keychain service (`keychain::SERVICE`) is deliberately **NOT** build-aware: canary shares `io.huginndb.app` so it reuses production passwords without the user re-entering them (isolating state but sharing credentials is the whole point — test real profiles, protect real state). The canary version is stamped `<base>-canary.<run_number>` by the workflow (prerelease suffix → always sorts below the equivalent stable version, so a canary never outranks a real release). The bundled MCP sidecar is built *stable*, not canary (its only `APP_DIR` use is the audit log; not worth a feature passthrough in the `mcp-server` crate) — noted in `docs/CANARY.md`. When editing `tauri.canary.conf.json`, remember Tauri's config merge **replaces arrays wholesale** (doesn't element-merge), which is why the overlay repeats the full `app.windows[0]` object rather than just the changed `title`.
