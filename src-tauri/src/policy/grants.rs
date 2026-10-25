//! The permission script for one role on one server — phase 3 of managed
//! policy (`docs/POLICY_ROADMAP.md` §7). With a database user per person
//! (`crate::credentials`), these grants are what make the database, and not
//! only HuginnDB, enforce what the policy says.
//!
//! Pure: the rules, the catalog as it stands and the members go in, a script
//! comes out. [`crate::commands::policy::policy_generate_grants`] does the
//! reading. **HuginnDB never runs the script** — it is for an administrator
//! to review and run, and the header says so.
//!
//! How a rule becomes grants:
//!
//! - A rule over **every relation** of a database (no `relations.allow`, no
//!   `deny`) grants at the database or schema level, which also covers tables
//!   created later.
//! - Otherwise the patterns are **expanded against the catalog**: a `GRANT`
//!   takes no wildcards, and a grant cannot subtract a `deny`. The script then
//!   says it describes the relations that exist today.
//! - Rules add up: two rules granting on the same object merge their verbs.
//! - `export` has no database equivalent — reading is what lets another client
//!   export — and `monitor` is server-wide.
//! - A rule that limits columns (ADR #113) is always expanded, since a column
//!   grant names one object, and its globs are resolved against each
//!   relation's columns as they are today: `GRANT UPDATE (a, b) ON t`. SQL
//!   Server grants `INSERT` only on the whole table and MongoDB has no field
//!   privileges at all; the script grants the whole object there and says so.

use super::model::{expand_db_user, normalise_user, Grant, PolicyDoc, Rule};
use super::resolve::{database_matches, endpoint_matches, glob_matches, relation_allowed};
use crate::db::dump::quote_text_literal;
use crate::db::sql::{Dialect, Verbs};
use crate::state::ConnectionProfile;
use std::collections::{BTreeMap, BTreeSet};

/// The engines a script can be written for. SQLite has no users.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Postgres,
    Mysql,
    MsSql,
    Mongo,
}

/// One relation of the catalog. On MySQL and MongoDB `schema` is the
/// database, as everywhere else in the app.
#[derive(Debug, Clone)]
pub struct Relation {
    pub database: String,
    pub schema: String,
    pub name: String,
    /// The relation's columns — read only when a rule limits columns on it,
    /// and empty otherwise.
    pub columns: Vec<String>,
}

pub struct GrantInput<'a> {
    pub engine: Engine,
    /// The policy's role name.
    pub role: &'a str,
    /// The role's rules whose endpoint is this server.
    pub rules: Vec<&'a Rule>,
    /// Every database on the server (the rules' `databases` pick among them).
    pub databases: Vec<String>,
    /// Every relation of those databases.
    pub relations: Vec<Relation>,
    /// Database users to add to the role, as comments.
    pub members: Vec<String>,
    /// `host:port`, for the header.
    pub server: String,
    /// Where the policy was read from, for the header.
    pub source: String,
    /// RFC 3339, for the header.
    pub generated_at: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantScript {
    /// `sql` or `javascript`, for the editor and the file extension.
    pub language: &'static str,
    /// The database role the script creates.
    pub role_name: String,
    pub script: String,
    /// What the administrator should know before running it.
    pub warnings: Vec<String>,
}

/// What one object is granted.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    /// Every relation of a database — MySQL `db.*`, MongoDB `collection: ""`.
    Database(String),
    /// Every relation of a schema — Postgres, SQL Server.
    Schema(String, String),
    Relation(String, String, String),
}

impl Target {
    fn database(&self) -> &str {
        match self {
            Target::Database(d) | Target::Schema(d, _) | Target::Relation(d, _, _) => d,
        }
    }
}

/// The two verbs a rule can limit to some columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum LimitedVerb {
    Insert,
    Update,
}

impl LimitedVerb {
    const ALL: [(LimitedVerb, Verbs); 2] = [
        (LimitedVerb::Insert, Verbs::INSERT),
        (LimitedVerb::Update, Verbs::UPDATE),
    ];

    fn key(self) -> &'static str {
        match self {
            LimitedVerb::Insert => "insert",
            LimitedVerb::Update => "update",
        }
    }
}

/// Which columns a limited verb reaches on one relation, merged across rules:
/// one rule without a limit makes it every column.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ColumnGrant {
    All,
    Only(BTreeSet<String>),
}

type Limits = BTreeMap<(Target, LimitedVerb), ColumnGrant>;

/// What [`plan`] works out.
struct Plan {
    targets: BTreeMap<Target, Verbs>,
    /// Column lists for `INSERT`/`UPDATE` on relation targets; a target and
    /// verb with no entry is granted on every column.
    limits: Limits,
    expanded: bool,
    warnings: Vec<String>,
}

/// `role`'s rules for `profile`'s server, or `None` when the policy has no
/// such role.
pub fn rules_for<'a>(
    doc: &'a PolicyDoc,
    role: &str,
    profile: &ConnectionProfile,
) -> Option<Vec<&'a Rule>> {
    let role = doc.roles.get(role)?;
    Some(
        role.rules
            .iter()
            .filter(|r| endpoint_matches(&r.endpoint, profile))
            .collect(),
    )
}

/// Whether any of `rules` reaches `database` — the databases whose catalog
/// the script has to read.
pub fn wants_database(rules: &[&Rule], database: &str) -> bool {
    rules.iter().any(|r| database_matches(r, Some(database)))
}

/// Whether a rule limits the columns some verb writes on this relation — the
/// relations whose columns the script has to read.
pub fn wants_columns(rules: &[&Rule], database: &str, schema: &str, name: &str) -> bool {
    rules.iter().any(|r| {
        database_matches(r, Some(database))
            && relation_allowed(r, Some(schema), name)
            && r.limits_columns_of(r.human_grant().verbs)
    })
}

/// The database users of the people the policy gives `role`: their OS
/// account, or the `dbUser` the first rule for this server that has one
/// expands to for them — the same user they sign in as
/// (`crate::credentials`). People who only get the role as `defaultRole` are
/// not listed by name anywhere, so they cannot be here either.
pub fn members(doc: &PolicyDoc, role: &str, rules: &[&Rule]) -> Vec<String> {
    let template = rules.iter().find_map(|r| r.db_user.as_deref());
    let mut out: Vec<String> = doc
        .users
        .iter()
        .filter(|(_, r)| r.as_str() == role)
        .filter_map(|(user, _)| match template {
            Some(t) => expand_db_user(t, user),
            None => Some(normalise_user(user)).filter(|u| !u.is_empty()),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `huginn_<role>`, folded to what every engine accepts unquoted.
pub fn role_name(role: &str) -> String {
    let folded: String = role
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("huginn_{folded}")
}

fn engine_has_schemas(engine: Engine) -> bool {
    matches!(engine, Engine::Postgres | Engine::MsSql)
}

/// Grant `verbs` on `t`, on top of what another rule already granted there.
fn add(targets: &mut BTreeMap<Target, Verbs>, t: Target, verbs: Verbs) {
    let merged = targets.get(&t).copied().unwrap_or(Verbs::NONE) | verbs;
    targets.insert(t, merged);
}

/// The objects each rule reaches and what it grants on them, merged.
fn plan(input: &GrantInput) -> Plan {
    let mut targets: BTreeMap<Target, Verbs> = BTreeMap::new();
    let mut limits: Limits = BTreeMap::new();
    let mut expanded = false;
    for rule in &input.rules {
        let grant: Grant = rule.human_grant();
        let verbs = grant.verbs;
        if verbs == Verbs::NONE {
            continue;
        }
        // A column grant names one object, so a rule that limits columns is
        // expanded even when it covers every relation.
        let whole = rule.relations.allow.is_none()
            && rule.relations.deny.is_empty()
            && !rule.limits_columns_of(verbs);
        for db in input
            .databases
            .iter()
            .filter(|db| database_matches(rule, Some(db)))
        {
            let in_db = input.relations.iter().filter(|r| &r.database == db);
            if whole {
                if engine_has_schemas(input.engine) {
                    let schemas: BTreeSet<&str> = in_db.map(|r| r.schema.as_str()).collect();
                    for schema in schemas {
                        add(
                            &mut targets,
                            Target::Schema(db.clone(), schema.to_string()),
                            verbs,
                        );
                    }
                } else {
                    add(&mut targets, Target::Database(db.clone()), verbs);
                }
                continue;
            }
            expanded = true;
            for r in in_db {
                // The same matching the app applies (`relation_allowed`), with
                // the schema the pattern is written against: on MySQL and
                // MongoDB that is the database.
                if relation_allowed(rule, Some(&r.schema), &r.name) {
                    let target = Target::Relation(db.clone(), r.schema.clone(), r.name.clone());
                    for (limited, verb) in LimitedVerb::ALL {
                        if !verbs.contains(verb) {
                            continue;
                        }
                        let this = match rule.columns.limit(verb) {
                            None => ColumnGrant::All,
                            Some(globs) => ColumnGrant::Only(
                                r.columns
                                    .iter()
                                    .filter(|c| globs.iter().any(|g| glob_matches(g, c)))
                                    .cloned()
                                    .collect(),
                            ),
                        };
                        let key = (target.clone(), limited);
                        let merged = match (limits.remove(&key), this) {
                            (Some(ColumnGrant::All), _) | (_, ColumnGrant::All) => ColumnGrant::All,
                            (Some(ColumnGrant::Only(mut a)), ColumnGrant::Only(b)) => {
                                a.extend(b);
                                ColumnGrant::Only(a)
                            }
                            (None, only) => only,
                        };
                        limits.insert(key, merged);
                    }
                    add(&mut targets, target, verbs);
                }
            }
        }
    }
    // A limit that matches no column of a relation grants the verb on none of
    // it: take the verb away there, rather than grant it on the whole table.
    let mut warnings = Vec::new();
    limits.retain(|(target, limited), grant| match grant {
        ColumnGrant::All => false,
        ColumnGrant::Only(cols) if cols.is_empty() => {
            let verb = if *limited == LimitedVerb::Insert {
                Verbs::INSERT
            } else {
                Verbs::UPDATE
            };
            if let Some(v) = targets.get_mut(target) {
                *v = v.without(verb);
            }
            if let Target::Relation(_, schema, name) = target {
                warnings.push(format!(
                    "columns.{} matches no column of {schema}.{name}, so the role gets no {} \
                     there.",
                    limited.key(),
                    limited.key().to_uppercase()
                ));
            }
            false
        }
        ColumnGrant::Only(_) => true,
    });
    targets.retain(|_, v| *v != Verbs::NONE);
    Plan {
        targets,
        limits,
        expanded,
        warnings,
    }
}

pub fn build(input: &GrantInput) -> GrantScript {
    let role = role_name(input.role);
    let Plan {
        targets,
        limits,
        expanded,
        warnings: plan_warnings,
    } = plan(input);
    let monitor = input.rules.iter().any(|r| r.human_grant().monitor);
    let export = input.rules.iter().any(|r| r.human_grant().export);
    let ddl = targets.values().any(|v| v.contains(Verbs::DDL));

    let mut warnings = plan_warnings;
    let limited = |v: LimitedVerb| limits.keys().any(|(_, l)| *l == v);
    if expanded {
        warnings.push(
            "The rules name relations, so the grants list the ones that exist today. Generate \
             the script again after creating a table the rules should cover."
                .to_string(),
        );
    }
    if export {
        warnings.push(
            "No database permission tells reading from exporting: whoever may read a table can \
             export it from another client. `export` only applies inside HuginnDB."
                .to_string(),
        );
    }
    match input.engine {
        Engine::Postgres => {
            warnings.push(
                "PostgreSQL shows every relation's name in pg_catalog to every user. The grants \
                 protect the data; the names stay visible."
                    .to_string(),
            );
            if ddl {
                warnings.push(
                    "PostgreSQL only lets an object's owner alter or drop it: `ddl` grants \
                     CREATE, so the role can make new objects but not change existing ones."
                        .to_string(),
                );
            }
        }
        Engine::MsSql => {
            warnings.push(
                "SQL Server lists every database to every login unless VIEW ANY DATABASE is \
                 revoked from public — the script offers it, commented, because it affects \
                 every login."
                    .to_string(),
            );
            if limited(LimitedVerb::Insert) {
                warnings.push(
                    "SQL Server grants INSERT only on a whole table (column permissions are \
                     SELECT, UPDATE and REFERENCES), so the script grants INSERT on the table: \
                     columns.insert only applies inside HuginnDB. To have the database enforce \
                     it, grant INSERT on a view with just those columns instead."
                        .to_string(),
                );
            }
        }
        Engine::Mysql => {
            warnings.push("Roles need MySQL 8.0 or MariaDB 10.0.5 or later.".to_string())
        }
        Engine::Mongo => {
            if !limits.is_empty() {
                warnings.push(
                    "MongoDB has no field-level privileges, so the script grants insert and \
                     update on whole collections: the column limits only apply inside HuginnDB."
                        .to_string(),
                );
            }
        }
    }

    let comment = if input.engine == Engine::Mongo {
        "//"
    } else {
        "--"
    };
    let mut out = String::new();
    let mut line = |s: &str| {
        out.push_str(s);
        out.push('\n');
    };
    line(&format!(
        "{comment} HuginnDB: database permissions for policy role {:?} on {}",
        input.role, input.server
    ));
    line(&format!(
        "{comment} Generated {} from {}.",
        input.generated_at, input.source
    ));
    line(&format!(
        "{comment} HuginnDB never runs this script. Review it, then run it as an administrator."
    ));
    for w in &warnings {
        line(&format!("{comment} Note: {w}"));
    }
    line("");

    let body = if input.rules.is_empty() {
        format!(
            "{comment} Role {:?} has no rule for this server: there is nothing to grant.\n",
            input.role
        )
    } else if targets.is_empty() && !monitor {
        format!(
            "{comment} The rules for this server grant nothing on the databases and relations \
             that exist now.\n"
        )
    } else {
        match input.engine {
            Engine::Postgres => postgres(&role, &targets, &limits, monitor, &input.members),
            Engine::Mysql => mysql(&role, &targets, &limits, monitor, &input.members),
            Engine::MsSql => mssql(&role, &targets, &limits, monitor, &input.members),
            Engine::Mongo => mongo(&role, &targets, monitor, &input.members),
        }
    };
    out.push_str(&body);

    GrantScript {
        language: if input.engine == Engine::Mongo {
            "javascript"
        } else {
            "sql"
        },
        role_name: role,
        script: out,
        warnings,
    }
}

/// The SQL privileges for a set of verbs, in a stable order. `ddl` is not
/// here: every engine spells it differently, and some not per table.
fn dml(verbs: Verbs) -> Vec<&'static str> {
    [
        (Verbs::SELECT, "SELECT"),
        (Verbs::INSERT, "INSERT"),
        (Verbs::UPDATE, "UPDATE"),
        (Verbs::DELETE, "DELETE"),
    ]
    .into_iter()
    .filter(|(v, _)| verbs.contains(*v))
    .map(|(_, n)| n)
    .collect()
}

/// [`dml`] for one relation, with a column list after each limited verb:
/// `UPDATE ("a", "b")`. `insert_by_column` is false where the engine cannot
/// grant `INSERT` per column (SQL Server), which then gets the whole table.
fn relation_privs(
    target: &Target,
    verbs: Verbs,
    limits: &Limits,
    quote: impl Fn(&str) -> String,
    insert_by_column: bool,
) -> Vec<String> {
    dml(verbs)
        .into_iter()
        .map(|name| {
            let limited = match name {
                "INSERT" if insert_by_column => Some(LimitedVerb::Insert),
                "UPDATE" => Some(LimitedVerb::Update),
                _ => None,
            };
            match limited.and_then(|l| limits.get(&(target.clone(), l))) {
                Some(ColumnGrant::Only(cols)) => {
                    let list: Vec<String> = cols.iter().map(|c| quote(c)).collect();
                    format!("{name} ({})", list.join(", "))
                }
                _ => name.to_string(),
            }
        })
        .collect()
}

fn by_database(targets: &BTreeMap<Target, Verbs>) -> BTreeMap<&str, Vec<(&Target, Verbs)>> {
    let mut out: BTreeMap<&str, Vec<(&Target, Verbs)>> = BTreeMap::new();
    for (t, v) in targets {
        out.entry(t.database()).or_default().push((t, *v));
    }
    out
}

fn postgres(
    role: &str,
    targets: &BTreeMap<Target, Verbs>,
    limits: &Limits,
    monitor: bool,
    members: &[String],
) -> String {
    let q = |s: &str| Dialect::Postgres.quote_ident(s);
    let r = q(role);
    let mut out = format!("CREATE ROLE {r} NOLOGIN;\n");
    if monitor {
        out.push_str(&format!("GRANT pg_monitor TO {r};\n"));
    }
    for (db, items) in by_database(targets) {
        out.push_str(&format!(
            "\n-- Database {db:?}: run the lines below connected to it.\n"
        ));
        out.push_str(&format!("GRANT CONNECT ON DATABASE {} TO {r};\n", q(db)));
        let schemas: BTreeSet<&str> = items
            .iter()
            .filter_map(|(t, _)| match t {
                Target::Schema(_, s) | Target::Relation(_, s, _) => Some(s.as_str()),
                Target::Database(_) => None,
            })
            .collect();
        for s in &schemas {
            out.push_str(&format!("GRANT USAGE ON SCHEMA {} TO {r};\n", q(s)));
        }
        let mut ddl_schemas = BTreeSet::new();
        for (t, verbs) in &items {
            let privs = dml(*verbs).join(", ");
            match t {
                Target::Schema(_, s) => {
                    if !privs.is_empty() {
                        out.push_str(&format!(
                            "GRANT {privs} ON ALL TABLES IN SCHEMA {} TO {r};\n",
                            q(s)
                        ));
                        out.push_str(&format!(
                            "ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT {privs} ON TABLES TO {r};\n",
                            q(s)
                        ));
                    }
                    if verbs.contains(Verbs::DDL) {
                        ddl_schemas.insert(s.as_str());
                    }
                }
                Target::Relation(_, s, n) => {
                    let privs = relation_privs(t, *verbs, limits, q, true).join(", ");
                    if !privs.is_empty() {
                        out.push_str(&format!("GRANT {privs} ON {}.{} TO {r};\n", q(s), q(n)));
                    }
                    if verbs.contains(Verbs::DDL) {
                        ddl_schemas.insert(s.as_str());
                    }
                }
                Target::Database(_) => {}
            }
        }
        for s in ddl_schemas {
            out.push_str(&format!("GRANT CREATE ON SCHEMA {} TO {r};\n", q(s)));
        }
    }
    out.push_str("\n-- Members: replace with each person's database user, then uncomment.\n");
    for m in members {
        out.push_str(&format!("-- GRANT {r} TO {};\n", q(m)));
    }
    out
}

fn mysql(
    role: &str,
    targets: &BTreeMap<Target, Verbs>,
    limits: &Limits,
    monitor: bool,
    members: &[String],
) -> String {
    let q = |s: &str| Dialect::Mysql.quote_ident(s);
    let r = quote_text_literal(Dialect::Mysql, role);
    let mut out = format!("CREATE ROLE IF NOT EXISTS {r};\n");
    if monitor {
        out.push_str(&format!("GRANT PROCESS ON *.* TO {r};\n"));
    }
    for (t, verbs) in targets {
        let mut privs: Vec<String> = Vec::new();
        let on = match t {
            Target::Database(db) => {
                privs.extend(dml(*verbs).into_iter().map(String::from));
                if verbs.contains(Verbs::DDL) {
                    privs.extend(
                        ["CREATE", "ALTER", "DROP", "INDEX", "CREATE VIEW"].map(String::from),
                    );
                }
                format!("{}.*", q(db))
            }
            Target::Relation(db, _, n) => {
                privs.extend(relation_privs(t, *verbs, limits, q, true));
                if verbs.contains(Verbs::DDL) {
                    privs.extend(["ALTER", "DROP", "INDEX"].map(String::from));
                }
                format!("{}.{}", q(db), q(n))
            }
            Target::Schema(..) => continue,
        };
        if !privs.is_empty() {
            out.push_str(&format!("GRANT {} ON {on} TO {r};\n", privs.join(", ")));
        }
    }
    out.push_str(
        "\n-- Members: replace with each person's account ('user'@'host'), then uncomment.\n",
    );
    for m in members {
        let u = quote_text_literal(Dialect::Mysql, m);
        out.push_str(&format!("-- GRANT {r} TO {u}@'%';\n"));
        out.push_str(&format!("-- SET DEFAULT ROLE {r} TO {u}@'%';\n"));
    }
    out
}

fn mssql(
    role: &str,
    targets: &BTreeMap<Target, Verbs>,
    limits: &Limits,
    monitor: bool,
    members: &[String],
) -> String {
    let q = |s: &str| Dialect::MsSql.quote_ident(s);
    let r = q(role);
    let literal = quote_text_literal(Dialect::MsSql, role);
    let mut out = String::new();
    if monitor {
        out.push_str(
            "-- monitor is a server permission, granted to each login rather than to a role:\n",
        );
        for m in members {
            out.push_str(&format!(
                "-- USE [master]; GRANT VIEW SERVER STATE TO {};\n",
                q(m)
            ));
        }
        out.push('\n');
    }
    out.push_str(
        "-- Optional: stop listing every database to every login (affects all of them).\n\
         -- USE [master]; REVOKE VIEW ANY DATABASE FROM public;\n",
    );
    for (db, items) in by_database(targets) {
        out.push_str(&format!("\nUSE {};\n", q(db)));
        out.push_str(&format!(
            "IF DATABASE_PRINCIPAL_ID({literal}) IS NULL CREATE ROLE {r};\n"
        ));
        let mut create = false;
        for (t, verbs) in &items {
            let mut privs: Vec<String> = Vec::new();
            let on = match t {
                Target::Schema(_, s) => {
                    privs.extend(dml(*verbs).into_iter().map(String::from));
                    if verbs.contains(Verbs::DDL) {
                        privs.push("ALTER".into());
                        create = true;
                    }
                    format!("SCHEMA::{}", q(s))
                }
                Target::Relation(_, s, n) => {
                    // No column list for INSERT: SQL Server cannot grant it.
                    privs.extend(relation_privs(t, *verbs, limits, q, false));
                    if verbs.contains(Verbs::DDL) {
                        privs.push("ALTER".into());
                    }
                    format!("{}.{}", q(s), q(n))
                }
                Target::Database(_) => continue,
            };
            if !privs.is_empty() {
                out.push_str(&format!("GRANT {} ON {on} TO {r};\n", privs.join(", ")));
            }
        }
        if create {
            out.push_str(&format!("GRANT CREATE TABLE, CREATE VIEW TO {r};\n"));
        }
        out.push_str("-- Members: replace with each person's database user, then uncomment.\n");
        for m in members {
            out.push_str(&format!("-- ALTER ROLE {r} ADD MEMBER {};\n", q(m)));
        }
    }
    out
}

fn mongo(
    role: &str,
    targets: &BTreeMap<Target, Verbs>,
    monitor: bool,
    members: &[String],
) -> String {
    let js = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    let actions = |verbs: Verbs, whole: bool| {
        let mut a: Vec<&str> = Vec::new();
        if verbs.contains(Verbs::SELECT) {
            a.extend(["find", "listIndexes"]);
            if whole {
                a.push("listCollections");
            }
        }
        if verbs.contains(Verbs::INSERT) {
            a.push("insert");
        }
        if verbs.contains(Verbs::UPDATE) {
            a.push("update");
        }
        if verbs.contains(Verbs::DELETE) {
            a.push("remove");
        }
        if verbs.contains(Verbs::DDL) {
            a.extend([
                "createCollection",
                "dropCollection",
                "createIndex",
                "dropIndex",
                "collMod",
            ]);
        }
        a
    };
    let mut privileges: Vec<String> = Vec::new();
    // Listing collections is a database-level action: a role limited to named
    // collections still needs it to find them (clients pass
    // `authorizedCollections` to see only those).
    let mut list_dbs: BTreeSet<&str> = BTreeSet::new();
    for (t, verbs) in targets {
        let (db, coll, whole) = match t {
            Target::Database(db) => (db.as_str(), "", true),
            Target::Relation(db, _, n) => (db.as_str(), n.as_str(), false),
            Target::Schema(..) => continue,
        };
        if !whole && verbs.contains(Verbs::SELECT) {
            list_dbs.insert(db);
        }
        let a = actions(*verbs, whole);
        if a.is_empty() {
            continue;
        }
        let list = a.iter().map(|x| js(x)).collect::<Vec<_>>().join(", ");
        privileges.push(format!(
            "    {{ resource: {{ db: {}, collection: {} }}, actions: [{list}] }},",
            js(db),
            js(coll)
        ));
    }
    for db in list_dbs {
        privileges.push(format!(
            "    {{ resource: {{ db: {}, collection: \"\" }}, actions: [\"listCollections\"] }},",
            js(db)
        ));
    }
    let roles = if monitor {
        "[{ role: \"clusterMonitor\", db: \"admin\" }]"
    } else {
        "[]"
    };
    let mut out = String::from("db.getSiblingDB(\"admin\").createRole({\n");
    out.push_str(&format!("  role: {},\n", js(role)));
    out.push_str("  privileges: [\n");
    for p in privileges {
        out.push_str(&p);
        out.push('\n');
    }
    out.push_str("  ],\n");
    out.push_str(&format!("  roles: {roles},\n"));
    out.push_str("});\n");
    out.push_str("\n// Members: replace with each person's database user, then uncomment.\n");
    for m in members {
        out.push_str(&format!(
            "// db.getSiblingDB(\"admin\").grantRolesToUser({}, [{{ role: {}, db: \"admin\" }}]);\n",
            js(m),
            js(role)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::model::PolicyDoc;

    fn rules(json: &str) -> PolicyDoc {
        let text = format!(
            r#"{{ "version": 1, "defaultRole": "sales", "roles": {{ "sales": {{ "rules": {json} }} }} }}"#
        );
        PolicyDoc::parse(&text).unwrap().0
    }

    fn rel(db: &str, schema: &str, name: &str) -> Relation {
        Relation {
            database: db.into(),
            schema: schema.into(),
            name: name.into(),
            columns: Vec::new(),
        }
    }

    fn rel_cols(db: &str, schema: &str, name: &str, columns: &[&str]) -> Relation {
        Relation {
            columns: columns.iter().map(|c| c.to_string()).collect(),
            ..rel(db, schema, name)
        }
    }

    /// The customer's case: read `pedidos`, add rows with three columns,
    /// change two.
    const PEDIDOS: &str = r#"[{ "endpoint": "*", "relations": { "allow": ["pedidos"] },
        "human": ["select", "insert", "update"],
        "columns": { "insert": ["cliente", "importe", "estado"], "update": ["estado", "obs*"] } }]"#;

    fn pedidos() -> Vec<Relation> {
        vec![rel_cols(
            "ventas",
            "dbo",
            "pedidos",
            &["id", "cliente", "importe", "estado", "observaciones"],
        )]
    }

    #[test]
    fn column_limits_become_column_lists_on_postgres_and_mysql() {
        let doc = rules(PEDIDOS);
        let pg = build(&input(Engine::Postgres, &doc, pedidos()));
        assert!(
            pg.script.contains(
                r#"GRANT SELECT, INSERT ("cliente", "estado", "importe"), UPDATE ("estado", "observaciones") ON "dbo"."pedidos" TO "huginn_sales";"#
            ),
            "{}",
            pg.script
        );
        let my = build(&input(Engine::Mysql, &doc, pedidos()));
        assert!(
            my.script.contains(
                "GRANT SELECT, INSERT (`cliente`, `estado`, `importe`), UPDATE (`estado`, `observaciones`) ON `ventas`.`pedidos`"
            ),
            "{}",
            my.script
        );
    }

    #[test]
    fn sql_server_limits_update_by_column_and_says_insert_cannot_be() {
        let doc = rules(PEDIDOS);
        let s = build(&input(Engine::MsSql, &doc, pedidos()));
        assert!(
            s.script.contains(
                "GRANT SELECT, INSERT, UPDATE ([estado], [observaciones]) ON [dbo].[pedidos] TO [huginn_sales];"
            ),
            "{}",
            s.script
        );
        assert!(s
            .warnings
            .iter()
            .any(|w| w.contains("INSERT only on a whole table")));
    }

    #[test]
    fn mongodb_grants_whole_collections_and_says_so() {
        let doc = rules(PEDIDOS);
        let s = build(&input(Engine::Mongo, &doc, pedidos()));
        assert!(s.script.contains("\"insert\", \"update\""), "{}", s.script);
        assert!(s
            .warnings
            .iter()
            .any(|w| w.contains("no field-level privileges")));
    }

    #[test]
    fn a_rule_over_everything_with_column_limits_is_expanded() {
        let doc = rules(
            r#"[{ "endpoint": "*", "human": ["select", "update"], "columns": { "update": ["estado"] } }]"#,
        );
        let s = build(&input(
            Engine::Postgres,
            &doc,
            vec![
                rel_cols("ventas", "dbo", "pedidos", &["id", "estado"]),
                rel_cols("ventas", "dbo", "clientes", &["id", "nombre"]),
            ],
        ));
        assert!(!s.script.contains("ALL TABLES IN SCHEMA"), "{}", s.script);
        assert!(s
            .script
            .contains(r#"GRANT SELECT, UPDATE ("estado") ON "dbo"."pedidos""#));
        // No column of `clientes` matches: it is read-only, not wide open.
        assert!(s
            .script
            .contains(r#"GRANT SELECT ON "dbo"."clientes" TO "huginn_sales";"#));
        assert!(s
            .warnings
            .iter()
            .any(|w| w.contains("matches no column of dbo.clientes")));
        assert!(s.warnings.iter().any(|w| w.contains("exist today")));
    }

    #[test]
    fn a_rule_without_a_column_limit_wins_on_the_same_table() {
        let doc = rules(
            r#"[{ "endpoint": "*", "human": ["update"], "columns": { "update": ["estado"] } },
                { "endpoint": "*", "relations": { "allow": ["pedidos"] }, "human": ["update"] }]"#,
        );
        let s = build(&input(Engine::Postgres, &doc, pedidos()));
        assert!(
            s.script
                .contains(r#"GRANT UPDATE ON "dbo"."pedidos" TO "huginn_sales";"#),
            "{}",
            s.script
        );
    }

    fn input<'a>(engine: Engine, doc: &'a PolicyDoc, relations: Vec<Relation>) -> GrantInput<'a> {
        let mut databases: Vec<String> = relations.iter().map(|r| r.database.clone()).collect();
        databases.sort();
        databases.dedup();
        GrantInput {
            engine,
            role: "sales",
            rules: doc.roles["sales"].rules.iter().collect(),
            databases,
            relations,
            members: vec!["alopez".into()],
            server: "erp.local:5432".into(),
            source: "test".into(),
            generated_at: "2026-09-24T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_rule_over_named_tables_grants_each_one_and_honours_deny() {
        let doc = rules(
            r#"[{ "endpoint": "*", "databases": ["billing"],
                  "relations": { "allow": ["invoice*"], "deny": ["invoice_cards"] },
                  "human": ["select", "insert"] }]"#,
        );
        let s = build(&input(
            Engine::Postgres,
            &doc,
            vec![
                rel("billing", "public", "invoices"),
                rel("billing", "public", "invoice_cards"),
                rel("billing", "public", "payroll"),
                rel("hr", "public", "invoices"),
            ],
        ));
        assert!(s
            .script
            .contains(r#"GRANT SELECT, INSERT ON "public"."invoices" TO "huginn_sales";"#));
        assert!(!s.script.contains("invoice_cards\" TO"), "{}", s.script);
        assert!(!s.script.contains("payroll"));
        assert!(
            !s.script.contains(r#"DATABASE "hr""#),
            "the rule names billing only"
        );
        assert!(s.script.contains(r#"-- GRANT "huginn_sales" TO "alopez";"#));
        assert!(s.warnings.iter().any(|w| w.contains("exist today")));
    }

    #[test]
    fn a_rule_over_everything_grants_at_the_schema_level() {
        let doc = rules(r#"[{ "endpoint": "*", "human": ["select", "ddl", "monitor"] }]"#);
        let s = build(&input(
            Engine::Postgres,
            &doc,
            vec![rel("billing", "public", "a"), rel("billing", "sales", "b")],
        ));
        assert!(s
            .script
            .contains(r#"GRANT SELECT ON ALL TABLES IN SCHEMA "sales" TO "huginn_sales";"#));
        assert!(s
            .script
            .contains("ALTER DEFAULT PRIVILEGES IN SCHEMA \"public\""));
        assert!(s.script.contains(r#"GRANT CREATE ON SCHEMA "public""#));
        assert!(s.script.contains("GRANT pg_monitor"));
        assert!(!s.warnings.iter().any(|w| w.contains("exist today")));
    }

    #[test]
    fn mysql_grants_on_the_database_and_names_members_with_a_host() {
        let doc = rules(
            r#"[{ "endpoint": "*", "databases": ["billing"], "human": ["select", "update"] },
               { "endpoint": "*", "databases": ["billing"], "relations": { "allow": ["invoices"] },
                 "human": ["delete"] }]"#,
        );
        let s = build(&input(
            Engine::Mysql,
            &doc,
            vec![
                rel("billing", "billing", "invoices"),
                rel("billing", "billing", "cards"),
            ],
        ));
        assert!(s
            .script
            .contains("CREATE ROLE IF NOT EXISTS 'huginn_sales';"));
        assert!(s
            .script
            .contains("GRANT SELECT, UPDATE ON `billing`.* TO 'huginn_sales';"));
        assert!(s
            .script
            .contains("GRANT DELETE ON `billing`.`invoices` TO 'huginn_sales';"));
        assert!(s
            .script
            .contains("-- GRANT 'huginn_sales' TO 'alopez'@'%';"));
    }

    #[test]
    fn sql_server_creates_the_role_in_each_database() {
        let doc = rules(
            r#"[{ "endpoint": "*", "relations": { "allow": ["dbo.orders"] }, "human": ["select"] }]"#,
        );
        let s = build(&input(
            Engine::MsSql,
            &doc,
            vec![rel("erp", "dbo", "orders"), rel("erp", "dbo", "salaries")],
        ));
        assert!(s.script.contains("USE [erp];"));
        assert!(s.script.contains(
            "IF DATABASE_PRINCIPAL_ID('huginn_sales') IS NULL CREATE ROLE [huginn_sales];"
        ));
        assert!(s
            .script
            .contains("GRANT SELECT ON [dbo].[orders] TO [huginn_sales];"));
        assert!(!s.script.contains("salaries"));
        assert!(s
            .script
            .contains("-- USE [master]; REVOKE VIEW ANY DATABASE FROM public;"));
    }

    #[test]
    fn mongo_writes_a_create_role_with_actions_per_collection() {
        let doc = rules(
            r#"[{ "endpoint": "*", "databases": ["shop"], "relations": { "allow": ["orders"] },
                 "human": ["select", "delete", "monitor"] }]"#,
        );
        let s = build(&input(
            Engine::Mongo,
            &doc,
            vec![rel("shop", "shop", "orders"), rel("shop", "shop", "users")],
        ));
        assert_eq!(s.language, "javascript");
        assert!(s.script.contains(
            r#"{ resource: { db: "shop", collection: "orders" }, actions: ["find", "listIndexes", "remove"] },"#
        ));
        assert!(s.script.contains(
            r#"{ resource: { db: "shop", collection: "" }, actions: ["listCollections"] },"#
        ));
        assert!(!s.script.contains("\"users\""));
        assert!(s
            .script
            .contains(r#"roles: [{ role: "clusterMonitor", db: "admin" }],"#));
        assert!(s.script.starts_with("// HuginnDB"));
    }

    #[test]
    fn names_that_need_quoting_are_quoted_per_engine() {
        let doc =
            rules(r#"[{ "endpoint": "*", "relations": { "allow": ["*"] }, "human": ["select"] }]"#);
        let pg = build(&input(
            Engine::Postgres,
            &doc,
            vec![rel("b", "we\"ird", "t\"x")],
        ));
        assert!(
            pg.script.contains(r#"ON "we""ird"."t""x" TO"#),
            "{}",
            pg.script
        );
        let my = build(&input(Engine::Mysql, &doc, vec![rel("b`d", "b`d", "t`x")]));
        assert!(my.script.contains("ON `b``d`.`t``x` TO"), "{}", my.script);
        let ms = build(&input(Engine::MsSql, &doc, vec![rel("b", "s]x", "t")]));
        assert!(ms.script.contains("ON [s]]x].[t] TO"), "{}", ms.script);
        assert_eq!(
            role_name("Ventas y Facturación"),
            "huginn_ventas_y_facturaci_n"
        );
    }

    #[test]
    fn a_role_with_no_rule_for_the_server_says_so() {
        let doc = rules(r#"[]"#);
        let s = build(&input(Engine::Mysql, &doc, vec![rel("b", "b", "t")]));
        assert!(s.script.contains("has no rule for this server"));
        assert!(!s.script.contains("GRANT"));
    }

    #[test]
    fn members_are_the_users_of_the_role_as_they_sign_in() {
        let (doc, _) = PolicyDoc::parse(
            r#"{ "version": 1, "defaultRole": "none",
                 "users": { "ACME\\Ana": "sales", "bob": "sales", "carl": "none" },
                 "roles": { "none": {}, "sales": { "rules": [
                     { "endpoint": { "host": "erp.local" }, "dbUser": "erp_{user}" }
                 ] } } }"#,
        )
        .unwrap();
        let erp = ConnectionProfile {
            driver: crate::state::Driver::Mysql,
            host: "erp.local".into(),
            ..crate::testkit::profile("erp")
        };
        let rules = rules_for(&doc, "sales", &erp).unwrap();
        assert_eq!(members(&doc, "sales", &rules), ["erp_ana", "erp_bob"]);
        // Without a `dbUser`, the bare account.
        assert_eq!(members(&doc, "sales", &[]), ["ana", "bob"]);
        assert!(rules_for(&doc, "nope", &erp).is_none());
    }
}
