//! PostgreSQL catalog introspection.
//!
//! Result shapes mirror [`crate::commands::schema`]'s DTOs exactly, the same
//! convention [`crate::db::mssql::schema`] and [`crate::db::mongo::schema`]
//! already follow: the DTOs are the IPC contract and live with the commands
//! that serialise them, while the SQL that fills them lives with its driver.
//!
//! Every function here takes an already-opened `PgPool`. Resolving a connection
//! id to a pool, and dispatching to the right driver, stays in
//! `commands::schema` — this module never sees an `AppState`.

use sqlx::PgPool;

use crate::commands::schema::{ColumnInfo, IndexInfo, PrivilegeInfo, TableInfo, UserInfo};
use crate::commands::schema::{DatabaseInfo, DatabaseSize};
use crate::error::AppResult;
use sqlx::Row;

/// Databases on the server, template databases excluded.
pub async fn list_databases(pool: &PgPool) -> AppResult<Vec<DatabaseInfo>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT datname FROM pg_database \
         WHERE datistemplate = false \
         ORDER BY datname",
    )
    .fetch_all(pool)
    .await?;
    Ok(names
        .into_iter()
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// On-disk size per database.
///
/// **`pg_database_size` is not a catalog read.** It is
/// `calculate_database_size()`, which walks the database's directory calling
/// `stat` on every file, so this is measured in seconds on a large server —
/// the reason the sizes are a deferred command rather than part of
/// [`list_databases`]. It counts everything in the directory, free space
/// included.
///
/// The `CASE` is what makes the failure per-row. `pg_database_size` raises
/// `permission denied` for a database the login cannot `CONNECT` to, and one
/// raise aborts the whole statement — so without the guard, a single
/// inaccessible database on a shared server costs every other database its
/// size. With it, that database alone answers `NULL`.
pub async fn database_sizes(pool: &PgPool) -> AppResult<Vec<DatabaseSize>> {
    let rows = sqlx::query(
        "SELECT datname, \
                CASE WHEN has_database_privilege(datname, 'CONNECT') \
                     THEN pg_database_size(oid) END AS size_bytes \
         FROM pg_database \
         WHERE datistemplate = false \
         ORDER BY datname",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| DatabaseSize {
            name: r.get::<String, _>("datname"),
            size_bytes: r
                .get::<Option<i64>, _>("size_bytes")
                .and_then(|n| u64::try_from(n).ok()),
        })
        .collect())
}

/// Engine and version, as `postgresql <version>`.
///
/// `version()` returns something like `PostgreSQL 16.2 on x86_64-pc-linux-gnu,
/// compiled by gcc ...`; the status bar wants the first two tokens.
pub async fn server_version(pool: &PgPool) -> AppResult<String> {
    let raw: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(pool)
        .await?;
    Ok(raw
        .splitn(3, ' ')
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase())
}

/// Tables and views in every non-system schema, **names only** — what the
/// schema tree draws from.
///
/// `information_schema.tables` on purpose rather than `pg_class`: it applies
/// the visibility rule the tree has always had (a relation the role holds no
/// privilege on is not listed) without this file restating it. The figures
/// that used to ride along — `pg_total_relation_size`, which `stat`s every
/// file of every relation — are [`table_stats`]' job, so ten thousand tables
/// no longer means ten thousand trips to the filesystem before the first name
/// is drawn.
pub async fn list_table_names(p: &sqlx::PgPool) -> AppResult<Vec<TableInfo>> {
    let rows = sqlx::query(
        "SELECT table_schema, table_name, table_type \
         FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(p)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: r.get::<String, _>("table_schema"),
            name: r.get::<String, _>("table_name"),
            kind: if r.get::<String, _>("table_type") == "VIEW" {
                "view".into()
            } else {
                "table".into()
            },
            row_count: None,
            size_bytes: None,
        })
        .collect())
}

/// Approximate live-row counts and on-disk sizes, for the tree to fold into
/// [`list_table_names`]' answer by `(schema, name)`.
///
/// Only ordinary (`r`) and partitioned (`p`) tables, the relations that have
/// statistics at all. `pg_total_relation_size` stays gated on `r`: a
/// partitioned parent owns no storage of its own and the old listing never
/// sized it. The privilege test is the one `information_schema.tables`
/// applies, so no relation the listing hides is `stat`ed only to be dropped by
/// the merge.
pub async fn table_stats(p: &sqlx::PgPool) -> AppResult<Vec<TableInfo>> {
    let rows = sqlx::query(
        "SELECT n.nspname AS table_schema, c.relname AS table_name, s.n_live_tup, \
                CASE WHEN c.relkind = 'r' \
                     THEN pg_total_relation_size(c.oid) \
                     ELSE NULL END AS size_bytes \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE c.relkind IN ('r', 'p') \
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
           AND NOT pg_is_other_temp_schema(n.oid) \
           AND (pg_has_role(c.relowner, 'USAGE') \
                OR has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') \
                OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))",
    )
    .fetch_all(p)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: r.get::<String, _>("table_schema"),
            name: r.get::<String, _>("table_name"),
            kind: "table".into(),
            row_count: r
                .get::<Option<i64>, _>("n_live_tup")
                .map(|v| v.unsigned_abs()),
            size_bytes: r
                .get::<Option<i64>, _>("size_bytes")
                .map(|v| v.unsigned_abs()),
        })
        .collect())
}

/// A table's columns, with primary-key and single-column foreign-key flags.
pub async fn list_columns(
    p: &sqlx::PgPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    Ok({
        let schema = schema.unwrap_or_else(|| "public".into());
        // The LATERAL subquery walks `pg_constraint` for foreign keys whose
        // conrelid matches the column's table and whose single-element
        // conkey points at this column. We restrict to length-1 conkey to
        // ignore composite FKs.
        let rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.is_nullable, \
                    EXISTS ( \
                        SELECT 1 FROM information_schema.table_constraints tc \
                        JOIN information_schema.key_column_usage k \
                          ON tc.constraint_name = k.constraint_name \
                         AND tc.table_schema = k.table_schema \
                        WHERE tc.constraint_type = 'PRIMARY KEY' \
                          AND tc.table_schema = c.table_schema \
                          AND tc.table_name = c.table_name \
                          AND k.column_name = c.column_name \
                    ) AS is_pk, \
                    fk.ref_schema, fk.ref_table, fk.ref_column \
             FROM information_schema.columns c \
             LEFT JOIN LATERAL ( \
                 SELECT n2.nspname AS ref_schema, \
                        cl2.relname AS ref_table, \
                        att2.attname AS ref_column \
                 FROM pg_constraint con \
                 JOIN pg_class cl  ON cl.oid  = con.conrelid \
                 JOIN pg_namespace n  ON n.oid  = cl.relnamespace \
                 JOIN pg_class cl2 ON cl2.oid = con.confrelid \
                 JOIN pg_namespace n2 ON n2.oid = cl2.relnamespace \
                 JOIN pg_attribute att  ON att.attrelid  = cl.oid  AND att.attnum  = con.conkey[1] \
                 JOIN pg_attribute att2 ON att2.attrelid = cl2.oid AND att2.attnum = con.confkey[1] \
                 WHERE con.contype = 'f' \
                   AND array_length(con.conkey, 1) = 1 \
                   AND n.nspname  = c.table_schema \
                   AND cl.relname = c.table_name \
                   AND att.attname = c.column_name \
                 LIMIT 1 \
             ) fk ON TRUE \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(&schema)
        .bind(&table)
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| ColumnInfo {
                name: r.get::<String, _>("column_name"),
                data_type: r.get::<String, _>("data_type"),
                nullable: r.get::<String, _>("is_nullable") == "YES",
                is_primary_key: r.get::<bool, _>("is_pk"),
                referenced_schema: r.get::<Option<String>, _>("ref_schema"),
                referenced_table: r.get::<Option<String>, _>("ref_table"),
                referenced_column: r.get::<Option<String>, _>("ref_column"),
            })
            .collect()
    })
}

/// A table's indexes and the columns each covers.
pub async fn list_indexes(
    p: &sqlx::PgPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    Ok({
        let schema = schema.unwrap_or_else(|| "public".into());
        let rows = sqlx::query(
            "SELECT i.relname AS index_name, \
                    array_agg(a.attname ORDER BY x.ordinality) AS columns, \
                    ix.indisunique AS is_unique \
             FROM pg_class t \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_index ix ON ix.indrelid = t.oid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, ix.indisunique",
        )
        .bind(&schema)
        .bind(&table)
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| IndexInfo {
                name: r.get::<String, _>("index_name"),
                columns: r.get::<Vec<String>, _>("columns"),
                unique: r.get::<bool, _>("is_unique"),
            })
            .collect()
    })
}

/// Server-side roles, with their membership aggregated in the same round-trip.
pub async fn list_users(p: &sqlx::PgPool) -> AppResult<Vec<UserInfo>> {
    Ok({
        // One row per role, roles-of-membership aggregated in the same
        // round-trip via pg_auth_members so we don't N+1 per role.
        let rows = sqlx::query(
            "SELECT r.rolname, r.rolsuper, r.rolcanlogin, \
                    COALESCE(array_agg(g.rolname) FILTER (WHERE g.rolname IS NOT NULL), '{}') AS roles \
             FROM pg_roles r \
             LEFT JOIN pg_auth_members m ON m.member = r.oid \
             LEFT JOIN pg_roles g ON g.oid = m.roleid \
             GROUP BY r.rolname, r.rolsuper, r.rolcanlogin \
             ORDER BY r.rolname",
        )
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| UserInfo {
                name: r.get::<String, _>("rolname"),
                is_superuser: r.get::<bool, _>("rolsuper"),
                can_login: r.get::<bool, _>("rolcanlogin"),
                roles: r.get::<Vec<String>, _>("roles"),
            })
            .collect()
    })
}

/// Privileges granted to `user`, from `information_schema.role_table_grants`.
pub async fn list_privileges(p: &sqlx::PgPool, user: String) -> AppResult<Vec<PrivilegeInfo>> {
    Ok({
        let rows = sqlx::query(
            "SELECT privilege_type, table_schema, table_name \
             FROM information_schema.role_table_grants \
             WHERE grantee = $1 \
             ORDER BY table_schema, table_name, privilege_type",
        )
        .bind(&user)
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| PrivilegeInfo {
                privilege: r.get::<String, _>("privilege_type"),
                schema: Some(r.get::<String, _>("table_schema")),
                table: Some(r.get::<String, _>("table_name")),
            })
            .collect()
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`, with no `CREATE VIEW ... AS` wrapper
/// and no trailing semicolon.
///
/// `Ok(None)` when `schema.view` is not a view: a table of that name, or nothing
/// at all. Not an error, because the callers ask this *about* a relation whose
/// kind they may not know yet (`describe_table` over MCP asks for every
/// relation), and "this is a table" is an answer rather than a failure.
///
/// `relkind = 'v'` only, deliberately matching [`list_tables`]: materialised
/// views are absent from `information_schema.tables`, so they never surface as
/// `kind: "view"` and there is nothing for a definition to belong to.
pub async fn view_definition(
    p: &sqlx::PgPool,
    schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let schema = schema.filter(|s| !s.is_empty()).unwrap_or("public");
    let def: Option<String> = sqlx::query_scalar(
        "SELECT pg_get_viewdef(c.oid, true) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
    )
    .bind(schema)
    .bind(view)
    .fetch_optional(p)
    .await?;
    Ok(def.map(|q| q.trim().trim_end_matches(';').trim().to_string()))
}

/// Foreign keys on other tables that reference `schema.table`, for the drop
/// dialog. See [`crate::commands::schema::list_referencing_foreign_keys`].
///
/// `pg_constraint` rather than `information_schema`: the latter only shows
/// constraints on tables the login *owns or has a privilege on*, so a child
/// table the user cannot read would vanish from the warning — precisely the
/// one they need to hear about, since they also cannot drop its FK.
/// `to_regclass` resolves the quoted name to the table's oid, or NULL (and so
/// no rows) when it does not exist. `unnest … WITH ORDINALITY` keeps a
/// composite key's columns in key order. Self-references are filtered in SQL.
pub async fn referencing_fks(
    p: &PgPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<crate::commands::schema::IncomingForeignKey>> {
    let qualified = crate::db::sql::Dialect::Postgres.qualify_defaulted(schema, table);
    let rows = sqlx::query(
        "SELECT n.nspname::text AS s, cl.relname::text AS t, \
                con.conname::text AS c, att.attname::text AS col \
         FROM pg_constraint con \
         JOIN pg_class cl ON cl.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = cl.relnamespace \
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) \
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum \
         WHERE con.contype = 'f' \
           AND con.confrelid = to_regclass($1) \
           AND con.conrelid <> con.confrelid \
         ORDER BY n.nspname, cl.relname, con.conname, k.ord",
    )
    .bind(&qualified)
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
