//! The decisions, with no I/O: given a policy, a user, a connection profile
//! and what a request needs, is it allowed? Everything that reads disks, the
//! registry or the clock lives elsewhere, so this can be tested exhaustively.

use super::model::{
    expand_db_user, ColumnScope, EndpointPattern, Grant, PolicyDoc, Rule, Subject, Unmanaged,
};
use crate::db::sql::Verbs;
use crate::state::{ConnectionProfile, Driver};

/// What one request needs, in the terms a rule speaks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    /// Only that the subject may reach this endpoint at all: opening a
    /// connection, asking the server version, the plumbing requests.
    Endpoint,
    /// That a database is visible (a per-database view, the Mongo target).
    Database(String),
    /// A named relation, for these verbs.
    Relation {
        schema: Option<String>,
        name: String,
        verbs: Verbs,
    },
    /// Free text (SQL or mongosh) needing these verbs. Refused under a scoped
    /// rule whatever the verbs (D3).
    FreeSql(Verbs),
    /// Pulse, sessions, users and privileges.
    Monitor,
    /// Writing a relation's rows out of the app, to a file. Needs `export`
    /// *and* `select` on it: exporting is reading, plus letting it leave.
    Export {
        schema: Option<String>,
        name: String,
    },
    /// Creating or dropping a database (or a MongoDB collection in one): DDL
    /// granted by a rule that covers that database by name.
    DatabaseDdl(String),
    /// The columns one `INSERT` gives a value to, or one `UPDATE` changes, on
    /// a named relation (ADR #113). Judged *in addition to* the matching
    /// [`Need::Relation`], which still decides whether the verb is granted at
    /// all; this only narrows it. On MongoDB a column is a field path and is
    /// judged by its top-level field.
    Columns {
        schema: Option<String>,
        name: String,
        /// `Verbs::INSERT` or `Verbs::UPDATE`, the only verbs a rule limits.
        verb: Verbs,
        columns: Vec<String>,
    },
}

/// Why a request was refused — worded for the person who reads it in the
/// Console, in a locked control, or in the AI's answer, so it names the role
/// and says who can change it (ADR #77).
pub type Refusal = String;

/// The context a need is judged in.
pub struct Ctx<'a> {
    pub doc: &'a PolicyDoc,
    pub user: &'a str,
    pub profile: Option<&'a ConnectionProfile>,
    /// The database the request is addressed to, when there is one to name:
    /// the `::db::` part of a per-database view, else the profile's own.
    pub database: Option<&'a str>,
    /// Who is asking: the person using the app, or the AI acting for them.
    /// Picks the permission block a rule is read through (`human` / `ai`) and
    /// the wording of a refusal.
    pub subject: Subject,
}

/// What the rules say about one endpoint for one user.
enum Coverage<'a> {
    /// No rule names this endpoint and the policy leaves such connections
    /// alone: the request is not the policy's business.
    Unmanaged,
    /// These rules name it (possibly none, when unmanaged is `deny`).
    Rules(Vec<&'a Rule>),
}

impl<'a> Ctx<'a> {
    fn role(&self) -> &'a str {
        self.doc.role_for(self.user).0
    }

    fn grant(&self, rule: &Rule) -> Grant {
        rule.grant_for(self.subject)
    }

    fn coverage(&self) -> Coverage<'a> {
        let (_, role) = self.doc.role_for(self.user);
        let rules: Vec<&Rule> = match self.profile {
            Some(profile) => role
                .rules
                .iter()
                .filter(|r| endpoint_matches(&r.endpoint, profile))
                .collect(),
            None => Vec::new(),
        };
        if rules.is_empty() && self.doc.unmanaged_connections == Unmanaged::Allow {
            Coverage::Unmanaged
        } else {
            Coverage::Rules(rules)
        }
    }

    /// The rules that cover the endpoint *and* the database addressed.
    fn rules_for_database(&self, database: Option<&str>) -> Option<Vec<&'a Rule>> {
        match self.coverage() {
            Coverage::Unmanaged => None,
            Coverage::Rules(rules) => Some(
                rules
                    .into_iter()
                    .filter(|r| database_matches(r, database))
                    .collect(),
            ),
        }
    }

    /// The database a relation lives in. On MySQL and MongoDB a relation's
    /// "schema" *is* its database — `billing.invoices` is table `invoices` in
    /// database `billing` — so a qualified name says which database it is, and
    /// wins over the connection's default. Elsewhere (Postgres, SQL Server) a
    /// schema is inside the connection's database, which is the one that
    /// counts.
    fn database_for(&self, schema: Option<&'a str>) -> Option<&'a str> {
        let schema_is_database = self
            .profile
            .is_some_and(|p| matches!(p.driver, Driver::Mysql | Driver::Mongo));
        match schema.filter(|s| !s.is_empty()) {
            Some(s) if schema_is_database => Some(s),
            _ => self.database,
        }
    }

    /// "the AI" / "you", for the refusal text.
    fn actor(&self) -> &'static str {
        match self.subject {
            Subject::Ai => "the AI",
            Subject::Human => "you",
        }
    }

    /// What to do instead of free SQL, for whoever was refused it.
    fn free_sql_alternative(&self) -> &'static str {
        match self.subject {
            Subject::Ai => {
                "Use the table tools instead (list_tables, describe_table, browse_table)"
            }
            Subject::Human => "Browse the tables from the explorer instead",
        }
    }

    fn refuse(&self, what: impl std::fmt::Display) -> Refusal {
        format!(
            "{what} — refused by your organization's HuginnDB policy (role {:?}). Ask your \
             administrator if you need it.",
            self.role()
        )
    }

    fn connection_label(&self) -> String {
        self.profile.map_or_else(
            || "this connection".to_string(),
            |p| format!("connection {:?}", p.name),
        )
    }

    /// Decide one need. `Ok(())` also when the endpoint is unmanaged and the
    /// policy allows unmanaged connections: then only the local settings
    /// govern, as without a policy.
    pub fn decide(&self, need: &Need) -> Result<(), Refusal> {
        let Some(rules) = self.rules_for_database(match need {
            Need::Database(db) | Need::DatabaseDdl(db) => Some(db.as_str()),
            Need::Relation { schema, .. }
            | Need::Export { schema, .. }
            | Need::Columns { schema, .. } => self.database_for(schema.as_deref()),
            _ => self.database,
        }) else {
            return Ok(());
        };
        let connection = self.connection_label();
        let actor = self.actor();
        let reachable = |rules: &[&Rule]| rules.iter().any(|r| !self.grant(r).is_empty());
        match need {
            Need::Endpoint => {
                // The endpoint check ignores the database: any rule on the
                // server that gives the subject anything makes it reachable.
                let on_endpoint = match self.coverage() {
                    Coverage::Unmanaged => return Ok(()),
                    Coverage::Rules(r) => r,
                };
                if reachable(&on_endpoint) {
                    Ok(())
                } else {
                    Err(self.refuse(format!("{actor} may not use {connection}")))
                }
            }
            Need::Database(db) => {
                if reachable(&rules) {
                    Ok(())
                } else {
                    Err(self.refuse(format!(
                        "database {db:?} on {connection} is not available to {actor}"
                    )))
                }
            }
            Need::Relation {
                schema,
                name,
                verbs,
            } => {
                let visible: Vec<&&Rule> = rules
                    .iter()
                    .filter(|r| relation_allowed(r, schema.as_deref(), name))
                    .collect();
                if visible.iter().any(|r| self.grant(r).verbs.contains(*verbs)) {
                    Ok(())
                } else if visible.iter().any(|r| !self.grant(r).is_empty()) {
                    Err(self.refuse(format!(
                        "{actor} may not {} {:?}",
                        verbs_phrase(*verbs),
                        qualified(schema.as_deref(), name)
                    )))
                } else {
                    Err(self.refuse(format!(
                        "{:?} on {connection} is not available to {actor}",
                        qualified(schema.as_deref(), name)
                    )))
                }
            }
            Need::Columns {
                schema,
                name,
                verb,
                columns,
            } => {
                let granting: Vec<&&Rule> = rules
                    .iter()
                    .filter(|r| {
                        relation_allowed(r, schema.as_deref(), name)
                            && self.grant(r).verbs.contains(*verb)
                    })
                    .collect();
                let what = qualified(schema.as_deref(), name);
                if granting.is_empty() {
                    return Err(
                        self.refuse(format!("{actor} may not {} {what:?}", verbs_phrase(*verb)))
                    );
                }
                let mut refused: Vec<&str> = Vec::new();
                for column in columns {
                    let key = self.column_key(column);
                    if self.column_exempt(*verb, key) {
                        continue;
                    }
                    if !granting.iter().any(|r| column_covered(r, *verb, key))
                        && !refused.contains(&key)
                    {
                        refused.push(key);
                    }
                }
                if refused.is_empty() {
                    return Ok(());
                }
                let allowed = union_limits(granting.iter().map(|r| &***r), *verb)
                    .map(|globs| {
                        if globs.is_empty() {
                            "none".to_string()
                        } else {
                            globs.join(", ")
                        }
                    })
                    .unwrap_or_default();
                Err(self.refuse(format!(
                    "{actor} may not {} column{} {} of {what:?}; the columns {actor} may {} \
                     there are: {allowed}",
                    column_verb(*verb),
                    if refused.len() == 1 { "" } else { "s" },
                    refused.join(", "),
                    column_verb(*verb),
                )))
            }
            Need::Export { schema, name } => {
                let exportable = rules.iter().any(|r| {
                    let g = self.grant(r);
                    relation_allowed(r, schema.as_deref(), name)
                        && g.export
                        && g.verbs.contains(Verbs::SELECT)
                });
                if exportable {
                    Ok(())
                } else {
                    Err(self.refuse(format!(
                        "{actor} may not export {:?} from {connection}",
                        qualified(schema.as_deref(), name)
                    )))
                }
            }
            Need::DatabaseDdl(db) => {
                if rules
                    .iter()
                    .any(|r| self.grant(r).verbs.contains(Verbs::DDL))
                {
                    Ok(())
                } else {
                    Err(self.refuse(format!(
                        "{actor} may not create or drop database {db:?} on {connection}"
                    )))
                }
            }
            Need::FreeSql(verbs) => {
                let unscoped_grant =
                    |r: &Rule| !r.is_scoped() && self.grant(r).verbs.contains(*verbs);
                if rules
                    .iter()
                    .any(|r| unscoped_grant(r) && !r.limits_columns_of(*verbs))
                {
                    Ok(())
                } else if rules.iter().any(|r| unscoped_grant(r)) {
                    // Granted, but only on some columns — and a statement's
                    // text cannot be checked against that (ADR #113).
                    Err(self.refuse(format!(
                        "free-form {} statements are disabled on {connection}, because the \
                         policy limits which columns {actor} may write and a query's text cannot \
                         be checked against that. {}",
                        verbs_phrase(*verbs),
                        self.free_sql_alternative()
                    )))
                } else if rules
                    .iter()
                    .any(|r| r.is_scoped() && !self.grant(r).is_empty())
                {
                    Err(self.refuse(format!(
                        "free-form queries are disabled on {connection}, because the policy \
                         limits which databases or relations {actor} may see and a query's text \
                         cannot be checked against that. {}",
                        self.free_sql_alternative()
                    )))
                } else if reachable(&rules) {
                    Err(self.refuse(format!(
                        "this statement needs {}, which {actor} may not do on {connection}",
                        verbs_phrase(*verbs)
                    )))
                } else {
                    Err(self.refuse(format!("{actor} may not use {connection}")))
                }
            }
            Need::Monitor => {
                // Server-wide, like the endpoint check: what Pulse and the
                // session list show is not per database.
                let on_endpoint = match self.coverage() {
                    Coverage::Unmanaged => return Ok(()),
                    Coverage::Rules(r) => r,
                };
                if on_endpoint.iter().any(|r| self.grant(r).monitor) {
                    Ok(())
                } else {
                    Err(self.refuse(format!(
                        "server monitoring, sessions and users on {connection} are not available \
                         to {actor}"
                    )))
                }
            }
        }
    }

    /// Whether the subject may *see* a relation at all — any verb, so that a
    /// relation it may only insert into is still listed. Used to filter
    /// discovery, so nobody learns the names of what they cannot reach.
    pub fn relation_visible(&self, schema: Option<&str>, name: &str) -> bool {
        self.relation_grant(schema, name)
            .is_none_or(|g| !g.is_empty())
    }

    /// Everything the subject may do on one relation: the union of what every
    /// rule covering it grants. `None` when the connection is unmanaged — the
    /// policy has nothing to say about it.
    pub fn relation_grant(&self, schema: Option<&str>, name: &str) -> Option<Grant> {
        let rules = self.rules_for_database(self.database_for(schema))?;
        Some(
            rules
                .iter()
                .filter(|r| relation_allowed(r, schema, name))
                .fold(Grant::default(), |all, r| all.union(self.grant(r))),
        )
    }

    /// Which columns the subject may write on one relation, per verb: the
    /// union of what every covering rule that grants the verb allows, where a
    /// rule without a limit allows every column. `None` when unmanaged.
    pub fn relation_columns(&self, schema: Option<&str>, name: &str) -> Option<ColumnScope> {
        let rules = self.rules_for_database(self.database_for(schema))?;
        let covering: Vec<&Rule> = rules
            .into_iter()
            .filter(|r| relation_allowed(r, schema, name))
            .collect();
        Some(self.column_scope(&covering))
    }

    /// [`Self::relation_columns`] over the whole addressed database — an upper
    /// bound for a connection, as [`Self::database_grant`] is.
    pub fn database_columns(&self) -> Option<ColumnScope> {
        let rules = self.rules_for_database(self.database)?;
        Some(self.column_scope(&rules))
    }

    fn column_scope(&self, rules: &[&Rule]) -> ColumnScope {
        let per_verb = |verb: Verbs| {
            union_limits(
                rules
                    .iter()
                    .copied()
                    .filter(|r| self.grant(r).verbs.contains(verb)),
                verb,
            )
        };
        ColumnScope {
            insert: per_verb(Verbs::INSERT),
            update: per_verb(Verbs::UPDATE),
        }
    }

    /// The name a column is judged by: on MongoDB a field path is judged by
    /// its top-level field, since writing `a.b` writes part of `a`.
    fn column_key<'c>(&self, column: &'c str) -> &'c str {
        if self.profile.is_some_and(|p| p.driver == Driver::Mongo) {
            top_level_field(column)
        } else {
            column
        }
    }

    /// A MongoDB document's `_id` is its key, as an identity column is a
    /// row's: giving one on insert is never limited.
    fn column_exempt(&self, verb: Verbs, key: &str) -> bool {
        verb == Verbs::INSERT
            && key == "_id"
            && self.profile.is_some_and(|p| p.driver == Driver::Mongo)
    }

    /// Everything the subject may do somewhere in the addressed database — an
    /// upper bound for one connection, which a single relation may narrow.
    /// `None` when unmanaged.
    pub fn database_grant(&self) -> Option<Grant> {
        let rules = self.rules_for_database(self.database)?;
        Some(
            rules
                .iter()
                .fold(Grant::default(), |all, r| all.union(self.grant(r))),
        )
    }

    pub fn database_visible(&self, database: &str) -> bool {
        self.decide(&Need::Database(database.to_string())).is_ok()
    }

    /// Whether free SQL is withheld on this connection — every rule that could
    /// grant it is scoped. The AI panel drops `run_query` from its catalogue
    /// when this holds, and the app locks its query editor.
    pub fn free_sql_blocked(&self) -> bool {
        match self.rules_for_database(self.database) {
            None => false,
            Some(rules) => !rules
                .iter()
                .any(|r| !r.is_scoped() && self.grant(r).verbs.contains(Verbs::SELECT)),
        }
    }

    /// The rules of this user's role that match the profile's endpoint — for
    /// the diagnostics view.
    pub fn endpoint_rules(&self) -> Vec<&'a Rule> {
        match self.coverage() {
            Coverage::Unmanaged => Vec::new(),
            Coverage::Rules(rules) => rules,
        }
    }

    pub fn is_unmanaged(&self) -> bool {
        matches!(self.coverage(), Coverage::Unmanaged)
    }
}

fn verbs_phrase(verbs: Verbs) -> String {
    let names = Grant {
        verbs,
        export: false,
        monitor: false,
    }
    .names();
    if names.is_empty() {
        "reach".to_string()
    } else {
        names.join(" + ")
    }
}

/// "give a value to" / "change", for a column refusal.
fn column_verb(verb: Verbs) -> &'static str {
    if verb == Verbs::INSERT {
        "give a value to"
    } else {
        "change"
    }
}

/// Whether `rule` lets `verb` write `column` — it sets no limit for the verb,
/// or one of its globs matches. Whether the rule grants the verb at all is the
/// caller's question.
pub(super) fn column_covered(rule: &Rule, verb: Verbs, column: &str) -> bool {
    match rule.columns.limit(verb) {
        None => true,
        Some(globs) => globs.iter().any(|g| glob_matches(g, column)),
    }
}

/// The union of what `rules` allow `verb` to write: `None` (every column)
/// when any of them sets no limit, otherwise every glob any of them lists, in
/// order and without repeats. Rules that do not grant the verb must already
/// be filtered out.
fn union_limits<'r>(rules: impl IntoIterator<Item = &'r Rule>, verb: Verbs) -> Option<Vec<String>> {
    let mut globs: Vec<String> = Vec::new();
    for rule in rules {
        let limit = rule.columns.limit(verb)?;
        for g in limit {
            if !globs.iter().any(|seen| seen.eq_ignore_ascii_case(g)) {
                globs.push(g.clone());
            }
        }
    }
    Some(globs)
}

/// The top-level field of a MongoDB field path: `address.zip` → `address`.
pub fn top_level_field(path: &str) -> &str {
    path.split('.').next().unwrap_or(path)
}

fn qualified(schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{s}.{name}"),
        _ => name.to_string(),
    }
}

/// The database user `user`'s role pins on `profile`'s endpoint: the first of
/// the role's rules for that endpoint, in document order, that carries a
/// `dbUser`, expanded. Endpoint-wide on purpose: a user signs in to a server,
/// not to one database of it, so a rule's `databases` do not narrow it.
pub fn pinned_db_user(doc: &PolicyDoc, user: &str, profile: &ConnectionProfile) -> Option<String> {
    let (_, role) = doc.role_for(user);
    role.rules
        .iter()
        .filter(|r| endpoint_matches(&r.endpoint, profile))
        .find_map(|r| r.db_user.as_deref())
        .and_then(|template| expand_db_user(template, user))
}

/// Whether a rule's endpoint pattern names this profile's server.
pub fn endpoint_matches(pattern: &EndpointPattern, profile: &ConnectionProfile) -> bool {
    use crate::db::endpoint::normalise_host;
    match pattern {
        EndpointPattern::Any => true,
        EndpointPattern::File { path } => {
            profile.driver == Driver::Sqlite
                && normalise_path(path) == normalise_path(&profile.database)
        }
        EndpointPattern::Server { driver, host, port } => {
            profile.driver != Driver::Sqlite
                && driver.is_none_or(|d| d == profile.driver)
                && normalise_host(host) == normalise_host(&profile.host)
                && port.is_none_or(|p| p == profile.effective_port())
        }
    }
}

/// Paths compare with either slash and in any case: the administrator writes
/// the path once for every machine, and Windows paths are case-insensitive.
fn normalise_path(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

pub(super) fn database_matches(rule: &Rule, database: Option<&str>) -> bool {
    match (&rule.databases, database) {
        (None, _) => true,
        (Some(globs), Some(db)) => globs.iter().any(|g| glob_matches(g, db)),
        // The rule is about named databases and the request names none it can
        // be checked against: not covered.
        (Some(_), None) => false,
    }
}

pub(super) fn relation_allowed(rule: &Rule, schema: Option<&str>, name: &str) -> bool {
    let full = qualified(schema, name);
    let hit = |glob: &String| {
        if glob.contains('.') {
            glob_matches(glob, &full)
        } else {
            glob_matches(glob, name)
        }
    };
    if rule.relations.deny.iter().any(hit) {
        return false;
    }
    match &rule.relations.allow {
        None => true,
        Some(globs) => globs.iter().any(hit),
    }
}

/// `*` matches any run of characters, everything else itself, ignoring case.
///
/// Case-insensitive on purpose, in both directions: a `deny` written as
/// `Cards` has to catch `cards`, and the cost on the `allow` side — `invoices`
/// also admitting a separate `INVOICES` on a case-sensitive Postgres — is rare
/// and visible in the diagnostics.
pub fn glob_matches(glob: &str, text: &str) -> bool {
    let glob: Vec<char> = glob.trim().to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    // Iterative wildcard match with one backtrack point per `*`.
    let (mut g, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while t < text.len() {
        if g < glob.len() && glob[g] != '*' && glob[g] == text[t] {
            g += 1;
            t += 1;
        } else if g < glob.len() && glob[g] == '*' {
            star = Some(g);
            mark = t;
            g += 1;
        } else if let Some(s) = star {
            g = s + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    glob[g..].iter().all(|c| *c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;

    fn doc_of(text: &str) -> PolicyDoc {
        PolicyDoc::parse(text).unwrap().0
    }

    fn doc(text: &str) -> PolicyDoc {
        PolicyDoc::parse(text).unwrap().0
    }

    /// The customer's own example: sales reads billing, production only sees
    /// its own area, an administrator does more, everyone else nothing.
    const COMPANY: &str = r#"{
        "version": 1,
        "defaultRole": "none",
        "users": { "ana": "sales", "pau": "production", "CORP\\scara": "admin" },
        "roles": {
            "none": {},
            "sales": { "rules": [{
                "endpoint": { "driver": "mysql", "host": "ERP.local", "port": 3306 },
                "databases": ["billing"],
                "relations": { "allow": ["invoices", "v_invoice_*"], "deny": ["v_invoice_cards"] },
                "human": ["select", "insert", "update"],
                "ai": ["select"]
            }] },
            "production": { "rules": [{
                "endpoint": { "host": "erp.local" },
                "databases": ["prod*"],
                "human": ["select", "insert", "update", "delete"],
                "ai": ["select", "insert"]
            }] },
            "admin": { "rules": [{
                "endpoint": "*",
                "human": ["select", "insert", "update", "delete", "ddl", "monitor"],
                "ai": ["select", "update", "monitor"]
            }] }
        }
    }"#;

    fn erp() -> ConnectionProfile {
        ConnectionProfile {
            name: "ERP".into(),
            driver: Driver::Mysql,
            host: "erp.local".into(),
            port: 3306,
            ..testkit::profile("erp")
        }
    }

    fn ctx<'a>(
        doc: &'a PolicyDoc,
        user: &'a str,
        profile: &'a ConnectionProfile,
        database: Option<&'a str>,
    ) -> Ctx<'a> {
        Ctx {
            doc,
            user,
            profile: Some(profile),
            database,
            subject: Subject::Ai,
        }
    }

    fn person<'a>(
        doc: &'a PolicyDoc,
        user: &'a str,
        profile: &'a ConnectionProfile,
        database: Option<&'a str>,
    ) -> Ctx<'a> {
        Ctx {
            subject: Subject::Human,
            ..ctx(doc, user, profile, database)
        }
    }

    fn rel(name: &str, verbs: Verbs) -> Need {
        Need::Relation {
            schema: None,
            name: name.into(),
            verbs,
        }
    }

    #[test]
    fn sales_reads_billing_and_nothing_else() {
        let doc = doc(COMPANY);
        let erp = erp();
        let sales = ctx(&doc, "ana", &erp, Some("billing"));
        assert!(sales.decide(&Need::Endpoint).is_ok());
        assert!(sales.decide(&rel("invoices", Verbs::SELECT)).is_ok());
        assert!(sales
            .decide(&rel("v_invoice_totals", Verbs::SELECT))
            .is_ok());
        // Denied by name, whatever `allow` says.
        assert!(sales
            .decide(&rel("v_invoice_cards", Verbs::SELECT))
            .is_err());
        // Not in the allow list.
        assert!(sales.decide(&rel("payroll", Verbs::SELECT)).is_err());
        // The person may insert; their AI may not.
        let err = sales.decide(&rel("invoices", Verbs::INSERT)).unwrap_err();
        assert!(err.contains("\"sales\""), "{err}");
        // Another database on the same server is out of reach.
        let elsewhere = ctx(&doc, "ana", &erp, Some("prod_line"));
        assert!(elsewhere.decide(&rel("invoices", Verbs::SELECT)).is_err());
        assert!(!elsewhere.database_visible("prod_line"));
        assert!(sales.database_visible("billing"));
    }

    /// Two rules on one server: `orders` limited to some columns, `notes`
    /// limited on update by one rule and open by another.
    const COLUMNS: &str = r#"{
        "version": 1,
        "defaultRole": "r",
        "roles": { "r": { "rules": [
            { "endpoint": "*", "relations": { "allow": ["orders"] },
              "human": ["select", "insert", "update"], "ai": ["select", "update"],
              "columns": { "insert": ["customer", "status"], "update": ["status", "note_*"] } },
            { "endpoint": "*", "relations": { "allow": ["notes"] },
              "human": ["select", "update"], "columns": { "update": ["body"] } },
            { "endpoint": "*", "relations": { "allow": ["notes"] },
              "human": ["select", "update"] }
        ] } }
    }"#;

    fn cols(name: &str, verb: Verbs, columns: &[&str]) -> Need {
        Need::Columns {
            schema: None,
            name: name.into(),
            verb,
            columns: columns.iter().map(|c| c.to_string()).collect(),
        }
    }

    #[test]
    fn a_column_limit_narrows_what_a_verb_writes() {
        let doc = doc(COLUMNS);
        let erp = erp();
        let me = person(&doc, "anyone", &erp, None);
        assert!(me
            .decide(&cols("orders", Verbs::UPDATE, &["status"]))
            .is_ok());
        assert!(me
            .decide(&cols("orders", Verbs::UPDATE, &["Note_Internal"]))
            .is_ok());
        let err = me
            .decide(&cols(
                "orders",
                Verbs::UPDATE,
                &["status", "amount", "total"],
            ))
            .unwrap_err();
        assert!(
            err.contains("may not change columns amount, total"),
            "{err}"
        );
        assert!(err.contains("are: status, note_*"), "{err}");
        // Insert reads its own list.
        assert!(me
            .decide(&cols("orders", Verbs::INSERT, &["customer", "status"]))
            .is_ok());
        let err = me
            .decide(&cols("orders", Verbs::INSERT, &["note_x"]))
            .unwrap_err();
        assert!(
            err.contains("may not give a value to column note_x"),
            "{err}"
        );
        // The AI reads the same list, through its own grant.
        let ai = ctx(&doc, "anyone", &erp, None);
        assert!(ai
            .decide(&cols("orders", Verbs::UPDATE, &["status"]))
            .is_ok());
        assert!(ai
            .decide(&cols("orders", Verbs::UPDATE, &["amount"]))
            .is_err());
        assert!(ai
            .decide(&cols("orders", Verbs::INSERT, &["status"]))
            .is_err());
    }

    #[test]
    fn a_rule_without_a_column_limit_wins_the_union() {
        let doc = doc(COLUMNS);
        let erp = erp();
        let me = person(&doc, "anyone", &erp, None);
        assert!(me
            .decide(&cols("notes", Verbs::UPDATE, &["anything"]))
            .is_ok());
        let scope = me.relation_columns(None, "notes").unwrap();
        assert_eq!(scope.update, None);
        let scope = me.relation_columns(None, "orders").unwrap();
        assert_eq!(
            scope.update,
            Some(vec!["status".to_string(), "note_*".to_string()])
        );
        assert_eq!(
            scope.insert,
            Some(vec!["customer".to_string(), "status".to_string()])
        );
    }

    #[test]
    fn on_mongodb_a_field_is_judged_by_its_top_level_name() {
        let doc = doc(COLUMNS);
        let mongo = ConnectionProfile {
            driver: Driver::Mongo,
            ..erp()
        };
        let me = person(&doc, "anyone", &mongo, None);
        assert!(me
            .decide(&cols("orders", Verbs::UPDATE, &["status.code"]))
            .is_ok());
        assert!(me
            .decide(&cols("orders", Verbs::UPDATE, &["amount.value"]))
            .is_err());
        // `_id` is the document's key: inserting it is never limited.
        assert!(me
            .decide(&cols("orders", Verbs::INSERT, &["_id", "customer"]))
            .is_ok());
        // On SQL a dotted name is a column like any other.
        let erp = erp();
        let sql = person(&doc, "anyone", &erp, None);
        assert!(sql
            .decide(&cols("orders", Verbs::UPDATE, &["status.code"]))
            .is_err());
    }

    #[test]
    fn column_limits_close_free_writes_but_not_free_reads() {
        let text = r#"{"version":1,"defaultRole":"r","roles":{"r":{"rules":[
            {"endpoint":"*","human":["select","update"],"columns":{"update":["status"]}}]}}}"#;
        let doc = doc(text);
        let erp = erp();
        let me = person(&doc, "anyone", &erp, None);
        assert!(me.decide(&Need::FreeSql(Verbs::SELECT)).is_ok());
        assert!(!me.free_sql_blocked());
        let err = me.decide(&Need::FreeSql(Verbs::UPDATE)).unwrap_err();
        assert!(err.contains("limits which columns"), "{err}");
    }

    #[test]
    fn an_unmanaged_connection_has_no_column_limits() {
        let text = r#"{"version":1,"defaultRole":"r","unmanagedConnections":"allow",
            "roles":{"r":{"rules":[{"endpoint":{"host":"elsewhere"},"human":["update"],
            "columns":{"update":["a"]}}]}}}"#;
        let doc = doc(text);
        let erp = erp();
        let me = person(&doc, "anyone", &erp, None);
        assert!(me.decide(&cols("t", Verbs::UPDATE, &["b"])).is_ok());
        assert_eq!(me.relation_columns(None, "t"), None);
    }

    #[test]
    fn a_scoped_rule_takes_free_sql_away() {
        let doc = doc(COMPANY);
        let erp = erp();
        let sales = ctx(&doc, "ana", &erp, Some("billing"));
        let err = sales.decide(&Need::FreeSql(Verbs::SELECT)).unwrap_err();
        assert!(err.contains("free-form queries are disabled"), "{err}");
        assert!(sales.free_sql_blocked());

        // An unscoped rule keeps it, bounded by the verbs.
        let admin = ctx(&doc, "scara", &erp, Some("billing"));
        assert!(admin.decide(&Need::FreeSql(Verbs::SELECT)).is_ok());
        assert!(admin.decide(&Need::FreeSql(Verbs::UPDATE)).is_ok());
        assert!(admin.decide(&Need::FreeSql(Verbs::DELETE)).is_err());
        assert!(admin
            .decide(&Need::FreeSql(Verbs::SELECT | Verbs::DELETE))
            .is_err());
        assert!(!admin.free_sql_blocked());
    }

    #[test]
    fn production_sees_its_own_databases() {
        let doc = doc(COMPANY);
        let erp = erp();
        let prod = ctx(&doc, "pau", &erp, Some("prod_line"));
        assert!(prod.decide(&rel("orders", Verbs::INSERT)).is_ok());
        // Its person may delete; the AI was given less.
        assert!(prod.decide(&rel("orders", Verbs::DELETE)).is_err());
        assert!(!ctx(&doc, "pau", &erp, Some("billing")).database_visible("billing"));
    }

    #[test]
    fn monitoring_is_its_own_grant() {
        let doc = doc(COMPANY);
        let erp = erp();
        assert!(ctx(&doc, "ana", &erp, Some("billing"))
            .decide(&Need::Monitor)
            .is_err());
        assert!(ctx(&doc, "scara", &erp, None)
            .decide(&Need::Monitor)
            .is_ok());
    }

    #[test]
    fn a_user_without_a_role_gets_the_default_and_reaches_nothing() {
        let doc = doc(COMPANY);
        let erp = erp();
        let stranger = ctx(&doc, "mallory", &erp, Some("billing"));
        assert!(stranger.decide(&Need::Endpoint).is_err());
        assert!(stranger.decide(&rel("invoices", Verbs::SELECT)).is_err());
    }

    #[test]
    fn a_server_reached_under_another_name_is_unmanaged_and_denied() {
        let doc = doc(COMPANY);
        let aliased = ConnectionProfile {
            host: "10.0.0.5".into(),
            ..erp()
        };
        // Sales' rule names erp.local; the IP is not it, and unmanaged
        // connections are denied by default — which is what makes the alias
        // useless as a way round the rule.
        assert!(ctx(&doc, "ana", &aliased, Some("billing"))
            .decide(&Need::Endpoint)
            .is_err());
    }

    #[test]
    fn unmanaged_allow_leaves_unnamed_connections_to_the_local_settings() {
        let text = COMPANY.replacen(
            "\"defaultRole\": \"none\",",
            "\"defaultRole\": \"none\", \"unmanagedConnections\": \"allow\",",
            1,
        );
        let doc = doc(&text);
        let other = ConnectionProfile {
            host: "reports.local".into(),
            ..erp()
        };
        let ana = ctx(&doc, "ana", &other, None);
        assert!(ana.is_unmanaged());
        assert!(ana.decide(&Need::FreeSql(Verbs::DELETE)).is_ok());
        // A connection a rule *does* name stays governed by it.
        let erp = erp();
        assert!(ctx(&doc, "ana", &erp, Some("billing"))
            .decide(&Need::FreeSql(Verbs::SELECT))
            .is_err());
    }

    #[test]
    fn endpoints_match_by_server_not_by_id() {
        let pattern = |p: &str| {
            let text = format!(
                r#"{{"version":1,"defaultRole":"r","roles":{{"r":{{"rules":[{{"endpoint":{p}}}]}}}}}}"#
            );
            PolicyDoc::parse(&text).unwrap().0.roles["r"].rules[0]
                .endpoint
                .clone()
        };
        let erp = erp();
        assert!(endpoint_matches(
            &pattern(r#"{"host":" ERP.LOCAL "}"#),
            &erp
        ));
        assert!(endpoint_matches(
            &pattern(r#"{"host":"erp.local","port":3306}"#),
            &erp
        ));
        assert!(!endpoint_matches(
            &pattern(r#"{"host":"erp.local","port":3307}"#),
            &erp
        ));
        assert!(!endpoint_matches(
            &pattern(r#"{"driver":"postgres","host":"erp.local"}"#),
            &erp
        ));
        // A blank port is the driver's default (ADR #89).
        let blank_port = ConnectionProfile {
            port: 0,
            ..erp.clone()
        };
        assert!(endpoint_matches(
            &pattern(r#"{"host":"erp.local","port":3306}"#),
            &blank_port
        ));

        let sqlite = ConnectionProfile {
            driver: Driver::Sqlite,
            host: String::new(),
            database: "C:\\Data\\App.db".into(),
            ..testkit::profile("lite")
        };
        assert!(endpoint_matches(
            &pattern(r#"{"path":"c:/data/app.db"}"#),
            &sqlite
        ));
        assert!(!endpoint_matches(
            &pattern(r#"{"host":"erp.local"}"#),
            &sqlite
        ));
    }

    #[test]
    fn on_mysql_a_qualified_name_says_which_database() {
        let doc = doc(COMPANY);
        // A root connection with no default database, as the multi-database
        // explorer opens one.
        let root = ConnectionProfile {
            database: String::new(),
            ..erp()
        };
        let sales = ctx(&doc, "ana", &root, None);
        assert!(sales.relation_visible(Some("billing"), "invoices"));
        assert!(!sales.relation_visible(Some("hr"), "invoices"));
        let need = Need::Relation {
            schema: Some("billing".into()),
            name: "invoices".into(),
            verbs: Verbs::SELECT,
        };
        assert!(sales.decide(&need).is_ok());
    }

    #[test]
    fn qualified_patterns_match_the_schema_too() {
        let text = r#"{"version":1,"defaultRole":"r","roles":{"r":{"rules":[{
            "endpoint":"*","relations":{"allow":["public.*"],"deny":["public.secrets"]},
            "human":["select"],"ai":["select"]}]}}}"#;
        let doc = doc(text);
        let pg = ConnectionProfile {
            driver: Driver::Postgres,
            ..erp()
        };
        let c = ctx(&doc, "u", &pg, Some("erp"));
        assert!(c.relation_visible(Some("public"), "orders"));
        assert!(!c.relation_visible(Some("public"), "secrets"));
        assert!(!c.relation_visible(Some("audit"), "orders"));
    }

    #[test]
    fn a_person_is_judged_by_the_human_block() {
        let doc = doc(COMPANY);
        let erp = erp();
        let ana = person(&doc, "ana", &erp, Some("billing"));
        // Sales people may insert and update billing; their AI may only read.
        assert!(ana.decide(&rel("invoices", Verbs::INSERT)).is_ok());
        assert!(ana.decide(&rel("invoices", Verbs::UPDATE)).is_ok());
        assert!(ctx(&doc, "ana", &erp, Some("billing"))
            .decide(&rel("invoices", Verbs::INSERT))
            .is_err());
        // But not delete, and the refusal speaks to them.
        let err = ana.decide(&rel("invoices", Verbs::DELETE)).unwrap_err();
        assert!(err.starts_with("you may not delete"), "{err}");
        // Hidden relations stay hidden from people too.
        assert!(!ana.relation_visible(None, "payroll"));
        // A scoped rule takes free SQL from people as well, pointing them at
        // the explorer rather than at MCP tools.
        let err = ana.decide(&Need::FreeSql(Verbs::SELECT)).unwrap_err();
        assert!(err.contains("from the explorer"), "{err}");
        assert!(ana.free_sql_blocked());
    }

    #[test]
    fn exporting_needs_export_and_select_on_the_relation() {
        let doc = doc(COMPANY);
        let erp = erp();
        let export = |name: &str| Need::Export {
            schema: None,
            name: name.into(),
        };
        // Sales may read invoices but was not granted `export`.
        let ana = person(&doc, "ana", &erp, Some("billing"));
        assert!(ana.decide(&export("invoices")).is_err());
        // Give the admin's person block `export`; the AI block stays without.
        let with_export = doc_of(&COMPANY.replacen(
            r#""human": ["select", "insert", "update", "delete", "ddl", "monitor"]"#,
            r#""human": ["select", "insert", "update", "delete", "ddl", "monitor", "export"]"#,
            1,
        ));
        let admin = person(&with_export, "scara", &erp, Some("billing"));
        assert!(admin.decide(&export("invoices")).is_ok());
        assert!(ctx(&with_export, "scara", &erp, Some("billing"))
            .decide(&export("invoices"))
            .is_err());
        // Without it, even an administrator may read but not export.
        assert!(person(&doc, "scara", &erp, Some("billing"))
            .decide(&export("invoices"))
            .is_err());
    }

    #[test]
    fn creating_a_database_needs_ddl_on_a_rule_that_covers_it() {
        let doc = doc(COMPANY);
        let erp = erp();
        let need = |db: &str| Need::DatabaseDdl(db.into());
        assert!(person(&doc, "scara", &erp, None)
            .decide(&need("new_db"))
            .is_ok());
        assert!(person(&doc, "ana", &erp, None)
            .decide(&need("billing"))
            .is_err());
        assert!(person(&doc, "pau", &erp, None)
            .decide(&need("prod_line"))
            .is_err());
    }

    #[test]
    fn a_relation_grant_is_everything_its_rules_allow() {
        let doc = doc(COMPANY);
        let erp = erp();
        let ana = person(&doc, "ana", &erp, Some("billing"));
        let grant = ana.relation_grant(None, "invoices").unwrap();
        assert_eq!(grant.verbs, Verbs::SELECT | Verbs::INSERT | Verbs::UPDATE);
        assert!(!grant.export);
        assert!(ana.relation_grant(None, "payroll").unwrap().is_empty());
        let db = ana.database_grant().unwrap();
        assert_eq!(db.verbs, Verbs::SELECT | Verbs::INSERT | Verbs::UPDATE);

        // An unmanaged connection has no answer: the policy says nothing.
        let text = COMPANY.replacen(
            "\"defaultRole\": \"none\",",
            "\"defaultRole\": \"none\", \"unmanagedConnections\": \"allow\",",
            1,
        );
        let open = doc_of(&text);
        let elsewhere = ConnectionProfile {
            host: "reports.local".into(),
            ..erp.clone()
        };
        let free = person(&open, "ana", &elsewhere, None);
        assert!(free.relation_grant(None, "anything").is_none());
        assert!(free.database_grant().is_none());
    }

    #[test]
    fn globs_match_like_an_administrator_expects() {
        assert!(glob_matches("v_invoice_*", "v_invoice_totals"));
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("prod*", "PROD_line"));
        assert!(glob_matches("*_log", "audit_log"));
        assert!(glob_matches("a*b*c", "axxbyyc"));
        assert!(!glob_matches("a*b*c", "axxbyy"));
        assert!(!glob_matches("invoices", "invoices_old"));
        assert!(glob_matches("invoices", "invoices"));
    }

    #[test]
    fn the_first_rule_for_the_endpoint_with_a_db_user_pins_it() {
        let (doc, _) = PolicyDoc::parse(
            r#"{
                "version": 1, "defaultRole": "none",
                "users": { "ACME\\ana": "sales" },
                "roles": {
                    "none": {},
                    "sales": { "rules": [
                        { "endpoint": { "host": "crm.local" }, "dbUser": "crm_{user}" },
                        { "endpoint": { "host": "erp.local" }, "databases": ["billing"] },
                        { "endpoint": { "host": "erp.local" }, "databases": ["hr"],
                          "dbUser": "{user}" },
                        { "endpoint": "*", "dbUser": "later" }
                    ] }
                }
            }"#,
        )
        .unwrap();
        let erp = ConnectionProfile {
            driver: Driver::Postgres,
            host: "ERP.local".into(),
            ..crate::testkit::profile("erp")
        };
        // Endpoint-wide: the `hr` rule's user applies to the whole server.
        assert_eq!(pinned_db_user(&doc, "ana", &erp), Some("ana".into()));
        // Someone the policy does not list gets the default role, which pins
        // nothing.
        assert_eq!(pinned_db_user(&doc, "bob", &erp), None);
    }
}
