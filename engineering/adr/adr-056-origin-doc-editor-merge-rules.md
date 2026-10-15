---
id: 56
type: adr
status: accepted
date: 2026-08-26
tags: [origins, state-files, security]
triggered_by_external_trap: false
related: [26, 52]
supersedes: []
superseded_by: null
amends: []
---

# ADR #56: The shared-origin editor edits a document with three load-bearing rules

`origin_doc/` is a pure model touching no local state, which is what makes its merge rules testable; an unchanged secret is re-encrypted only via cached identity fields staying sacred, and `publish_impact` runs the real `merge_into` to surface any silently-dropped consumers.

**Decision:** The origin editor edits a pure document model with no local side effects, carries unchanged secrets verbatim, never re-mints source_environment_id/profile ids, computes publish impact by running the real merge_into, and syncs JSON Schemas by ID through json_schemas::origin.

**Alternatives rejected:**

- Re-encrypting an unchanged secret: rejected because a fresh salt/nonce invalidates every consumer's landed_secrets fingerprint and costs ~600 000 PBKDF2 rounds per slot.
- Re-deriving the merge rules for publish_impact instead of running merge_into: avoided so the impact report needs no knowledge of which fields a refresh preserves.
- Returning a publish conflict as an Err: rejected because errors cross IPC as plain strings and could not carry the newer document.
- Syncing the JSON Schema slice through json_schemas::import: rejected because it mints fresh uuids and resolves conflicts by name, growing duplicates on every poll.
- Letting save_atomic take arbitrary paths: rejected to keep canary isolation (gotcha #26) enforceable in one place; write_atomic exists for that.

## Detail

**The shared-origin editor edits a DOCUMENT, and three of its rules are the whole feature.** `src-tauri/src/origin_doc/` is the pure model (draft ⇄ file, membership, publish impact); `commands/origin_doc.rs` is the I/O around it; `src/components/origins/` is the overlay, mounted as a **sibling** of `SettingsDialog` in `App.tsx` (opening it closes Settings — never a dialog trapping focus on top of another). What will bite:
    - **Nothing in it touches this machine's state, in either direction.** An `OriginDraft` never reads or writes `profiles.json` / `tab_state.json` / `json_schemas.json`, and saving one changes nothing locally. That is what makes the merge rules testable at all — convention #52 is the record of what happens when the only entry point insists on saving first, and every test in `origin_doc/tests.rs` is pure for exactly that reason. The local profile list and schema library are read *only* to offer rows to copy into the document.
    - **A secret that did not change travels VERBATIM, and that is a correctness property, not an optimisation.** `encrypt_secret` draws a fresh salt and nonce per call, so re-encrypting invalidates every consumer's `landed_secrets` fingerprint cache (gotcha's neighbour: `already_landed`) and costs each of them ~600 000 PBKDF2 rounds *per slot*. `SecretSlot::Keep` carries the envelope byte for byte; the pristine draft is kept for the whole editing session precisely so leaving `keep` and coming back **restores** the envelope rather than rebuilding it, which the editor cannot do (it has neither the plaintext nor the passphrase). Renaming an environment must cost zero derivations, and `renaming_an_environment_re_encrypts_nothing` is the test that says so.
    - **`source_environment_id` is sacred** — it is the `(origin_id, origin_source_id)` identity `sync_environment_bundles` matches a bundle against its local mirror with. Minting a fresh one while editing makes every consumer see that environment *disappear* and a different one arrive, losing tabs, layout and filters. Exactly one place mints one: creating an environment that never existed. Same one level down for `ConnectionProfile.id`, which is what lets a publisher consume their own origin without ending up with two copies of every server.
    - **`publish_impact` runs the REAL `merge_into`** against a synthetic pool built from the file it is about to replace, rather than re-deriving the rules — and reads the refreshed/unchanged split off the simulated pool *after* the merge, so it needs no knowledge of which fields a refresh preserves locally (`mcp_write`, today). It computes `vanished` itself, though, and that is the point: `merge_into` **clears** `vanished` once the read crosses the suspicion threshold, so the consumer's own report can never reveal that a publish will reach nobody. `EntityImpact.silently_dropped` is the only surface in the product where that is discoverable.
    - **Three layers decide whether a write is allowed, and only the middle one is authoritative.** `Origin.role` (`#[serde(default)] = Consumer`) is *intention*, so no existing origin gains write access by updating; `probe_origin_writable` creates and deletes a real file next to the document, because permission bits on a Windows share describe the local mount and not what the server accepts; `meta.maintainer`/`meta.revision` are *coordination* and grant nothing. What actually stops two publishers clobbering each other is the SHA-256 the save re-computes from disk — a conflict comes back as `Ok(SaveOutcome::Conflict)` carrying the newer document, **not** an `Err`, because errors cross the IPC boundary as plain strings and could not carry it.
    - **`state_file::write_atomic` takes an arbitrary path; `save_atomic` does not and must not.** `save_atomic` only resolves names under the config dir, which is what keeps ADR #26's canary isolation enforceable in one place. The temp file goes in the *destination's* directory (a `rename` is only atomic within a filesystem, and a share is another volume), is `fsync`ed before the rename, and the previous revision is copied — not moved — to `<name>.bak`.
    - **The JSON Schema slice syncs by ID, through `json_schemas::origin`, never through `json_schemas::import`.** The one-shot importer mints fresh uuids, clears `origin_id` and resolves conflicts by *name*, all correct for a file picked once and all wrong for a four-hourly poll: it would grow `cfg (2)`, `cfg (3)`, … forever, or adopt a locally-authored schema that happens to share a name. The sync path is `merge_into`'s shape instead — ownership by `origin_id`, refresh in place, a published name that collides with a local one steps aside, a binding naming an unknown connection lands `enabled: false` with its pin intact, and nothing deletes.
