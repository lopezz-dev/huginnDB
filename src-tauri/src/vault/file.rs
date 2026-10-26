//! The vault's on-disk format and the cryptography over it — pure, no I/O.
//!
//! One random 256-bit **vault key** encrypts the secrets (AES-256-GCM). That key
//! is never stored as such: each [`Slot`] holds a copy of it *wrapped* (also
//! AES-256-GCM) under a key derived from something only the person has. The
//! master password's slot always exists; the format leaves room for more (a
//! Windows Hello slot, later a Touch ID one) without touching the secrets,
//! which is the point of slots — adding or replacing a way in re-wraps 32
//! bytes, and the ciphertext of the secrets never moves.
//!
//! Every ciphertext is bound to this vault's `id` through its associated data,
//! so a slot or a secrets blob pasted in from another vault fails to open
//! instead of opening something else. See ADR #118.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key as AesKey, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, AppResult};

/// The format this build writes. A file with a higher number is refused rather
/// than guessed at: losing a secret to a misread is worse than asking the
/// person to update.
pub const VERSION: u32 = 1;

/// The vault key. Zeroed when dropped, which is what locking amounts to.
pub type VaultKey = Zeroizing<[u8; 32]>;

/// Argon2id cost for a new password slot. Stored in the slot, so raising these
/// later only affects slots written after the change, and an old vault still
/// opens with the parameters it was sealed under.
///
/// 256 MiB, three passes, one lane: about 300 ms on the maintainer's laptop in
/// a release build (ADR #118 has the measurements). Memory is what makes a GPU
/// or ASIC farm expensive, so it is the parameter pushed hardest — 64 MiB, the
/// usual default, measured at 67 ms, cheap enough that an offline guess cost
/// less than the wall's own wait. The unlock happens a few times a day and the
/// memory is held only while it runs. One lane because the `parallel` feature
/// would bring `rayon` into the tree; lanes computed one after another cost
/// the defender exactly what they cost an attacker, so `p` above one buys
/// nothing without threads.
pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_kib: 256 * 1024,
    t: 3,
    p: 1,
};

/// The cheapest parameters a file may name. A vault that asks for less is
/// refused as tampered with: lowering the cost in the file is not a way to
/// make the *existing* ciphertext cheaper to attack (it was sealed under the
/// real cost), but accepting it would let an edited file make the person's
/// next password change seal under the cheap one.
const MIN_KDF: KdfParams = KdfParams {
    m_kib: 19 * 1024,
    t: 2,
    p: 1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

/// One way in: a wrapped copy of the vault key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Slot {
    /// The master password. Always present: it is the recovery path.
    #[serde(rename_all = "camelCase")]
    Password {
        kdf: KdfParams,
        salt: String,
        nonce: String,
        wrapped_key: String,
    },
}

impl Slot {
    fn kind(&self) -> &'static str {
        match self {
            Slot::Password { .. } => "password",
        }
    }
}

/// `vault.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultFile {
    pub version: u32,
    /// Random per vault. Bound into every ciphertext's associated data, and
    /// what the keychain marker names (see `vault::SENTINEL_ACCOUNT`).
    pub id: String,
    pub slots: Vec<Slot>,
    pub nonce: String,
    pub secrets: String,
}

/// The decrypted secrets: keychain account → secret. Zeroed when dropped.
#[derive(Default, Clone, PartialEq, Eq)]
pub struct SecretMap(pub BTreeMap<String, String>);

impl Drop for SecretMap {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            value.zeroize();
        }
    }
}

impl std::fmt::Debug for SecretMap {
    /// Account names only. A `{:?}` in a log line must never print a password.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set().entries(self.0.keys()).finish()
    }
}

/// Why a slot did not open.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The authentication tag did not verify: wrong password (or a slot
    /// tampered with — the two cannot be told apart, by design).
    Wrong,
    /// The file has no slot of the kind asked for.
    NoSlot,
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}

fn decode(field: &str, value: &str) -> AppResult<Vec<u8>> {
    B64.decode(value)
        .map_err(|e| AppError::Vault(format!("vault.json: {field} is not base64: {e}")))
}

fn secrets_aad(id: &str) -> Vec<u8> {
    format!("huginndb-vault/v{VERSION}/{id}/secrets").into_bytes()
}

fn slot_aad(id: &str, kind: &str) -> Vec<u8> {
    format!("huginndb-vault/v{VERSION}/{id}/slot/{kind}").into_bytes()
}

fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> AppResult<(String, String)> {
    let nonce = random::<12>();
    let ciphertext = Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(key))
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AppError::Vault("encryption failed".into()))?;
    Ok((B64.encode(nonce), B64.encode(ciphertext)))
}

/// `None` when the tag does not verify.
fn open(
    key: &[u8; 32],
    aad: &[u8],
    nonce: &str,
    ciphertext: &str,
) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    let nonce = decode("nonce", nonce)?;
    if nonce.len() != 12 {
        return Err(AppError::Vault(
            "vault.json: a nonce is not 12 bytes".into(),
        ));
    }
    let ciphertext = decode("ciphertext", ciphertext)?;
    Ok(Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(key))
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .ok()
        .map(Zeroizing::new))
}

/// Argon2id over `password`, into a key-encryption key.
pub fn derive(password: &str, salt: &[u8], kdf: KdfParams) -> AppResult<Zeroizing<[u8; 32]>> {
    let params = argon2::Params::new(kdf.m_kib, kdf.t, kdf.p, Some(32))
        .map_err(|e| AppError::Vault(format!("argon2 parameters: {e}")))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| AppError::Vault(format!("argon2: {e}")))?;
    Ok(out)
}

fn password_slot(id: &str, key: &[u8; 32], password: &str, kdf: KdfParams) -> AppResult<Slot> {
    let salt = random::<16>();
    let kek = derive(password, &salt, kdf)?;
    let (nonce, wrapped_key) = seal(&kek, &slot_aad(id, "password"), key)?;
    Ok(Slot::Password {
        kdf,
        salt: B64.encode(salt),
        nonce,
        wrapped_key,
    })
}

fn key_from(bytes: &[u8]) -> AppResult<VaultKey> {
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| AppError::Vault("vault.json: a wrapped key is not 32 bytes".into()))?;
    Ok(Zeroizing::new(array))
}

impl VaultFile {
    /// A new vault holding `secrets`, with one password slot.
    pub fn create(
        password: &str,
        secrets: &SecretMap,
        kdf: KdfParams,
    ) -> AppResult<(Self, VaultKey)> {
        let key: VaultKey = Zeroizing::new(random::<32>());
        let id = uuid::Uuid::new_v4().to_string();
        let slot = password_slot(&id, &key, password, kdf)?;
        let mut file = VaultFile {
            version: VERSION,
            id,
            slots: vec![slot],
            nonce: String::new(),
            secrets: String::new(),
        };
        file.reseal(&key, secrets)?;
        Ok((file, key))
    }

    /// Parse and sanity-check a file. Errors here are a broken vault, never an
    /// empty one: the caller must not treat them as "no secrets".
    pub fn parse(bytes: &[u8]) -> AppResult<Self> {
        let file: VaultFile = serde_json::from_slice(bytes)
            .map_err(|e| AppError::Vault(format!("vault.json cannot be read: {e}")))?;
        if file.version > VERSION {
            return Err(AppError::Vault(format!(
                "vault.json was written by a newer HuginnDB (format {}); update the app",
                file.version
            )));
        }
        if !file
            .slots
            .iter()
            .any(|s| matches!(s, Slot::Password { .. }))
        {
            return Err(AppError::Vault(
                "vault.json has no master-password slot".into(),
            ));
        }
        for slot in &file.slots {
            let Slot::Password { kdf, .. } = slot;
            if kdf.m_kib < MIN_KDF.m_kib || kdf.t < MIN_KDF.t || kdf.p < MIN_KDF.p {
                return Err(AppError::Vault(
                    "vault.json names key-derivation costs below the minimum".into(),
                ));
            }
        }
        Ok(file)
    }

    pub fn to_bytes(&self) -> AppResult<Vec<u8>> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    /// Unwrap the vault key with the master password. Runs Argon2: call it off
    /// the async runtime.
    pub fn open_with_password(&self, password: &str) -> AppResult<Result<VaultKey, OpenError>> {
        let Some(Slot::Password {
            kdf,
            salt,
            nonce,
            wrapped_key,
        }) = self
            .slots
            .iter()
            .find(|s| matches!(s, Slot::Password { .. }))
        else {
            return Ok(Err(OpenError::NoSlot));
        };
        let kek = derive(password, &decode("salt", salt)?, *kdf)?;
        match open(&kek, &slot_aad(&self.id, "password"), nonce, wrapped_key)? {
            Some(bytes) => Ok(Ok(key_from(&bytes)?)),
            None => Ok(Err(OpenError::Wrong)),
        }
    }

    /// Decrypt the secrets with an unwrapped key.
    pub fn secrets(&self, key: &[u8; 32]) -> AppResult<SecretMap> {
        let plaintext =
            open(key, &secrets_aad(&self.id), &self.nonce, &self.secrets)?.ok_or_else(|| {
                AppError::Vault("the vault's secrets do not open with its own key".into())
            })?;
        let map: BTreeMap<String, String> = serde_json::from_slice(&plaintext)
            .map_err(|e| AppError::Vault(format!("the vault's secrets cannot be read: {e}")))?;
        Ok(SecretMap(map))
    }

    /// Re-encrypt `secrets` under a fresh nonce. The slots are untouched.
    pub fn reseal(&mut self, key: &[u8; 32], secrets: &SecretMap) -> AppResult<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(&secrets.0)?);
        let (nonce, ciphertext) = seal(key, &secrets_aad(&self.id), &plaintext)?;
        self.nonce = nonce;
        self.secrets = ciphertext;
        Ok(())
    }

    /// Replace the master-password slot. The vault key — and so the secrets'
    /// ciphertext and every other slot — stays as it was.
    pub fn replace_password(
        &mut self,
        key: &[u8; 32],
        password: &str,
        kdf: KdfParams,
    ) -> AppResult<()> {
        let slot = password_slot(&self.id, key, password, kdf)?;
        let kind = slot.kind();
        self.slots.retain(|s| s.kind() != kind);
        self.slots.insert(0, slot);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The cheapest parameters [`VaultFile::parse`] accepts, so the suite does
    /// not spend 64 MiB × 3 passes per derivation.
    pub(crate) const FAST: KdfParams = MIN_KDF;

    pub(crate) fn map(pairs: &[(&str, &str)]) -> SecretMap {
        SecretMap(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[test]
    fn a_vault_round_trips_through_its_bytes_and_the_right_password() {
        let secrets = map(&[("p1::root", "hunter2"), ("origin::o1", "team phrase")]);
        let (file, key) = VaultFile::create("correct horse battery", &secrets, FAST).unwrap();
        let reread = VaultFile::parse(&file.to_bytes().unwrap()).unwrap();
        assert_eq!(reread, file);
        let opened = reread
            .open_with_password("correct horse battery")
            .unwrap()
            .unwrap();
        assert_eq!(*opened, *key);
        assert_eq!(reread.secrets(&opened).unwrap(), secrets);
    }

    #[test]
    fn a_wrong_password_does_not_open_the_vault() {
        let (file, _) = VaultFile::create("correct horse battery", &map(&[]), FAST).unwrap();
        assert_eq!(
            file.open_with_password("correct horse batterY").unwrap(),
            Err(OpenError::Wrong)
        );
    }

    #[test]
    fn the_plaintext_never_reaches_the_file() {
        let secrets = map(&[("p1::root", "a-very-recognisable-password")]);
        let (file, _) = VaultFile::create("correct horse battery", &secrets, FAST).unwrap();
        let text = String::from_utf8(file.to_bytes().unwrap()).unwrap();
        assert!(!text.contains("a-very-recognisable-password"));
        assert!(!text.contains("correct horse battery"));
    }

    #[test]
    fn changing_the_password_keeps_the_key_and_the_secrets() {
        let secrets = map(&[("p1::root", "hunter2")]);
        let (mut file, key) = VaultFile::create("first password!", &secrets, FAST).unwrap();
        let before = file.secrets.clone();
        file.replace_password(&key, "second password!", FAST)
            .unwrap();
        assert_eq!(
            file.secrets, before,
            "the secrets' ciphertext must not move"
        );
        assert_eq!(file.slots.len(), 1, "the old password slot is replaced");
        assert_eq!(
            file.open_with_password("first password!").unwrap(),
            Err(OpenError::Wrong)
        );
        let opened = file
            .open_with_password("second password!")
            .unwrap()
            .unwrap();
        assert_eq!(file.secrets(&opened).unwrap(), secrets);
    }

    #[test]
    fn a_slot_from_another_vault_does_not_open_this_one() {
        let (a, _) = VaultFile::create("same password!!", &map(&[]), FAST).unwrap();
        let (mut b, _) = VaultFile::create("same password!!", &map(&[]), FAST).unwrap();
        b.slots = a.slots.clone();
        assert_eq!(
            b.open_with_password("same password!!").unwrap(),
            Err(OpenError::Wrong),
            "the slot's associated data names its vault"
        );
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_error_never_an_empty_vault() {
        assert!(VaultFile::parse(b"").is_err());
        assert!(VaultFile::parse(b"{}").is_err());
        let (mut file, _) = VaultFile::create("correct horse battery", &map(&[]), FAST).unwrap();
        file.version = VERSION + 1;
        assert!(VaultFile::parse(&file.to_bytes().unwrap()).is_err());
        let (mut file, _) = VaultFile::create("correct horse battery", &map(&[]), FAST).unwrap();
        file.slots.clear();
        assert!(VaultFile::parse(&file.to_bytes().unwrap()).is_err());
    }

    #[test]
    fn a_file_edited_down_to_a_cheap_kdf_is_refused() {
        let (mut file, _) = VaultFile::create("correct horse battery", &map(&[]), FAST).unwrap();
        let Slot::Password { kdf, .. } = &mut file.slots[0];
        kdf.m_kib = 8;
        assert!(VaultFile::parse(&file.to_bytes().unwrap()).is_err());
    }

    #[test]
    fn debug_never_prints_a_secret() {
        let secrets = map(&[("p1::root", "hunter2")]);
        let rendered = format!("{secrets:?}");
        assert!(rendered.contains("p1::root"));
        assert!(!rendered.contains("hunter2"));
    }
}
