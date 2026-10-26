---
id: 120
type: adr
status: accepted
date: 2026-10-26
tags: [policy, security]
triggered_by_external_trap: false
related: [94, 95, 96, 109, 118, 119]
supersedes: []
superseded_by: null
amends: []
---

# ADR #120: a managed policy can require the app lock, only ever tightens it, and an unreadable one keeps the lock that is there

Phase 4 of the app lock. A role's `appLock` sets what its people may choose about the lock:
- `required`;
- `maxIdleMinutes`;
- `lockWithSession`;
- `allowWindowsHello`, which is reserved.

It is resolved like `allowToolDownloads`, per role and for the current OS account, by `policy::app_lock`, and enforced in Rust, never only in the interface. A required lock with no vault is a wall of its own, the `setup` mode, so a managed machine cannot be used before a master password exists. A pending or broken policy cannot say what it requires, so it requires nothing new, and refuses to let the lock that is there be turned off.

**Decision:** `Role::app_lock: Option<AppLockRule>`, with `deny_unknown_fields`, resolved by `policy::app_lock(state) -> LockPolicy`. The gate closes on `required && Mode::Off`. `vault_enable` is open behind the gate. `vault_disable` refuses unless `may_disable`. The idle watcher and the session watcher use `LockPolicy::idle_minutes` and `LockPolicy::with_session`.

**Alternatives rejected:**

- **A document-level `appLock`.** One policy usually governs a whole company, and the exceptions are people (IT, a shared kiosk account). Roles already map people to what they may do, and `allowToolDownloads` set the precedent for a role-level switch that is not about a connection.
- **Enforcing `required` by turning the lock on silently.** There is no master password to seal it with. Inventing one, or deriving it from something the machine knows, would be a lock anyone at that machine could open. The person sets it, behind a wall.
- **A broken policy forcing the setup wall.** It would turn an unreadable share into a whole company locked out of HuginnDB until each person invented a password, for a requirement that may not exist. Instead it fails closed the narrow way: what is locked stays locked.
- **Ignoring `allowWindowsHello` until Hello ships.** `deny_unknown_fields` would make a policy that names it Broken on every build before then. Accepting it now (and documenting that it does nothing yet) keeps a policy written today valid when phase 2 lands.
- **Editing `appLock` in the policy editor's form.** The draft is the JSON (ADR #100). A field the form does not know rides along untouched, which is how `allowToolDownloads` is edited today. A form section can come later without a format change.

## Detail

- **Model.** `AppLockRule { required, max_idle_minutes, lock_with_session, allow_windows_hello }`, camelCase, with `deny_unknown_fields`.
  - `maxIdleMinutes: 0` is an error: "never" is the absence of a maximum.
  - A maximum without `required` is a warning, since it bounds a lock the person may still leave off.
- **Resolution.**
  - `Unmanaged`: everything the person's, `may_disable`.
  - `Pending`/`Broken`: `required = false`, `may_disable = false`.
  - `Active`: the role's rule, defaulting to "the person decides".
  - `LockPolicy::idle_minutes(chosen)` caps the choice, and the person's 0 (never) becomes the maximum. `LockPolicy::with_session(chosen)` is the policy's answer when it gives one.
- **Enforcement.**
  - `app_lock::sync_gate(state)` closes on `vault::is_locked() || setup_required(state)`.
  - `LockStatus.mode` is `setup` in that case, and `LockStatus.policy` carries the `LockPolicy` for the interface.
  - `vault_enable` joins `OPEN_WHILE_LOCKED`. Behind an ordinary lock it refuses on its own ("already on"), and the dispatcher test still requires it to touch no database.
  - `vault_disable` refuses with a sentence naming the role, or the unreadable policy.
  - `vault_reset` is unaffected: it keeps the lock on.
- **A policy change applies at once.** `policy::install`'s `on_change` now also runs `app_lock::announce`. A reload that starts requiring the lock puts up the setup wall without waiting for a restart.
- **Interface.**
  - The setup wall opens with the padlock *open* and plays the closing animation once the password is set.
  - In Settings → Security the lock switch, the idle choices (capped, without "Never") and the session switch show the organization's decision in their row's footer, per ADR #96's "advisory, the backend refuses regardless".

## Consequences

- **Compatibility is one-way.** A HuginnDB older than this one reads `appLock` as an unknown field and the whole policy as Broken, which blocks every connection. `docs/POLICY.md` says so in a callout, as it does for `dbUser` (ADR #97).
- The system anchor (`Program Files\HuginnDB\managed-policy.json`, `HKLM`) is read by every build on the machine. Trying `appLock` there on a development machine breaks the installed app's policy until the file is removed or the app updated.
- `allowWindowsHello` must be wired when Hello ships; until then `LockPolicy::allow_windows_hello` is carried and read by nothing.
