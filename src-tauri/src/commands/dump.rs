//! Whole-database export and the one backend primitive the import flow needs.
//!
//! `export_databases` streams a portable, combined `.sql` dump (schema +
//! data) for one or more already-resolved database connections — the
//! connection-level and per-database "Export database…" dialogs both funnel
//! into it (see `ExportDatabaseDialog.tsx`). `read_text_file` is
//! intentionally the *only* backend piece import needs: the frontend
//! re-runs the picked file through the existing query batch runner
//! (`splitSql` + `execute_batch` in `src/lib/sqlSplit.ts` /
//! `commands::query::execute_batch`) instead of a second, parallel
//! execution path here (see `ImportSqlDialog.tsx`).
//!
//! Export writes in three global phases for Postgres/MySQL — bare
//! `CREATE TABLE`, then all data, then `ALTER TABLE ADD CONSTRAINT` (FK) +
//! `CREATE INDEX` — so a whole-database dump doesn't need a table-dependency
//! topological sort, and doesn't need elevated privileges (e.g. Postgres's
//! superuser-only `session_replication_role`) to load out of FK order.
//! SQLite instead dumps its catalog verbatim (higher fidelity than
//! reconstructing via `TableStructure` — it captures `CHECK` constraints
//! etc.) bracketed by `PRAGMA foreign_keys=OFF/ON`, since SQLite inlines FKs
//! into `CREATE TABLE` text that isn't worth re-parsing to split.

use crate::commands::query::{from_clause, nonblank, order_by_clause, select_list, TableScan};
use crate::commands::schema::{list_tables_inner, TableInfo};
use crate::commands::structure::{mysql_structure, pg_structure};
use crate::db::ddl::{build_create, TableStructure};
use crate::db::dump::{
    build_insert_statements, mysql_auto_increment_resync_stmt, mysql_literal, pg_literal,
    pg_sequence_resync_stmt, sqlite_literal,
};
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;
use sqlx::{Column, Row};
use std::io::Write;
use tauri::{AppHandle, Emitter, State};

/// How a table's existing data is treated relative to the rows being
/// exported. `TruncateInsert` prefixes each table's `INSERT` block with a
/// `DELETE FROM` so re-running the dump against a target that already has
/// conflicting rows replaces them instead of erroring on the primary key —
/// the "vaciar tabla e insertar" mode from the connection-level export
/// dialog. Plain `DELETE FROM` (not `TRUNCATE`) so the same code path works
/// unchanged across Postgres/MySQL/SQLite.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataMode {
    Insert,
    TruncateInsert,
}

/// Rows per multi-row `INSERT ... VALUES (...), (...);` statement
/// (mysqldump-style batching).
const BATCH_SIZE: usize = 500;

/// One database (or, for a multi-DB connection, one already-resolved
/// `<parent>::db::<name>` child) to include in an [`export_databases`] run.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTarget {
    /// Already resolved by the frontend — for a single-DB profile this is
    /// the profile id itself; for a multi-DB connection it's that
    /// database's synthetic child id (`openTrackedDatabaseView`), so this
    /// command never has to resolve or open pools itself.
    pub connection_id: String,
    /// Only used for the `-- Database: <name>` header comment separating
    /// targets in the combined output.
    pub database_name: String,
    /// `None` exports every table in this database; `Some` restricts it to
    /// the named subset (the export dialog's per-database table checkboxes).
    #[serde(default)]
    pub tables: Option<Vec<String>>,
}

/// Emitted by [`export_databases`] as each table's rows finish writing.
///
/// `done`/`total` are actual row counts, not tables — a schema with one
/// three-row table and one three-million-row table would make per-table
/// progress meaningless (a jump to 50% for nothing, then a long stall).
/// `total` comes from a `SELECT COUNT(*)` pass over every target's tables
/// before any writing starts: `TableInfo.row_count` (from `list_tables_inner`)
/// is only ever an approximate, engine-side statistic — stale on Postgres,
/// an InnoDB estimate on MySQL, always absent on SQLite — and its own doc
/// comment says as much. `emit_to`, not a broadcast `emit`, for the same
/// reason as `IMPORT_PROGRESS_EVENT` (gotcha #25): the export was
/// started from one window's dialog.
pub const EXPORT_PROGRESS_EVENT: &str = "huginndb://export-progress";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportProgress {
    pub done: i64,
    pub total: i64,
}

/// One target resolved to an open pool and its concrete table list, ready to
/// write — the shape [`export_databases`] needs twice: once to count rows,
/// once to actually dump them, without resolving pools or re-listing tables
/// a second time.
struct ResolvedExportTarget {
    database_name: String,
    pool: DbPool,
    tables: Vec<TableInfo>,
}

/// Export one or more databases — each optionally scoped to a subset of its
/// tables — into a SINGLE combined `.sql` file at `dest_path`. Replaces the
/// old `export_database` (always the connection's one implicit database, via
/// a Rust-side save dialog): the connection-level and per-database "Export
/// database…" menu actions both funnel into this command now, with one
/// target for a single-DB profile or per-database menu, several for a
/// multi-DB connection's "pick which databases" dialog. The frontend already
/// owns the save-path UI (a text field + native picker, mirroring HeidiSQL),
/// so — unlike `export_table`/`export_table_rows` — this command takes
/// `dest_path` directly instead of opening its own dialog. Rejects MongoDB.
#[tauri::command]
pub async fn export_databases(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    targets: Vec<ExportTarget>,
    data_mode: DataMode,
    dest_path: String,
) -> AppResult<String> {
    if targets.is_empty() {
        return Err(AppError::InvalidInput(
            "export_databases: no databases selected".into(),
        ));
    }

    let mut resolved = Vec::with_capacity(targets.len());
    for target in &targets {
        crate::commands::ensure_view(&app, &window, state.inner(), &target.connection_id).await;
        let pool = state.pool_for(&target.connection_id)?;
        if matches!(&pool, DbPool::Mongo(_)) {
            return Err(AppError::InvalidInput(format!(
                "database export is not supported for MongoDB (database: {})",
                target.database_name
            )));
        }

        let mut tables: Vec<TableInfo> = list_tables_inner(state.inner(), &target.connection_id)
            .await?
            .into_iter()
            .filter(|t| t.kind == "table")
            .collect();
        if let Some(names) = &target.tables {
            tables.retain(|t| names.contains(&t.name));
        }
        // Only what the person may export. A table they asked for by name and
        // may not export is refused rather than quietly left out — a dump that
        // silently lacks a table is worse than one that says why it failed. A
        // whole-database dump keeps what they may export and names nothing
        // else, the way the explorer does.
        let exportable = |t: &TableInfo| {
            crate::commands::guard::export(
                state.inner(),
                &target.connection_id,
                Some(&t.schema),
                &t.name,
            )
        };
        if target.tables.is_some() {
            for t in &tables {
                exportable(t)?;
            }
        } else {
            crate::commands::guard::endpoint(state.inner(), &target.connection_id)?;
            tables.retain(|t| exportable(t).is_ok());
        }
        resolved.push(ResolvedExportTarget {
            database_name: target.database_name.clone(),
            pool,
            tables,
        });
    }

    let mut total_rows: i64 = 0;
    for r in &resolved {
        let dialect = Dialect::try_of(&r.pool)?;
        for t in &r.tables {
            let qt = dialect.qualify(Some(&t.schema), &t.name);
            let count =
                crate::db::exec::scalar_i64(&r.pool, &format!("SELECT COUNT(*) FROM {qt}"), &[])
                    .await?
                    .unwrap_or(0);
            total_rows += count;
        }
    }

    let window_label = window.label().to_string();
    let mut done_rows: i64 = 0;
    let mut on_progress = move |just_written: i64| {
        done_rows += just_written;
        let _ = app.emit_to(
            &window_label,
            EXPORT_PROGRESS_EVENT,
            ExportProgress {
                done: done_rows,
                total: total_rows,
            },
        );
    };

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest_path)?);
    writeln!(
        w,
        "-- HuginnDB export — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    for r in &resolved {
        writeln!(w, "-- Database: {}\n", r.database_name)?;
        match &r.pool {
            DbPool::Postgres(p) => {
                export_pg(&mut w, p, &r.tables, data_mode, &mut on_progress).await?
            }
            DbPool::Mysql(p) => {
                export_mysql(&mut w, p, &r.tables, data_mode, &mut on_progress).await?
            }
            DbPool::Sqlite(p) => {
                export_sqlite(&mut w, p, &r.tables, data_mode, &mut on_progress).await?
            }
            // SQL Server export needs its own literal encoder (`0x…` binaries,
            // `N'…'` unicode strings) plus `SET IDENTITY_INSERT` bracketing
            // instead of the sequence/auto-increment resync the others do —
            // deferred, so refuse rather than emit a dump that won't load.
            DbPool::MsSql(_) => {
                return Err(AppError::UnsupportedDriver(
                    "database export is not supported for SQL Server yet".into(),
                ))
            }
            DbPool::Mongo(_) => unreachable!("rejected above"),
        }
    }
    w.flush()?;
    Ok(dest_path)
}

/// Reads a text file for the frontend-driven import flow (see module docs).
#[tauri::command]
pub fn read_text_file(file_path: String) -> AppResult<String> {
    Ok(std::fs::read_to_string(&file_path)?)
}

/// Largest image file accepted as an environment avatar, before downscaling.
/// The frontend shrinks whatever it gets to a 128px square, so this cap is not
/// about the stored size — it exists so a user who picks a 200 MB TIFF by
/// mistake gets a clear error instead of the webview base64-ing it into memory
/// twice and stalling.
const MAX_AVATAR_SOURCE_BYTES: u64 = 12 * 1024 * 1024;

/// Reads an image file and returns it as a `data:` URL for the frontend to
/// draw into a canvas and downscale (see `src/lib/environmentAvatar.ts`).
///
/// Why the backend is involved at all: the picker is the native dialog
/// (`@tauri-apps/plugin-dialog`'s `open()`, like every other file flow here),
/// which yields a *path*, and the webview can't read an arbitrary path itself.
/// The counterpart to [`read_text_file`], and just as narrow — except that it
/// does validate: the MIME type comes from the file's magic bytes rather than
/// its extension, so a `.png` that is really something else is rejected here
/// instead of silently producing a data URL no `<img>` will load. Nothing is
/// stored on this side; the resulting avatar lives in `Environment.icon`, which
/// the backend keeps opaque (see `tab_state.rs`).
#[tauri::command]
pub fn read_image_data_url(file_path: String) -> AppResult<String> {
    let len = std::fs::metadata(&file_path)?.len();
    if len > MAX_AVATAR_SOURCE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "image is too large ({:.1} MB); the limit is {} MB",
            len as f64 / (1024.0 * 1024.0),
            MAX_AVATAR_SOURCE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = std::fs::read(&file_path)?;
    let mime = sniff_image_mime(&bytes).ok_or_else(|| {
        AppError::InvalidInput("that file is not a PNG, JPEG, GIF, WebP or BMP image".into())
    })?;
    Ok(format!("data:{mime};base64,{}", B64.encode(&bytes)))
}

/// Magic-byte MIME sniff for the raster formats every webview can decode.
/// SVG is deliberately absent: an SVG without an intrinsic size draws as a
/// 0×0 image on canvas in WebKitGTK, so accepting one would produce a blank
/// avatar rather than an error.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

/// Writes a text file to a path the frontend already picked via the native
/// save dialog (`@tauri-apps/plugin-dialog`'s `save()`), for flows that have
/// nothing else to ask the backend to do — currently theme export
/// (`AppearanceSection.tsx`/`src/lib/themeTransfer.ts`): themes are plain
/// JSON that live entirely in the frontend's `localStorage`-backed theme
/// store, so there is no query, no encoding decision, nothing that belongs on
/// this side beyond the actual file write (which the webview sandbox can't do
/// itself). Deliberately as narrow as `read_text_file` — one path, one
/// string, no format opinion.
#[tauri::command]
pub fn write_text_file(file_path: String, contents: String) -> AppResult<()> {
    Ok(std::fs::write(&file_path, contents)?)
}

/// Export a single table (schema + data) to a user-chosen `.sql` file — the
/// same DDL+data format [`export_databases`] produces, scoped to one table.
/// Always plain `INSERT` ([`DataMode::Insert`]) — this is the DataGrid
/// toolbar's "Export the full table", not the connection-level dialog, so it
/// has no data-mode control of its own. Rejects MongoDB; collections use
/// [`crate::commands::mongo::export_collection`] instead.
#[tauri::command]
pub async fn export_table(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<String> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::export(state.inner(), &connection_id, schema.as_deref(), &table)?;
    let pool = state.pool_for(&connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "table export is not supported for MongoDB; use \"Export collection\" instead".into(),
        ));
    }

    let tables: Vec<_> = list_tables_inner(state.inner(), &connection_id)
        .await?
        .into_iter()
        .filter(|t| {
            t.kind == "table"
                && t.name == table
                && schema.as_deref().map_or(true, |s| t.schema == s)
        })
        .collect();
    if tables.is_empty() {
        return Err(AppError::InvalidInput(format!("table not found: {table}")));
    }

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{table}.sql");
    let path = app
        .dialog()
        .file()
        .set_title("Export table")
        .set_file_name(&suggested)
        .add_filter("SQL", &["sql"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer(crate::error::EXPORT_CANCELLED.into()))?;
    let dest = path.to_string();

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    writeln!(
        w,
        "-- HuginnDB export of {connection_id}.{table} — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    // Nothing observes this single-table export's progress today — the
    // DataGrid toolbar action that triggers it has no notification handoff
    // like `export_databases` does — so the callback is a no-op rather than
    // wiring up an event nobody listens for.
    let mut no_progress = |_rows: i64| {};
    match pool {
        DbPool::MsSql(_) => {
            return Err(AppError::UnsupportedDriver(
                "table export is not supported for SQL Server yet".into(),
            ))
        }
        DbPool::Postgres(p) => {
            export_pg(&mut w, &p, &tables, DataMode::Insert, &mut no_progress).await?
        }
        DbPool::Mysql(p) => {
            export_mysql(&mut w, &p, &tables, DataMode::Insert, &mut no_progress).await?
        }
        DbPool::Sqlite(p) => {
            export_sqlite(&mut w, &p, &tables, DataMode::Insert, &mut no_progress).await?
        }
        DbPool::Mongo(_) => unreachable!("rejected above"),
    }
    w.flush()?;
    Ok(dest)
}

/// Export the rows of `schema.table` matching `filters`/`search` as `INSERT`
/// statements, without any DDL — the filtered-data counterpart of
/// [`export_table`], driven by the same [`ColumnFilter`] shape the grid's
/// query panel builds. No pagination limit: every matching row is written,
/// not just the current page. Rejects MongoDB.
///
/// **It writes what the grid shows**: the browse's projection becomes the
/// `SELECT` list (so each `INSERT` names only those columns, and a column left
/// out takes its default on the way back in) and its sort becomes the
/// `ORDER BY`, so the file reads in the order the grid did.
#[tauri::command]
pub async fn export_table_rows(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    query: TableScan,
) -> AppResult<String> {
    let TableScan {
        connection_id,
        schema,
        table,
        filter,
        order,
        projection,
        collation,
        hint,
    } = query;
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::export(state.inner(), &connection_id, schema.as_deref(), &table)?;
    crate::commands::guard::raw_filter(state.inner(), &connection_id, &filter)?;
    let pool = state.pool_for(&connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "row export is not supported for MongoDB here; use \"Export collection\" instead"
                .into(),
        ));
    }
    if matches!(&pool, DbPool::MsSql(_)) {
        return Err(AppError::UnsupportedDriver(
            "row export is not supported for SQL Server yet".into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;
    // The same clause the browse runs, the expression included.
    let (where_clause, binds) = filter.clause(dialect)?;
    let qt = dialect.qualify(schema.as_deref(), &table);
    let select = select_list(dialect, projection.as_ref())?;
    let order_clause = order_by_clause(dialect, &order, nonblank(&collation))?;
    let from = from_clause(dialect, &qt, nonblank(&hint))?;
    let select_sql = format!("SELECT {select} FROM {from}{where_clause}{order_clause}");

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{table}_rows.sql");
    let path = app
        .dialog()
        .file()
        .set_title("Export query results")
        .set_file_name(&suggested)
        .add_filter("SQL", &["sql"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer(crate::error::EXPORT_CANCELLED.into()))?;
    let dest = path.to_string();

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    writeln!(
        w,
        "-- HuginnDB filtered export of {connection_id}.{table} — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    // No `TableStructure` is available here (this is a plain filtered
    // `SELECT`, not a table dump), so the quoted column list comes from the
    // fetched rows' own metadata — the same technique `export_sqlite` already
    // uses for its per-row dump.
    match &pool {
        DbPool::MsSql(_) => unreachable!("sql server rejected above"),
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Postgres.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| (0..quoted_cols.len()).map(|i| pg_literal(row, i)).collect())
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Mysql.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| {
                        (0..quoted_cols.len())
                            .map(|i| mysql_literal(row, i))
                            .collect()
                    })
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Sqlite.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| {
                        (0..quoted_cols.len())
                            .map(|i| sqlite_literal(row, i))
                            .collect()
                    })
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Mongo(_) => unreachable!("rejected above"),
    }
    w.flush()?;
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

struct CachedTable {
    create: String,
    tail: Vec<String>,
    structure: TableStructure,
    qt: String,
}

async fn export_pg(
    w: &mut impl Write,
    pool: &sqlx::PgPool,
    tables: &[TableInfo],
    data_mode: DataMode,
    on_progress: &mut impl FnMut(i64),
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        // `build_create` (not `build_ddl`) deliberately skips
        // `validate_structure`'s default-expression allowlist, which exists
        // to gate *user-typed* structure-editor input — catalog-sourced
        // defaults (e.g. Postgres's `'foo'::text` cast-style defaults) are
        // common and would otherwise be rejected outright.
        let structure = pg_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Dialect::Postgres, &structure)?;
        let create = stmts.remove(0);
        let qt = Dialect::Postgres.qualify(structure.schema.as_deref(), &structure.name);
        cached.push(CachedTable {
            create,
            tail: stmts,
            structure,
            qt,
        });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| Dialect::Postgres.quote_ident(&col.name))
            .collect();
        let auto_idx = c
            .structure
            .columns
            .iter()
            .position(|col| col.auto_increment);

        let rows = sqlx::query(&format!("SELECT * FROM {}", c.qt))
            .fetch_all(pool)
            .await?;
        let mut max_val: Option<i64> = None;
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                if let Some(i) = auto_idx {
                    if let Ok(v) = row.try_get::<i64, _>(i) {
                        max_val = Some(max_val.map_or(v, |m| m.max(v)));
                    }
                }
                (0..quoted_cols.len()).map(|i| pg_literal(row, i)).collect()
            })
            .collect();

        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {};\n", c.qt)?;
        }
        for stmt in build_insert_statements(&c.qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
        if let (Some(i), Some(max_val)) = (auto_idx, max_val) {
            let unquoted_table = match &c.structure.schema {
                Some(s) if !s.is_empty() => format!("{s}.{}", c.structure.name),
                _ => c.structure.name.clone(),
            };
            let col_name = &c.structure.columns[i].name;
            writeln!(
                w,
                "{};\n",
                pg_sequence_resync_stmt(&unquoted_table, col_name, max_val)
            )?;
        }
        on_progress(literal_rows.len() as i64);
    }

    for c in &cached {
        for stmt in &c.tail {
            writeln!(w, "{stmt};\n")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async fn export_mysql(
    w: &mut impl Write,
    pool: &sqlx::MySqlPool,
    tables: &[TableInfo],
    data_mode: DataMode,
    on_progress: &mut impl FnMut(i64),
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        let structure = mysql_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Dialect::Mysql, &structure)?;
        let create = stmts.remove(0);
        let qt = Dialect::Mysql.qualify(None, &structure.name);
        cached.push(CachedTable {
            create,
            tail: stmts,
            structure,
            qt,
        });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| Dialect::Mysql.quote_ident(&col.name))
            .collect();
        let auto_idx = c
            .structure
            .columns
            .iter()
            .position(|col| col.auto_increment);

        let rows = sqlx::query(&format!("SELECT * FROM {}", c.qt))
            .fetch_all(pool)
            .await?;
        let mut max_val: Option<i64> = None;
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                if let Some(i) = auto_idx {
                    if let Ok(v) = row.try_get::<i64, _>(i) {
                        max_val = Some(max_val.map_or(v, |m| m.max(v)));
                    }
                }
                (0..quoted_cols.len())
                    .map(|i| mysql_literal(row, i))
                    .collect()
            })
            .collect();

        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {};\n", c.qt)?;
        }
        for stmt in build_insert_statements(&c.qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
        if let Some(max_val) = max_val {
            writeln!(w, "{};\n", mysql_auto_increment_resync_stmt(&c.qt, max_val))?;
        }
        on_progress(literal_rows.len() as i64);
    }

    for c in &cached {
        for stmt in &c.tail {
            writeln!(w, "{stmt};\n")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/// `tables` scopes the dump to exactly those tables — resolved by the caller
/// via `list_tables_inner` the same way as [`export_pg`]/[`export_mysql`], so
/// SQLite's "every table" case is just the caller's unfiltered list rather
/// than a `None` this function has to special-case.
async fn export_sqlite(
    w: &mut impl Write,
    pool: &sqlx::SqlitePool,
    tables: &[TableInfo],
    data_mode: DataMode,
    on_progress: &mut impl FnMut(i64),
) -> AppResult<()> {
    if tables.is_empty() {
        return Ok(());
    }
    // `sqlx::query` takes a runtime `&str` (not the compile-time-checked
    // `query!` macro), so the `IN (?, ?, …)` placeholder list can be built to
    // match the filter's length rather than hard-coding an arity.
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    let placeholders = names.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

    let table_sql = format!(
        "SELECT name, sql FROM sqlite_master \
         WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
         AND name IN ({placeholders}) ORDER BY name"
    );
    let mut tq = sqlx::query(&table_sql);
    for n in &names {
        tq = tq.bind(n);
    }
    let table_rows = tq.fetch_all(pool).await?;

    let index_sql = format!(
        "SELECT sql FROM sqlite_master \
         WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
         AND tbl_name IN ({placeholders}) ORDER BY name"
    );
    let mut iq = sqlx::query(&index_sql);
    for n in &names {
        iq = iq.bind(n);
    }
    let index_rows = iq.fetch_all(pool).await?;

    writeln!(w, "PRAGMA foreign_keys=OFF;\n")?;
    for r in &table_rows {
        let sql: String = r.get("sql");
        writeln!(w, "{sql};\n")?;
    }

    for r in &table_rows {
        let name: String = r.get("name");
        let quoted = Dialect::Sqlite.quote_ident(&name);
        let rows = sqlx::query(&format!("SELECT * FROM {quoted}"))
            .fetch_all(pool)
            .await?;
        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {quoted};\n")?;
        }
        if rows.is_empty() {
            on_progress(0);
            continue;
        }
        // No `TableStructure` is built for SQLite (schema is dumped verbatim
        // from `sqlite_master`), so the column list comes straight from the
        // fetched rows' own metadata instead.
        let quoted_cols: Vec<String> = rows[0]
            .columns()
            .iter()
            .map(|c| Dialect::Sqlite.quote_ident(c.name()))
            .collect();
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                (0..quoted_cols.len())
                    .map(|i| sqlite_literal(row, i))
                    .collect()
            })
            .collect();
        for stmt in build_insert_statements(&quoted, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
        on_progress(literal_rows.len() as i64);
    }

    for r in &index_rows {
        let sql: String = r.get("sql");
        writeln!(w, "{sql};\n")?;
    }
    writeln!(w, "PRAGMA foreign_keys=ON;\n")?;
    Ok(())
}
