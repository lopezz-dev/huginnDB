---
id: 122
type: adr
status: accepted
date: 2026-10-29
tags: [mongodb, security, connections]
triggered_by_external_trap: false
related: [40, 69, 70, 118]
supersedes: []
superseded_by: null
amends: []
---

# ADR #122: A MongoDB connection string never carries its password to disk — it is moved to the keychain wherever a profile is written

A password typed into a MongoDB URI (`mongodb://user:pass@…`) is taken out of the string and stored in the keychain at every point where a profile is written: when it is saved, imported, synced from a shared origin or published. A sweep at startup and after an unlock handles profiles saved before this change. `connection_string` is metadata. It used to travel everywhere metadata does: `profiles.json`, exports written "with encrypted passwords", and every consumer of a shared origin. As a result, the one invariant CLAUDE.md states without qualification ("passwords never hit disk in plaintext") did not hold for raw-edit MongoDB connections.

**Decision:** `credentials::take_embedded_password` is the one rule (Mongo only; the user stays in the URI, the password leaves). Each writer applies it **before** deriving a keychain account, and the URI's password **wins** over a separately stored one, because it is the one the driver used to sign in with.

**Alternatives rejected:**

- **Encrypt the URI in place** (a second secret slot holding the whole string) — every reader of `connection_string` (the dialog, the rail, the terminal's `mongosh`, `dial_target`, `credentials::effective_profile`) would need to decrypt it. A slot that already exists (`keyring_account()`) and an injection point that already exists (`db::mongo::open_pool` fills the password in when the URI carries none) make the move free for every one of them.
- **Strip it in the frontend only** (the form already does in form mode) — the import, the origin sync and the origin editor all write profiles without passing through the form. A file written by an older version, or by a consumer of an older origin, would keep putting it back.
- **Strip it in `store::save_profiles`** — the one writer to disk, but the wrong place for a keychain write: it has no error channel for "the vault is locked", and silently dropping the password there loses it. The startup and unlock sweep keep the password where it was while the keychain cannot take it.
- **Refuse to save a URI with a password** — the raw-edit field exists precisely for strings the form cannot hold (SRV, seed lists, Atlas options, ADR #70). Refusing would push people towards the form for connections it cannot express.

## Context

The form builds the URI without the password and keeps it in the keychain. Raw-edit mode saves the string verbatim, and the form already acknowledged that this could include a password (`useConnectionForm.ts`). `ExportedProfile` flattens the whole `ConnectionProfile` and encrypts only `ExportedSecret`, so the "encrypted" export and a shared origin's document carried the password in clear beside the ciphertext. The only code that ever stripped it, `credentials::effective_profile`, works on a throwaway copy used to dial with a personal user.

## Consequences

- **Writers** — `commands::connection::save_profile`, `apply_profile_imports`, `origins::merge_profiles_bundle` (consumer), `commands::origin_doc::resolve_secrets` (publisher) and `transfer::build_exported_profiles` (export) all take the password out first, then key every keychain write on the *stripped* profile. Taking it out sets `username` to the URI's user, which changes `keyring_account()`; deriving the account from the unstripped profile would store the password where the next reopen of the form (which reads the user back from the URI) no longer looks.
- **Publishing:** a row whose slot is `Clear` drops the password rather than encrypting it, because the publisher chose to publish nothing for that connection. Any other row needs the document's passphrase, and is refused without one, like any other secret.
- **Consuming:** the password is landed under the same exclusions as an envelope: never for a personal user (`credentials::personal_user`), never over a `secret_override` (ADR #69), and only into a connection the origin owns here. There is no `landed_secrets` fingerprint, because there is no decryption to skip. The keychain write is skipped when the stored value already matches.
- **Migration:** `credentials::migrate_embedded_passwords` runs in `lib.rs`'s setup and in `app_lock::announce`. It writes the keychain **before** touching the profile, so a closed vault (ADR #118) leaves it exactly as it was, to be retried on unlock. It runs in the desktop app only, never in the MCP sidecar, so that two processes never rewrite `profiles.json` at once.
- **Not covered:** a published origin document stays in clear on the share until its publisher saves it again from the editor; consumers stop *storing* it, but cannot remove it from a file they do not own. Session-only (CLI `--uri`) profiles are untouched: they never reach disk.
