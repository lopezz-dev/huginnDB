//! SQLite catalog introspection. See [`crate::db::postgres::schema`] for the
//! module's contract.

use sqlx::SqlitePool;

use crate::commands::schema::{ColumnInfo, IndexInfo, TableInfo};
use crate::commands::schema::{DatabaseInfo, DatabaseSize};
use crate::db::sql::Dialect;
use crate::error::AppResult;
use sqlx::Row;

/// The single database a SQLite connection has.
///
/// A SQLite connection *is* one file, so there is nothing to query: the tree
/// still wants one node, and `main` is the name SQLite itself uses for the
/// primary schema (`PRAGMA database_list`). Kept as a function rather than a
/// constant at the call site so the dispatch in `commands::schema` reads the
/// same for all five drivers.
pub fn list_databases() -> Vec<DatabaseInfo> {
    vec![DatabaseInfo {
        name: "main".to_string(),
    }]
}

/// Bytes occupied by `pages` pages of `page_size` bytes each.
///
/// Pure and `checked_mul`-guarded so a nonsensical pragma pair (a negative
/// page count from a corrupt header, or a product past `u64`) yields `None` —
/// "the engine would not say" — rather than a wrapped number presented as a
/// size. Split out from [`database_sizes`] because it is the only part of that
/// function a test can reach without a database.
pub(crate) fn pages_to_bytes(pages: i64, page_size: i64) -> Option<u64> {
    let pages = u64::try_from(pages).ok()?;
    let page_size = u64::try_from(page_size).ok()?;
    pages.checked_mul(page_size)
}

/// Size of the SQLite file behind this connection.
///
/// `page_count * page_size` is the number the OS file browser shows, which
/// makes it the most directly meaningful of the five drivers' answers. It
/// includes pages on the freelist (space the file holds but no longer uses)
/// and excludes the `-wal` and `-shm` sidecars, which can be substantial
/// between checkpoints.
///
/// Separate from [`list_databases`], which is sync and needs no pool, because
/// this one is neither — two functions rather than one contorted signature.
pub async fn database_sizes(pool: &SqlitePool) -> AppResult<Vec<DatabaseSize>> {
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await?;
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(pool)
        .await?;
    Ok(vec![DatabaseSize {
        name: "main".to_string(),
        size_bytes: pages_to_bytes(pages, page_size),
    }])
}

/// Engine and version, as `sqlite <version>`.
pub async fn server_version(pool: &SqlitePool) -> AppResult<String> {
    let raw: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(pool)
        .await?;
    Ok(format!("sqlite {raw}"))
}

/// Tables and views from `sqlite_master`, **names only** — what the schema tree
/// draws from.
///
/// SQLite has no statistics catalog with per-table row counts (`sqlite_stat1`
/// only exists after `ANALYZE` and is unreliable for fresh databases, and a
/// `COUNT(*)` per table would block the tree on large schemas), so the only
/// figure is the size [`table_stats`] reads afterwards.
pub async fn list_table_names(p: &sqlx::SqlitePool) -> AppResult<Vec<TableInfo>> {
    let rows = sqlx::query(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table', 'view') \
         AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )
    .fetch_all(p)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: "main".into(),
            name: r.get("name"),
            kind: r.get("type"),
            row_count: None,
            size_bytes: None,
        })
        .collect())
}

/// Per-table size from the `dbstat` virtual table, for the tree to fold into
/// [`list_table_names`]' answer by name.
///
/// **One aggregate, not one query per table.** This used to probe `dbstat`
/// once per table inside the listing, so a file with ten thousand tables was
/// ten thousand statements before the tree drew anything. `dbstat` names every
/// b-tree — indexes too — and an index's row is simply not in the listing, so
/// the merge drops it; the table's own figure is its own b-tree, as before.
///
/// `dbstat` is a compile-time feature of SQLite and may be absent; a build
/// without it answers with no sizes rather than an error.
pub async fn table_stats(p: &sqlx::SqlitePool) -> AppResult<Vec<TableInfo>> {
    let rows = sqlx::query("SELECT name, SUM(pgsize) AS size FROM dbstat GROUP BY name")
        .fetch_all(p)
        .await
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            schema: "main".into(),
            name: r.get("name"),
            kind: "table".into(),
            row_count: None,
            size_bytes: r
                .try_get::<Option<i64>, _>("size")
                .ok()
                .flatten()
                .map(|n| n.unsigned_abs()),
        })
        .collect())
}

/// A table's columns, from `PRAGMA table_info` plus `PRAGMA foreign_key_list`.
///
/// `_schema` is accepted and ignored: SQLite has no schema layer (the file is
/// the database), but taking it keeps the dispatch in `commands::schema`
/// identical across all five drivers.
pub async fn list_columns(
    p: &sqlx::SqlitePool,
    _schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    Ok({
        // PRAGMA does not accept bound parameters; identifiers are
        // quoted defensively even though they come from a trusted
        // catalog lookup.
        let q = format!("PRAGMA table_info({})", Dialect::Sqlite.quote_ident(&table));
        let rows = sqlx::query(&q).fetch_all(p).await?;
        // foreign_key_list yields one row per column of each constraint.
        // Group by `id` to filter composite FKs.
        let fk_q = format!(
            "PRAGMA foreign_key_list({})",
            Dialect::Sqlite.quote_ident(&table)
        );
        let fk_rows = sqlx::query(&fk_q).fetch_all(p).await?;
        use std::collections::HashMap;
        // (id) -> Vec<(from, target_table, target_col_opt)>
        let mut groups: HashMap<i64, Vec<(String, String, Option<String>)>> = HashMap::new();
        for r in fk_rows {
            let id: i64 = r.get("id");
            let from: String = r.get("from");
            let target_table: String = r.get("table");
            let to: Option<String> = r.try_get("to").ok().flatten();
            groups.entry(id).or_default().push((from, target_table, to));
        }
        let mut fk_map: HashMap<String, (String, Option<String>)> = HashMap::new();
        for parts in groups.into_values() {
            if parts.len() == 1 {
                let (from, target_table, to) = parts.into_iter().next().unwrap();
                fk_map.insert(from, (target_table, to));
            }
        }
        // Resolve any FK with NULL `to` (implicit PK) by inspecting the
        // target table once each.
        use std::collections::HashSet;
        let needs_pk_resolution: HashSet<String> = fk_map
            .values()
            .filter(|(_, to)| to.is_none())
            .map(|(t, _)| t.clone())
            .collect();
        let mut pk_cache: HashMap<String, Option<String>> = HashMap::new();
        for target in needs_pk_resolution {
            let q2 = format!(
                "PRAGMA table_info({})",
                Dialect::Sqlite.quote_ident(&target)
            );
            let pk = match sqlx::query(&q2).fetch_all(p).await {
                Ok(target_rows) => target_rows
                    .into_iter()
                    .find(|r| r.get::<i64, _>("pk") > 0)
                    .map(|r| r.get::<String, _>("name")),
                Err(_) => None,
            };
            pk_cache.insert(target, pk);
        }
        rows.into_iter()
            .map(|r| {
                let name: String = r.get("name");
                let (ref_table, ref_column) = match fk_map.get(&name) {
                    Some((t, Some(c))) => (Some(t.clone()), Some(c.clone())),
                    Some((t, None)) => (Some(t.clone()), pk_cache.get(t).cloned().unwrap_or(None)),
                    None => (None, None),
                };
                ColumnInfo {
                    name,
                    data_type: r.get::<String, _>("type"),
                    nullable: r.get::<i64, _>("notnull") == 0,
                    is_primary_key: r.get::<i64, _>("pk") > 0,
                    referenced_schema: None,
                    referenced_table: ref_table,
                    referenced_column: ref_column,
                }
            })
            .collect()
    })
}

/// A table's indexes, from `PRAGMA index_list` + `PRAGMA index_info`.
///
/// `_schema` is accepted and ignored — see [`list_columns`].
pub async fn list_indexes(
    p: &sqlx::SqlitePool,
    _schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    Ok({
        let q = format!("PRAGMA index_list({})", Dialect::Sqlite.quote_ident(&table));
        let rows = sqlx::query(&q).fetch_all(p).await?;
        let mut out = Vec::new();
        for r in rows {
            let name: String = r.get("name");
            let unique: i64 = r.get("unique");
            let q2 = format!("PRAGMA index_info({})", Dialect::Sqlite.quote_ident(&name));
            let cols_rows = sqlx::query(&q2).fetch_all(p).await?;
            let cols: Vec<String> = cols_rows.into_iter().map(|c| c.get("name")).collect();
            out.push(IndexInfo {
                name,
                columns: cols,
                unique: unique != 0,
            });
        }
        out
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`. See
/// [`crate::db::postgres::schema::view_definition`] for why a missing view is
/// `Ok(None)` rather than an error.
///
/// `sqlite_master.sql` holds the *whole* `CREATE VIEW ... AS ...` statement, so
/// the header is stripped by [`crate::db::view_ddl::strip_view_header`] to keep
/// the returned body meaning the same thing it does on the other drivers.
/// `_schema` is accepted and ignored: SQLite has exactly one schema (`main`).
pub async fn view_definition(
    p: &sqlx::SqlitePool,
    _schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let create_sql: Option<Option<String>> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
            .bind(view)
            .fetch_optional(p)
            .await?;
    Ok(create_sql
        .flatten()
        .map(|sql| crate::db::view_ddl::strip_view_header(&sql)))
}

/// A table's full definition as SQLite stored it: the `CREATE TABLE` from
/// `sqlite_master`, followed by the table's explicit indexes and triggers.
///
/// Unlike MySQL's `SHOW CREATE TABLE`, SQLite's table row does not mention the
/// table's indexes — they are separate `sqlite_master` rows — so copying only
/// the first statement would recreate the table without them. Auto-indexes
/// (for `UNIQUE`/`PRIMARY KEY` constraints) have a `NULL` `sql` and are already
/// implied by the table statement, so they are skipped.
pub async fn create_table_sql(p: &sqlx::SqlitePool, table: &str) -> AppResult<String> {
    let table_sql: Option<Option<String>> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_optional(p)
            .await?;
    let Some(Some(table_sql)) = table_sql else {
        return Err(crate::error::AppError::NotFound(format!("table {table}")));
    };
    let extras: Vec<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master \
         WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL \
         ORDER BY type, name",
    )
    .bind(table)
    .fetch_all(p)
    .await?;
    let mut out = format!("{};", table_sql.trim_end());
    for sql in extras {
        out.push_str("\n\n");
        out.push_str(sql.trim_end());
        out.push(';');
    }
    Ok(out)
}

/// Foreign keys on other tables that reference `table`, for the drop dialog.
/// See [`crate::commands::schema::list_referencing_foreign_keys`].
///
/// SQLite has no catalog view of FKs from the referenced side, only
/// `PRAGMA foreign_key_list(child)`, so every other table is asked in turn —
/// N small pragma reads, acceptable for a confirm dialog on a local file. The
/// pragma names the parent as it was *written* in the child's DDL, which
/// SQLite itself resolves case-insensitively, so the match is too.
///
/// SQLite constraints are usually anonymous; the pragma's per-table `id` then
/// stands in as the name (`fk_0`, `fk_1`, …) so two FKs from the same child
/// stay apart.
pub async fn referencing_fks(
    p: &sqlx::SqlitePool,
    table: &str,
) -> AppResult<Vec<crate::commands::schema::IncomingForeignKey>> {
    let children: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? COLLATE NOCASE \
         ORDER BY name",
    )
    .bind(table)
    .fetch_all(p)
    .await?;
    let mut rows = Vec::new();
    for child in children {
        let q = format!(
            "PRAGMA foreign_key_list({})",
            Dialect::Sqlite.quote_ident(&child)
        );
        // `id` then `seq` is constraint order then key order.
        let mut fks: Vec<(i64, i64, String)> = sqlx::query(&q)
            .fetch_all(p)
            .await?
            .into_iter()
            .filter(|r| r.get::<String, _>("table").eq_ignore_ascii_case(table))
            .map(|r| (r.get("id"), r.get("seq"), r.get("from")))
            .collect();
        fks.sort();
        rows.extend(
            fks.into_iter()
                .map(|(id, _, from)| (None, child.clone(), format!("fk_{id}"), from)),
        );
    }
    Ok(crate::commands::schema::group_incoming_fks(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// File-backed for the reason `db::exec::tests` gives: an in-memory
    /// database is per-connection, so the schema would not survive the pool.
    async fn pool(name: &str) -> SqlitePool {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let path = std::env::temp_dir().join(format!("huginndb_sqlite_schema_{name}.db"));
        let _ = std::fs::remove_file(&path);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn names_come_without_figures_and_stats_fold_in_without_index_rows() {
        let p = pool("names_then_stats").await;
        for sql in [
            "CREATE TABLE b (x INTEGER)",
            "CREATE TABLE a (x INTEGER)",
            "CREATE INDEX a_x ON a (x)",
            "CREATE VIEW v AS SELECT x FROM a",
        ] {
            sqlx::query(sql).execute(&p).await.unwrap();
        }

        let names = list_table_names(&p).await.unwrap();
        let got: Vec<(&str, &str)> = names
            .iter()
            .map(|t| (t.name.as_str(), t.kind.as_str()))
            .collect();
        assert_eq!(got, vec![("a", "table"), ("b", "table"), ("v", "view")]);
        assert!(names
            .iter()
            .all(|t| t.row_count.is_none() && t.size_bytes.is_none()));

        let stats = table_stats(&p).await.unwrap();
        let has_dbstat = !stats.is_empty();
        let merged = crate::commands::schema::merge_table_stats(names, stats);
        assert_eq!(
            merged.len(),
            3,
            "the index's dbstat row must not become a relation"
        );
        assert_eq!(merged[2].size_bytes, None, "a view owns no b-tree");
        // `dbstat` is optional at compile time; when it is there, a table's
        // figure is its own b-tree, exactly one page for an empty table.
        if has_dbstat {
            assert!(merged[0].size_bytes.is_some_and(|n| n > 0));
            assert!(merged[1].size_bytes.is_some_and(|n| n > 0));
        }
    }

    #[tokio::test]
    async fn referencing_fks_lists_every_child_and_leaves_self_references_out() {
        let p = pool("referencing_fks").await;
        for sql in [
            "CREATE TABLE orders (id INTEGER, rev INTEGER, parent_id INTEGER \
                 REFERENCES orders(id), PRIMARY KEY (id, rev))",
            "CREATE TABLE lines (order_id INTEGER, order_rev INTEGER, \
                 FOREIGN KEY (order_id, order_rev) REFERENCES orders(id, rev))",
            // Written in a different case than the table was created with.
            "CREATE TABLE payments (order_id INTEGER REFERENCES ORDERS(id))",
            "CREATE TABLE unrelated (x INTEGER)",
        ] {
            sqlx::query(sql).execute(&p).await.unwrap();
        }

        let got = referencing_fks(&p, "orders").await.unwrap();

        let tables: Vec<&str> = got.iter().map(|f| f.table.as_str()).collect();
        assert_eq!(tables, vec!["lines", "payments"]);
        assert_eq!(got[0].columns, vec!["order_id", "order_rev"]);
        assert_eq!(got[1].columns, vec!["order_id"]);
        assert!(got.iter().all(|f| f.schema.is_none()));
    }

    #[test]
    fn pages_to_bytes_multiplies_the_pragma_pair() {
        // SQLite's own default page size, and the number the OS file browser
        // shows for such a file.
        assert_eq!(pages_to_bytes(2_560, 4_096), Some(10_485_760));
        assert_eq!(pages_to_bytes(0, 4_096), Some(0));
    }

    #[test]
    fn pages_to_bytes_refuses_nonsense_rather_than_wrapping() {
        // A corrupt header can hand back a negative page count, and a wrapped
        // product presented as a size is worse than no badge at all — the
        // best-effort contract says `None` means "would not say", and a
        // silently truncated number cannot say that.
        assert_eq!(pages_to_bytes(-1, 4_096), None);
        assert_eq!(pages_to_bytes(4_096, -1), None);
        assert_eq!(pages_to_bytes(i64::MAX, i64::MAX), None);
    }

    #[tokio::test]
    async fn create_table_sql_includes_the_tables_indexes_and_triggers() {
        let p = pool("create_ddl").await;
        for sql in [
            "CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT)",
            "CREATE INDEX t_name ON t (name)",
            "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN SELECT 1; END",
            // Another table's index must not leak into `t`'s definition.
            "CREATE TABLE other (x INTEGER)",
            "CREATE INDEX other_x ON other (x)",
        ] {
            sqlx::query(sql).execute(&p).await.unwrap();
        }

        let ddl = create_table_sql(&p, "t").await.unwrap();

        assert!(ddl.starts_with("CREATE TABLE t (id INTEGER PRIMARY KEY"));
        assert!(ddl.contains("CREATE INDEX t_name ON t (name);"));
        assert!(ddl.contains("CREATE TRIGGER t_ai AFTER INSERT ON t"));
        // The UNIQUE auto-index has no `sql` and is implied by the table.
        assert!(!ddl.contains("sqlite_autoindex"));
        assert!(!ddl.contains("other"));
    }

    #[tokio::test]
    async fn create_table_sql_reports_a_missing_table_as_not_found() {
        let p = pool("create_ddl_missing").await;
        let err = create_table_sql(&p, "nope").await.unwrap_err();
        assert!(matches!(err, crate::error::AppError::NotFound(_)));
    }
}
