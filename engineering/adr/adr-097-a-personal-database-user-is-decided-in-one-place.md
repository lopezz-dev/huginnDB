---
id: 97
type: adr
status: accepted
date: 2026-09-24
tags: [policy, security, mongodb]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #97: A person's own database user is decided in one function, keys the keychain, and stops the shared secret from landing

Phase 3 of managed policy (`docs/POLICY_ROADMAP.md` §7). For people, the policy is only a guardrail as long as a shared database password can open any other client. It becomes a wall when each person signs in with their own database user, whose grants match the role. This covers the "own user" half; generating the grants is the other half.

**Decision:** credentials::effective_profile picks policy dbUser, then personal_username, then username, returning a clone that keys the keychain everywhere a pool is opened; personal_username never leaves the machine and the shared secret is not landed while a personal user is in force.

**Alternatives rejected:**

- Computing the keychain account from the stored profile — rejected because it would read the published user's entry.
- Writing the effective user back into profiles.json — rejected; a clone is returned so the published connection stays as published.
- Landing the shared secret for rows with a personal user — rejected because it would hand the user the password for the shared account.

## Detail

- **One decision: `credentials::effective_profile`.** Three sources, in order:
  1. **The policy**, when the first rule of the person's role for that endpoint carries a `dbUser`. It is endpoint-wide: the rule's `databases` do not narrow it, because a user signs in to a server, not to one database.
  2. **The person's own choice**, `ConnectionProfile::personal_username`.
  3. **The profile's `username`**.

  The policy's user is pinned: `set_personal_credentials` refuses a different one. The function returns a **clone**, never written back, so `profiles.json` keeps the connection as it was published.
- **It keys the keychain.** `keyring_account()` is `id::username` on whatever value it is called on. Every place that opens a pool calls `effective_profile` first:
  - `connect_inner`, `test_connection` (and so `smoke_test`), `open_database_view_inner` for a child pool, and the MCP sidecar's `ensure_connected`;
  - `save_profile`, for the password it writes;
  - `delete_profile` / `delete_profiles`, which delete the personal account (`personal_account`) as well as the published one.

  A code path that computed the account from the stored profile would read the published user's entry, and the person would be refused or, worse, signed in as the shared account.
- **`dbUser` is a template with exactly one token, `{user}`.** The token expands to `normalise_user(current_user())`: no domain, lower case. Any other brace is a load error (`db_user_problem`), so the policy becomes Broken rather than signing everyone in as the literal `{usr}`. An OS that will not name its user expands `{user}` to nothing, which means no personal user at all.
- **Strictly local, like `secret_override`.** `personal_username` never leaves the machine:
  - `merge_into` clears it on every incoming row and restores this machine's value;
  - `build_origin_file` and `build_exported_profiles` publish the profile with it removed;
  - the import clears it.

  Two cases rely on this. A publisher's own user must not ride into everyone's file. A **new** row has nothing local to restore, so without the clearing it would arrive carrying the publisher's user.
- **The shared secret is not landed while a personal user is in force.** `merge_profiles_bundle` skips those rows. The landed secret would sit under `id::<published user>`, which nothing reads. Worse, it would put on the machine the one password that lets its user open another client as the shared account, which is exactly what per-person users exist to prevent. `clear_personal_credentials` forgets the origin's `landed_secrets[id]` so that the next sync lands the shared password again. This is the same step `clear_secret_override` takes.
- **MongoDB puts the user in the URI.** `connection_string` wins over `profile.username`, so `effective_profile` strips the user info (`strip_uri_userinfo`: after the scheme, up to the last `@` before the first `/` or `?`), along with any password embedded in it. The driver's credential is then built from the personal user and their own password. `resolve_password` stops treating a missing Mongo password as "none" while a personal user is in force (`personal_username` is set on the clone for that reason).
- **A missing password is asked for, not reported.** `keychain::require_password` raises `AppError::MissingPassword`, tagged `MISSING_PASSWORD_TAG`. The text is unchanged, so nothing that already read it breaks. `useConnections.connect` catches it through `isMissingPassword`, asks through `PasswordPromptHost`, retries once with the typed password, and remembers it only after that connect succeeded. It remembers it through `remember_password` (under the effective account), except for a shared connection on the published user: there it uses `set_secret_override`, because a plain write would be overwritten by the next sync.
- **Compatibility is one-way.** `Rule` has `deny_unknown_fields`, so a version before this one reads a policy containing `dbUser` as Broken and blocks every connection. `docs/POLICY.md` says so in a callout: update every installation before adding the field.
