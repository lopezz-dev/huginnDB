//! Which database user a connection signs in as — the one place that decides.
//!
//! Phase 3 of managed policy (`docs/POLICY_ROADMAP.md` §7) gives each person
//! their own database user, so the database itself enforces what the policy
//! says instead of only HuginnDB. A shared origin publishes a connection with
//! the team's user (`erp_app`); a person connects as `alopez`, with their own
//! password, and the team's never has to reach their machine.
//!
//! The user is decided in this order:
//!
//! 1. **The policy**, when the rule for this endpoint carries a `dbUser`
//!    template. It is pinned: an organization that gives everyone their own
//!    database user does not want one of them signing in as the shared one.
//! 2. **The person's own choice** (`ConnectionProfile::personal_username`),
//!    kept on this machine only.
//! 3. **The connection's user**, as the profile (or the origin) has it.
//!
//! Everything that opens a pool goes through [`effective_profile`] first —
//! `connect_inner`, `test_connection`, a per-database view, the MCP sidecar's
//! `ensure_connected` — so the user the driver signs in as and the keychain
//! account the password is read from (`id::<user>`) can never disagree.

use crate::error::AppResult;
use crate::policy::SharedPolicy;
use crate::state::{ConnectionProfile, Driver};

/// Where a connection's personal user came from, for the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersonalSource {
    /// A rule's `dbUser`: fixed by the organization.
    Policy,
    /// The person chose it on this machine.
    Local,
}

/// The personal user in force for `profile`, and where it came from; `None`
/// when the connection signs in with its own user.
pub fn personal_user(
    policy: &SharedPolicy,
    profile: &ConnectionProfile,
) -> Option<(String, PersonalSource)> {
    if profile.driver == Driver::Sqlite {
        // No users: a file is protected by its ACL alone.
        return None;
    }
    if let Some(user) = crate::policy::pinned_db_user(policy, profile) {
        return Some((user, PersonalSource::Policy));
    }
    profile
        .personal_username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|u| (u.to_string(), PersonalSource::Local))
}

/// `profile` as it signs in: with the personal user in place of the
/// published one when there is one. A clone, for opening a pool — never
/// written back, so `profiles.json` keeps the connection as it was published.
///
/// On the copy, `personal_username` is set whenever a personal user is in
/// force, so [`crate::commands::connection::resolve_password`] can tell that
/// the password is the person's own and must be there, even on MongoDB (whose
/// password is otherwise optional).
pub fn effective_profile(policy: &SharedPolicy, profile: &ConnectionProfile) -> ConnectionProfile {
    let mut effective = profile.clone();
    let Some((user, _)) = personal_user(policy, profile) else {
        return effective;
    };
    if effective.driver == Driver::Mongo {
        // A MongoDB connection string carries its own user, and the driver
        // prefers it to anything we set — so the published user (and any
        // password embedded with it) is taken out of the string, and the
        // credential is built from the personal user and their own password.
        if let Some(cs) = effective.connection_string.as_deref() {
            effective.connection_string = Some(strip_uri_userinfo(cs));
        }
    }
    effective.username = user.clone();
    effective.personal_username = Some(user);
    effective
}

/// `mongodb://user:pass@h1,h2/db?x` → `mongodb://h1,h2/db?x`. The authority
/// ends at the first `/` or `?` after the scheme (a host list cannot contain
/// either), and its user info is everything up to the **last** `@` in it —
/// a password may contain an `@` only percent-encoded, but a sloppy one is
/// still better cut at the last than the first.
fn strip_uri_userinfo(uri: &str) -> String {
    let Some(scheme_end) = uri.find("://").map(|i| i + 3) else {
        return uri.to_string();
    };
    let rest = &uri[scheme_end..];
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{}{}", &uri[..scheme_end], &rest[at + 1..]),
        None => uri.to_string(),
    }
}

/// A password found inside a connection string's user info, and the string
/// without it.
#[derive(Debug, PartialEq, Eq)]
pub struct EmbeddedPassword {
    /// The URI with the user kept and the password taken out:
    /// `mongodb://user@h1,h2/db?x`. The user stays because it says who signs
    /// in; the password is put back at connect time from the keychain
    /// (`db::mongo::open_pool` fills it in only when the URI carries none).
    pub uri: String,
    /// The user, percent-decoded — what `ConnectionProfile::username` holds.
    pub username: String,
    /// The password, percent-decoded, as the driver would have read it.
    pub password: String,
}

/// Split the password out of `mongodb://user:pass@hosts/…`.
///
/// `None` when there is nothing to move: no user info, a user without a
/// password, an empty password, or user info that does not percent-decode —
/// the driver would refuse that URI too, so nothing is lost by leaving it.
/// Same authority rule as [`strip_uri_userinfo`]: it ends at the first `/` or
/// `?`, and the user info runs to the **last** `@` in it.
pub fn split_embedded_password(uri: &str) -> Option<EmbeddedPassword> {
    let scheme_end = uri.find("://")? + 3;
    let rest = &uri[scheme_end..];
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let at = rest[..authority_end].rfind('@')?;
    let (user, pass) = rest[..at].split_once(':')?;
    if pass.is_empty() {
        return None;
    }
    let password = percent_decode(pass)?;
    let username = percent_decode(user)?;
    let hosts = &rest[at + 1..];
    let uri = if user.is_empty() {
        format!("{}{hosts}", &uri[..scheme_end])
    } else {
        format!("{}{user}@{hosts}", &uri[..scheme_end])
    };
    Some(EmbeddedPassword {
        uri,
        username,
        password,
    })
}

/// `%XX` decoding for URI user info. `None` on a malformed escape or a result
/// that is not UTF-8. `+` is left alone: it means a space only in a query.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Take a password embedded in a MongoDB profile's connection string out of
/// it, returning the password. The profile keeps the URI without it, and its
/// `username` becomes the URI's user, so `keyring_account()` names the account
/// the password has to be stored under.
///
/// Pure: the caller decides where the password goes. It must never be written
/// back into anything that reaches disk unencrypted — `profiles.json`, an
/// export or a shared origin — which is the whole reason this exists:
/// `connection_string` is metadata, not a secret slot, so a password inside it
/// travelled everywhere metadata does.
pub fn take_embedded_password(profile: &mut ConnectionProfile) -> Option<String> {
    if profile.driver != Driver::Mongo {
        return None;
    }
    let split = split_embedded_password(profile.connection_string.as_deref()?)?;
    profile.connection_string = Some(split.uri);
    profile.username = split.username;
    Some(split.password)
}

/// Move a password embedded in `profile`'s connection string into the
/// keychain, returning whether one was moved.
///
/// The keychain is written **before** the profile is touched, so a refusal
/// (the app lock is closed, the keychain is unavailable) leaves the profile
/// exactly as it was and the password where it was — still exposed, but not
/// lost. The startup and post-unlock sweep simply tries again next time.
pub fn secure_embedded_password(profile: &mut ConnectionProfile) -> AppResult<bool> {
    let mut stripped = profile.clone();
    let Some(password) = take_embedded_password(&mut stripped) else {
        return Ok(false);
    };
    crate::keychain::set_password(&stripped.keyring_account(), &password)?;
    *profile = stripped;
    Ok(true)
}

/// Sweep the saved profiles for passwords still embedded in a MongoDB
/// connection string, move each into the keychain, and rewrite
/// `profiles.json` if any moved. Returns whether anything changed.
///
/// For profiles saved before the save path learned to do this itself. Run at
/// startup and again after the app lock opens, because a closed lock refuses
/// the keychain write — [`secure_embedded_password`] then leaves that profile
/// alone rather than dropping its password. Session-only (ephemeral) profiles
/// are skipped: they never reach disk, so there is nothing to protect.
///
/// Called from the desktop app only, never the MCP sidecar: two processes
/// rewriting `profiles.json` is a race this does not need to start.
pub fn migrate_embedded_passwords(
    profiles_lock: &parking_lot::RwLock<Vec<ConnectionProfile>>,
) -> bool {
    let needs_work = |p: &ConnectionProfile| {
        !p.ephemeral
            && p.driver == Driver::Mongo
            && p.connection_string
                .as_deref()
                .is_some_and(|cs| split_embedded_password(cs).is_some())
    };
    // Read first: the common case — nothing to move — never takes the write
    // lock, and this runs on every unlock.
    if !profiles_lock.read().iter().any(needs_work) {
        return false;
    }
    let mut profiles = profiles_lock.write();
    let mut changed = false;
    for p in profiles.iter_mut().filter(|p| needs_work(p)) {
        if matches!(secure_embedded_password(p), Ok(true)) {
            changed = true;
        }
    }
    if changed {
        // Best effort, like the rest of startup: a failed write leaves the old
        // file, and the next sweep finds the same work and redoes it.
        let _ = crate::store::save_profiles(&profiles);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PolicyState;
    use crate::testkit;
    use parking_lot::RwLock;
    use std::sync::Arc;

    fn unmanaged() -> SharedPolicy {
        Arc::new(RwLock::new(PolicyState::Unmanaged))
    }

    /// A policy whose `dbUser` on `erp.local` is `template`, for whoever runs
    /// the tests (the rules match the OS account through `defaultRole`).
    fn pinning(template: &str) -> SharedPolicy {
        let text = format!(
            r#"{{
                "version": 1, "defaultRole": "staff",
                "roles": {{ "staff": {{ "rules": [
                    {{ "endpoint": {{ "host": "other.local" }}, "dbUser": "nope" }},
                    {{ "endpoint": {{ "host": "erp.local" }}, "dbUser": {template:?},
                       "human": ["select"] }}
                ] }} }}
            }}"#
        );
        let (doc, _) = crate::policy::model::PolicyDoc::parse(&text).unwrap();
        Arc::new(RwLock::new(PolicyState::Active {
            doc: Arc::new(doc),
            source: "test".into(),
            warnings: Vec::new(),
        }))
    }

    fn erp() -> ConnectionProfile {
        ConnectionProfile {
            driver: Driver::Postgres,
            host: "erp.local".into(),
            username: "erp_app".into(),
            ..testkit::profile("erp")
        }
    }

    #[test]
    fn without_a_personal_user_the_published_one_signs_in() {
        let p = effective_profile(&unmanaged(), &erp());
        assert_eq!(p.username, "erp_app");
        assert_eq!(p.personal_username, None);
        assert_eq!(p.keyring_account(), "erp::erp_app");
    }

    #[test]
    fn a_local_choice_replaces_the_user_and_the_keychain_account() {
        let profile = ConnectionProfile {
            personal_username: Some(" alopez ".into()),
            ..erp()
        };
        let p = effective_profile(&unmanaged(), &profile);
        assert_eq!(p.username, "alopez");
        assert_eq!(p.keyring_account(), "erp::alopez");
        assert_eq!(
            personal_user(&unmanaged(), &profile),
            Some(("alopez".into(), PersonalSource::Local))
        );
    }

    #[test]
    fn the_policy_pins_the_user_over_a_local_choice() {
        let user = crate::policy::current_user();
        if user.is_empty() {
            return;
        }
        let profile = ConnectionProfile {
            personal_username: Some("someone_else".into()),
            ..erp()
        };
        let expected = format!("{}_ro", crate::policy::model::normalise_user(user));
        let (got, source) = personal_user(&pinning("{user}_ro"), &profile).unwrap();
        assert_eq!(
            (got.as_str(), source),
            (expected.as_str(), PersonalSource::Policy)
        );
        // A rule for another endpoint pins nothing here.
        let elsewhere = ConnectionProfile {
            host: "crm.local".into(),
            ..erp()
        };
        assert_eq!(personal_user(&pinning("{user}"), &elsewhere), None);
    }

    #[test]
    fn sqlite_has_no_users_to_pin() {
        let file = ConnectionProfile {
            driver: Driver::Sqlite,
            personal_username: Some("alopez".into()),
            ..testkit::profile("f")
        };
        assert_eq!(personal_user(&unmanaged(), &file), None);
    }

    #[test]
    fn a_mongo_uri_loses_the_published_user_and_password() {
        let profile = ConnectionProfile {
            driver: Driver::Mongo,
            connection_string: Some(
                "mongodb://erp_app:s%40cret@h1:27017,h2:27017/billing?authSource=admin".into(),
            ),
            personal_username: Some("alopez".into()),
            ..erp()
        };
        let p = effective_profile(&unmanaged(), &profile);
        assert_eq!(
            p.connection_string.as_deref(),
            Some("mongodb://h1:27017,h2:27017/billing?authSource=admin")
        );
        assert_eq!(p.username, "alopez");
    }

    #[test]
    fn stripping_leaves_a_uri_without_user_info_alone() {
        for uri in [
            "mongodb://h1/db",
            "mongodb+srv://cluster.example.net/?retryWrites=true",
            "mongodb://h1/db?note=a@b",
        ] {
            assert_eq!(strip_uri_userinfo(uri), uri);
        }
        assert_eq!(
            strip_uri_userinfo("mongodb+srv://u:p@cluster.example.net"),
            "mongodb+srv://cluster.example.net"
        );
    }

    #[test]
    fn an_embedded_password_is_split_out_and_decoded() {
        let got = split_embedded_password(
            "mongodb://erp%5Fapp:s%40c:ret@h1:27017,h2:27017/billing?authSource=admin",
        )
        .unwrap();
        assert_eq!(
            got,
            EmbeddedPassword {
                uri: "mongodb://erp%5Fapp@h1:27017,h2:27017/billing?authSource=admin".into(),
                username: "erp_app".into(),
                password: "s@c:ret".into(),
            }
        );
        let srv = split_embedded_password("mongodb+srv://u:p%2Bq@cluster.example.net").unwrap();
        assert_eq!(srv.uri, "mongodb+srv://u@cluster.example.net");
        assert_eq!(srv.password, "p+q");
    }

    #[test]
    fn nothing_to_split_without_a_password() {
        for uri in [
            "mongodb://h1/db",
            "mongodb://user@h1/db",
            "mongodb://user:@h1/db",
            "mongodb://h1/db?note=a:b@c",
            "mongodb://u:bad%zz@h1/db",
            "not a uri",
        ] {
            assert_eq!(split_embedded_password(uri), None, "{uri}");
        }
        // A password with no user still moves; the URI keeps no user info.
        let anon = split_embedded_password("mongodb://:p@h1/db").unwrap();
        assert_eq!(
            (anon.uri.as_str(), anon.username.as_str()),
            ("mongodb://h1/db", "")
        );
    }

    #[test]
    fn taking_the_password_rekeys_the_profile_to_the_uri_user() {
        let mut profile = ConnectionProfile {
            driver: Driver::Mongo,
            username: String::new(),
            connection_string: Some("mongodb://erp_app:pw@h1/db".into()),
            ..testkit::profile("m")
        };
        assert_eq!(take_embedded_password(&mut profile).as_deref(), Some("pw"));
        assert_eq!(
            profile.connection_string.as_deref(),
            Some("mongodb://erp_app@h1/db")
        );
        assert_eq!(profile.keyring_account(), "m::erp_app");
        // Nothing left to take the second time.
        assert_eq!(take_embedded_password(&mut profile), None);
    }

    #[test]
    fn only_mongo_profiles_are_touched() {
        let mut pg = ConnectionProfile {
            connection_string: Some("postgres://u:pw@h/db".into()),
            ..erp()
        };
        assert_eq!(take_embedded_password(&mut pg), None);
        assert_eq!(
            pg.connection_string.as_deref(),
            Some("postgres://u:pw@h/db")
        );
    }
}
