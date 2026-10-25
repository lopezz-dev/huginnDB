//! MongoDB per-collection data import/export (#65) — the Mongo counterpart of
//! the SQL whole-database `.sql` dump in [`crate::commands::dump`] (which
//! rejects Mongo outright).
//!
//! Format: **canonical MongoDB Extended JSON**, so `ObjectId`/`Date`/`Long`/
//! `Decimal128`/… survive a round-trip with their types intact, unlike the
//! display-lossy [`crate::db::mongo::values::bson_to_json`] the grid uses.
//! Export serializes each document via `bson`'s own `into_canonical_extjson`;
//! import parses each entry with `bson`'s own `Bson::try_from::<serde_json::
//! Value>` (which understands both canonical and relaxed Extended JSON) and
//! `insert_many`s the batch. Both are unlocked by the `serde_json-1` feature on
//! the `bson` crate (see `Cargo.toml`), so fidelity matches MongoDB's spec for
//! every BSON type — not just the common tags the grid's own converter handles.

use crate::commands::query::{nonblank, Projection, SortSpec, TableFilter};
use crate::db::mongo::query::{parse_collation, predicate_doc, projection_doc, sort_doc};
use crate::db::mongo::schema::resolve_db;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::Value;
use std::convert::TryFrom;
use std::io::Write;
use tauri::{AppHandle, State};

fn mongo_conn(pool: &DbPool) -> AppResult<&crate::state::MongoConn> {
    match pool {
        DbPool::Mongo(conn) => Ok(conn),
        _ => Err(AppError::InvalidInput(
            "collection import/export is only supported for MongoDB; use \"Export database\" for the SQL drivers".into(),
        )),
    }
}

/// What "export query results" narrows a collection to: the browse's
/// predicate (its chips *and* its free-text search), sort and projection,
/// without its paging. Flattened like `TableScan`, so the payload is the same
/// flat shape the grid already sends for a SQL export.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionScan {
    #[serde(flatten)]
    pub filter: TableFilter,
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(default)]
    pub projection: Option<Projection>,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
}

/// Export the documents of `collection` to a user-chosen `.json` file as a
/// canonical Extended JSON array. Streams straight from the cursor to the file
/// so a large collection isn't fully buffered in memory. Returns the written
/// path; rejects if the user cancels the save dialog.
///
/// `scan` absent is "export the full collection". Present, it is "export query
/// results", and it writes what the grid shows: the same filter
/// `fetch_collection_data` builds (the free-text search included — it used to
/// be dropped here, so an export under a search wrote documents the grid was
/// not showing), in the grid's order, with the grid's projection.
#[tauri::command]
pub async fn export_collection(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    scan: Option<CollectionScan>,
) -> AppResult<String> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::export(state.inner(), &connection_id, None, &collection)?;
    let pool = state.pool_for(&connection_id)?;
    let conn = mongo_conn(&pool)?;
    let db = resolve_db(conn)?;
    let scan = scan.unwrap_or_default();

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{collection}.json");
    let path = app
        .dialog()
        .file()
        .set_title("Export collection")
        .set_file_name(&suggested)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer(crate::error::EXPORT_CANCELLED.into()))?;
    let dest = path.to_string();

    let coll = db.collection::<Document>(&collection);
    let query_filter = predicate_doc(&scan.filter)?;
    let mut find = coll.find(query_filter);
    if let Some(sort) = sort_doc(&scan.order) {
        find = find.sort(sort);
    }
    if let Some(projection) = projection_doc(scan.projection.as_ref()) {
        find = find.projection(projection);
    }
    if let Some(c) = nonblank(&scan.collation).map(parse_collation).transpose()? {
        find = find.collation(c);
    }
    if let Some(h) = nonblank(&scan.hint) {
        find = find.hint(mongodb::options::Hint::Name(h.to_string()));
    }
    let mut cursor = find.await?;
    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    write!(w, "[")?;
    let mut first = true;
    while cursor.advance().await? {
        let document = cursor.deserialize_current()?;
        let ext = Bson::Document(document).into_canonical_extjson();
        if !first {
            write!(w, ",")?;
        }
        first = false;
        write!(w, "\n  ")?;
        serde_json::to_writer(&mut w, &ext)?;
    }
    write!(w, "\n]\n")?;
    w.flush()?;
    Ok(dest)
}

/// Import documents from a JSON file into `collection` and return how many were
/// inserted. Accepts a canonical/relaxed Extended JSON **array**, a single
/// **object**, or newline-delimited JSON (mongoexport's default `--type=json`
/// shape). Server-generated `_id`s are kept as written when present.
#[tauri::command]
pub async fn import_collection(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    file_path: String,
) -> AppResult<u64> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::INSERT,
    )?;
    let pool = state.pool_for(&connection_id)?;
    let conn = mongo_conn(&pool)?;
    let db = resolve_db(conn)?;

    let text = std::fs::read_to_string(&file_path)?;
    let docs = parse_documents(&text)?;
    if docs.is_empty() {
        return Ok(0);
    }
    crate::commands::guard::columns(
        state.inner(),
        &connection_id,
        None,
        &collection,
        crate::db::sql::Verbs::INSERT,
        docs.iter().flat_map(|d| d.keys()),
    )?;
    let coll = db.collection::<Document>(&collection);
    let res = coll.insert_many(docs).await?;
    Ok(res.inserted_ids.len() as u64)
}

/// Parse the import file into BSON documents. Tries whole-file JSON first (an
/// array of objects, or a single object), then falls back to newline-delimited
/// JSON so a mongoexport dump loads without a format flag.
fn parse_documents(text: &str) -> AppResult<Vec<Document>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(arr)) => arr.into_iter().map(value_to_document).collect(),
        Ok(v @ Value::Object(_)) => Ok(vec![value_to_document(v)?]),
        Ok(_) => Err(AppError::Transfer(
            "expected a JSON object or an array of objects".into(),
        )),
        Err(_) => {
            // Not a single JSON value — treat as JSONL (one document per line).
            let mut out = Vec::new();
            for (i, line) in text.lines().enumerate() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(line)
                    .map_err(|e| AppError::Transfer(format!("line {}: {e}", i + 1)))?;
                out.push(value_to_document(value)?);
            }
            Ok(out)
        }
    }
}

fn value_to_document(value: Value) -> AppResult<Document> {
    // `bson`'s own Extended JSON parser: understands canonical (`$oid`,
    // `$numberLong`, `$date: {$numberLong}`, …) and relaxed forms, and every
    // BSON type — so a document exported by `into_canonical_extjson` round-trips
    // exactly.
    match Bson::try_from(value).map_err(|e| AppError::Transfer(e.to_string()))? {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::Transfer(
            "each entry must be a JSON object (a document)".into(),
        )),
    }
}
