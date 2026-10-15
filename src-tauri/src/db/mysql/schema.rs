//! MySQL catalog introspection. See [`crate::db::postgres::schema`] for the
//! module's contract.

use sqlx::MySqlPool;

use crate::commands::schema::{ColumnInfo, IndexInfo, PrivilegeInfo, TableInfo, UserInfo};
use crate::commands::schema::{DatabaseInfo, DatabaseSize};
use crate::db::sql::Dialect;
use crate::error::AppResult;
use sqlx::Row;

/// Schemas on the server, MySQL's own system schemas excluded.
///
/// MySQL has no database/schema distinction: `information_schema.schemata` is
/// the list, and the four names filtered out are the server's own.
pub async fn list_databases(pool: &MySqlPool) -> AppResult<Vec<DatabaseInfo>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema', 'performance_schema', \
                                   'mysql', 'sys') \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await?;
    Ok(names
        .into_iter()
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// On-disk size per schema, summed from `information_schema`.
///
/// A `LEFT JOIN` from `schemata` rather than a `GROUP BY` over `tables`, so a
/// schema the login can see but whose tables it cannot still appears — with a
/// `NULL` size rather than being missing from the list entirely.
///
/// **`NULL` is reported as `None`, never `0`.** Two different situations
/// produce it and neither means "empty": a schema with no tables, and — the
/// one confirmed in the field, against a MariaDB 11.4 with a low-privilege
/// login — a schema with 31 tables whose `DATA_LENGTH` the login may not read.
/// Rendering either as `0` would tell the user their data is gone.
///
/// This measures `DATA_LENGTH + INDEX_LENGTH`, so unlike Postgres it does
/// **not** include free space (`DATA_FREE` is a separate column, deliberately
/// left out), and for a compressed row format it is the compressed size.
///
/// There is no eager fallback to `SHOW TABLE STATUS` when the aggregate comes
/// back `NULL`: that is one expensive statement per database, on the path the
/// user has just opened.
pub async fn database_sizes(pool: &MySqlPool) -> AppResult<Vec<DatabaseSize>> {
    let rows = sqlx::query(
        "SELECT s.schema_name AS name, \
                CAST(SUM(t.data_length + t.index_length) AS UNSIGNED) AS size_bytes \
         FROM information_schema.schemata s \
         LEFT JOIN information_schema.tables t \
                ON t.table_schema = s.schema_name \
         WHERE s.schema_name NOT IN ('information_schema', 'performance_schema', \
                                     'mysql', 'sys') \
         GROUP BY s.schema_name \
         ORDER BY s.schema_name",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| DatabaseSize {
            name: r.get::<String, _>("name"),
            // `CAST(... AS UNSIGNED)` in the statement, not a decode here:
            // `SUM` over `BIGINT UNSIGNED` columns yields `NEWDECIMAL`, which
            // sqlx will not hand out as an integer at all (gotcha #15's family
            // of width- and type-specific decodes). The cast makes it a plain
            // `BIGINT UNSIGNED`, and `CAST(NULL AS UNSIGNED)` stays `NULL`.
            //
            // `try_get` rather than `get`: `get` panics on a decode surprise,
            // and a best-effort badge must never take the call down with it.
            size_bytes: r.try_get::<Option<u64>, _>("size_bytes").ok().flatten(),
        })
        .collect())
}

/// Engine and version, as `mysql <version>`.
///
/// `VERSION()` carries a distro/build suffix (`8.0.36-0ubuntu0.22.04.1`) that
/// says nothing useful in a status bar, so everything from the first `-` is
/// dropped.
pub async fn server_version(pool: &MySqlPool) -> AppResult<String> {
    let raw: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(pool)
        .await?;
    let ver = raw.split('-').next().unwrap_or(&raw);
    Ok(format!("mysql {ver}"))
}

/// The connection's current database, or `None` when the profile named none.
///
/// Resolved from the connection (set via the URL when the pool was opened).
/// With no default database `DATABASE()` is NULL and there is nothing to
/// enumerate — the user needs to specify a database in the connection profile.
async fn current_database(p: &sqlx::MySqlPool) -> AppResult<Option<String>> {
    let db_name: Option<String> = sqlx::query_scalar("SELECT DATABASE()").fetch_one(p).await?;
    Ok(db_name.filter(|d| !d.is_empty()))
}

/// A `SHOW` statement's text column by position, tolerating the binary
/// collation some MySQL/MariaDB builds report for it (see
/// [`show_create_table`]).
fn show_text(r: &sqlx::mysql::MySqlRow, idx: usize) -> String {
    r.try_get::<String, _>(idx)
        .or_else(|_| {
            r.try_get::<Vec<u8>, _>(idx)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
        })
        .unwrap_or_default()
}

/// Tables and views in the connection's current database, **names only** —
/// what the schema tree draws from.
///
/// `SHOW FULL TABLES` reads the data dictionary and nothing else: it neither
/// opens the tables nor computes statistics, which is exactly the part of
/// `SHOW TABLE STATUS` that grows with the table count (on 5.7, where nothing
/// caches it, the status of every table is gathered on every call). The
/// figures are [`table_stats`]' job and arrive afterwards.
///
/// The first column is named `Tables_in_<db>`, so both are read by position.
/// `Table_type` is `BASE TABLE`, `VIEW` or `SYSTEM VIEW`.
pub async fn list_table_names(p: &sqlx::MySqlPool) -> AppResult<Vec<TableInfo>> {
    let Some(db) = current_database(p).await? else {
        return Ok(vec![]);
    };
    let q = format!("SHOW FULL TABLES FROM {}", Dialect::Mysql.quote_ident(&db));
    let rows = sqlx::query(&q).fetch_all(p).await?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: db.clone(),
            name: show_text(r, 0),
            kind: if show_text(r, 1).ends_with("VIEW") {
                "view".into()
            } else {
                "table".into()
            },
            row_count: None,
            size_bytes: None,
        })
        .collect())
}

/// Row-count and size estimates from `SHOW TABLE STATUS`, for the tree to fold
/// into [`list_table_names`]' answer by `(schema, name)`.
pub async fn table_stats(p: &sqlx::MySqlPool) -> AppResult<Vec<TableInfo>> {
    Ok({
        let Some(db) = current_database(p).await? else {
            return Ok(vec![]);
        };

        // SHOW TABLE STATUS is significantly faster than querying
        // information_schema.TABLES and, critically, does not block on
        // InnoDB metadata locks the way information_schema can. On busy
        // servers a DDL statement or long-running transaction can cause
        // information_schema.TABLES to wait indefinitely, leaving the
        // schema explorer stuck in a loading state forever.
        //
        // Engine is NULL for views in SHOW TABLE STATUS output; that is
        // how we distinguish views from base tables without needing the
        // table_type column from information_schema.
        //
        // The database name is quoted with backtick-escaping. It comes
        // from DATABASE() (server-side catalog), not user input, so the
        // quoting is a safety measure rather than a SQL-injection guard.
        let q = format!("SHOW TABLE STATUS FROM {}", Dialect::Mysql.quote_ident(&db));
        let rows = sqlx::query(&q).fetch_all(p).await?;

        // try_get is used throughout instead of get. sqlx's get() panics
        // when the Rust type does not match the column's type-flag reported
        // by the server (e.g. UNSIGNED vs signed BIGINT). Different MySQL
        // versions and forks disagree on whether SHOW TABLE STATUS columns
        // carry the UNSIGNED flag. try_get returns Err instead of panicking;
        // a panic in an async Tauri command causes the IPC promise to hang
        // rather than reject, which is why the schema explorer appeared
        // stuck. The fallback chain u64 → i64 → 0 handles all variants.
        let try_u64 = |r: &sqlx::mysql::MySqlRow, col: &str| -> u64 {
            r.try_get::<u64, _>(col)
                .or_else(|_| r.try_get::<i64, _>(col).map(|v| v.unsigned_abs()))
                .unwrap_or(0)
        };

        rows.into_iter()
            .map(|r| {
                let name: String = r.try_get("Name").unwrap_or_default();
                // Engine is NULL for views; all base tables have a non-NULL engine.
                let is_view = r
                    .try_get::<Option<String>, _>("Engine")
                    .ok()
                    .flatten()
                    .is_none();
                let data_len = try_u64(&r, "Data_length");
                let idx_len = try_u64(&r, "Index_length");
                TableInfo {
                    schema: db.clone(),
                    name,
                    kind: if is_view {
                        "view".into()
                    } else {
                        "table".into()
                    },
                    row_count: r
                        .try_get::<u64, _>("Rows")
                        .or_else(|_| r.try_get::<i64, _>("Rows").map(|v| v.unsigned_abs()))
                        .ok(),
                    size_bytes: if is_view {
                        None
                    } else {
                        Some(data_len + idx_len)
                    },
                }
            })
            .collect()
    })
}

/// A table's columns, with primary-key and single-column foreign-key flags.
pub async fn list_columns(
    p: &sqlx::MySqlPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    Ok({
        let schema_arg = schema.unwrap_or_default();
        let rows = sqlx::query(
            "SELECT column_name, column_type, is_nullable, column_key \
             FROM information_schema.columns \
             WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
               AND table_name = ? \
             ORDER BY ordinal_position",
        )
        .bind(&schema_arg)
        .bind(&table)
        .fetch_all(p)
        .await?;
        // Separate query for FK metadata. Filtered to single-column FKs
        // via a constraint-name lookup with COUNT(*) = 1.
        let fk_rows = sqlx::query(
            "SELECT k.column_name, \
                    k.referenced_table_schema AS ref_schema, \
                    k.referenced_table_name   AS ref_table, \
                    k.referenced_column_name  AS ref_column \
             FROM information_schema.key_column_usage k \
             WHERE k.table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
               AND k.table_name = ? \
               AND k.referenced_table_name IS NOT NULL \
               AND k.ordinal_position = 1 \
               AND k.constraint_name IN ( \
                   SELECT constraint_name FROM information_schema.key_column_usage \
                   WHERE table_schema = k.table_schema \
                     AND table_name = k.table_name \
                     AND referenced_table_name IS NOT NULL \
                   GROUP BY constraint_name HAVING COUNT(*) = 1 \
               )",
        )
        .bind(&schema_arg)
        .bind(&table)
        .fetch_all(p)
        .await?;
        use std::collections::HashMap;
        // Referenced (schema, table, column) for one column. Every part is
        // optional because `information_schema` reports NULL for a target
        // it cannot resolve (cross-database, or insufficient privileges).
        type FkTarget = (Option<String>, Option<String>, Option<String>);
        let mut fk_map: HashMap<String, FkTarget> = HashMap::new();
        for r in fk_rows {
            fk_map.insert(
                r.get::<String, _>("column_name"),
                (
                    r.get::<Option<String>, _>("ref_schema"),
                    r.get::<Option<String>, _>("ref_table"),
                    r.get::<Option<String>, _>("ref_column"),
                ),
            );
        }
        rows.into_iter()
            .map(|r| {
                let name: String = r.get("column_name");
                let (ref_schema, ref_table, ref_column) =
                    fk_map.get(&name).cloned().unwrap_or((None, None, None));
                ColumnInfo {
                    name,
                    data_type: r.get::<String, _>("column_type"),
                    nullable: r.get::<String, _>("is_nullable") == "YES",
                    is_primary_key: r.get::<String, _>("column_key") == "PRI",
                    referenced_schema: ref_schema,
                    referenced_table: ref_table,
                    referenced_column: ref_column,
                }
            })
            .collect()
    })
}

/// A table's indexes and the columns each covers.
pub async fn list_indexes(
    p: &sqlx::MySqlPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    Ok({
        let rows = sqlx::query(
            "SELECT index_name, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
               AND table_name = ? \
             ORDER BY index_name, seq_in_index",
        )
        .bind(schema.unwrap_or_default())
        .bind(&table)
        .fetch_all(p)
        .await?;
        use std::collections::BTreeMap;
        let mut grouped: BTreeMap<String, (Vec<String>, bool)> = BTreeMap::new();
        for r in rows {
            let name: String = r.get("index_name");
            let col: String = r.get("column_name");
            let non_unique: i64 = r.get("non_unique");
            let entry = grouped
                .entry(name)
                .or_insert_with(|| (Vec::new(), non_unique == 0));
            entry.0.push(col);
        }
        grouped
            .into_iter()
            .map(|(name, (cols, unique))| IndexInfo {
                name,
                columns: cols,
                unique,
            })
            .collect()
    })
}

/// Server-side accounts (`user@host`), with their granted roles.
pub async fn list_users(p: &sqlx::MySqlPool) -> AppResult<Vec<UserInfo>> {
    Ok({
        // mysql.user requires a global SELECT privilege the connected
        // account may not have; fall back to reporting just the current
        // user (via CURRENT_USER(), always readable) rather than
        // failing the whole panel.
        let rows_res = sqlx::query(
            "SELECT User, Host, Super_priv, account_locked FROM mysql.user \
             ORDER BY User, Host",
        )
        .fetch_all(p)
        .await;
        match rows_res {
            Ok(rows) => {
                // MySQL 8 roles: mysql.role_edges lists (from_user/host)
                // granted TO (to_user/host). Best-effort — absent on
                // MySQL 5.7 / MariaDB, where the query simply errors and
                // we leave every `roles` list empty.
                let mut role_map: std::collections::HashMap<(String, String), Vec<String>> =
                    std::collections::HashMap::new();
                if let Ok(edges) =
                    sqlx::query("SELECT TO_USER, TO_HOST, FROM_USER FROM mysql.role_edges")
                        .fetch_all(p)
                        .await
                {
                    for e in edges {
                        let key = (e.get::<String, _>("TO_USER"), e.get::<String, _>("TO_HOST"));
                        role_map
                            .entry(key)
                            .or_default()
                            .push(e.get::<String, _>("FROM_USER"));
                    }
                }
                rows.into_iter()
                    .map(|r| {
                        let user: String = r.get("User");
                        let host: String = r.get("Host");
                        let can_login = r
                            .try_get::<String, _>("account_locked")
                            .map(|v| v != "Y")
                            .unwrap_or(true);
                        let roles = role_map
                            .get(&(user.clone(), host.clone()))
                            .cloned()
                            .unwrap_or_default();
                        UserInfo {
                            name: format!("{user}@{host}"),
                            is_superuser: r.get::<String, _>("Super_priv") == "Y",
                            can_login,
                            roles,
                        }
                    })
                    .collect()
            }
            Err(_) => {
                let current: String = sqlx::query_scalar("SELECT CURRENT_USER()")
                    .fetch_one(p)
                    .await?;
                vec![UserInfo {
                    name: current,
                    is_superuser: false,
                    can_login: true,
                    roles: vec![],
                }]
            }
        }
    })
}

/// Privileges granted to `user`, parsed out of `SHOW GRANTS`.
pub async fn list_privileges(p: &sqlx::MySqlPool, user: String) -> AppResult<Vec<PrivilegeInfo>> {
    Ok({
        // `user` is "user@host" as produced by list_users. SHOW GRANTS
        // requires the literal pair, quoted as MySQL string literals —
        // not identifiers, so identifier quoting does not apply here. The
        // source is always a catalog lookup (mysql.user), never
        // free-form input, but quotes are still escaped defensively.
        let (name, host) = user.rsplit_once('@').unwrap_or((user.as_str(), "%"));
        let q = format!(
            "SHOW GRANTS FOR '{}'@'{}'",
            name.replace('\'', "''"),
            host.replace('\'', "''"),
        );
        let rows = sqlx::query(&q).fetch_all(p).await?;
        let mut out = Vec::new();
        for r in rows {
            // SHOW GRANTS returns one text column whose name is
            // "Grants for <user>@<host>" — read positionally instead.
            let line: String = r.try_get(0).unwrap_or_default();
            out.extend(parse_mysql_grant(&line));
        }
        out
    })
}

/// Parse one `SHOW GRANTS FOR ...` line into individual [`PrivilegeInfo`]
/// rows.
///
/// Handles the common shapes: `GRANT <privs> ON <db>.<table> TO ...`,
/// `... ON *.*`, `... ON \`db\`.*`, and the `GRANT PROXY ON ...` special
/// case (whose "target" is a user, not a schema/table). Anything that
/// doesn't match the expected `GRANT ... ON ... TO ...` shape is skipped
/// rather than mis-parsed.
fn parse_mysql_grant(line: &str) -> Vec<PrivilegeInfo> {
    let Some(rest) = line.strip_prefix("GRANT ") else {
        return vec![];
    };
    let Some(on_idx) = rest.find(" ON ") else {
        return vec![];
    };
    let privileges_part = &rest[..on_idx];
    let after_on = &rest[on_idx + 4..];
    let Some(to_idx) = after_on.rfind(" TO ") else {
        return vec![];
    };
    let target_part = after_on[..to_idx].trim();

    let (schema, table) = if privileges_part.trim() == "PROXY" {
        (None, None)
    } else {
        let cleaned = target_part.replace('`', "");
        match cleaned.split_once('.') {
            Some((db, tbl)) => (
                (db != "*").then(|| db.to_string()),
                (tbl != "*").then(|| tbl.to_string()),
            ),
            None => (None, None),
        }
    };

    split_mysql_privilege_list(privileges_part)
        .into_iter()
        .map(|privilege| PrivilegeInfo {
            privilege,
            schema: schema.clone(),
            table: table.clone(),
        })
        .collect()
}

/// Split a comma-separated privilege list, ignoring commas inside a
/// column-list suffix like `SELECT (col1, col2)`.
fn split_mysql_privilege_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = cur.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let trimmed = cur.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`. See
/// [`crate::db::postgres::schema::view_definition`] for why a missing view is
/// `Ok(None)` rather than an error.
///
/// An empty `schema` falls back to the session's current database, the same
/// `COALESCE(NULLIF(?, ''), DATABASE())` shape the rest of this module uses —
/// so a connection with no database bound gets NULL and matches nothing, rather
/// than searching every schema on the server.
pub async fn view_definition(
    p: &sqlx::MySqlPool,
    schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let def: Option<String> = sqlx::query_scalar(
        "SELECT VIEW_DEFINITION FROM information_schema.views \
         WHERE TABLE_SCHEMA = COALESCE(NULLIF(?, ''), DATABASE()) AND TABLE_NAME = ?",
    )
    .bind(schema.unwrap_or_default())
    .bind(view)
    .fetch_optional(p)
    .await?;
    Ok(def.map(|q| q.trim().to_string()))
}

/// The server's own `CREATE TABLE` for `schema.table`, exactly as
/// `SHOW CREATE TABLE` prints it — engine, charset, collation, comments,
/// partitions and all.
///
/// Verbatim rather than rebuilt from [`crate::db::ddl::build_create`]: that
/// builder only knows what `TableStructure` carries, so it would silently drop
/// the table options, `CHECK`s and generated columns, and a "ready to copy"
/// statement that is quietly incomplete is worse than none.
///
/// Column 1 is read as text with a byte fallback. The name column is plain
/// `VARCHAR`, but some MySQL/MariaDB builds report the statement column with a
/// binary collation, and sqlx refuses to decode that as `String` (the same
/// family of surprise as gotcha #17).
pub async fn show_create_table(
    p: &sqlx::MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<String> {
    let qt = Dialect::Mysql.qualify_defaulted(schema, table);
    let row = sqlx::query(&format!("SHOW CREATE TABLE {qt}"))
        .fetch_one(p)
        .await?;
    let ddl = row.try_get::<String, _>(1).or_else(|_| {
        row.try_get::<Vec<u8>, _>(1)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    })?;
    Ok(format!("{};", ddl.trim_end()))
}

/// Foreign keys on other tables that reference `schema.table`, for the drop
/// dialog. See [`crate::commands::schema::list_referencing_foreign_keys`].
///
/// Reads `key_column_usage` from the referenced side — the same view
/// `commands::structure::mysql_structure` reads from the owning side. The
/// referencing table may live in another schema, so its `table_schema` is
/// returned rather than assumed. Self-references are filtered in SQL.
pub async fn referencing_fks(
    p: &sqlx::MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<crate::commands::schema::IncomingForeignKey>> {
    let rows = sqlx::query(
        "SELECT k.table_schema AS s, k.table_name AS t, \
                k.constraint_name AS c, k.column_name AS col \
         FROM information_schema.key_column_usage k \
         WHERE k.referenced_table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
           AND k.referenced_table_name = ? \
           AND NOT (k.table_schema = k.referenced_table_schema \
                    AND k.table_name = k.referenced_table_name) \
         ORDER BY k.table_schema, k.table_name, k.constraint_name, k.ordinal_position",
    )
    .bind(schema.unwrap_or_default())
    .bind(table)
    .fetch_all(p)
    .await?;
    Ok(crate::commands::schema::group_incoming_fks(
        rows.iter().map(|r| {
            (
                Some(r.get::<String, _>("s")),
                r.get::<String, _>("t"),
                r.get::<String, _>("c"),
                r.get::<String, _>("col"),
            )
        }),
    ))
}
