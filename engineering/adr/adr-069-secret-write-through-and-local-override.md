---
id: 69
type: adr
status: accepted
date: 2026-09-09
tags: [origins, security]
triggered_by_external_trap: false
related: [56]
supersedes: []
superseded_by: null
amends: []
---

# ADR #69: A shared origin's credentials move in two directions, and each has exactly one door

A publisher's local correction offers to republish only the row it corrected (`republish_profile_to_origin`), re-encrypting only when the password itself changed; a consumer may keep their own password (`ConnectionProfile::secret_override`), and it expires the moment the origin publishes a different ciphertext.

**Decision:** A publisher's local password fix offers republish_profile_to_origin (same save path as the editor, re-encrypting only when the password changed), and a consumer may set ConnectionProfile::secret_override, which expires when the origin publishes a different ciphertext.

**Alternatives rejected:**

- Automatically writing to the origin on save: rejected; it is always a prompt because publishing reaches other machines.
- Holding the republish prompt in dialog useState: rejected because connecting closes the dialog.
- Re-adding a connection the document dropped: rejected; it is reported instead.
- Comparing plaintexts to decide override expiry: rejected because it would put password-derived material in profiles.json.
- set_secret_override as save_profile with the read-only rule relaxed: rejected because it would allow host/port edits that the next sync reverts.

## Detail

**Both halves exist because the credential is the one field where "the file is authoritative" costs more than it buys.** Host, port, database, the visible-database default: those are what "somebody curates this" means, and a consumer editing them locally would rightly be undone by the next sync. A password that stopped working is not a curation decision — it is a fact about the server that whoever hit it learned first. Everything below follows from taking that one exception seriously and refusing to widen it.

- **`republish_profile_to_origin` is `save_origin_document` with one row pre-filled, not a second write path.** A publisher who fixed a rotated password in the connection dialog had fixed it for themselves: `save_profile` writes `profiles.json` and this machine's keychain and stops there, so the share still carried the old envelope and every consumer stayed locked out until somebody remembered to open the editor, find the row, flip its secret to `fromKeychain` and publish. Two expressions of one intent with a silent window of broken connections in between. The command re-reads the document, calls `origin_doc::replace_connection`, and hands the result to the **same** `save_inner` — so the publisher-role check, the write probe, the SHA-256 conflict check, the `.bak` and the impact report are all the editor's, and a concurrent publish still comes back as `SaveOutcome::Conflict`. The prompt sends the user to the editor for a conflict on purpose: merging is a document-shaped job, and a one-row prompt cannot show what moved.
    - **`with_secret` is a correctness parameter, not a convenience.** ADR #56's invariant 2 says an unchanged secret travels verbatim; `encrypt_secret` draws a fresh salt and nonce per call, so re-encrypting invalidates every consumer's `landed_secrets` fingerprint and charges each of them ~600 000 PBKDF2 rounds for a password that did not change. Correcting a *port* must therefore cost the team zero derivations. `ConnectionDialog` reads it from the password field **before** the save, because `setEditingId` reloads the form and clears it.
    - **The prompt lives in a store, not in the dialog that raises it** (`stores/dialogs/originRepublish`). Saving keeps the connection dialog open but *connecting* saves and then closes it, and "fix the password, connect, done" is the flow a rotated credential actually produces — a `useState` in there would take the prompt down in exactly the case that matters most. It is a prompt and never an automatic write: publishing reaches other people's machines and `save_profile` does not.
    - **A connection the document has since dropped is reported, never re-added.** `replace_connection` returns `false` and the command refuses. Publishing it back would silently restore a row somebody deliberately removed; adding one stays the editor's job.

- **`ConnectionProfile::secret_override` is local state that EXPIRES, which is what separates it from its three neighbours.** `mcp_write`, `mcp_exposed` and `pulse_enabled` are permanent local decisions `merge_into` preserves. This one is preserved *in order to be expired*: the landing loop in `merge_profiles_bundle` reads it back off the merged pool and compares `supersedes` against the fingerprint of the ciphertext that just arrived (`override_still_stands`, the one place that rule is stated). Same ciphertext → the override stands and nothing is landed; a different one → the publisher has answered the question the override stood in for, so their secret lands and the flag is cleared.
    - **Cleared only after a *successful* land.** A failed decrypt (missing or wrong passphrase) leaves the override in place, so the user keeps a connection that works rather than one that does not.
    - **The known cost is a passphrase rotation**, which re-encrypts every envelope without changing a single password and therefore expires every override on that origin. Rare, publisher-initiated, and reported (`OriginSyncReport::superseded` → a `warning` notification). The alternative — comparing plaintexts — means keeping password-derived material in `profiles.json`, a file guaranteed to hold no secrets. Not a trade worth making for this.
    - **`set_secret_override` is deliberately not `save_profile` with the read-only rule relaxed.** That command replaces the whole record, so it would let the host or the port of a curated connection be changed too, and the next sync would revert *those* while keeping the password — the worst of both, and impossible to explain from the UI. It writes the keychain and the one flag, and refuses a profile with no `origin_id` (a local profile's password is edited by saving it; two ways to write one keychain entry is how they drift).
    - **`clear_secret_override` must also forget the landed fingerprint.** `already_landed` skips a ciphertext it has already recorded, so clearing the flag alone would mean the origin's secret is never re-landed and the connection keeps quietly running on the local password. Dropping `origin.landed_secrets[profile_id]` is what makes the next sync actually re-derive and overwrite it.
    - **The flag must never travel.** `ExportedProfile` flattens the whole `ConnectionProfile`, so `merge_into` clears it on every incoming row before the update arm restores this machine's own, and `apply_profile_imports` clears it like `mcp_exposed`. Skipping either is worse than the `mcp_exposed` case it mirrors: on a *newly added* profile there is no local value to restore over it, and the inherited flag would suppress the very secret the file publishes.
