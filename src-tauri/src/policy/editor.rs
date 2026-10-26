//! The in-app policy editor's backend — phase 4 of managed policy.
//!
//! **Who may edit is decided by the file system, never by the app.** The
//! policy is not signed (D6): the share's permissions are what stop a user
//! rewriting it, so they are also what decides who may use this editor. It
//! opens anything, and saves only where a real write succeeds (the same probe
//! the shared-origin editor uses, `state_file::probe_writable`). There is no
//! "administrator" flag anywhere: it would be a second answer to a question
//! the share already answers, and it would protect nothing, since whoever can
//! write the file can edit it by hand.
//!
//! **The document is never re-serialized.** The editor holds the policy as
//! JSON text and every check parses it with [`PolicyDoc::parse`], the parser
//! that applies it — so what is saved is exactly what was validated, and a
//! field this version does not model cannot be lost in a round trip through
//! structs. Saving refuses text that does not parse: the editor never
//! publishes a policy that would lock every machine out.
//!
//! **Saving is the shared-origin editor's sequence** (ADR 56): validate, probe,
//! compare the SHA-256 the draft was opened against, keep a `.bak`, write — but
//! with `state_file::write_replace`, which never leaves the path without a
//! file, because every machine reads it on a timer and a missing policy fails
//! closed.

use super::model::PolicyDoc;
use super::source::{self, Anchor};
use crate::error::{AppError, AppResult};
use crate::state::ConnectionProfile;
use crate::state_file::{self, WritableProbe};
use serde::Serialize;
use std::path::Path;

/// What this machine's anchor says, for the editor to decide what it can offer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorInfo {
    /// `none` (unmanaged), `file` (a policy file, normally on a share — the
    /// one kind that can be edited in place), `registry` (the policy inline
    /// in `HKLM\…\Policy`), `systemFile` (inline in `managed-policy.json`), or
    /// `error` (the anchor itself could not be read).
    pub kind: &'static str,
    /// The policy file, when `kind` is `file`.
    pub path: Option<String>,
    /// The anchor that names it: the registry value or the system file.
    pub origin: Option<String>,
    pub error: Option<String>,
}

pub fn anchor_info() -> AnchorInfo {
    match source::read_anchor() {
        Ok(None) => AnchorInfo {
            kind: "none",
            path: None,
            origin: None,
            error: None,
        },
        Ok(Some(Anchor::Source { origin, path })) => AnchorInfo {
            kind: "file",
            path: Some(path),
            origin: Some(origin),
            error: None,
        },
        Ok(Some(Anchor::Inline { origin, .. })) => AnchorInfo {
            kind: if origin.starts_with("HKLM\\") {
                "registry"
            } else {
                "systemFile"
            },
            path: None,
            origin: Some(origin),
            error: None,
        },
        Err(error) => AnchorInfo {
            kind: "error",
            path: None,
            origin: None,
            error: Some(error),
        },
    }
}

/// What the file looked like when the draft was opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditBase {
    /// `""` for a file that does not exist yet.
    pub sha256: String,
    pub mtime: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    /// Why the text is not a valid policy — the parser's own message, which
    /// names the role and rule where it can.
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEditDoc {
    pub anchor: AnchorInfo,
    /// The policy as it stands: the file's text, or the inline policy's, or
    /// `""` on an unmanaged machine.
    pub text: String,
    /// For a `file` anchor whose file could be read (or does not exist yet).
    pub base: Option<EditBase>,
    /// For a `file` anchor: can this machine write it?
    pub writable: Option<WritableProbe>,
    /// The file named by the anchor could not be read.
    pub read_error: Option<String>,
    pub validation: Validation,
}

/// Parse `text` as a policy, the way the machines applying it will.
pub fn validate(text: &str) -> (Option<PolicyDoc>, Validation) {
    if text.len() as u64 > source::MAX_BYTES {
        return (
            None,
            Validation {
                error: Some(format!(
                    "the policy is larger than {} KB, which HuginnDB refuses to read",
                    source::MAX_BYTES / 1024
                )),
                warnings: Vec::new(),
            },
        );
    }
    match PolicyDoc::parse(text) {
        Ok((doc, warnings)) => (
            Some(doc),
            Validation {
                error: None,
                warnings,
            },
        ),
        Err(error) => (
            None,
            Validation {
                error: Some(error),
                warnings: Vec::new(),
            },
        ),
    }
}

fn read_text(path: &Path) -> std::io::Result<(String, Vec<u8>)> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok((text, bytes))
}

/// Everything the editor needs to open. Opens a broken policy too — fixing
/// one is the point.
pub fn open() -> PolicyEditDoc {
    let anchor = anchor_info();
    let (text, base, writable, read_error) = match (&anchor.kind, &anchor.path) {
        (&"file", Some(path)) => {
            let path = Path::new(path);
            let probe = state_file::probe_writable(path);
            match read_text(path) {
                Ok((text, bytes)) => (
                    text,
                    Some(EditBase {
                        sha256: state_file::sha256_hex(&bytes),
                        mtime: state_file::mtime_of(path),
                    }),
                    Some(probe),
                    None,
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
                    String::new(),
                    Some(EditBase {
                        sha256: String::new(),
                        mtime: None,
                    }),
                    Some(probe),
                    None,
                ),
                Err(e) => (
                    String::new(),
                    None,
                    Some(probe),
                    Some(format!("cannot read {}: {e}", path.display())),
                ),
            }
        }
        _ => {
            let text = match source::read_anchor() {
                Ok(Some(Anchor::Inline { text, .. })) => text,
                _ => String::new(),
            };
            (text, None, None, None)
        }
    };
    let validation = if text.trim().is_empty() {
        Validation::default()
    } else {
        validate(&text).1
    };
    PolicyEditDoc {
        anchor,
        text,
        base,
        writable,
        read_error,
        validation,
    }
}

/// One connection, as a given user would see it under a draft.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConnection {
    pub id: String,
    pub name: String,
    /// What the person may do.
    pub human: super::enforce::ConnectionAccess,
    /// What their AI may do — never more than `human` (D1).
    pub ai: super::enforce::ConnectionAccess,
    /// The database user they would sign in as (`dbUser`, expanded).
    pub db_user: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub user: String,
    pub role: String,
    /// Whether the user is named in the draft, or falls to `defaultRole`.
    pub listed: bool,
    pub connections: Vec<PreviewConnection>,
}

/// What `user` would get on each of `profiles` under `doc` — the "view as"
/// the editor shows before anything is saved. Pure: the same decision the
/// commands make ([`super::enforce::connection_access`]), with the draft and
/// a user of the editor's choosing instead of the policy in force and the OS
/// account.
pub fn preview(doc: &PolicyDoc, user: &str, profiles: &[ConnectionProfile]) -> Preview {
    use super::model::{normalise_user, Subject};
    let wanted = normalise_user(user);
    let listed = doc.users.keys().any(|u| normalise_user(u) == wanted);
    let connections = profiles
        .iter()
        .filter(|p| !p.ephemeral)
        .map(|p| PreviewConnection {
            id: p.id.clone(),
            name: p.name.clone(),
            human: super::enforce::connection_access(doc, user, Some(p), &p.id, Subject::Human),
            ai: super::enforce::connection_access(doc, user, Some(p), &p.id, Subject::Ai),
            db_user: super::resolve::pinned_db_user(doc, user, p),
        })
        .collect();
    Preview {
        user: user.to_string(),
        role: doc.role_for(user).0.to_string(),
        listed,
        connections,
    }
}

/// How a save ended. A conflict is an outcome, not an error: it carries the
/// file as it is now, which an IPC error string could not (ADR 56).
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved {
        base: EditBase,
        /// Whether the previous revision was kept as `<file>.bak`.
        backup: bool,
    },
    Conflict {
        /// The file as somebody else left it.
        text: String,
        base: EditBase,
    },
}

/// Write `text` to `path` as the policy, if it is one, if this machine may,
/// and if nobody has changed the file since it was opened at `base_sha256`
/// (`""`: it did not exist).
pub fn save(path: &Path, text: &str, base_sha256: &str) -> AppResult<SaveOutcome> {
    if let Some(error) = validate(text).1.error {
        return Err(AppError::InvalidInput(format!(
            "the policy was not saved, because it is not valid: {error}"
        )));
    }
    let probe = state_file::probe_writable(path);
    if !probe.writable {
        return Err(AppError::InvalidInput(format!(
            "cannot write to {}: {}",
            path.display(),
            probe.reason.unwrap_or_default()
        )));
    }
    let current = match read_text(path) {
        Ok(found) => Some(found),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let current_sha = current
        .as_ref()
        .map(|(_, bytes)| state_file::sha256_hex(bytes))
        .unwrap_or_default();
    if current_sha != base_sha256 {
        let (text, _) = current.unwrap_or_default();
        return Ok(SaveOutcome::Conflict {
            text,
            base: EditBase {
                sha256: current_sha,
                mtime: state_file::mtime_of(path),
            },
        });
    }
    // Errors swallowed: a `.bak` someone left read-only must not be what stops
    // today's fix (the same call the origin editor makes).
    let backup = state_file::backup_previous(path).unwrap_or(false);
    state_file::write_replace(path, text.as_bytes())?;
    Ok(SaveOutcome::Saved {
        base: EditBase {
            sha256: state_file::sha256_hex(text.as_bytes()),
            mtime: state_file::mtime_of(path),
        },
        backup,
    })
}

/// A policy written to a new file, and how to point the machines at it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedPolicy {
    pub path: String,
    pub base: EditBase,
    /// For one machine, in an elevated prompt.
    pub reg_command: String,
    /// The same value, as Group Policy or Intune set it.
    pub registry_key: String,
    pub registry_value: String,
    /// Things worth knowing before the machines are pointed at it.
    pub warnings: Vec<String>,
}

/// Create the policy file at `path` — the "Create policy" wizard, and the way
/// an inline policy (registry or Program Files) is moved to a file that can be
/// edited here. Refuses an existing file: replacing one is what [`save`], with
/// its conflict check, is for.
pub fn create(path: &Path, text: &str) -> AppResult<CreatedPolicy> {
    if path.exists() {
        return Err(AppError::InvalidInput(format!(
            "{} already exists; open it with the policy editor instead",
            path.display()
        )));
    }
    match save(path, text, "")? {
        SaveOutcome::Saved { base, .. } => {
            let shown = path.display().to_string();
            let mut warnings = Vec::new();
            if !shown.starts_with("\\\\") {
                warnings.push(
                    "This is not a network path (\\\\server\\share\\…). Every machine has to \
                     reach the file by the same path, and a drive letter can differ from one \
                     machine to the next."
                        .to_string(),
                );
            }
            Ok(CreatedPolicy {
                reg_command: format!(
                    "reg add \"HKLM\\SOFTWARE\\Policies\\HuginnDB\" /v PolicySource /t REG_SZ /d \"{shown}\" /f"
                ),
                registry_key: "HKLM\\SOFTWARE\\Policies\\HuginnDB".to_string(),
                registry_value: "PolicySource".to_string(),
                path: shown,
                base,
                warnings,
            })
        }
        // `save` with an empty base on a path checked absent a moment ago: a
        // conflict means another machine created it in between.
        SaveOutcome::Conflict { .. } => Err(AppError::InvalidInput(format!(
            "{} was created by someone else just now; open it with the policy editor",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;
    use crate::testkit;

    const GOOD: &str = r#"{
        "version": 1, "defaultRole": "none",
        "users": { "ana": "sales" },
        "roles": { "none": {}, "sales": { "rules": [{
            "endpoint": { "host": "erp.local" },
            "databases": ["billing"],
            "human": ["select", "insert"], "ai": ["select"], "dbUser": "erp_{user}"
        }] } }
    }"#;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("huginndb-policy-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn a_policy_that_does_not_parse_is_never_saved() {
        let path = scratch("p.json");
        let err = save(&path, r#"{ "version": 1, "relatons": {} }"#, "").unwrap_err();
        assert!(err.to_string().contains("not valid"), "{err}");
        assert!(!path.exists());
    }

    #[test]
    fn a_save_over_a_file_changed_since_it_was_opened_is_a_conflict() {
        let path = scratch("p.json");
        std::fs::write(&path, GOOD).unwrap();
        let opened = state_file::sha256_hex(GOOD.as_bytes());
        // Someone else saves in between.
        let theirs = GOOD.replace("\"ana\"", "\"bob\"");
        std::fs::write(&path, &theirs).unwrap();
        match save(&path, GOOD, &opened).unwrap() {
            SaveOutcome::Conflict { text, .. } => assert_eq!(text, theirs),
            other => panic!("expected a conflict, got {other:?}"),
        }
        // Their file is untouched.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), theirs);
    }

    #[test]
    fn a_save_replaces_the_file_keeps_a_backup_and_rebases() {
        let path = scratch("p.json");
        std::fs::write(&path, GOOD).unwrap();
        let mine = GOOD.replace("\"ana\"", "\"carla\"");
        let outcome = save(&path, &mine, &state_file::sha256_hex(GOOD.as_bytes())).unwrap();
        let SaveOutcome::Saved { base, backup } = outcome else {
            panic!("expected saved");
        };
        assert!(backup);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), mine);
        let mut bak = path.clone().into_os_string();
        bak.push(".bak");
        assert_eq!(std::fs::read_to_string(bak).unwrap(), GOOD);
        assert_eq!(base.sha256, state_file::sha256_hex(mine.as_bytes()));
        // The next save from the same editor goes through on the new base.
        let again = mine.replace("\"carla\"", "\"dani\"");
        assert!(matches!(
            save(&path, &again, &base.sha256).unwrap(),
            SaveOutcome::Saved { .. }
        ));
    }

    #[test]
    fn create_refuses_an_existing_file_and_says_how_to_point_machines_at_it() {
        let path = scratch("p.json");
        let created = create(&path, GOOD).unwrap();
        assert!(created.reg_command.contains("/v PolicySource"));
        assert!(created.reg_command.contains(&created.path));
        // A temp dir is not a network path.
        assert!(created.warnings.iter().any(|w| w.contains("network path")));
        assert!(create(&path, GOOD).is_err());
    }

    #[test]
    fn the_preview_answers_for_any_user_under_a_draft() {
        let (doc, _) = PolicyDoc::parse(GOOD).unwrap();
        let erp = ConnectionProfile {
            driver: Driver::Postgres,
            host: "erp.local".into(),
            database: "billing".into(),
            ..testkit::profile("erp")
        };
        let crm = ConnectionProfile {
            driver: Driver::Postgres,
            host: "crm.local".into(),
            ..testkit::profile("crm")
        };
        let ana = preview(&doc, r"ACME\Ana", &[erp.clone(), crm.clone()]);
        assert_eq!((ana.role.as_str(), ana.listed), ("sales", true));
        let on_erp = &ana.connections[0];
        assert!(on_erp.human.visible);
        assert_eq!(on_erp.human.verbs, ["select", "insert"]);
        assert_eq!(on_erp.ai.verbs, ["select"]);
        assert_eq!(on_erp.db_user.as_deref(), Some("erp_ana"));
        // A server no rule names is refused (unmanagedConnections: deny).
        assert!(!ana.connections[1].human.visible);
        // Someone the draft does not list falls to the default role.
        let bob = preview(&doc, "bob", &[erp]);
        assert_eq!((bob.role.as_str(), bob.listed), ("none", false));
        assert!(!bob.connections[0].human.visible);
    }

    #[test]
    fn the_preview_says_which_columns_a_limited_verb_writes() {
        let text = GOOD.replacen(
            "\"human\": [\"select\", \"insert\"]",
            "\"human\": [\"select\", \"insert\"], \"columns\": { \"insert\": [\"number\"] }",
            1,
        );
        assert_ne!(text, GOOD, "the fixture's human list moved");
        let (doc, _) = PolicyDoc::parse(&text).unwrap();
        let erp = ConnectionProfile {
            driver: Driver::Postgres,
            host: "erp.local".into(),
            database: "billing".into(),
            ..testkit::profile("erp")
        };
        let ana = preview(&doc, r"ACME\Ana", &[erp]);
        let columns = &ana.connections[0].human.columns;
        assert_eq!(columns.insert, Some(vec!["number".to_string()]));
        // Not granted at all: an empty list, not "every column".
        assert_eq!(columns.update, Some(Vec::new()));
    }

    #[test]
    fn validation_reports_the_parsers_own_message() {
        let (doc, v) = validate(GOOD);
        assert!(doc.is_some() && v.error.is_none());
        let (_, v) = validate(&GOOD.replace("\"select\", \"insert\"", "\"selct\""));
        assert!(v.error.unwrap().contains("selct"));
    }
}
