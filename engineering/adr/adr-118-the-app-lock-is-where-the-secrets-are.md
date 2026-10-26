---
id: 118
type: adr
status: accepted
date: 2026-10-26
tags: [security, keychain, state-files]
triggered_by_external_trap: false
related: [26, 41, 94, 95, 96, 104]
supersedes: []
superseded_by: null
amends: []
---

# ADR #118: the app lock is where the secrets are — a slotted vault replaces the keychain while it is on, and every command is refused by default behind it

The app lock stops someone who sits at a computer whose Windows session is open. It is not a screen in front of the app. Turning it on moves every secret HuginnDB holds out of the OS keychain and into `vault.json`. That file is sealed with AES-256-GCM under a random vault key, and the key is wrapped in one or more *slots*. The master password's slot always exists; Windows Hello comes next. `crate::keychain` routes through the vault, so no caller can reach a secret around it. A single dispatcher wrapped around `generate_handler!` refuses every command that is not on a short allow-list while the app is locked. Deleting files therefore leaves an app with no secrets, not an app with no lock. The MCP sidecar has no way to unlock, so on its own it refuses.

**Decision:** While the lock is on, secrets live only in a slotted, AEAD-sealed vault reached through `keychain::{get,set,delete}_password`. Commands pass `app_lock::gate`, which refuses everything but `OPEN_WHILE_LOCKED`. The vault and its keychain marker are shared by every build, canary included.

**Alternatives rejected:**

- **A lock screen over an app whose secrets stay in the keychain.** Anyone in the session reads the Credential Manager, or asks the MCP connector, and never meets the screen.
- **A guard call in each command, as ADR #95 does for policy.** Forgetting it opens a hole. With a default refusal, forgetting only makes the wall a little too high.
- **One key derived straight from the password, with no slots.** Adding Windows Hello, or changing the password, would re-encrypt every secret. A slot re-wraps 32 bytes instead.
- **A HuginnDB PIN.** A short code that we store is brute-forced offline in seconds. The PIN of Windows Hello is protected by the TPM, which limits the attempts.
- **A vault isolated per build (`APP_DIR`).** Turning the lock on in the stable build would empty the keychain that the canary shares (ADR #26). The canary would then ask for each password again and store it back in the keychain in the clear.
- **"No `vault.json`" meaning "lock off".** Deleting the file would turn the lock off. A keychain marker makes a missing file a broken vault instead.
- **Caching the decrypted secrets while unlocked.** Two processes share the file, and a cached copy would overwrite the other's writes. Each read decrypts the file afresh; locking only has to drop the key.

## Context

Until 1.35 every secret sat in the OS keychain under `io.huginndb.app`: connection passwords and personal users (ADR #97), SSH passwords and passphrases, origin passphrases, the AI key and the issue reporter's GitHub token. All of them go through `keychain.rs`. Anyone using the open Windows session could:

- open HuginnDB and connect to any database without typing a password;
- see the restored tabs;
- point Claude Desktop at the MCP connector and query without ever opening the app's window.

We protect against that person, even when they edit or delete config files or use the MCP connector. We do not protect against prolonged access: malware, a keylogger, or memory read while the app is unlocked. `docs/APP_LOCK.md` says so.

## Detail

### The vault (`src-tauri/src/vault/`)

- **Format** (`vault/file.rs`). `vault.json` holds `{ version, id, slots[], nonce, secrets }`.
  - `secrets` is the account → secret map, sealed with AES-256-GCM under the vault key.
  - Each slot wraps the vault key.
  - The associated data of every ciphertext names the vault's `id` (and, for a slot, its kind). A slot or blob pasted in from another vault does not open.
  - `deny_unknown_fields`. A newer `version` is refused, never guessed at.
- **Password slot.** Argon2id with 256 MiB, `t = 3`, `p = 1`, a 16-byte salt and a 32-byte output.
  - Memory is what makes a GPU or ASIC farm expensive, so it is pushed hardest.
  - Measured in a release build on the maintainer's laptop (best of three, `argon2` 0.6.0):

    | Memory | `t` | Time |
    | --- | --- | --- |
    | 64 MiB | 3 | 67 ms |
    | 128 MiB | 3 | 144 ms |
    | 256 MiB | 2 | 205 ms |
    | 256 MiB | 3 | 301 ms |
    | 256 MiB | 4 | 393 ms |

  - 64 MiB, the usual default (Bitwarden's, three times OWASP's floor of 19 MiB with `t = 2`), was rejected: at 67 ms an offline guess cost less than the wall's own wait.
  - 256 MiB with `t = 3` costs about a third of a second here, and probably under a second on a modest laptop. That is acceptable for an unlock that happens a few times a day, and the memory is held only while it runs.
  - One lane, because the `parallel` feature would bring in `rayon`. Without threads, lanes computed one after another cost the defender exactly what they cost an attacker.
  - `vault::tests::vault_kdf_cost` (ignored; `--release -- --ignored`) re-measures it.
  - The parameters live in the slot, so raising them later changes only new slots.
  - A file that names less than the floor (19 MiB, `t = 2`) is refused. An edited file must not make the next password change seal under a cheap cost.
- **Shared by every build.** The vault lives in `app_identity::KEYSTORE_DIR` (`"HuginnDB"`), the one deliberate exception to `APP_DIR`, for the same reason `keychain::SERVICE` is one (ADR #26).
  - It is written with `state_file::write_atomic` through `state_file::keystore_path`.
  - Each process unlocks on its own.
  - Writes re-read the file and reseal it, so the stable build and the canary do not overwrite each other.
- **Marker.** The keychain entry `vault::enabled` holds the vault's `id`.
  - File present → on.
  - File missing and marker present → `Broken`: refused like `Locked`, and the only way out is a reset.
  - Both missing → off, and the secrets are gone rather than handed back.
  - A file that cannot be parsed is `Broken`, never "empty". This is the same rule `profiles.json` follows (ADR #41).
- **Crash order.**
  - Turning the lock on writes the vault and the marker *before* anything leaves the keychain.
  - Turning it off writes the keychain *before* removing the vault.
  - A crash leaves secrets in both places, never in neither.
  - Every unlock deletes any keychain copy of an account the vault holds (`Vault::sweep`).
- **What moves.** The keychain cannot be listed, so `app_lock::known_accounts` rebuilds the list from what refers to it:
  - for each profile, its account, its effective (personal) account and its SSH account;
  - each origin's passphrase account;
  - the configured AI endpoint's account;
  - the GitHub token's account.

  A secret under an account nothing refers to any more (a crash, a pre-1.0 build) is not moved. Nothing in the app can read it either.
- **Wrong passwords.** After the third failure the next attempt waits 2ⁿ seconds, up to five minutes. The wait is enforced before Argon2 runs.
  - It lives in memory and a restart resets it. It slows guessing at the wall.
  - Against a copy of `vault.json` attacked offline, the defence is Argon2's cost times the password's length. The docs say so.
- **Reset** starts a new, empty vault under a new password, and the lock stays on. That matters once a policy can require the lock (phase 4).
  - Reset is open while locked. It destroys secrets and never reveals one, so it hands a stranger what deleting the files would.
- **Floor.** The backend refuses a master password shorter than `vault::MIN_PASSWORD_CHARS` (12). The interface's advice (`lib/lock/strength.ts`) asks for more, without a dictionary dependency.

### Enforcement (`src-tauri/src/app_lock.rs`)

- **One dispatcher.** `.invoke_handler(app_lock::gate(tauri::generate_handler![…]))`.
  - While `CLOSED` (an atomic that mirrors `vault::is_locked()`, so each IPC call costs a load, not a file read), anything not in `OPEN_WHILE_LOCKED` is rejected with `AppError::Locked`. The allowed commands are `vault_status`, `vault_unlock` and `vault_reset`.
  - `CLOSED` starts **closed**. `setup` opens it only after asking the vault.
  - Plugin commands (window controls, updater, dialogs) are routed by their plugins and never reach the gate.
- **Two tests.**
  - `locked_only_the_wall_runs_and_unlocked_nothing_is_refused` walks every command in `generate_handler!`.
  - `every_command_open_while_locked_is_registered_and_touches_no_database` requires each open command to be classified `none` in `guard::HUMAN_POLICY`.
- **Locking (`lock_app`):**
  1. drop the key;
  2. close every window but the main one, which reloads into the wall and so loses all JavaScript state, including the AI conversation (D7);
  3. close the terminals;
  4. cancel AI turns;
  5. close every pool (ADR #104), which takes the SSH tunnels and keepalives with it;
  6. clear `session_secrets` and every pending CLI or window intent (they can carry `--password`);
  7. stop the MCP bridge.

  Nothing reconnects on unlock.
- **Idle.** The backend decides. `spawn_idle_watcher` checks every 15 s against `LockPrefs::idle_minutes` (15 by default; 0 is never). The interface only reports activity, at most every 30 s per window (`vault_activity`). A frozen or closed window therefore cannot keep the app unlocked.
- **Startup.** `LockGate` wraps every window kind in `main.tsx`. It renders an empty background until `vault_status` answers, then either the wall or the app. Nothing mounts behind it: no `tab_state` hydration, tree, auto-connect or bridges.
  - A second instance only focuses the wall.
  - The Jump List's "New window" does nothing while locked.
  - A CLI connection intent stays buffered until the app mounts after unlocking.
  - `updater::headless` returns before the Builder and never touches a secret.
- **MCP.**
  - `bridge::server::reconcile` serves the bridge only while unlocked, and `dispatch` refuses as well.
  - The sidecar's own paths (`Huginn::call`'s local fallback, `ensure_connected`'s own pool, and `list_connections` with no app publishing a bridge) refuse with `AppError::Locked` whenever the lock is on. They do so even for a connection that needs no password: with the lock on, nothing is reached without the app.
- **Pulse.** The sampler's tick returns while locked; it only samples open pools anyway.

### Testing a dev build

The vault and keychain are shared with the installed app. A debug build started with `HUGINNDB_LOCK_SANDBOX=1` therefore uses `HuginnDB-LockSandbox` and the keychain service `io.huginndb.lock-sandbox` instead. Without it, trying the lock in a dev build would move the maintainer's real passwords out from under the installed app. Release builds do not compile it.

## Consequences

- Any new place that stores a secret goes through `crate::keychain`. Calling `keyring` directly would put a secret where the lock cannot see it. Only `keychain::os` (called by `vault::OsEnv`) touches `keyring`.
- A new secret account must be added to `app_lock::known_accounts`, or turning the lock on leaves it in the keychain.
- A new command is unavailable while locked unless it is added to `OPEN_WHILE_LOCKED`. The test then requires it to touch no database.
- An older build sharing the keychain does not know about the vault. It will ask for passwords (finding none) and may store answers back in the keychain. The next unlock sweeps those copies away.
- Not protected, and documented: connection metadata (`profiles.json`), restored tab bodies (`tab_state.json`), `localStorage` history and `pulse.db` are still plaintext on disk. Encrypting them is a later phase. Connections that need no secret (SQLite files, trust authentication) stay reachable by anyone who can read the disk; only the app and the sidecar refuse them.
- Phases 2–4: a Windows Hello slot, locking with the Windows session, and policy integration.
