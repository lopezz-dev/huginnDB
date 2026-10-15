//! Where a BYOK key lives — and where it does not.
//!
//! The key goes to the OS keychain, under the same service every other HuginnDB
//! credential uses ([`crate::keychain::SERVICE`]), and **never** to
//! `prefs.json`. `prefs.json` is world-readable, is copied around by people
//! syncing their dotfiles, and is the file this project already promises holds
//! nothing sensitive; a provider key in it would be a plaintext secret on disk,
//! which is the one thing the connection layer has never done either.
//!
//! It is also never returned to the frontend. Phase 3's command surface exposes
//! `ai_set_key` / `ai_has_key` / `ai_clear_key`, so the webview can tell the
//! user whether a key is stored and can replace it, but cannot read it back.
//! The key is only ever assembled into an `Authorization` header inside
//! [`crate::ai::provider`], which is the same shape as connection passwords:
//! the webview knows a secret exists and never holds one.
//!
//! # Keyed by the endpoint's origin
//!
//! Not by a provider name the user types. Two reasons, and the first is a
//! security property: a key belongs to the host that issued it, so keying by
//! origin makes it structurally impossible for an OpenRouter token to be sent
//! to a different endpoint after the base URL is edited. The second is
//! ergonomic — a user who keeps a local Ollama *and* a cloud provider
//! configured switches between them without retyping anything, because the two
//! keys (one of them absent) sit under different accounts.
//!
//! Origin means scheme + host + port, so `/v1` and `/api/v1` on the same host
//! share a key. That is correct: they are the same server, and Azure's
//! per-deployment paths all authenticate with one key.

use crate::error::AppResult;
use crate::keychain;
use reqwest::Url;

/// Prefix distinguishing an AI provider key from a connection password in the
/// platform's credential manager, where the user sees both.
const PREFIX: &str = "ai::";

/// Keychain account holding the key for `base_url`'s endpoint.
pub fn key_account(base_url: &Url) -> String {
    format!("{PREFIX}{}", base_url.origin().ascii_serialization())
}

/// Store (or replace) the key for this endpoint.
pub fn set_key(base_url: &Url, key: &str) -> AppResult<()> {
    keychain::set_password(&key_account(base_url), key.trim())
}

/// Read the key, for [`crate::ai::provider`] only.
///
/// `Ok(None)` for an endpoint with no stored key — which is the normal state
/// for every local server, not an error.
pub fn key(base_url: &Url) -> AppResult<Option<String>> {
    Ok(keychain::get_password(&key_account(base_url))?
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty()))
}

/// Whether a key is stored. The only thing the frontend is told.
pub fn has_key(base_url: &Url) -> AppResult<bool> {
    Ok(key(base_url)?.is_some())
}

/// Forget the key for this endpoint. Succeeds when there was none.
pub fn clear_key(base_url: &Url) -> AppResult<()> {
    keychain::delete_password(&key_account(base_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the account derivation is tested. The four functions above reach
    /// the real OS keychain, and a test that writes to it pollutes the
    /// developer's own credential manager for the same reason convention #52's
    /// tests overwrote a real `profiles.json` — a global side effect with no
    /// override seam.
    fn account(base: &str) -> String {
        key_account(&Url::parse(base).expect("test URL must parse"))
    }

    #[test]
    fn an_account_names_the_endpoints_origin_under_the_ai_prefix() {
        assert_eq!(
            account("http://localhost:11434/v1"),
            "ai::http://localhost:11434"
        );
        assert_eq!(
            account("https://openrouter.ai/api/v1"),
            "ai::https://openrouter.ai"
        );
    }

    /// The security property: editing the base URL to point somewhere else
    /// must not carry the old key along.
    #[test]
    fn a_different_host_scheme_or_port_is_a_different_key() {
        let cloud = account("https://openrouter.ai/api/v1");
        for other in [
            "https://api.openai.com/v1",
            "http://openrouter.ai/api/v1",
            "https://openrouter.ai:8443/api/v1",
        ] {
            assert_ne!(cloud, account(other), "{other} must not reuse the key");
        }
    }

    /// And the ergonomic one: the same server reached through two API paths is
    /// one provider with one key.
    #[test]
    fn the_path_is_not_part_of_the_key() {
        assert_eq!(
            account("https://host.example/v1"),
            account("https://host.example/openai/deployments/gpt4/")
        );
    }

    /// The prefix is what keeps a provider key visually distinct from a
    /// connection password in Credential Manager, where profiles are stored as
    /// `<uuid>::<username>`.
    #[test]
    fn an_account_cannot_collide_with_a_connection_password() {
        let account = account("http://localhost:11434/v1");
        assert!(account.starts_with(PREFIX), "{account}");
    }
}
