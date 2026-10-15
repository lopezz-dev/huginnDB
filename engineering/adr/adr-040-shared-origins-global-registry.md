---
id: 40
type: adr
status: accepted
date: 2026-08-20
tags: [origins, environments, state-files]
triggered_by_external_trap: false
related: [10, 27, 39]
supersedes: []
superseded_by: null
amends: []
---

# ADR #40: Shared origins are a global registry, not per-environment state

`tab_state.json` v5 moved origins out of `Environment` into a top-level, deduped-by-path registry, for the same reason JSON Schema bindings are global (ADR #39). Vanished-origin detection has both a proactive notice and a durable reconciliation sweep as a fallback.

**Decision:** Shared origins are a global registry in tab_state.json v5 (PersistedTabState.origins), migrated from v4 by deduping on path with id remapping, with both a proactive vanished-origin notice and a durable reconcileOrphans sweep.

**Alternatives rejected:**

- Per-environment origin registration: same file needed a second registration and deleting the holding environment orphaned its imports.
- Deduping the migration by id: two ids for one path would survive.
- A local decrypt-and-store branch in sync_origin: stored the encrypted envelope as the password; replaced by transfer::land_secrets.
- Removing either the proactive notice or the reconciliation sweep: each covers the other's gap.

## Detail

**Shared origins (#108) are a GLOBAL registry (`tab_state.json` v5, `PersistedTabState.origins`) — they used to live on `Environment` and that was wrong for the same reason ADR #39 gives for JSON Schemas.** An origin describes a server-side resource (a file on a share), not a Producción/Staging axis, and what it produces — `profiles.json` entries, whole mirrored environments — is already global. Scoping the *registration* to one environment reproduced the `visible_databases` bug (ADR #27) one level up: the same physical file needed a second, independent registration (a second id) to be seen from a second environment, and deleting whichever environment happened to hold the registration silently orphaned every connection it had ever imported, with no notice raised at all — worse than an intentional `remove_origin`, which at least tells the frontend. `commands::origins`'s `add/update/remove/sync/list_origins` all read/write `state.tab_state.write().origins` directly now — there is no more `active_environment_mut().origins`. `Environment.origins` still exists as a **deprecated**, always-empty-on-save field (same convention as `ConnectionTabState.internal_layout`, ADR #10), kept only so an old v4 blob still deserialises.
    - **Migration (v4→v5) dedupes by `path`, not by id.** Two environments that had each registered "the same" shared file independently (two ids, one path) collapse into one global entry on first load after upgrading — first occurrence wins the surviving id, deterministic because environments and their per-env origins keep their on-disk order. Every dangling reference to a deduped-away id — a `ConnectionProfile.origin_id` (in the **separate** `profiles.json`), a mirrored environment's `Environment.origin_id` — is remapped to the surviving id. `tab_state::RawState::into_state_with_remap` returns the remap table (`load_tab_state` now returns `(PersistedTabState, HashMap<old_id, new_id>)`); `state::AppState::new_with_args` is the one place that applies it to `profiles.json`, since `tab_state.rs` has no business touching a different file. Get the load order wrong (profiles before tab_state) and the remap has nothing to apply itself to.
    - **`export_environments`/`import_environment` had to change too.** An environment no longer "owns" origins to copy verbatim into its export bundle; `export_environments` derives `ExportedEnvironmentBundle.origins` from whichever global origins the environment's *referenced connections* (by `origin_id`) or its own mirror (`env.origin_id`) actually depend on. `import_environment` still mints fresh origins per bundle (no dedup-on-import — a rarer case than the migration's, and easy to spot and clean up by hand), but pushes them onto `guard.origins` (global) instead of a per-environment field that no longer exists.
    - **Landing a synced profile's secrets goes through `transfer::land_secrets`, never a local copy.** `sync_origin` had its own decrypt-and-store branch, and it stored the base64 AES-256-GCM *envelope* as the password whenever no passphrase was configured — `build_exported_profiles` always encrypts, so that arm was never correct, and the result was a profile that could not connect and a keychain entry the real password could not be recovered from. The shared function takes a `LandMode`: `Strict` (the profile importer — a secret that will not decrypt fails the import) or `BestEffort` (a sync — skip it and leave the profile asking for a password, which is what an origin without its out-of-band passphrase is supposed to look like). It never writes a secret it could not decrypt, in either mode, and three keychain-free tests pin that down.
    - **`useOriginSync`'s in-memory `vanished`/`vanishedEnvironments` notices are the only thing standing between "removed this origin" and "connection stuck forever read-only."** `noticeOriginRemoved` (called synchronously from `OriginsSection`'s remove flow, before the origin is actually gone) is the well-named, immediate path — but it's in-memory only, so an app restart before the user decides loses it for good, and a profile/environment left with a dangling `origin_id` is read-only in the UI (`ConnectionDialog.isFromOrigin` and the equivalent environment gating) with **no other way to clear the tag**. `reconcileOrphans`, run at the end of every `syncAll()` pass (launch, the 4-hourly poll, "Sync now"), is the durable fallback: it compares every origin-owned profile/environment against the ids `listOrigins()` (now global, so one call covers everything) just returned, and raises the same notice — minus the name, which is unrecoverable by then; the notice components fall back to a translated "a shared origin that no longer exists" when `originName` is blank. Don't remove either path: the proactive one is the good UX, the sweep is the safety net for when it's missed.
