//! The policy document an administrator writes, and the checks that make a
//! malformed one fail loudly instead of being half-applied.
//!
//! Every struct denies unknown fields. A typo in a hand-edited security file —
//! `"relatons"`, `"denny"` — must not be read as "no restriction here": it
//! makes the whole document [`super::PolicyState::Broken`], which blocks, and
//! the diagnostics name the field.

use crate::db::sql::Verbs;
use crate::state::Driver;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The only document version this build understands. A newer one is refused
/// rather than read as far as it happens to parse: its new fields could be the
/// restrictions.
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyDoc {
    pub version: u32,
    /// The role of anyone the `users` map does not name. It should be the most
    /// restrictive one, since that is who an unexpected account gets.
    pub default_role: String,
    /// OS account name → role, exactly one role per user (D5). Keys are
    /// matched case-insensitively, with or without a `DOMAIN\` prefix.
    #[serde(default)]
    pub users: BTreeMap<String, String>,
    pub roles: BTreeMap<String, Role>,
    /// What happens on a connection no rule of the user's role matches.
    #[serde(default)]
    pub unmanaged_connections: Unmanaged,
}

/// `deny` by default: a connection the policy does not name is out of reach,
/// which is also what stops a user side-stepping a rule by reaching the same
/// server under another name (an IP instead of a hostname).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unmanaged {
    #[default]
    Deny,
    Allow,
}

impl Unmanaged {
    pub fn label(self) -> &'static str {
        match self {
            Unmanaged::Deny => "deny",
            Unmanaged::Allow => "allow",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Role {
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Whether people in this role may have HuginnDB download a tool for them
    /// (today: the `mongosh` the Terminal can fetch, ADR #109). **Off unless a
    /// role says so**: a managed machine does not fetch and run an executable
    /// from the internet because nobody thought to forbid it. Without a policy
    /// the download is on, as everything else is.
    #[serde(default)]
    pub allow_tool_downloads: bool,
    /// What the role asks of the app lock (ADR #118, #120). Absent: the person
    /// decides, as on an unmanaged machine.
    #[serde(default)]
    pub app_lock: Option<AppLockRule>,
}

/// A role's demands on the app lock. Every field only ever tightens what the
/// person could choose; none of them can turn the lock off for someone who
/// turned it on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppLockRule {
    /// The lock must be on: an app without a vault opens on a wall that asks
    /// for a master password before anything else, and turning it off is
    /// refused.
    #[serde(default)]
    pub required: bool,
    /// The longest the app may sit idle before it locks, in minutes. "Never"
    /// stops being a choice.
    #[serde(default)]
    pub max_idle_minutes: Option<u32>,
    /// Whether the app locks with the operating system's session, decided
    /// for the person rather than by them.
    #[serde(default)]
    pub lock_with_session: Option<bool>,
    /// Whether Windows Hello may unlock it. Accepted now so a policy written
    /// today keeps parsing when Hello ships; it has no effect until then.
    #[serde(default)]
    pub allow_windows_hello: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub endpoint: EndpointPattern,
    /// Database globs; absent means every database on the endpoint.
    #[serde(default)]
    pub databases: Option<Vec<String>>,
    #[serde(default)]
    pub relations: Relations,
    /// What a person may do. Not enforced for people until phase 2; it bounds
    /// `ai` already, since the AI never gets more than its user (D1).
    #[serde(default)]
    pub human: Vec<Permission>,
    #[serde(default)]
    pub ai: Vec<Permission>,
    /// The database user a person signs in to this endpoint as — a template
    /// whose one token, `{user}`, is their OS account without the domain and
    /// in lower case (`"{user}"`, `"{user}_ro"`, `"erp_{user}"`). Pinned: it
    /// wins over the person's own choice, because giving each person their own
    /// database user is how the database, and not only HuginnDB, comes to
    /// enforce the policy (§7). Absent: the connection's own user.
    #[serde(default)]
    pub db_user: Option<String>,
    /// Which columns `insert` may give a value to and `update` may change, on
    /// every relation the rule reaches (ADR #113). Absent means every column;
    /// it narrows the verbs the rule grants and never adds one.
    #[serde(default)]
    pub columns: Columns,
}

/// Column limits per verb. A list holds globs matched against a column's name
/// — on MongoDB, against a field's top-level name, since `a.b` is part of `a`.
/// `None` means every column, which is not the same as an empty list: an
/// empty list grants the verb on no column at all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Columns {
    #[serde(default)]
    pub insert: Option<Vec<String>>,
    #[serde(default)]
    pub update: Option<Vec<String>>,
}

impl Columns {
    /// The limit on one verb, if the rule sets one. Only `INSERT` and
    /// `UPDATE` can be limited; any other verb has none.
    pub fn limit(&self, verb: Verbs) -> Option<&[String]> {
        if verb == Verbs::INSERT {
            self.insert.as_deref()
        } else if verb == Verbs::UPDATE {
            self.update.as_deref()
        } else {
            None
        }
    }
}

/// What a subject may write, per verb, once every rule that applies is
/// folded together — what the interface reads to lock a column (ADR #96).
/// `None` means every column; an empty list, none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnScope {
    pub insert: Option<Vec<String>>,
    pub update: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relations {
    /// Globs of relations that may be reached; absent means all of them. A
    /// pattern with a `.` is matched against `schema.name`, one without it
    /// against the name alone.
    #[serde(default)]
    pub allow: Option<Vec<String>>,
    /// Globs that are never reachable, whatever `allow` says.
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Which server a rule is about: `"*"` for every endpoint, or an object naming
/// one. Matched against the profile's endpoint, never its id — an id is local
/// and free to mint, so a user re-creating a connection by hand would get one
/// the policy has never heard of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointPattern {
    Any,
    Server {
        driver: Option<Driver>,
        host: String,
        /// Absent means any port on that host.
        port: Option<u16>,
    },
    /// A SQLite file, which has no server to name.
    File {
        path: String,
    },
}

impl<'de> Deserialize<'de> for EndpointPattern {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Star(String),
            Object(WireObject),
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireObject {
            #[serde(default)]
            driver: Option<Driver>,
            #[serde(default)]
            host: Option<String>,
            #[serde(default)]
            port: Option<u16>,
            #[serde(default)]
            path: Option<String>,
        }
        use serde::de::Error;
        match Wire::deserialize(de)? {
            Wire::Star(s) if s == "*" => Ok(EndpointPattern::Any),
            Wire::Star(s) => Err(D::Error::custom(format!(
                "endpoint {s:?} is not valid: use \"*\" for every server, or an object with a host \
                 or a path"
            ))),
            Wire::Object(o) => match (o.host, o.path) {
                (Some(host), None) if !host.trim().is_empty() => Ok(EndpointPattern::Server {
                    driver: o.driver,
                    host,
                    port: o.port,
                }),
                (None, Some(path)) if !path.trim().is_empty() => {
                    if o.port.is_some() || o.driver.is_some_and(|d| d != Driver::Sqlite) {
                        return Err(D::Error::custom(
                            "an endpoint with a path is a SQLite file: it takes no port and no \
                             other driver",
                        ));
                    }
                    Ok(EndpointPattern::File { path })
                }
                _ => Err(D::Error::custom(
                    "an endpoint object needs exactly one of a non-empty host or path",
                )),
            },
        }
    }
}

/// What a rule grants. The first five are the statement verbs; `export` and
/// `monitor` are surfaces rather than statements — exporting is how data
/// leaves, and Pulse / sessions / users show *other people's* statements,
/// which can carry data this role cannot read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Select,
    Insert,
    Update,
    Delete,
    Ddl,
    Export,
    Monitor,
}

/// Who a decision is about: the person using the app, or the AI acting for
/// them. A rule is read through the matching block — `human`, or `ai ∩ human`
/// (D1) — so the same document answers both, and the AI can never be granted
/// more than its user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    Human,
    Ai,
}

/// A permission list folded into what enforcement asks about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Grant {
    pub verbs: Verbs,
    pub export: bool,
    pub monitor: bool,
}

impl Grant {
    pub fn of(permissions: &[Permission]) -> Self {
        permissions.iter().fold(Grant::default(), |g, p| match p {
            Permission::Select => g.with(Verbs::SELECT),
            Permission::Insert => g.with(Verbs::INSERT),
            Permission::Update => g.with(Verbs::UPDATE),
            Permission::Delete => g.with(Verbs::DELETE),
            Permission::Ddl => g.with(Verbs::DDL),
            Permission::Export => Grant { export: true, ..g },
            Permission::Monitor => Grant { monitor: true, ..g },
        })
    }

    fn with(self, verbs: Verbs) -> Self {
        Grant {
            verbs: self.verbs | verbs,
            ..self
        }
    }

    /// What either grant allows.
    pub fn union(self, other: Grant) -> Grant {
        Grant {
            verbs: self.verbs | other.verbs,
            export: self.export || other.export,
            monitor: self.monitor || other.monitor,
        }
    }

    /// What both grants allow.
    pub fn intersect(self, other: Grant) -> Grant {
        Grant {
            verbs: self.verbs.intersection(other.verbs),
            export: self.export && other.export,
            monitor: self.monitor && other.monitor,
        }
    }

    pub fn is_empty(self) -> bool {
        self.verbs == Verbs::NONE && !self.export && !self.monitor
    }

    /// The names, in the order the document spells them — for diagnostics.
    pub fn names(self) -> Vec<&'static str> {
        let mut out = verb_names(self.verbs);
        if self.export {
            out.push("export");
        }
        if self.monitor {
            out.push("monitor");
        }
        out
    }
}

/// The statement verbs in `verbs`, by the names a policy document uses.
pub fn verb_names(verbs: Verbs) -> Vec<&'static str> {
    [
        (Verbs::SELECT, "select"),
        (Verbs::INSERT, "insert"),
        (Verbs::UPDATE, "update"),
        (Verbs::DELETE, "delete"),
        (Verbs::DDL, "ddl"),
    ]
    .into_iter()
    .filter(|(v, _)| verbs.contains(*v))
    .map(|(_, n)| n)
    .collect()
}

impl Rule {
    /// What the AI may do under this rule: what the rule gives it, and never
    /// more than it gives the person (D1).
    pub fn ai_grant(&self) -> Grant {
        Grant::of(&self.ai).intersect(Grant::of(&self.human))
    }

    pub fn human_grant(&self) -> Grant {
        Grant::of(&self.human)
    }

    /// The grant a subject reads this rule through.
    pub fn grant_for(&self, subject: Subject) -> Grant {
        match subject {
            Subject::Human => self.human_grant(),
            Subject::Ai => self.ai_grant(),
        }
    }

    /// Whether the rule is narrower than its whole endpoint — which is what
    /// takes free SQL away (D3), since no text classifier can say which
    /// relations a statement touches.
    pub fn is_scoped(&self) -> bool {
        self.databases.is_some()
            || self.relations.allow.is_some()
            || !self.relations.deny.is_empty()
    }

    /// Whether the rule limits which columns one of `verbs` may write. Free
    /// SQL needing such a verb is withheld under it, for the same reason as
    /// under a scoped rule: a statement's text does not reliably say which
    /// columns it writes (triggers, views, dynamic SQL).
    pub fn limits_columns_of(&self, verbs: Verbs) -> bool {
        [Verbs::INSERT, Verbs::UPDATE]
            .into_iter()
            .any(|v| verbs.contains(v) && self.columns.limit(v).is_some())
    }
}

/// The only token a `dbUser` template may carry.
pub const DB_USER_TOKEN: &str = "{user}";

/// A `dbUser` template with `{user}` replaced by `user`, folded the way the
/// document's user keys are. `None` when that leaves nothing, which is only
/// possible for an OS that will not name its user.
pub fn expand_db_user(template: &str, user: &str) -> Option<String> {
    let user = normalise_user(user);
    if template.contains(DB_USER_TOKEN) && user.is_empty() {
        return None;
    }
    let expanded = template.trim().replace(DB_USER_TOKEN, &user);
    (!expanded.is_empty()).then_some(expanded)
}

/// Why a `dbUser` template cannot be used, if it cannot.
fn db_user_problem(template: &str) -> Option<&'static str> {
    let t = template.trim();
    if t.is_empty() {
        return Some("is empty");
    }
    // Every brace must belong to a `{user}`: a typo such as `{usr}` would
    // otherwise sign everybody in as the literal text `{usr}`.
    let rest = t.replace(DB_USER_TOKEN, "");
    if rest.contains('{') || rest.contains('}') {
        return Some("may only use the token {user}");
    }
    None
}

/// A user key as the document spells it, folded to how it is compared.
pub fn normalise_user(name: &str) -> String {
    let name = name.trim();
    let bare = name.rsplit_once('\\').map_or(name, |(_, user)| user);
    bare.to_lowercase()
}

impl PolicyDoc {
    /// Parse and validate. Everything returned as an error makes the policy
    /// `Broken`, so each message has to tell the administrator what to fix.
    ///
    /// Returns the warnings too: things that are allowed but probably not
    /// meant, such as an `ai` list granting what `human` does not (it is
    /// intersected, never widened).
    pub fn parse(text: &str) -> Result<(PolicyDoc, Vec<String>), String> {
        let doc: PolicyDoc =
            serde_json::from_str(text).map_err(|e| format!("the policy is not valid: {e}"))?;
        if doc.version != VERSION {
            return Err(format!(
                "the policy is version {}, and this HuginnDB understands version {VERSION}. \
                 Update HuginnDB, or write the policy for version {VERSION}.",
                doc.version
            ));
        }
        if !doc.roles.contains_key(&doc.default_role) {
            return Err(format!(
                "defaultRole {:?} is not one of the roles the policy defines",
                doc.default_role
            ));
        }
        let mut seen: BTreeMap<String, &str> = BTreeMap::new();
        for (user, role) in &doc.users {
            if !doc.roles.contains_key(role) {
                return Err(format!(
                    "user {user:?} is assigned role {role:?}, which the policy does not define"
                ));
            }
            let key = normalise_user(user);
            if key.is_empty() {
                return Err("a user name in the policy is empty".into());
            }
            if let Some(other) = seen.insert(key, user) {
                return Err(format!(
                    "users {other:?} and {user:?} are the same account once the domain and the \
                     case are ignored; a user has exactly one role"
                ));
            }
        }
        let mut warnings = Vec::new();
        for (name, role) in &doc.roles {
            if let Some(lock) = &role.app_lock {
                if lock.max_idle_minutes == Some(0) {
                    return Err(format!(
                        "role {name:?}: appLock.maxIdleMinutes is 0; leave it out to let                          people choose, or give the longest idle time in minutes"
                    ));
                }
                if lock.max_idle_minutes.is_some() && !lock.required {
                    warnings.push(format!(
                        "role {name:?}: appLock.maxIdleMinutes applies only while the lock is                          on, and appLock.required is false, so people may still leave it off"
                    ));
                }
            }
        }
        for (name, role) in &doc.roles {
            for (i, rule) in role.rules.iter().enumerate() {
                let globs = rule
                    .databases
                    .iter()
                    .flatten()
                    .chain(rule.relations.allow.iter().flatten())
                    .chain(rule.relations.deny.iter());
                if globs.clone().any(|g| g.trim().is_empty()) {
                    return Err(format!(
                        "role {name:?}, rule {}: a database or relation pattern is empty",
                        i + 1
                    ));
                }
                for (verb, key, list) in [
                    (Verbs::INSERT, "insert", rule.columns.insert.as_ref()),
                    (Verbs::UPDATE, "update", rule.columns.update.as_ref()),
                ] {
                    let Some(list) = list else { continue };
                    if list.iter().any(|g| g.trim().is_empty()) {
                        return Err(format!(
                            "role {name:?}, rule {}: a pattern in columns.{key} is empty",
                            i + 1
                        ));
                    }
                    if !rule.human_grant().verbs.contains(verb) {
                        warnings.push(format!(
                            "role {name:?}, rule {}: columns.{key} limits a permission the rule \
                             does not grant, so it changes nothing",
                            i + 1
                        ));
                    } else if list.is_empty() {
                        warnings.push(format!(
                            "role {name:?}, rule {}: columns.{key} is empty, so `{key}` reaches \
                             no column at all",
                            i + 1
                        ));
                    }
                }
                if let Some(problem) = rule.db_user.as_deref().and_then(db_user_problem) {
                    return Err(format!("role {name:?}, rule {}: dbUser {problem}", i + 1));
                }
                let ai = Grant::of(&rule.ai);
                if ai.intersect(rule.human_grant()) != ai {
                    warnings.push(format!(
                        "role {name:?}, rule {}: `ai` grants something `human` does not; the AI \
                         never gets more than the person, so the extra is ignored",
                        i + 1
                    ));
                }
            }
        }
        Ok((doc, warnings))
    }

    /// The role for an OS account, and its name.
    pub fn role_for(&self, user: &str) -> (&str, &Role) {
        let wanted = normalise_user(user);
        let name = self
            .users
            .iter()
            .find(|(u, _)| normalise_user(u) == wanted)
            .map_or(self.default_role.as_str(), |(_, role)| role.as_str());
        // `parse` checked every role a user or the default points at exists.
        let role = &self.roles[name];
        (name, role)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "version": 1,
        "defaultRole": "none",
        "roles": { "none": {} }
    }"#;

    #[test]
    fn a_minimal_policy_parses_and_denies_the_unmanaged_by_default() {
        let (doc, warnings) = PolicyDoc::parse(MINIMAL).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(doc.unmanaged_connections, Unmanaged::Deny);
        assert_eq!(doc.role_for("anyone").0, "none");
    }

    #[test]
    fn a_typo_is_an_error_not_a_missing_restriction() {
        let text = r#"{
            "version": 1, "defaultRole": "r",
            "roles": { "r": { "rules": [{
                "endpoint": "*",
                "relatons": { "deny": ["cards"] }
            }] } }
        }"#;
        let err = PolicyDoc::parse(text).unwrap_err();
        assert!(err.contains("relatons"), "{err}");
    }

    #[test]
    fn roles_and_versions_are_checked() {
        let unknown_default = r#"{"version":1,"defaultRole":"x","roles":{"r":{}}}"#;
        assert!(PolicyDoc::parse(unknown_default)
            .unwrap_err()
            .contains("defaultRole"));

        let unknown_user_role =
            r#"{"version":1,"defaultRole":"r","users":{"ana":"ghost"},"roles":{"r":{}}}"#;
        assert!(PolicyDoc::parse(unknown_user_role)
            .unwrap_err()
            .contains("ghost"));

        let newer = r#"{"version":2,"defaultRole":"r","roles":{"r":{}}}"#;
        assert!(PolicyDoc::parse(newer).unwrap_err().contains("version 2"));
    }

    #[test]
    fn one_account_cannot_hold_two_roles() {
        let text = r#"{"version":1,"defaultRole":"a",
            "users":{"CORP\\Ana":"a","ana":"b"},
            "roles":{"a":{},"b":{}}}"#;
        assert!(PolicyDoc::parse(text)
            .unwrap_err()
            .contains("exactly one role"));
    }

    #[test]
    fn users_match_without_domain_or_case() {
        let text = r#"{"version":1,"defaultRole":"none",
            "users":{"CORP\\SCara":"admin"},
            "roles":{"none":{},"admin":{}}}"#;
        let (doc, _) = PolicyDoc::parse(text).unwrap();
        assert_eq!(doc.role_for("scara").0, "admin");
        assert_eq!(doc.role_for("OTHER\\scara").0, "admin");
        assert_eq!(doc.role_for("someone").0, "none");
    }

    #[test]
    fn endpoints_accept_the_star_a_server_or_a_file() {
        let rule = |endpoint: &str| {
            format!(
                r#"{{"version":1,"defaultRole":"r","roles":{{"r":{{"rules":[{{"endpoint":{endpoint}}}]}}}}}}"#
            )
        };
        let parse = |e: &str| {
            PolicyDoc::parse(&rule(e)).map(|(d, _)| d.roles["r"].rules[0].endpoint.clone())
        };
        assert_eq!(parse(r#""*""#).unwrap(), EndpointPattern::Any);
        assert_eq!(
            parse(r#"{"driver":"mysql","host":"erp.local","port":3306}"#).unwrap(),
            EndpointPattern::Server {
                driver: Some(Driver::Mysql),
                host: "erp.local".into(),
                port: Some(3306)
            }
        );
        assert_eq!(
            parse(r#"{"path":"C:/data/app.db"}"#).unwrap(),
            EndpointPattern::File {
                path: "C:/data/app.db".into()
            }
        );
        assert!(parse(r#""everything""#).is_err());
        assert!(parse(r#"{"host":"a","path":"b"}"#).is_err());
        assert!(parse(r#"{"path":"a.db","port":1}"#).is_err());
        assert!(parse(r#"{"port":1}"#).is_err());
    }

    #[test]
    fn the_ai_never_gets_more_than_the_person() {
        let text = r#"{"version":1,"defaultRole":"r","roles":{"r":{"rules":[{
            "endpoint":"*","human":["select"],"ai":["select","delete","monitor"]}]}}}"#;
        let (doc, warnings) = PolicyDoc::parse(text).unwrap();
        assert_eq!(warnings.len(), 1);
        let grant = doc.roles["r"].rules[0].ai_grant();
        assert_eq!(grant.verbs, Verbs::SELECT);
        assert!(!grant.monitor);
    }

    #[test]
    fn a_rule_is_scoped_when_it_names_less_than_its_endpoint() {
        let rule = |extra: &str| {
            let text = format!(
                r#"{{"version":1,"defaultRole":"r","roles":{{"r":{{"rules":[{{"endpoint":"*"{extra}}}]}}}}}}"#
            );
            PolicyDoc::parse(&text).unwrap().0.roles["r"].rules[0].clone()
        };
        assert!(!rule("").is_scoped());
        assert!(rule(r#","databases":["billing"]"#).is_scoped());
        assert!(rule(r#","relations":{"allow":["t"]}"#).is_scoped());
        assert!(rule(r#","relations":{"deny":["t"]}"#).is_scoped());
        // Column limits narrow what may be written, not what may be seen.
        assert!(!rule(r#","human":["update"],"columns":{"update":["estado"]}"#).is_scoped());
    }

    fn with_columns(human: &str, columns: &str) -> Result<(PolicyDoc, Vec<String>), String> {
        PolicyDoc::parse(&format!(
            r#"{{"version":1,"defaultRole":"r","roles":{{"r":{{"rules":[
                {{"endpoint":"*","human":{human},"columns":{columns}}}]}}}}}}"#
        ))
    }

    #[test]
    fn columns_are_read_per_verb_and_absent_means_every_column() {
        let (doc, warnings) = with_columns(
            r#"["select","insert","update"]"#,
            r#"{"insert":["Cliente","Importe"],"update":["Estado"]}"#,
        )
        .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let rule = &doc.roles["r"].rules[0];
        assert_eq!(
            rule.columns.limit(Verbs::INSERT),
            Some(&["Cliente".to_string(), "Importe".to_string()][..])
        );
        assert_eq!(
            rule.columns.limit(Verbs::UPDATE),
            Some(&["Estado".to_string()][..])
        );
        assert_eq!(rule.columns.limit(Verbs::DELETE), None);
        assert!(rule.limits_columns_of(Verbs::UPDATE));
        assert!(!rule.limits_columns_of(Verbs::SELECT | Verbs::DELETE));

        // A rule written before columns existed limits nothing.
        let (doc, _) = PolicyDoc::parse(
            r#"{"version":1,"defaultRole":"r","roles":{"r":{"rules":[{"endpoint":"*"}]}}}"#,
        )
        .unwrap();
        assert_eq!(doc.roles["r"].rules[0].columns, Columns::default());
    }

    #[test]
    fn a_columns_typo_or_an_empty_pattern_breaks_the_policy() {
        assert!(with_columns(r#"["update"]"#, r#"{"updates":["a"]}"#)
            .unwrap_err()
            .contains("updates"));
        assert!(with_columns(r#"["update"]"#, r#"{"update":[" "]}"#)
            .unwrap_err()
            .contains("columns.update is empty"));
    }

    #[test]
    fn columns_that_change_nothing_are_warned_about() {
        // A limit on a verb the rule does not grant.
        let (_, warnings) = with_columns(r#"["select"]"#, r#"{"update":["a"]}"#).unwrap();
        assert!(warnings[0].contains("does not grant"), "{warnings:?}");
        // An empty list: the verb reaches no column.
        let (_, warnings) = with_columns(r#"["insert"]"#, r#"{"insert":[]}"#).unwrap();
        assert!(warnings[0].contains("reaches no column"), "{warnings:?}");
    }

    #[test]
    fn a_db_user_template_may_only_name_the_user() {
        let with = |template: &str| {
            format!(
                r#"{{ "version": 1, "defaultRole": "r", "roles": {{ "r": {{ "rules": [
                    {{ "endpoint": "*", "dbUser": {template:?} }}
                ] }} }} }}"#
            )
        };
        for good in ["{user}", "{user}_ro", "erp_{user}", "shared_reader"] {
            assert!(PolicyDoc::parse(&with(good)).is_ok(), "{good}");
        }
        for (bad, why) in [("", "is empty"), ("{usr}", "{user}"), ("{user", "{user}")] {
            let err = PolicyDoc::parse(&with(bad)).unwrap_err();
            assert!(err.contains("dbUser") && err.contains(why), "{bad}: {err}");
        }
    }

    #[test]
    fn a_db_user_expands_to_the_bare_lower_case_account() {
        assert_eq!(
            expand_db_user("{user}", r"ACME\ALopez"),
            Some("alopez".into())
        );
        assert_eq!(
            expand_db_user("erp_{user}", "alopez"),
            Some("erp_alopez".into())
        );
        assert_eq!(expand_db_user("reader", ""), Some("reader".into()));
        // An OS that will not name its user gets no personal user at all,
        // rather than signing in as the empty string.
        assert_eq!(expand_db_user("{user}", ""), None);
    }
}
