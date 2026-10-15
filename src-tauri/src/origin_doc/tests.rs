//! Tests for the shared-origin document model.
//!
//! Every one of these is pure: no disk, no keychain, no `AppState`. That is not
//! a stylistic preference — `state_file::path` resolves through the developer's
//! real config directory under `cargo test`, so a test that reaches
//! `store::save_profiles` (or constructs `AppState`) overwrites their own saved
//! connections. See convention #52 for the time that happened.

use super::*;
use crate::json_schemas::JsonSchemaBinding;
use crate::state::{Driver, McpWritePolicy, SshAuth, SshTunnel};
use crate::testkit;

/// An envelope with a distinguishable ciphertext, without paying 600 000 PBKDF2
/// rounds per test. The fingerprint only hashes the *ciphertext*, so any string
/// that differs is enough to exercise every comparison in this module.
fn envelope(db: Option<&str>, ssh: Option<&str>) -> ExportedSecret {
    ExportedSecret {
        db_password: db.map(str::to_string),
        ssh_secret: ssh.map(str::to_string),
    }
}

fn tunnel() -> SshTunnel {
    SshTunnel {
        host: "jump".into(),
        port: 22,
        username: "ops".into(),
        auth: SshAuth::Password,
        local_port: 0,
        host_key_policy: Default::default(),
    }
}

/// A published connection with a kept envelope.
///
/// Tunnelled whenever it carries an SSH secret, because `transfer::secret_slots`
/// only lands one for a profile that *has* an SSH account — a blob with no
/// tunnel to land it in is not a slot anybody pays for.
fn kept(id: &str, db: Option<&str>, ssh: Option<&str>) -> DraftConnection {
    DraftConnection {
        profile: ConnectionProfile {
            ssh_tunnel: ssh.map(|_| tunnel()),
            ..testkit::profile(id)
        },
        secret: SecretSlot::Keep {
            envelope: envelope(db, ssh),
        },
    }
}

fn file_of(draft: &OriginDraft) -> EnvironmentExportFile {
    build_origin_file(draft, "2026-08-26T10:00:00Z")
}

fn json(value: &impl Serialize) -> serde_json::Value {
    serde_json::to_value(value).expect("serialisable")
}

fn draft_with(connections: Vec<DraftConnection>) -> OriginDraft {
    OriginDraft {
        connections,
        ..OriginDraft::default()
    }
}

fn environment(source_id: &str, name: &str, members: &[&str]) -> DraftEnvironment {
    DraftEnvironment {
        source_environment_id: source_id.into(),
        name: name.into(),
        connection_ids: members.iter().map(|s| s.to_string()).collect(),
        ..DraftEnvironment::default()
    }
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

/// The property the whole feature rests on: opening a published file and saving
/// it back unchanged must reproduce it exactly. Same spirit as
/// `pipeline_source_round_trips_through_bson` (ADR #33) — the failure mode
/// here is not an error either, it is a publish that silently drops a field the
/// editor did not model, and every consumer adopting the loss on their next
/// sync.
#[test]
fn file_round_trips_through_the_draft() {
    let original = EnvironmentExportFile {
        meta: {
            let mut m = transfer::metadata(KIND_ENVIRONMENT, true, "2026-08-26T10:00:00Z");
            m.maintainer = Some("Ana".into());
            m.revision = Some(14);
            m.note = Some("added the Ribesalbes box".into());
            m
        },
        environments: vec![ExportedEnvironmentBundle {
            environment: ExportedEnvironment {
                name: "Producción".into(),
                color: Some("#ff0000".into()),
                icon: Some("server".into()),
                theme_id: Some("nord".into()),
                source_environment_id: "src-1".into(),
            },
            connection_ids: vec!["p1".into(), "p2".into()],
            origins: vec![ExportedOrigin {
                name: "Equipo".into(),
                path: r"\\share\huginndb\team.json".into(),
            }],
        }],
        profiles: vec![
            ExportedProfile {
                profile: testkit::profile("p1"),
                secrets: Some(envelope(Some("db-blob"), Some("ssh-blob"))),
            },
            ExportedProfile {
                profile: testkit::profile("p2"),
                secrets: None,
            },
        ],
        json_schemas: JsonSchemaBundle {
            schemas: Vec::new(),
            bindings: vec![JsonSchemaBinding {
                id: "b1".into(),
                schema_id: "s1".into(),
                connection_id: Some("p1".into()),
                column: "payload".into(),
                ..JsonSchemaBinding::default()
            }],
        },
    };

    let expected = json(&original);
    let rebuilt = build_origin_file(&draft_from_file(original), "2026-08-26T10:00:00Z");
    assert_eq!(expected, json(&rebuilt));
}

/// The other direction, for a draft that carries no unresolved
/// `FromKeychain` — which is every draft that came out of a file, and the only
/// shape the equality can hold for: a `FromKeychain` slot publishes nothing, so
/// reading the file back necessarily reports it as `Clear`.
#[test]
fn draft_round_trips_through_the_file() {
    let draft = OriginDraft {
        meta: DraftMeta {
            maintainer: Some("Ana".into()),
            revision: Some(3),
            note: None,
            encrypted: true,
        },
        environments: vec![environment("src-1", "Producción", &["p1"])],
        connections: vec![kept("p1", Some("db-blob"), None), unpublished("p2")],
        schemas: Vec::new(),
        bindings: Vec::new(),
    };
    let reloaded = draft_from_file(file_of(&draft));
    assert_eq!(json(&draft), json(&reloaded));
}

fn unpublished(id: &str) -> DraftConnection {
    DraftConnection {
        profile: testkit::profile(id),
        secret: SecretSlot::Clear,
    }
}

/// A file written before the editor existed carries no `revision`, and rebuilding
/// it must not invent one. `Some(0)` and `None` being distinct is what buys this;
/// a plain `u32` would grow a `revision: 0` on every legacy file it touched.
#[test]
fn a_legacy_file_gains_no_revision_field() {
    let draft = draft_from_file(EnvironmentExportFile {
        meta: transfer::metadata(KIND_ENVIRONMENT, false, "2026-01-01T00:00:00Z"),
        environments: Vec::new(),
        profiles: Vec::new(),
        json_schemas: JsonSchemaBundle::default(),
    });
    assert_eq!(None, draft.meta.revision);
    let rebuilt = json(&file_of(&draft));
    let meta = rebuilt.get("meta").expect("meta");
    assert!(meta.get("revision").is_none(), "got {meta:?}");
    assert!(meta.get("maintainer").is_none());
    assert!(meta.get("note").is_none());
}

/// `meta.encrypted` is recomputed from the slots actually written, never copied
/// from the draft. A header claiming secrets the body does not carry makes
/// `sync_origin` refuse the file for want of a passphrase it does not need.
#[test]
fn the_header_cannot_claim_secrets_the_body_lacks() {
    let draft = OriginDraft {
        meta: DraftMeta {
            encrypted: true,
            ..DraftMeta::default()
        },
        connections: vec![unpublished("p1")],
        ..OriginDraft::default()
    };
    assert!(!file_of(&draft).meta.encrypted);

    // And the converse: a kept envelope sets it even if the draft says otherwise.
    let draft = draft_with(vec![kept("p1", Some("blob"), None)]);
    assert!(!draft.meta.encrypted);
    assert!(file_of(&draft).meta.encrypted);
}

/// A `FromKeychain` slot the command layer could not resolve publishes nothing,
/// rather than an empty envelope that would make the header claim encryption.
#[test]
fn an_unresolved_keychain_slot_publishes_nothing() {
    let draft = draft_with(vec![DraftConnection {
        profile: testkit::profile("p1"),
        secret: SecretSlot::FromKeychain,
    }]);
    let file = file_of(&draft);
    assert!(file.profiles[0].secrets.is_none());
    assert!(!file.meta.encrypted);
}

/// A blank maintainer is absent, not `""`.
#[test]
fn blank_publication_metadata_is_absent() {
    let draft = OriginDraft {
        meta: DraftMeta {
            maintainer: Some("   ".into()),
            note: Some(String::new()),
            ..DraftMeta::default()
        },
        ..OriginDraft::default()
    };
    let meta = file_of(&draft).meta;
    assert_eq!(None, meta.maintainer);
    assert_eq!(None, meta.note);
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/// A connection no environment lists is the *loose* connection the editor shows
/// under "unassigned" — publishable, and not an error: `merge_into` puts every
/// profile in the file into the consumer's global pool regardless.
#[test]
fn a_connection_in_no_environment_is_unassigned() {
    let draft = OriginDraft {
        environments: vec![environment("src-1", "Prod", &["p1"])],
        connections: vec![unpublished("p1"), unpublished("p2")],
        ..OriginDraft::default()
    };
    let m = membership(&draft);
    assert_eq!(vec!["p2".to_string()], m.unassigned);
    assert!(m.dangling.is_empty());
}

/// An environment naming a connection the document dropped keeps the id (the
/// consumer ignores a stale `visible_connections` entry) but is reported, since
/// it almost always means half a removal.
#[test]
fn an_environment_naming_an_absent_connection_is_dangling() {
    let draft = OriginDraft {
        environments: vec![
            environment("src-1", "Prod", &["p1", "gone"]),
            environment("src-2", "Staging", &["gone"]),
        ],
        connections: vec![unpublished("p1")],
        ..OriginDraft::default()
    };
    let m = membership(&draft);
    assert_eq!(vec!["gone".to_string()], m.dangling, "reported once");
    assert!(m.unassigned.is_empty());
    // The builder keeps it: rewriting the user's data behind their back is the
    // one thing worse than telling them about it.
    assert_eq!(
        vec!["p1".to_string(), "gone".to_string()],
        file_of(&draft).environments[0].connection_ids
    );
}

// ---------------------------------------------------------------------------
// Publish impact
// ---------------------------------------------------------------------------

/// The headline case, and manual test 1 of the plan: renaming an environment
/// costs the team **nothing**. No connection is refreshed, and not one PBKDF2
/// round is spent — which is only true because a kept envelope is copied
/// verbatim (invariant 3).
#[test]
fn renaming_an_environment_re_encrypts_nothing() {
    let before = OriginDraft {
        environments: vec![environment("src-1", "Producción", &["p1", "p2"])],
        connections: vec![
            kept("p1", Some("db-1"), None),
            kept("p2", Some("db-2"), Some("ssh-2")),
        ],
        ..OriginDraft::default()
    };
    let base = file_of(&before);

    let mut after = before.clone();
    after.environments[0].name = "Producción (ES)".into();

    let impact = publish_impact(&after, &base);
    assert!(impact.connections.refreshed.is_empty());
    assert_eq!(2, impact.connections.unchanged);
    assert!(impact.connections.vanished.is_empty());
    assert_eq!(0, impact.reencryption.slots);
    assert_eq!(0, impact.reencryption.pbkdf2_rounds);
    assert!(!impact.reencryption.estimated);
    assert_eq!(1, impact.environments.refreshed.len());
    assert_eq!("src-1", impact.environments.refreshed[0].id);
}

/// A changed field is reported; the connections around it are not. The split is
/// read off the *simulated* merge rather than re-derived, so it needs no
/// knowledge of which fields a refresh preserves locally.
#[test]
fn only_the_connection_that_changed_is_reported_as_refreshed() {
    let before = draft_with(vec![kept("p1", Some("db-1"), None), unpublished("p2")]);
    let base = file_of(&before);

    let mut after = before.clone();
    after.connections[1].profile.host = "new-host".into();

    let impact = publish_impact(&after, &base);
    assert_eq!(1, impact.connections.refreshed.len());
    assert_eq!("p2", impact.connections.refreshed[0].id);
    assert_eq!(1, impact.connections.unchanged);
}

/// `mcp_write` is the consumer's own trust decision, and `merge_into` preserves
/// it across a refresh — so changing it in the document changes nothing for
/// anybody, and the preview must not claim otherwise. Reading the split off the
/// simulated pool is what makes this fall out for free.
#[test]
fn a_locally_owned_field_is_not_a_change() {
    let before = draft_with(vec![kept("p1", Some("db-1"), None)]);
    let base = file_of(&before);

    let mut after = before.clone();
    after.connections[0].profile.mcp_write = McpWritePolicy::Full;

    let impact = publish_impact(&after, &base);
    assert!(
        impact.connections.refreshed.is_empty(),
        "got {:?}",
        impact.connections.refreshed
    );
    assert_eq!(1, impact.connections.unchanged);
}

/// A rotated password with untouched metadata is still a change: the consumer
/// re-derives that slot's key, and the whole point of the cost report is to name
/// the rows that make them pay.
#[test]
fn a_rotated_secret_is_a_change_even_with_identical_metadata() {
    let before = draft_with(vec![kept("p1", Some("db-1"), Some("ssh-1"))]);
    let base = file_of(&before);

    let mut after = before.clone();
    after.connections[0].secret = SecretSlot::Keep {
        envelope: envelope(Some("db-2"), Some("ssh-1")),
    };

    let impact = publish_impact(&after, &base);
    assert_eq!(1, impact.connections.refreshed.len());
    assert_eq!(0, impact.connections.unchanged);
    // Both slots, even though only the DB half rotated: the envelope is
    // fingerprinted as a pair and landed whole, so the SSH secret's key gets
    // re-derived too. That is the cost the report has to be honest about.
    assert_eq!(1, impact.reencryption.connections.len());
    assert_eq!(2, impact.reencryption.slots);
    assert_eq!(
        2 * u64::from(transfer::PBKDF2_ITERATIONS),
        impact.reencryption.pbkdf2_rounds
    );
}

/// A slot resolved from the keychain at save time always produces a fresh salt
/// and nonce, so it always costs — and the count is flagged as an estimate,
/// because the keychain may hold neither secret.
#[test]
fn a_keychain_slot_is_charged_as_an_estimate() {
    let base = file_of(&OriginDraft::default());
    let draft = draft_with(vec![
        DraftConnection {
            profile: ConnectionProfile {
                ssh_tunnel: Some(tunnel()),
                ..testkit::profile("p1")
            },
            secret: SecretSlot::FromKeychain,
        },
        DraftConnection {
            profile: ConnectionProfile {
                driver: Driver::Sqlite,
                ..testkit::profile("p2")
            },
            secret: SecretSlot::FromKeychain,
        },
    ]);
    let impact = publish_impact(&draft, &base);
    // p1: DB password + SSH secret. p2: a SQLite file behind no tunnel needs
    // neither, so it is not even listed.
    assert_eq!(2, impact.reencryption.slots);
    assert_eq!(1, impact.reencryption.connections.len());
    assert_eq!("p1", impact.reencryption.connections[0].id);
    assert!(impact.reencryption.estimated);
}

/// The silent-threshold warning, and manual test 2 of the plan. Dropping more
/// than half the roster is exactly the case a consumer is **never told about**:
/// `merge_into` decides the read is untrustworthy and clears `vanished`, so the
/// publisher's only chance to find out is here.
#[test]
fn crossing_the_suspicion_threshold_is_flagged_as_silent() {
    let before = draft_with((1..=6).map(|i| unpublished(&format!("p{i}"))).collect());
    let base = file_of(&before);

    let mut after = before.clone();
    after.connections.truncate(2);

    let impact = publish_impact(&after, &base);
    assert_eq!(4, impact.connections.vanished.len());
    assert_eq!(6, impact.connections.owned);
    assert!(
        impact.connections.silently_dropped,
        "4 of 6 crosses the ratio, so no consumer hears about it"
    );

    // One fewer removal stays under the ratio, and is reported normally.
    let mut mild = before.clone();
    mild.connections.truncate(4);
    let impact = publish_impact(&mild, &base);
    assert_eq!(2, impact.connections.vanished.len());
    assert!(!impact.connections.silently_dropped);
}

/// The same threshold applies to environments, matched by
/// `source_environment_id` — the identity the sync uses, never the name or the
/// position in the file.
#[test]
fn environments_are_matched_by_source_id_not_by_name() {
    let before = OriginDraft {
        environments: vec![
            environment("src-1", "Prod", &[]),
            environment("src-2", "Dev", &[]),
        ],
        ..OriginDraft::default()
    };
    let base = file_of(&before);

    // Rename both and swap their order: nothing vanished, both refreshed.
    let after = OriginDraft {
        environments: vec![
            environment("src-2", "Desarrollo", &[]),
            environment("src-1", "Producción", &[]),
        ],
        ..OriginDraft::default()
    };
    let impact = publish_impact(&after, &base);
    assert!(impact.environments.vanished.is_empty());
    assert!(impact.environments.added.is_empty());
    assert_eq!(2, impact.environments.refreshed.len());

    // Mint a new source id for the same environment — the mistake invariant 4
    // exists to prevent — and it reads as one disappearance plus one arrival,
    // which is precisely what every consumer would experience.
    let after = OriginDraft {
        environments: vec![
            environment("brand-new", "Prod", &[]),
            environment("src-2", "Dev", &[]),
        ],
        ..OriginDraft::default()
    };
    let impact = publish_impact(&after, &base);
    assert_eq!(1, impact.environments.added.len());
    assert_eq!("brand-new", impact.environments.added[0].id);
    assert_eq!(1, impact.environments.vanished.len());
    assert_eq!("src-1", impact.environments.vanished[0].id);
    assert_eq!(
        "Prod", impact.environments.vanished[0].name,
        "named from the base"
    );
}

/// A vanished entry's name comes from the base file, since the draft no longer
/// has it — without that, the warning cannot say *which* connections go.
#[test]
fn a_vanished_connection_is_named_from_the_base() {
    let before = draft_with(vec![DraftConnection {
        profile: ConnectionProfile {
            name: "Tencer producción".into(),
            ..testkit::profile("p1")
        },
        secret: SecretSlot::Clear,
    }]);
    let base = file_of(&before);
    let impact = publish_impact(&OriginDraft::default(), &base);
    assert_eq!(1, impact.connections.vanished.len());
    assert_eq!("Tencer producción", impact.connections.vanished[0].name);
}

/// A connection published without a secret is reported, so "the consumer will
/// be asked for a password" is a decision rather than a surprise. A SQLite file
/// behind no tunnel is excluded: it needs no credential, so its empty slot is
/// not a gap.
#[test]
fn connections_published_without_a_password_are_listed() {
    let base = file_of(&OriginDraft::default());
    let draft = draft_with(vec![
        unpublished("p1"),
        DraftConnection {
            profile: ConnectionProfile {
                driver: Driver::Sqlite,
                ..testkit::profile("sqlite")
            },
            secret: SecretSlot::Clear,
        },
        DraftConnection {
            profile: ConnectionProfile {
                driver: Driver::Sqlite,
                ssh_tunnel: Some(tunnel()),
                ..testkit::profile("sqlite-tunnelled")
            },
            secret: SecretSlot::Clear,
        },
    ]);
    let impact = publish_impact(&draft, &base);
    let ids: Vec<&str> = impact
        .without_password
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(vec!["p1", "sqlite-tunnelled"], ids);
}

/// A binding pinned to a connection the document does not carry lands
/// **disabled** on every consumer, so it has to be counted separately from the
/// pinned ones that resolve fine.
#[test]
fn bindings_pinned_to_an_absent_connection_are_counted() {
    let base = file_of(&OriginDraft::default());
    let draft = OriginDraft {
        connections: vec![unpublished("p1")],
        bindings: vec![
            JsonSchemaBinding {
                id: "b1".into(),
                connection_id: Some("p1".into()),
                ..JsonSchemaBinding::default()
            },
            JsonSchemaBinding {
                id: "b2".into(),
                connection_id: Some("absent".into()),
                ..JsonSchemaBinding::default()
            },
            JsonSchemaBinding {
                id: "b3".into(),
                connection_id: None,
                ..JsonSchemaBinding::default()
            },
        ],
        ..OriginDraft::default()
    };
    let impact = publish_impact(&draft, &base);
    assert_eq!(2, impact.bindings_pinned);
    assert_eq!(1, impact.bindings_unresolvable);
}

/// What a new hire pays on their first pull: every published slot, once.
#[test]
fn a_fresh_machine_pays_for_every_slot() {
    let draft = OriginDraft {
        environments: vec![environment("src-1", "Prod", &["p1"])],
        connections: vec![
            kept("p1", Some("db-1"), Some("ssh-1")),
            kept("p2", Some("db-2"), None),
            unpublished("p3"),
        ],
        ..OriginDraft::default()
    };
    let fresh = publish_impact(&draft, &file_of(&OriginDraft::default())).fresh_machine;
    assert_eq!(3, fresh.connections);
    assert_eq!(1, fresh.environments);
    assert_eq!(3, fresh.slots);
    assert_eq!(
        3 * u64::from(transfer::PBKDF2_ITERATIONS),
        fresh.pbkdf2_rounds
    );
}

// ---------------------------------------------------------------------------
// Republishing one corrected connection
// ---------------------------------------------------------------------------

#[test]
fn a_correction_replaces_only_its_own_row() {
    let mut draft = draft_with(vec![
        kept("a", Some("cipher-a"), None),
        kept("b", Some("cipher-b"), None),
    ]);
    let corrected = ConnectionProfile {
        host: "moved.example.net".into(),
        ..testkit::profile("b")
    };

    assert!(replace_connection(&mut draft, corrected, false));

    assert_eq!(
        draft.connections[0].profile.host,
        testkit::profile("a").host
    );
    assert_eq!(draft.connections[1].profile.host, "moved.example.net");
    // Order is identity here as much as anywhere: a consumer's `merge_into`
    // matches by id, but a document whose rows shuffle on every correction
    // diffs as if everything changed.
    assert_eq!(draft.connections[1].profile.id, "b");
}

#[test]
fn correcting_metadata_re_encrypts_nothing() {
    // The same property `renaming_an_environment_re_encrypts_nothing` pins one
    // level up, and for the same reason: a fresh envelope for an unchanged
    // password costs every consumer ~600 000 PBKDF2 rounds and buys nothing.
    let mut draft = draft_with(vec![kept("a", Some("cipher-a"), Some("ssh-a"))]);
    let corrected = ConnectionProfile {
        port: 15432,
        ..testkit::profile("a")
    };

    assert!(replace_connection(&mut draft, corrected, false));

    match &draft.connections[0].secret {
        SecretSlot::Keep { envelope } => {
            assert_eq!(envelope.db_password.as_deref(), Some("cipher-a"));
            assert_eq!(envelope.ssh_secret.as_deref(), Some("ssh-a"));
        }
        other => panic!("an untouched password must travel byte for byte, got {other:?}"),
    }
}

#[test]
fn a_changed_password_asks_the_keychain_for_the_new_one() {
    let mut draft = draft_with(vec![kept("a", Some("cipher-a"), None)]);

    assert!(replace_connection(&mut draft, testkit::profile("a"), true));

    // The command layer resolves this into a `Keep` before the file is built;
    // what matters here is that the correction *asked* for it, since nothing
    // else in the draft records that the password moved.
    assert!(matches!(
        draft.connections[0].secret,
        SecretSlot::FromKeychain
    ));
}

#[test]
fn a_connection_the_document_dropped_is_reported_not_re_added() {
    let mut draft = draft_with(vec![kept("a", Some("cipher-a"), None)]);

    assert!(!replace_connection(
        &mut draft,
        testkit::profile("gone"),
        true
    ));

    assert_eq!(
        draft.connections.len(),
        1,
        "a correction is not a way to add a row somebody removed"
    );
}
