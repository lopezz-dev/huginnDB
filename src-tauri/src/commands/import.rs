//! Import a CSV, JSON or Excel file into an existing SQL table (ADR #139).
//!
//! Two commands. [`preview_import_file`] reads the file the person picked and
//! returns its columns and first rows for the dialog's mapping — no database
//! is touched. [`import_table_file`] reads it again, applies the mapping the
//! person settled on, and inserts every row through the paste's core
//! (`insert::insert_in_tx`): chunked multi-row `INSERT`s in **one**
//! transaction, so a file goes in whole or not at all.
//!
//! The file is read here, never in the frontend, for the reasons ADR #33
//! gives for pasted text: the catalogue is here, and the catalogue is what
//! turns a header into a column name safely (convention #4) and decides what
//! a value means for a column ([`cell_bind`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::commands::insert::{
    coerce_value, insert_in_tx, is_boolean_column, InsertColumn, InsertRowsSummary, Locate,
};
use crate::commands::schema::{list_columns_inner, ColumnInfo};
use crate::db::import_file::{read_file, ImportFormat, ReadOptions, Sheet};
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::log_bus::LogSink;
use crate::state::{AppState, DbPool};

/// Rows of the file the preview carries — enough to recognise each column
/// by its values, few enough that a wide file crosses IPC in a blink.
pub const PREVIEW_ROWS: usize = 20;

/// What the dialog shows before anything is written. `ImportPreview` in
/// `src/types.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub format: ImportFormat,
    pub columns: Vec<String>,
    /// The first [`PREVIEW_ROWS`] rows, each with one cell per column.
    pub sample: Vec<Vec<Value>>,
    pub total_rows: usize,
    pub delimiter: Option<char>,
    pub encoding: Option<&'static str>,
    pub sheets: Vec<String>,
    pub sheet: Option<String>,
}

impl From<Sheet> for ImportPreview {
    fn from(mut sheet: Sheet) -> Self {
        let total_rows = sheet.rows.len();
        sheet.rows.truncate(PREVIEW_ROWS);
        Self {
            format: sheet.format,
            columns: sheet.columns,
            sample: sheet.rows,
            total_rows,
            delimiter: sheet.delimiter,
            encoding: sheet.encoding,
            sheets: sheet.sheets,
            sheet: sheet.sheet,
        }
    }
}

/// One table column and the file column that fills it, by its index in the
/// file's columns (a header may repeat; an index cannot). A table column
/// left out of the mapping is not written, so it takes its default.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSource {
    pub column: String,
    pub source: usize,
}

/// Read the file at `path` for the import dialog.
///
/// Touches no database, so it asks nothing of the policy (`none` in
/// `guard::HUMAN_POLICY`, like `dump::read_text_file`): the person picked the
/// file, and what may be *written* is [`import_table_file`]'s question.
#[tauri::command]
pub async fn preview_import_file(path: String, options: ReadOptions) -> AppResult<ImportPreview> {
    let sheet = read_off_thread(path, options).await?;
    Ok(sheet.into())
}

/// Insert every row of the file at `path` into `schema.table`, its columns
/// filled as `mapping` says, in one transaction.
///
/// `empty_as_null`: an empty CSV field or Excel text cell is SQL `NULL` —
/// how the export writes one — rather than an empty string. Ignored for
/// JSON, which writes `null` and `""` apart.
// Flat argument list is the IPC surface — same note as `insert_rows`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn import_table_file(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    path: String,
    options: ReadOptions,
    mapping: Vec<ColumnSource>,
    empty_as_null: bool,
) -> AppResult<InsertRowsSummary> {
    let sink = crate::commands::entry_sink(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
    )?;
    // The columns an import writes are the mapping's, whatever the file
    // holds besides (ADR #113).
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::INSERT,
        mapping.iter().map(|m| &m.column),
    )?;
    import_table_file_inner(
        &sink,
        state.inner(),
        ImportRequest {
            connection_id,
            schema,
            table,
            path,
            options,
            mapping,
            empty_as_null,
        },
    )
    .await
}

/// [`import_table_file`]'s arguments, past the policy.
pub(crate) struct ImportRequest {
    pub connection_id: String,
    pub schema: Option<String>,
    pub table: String,
    pub path: String,
    pub options: ReadOptions,
    pub mapping: Vec<ColumnSource>,
    pub empty_as_null: bool,
}

/// Tauri-independent core of [`import_table_file`].
pub(crate) async fn import_table_file_inner(
    sink: &dyn LogSink,
    state: &AppState,
    req: ImportRequest,
) -> AppResult<InsertRowsSummary> {
    let pool = state.pool_for(&req.connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::UnsupportedDriver(
            "import: a file is imported into a SQL table — for a MongoDB collection use \
             \"Import JSON\""
                .into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;
    if req.mapping.is_empty() {
        return Err(AppError::InvalidInput(
            "import: no column is mapped, so there is nothing to import".into(),
        ));
    }

    // Everything up to `insert_in_tx` is validation, before the pool is
    // written to.
    let sheet = read_off_thread(req.path, req.options).await?;
    if sheet.rows.is_empty() {
        return Err(AppError::InvalidInput(
            "import: the file has no rows to import".into(),
        ));
    }
    let catalog = list_columns_inner(
        state,
        &req.connection_id,
        req.schema.clone(),
        req.table.clone(),
    )
    .await?;
    let plan = resolve_mapping(&catalog, &req.mapping, sheet.columns.len())?;
    // JSON writes `null` and `""` apart, so an empty string there is one;
    // only CSV and Excel, where the two look alike, read it as `NULL`.
    let empty_as_null = req.empty_as_null && sheet.format != ImportFormat::Json;
    let values: Vec<Vec<Option<String>>> = sheet
        .rows
        .iter()
        .map(|row| {
            plan.iter()
                .map(|(col, src)| cell_bind(&row[*src], col, empty_as_null))
                .collect()
        })
        .collect();

    let qt = dialect.qualify_defaulted(req.schema.as_deref(), &req.table);
    let columns = plan.into_iter().map(|(c, _)| c).collect();
    insert_in_tx(
        sink,
        &req.connection_id,
        &pool,
        &qt,
        columns,
        values,
        Locate::FailingRow,
    )
    .await
    .map_err(|f| {
        let place = match f.row {
            Some(i) if sheet.format == ImportFormat::Json => {
                format!("item {} of the file", i + 1)
            }
            Some(i) => format!("row {} of the file", sheet.first_row_offset + i + 1),
            None => "the import".into(),
        };
        AppError::InvalidInput(format!(
            "import: {place} could not be inserted, so nothing was imported — {}",
            f.error
        ))
    })
}

/// The file read on a blocking thread: a 200 000-row workbook takes long
/// enough to parse that it must not hold the async runtime.
async fn read_off_thread(path: String, options: ReadOptions) -> AppResult<Sheet> {
    tokio::task::spawn_blocking(move || read_file(&PathBuf::from(path), &options))
        .await
        .map_err(|e| AppError::InvalidInput(format!("import: reading the file failed — {e}")))?
}

/// The mapping checked against the catalogue and the file: each table column
/// exists (its catalogue spelling is what reaches the SQL — convention #4),
/// is named once, and takes a column the file has. In catalogue order, so the
/// statement is deterministic and reads like the grid.
fn resolve_mapping(
    catalog: &[ColumnInfo],
    mapping: &[ColumnSource],
    file_columns: usize,
) -> AppResult<Vec<(InsertColumn, usize)>> {
    let mut plan: Vec<(usize, InsertColumn, usize)> = Vec::with_capacity(mapping.len());
    for m in mapping {
        let (rank, hit) = catalog
            .iter()
            .enumerate()
            .find(|(_, c)| c.name.eq_ignore_ascii_case(&m.column))
            .ok_or_else(|| {
                AppError::InvalidInput(format!("import: this table has no column \"{}\"", m.column))
            })?;
        if plan.iter().any(|(r, _, _)| *r == rank) {
            return Err(AppError::InvalidInput(format!(
                "import: column \"{}\" is mapped twice",
                hit.name
            )));
        }
        if m.source >= file_columns {
            return Err(AppError::InvalidInput(format!(
                "import: column \"{}\" is mapped to file column {}, but the file has {} — \
                 did it change since the preview?",
                hit.name,
                m.source + 1,
                file_columns
            )));
        }
        plan.push((
            rank,
            InsertColumn {
                name: hit.name.clone(),
                data_type: Some(hit.data_type.clone()),
            },
            m.source,
        ));
    }
    plan.sort_by_key(|(rank, _, _)| *rank);
    Ok(plan.into_iter().map(|(_, c, s)| (c, s)).collect())
}

/// One file cell as the textual bind for `column` (ADR #5), on top of the
/// paste's [`coerce_value`]:
///
/// - an empty string is `NULL` when `empty_as_null` (how the export writes a
///   `NULL`, and what an empty spreadsheet cell nearly always means);
/// - `true`/`false` text into a boolean column is `1`/`0` — the CSV export
///   writes a boolean as a word, and MySQL's `tinyint(1)` will not take it;
/// - `3,14` into a numeric column is `3.14`, when it has exactly one comma
///   and no dot: a Spanish Excel's decimal comma. A numeric column could not
///   take it as written, so this never changes a value that would import.
pub(crate) fn cell_bind(v: &Value, column: &InsertColumn, empty_as_null: bool) -> Option<String> {
    let ty = column.data_type.as_deref();
    match v {
        Value::String(s) if s.is_empty() && empty_as_null => None,
        Value::String(s) if is_boolean_column(ty) => {
            Some(match s.trim().to_ascii_lowercase().as_str() {
                "true" => "1".into(),
                "false" => "0".into(),
                _ => s.clone(),
            })
        }
        Value::String(s) if is_numeric_column(ty) && is_decimal_comma(s.trim()) => {
            Some(s.trim().replace(',', "."))
        }
        other => coerce_value(other, column),
    }
}

/// Whether `data_type` is a numeric type on any of the four engines, judged
/// by its first word (`decimal(10,2) unsigned` is `decimal`).
fn is_numeric_column(data_type: Option<&str>) -> bool {
    let Some(t) = data_type else { return false };
    let lower = t.trim().to_ascii_lowercase();
    let word = lower
        .split(|c: char| c == '(' || c.is_whitespace())
        .next()
        .unwrap_or("");
    matches!(
        word,
        "int"
            | "integer"
            | "smallint"
            | "bigint"
            | "tinyint"
            | "mediumint"
            | "int2"
            | "int4"
            | "int8"
            | "decimal"
            | "numeric"
            | "dec"
            | "real"
            | "float"
            | "float4"
            | "float8"
            | "double"
            | "money"
            | "smallmoney"
            | "number"
    )
}

/// `[+-]digits,digits` — one comma, no dot, nothing else.
fn is_decimal_comma(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let Some((int, frac)) = body.split_once(',') else {
        return false;
    };
    !int.is_empty()
        && !frac.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(data_type: &str) -> InsertColumn {
        InsertColumn {
            name: "c".into(),
            data_type: Some(data_type.into()),
        }
    }

    fn cat(specs: &[(&str, &str)]) -> Vec<ColumnInfo> {
        specs
            .iter()
            .map(|(name, data_type)| ColumnInfo {
                name: name.to_string(),
                data_type: data_type.to_string(),
                nullable: true,
                is_primary_key: false,
                referenced_schema: None,
                referenced_table: None,
                referenced_column: None,
            })
            .collect()
    }

    fn map(column: &str, source: usize) -> ColumnSource {
        ColumnSource {
            column: column.into(),
            source,
        }
    }

    #[test]
    fn an_empty_cell_is_null_only_when_asked() {
        assert_eq!(cell_bind(&json!(""), &col("text"), true), None);
        assert_eq!(
            cell_bind(&json!(""), &col("text"), false),
            Some(String::new())
        );
        assert_eq!(cell_bind(&Value::Null, &col("text"), false), None);
    }

    #[test]
    fn boolean_words_become_bits_for_a_boolean_column() {
        assert_eq!(
            cell_bind(&json!("TRUE"), &col("tinyint(1)"), true).as_deref(),
            Some("1")
        );
        assert_eq!(
            cell_bind(&json!("false"), &col("boolean"), true).as_deref(),
            Some("0")
        );
        assert_eq!(
            cell_bind(&json!("true"), &col("varchar(5)"), true).as_deref(),
            Some("true")
        );
        // An Excel boolean cell takes the paste's path.
        assert_eq!(
            cell_bind(&json!(true), &col("bit"), true).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn a_decimal_comma_becomes_a_dot_only_in_a_numeric_column() {
        let n = |v: &str, t: &str| cell_bind(&json!(v), &col(t), true);
        assert_eq!(n("3,14", "decimal(10,2)").as_deref(), Some("3.14"));
        assert_eq!(n("-0,5", "double precision").as_deref(), Some("-0.5"));
        assert_eq!(n("1,5", "float").as_deref(), Some("1.5"));
        // Not a decimal comma: left for the server to judge.
        assert_eq!(n("1.234,5", "decimal").as_deref(), Some("1.234,5"));
        assert_eq!(n("1,2,3", "int").as_deref(), Some("1,2,3"));
        // Not a numeric column: text stays as written.
        assert_eq!(n("3,14", "varchar(10)").as_deref(), Some("3,14"));
    }

    #[test]
    fn an_excel_number_binds_as_its_text() {
        assert_eq!(
            cell_bind(&json!(3), &col("int"), true).as_deref(),
            Some("3")
        );
        assert_eq!(
            cell_bind(&json!(3.25), &col("real"), true).as_deref(),
            Some("3.25")
        );
    }

    #[test]
    fn the_mapping_takes_catalogue_spelling_and_order() {
        let catalog = cat(&[("Id", "int"), ("Name", "text"), ("Note", "text")]);
        let plan = resolve_mapping(&catalog, &[map("note", 0), map("ID", 2)], 3).unwrap();
        let names: Vec<_> = plan.iter().map(|(c, s)| (c.name.as_str(), *s)).collect();
        assert_eq!(names, [("Id", 2), ("Note", 0)]);
        assert_eq!(plan[0].0.data_type.as_deref(), Some("int"));
    }

    #[test]
    fn a_bad_mapping_is_refused_before_the_server() {
        let catalog = cat(&[("id", "int"), ("name", "text")]);
        let err = |m: &[ColumnSource]| resolve_mapping(&catalog, m, 2).unwrap_err().to_string();
        assert!(err(&[map("ghost", 0)]).contains("no column \"ghost\""));
        assert!(err(&[map("id", 0), map("ID", 1)]).contains("mapped twice"));
        assert!(err(&[map("id", 5)]).contains("the file has 2"));
    }

    // ── Against a real SQLite: the whole path, file to table ─────────────────

    use crate::log_bus::LogEntry;
    use crate::state::ActivePool;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    struct Quiet;
    impl LogSink for Quiet {
        fn log(&self, _: LogEntry) {}
    }

    /// A state with connection `c` on a fresh SQLite file holding
    /// `items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL,
    /// ok BOOLEAN, note TEXT DEFAULT 'none')`, and a scratch directory.
    async fn sqlite_state(name: &str) -> (AppState, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("huginndb-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(dir.join("db.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, \
             ok BOOLEAN, note TEXT DEFAULT 'none')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState::new();
        state
            .connections
            .write()
            .insert("c".into(), ActivePool::bare(DbPool::Sqlite(pool)));
        (state, dir)
    }

    type Item = (i64, String, Option<f64>, Option<bool>, Option<String>);

    async fn items(state: &AppState) -> Vec<Item> {
        let Ok(DbPool::Sqlite(p)) = state.pool_for("c") else {
            unreachable!()
        };
        sqlx::query_as("SELECT id, name, price, ok, note FROM items ORDER BY id")
            .fetch_all(&p)
            .await
            .unwrap()
    }

    fn request(path: &std::path::Path, mapping: Vec<ColumnSource>) -> ImportRequest {
        ImportRequest {
            connection_id: "c".into(),
            schema: None,
            table: "items".into(),
            path: path.to_string_lossy().into_owned(),
            options: ReadOptions::default(),
            mapping,
            empty_as_null: true,
        }
    }

    /// The bytes `result_export` writes for a CSV `;` export of this table:
    /// BOM, CRLF, `NULL` as an empty field, booleans as words — plus a
    /// decimal comma, as a Spanish Excel leaves it after an edit.
    #[tokio::test]
    async fn a_csv_export_imports_back_whole() {
        let (state, dir) = sqlite_state("csv").await;
        let file = dir.join("items.csv");
        std::fs::write(
            &file,
            "\u{FEFF}id;name;price;ok;note\r\n1;Tornillo;0,25;true;\r\n2;\"Tuerca; M6\";3.5;false;x\r\n",
        )
        .unwrap();
        let mapping = ["id", "name", "price", "ok", "note"]
            .iter()
            .enumerate()
            .map(|(i, c)| map(c, i))
            .collect();
        let out = import_table_file_inner(&Quiet, &state, request(&file, mapping))
            .await
            .unwrap();
        assert_eq!(out.inserted, 2);
        assert_eq!(
            items(&state).await,
            vec![
                (1, "Tornillo".into(), Some(0.25), Some(true), None),
                (
                    2,
                    "Tuerca; M6".into(),
                    Some(3.5),
                    Some(false),
                    Some("x".into())
                ),
            ]
        );
    }

    #[tokio::test]
    async fn an_unmapped_column_takes_its_default() {
        let (state, dir) = sqlite_state("default").await;
        let file = dir.join("items.json");
        std::fs::write(&file, r#"[{"name": "", "id": 7, "extra": "ignored"}]"#).unwrap();
        // JSON columns are alphabetical: extra, id, name.
        let req = request(&file, vec![map("id", 1), map("name", 2)]);
        import_table_file_inner(&Quiet, &state, req).await.unwrap();
        assert_eq!(
            items(&state).await,
            // `""` stays an empty string in JSON, even with "empty is NULL".
            vec![(7, "".into(), None, None, Some("none".into()))]
        );
    }

    #[tokio::test]
    async fn a_failing_row_is_named_and_nothing_is_written() {
        let (state, dir) = sqlite_state("fail").await;
        let file = dir.join("items.csv");
        std::fs::write(&file, "id,name\n1,a\n2,b\n2,dup\n3,c\n").unwrap();
        let req = request(&file, vec![map("id", 0), map("name", 1)]);
        let err = import_table_file_inner(&Quiet, &state, req)
            .await
            .unwrap_err()
            .to_string();
        // Header is line 1, so the third data row is row 4 of the file.
        assert!(err.contains("row 4 of the file"), "{err}");
        assert!(err.contains("nothing was imported"), "{err}");
        assert!(items(&state).await.is_empty());
    }

    /// Past one statement's bind ceiling the rows go in several chunks, and
    /// a row that fails in a later chunk is still found — by replaying the
    /// chunks before it.
    #[tokio::test]
    async fn a_failing_row_in_a_later_chunk_is_found() {
        let (state, dir) = sqlite_state("chunks").await;
        let file = dir.join("items.csv");
        // 2 columns → 16 383 rows per SQLite statement.
        let mut text = String::from("id,name\n");
        for i in 1..=20_000 {
            text.push_str(&format!("{i},n{i}\n"));
        }
        text.push_str("17,clash\n");
        std::fs::write(&file, &text).unwrap();
        let req = request(&file, vec![map("id", 0), map("name", 1)]);
        let err = import_table_file_inner(&Quiet, &state, req)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("row 20002 of the file"), "{err}");
        assert!(items(&state).await.is_empty());

        // Without the clash, all of them, in one transaction of two chunks.
        let text = text.trim_end().rsplit_once('\n').unwrap().0.to_string();
        std::fs::write(&file, text).unwrap();
        let req = request(&file, vec![map("id", 0), map("name", 1)]);
        let out = import_table_file_inner(&Quiet, &state, req).await.unwrap();
        assert_eq!((out.inserted, out.statements), (20_000, 2));
    }

    #[test]
    fn numeric_types_are_recognised_across_engines() {
        for t in [
            "int",
            "INTEGER",
            "bigint unsigned",
            "decimal(10,2)",
            "numeric",
            "money",
        ] {
            assert!(is_numeric_column(Some(t)), "{t}");
        }
        for t in ["varchar(10)", "text", "date", "interval", "json"] {
            assert!(!is_numeric_column(Some(t)), "{t}");
        }
    }
}
