//! SQL Server catalog introspection.
//!
//! Every query here is a single, parameterised statement against the `sys.*`
//! catalog views — no dynamic SQL, and no `INFORMATION_SCHEMA` where the
//! `sys.*` equivalent carries more (identity flags, filtered/hypothetical
//! indexes, principal types). Objects are addressed with
//! `OBJECT_ID(@P1)`, which takes the *quoted* `[schema].[table]` name as a
//! bound string: the table name reaches the server as data, never as
//! concatenated SQL text.
//!
//! Result shapes mirror [`crate::commands::schema`]'s DTOs exactly, so the
//! command layer's SQL Server arms are one-liners.

use crate::commands::schema::{
    ColumnInfo, DatabaseInfo, DatabaseSize, IndexInfo, PrivilegeInfo, TableInfo, UserInfo,
};
use crate::db::ddl::{ColumnDef, ForeignKeyDef, IndexDef, TableStructure};
use crate::db::mssql::values::{first_i64, first_string, mssql_value};
use crate::db::mssql::MsSqlPool;
use crate::db::sql::Dialect;
use crate::error::AppResult;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use tiberius::Row;

/// `[schema].[table]`, defaulting the schema to `dbo` — the string form
/// `OBJECT_ID()` expects.
fn object_name(schema: Option<&str>, table: &str) -> String {
    Dialect::MsSql.qualify_defaulted(schema, table)
}

/// Column `name` of `row` as an owned `String` (empty when NULL/absent).
fn s(row: &Row, name: &str) -> String {
    row.get::<&str, _>(name).unwrap_or_default().to_string()
}

/// Column `name` of `row` as an optional `String`.
fn os(row: &Row, name: &str) -> Option<String> {
    row.get::<&str, _>(name).map(str::to_string)
}

/// Column `name` of `row` as a bool (`bit` columns come back as `bool`).
fn b(row: &Row, name: &str) -> bool {
    row.get::<bool, _>(name).unwrap_or(false)
}

/// Column `name` of `row` as an `i64`, widening whichever integer the catalog
/// used.
///
/// **Must use `try_get`, never `get`.** `tiberius::Row::get::<T, _>` is
/// `self.try_get(idx).unwrap()` — it *panics* when the column's actual
/// `ColumnData` variant isn't the one `T`'s `FromSql` accepts, rather than
/// returning `None`. This function exists precisely because catalog columns
/// like `sys.columns.max_length` (a `smallint`, decoded as `ColumnData::I16`)
/// don't match the widest type: `i64`'s `FromSql` only accepts
/// `ColumnData::I64` (or a null `U8`/`I32`), so a first attempt with `get`
/// panicked on the very first column of the very first table — every single
/// call, on every server, since `max_length`/`precision`/`scale` are never
/// `bigint`. A panic inside a Tauri command's async task never reaches the
/// frontend as a rejected promise, so `list_columns` looked like it just
/// hung forever with no error, on every table, which is exactly what made
/// this so easy to miss without a real SQL Server to test against: the
/// `.or_else` fallback chain below reads as if it handles the mismatch, but
/// it never even ran. `try_get` reports the mismatch as `Err` instead, which
/// `ok()` discards, letting the chain actually fall through to the next
/// width as intended.
fn i(row: &Row, name: &str) -> Option<i64> {
    row.try_get::<i64, _>(name)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i32, _>(name).ok().flatten().map(i64::from))
        .or_else(|| row.try_get::<i16, _>(name).ok().flatten().map(i64::from))
        .or_else(|| row.try_get::<u8, _>(name).ok().flatten().map(i64::from))
}

// ---------------------------------------------------------------------------
// Databases / tables
// ---------------------------------------------------------------------------

pub async fn list_databases(pool: &MsSqlPool) -> AppResult<Vec<DatabaseInfo>> {
    let mut c = pool.acquire().await?;
    // `state = 0` is ONLINE; `HAS_DBACCESS` filters out databases this login
    // cannot open, which would otherwise appear in the tree and fail on click.
    let rows = c
        .query_rows(
            "SELECT name FROM sys.databases \
             WHERE state = 0 AND HAS_DBACCESS(name) = 1 \
             ORDER BY name",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(first_string)
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// On-disk size per database, from the allocated data files.
///
/// `sys.master_files.size` is a page count, and a SQL Server page is 8 KB —
/// hence the `* 8192`. `type_desc = 'ROWS'` restricts it to the data files:
/// the transaction log is excluded on purpose, since it is a function of the
/// recovery model and backup cadence rather than of the data, and including it
/// makes an idle database in FULL recovery look enormous.
///
/// This is *allocated* size, so it includes free space inside the files.
///
/// No privilege guard is needed, unlike the Postgres arm: `sys.master_files`
/// filters rows the login may not see rather than raising, so an inaccessible
/// database's subquery sums nothing and yields `NULL` — the `None` this wants,
/// for free.
pub async fn database_sizes(pool: &MsSqlPool) -> AppResult<Vec<DatabaseSize>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT d.name, \
                    (SELECT SUM(CAST(mf.size AS BIGINT)) * 8192 \
                     FROM sys.master_files mf \
                     WHERE mf.database_id = d.database_id \
                       AND mf.type_desc = 'ROWS') AS size_bytes \
             FROM sys.databases d \
             WHERE d.state = 0 AND HAS_DBACCESS(d.name) = 1 \
             ORDER BY d.name",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = first_string(r)?;
            // Named, not positional-by-index-into-cells: the subquery is
            // aliased `size_bytes`, and `Row::get` resolves either. `i64`
            // because `CAST(... AS BIGINT) * 8192` is a bigint, and `NULL`
            // (an inaccessible database) arrives as `None`.
            let size_bytes = r
                .get::<i64, _>("size_bytes")
                .and_then(|n| u64::try_from(n).ok());
            Some(DatabaseSize { name, size_bytes })
        })
        .collect())
}

/// Tables and views, **names only** — what the schema tree draws from.
///
/// One scan of `sys.objects` (`U` is a user table, `V` a view: the same rows
/// `sys.tables` and `sys.views` expose, without the `UNION`). Row counts and
/// sizes are [`table_stats`]' job and arrive afterwards, because on a database
/// with ten thousand tables `sys.dm_db_partition_stats` was most of the wait
/// before the tree showed anything — and all of it counted against the
/// operation timeout.
pub async fn list_table_names(pool: &MsSqlPool) -> AppResult<Vec<TableInfo>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT s.name AS [schema_name], o.name AS [object_name], \
                    CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END AS [kind] \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U', 'V') \
             ORDER BY s.name, o.name",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: s(r, "schema_name"),
            name: s(r, "object_name"),
            kind: s(r, "kind"),
            row_count: None,
            size_bytes: None,
        })
        .collect())
}

/// Approximate row count and reserved size per table, for the tree to fold
/// into [`list_table_names`]' answer by `(schema, name)`.
///
/// Aggregated by `object_id` *before* the names are joined in, so the server
/// groups on an integer rather than on two `sysname` strings per partition.
/// `index_id IN (0, 1)` counts the heap or the clustered index once; the
/// nonclustered indexes would count every row again.
///
/// `sys.dm_db_partition_stats` needs VIEW DATABASE STATE. A login without it
/// gets an empty answer rather than an error — the tree keeps its names and
/// loses the badges, the same graceful degradation SQLite's `dbstat` probe uses.
pub async fn table_stats(pool: &MsSqlPool) -> AppResult<Vec<TableInfo>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT s.name AS [schema_name], t.name AS [object_name], \
                    p.[rows] AS [rows], p.[bytes] AS [bytes] \
             FROM (SELECT object_id, \
                          SUM(CASE WHEN index_id IN (0, 1) THEN row_count ELSE 0 END) AS [rows], \
                          SUM(reserved_page_count) * 8192 AS [bytes] \
                   FROM sys.dm_db_partition_stats \
                   GROUP BY object_id) p \
             JOIN sys.tables t ON t.object_id = p.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id",
            &[],
        )
        .await
        .unwrap_or_default();
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            schema: s(r, "schema_name"),
            name: s(r, "object_name"),
            kind: "table".into(),
            row_count: i(r, "rows").and_then(|v| u64::try_from(v).ok()),
            size_bytes: i(r, "bytes").and_then(|v| u64::try_from(v).ok()),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Columns / indexes
// ---------------------------------------------------------------------------

/// One row of the shared column query, before it is shaped into either a
/// [`ColumnInfo`] (explorer) or a [`ColumnDef`] (structure editor).
struct RawColumn {
    name: String,
    full_type: String,
    nullable: bool,
    identity: bool,
    default: Option<String>,
}

async fn raw_columns(pool: &MsSqlPool, object: &str) -> AppResult<Vec<RawColumn>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT c.name AS [col_name], ty.name AS [type_name], \
                    c.max_length AS [max_length], c.precision AS [prec], c.scale AS [scale], \
                    c.is_nullable AS [is_nullable], c.is_identity AS [is_identity], \
                    dc.definition AS [col_default] \
             FROM sys.columns c \
             JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN sys.default_constraints dc \
                    ON dc.parent_object_id = c.object_id \
                   AND dc.parent_column_id = c.column_id \
             WHERE c.object_id = OBJECT_ID(@P1) \
             ORDER BY c.column_id",
            &[Some(object.to_string())],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| RawColumn {
            name: s(r, "col_name"),
            full_type: render_type(
                &s(r, "type_name"),
                i(r, "max_length"),
                i(r, "prec"),
                i(r, "scale"),
            ),
            nullable: b(r, "is_nullable"),
            identity: b(r, "is_identity"),
            // `sys.default_constraints.definition` is parenthesised
            // (`('x')`, `(getdate())`); unwrap one layer so the structure
            // editor shows what the user would type.
            default: os(r, "col_default").map(|d| strip_outer_parens(&d)),
        })
        .collect())
}

/// Render a catalog type row as the type text a user would write.
///
/// `max_length` is in *bytes*, so the Unicode types report double their
/// character length, and `-1` means `(max)`. Only the types whose declaration
/// actually carries a length or precision get a suffix.
fn render_type(
    type_name: &str,
    max_length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let t = type_name.to_ascii_lowercase();
    match t.as_str() {
        "varchar" | "char" | "varbinary" | "binary" => match max_length {
            Some(-1) => format!("{t}(max)"),
            Some(n) if n > 0 => format!("{t}({n})"),
            _ => t,
        },
        "nvarchar" | "nchar" => match max_length {
            Some(-1) => format!("{t}(max)"),
            Some(n) if n > 0 => format!("{t}({})", n / 2),
            _ => t,
        },
        "decimal" | "numeric" => match (precision, scale) {
            (Some(p), Some(sc)) => format!("{t}({p},{sc})"),
            (Some(p), None) => format!("{t}({p})"),
            _ => t,
        },
        "datetime2" | "datetimeoffset" | "time" => match scale {
            Some(sc) if sc != 7 => format!("{t}({sc})"),
            _ => t,
        },
        _ => t,
    }
}

fn strip_outer_parens(def: &str) -> String {
    let d = def.trim();
    let inner = d
        .strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(d);
    inner.trim().to_string()
}

async fn primary_key_columns(pool: &MsSqlPool, object: &str) -> AppResult<Vec<String>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT c.name AS [col_name] \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@P1) \
             ORDER BY ic.key_ordinal",
            &[Some(object.to_string())],
        )
        .await?;
    Ok(rows.iter().map(|r| s(r, "col_name")).collect())
}

/// Single-column foreign keys, keyed by the local column name.
///
/// Composite FKs are filtered out with the same `COUNT(*) = 1` guard the MySQL
/// path uses: the explorer's inline FK dropdown can only address one column.
async fn single_column_fks(
    pool: &MsSqlPool,
    object: &str,
) -> AppResult<HashMap<String, (String, String, String)>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT pc.name AS [col_name], rs.name AS [ref_schema], \
                    rt.name AS [ref_table], rc.name AS [ref_column] \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                                AND pc.column_id = fkc.parent_column_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
                                AND rc.column_id = fkc.referenced_column_id \
             WHERE fk.parent_object_id = OBJECT_ID(@P1) \
               AND (SELECT COUNT(*) FROM sys.foreign_key_columns x \
                    WHERE x.constraint_object_id = fk.object_id) = 1",
            &[Some(object.to_string())],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                s(r, "col_name"),
                (s(r, "ref_schema"), s(r, "ref_table"), s(r, "ref_column")),
            )
        })
        .collect())
}

pub async fn list_columns(
    pool: &MsSqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<ColumnInfo>> {
    let object = object_name(schema, table);
    let cols = raw_columns(pool, &object).await?;
    let pk = primary_key_columns(pool, &object).await?;
    let fks = single_column_fks(pool, &object).await?;
    Ok(cols
        .into_iter()
        .map(|c| {
            let fk = fks.get(&c.name);
            ColumnInfo {
                is_primary_key: pk.contains(&c.name),
                referenced_schema: fk.map(|f| f.0.clone()),
                referenced_table: fk.map(|f| f.1.clone()),
                referenced_column: fk.map(|f| f.2.clone()),
                name: c.name,
                data_type: c.full_type,
                nullable: c.nullable,
            }
        })
        .collect())
}

pub async fn list_indexes(
    pool: &MsSqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<IndexInfo>> {
    let object = object_name(schema, table);
    let mut c = pool.acquire().await?;
    // Grouped in Rust rather than with `STRING_AGG`, which is SQL Server 2017+
    // — the driver otherwise targets 2012 and newer.
    let rows = c
        .query_rows(
            "SELECT i.name AS [index_name], i.is_unique AS [is_unique], \
                    c.name AS [col_name] \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE i.object_id = OBJECT_ID(@P1) AND i.name IS NOT NULL \
               AND i.is_hypothetical = 0 \
             ORDER BY i.name, ic.key_ordinal",
            &[Some(object)],
        )
        .await?;

    let mut grouped: BTreeMap<String, (bool, Vec<String>)> = BTreeMap::new();
    for r in &rows {
        let entry = grouped
            .entry(s(r, "index_name"))
            .or_insert_with(|| (b(r, "is_unique"), Vec::new()));
        entry.1.push(s(r, "col_name"));
    }
    Ok(grouped
        .into_iter()
        .map(|(name, (unique, columns))| IndexInfo {
            name,
            columns,
            unique,
        })
        .collect())
}

/// Full structure for the (read-only in this version) structure editor.
pub async fn table_structure(
    pool: &MsSqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<TableStructure> {
    let object = object_name(schema, table);
    let cols = raw_columns(pool, &object).await?;
    let pk = primary_key_columns(pool, &object).await?;
    let indexes = list_indexes(pool, schema, table).await?;
    let fks = all_foreign_keys(pool, &object).await?;

    Ok(TableStructure {
        schema: schema.map(str::to_string),
        name: table.to_string(),
        columns: cols
            .into_iter()
            .map(|c| ColumnDef {
                original_name: Some(c.name.clone()),
                is_primary_key: pk.contains(&c.name),
                name: c.name,
                data_type: c.full_type,
                nullable: c.nullable,
                default: c.default,
                auto_increment: c.identity,
            })
            .collect(),
        indexes: indexes
            .into_iter()
            // The PK's backing index is represented by `is_primary_key` on the
            // columns, so listing it again would show a phantom index.
            .filter(|idx| !is_pk_index(&idx.columns, &pk) || pk.is_empty())
            .map(|idx| IndexDef {
                name: Some(idx.name),
                columns: idx.columns,
                unique: idx.unique,
            })
            .collect(),
        foreign_keys: fks,
    })
}

fn is_pk_index(columns: &[String], pk: &[String]) -> bool {
    !pk.is_empty() && columns == pk
}

/// Composite-capable FK introspection for the structure view.
async fn all_foreign_keys(pool: &MsSqlPool, object: &str) -> AppResult<Vec<ForeignKeyDef>> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT fk.name AS [fk_name], rs.name AS [ref_schema], rt.name AS [ref_table], \
                    pc.name AS [col_name], rc.name AS [ref_column], \
                    fk.delete_referential_action_desc AS [on_delete], \
                    fk.update_referential_action_desc AS [on_update], \
                    fkc.constraint_column_id AS [ord] \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                                AND pc.column_id = fkc.parent_column_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
                                AND rc.column_id = fkc.referenced_column_id \
             WHERE fk.parent_object_id = OBJECT_ID(@P1) \
             ORDER BY fk.name, fkc.constraint_column_id",
            &[Some(object.to_string())],
        )
        .await?;

    let mut grouped: BTreeMap<String, ForeignKeyDef> = BTreeMap::new();
    for r in &rows {
        let name = s(r, "fk_name");
        let entry = grouped
            .entry(name.clone())
            .or_insert_with(|| ForeignKeyDef {
                name: Some(name),
                columns: Vec::new(),
                ref_schema: Some(s(r, "ref_schema")),
                ref_table: s(r, "ref_table"),
                ref_columns: Vec::new(),
                on_delete: referential_action(&s(r, "on_delete")),
                on_update: referential_action(&s(r, "on_update")),
            });
        entry.columns.push(s(r, "col_name"));
        entry.ref_columns.push(s(r, "ref_column"));
    }
    Ok(grouped.into_values().collect())
}

/// Catalog action names are `NO_ACTION` / `SET_NULL` / … ; the DTO uses the SQL
/// spelling, and `NO ACTION` (the default) is represented as absent, matching
/// the MySQL path.
fn referential_action(desc: &str) -> Option<String> {
    match desc.trim().to_ascii_uppercase().as_str() {
        "" | "NO_ACTION" => None,
        other => Some(other.replace('_', " ")),
    }
}

// ---------------------------------------------------------------------------
// Server info / security
// ---------------------------------------------------------------------------

pub async fn server_version(pool: &MsSqlPool) -> AppResult<String> {
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS [v]",
            &[],
        )
        .await?;
    let version = rows
        .iter()
        .filter_map(first_string)
        .next()
        .unwrap_or_default();
    Ok(format!("sql server {version}").trim().to_string())
}

pub async fn list_users(pool: &MsSqlPool) -> AppResult<Vec<UserInfo>> {
    let mut c = pool.acquire().await?;
    // Database *principals*, not server logins: a login without a mapped user
    // cannot touch this database, and asking for server-level principals needs
    // permissions an ordinary user does not have.
    let rows = c
        .query_rows(
            "SELECT dp.name AS [principal], dp.type AS [ptype], \
                    dp.authentication_type AS [auth_type] \
             FROM sys.database_principals dp \
             WHERE dp.type IN ('S', 'U', 'G', 'E', 'X') \
               AND dp.name NOT LIKE '##%' \
             ORDER BY dp.name",
            &[],
        )
        .await?;
    let members = c
        .query_rows(
            "SELECT m.name AS [member], r.name AS [role] \
             FROM sys.database_role_members rm \
             JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id \
             JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id",
            &[],
        )
        .await
        .unwrap_or_default();

    let mut roles_by_member: HashMap<String, Vec<String>> = HashMap::new();
    for r in &members {
        roles_by_member
            .entry(s(r, "member"))
            .or_default()
            .push(s(r, "role"));
    }

    Ok(rows
        .iter()
        .map(|r| {
            let name = s(r, "principal");
            let roles = roles_by_member.get(&name).cloned().unwrap_or_default();
            UserInfo {
                is_superuser: name == "dbo" || roles.iter().any(|r| r == "db_owner"),
                // `authentication_type = 0` is NONE: a principal that exists in
                // the database but has no way to authenticate (e.g. a user
                // mapped to a dropped login).
                can_login: i(r, "auth_type").unwrap_or(1) != 0,
                name,
                roles,
            }
        })
        .collect())
}

pub async fn list_privileges(pool: &MsSqlPool, user: &str) -> AppResult<Vec<PrivilegeInfo>> {
    let mut c = pool.acquire().await?;
    // `state` G = granted, W = granted with grant option. Denials are excluded
    // rather than shown as privileges.
    let rows = c
        .query_rows(
            "SELECT p.permission_name AS [perm], s.name AS [schema_name], \
                    o.name AS [object_name] \
             FROM sys.database_permissions p \
             JOIN sys.database_principals pr ON pr.principal_id = p.grantee_principal_id \
             LEFT JOIN sys.objects o ON p.class = 1 AND o.object_id = p.major_id \
             LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE pr.name = @P1 AND p.state IN ('G', 'W') \
             ORDER BY p.permission_name, s.name, o.name",
            &[Some(user.to_string())],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| PrivilegeInfo {
            privilege: s(r, "perm"),
            schema: os(r, "schema_name"),
            table: os(r, "object_name"),
        })
        .collect())
}

/// Row-count estimate for the browse footer, from the same partition stats
/// `list_tables` uses. `None` when the login lacks VIEW DATABASE STATE, so the
/// caller falls back to an exact `COUNT(*)`.
pub async fn estimate_rows(pool: &MsSqlPool, schema: Option<&str>, table: &str) -> Option<u64> {
    let object = object_name(schema, table);
    let mut c = pool.acquire().await.ok()?;
    let rows = c
        .query_rows(
            "SELECT SUM(p.row_count) AS [rows] FROM sys.dm_db_partition_stats p \
             WHERE p.object_id = OBJECT_ID(@P1) AND p.index_id IN (0, 1)",
            &[Some(object)],
        )
        .await
        .ok()?;
    rows.first()
        .and_then(first_i64)
        .filter(|n| *n > 0)
        .and_then(|n| u64::try_from(n).ok())
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`. See
/// [`crate::db::postgres::schema::view_definition`] for why a missing view is
/// `Ok(None)` rather than an error.
///
/// Reading a definition works here even though *editing* one does not: the
/// refusal in [`crate::db::view_ddl::build_view_ddl`] is about the T-SQL DDL
/// builder not being written, never about the catalog being unable to answer.
///
/// Two details are load-bearing:
///
/// - The join to `sys.views` is not decoration. `sys.sql_modules` holds the
///   body of every module-backed object — procedures, functions, triggers,
///   default constraints — and `OBJECT_ID` happily resolves those names too, so
///   without the join this would hand back a stored procedure's source for a
///   caller that asked for a view.
/// - `sys.sql_modules.definition` is NULL for a view created `WITH
///   ENCRYPTION`, which lands as `Ok(None)` — indistinguishable from "not a
///   view". That is the honest answer available: the body genuinely cannot be
///   read, and the alternative would be an error on a relation the caller may
///   only have been probing.
///
/// SQL Server stores the whole `CREATE VIEW ... AS ...` statement, as SQLite
/// does, so the header is stripped to keep the body meaning the same thing on
/// every driver.
pub async fn view_definition(
    pool: &MsSqlPool,
    schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let object = object_name(schema, view);
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT m.definition FROM sys.sql_modules m \
             JOIN sys.views v ON v.object_id = m.object_id \
             WHERE m.object_id = OBJECT_ID(@P1)",
            &[Some(object)],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(first_string)
        .map(|sql| crate::db::view_ddl::strip_view_header(&sql)))
}

/// The `WITH …` options in a view's header, as `ALTER VIEW` would spell them.
///
/// [`view_definition`] hands back the body with its header stripped, and
/// `ALTER VIEW` replaces the header too — so these have to be read separately
/// and passed to `db::view_ddl::build_view_ddl`, or editing a view would
/// silently drop them. `ENCRYPTION` is not here: an encrypted view has no
/// readable definition, so [`view_definition`] already reports it as absent.
pub async fn view_options(
    pool: &MsSqlPool,
    schema: Option<&str>,
    view: &str,
) -> AppResult<Vec<&'static str>> {
    let object = object_name(schema, view);
    let mut c = pool.acquire().await?;
    let rows = c
        .query_rows(
            "SELECT m.is_schema_bound AS [schemabinding], \
                    v.has_opaque_metadata AS [view_metadata] \
             FROM sys.views v JOIN sys.sql_modules m ON m.object_id = v.object_id \
             WHERE v.object_id = OBJECT_ID(@P1)",
            &[Some(object)],
        )
        .await?;
    let Some(r) = rows.first() else {
        return Ok(Vec::new());
    };
    let mut options = Vec::new();
    if b(r, "schemabinding") {
        options.push("SCHEMABINDING");
    }
    if b(r, "view_metadata") {
        options.push("VIEW_METADATA");
    }
    Ok(options)
}

/// Decode a whole result set into the `(columns, rows)` shape the query and
/// browse paths hand back to the frontend.
pub fn decode_rows(rows: &[Row]) -> (Vec<(String, String)>, Vec<Vec<Value>>) {
    let columns = rows
        .first()
        .map(crate::db::mssql::values::mssql_columns)
        .unwrap_or_default();
    let data = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| mssql_value(r, i)).collect())
        .collect();
    (columns, data)
}

/// Foreign keys on other tables that reference `schema.table`, for the drop
/// dialog. See [`crate::commands::schema::list_referencing_foreign_keys`].
///
/// [`all_foreign_keys`] turned around: it filters on `parent_object_id`, this
/// on `referenced_object_id`. Self-references are filtered in SQL.
pub async fn referencing_fks(
    pool: &MsSqlPool,
    schema: Option<&str>,
    table: &str,
) -> AppResult<Vec<crate::commands::schema::IncomingForeignKey>> {
    let rows = pool
        .query_all(
            "SELECT ps.name AS [s], pt.name AS [t], fk.name AS [c], pc.name AS [col] \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.tables pt ON pt.object_id = fk.parent_object_id \
             JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
                                AND pc.column_id = fkc.parent_column_id \
             WHERE fk.referenced_object_id = OBJECT_ID(@P1) \
               AND fk.parent_object_id <> fk.referenced_object_id \
             ORDER BY ps.name, pt.name, fk.name, fkc.constraint_column_id",
            &[Some(object_name(schema, table))],
        )
        .await?;
    Ok(crate::commands::schema::group_incoming_fks(
        rows.iter()
            .map(|r| (Some(s(r, "s")), s(r, "t"), s(r, "c"), s(r, "col"))),
    ))
}

#[cfg(test)]
mod tests {
    use super::{referential_action, render_type, strip_outer_parens};

    #[test]
    fn renders_lengths_and_precision_like_a_declaration() {
        assert_eq!(
            render_type("varchar", Some(255), None, None),
            "varchar(255)"
        );
        // `max_length` is in bytes, so a Unicode type reports twice its
        // character length.
        assert_eq!(
            render_type("nvarchar", Some(100), None, None),
            "nvarchar(50)"
        );
        assert_eq!(
            render_type("nvarchar", Some(-1), None, None),
            "nvarchar(max)"
        );
        assert_eq!(
            render_type("varbinary", Some(-1), None, None),
            "varbinary(max)"
        );
        assert_eq!(
            render_type("decimal", Some(9), Some(10), Some(2)),
            "decimal(10,2)"
        );
        // Types whose declaration carries no length must not grow one.
        assert_eq!(render_type("int", Some(4), Some(10), Some(0)), "int");
        assert_eq!(render_type("datetime", Some(8), None, None), "datetime");
        // The default scale for datetime2 is 7; only a narrower one is shown.
        assert_eq!(
            render_type("datetime2", Some(8), None, Some(7)),
            "datetime2"
        );
        assert_eq!(
            render_type("datetime2", Some(6), None, Some(3)),
            "datetime2(3)"
        );
    }

    #[test]
    fn unwraps_the_catalogs_parenthesised_defaults() {
        assert_eq!(strip_outer_parens("('x')"), "'x'");
        assert_eq!(strip_outer_parens("(getdate())"), "getdate()");
        assert_eq!(strip_outer_parens("((0))"), "(0)");
        assert_eq!(strip_outer_parens("0"), "0");
    }

    #[test]
    fn maps_referential_actions_and_treats_no_action_as_absent() {
        assert_eq!(referential_action("NO_ACTION"), None);
        assert_eq!(referential_action(""), None);
        assert_eq!(referential_action("CASCADE"), Some("CASCADE".to_string()));
        assert_eq!(referential_action("SET_NULL"), Some("SET NULL".to_string()));
        assert_eq!(
            referential_action("SET_DEFAULT"),
            Some("SET DEFAULT".to_string())
        );
    }
}
