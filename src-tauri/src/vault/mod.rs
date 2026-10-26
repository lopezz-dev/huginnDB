//! The app lock: an encrypted vault that holds every secret while the lock is
//! on, and the one answer to "is HuginnDB locked?" in this process.
//!
//! **Where the secrets are is what the lock is.** With the lock off, secrets
//! live in the OS keychain exactly as before. Turning it on moves every one of
//! them into `vault.json`, sealed under a key only the master password (and,
//! later, Windows Hello) can unwrap, and deletes them from the keychain. So a
//! person sitting at an unlocked Windows session finds nothing to read in the
//! Credential Manager, the MCP sidecar finds nothing to connect with, and
//! deleting HuginnDB's config files buys an app with no passwords rather than
//! an app with no lock. The wall in the interface and the refusals in the
//! command dispatcher (`lock_gate`) are what a person *meets*; this is what
//! holds.
//!
//! **Every secret already went through `crate::keychain`**, so the routing is
//! done there and nothing else changes: `keychain::get_password` and friends
//! ask [`Vault`] where the secret lives and get the keychain, the vault, or
//! [`AppError::Locked`]. A caller cannot reach the OS keychain around it.
//!
//! **Shared with the canary build, unlike every other state file** — the same
//! exception `keychain::SERVICE` makes (ADR #26), because the vault *is* where
//! the keychain's entries went. An isolated vault would leave the canary
//! looking at an emptied keychain, asking for each password again and storing
//! it back in the keychain in the clear. See ADR #118.
//!
//! **No secret is cached between calls.** Unlocked, the process holds the
//! vault key and nothing else; each read decrypts the file afresh. That keeps
//! two processes sharing the file (the app and a canary) from overwriting
//! each other's writes with a stale copy, and it makes locking one thing: drop
//! the key.

pub mod file;

use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use file::{KdfParams, OpenError, SecretMap, VaultFile, VaultKey, DEFAULT_KDF};

/// `vault.json`, in [`crate::app_identity::KEYSTORE_DIR`].
pub const FILE: &str = "vault.json";

/// The keychain entry that says "this machine has the lock on", holding the
/// vault's id. The file alone cannot say it: deleting `vault.json` would then
/// turn the lock off. With the marker, a missing file is a broken vault, which
/// is refused like a locked one, and the person can only reset it — which
/// leaves them with no secrets, not with the old ones.
pub const SENTINEL_ACCOUNT: &str = "vault::enabled";

/// The shortest master password the backend accepts. The interface asks for
/// more than length (`lib/lock/strength.ts`); this is the floor nothing
/// bypasses.
pub const MIN_PASSWORD_CHARS: usize = 12;

/// Where secrets are read and written from this process's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// The lock is off; secrets are in the OS keychain.
    Off,
    /// The lock is on and the vault is closed.
    Locked,
    /// The lock is on and this process holds the vault key.
    Unlocked,
    /// The lock is on but the vault cannot be used: `vault.json` is missing
    /// while the keychain marker says it should exist, or it cannot be read.
    /// Refused like [`Mode::Locked`]; the only way out is a reset.
    Broken(String),
}

/// What an unlock attempt came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unlock {
    Opened,
    /// Wrong password. `retry_after` is the wait before the next attempt is
    /// even considered.
    Wrong {
        failures: u32,
        retry_after: Duration,
    },
    /// Asked too soon after a failure; the password was not checked.
    TooSoon {
        retry_after: Duration,
    },
}

/// The wait imposed after `failures` consecutive wrong passwords: none for the
/// first two, then doubling from two seconds to a five-minute ceiling.
///
/// In memory, and said so in ADR #118: a restart resets it. It exists to make
/// guessing at the wall slow; against a copy of `vault.json` attacked offline
/// the only defence is Argon2's cost, and the docs say that too.
pub fn backoff(failures: u32) -> Duration {
    if failures < 3 {
        return Duration::ZERO;
    }
    let exponent = (failures - 2).min(16);
    Duration::from_secs((1u64 << exponent).min(300))
}

/// Whether `idle_minutes` of inactivity have passed since `last_activity`.
/// Zero minutes means "never lock for inactivity".
pub fn idle_expired(last_activity: Instant, now: Instant, idle_minutes: u32) -> bool {
    idle_minutes > 0
        && now.saturating_duration_since(last_activity)
            >= Duration::from_secs(u64::from(idle_minutes) * 60)
}

/// The secrets' storage, as seen by [`Vault`]: the OS keychain and the vault
/// file. A trait so the rules are tested against memory (convention #52: a test
/// must never reach the developer's real keychain or config directory).
pub trait Env: Send + Sync {
    fn keychain_get(&self, account: &str) -> AppResult<Option<String>>;
    fn keychain_set(&self, account: &str, secret: &str) -> AppResult<()>;
    fn keychain_delete(&self, account: &str) -> AppResult<()>;
    fn read_file(&self) -> AppResult<Option<Vec<u8>>>;
    fn write_file(&self, bytes: &[u8]) -> AppResult<()>;
    fn remove_file(&self) -> AppResult<()>;
}

struct Open {
    id: String,
    key: VaultKey,
}

/// The lock's state in this process. One per process ([`with`]); tests build
/// their own.
pub struct Vault {
    open: Option<Open>,
    failures: u32,
    not_before: Option<Instant>,
    last_activity: Instant,
    kdf: KdfParams,
}

impl Default for Vault {
    fn default() -> Self {
        Self::new(DEFAULT_KDF)
    }
}

impl Vault {
    pub fn new(kdf: KdfParams) -> Self {
        Self {
            open: None,
            failures: 0,
            not_before: None,
            last_activity: Instant::now(),
            kdf,
        }
    }

    /// Where this process stands. Re-read every time the vault is not open, so
    /// a long-running process (the MCP sidecar) follows the lock being turned
    /// on or off by the app rather than acting on what it saw at startup.
    pub fn mode(&self, env: &dyn Env) -> Mode {
        if self.open.is_some() {
            return Mode::Unlocked;
        }
        match env.read_file() {
            Ok(Some(bytes)) => match VaultFile::parse(&bytes) {
                Ok(_) => Mode::Locked,
                Err(e) => Mode::Broken(e.to_string()),
            },
            Ok(None) => match env.keychain_get(SENTINEL_ACCOUNT) {
                Ok(Some(_)) => Mode::Broken(
                    "vault.json is missing, but this machine has the app lock on".into(),
                ),
                // No marker: the lock is off. A keychain that cannot be read
                // at all cannot hold a secret either, so treating it as off
                // opens nothing.
                Ok(None) | Err(_) => Mode::Off,
            },
            Err(e) => Mode::Broken(format!("vault.json cannot be read: {e}")),
        }
    }

    pub fn is_locked(&self, env: &dyn Env) -> bool {
        matches!(self.mode(env), Mode::Locked | Mode::Broken(_))
    }

    /// The file and its secrets, decrypted with the key this process holds.
    fn current(&self, env: &dyn Env) -> AppResult<(VaultFile, SecretMap, &Open)> {
        let open = self.open.as_ref().ok_or(AppError::Locked)?;
        let bytes = env.read_file()?.ok_or_else(|| {
            AppError::Vault("vault.json disappeared while the app was unlocked".into())
        })?;
        let file = VaultFile::parse(&bytes)?;
        if file.id != open.id {
            return Err(AppError::Vault(
                "vault.json was replaced while the app was unlocked; lock and unlock again".into(),
            ));
        }
        let secrets = file.secrets(&open.key)?;
        Ok((file, secrets, open))
    }

    fn mutate(&self, env: &dyn Env, change: impl FnOnce(&mut SecretMap)) -> AppResult<()> {
        let (mut file, mut secrets, open) = self.current(env)?;
        change(&mut secrets);
        file.reseal(&open.key, &secrets)?;
        env.write_file(&file.to_bytes()?)
    }

    // --- The keychain's three operations, routed. ---------------------------

    pub fn get(&self, env: &dyn Env, account: &str) -> AppResult<Option<String>> {
        match self.mode(env) {
            Mode::Off => env.keychain_get(account),
            Mode::Unlocked => Ok(self.current(env)?.1 .0.get(account).cloned()),
            Mode::Locked | Mode::Broken(_) => Err(AppError::Locked),
        }
    }

    pub fn set(&self, env: &dyn Env, account: &str, secret: &str) -> AppResult<()> {
        match self.mode(env) {
            Mode::Off => env.keychain_set(account, secret),
            Mode::Unlocked => self.mutate(env, |s| {
                s.0.insert(account.to_string(), secret.to_string());
            }),
            Mode::Locked | Mode::Broken(_) => Err(AppError::Locked),
        }
    }

    pub fn delete(&self, env: &dyn Env, account: &str) -> AppResult<()> {
        match self.mode(env) {
            Mode::Off => env.keychain_delete(account),
            Mode::Unlocked => self.mutate(env, |s| {
                s.0.remove(account);
            }),
            Mode::Locked | Mode::Broken(_) => Err(AppError::Locked),
        }
    }

    // --- Turning the lock on and off. ---------------------------------------

    /// Turn the lock on: move the secrets of `accounts` from the keychain into
    /// a new vault sealed under `password`, and leave it unlocked — the person
    /// just typed the password.
    ///
    /// The order is what makes a crash survivable: the vault and its marker
    /// are written **before** anything leaves the keychain, so a crash in
    /// between leaves the secrets in both places, never in neither. The copies
    /// left behind are deleted on every unlock ([`Self::sweep`]).
    ///
    /// Returns how many secrets moved.
    pub fn enable(
        &mut self,
        env: &dyn Env,
        password: &str,
        accounts: &[String],
    ) -> AppResult<usize> {
        if self.mode(env) != Mode::Off {
            return Err(AppError::InvalidInput("the app lock is already on".into()));
        }
        check_strength(password)?;
        let mut secrets = SecretMap::default();
        for account in accounts {
            if let Some(secret) = env.keychain_get(account)? {
                secrets.0.insert(account.clone(), secret);
            }
        }
        let (file, key) = VaultFile::create(password, &secrets, self.kdf)?;
        env.write_file(&file.to_bytes()?)?;
        env.keychain_set(SENTINEL_ACCOUNT, &file.id)?;
        self.open = Some(Open {
            id: file.id.clone(),
            key,
        });
        self.after_open();
        self.sweep(env, &secrets);
        Ok(secrets.0.len())
    }

    /// Turn the lock off: put every secret back in the keychain, then remove
    /// the vault and its marker. Same crash rule as [`Self::enable`], mirrored:
    /// the keychain is written first.
    pub fn disable(&mut self, env: &dyn Env, password: &str) -> AppResult<usize> {
        let (file, secrets, _) = self.current(env)?;
        if file.open_with_password(password)?.is_err() {
            return Err(AppError::InvalidInput(
                "the master password is not correct".into(),
            ));
        }
        for (account, secret) in &secrets.0 {
            env.keychain_set(account, secret)?;
        }
        env.remove_file()?;
        env.keychain_delete(SENTINEL_ACCOUNT)?;
        self.open = None;
        Ok(secrets.0.len())
    }

    /// Replace the master password. The vault key, and so every secret's
    /// ciphertext, stays as it was.
    pub fn change_password(&mut self, env: &dyn Env, current: &str, next: &str) -> AppResult<()> {
        check_strength(next)?;
        let (mut file, _, open) = self.current(env)?;
        if file.open_with_password(current)?.is_err() {
            return Err(AppError::InvalidInput(
                "the current master password is not correct".into(),
            ));
        }
        file.replace_password(&open.key, next, self.kdf)?;
        env.write_file(&file.to_bytes()?)
    }

    /// The way out of a forgotten password or a broken vault: a new, empty
    /// vault under `password`. The secrets are gone; the connections stay, and
    /// ask for their passwords again. The lock stays **on** — a reset is not a
    /// way to turn it off, which matters once a policy can require it.
    pub fn reset(&mut self, env: &dyn Env, password: &str) -> AppResult<()> {
        check_strength(password)?;
        let (file, key) = VaultFile::create(password, &SecretMap::default(), self.kdf)?;
        env.write_file(&file.to_bytes()?)?;
        env.keychain_set(SENTINEL_ACCOUNT, &file.id)?;
        self.open = Some(Open { id: file.id, key });
        self.after_open();
        Ok(())
    }

    // --- Unlocking and locking. ---------------------------------------------

    /// What an attempt needs before the expensive part: the file, or the wait
    /// still owed. Split from [`Self::finish_unlock`] so the global lock is not
    /// held across Argon2 (a third of a second the rest of the process would
    /// spend waiting for a keychain read).
    pub fn begin_unlock(
        &self,
        env: &dyn Env,
        now: Instant,
    ) -> AppResult<Result<VaultFile, Unlock>> {
        if let Some(not_before) = self.not_before {
            if now < not_before {
                return Ok(Err(Unlock::TooSoon {
                    retry_after: not_before - now,
                }));
            }
        }
        match self.mode(env) {
            Mode::Unlocked => Ok(Err(Unlock::Opened)),
            Mode::Off => Err(AppError::InvalidInput("the app lock is off".into())),
            Mode::Broken(why) => Err(AppError::Vault(why)),
            Mode::Locked => {
                let bytes = env
                    .read_file()?
                    .ok_or_else(|| AppError::Vault("vault.json is missing".into()))?;
                Ok(Ok(VaultFile::parse(&bytes)?))
            }
        }
    }

    pub fn finish_unlock(
        &mut self,
        env: &dyn Env,
        file: &VaultFile,
        opened: Result<VaultKey, OpenError>,
        now: Instant,
    ) -> AppResult<Unlock> {
        match opened {
            Ok(key) => {
                // Proves the key opens the secrets too, before calling it open.
                let secrets = file.secrets(&key)?;
                self.open = Some(Open {
                    id: file.id.clone(),
                    key,
                });
                self.after_open();
                self.sweep(env, &secrets);
                Ok(Unlock::Opened)
            }
            Err(OpenError::NoSlot) => Err(AppError::Vault(
                "vault.json has no master-password slot".into(),
            )),
            Err(OpenError::Wrong) => {
                self.failures = self.failures.saturating_add(1);
                let retry_after = backoff(self.failures);
                self.not_before = Some(now + retry_after);
                Ok(Unlock::Wrong {
                    failures: self.failures,
                    retry_after,
                })
            }
        }
    }

    /// Drop the key. The secrets were never cached, so this is all of it.
    pub fn lock(&mut self) {
        self.open = None;
    }

    pub fn touch(&mut self, now: Instant) {
        self.last_activity = now;
    }

    pub fn idle_expired(&self, now: Instant, idle_minutes: u32) -> bool {
        self.open.is_some() && idle_expired(self.last_activity, now, idle_minutes)
    }

    /// The wait still owed before the next attempt, for the wall to count down.
    pub fn retry_after(&self, now: Instant) -> Duration {
        self.not_before
            .map_or(Duration::ZERO, |t| t.saturating_duration_since(now))
    }

    fn after_open(&mut self) {
        self.failures = 0;
        self.not_before = None;
        self.last_activity = Instant::now();
    }

    /// Delete from the keychain every account the vault holds. Idempotent and
    /// best-effort: it finishes what a crash during [`Self::enable`] left, and
    /// removes a copy something wrote around the vault (an older build sharing
    /// the keychain).
    fn sweep(&self, env: &dyn Env, secrets: &SecretMap) {
        for account in secrets.0.keys() {
            if let Err(e) = env.keychain_delete(account) {
                eprintln!("[vault] could not remove a keychain copy of {account}: {e}");
            }
        }
    }
}

/// The floor for a master password. See [`MIN_PASSWORD_CHARS`].
pub fn check_strength(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::InvalidInput(format!(
            "the master password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    Ok(())
}

// --- This process's vault. ---------------------------------------------------

/// The real storage: the OS keychain (`keychain::os`) and `vault.json` in the
/// keystore directory shared by every build.
struct OsEnv;

impl Env for OsEnv {
    fn keychain_get(&self, account: &str) -> AppResult<Option<String>> {
        crate::keychain::os::get(account)
    }
    fn keychain_set(&self, account: &str, secret: &str) -> AppResult<()> {
        crate::keychain::os::set(account, secret)
    }
    fn keychain_delete(&self, account: &str) -> AppResult<()> {
        crate::keychain::os::delete(account)
    }
    fn read_file(&self) -> AppResult<Option<Vec<u8>>> {
        let path = crate::state_file::keystore_path(FILE)?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn write_file(&self, bytes: &[u8]) -> AppResult<()> {
        crate::state_file::write_atomic(&crate::state_file::keystore_path(FILE)?, bytes)
    }
    fn remove_file(&self) -> AppResult<()> {
        match std::fs::remove_file(crate::state_file::keystore_path(FILE)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

fn global() -> MutexGuard<'static, Vault> {
    static VAULT: OnceLock<Mutex<Vault>> = OnceLock::new();
    VAULT
        .get_or_init(|| Mutex::new(Vault::default()))
        .lock()
        // A panic while holding it leaves a `Vault` whose fields are each
        // still valid on their own; refusing every secret for the rest of the
        // session would be the worse outcome.
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `f` against this process's vault and the real storage.
pub fn with<T>(f: impl FnOnce(&mut Vault, &dyn Env) -> T) -> T {
    f(&mut global(), &OsEnv)
}

/// Whether this process must refuse anything behind the lock.
pub fn is_locked() -> bool {
    #[cfg(test)]
    if let Some(forced) = FORCED.with(std::cell::Cell::get) {
        return forced;
    }
    with(|v, env| v.is_locked(env))
}

#[cfg(test)]
thread_local! {
    static FORCED: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Make [`is_locked`] answer `locked` on this thread, for the callers that
/// cannot be handed an [`Env`] (the MCP sidecar's paths). Per thread so a
/// test cannot lock its neighbours; `#[tokio::test]` runs on the test's own.
#[cfg(test)]
pub fn force_locked_on_this_thread(locked: Option<bool>) {
    FORCED.with(|f| f.set(locked));
}

/// Unlock with the master password, running Argon2 without holding the
/// process-wide lock. Blocking: call it from `spawn_blocking`.
pub fn unlock(password: &str) -> AppResult<Unlock> {
    let now = Instant::now();
    let file = match with(|v, env| v.begin_unlock(env, now))? {
        Ok(file) => file,
        Err(answer) => return Ok(answer),
    };
    let opened = file.open_with_password(password)?;
    with(|v, env| v.finish_unlock(env, &file, opened, Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::file::tests::FAST;
    use super::*;
    use std::collections::HashMap;

    /// The keychain and the vault file, in memory.
    #[derive(Default)]
    struct MemEnv {
        keychain: Mutex<HashMap<String, String>>,
        file: Mutex<Option<Vec<u8>>>,
    }

    impl Env for MemEnv {
        fn keychain_get(&self, a: &str) -> AppResult<Option<String>> {
            Ok(self.keychain.lock().unwrap().get(a).cloned())
        }
        fn keychain_set(&self, a: &str, s: &str) -> AppResult<()> {
            self.keychain.lock().unwrap().insert(a.into(), s.into());
            Ok(())
        }
        fn keychain_delete(&self, a: &str) -> AppResult<()> {
            self.keychain.lock().unwrap().remove(a);
            Ok(())
        }
        fn read_file(&self) -> AppResult<Option<Vec<u8>>> {
            Ok(self.file.lock().unwrap().clone())
        }
        fn write_file(&self, b: &[u8]) -> AppResult<()> {
            *self.file.lock().unwrap() = Some(b.to_vec());
            Ok(())
        }
        fn remove_file(&self) -> AppResult<()> {
            *self.file.lock().unwrap() = None;
            Ok(())
        }
    }

    const PASSWORD: &str = "correct horse battery";

    fn env_with(pairs: &[(&str, &str)]) -> MemEnv {
        let env = MemEnv::default();
        for (a, s) in pairs {
            env.keychain_set(a, s).unwrap();
        }
        env
    }

    fn accounts(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn unlock(vault: &mut Vault, env: &MemEnv, password: &str) -> Unlock {
        let now = Instant::now();
        let file = match vault.begin_unlock(env, now).unwrap() {
            Ok(file) => file,
            Err(answer) => return answer,
        };
        let opened = file.open_with_password(password).unwrap();
        vault.finish_unlock(env, &file, opened, now).unwrap()
    }

    #[test]
    fn with_the_lock_off_secrets_stay_in_the_keychain() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let vault = Vault::new(FAST);
        assert_eq!(vault.mode(&env), Mode::Off);
        assert_eq!(
            vault.get(&env, "p1::root").unwrap().as_deref(),
            Some("hunter2")
        );
        vault.set(&env, "p2::app", "s3cret").unwrap();
        assert!(env.keychain_get("p2::app").unwrap().is_some());
    }

    #[test]
    fn enabling_moves_every_secret_out_of_the_keychain() {
        let env = env_with(&[
            ("p1::root", "hunter2"),
            ("origin::o1", "phrase"),
            ("other", "x"),
        ]);
        let mut vault = Vault::new(FAST);
        let moved = vault
            .enable(
                &env,
                PASSWORD,
                &accounts(&["p1::root", "origin::o1", "absent"]),
            )
            .unwrap();
        assert_eq!(moved, 2);
        assert_eq!(env.keychain_get("p1::root").unwrap(), None);
        assert_eq!(env.keychain_get("origin::o1").unwrap(), None);
        assert_eq!(
            env.keychain_get("other").unwrap().as_deref(),
            Some("x"),
            "not ours to move"
        );
        assert!(env.keychain_get(SENTINEL_ACCOUNT).unwrap().is_some());
        assert_eq!(vault.mode(&env), Mode::Unlocked);
        assert_eq!(
            vault.get(&env, "p1::root").unwrap().as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn locked_every_operation_is_refused_and_unlocking_restores_them() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let mut vault = Vault::new(FAST);
        vault
            .enable(&env, PASSWORD, &accounts(&["p1::root"]))
            .unwrap();
        vault.lock();
        assert_eq!(vault.mode(&env), Mode::Locked);
        assert!(matches!(vault.get(&env, "p1::root"), Err(AppError::Locked)));
        assert!(matches!(
            vault.set(&env, "p1::root", "x"),
            Err(AppError::Locked)
        ));
        assert!(matches!(
            vault.delete(&env, "p1::root"),
            Err(AppError::Locked)
        ));

        assert_eq!(unlock(&mut vault, &env, PASSWORD), Unlock::Opened);
        assert_eq!(
            vault.get(&env, "p1::root").unwrap().as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn a_wrong_password_fails_and_the_wait_grows() {
        let env = env_with(&[]);
        let mut vault = Vault::new(FAST);
        vault.enable(&env, PASSWORD, &[]).unwrap();
        vault.lock();
        assert!(matches!(
            unlock(&mut vault, &env, "wrong password!!"),
            Unlock::Wrong { failures: 1, retry_after } if retry_after.is_zero()
        ));
        assert!(matches!(
            unlock(&mut vault, &env, "wrong password!!"),
            Unlock::Wrong { failures: 2, .. }
        ));
        match unlock(&mut vault, &env, "wrong password!!") {
            Unlock::Wrong {
                failures: 3,
                retry_after,
            } => assert_eq!(retry_after, Duration::from_secs(2)),
            other => panic!("{other:?}"),
        }
        // Even the right password is not checked inside the wait.
        assert!(matches!(
            unlock(&mut vault, &env, PASSWORD),
            Unlock::TooSoon { .. }
        ));
        assert_eq!(vault.mode(&env), Mode::Locked);
    }

    #[test]
    fn the_wait_doubles_up_to_five_minutes() {
        assert_eq!(backoff(0), Duration::ZERO);
        assert_eq!(backoff(2), Duration::ZERO);
        assert_eq!(backoff(3), Duration::from_secs(2));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(10), Duration::from_secs(256));
        assert_eq!(backoff(11), Duration::from_secs(300));
        assert_eq!(backoff(u32::MAX), Duration::from_secs(300));
    }

    #[test]
    fn writes_while_unlocked_land_in_the_vault_never_the_keychain() {
        let env = env_with(&[]);
        let mut vault = Vault::new(FAST);
        vault.enable(&env, PASSWORD, &[]).unwrap();
        vault.set(&env, "p9::new", "fresh").unwrap();
        assert_eq!(env.keychain_get("p9::new").unwrap(), None);
        vault.lock();
        unlock(&mut vault, &env, PASSWORD);
        assert_eq!(
            vault.get(&env, "p9::new").unwrap().as_deref(),
            Some("fresh")
        );
        vault.delete(&env, "p9::new").unwrap();
        assert_eq!(vault.get(&env, "p9::new").unwrap(), None);
    }

    #[test]
    fn disabling_puts_the_secrets_back_as_they_were() {
        let before = [
            ("p1::root", "hunter2"),
            ("p1::ssh::deploy", "key phrase"),
            ("ai::https://api.x", "sk-1"),
        ];
        let env = env_with(&before);
        let mut vault = Vault::new(FAST);
        vault
            .enable(
                &env,
                PASSWORD,
                &accounts(&["p1::root", "p1::ssh::deploy", "ai::https://api.x"]),
            )
            .unwrap();
        assert!(matches!(
            vault.disable(&env, "not the password"),
            Err(AppError::InvalidInput(_))
        ));
        assert_eq!(vault.disable(&env, PASSWORD).unwrap(), 3);
        for (account, secret) in before {
            assert_eq!(env.keychain_get(account).unwrap().as_deref(), Some(secret));
        }
        assert_eq!(env.keychain_get(SENTINEL_ACCOUNT).unwrap(), None);
        assert!(env.read_file().unwrap().is_none());
        assert_eq!(vault.mode(&env), Mode::Off);
    }

    #[test]
    fn deleting_the_vault_file_does_not_turn_the_lock_off() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let mut vault = Vault::new(FAST);
        vault
            .enable(&env, PASSWORD, &accounts(&["p1::root"]))
            .unwrap();
        vault.lock();
        env.remove_file().unwrap();
        assert!(matches!(vault.mode(&env), Mode::Broken(_)));
        assert!(matches!(vault.get(&env, "p1::root"), Err(AppError::Locked)));
        // Removing the marker too leaves an app with the lock off and nothing
        // to read: the secret is gone, not handed back.
        env.keychain_delete(SENTINEL_ACCOUNT).unwrap();
        assert_eq!(vault.mode(&env), Mode::Off);
        assert_eq!(vault.get(&env, "p1::root").unwrap(), None);
    }

    #[test]
    fn an_unreadable_vault_is_broken_not_empty() {
        let env = env_with(&[]);
        env.write_file(b"{ not json").unwrap();
        let vault = Vault::new(FAST);
        assert!(matches!(vault.mode(&env), Mode::Broken(_)));
        assert!(matches!(vault.get(&env, "anything"), Err(AppError::Locked)));
    }

    #[test]
    fn a_reset_forgets_the_secrets_and_keeps_the_lock_on() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let mut vault = Vault::new(FAST);
        vault
            .enable(&env, PASSWORD, &accounts(&["p1::root"]))
            .unwrap();
        vault.lock();
        vault.reset(&env, "a brand new password").unwrap();
        assert_eq!(vault.get(&env, "p1::root").unwrap(), None);
        vault.lock();
        assert_eq!(vault.mode(&env), Mode::Locked);
        assert!(matches!(
            unlock(&mut vault, &env, PASSWORD),
            Unlock::Wrong { .. }
        ));
    }

    #[test]
    fn changing_the_password_keeps_every_secret() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let mut vault = Vault::new(FAST);
        vault
            .enable(&env, PASSWORD, &accounts(&["p1::root"]))
            .unwrap();
        assert!(vault
            .change_password(&env, "wrong current!!", "next password!!")
            .is_err());
        vault
            .change_password(&env, PASSWORD, "next password!!")
            .unwrap();
        vault.lock();
        assert!(matches!(
            unlock(&mut vault, &env, PASSWORD),
            Unlock::Wrong { .. }
        ));
        assert_eq!(unlock(&mut vault, &env, "next password!!"), Unlock::Opened);
        assert_eq!(
            vault.get(&env, "p1::root").unwrap().as_deref(),
            Some("hunter2")
        );
    }

    #[test]
    fn a_crash_after_sealing_leaves_copies_that_the_next_unlock_removes() {
        let env = env_with(&[("p1::root", "hunter2")]);
        let mut vault = Vault::new(FAST);
        vault
            .enable(&env, PASSWORD, &accounts(&["p1::root"]))
            .unwrap();
        vault.lock();
        // What a crash between writing the vault and deleting the keychain
        // copy leaves behind (or an older build writing around the vault).
        env.keychain_set("p1::root", "hunter2").unwrap();
        unlock(&mut vault, &env, PASSWORD);
        assert_eq!(env.keychain_get("p1::root").unwrap(), None);
    }

    #[test]
    fn a_short_master_password_is_refused() {
        let env = env_with(&[]);
        let mut vault = Vault::new(FAST);
        assert!(vault.enable(&env, "too short", &[]).is_err());
        assert_eq!(vault.mode(&env), Mode::Off);
    }

    #[test]
    fn idle_locks_only_after_the_configured_minutes_and_never_at_zero() {
        let start = Instant::now();
        assert!(!idle_expired(start, start + Duration::from_secs(899), 15));
        assert!(idle_expired(start, start + Duration::from_secs(900), 15));
        assert!(!idle_expired(start, start + Duration::from_secs(86_400), 0));
    }

    /// The real cost, measured rather than assumed (ADR #118 quotes it). Run
    /// with `cargo test --release -- --ignored vault_kdf_cost --nocapture`.
    #[test]
    #[ignore]
    fn vault_kdf_cost() {
        let started = Instant::now();
        file::derive(PASSWORD, &[0u8; 16], DEFAULT_KDF).unwrap();
        eprintln!("argon2id {DEFAULT_KDF:?}: {:?}", started.elapsed());
    }
}
