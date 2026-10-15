---
id: 98
type: adr
status: accepted
date: 2026-09-24
tags: [policy, security]
triggered_by_external_trap: false
related: [97]
supersedes: []
superseded_by: null
amends: []
---

# ADR #98: A role's grants are built by a pure function from the live catalog, expand every pattern, and are never run by HuginnDB

This is the second half of managed policy phase 3. A database user per person (ADR #97) only enforces the policy if its grants match the role. `policy::grants::build` writes those grants, and `policy_generate_grants` reads the catalog the build needs.

**Decision:** policy::grants::build is a pure function over rules, unfiltered live catalog and members, reusing enforcement's matching, expanding non-trivial rules to existing relations, and producing a script that is only copied or saved, never run.

**Alternatives rejected:**

- Reading the catalog through person-filtered listings — rejected because it would drop exactly the relations the role is about.
- Using schema/database-level grants for rules with allow/deny lists — not possible because GRANT takes no glob and a deny cannot be subtracted from a schema grant.
- Executing the generated script from the app — deliberately not offered; no execute path exists.

## Detail

- **Pure build, separate read.** `grants::build(GrantInput)` takes the role's rules for the endpoint, the catalog (databases, and relations with their database and schema), the members, and the header facts. It returns the script. No I/O happens, so every engine is table-tested. `policy_generate_grants`:
  - requires `monitor` (`guard::monitor`, categorised `monitor` in `HUMAN_POLICY`) and an active policy;
  - lists the databases through `list_databases_inner` and keeps those a rule reaches (`wants_database`);
  - opens each one's `::db::` view with `ensure_view`, because PG, MySQL and MSSQL list only the bound database, and reads it with `list_tables_inner`.

  The `_inner` cores are **unfiltered on purpose**. The grants must cover everything the rules name, and the connection is the administrator's own. A person-filtered listing would drop exactly the relations the role is about.
- **The same matching as enforcement.** The build calls `resolve::database_matches` and `relation_allowed`, made `pub(super)` for this, and `endpoint_matches`. The grants therefore cannot describe a different role from the one the app enforces. The schema passed for a relation is the one the pattern is written against, so on MySQL and MongoDB it is the database, as in `Ctx::database_for`.
- **When a rule is expanded.** A rule with no `relations.allow` and no `deny` grants at the database level (MySQL `db.*`, Mongo `collection: ""`) or the schema level (PG `ALL TABLES IN SCHEMA` plus `ALTER DEFAULT PRIVILEGES`, MSSQL `ON SCHEMA::`). Those grants cover tables created later. Any other rule is expanded to the relations that exist now:
  - a `GRANT` takes no glob;
  - a `deny` cannot be subtracted from a schema grant.

  The script then warns that it has to be regenerated. `glob_matches` ignores case, so on a case-sensitive Postgres one pattern can grant two tables. That is the same answer enforcement gives.
- **Rules add up per object** (`add` ORs the verbs). Each engine spells `ddl` and `monitor` its own way:

  | Engine | `ddl` | `monitor` |
  |---|---|---|
  | PG | `CREATE` on the schema | `pg_monitor` |
  | MySQL | `CREATE, ALTER, DROP, INDEX, CREATE VIEW` on `db.*`, or `ALTER, DROP, INDEX` on a table | `PROCESS` |
  | MSSQL | `ALTER` on the schema, plus `CREATE TABLE, CREATE VIEW` | `VIEW SERVER STATE`, per login in `master` (commented, since it cannot go to a database role) |
  | Mongo | `createCollection`, `dropCollection`, `createIndex`, `dropIndex`, `collMod` | the `clusterMonitor` role |

  Mongo's `select` is `find` plus `listIndexes`. A role limited to named collections also gets `listCollections` on the database, without which it cannot find them. `export` has no database equivalent, and the script says so.
- **What the script says.** Notes list what the engine cannot hide:
  - PG shows every relation name in `pg_catalog`;
  - MSSQL lists every database unless `VIEW ANY DATABASE` is revoked from `public` (offered commented, since it affects every login);
  - MySQL roles need 8.0 or MariaDB 10.0.5;
  - PG only lets an object's owner alter it, so `ddl` means `CREATE`.

  A role with no rule for the server, or rules that reach nothing that exists, gets a script that says so instead of an empty one.
- **Members are commented, and named as people sign in.** `grants::members` takes the users the document gives the role by name. If one of the endpoint's rules carries a `dbUser`, it expands that template for each of them (the same user `credentials::effective_profile` would pick); otherwise it uses the bare account. `defaultRole` users are not named anywhere, so they cannot be listed. The lines stay commented because the database account names are the administrator's to confirm.
- **Quoting** goes through `Dialect::quote_ident` for identifiers and `quote_text_literal` for MySQL role and user literals. Mongo names go through `serde_json::to_string`. The role name is `huginn_<role>`, folded to `[a-z0-9_]`.
- **Never run.** There is no execute path: the dialog offers Copy and Save (`.sql`, or `.js` for Mongo), and the header says to review the script and run it as an administrator. `PolicyStatus.roles` lists every role and its named members for the dialog's picker. That is nothing more than the policy file already shows to whoever can read it.
