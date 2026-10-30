//! MongoDB query + CRUD execution, shaped into the SQL-shaped DTOs the rest of
//! the app consumes ([`QueryResult`] / [`BatchResult`]).
//!
//! Read operations (`find`/`aggregate`/`count`/`distinct`) are flattened into a
//! tabular `(columns, rows)` result by [`docs_to_result`]: top-level fields
//! become columns (`_id` first), nested documents/arrays stay structured JSON in
//! the cell (the `CellPreview` panel expands them). Write operations report an
//! affected-document count in `rows_affected` and carry no rows.

use crate::commands::query::{
    nonblank, shed_to_batch_budget, BatchResult, ColumnFilter, ColumnMeta, CountMode, CountResult,
    FilterOp, Projection, QueryResult, RowValue, SortSpec, StmtOutcome, TableFilter, TableQuery,
    MAX_ADHOC_QUERY_ROWS,
};
use crate::error::{AppError, AppResult};
use crate::log_bus::{log_sql_sink, LogSink};
use crate::state::MongoConn;
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value;
use std::time::{Duration, Instant};

use super::schema::resolve_db;
use super::shell::{self, MongoOp};
use super::values::{
    bson_to_json, bson_type_name, bson_type_tree, id_to_bson, json_to_bson, string_to_bson,
};

/// Collect a cursor of documents without pulling in an external `Stream` trait
/// (the `mongodb` cursor exposes `advance` + `deserialize_current` directly).
/// Used only where the cursor is already server-side bounded (a `.limit()`
/// the caller applied itself, e.g. [`fetch_collection_data`]'s page size) —
/// anywhere the document count is driven by hand-typed `mongosh` text with no
/// such guarantee goes through [`collect_capped`] instead.
async fn collect(cursor: &mut mongodb::Cursor<Document>) -> AppResult<Vec<Document>> {
    let mut out = Vec::new();
    while cursor.advance().await? {
        out.push(cursor.deserialize_current()?);
    }
    Ok(out)
}

/// Collect a cursor of documents, keeping only the first `cap` documents.
///
/// Unlike the SQL drivers (see [`MAX_ADHOC_QUERY_ROWS`]), there's no clean-
/// protocol-boundary concern here: a cursor is its own independent server-side
/// resource, and the driver sends a `killCursors` when it's dropped early —
/// there's nothing to drain first. Returns `(docs, truncated)`, `truncated`
/// decided by one extra `advance()` past the cap rather than materialising a
/// document we're about to discard.
async fn collect_capped(
    cursor: &mut mongodb::Cursor<Document>,
    cap: usize,
) -> AppResult<(Vec<Document>, bool)> {
    let mut out = Vec::new();
    while out.len() < cap {
        if !cursor.advance().await? {
            return Ok((out, false));
        }
        out.push(cursor.deserialize_current()?);
    }
    let truncated = cursor.advance().await?;
    Ok((out, truncated))
}

/// Infer a single column's BSON type across a result set: the type of the
/// first non-null value seen for `field`, or `"mixed"` if later non-null
/// values disagree with it (BSON is schemaless, so within one result set a
/// field can legitimately hold different types across rows/documents — this
/// is the honest answer rather than picking one type and silently hiding the
/// disagreement). `"null"` when `field` is absent or null in every document.
fn infer_column_type<'a>(docs: impl Iterator<Item = Option<&'a Bson>>) -> String {
    let mut inferred: Option<&'static str> = None;
    for v in docs.flatten() {
        if matches!(v, Bson::Null) {
            continue;
        }
        let t = super::values::bson_type_name(v);
        match inferred {
            None => inferred = Some(t),
            Some(prev) if prev != t => return "mixed".to_string(),
            _ => {}
        }
    }
    inferred.unwrap_or("null").to_string()
}

/// Flatten a set of documents into a tabular result. Columns are the union of
/// top-level field names across all rows, `_id` pinned first, otherwise
/// first-seen order. Each column's `data_type` is inferred from the values
/// actually returned ([`infer_column_type`]) rather than a generic `"bson"`
/// label, so `run_query`/`browse_table` give an MCP client (or the data grid)
/// a real type signal — the same treatment the read-only structure view
/// already gives via `infer_columns`' document sampling.
pub(super) fn docs_to_result(docs: Vec<Document>, elapsed_ms: u64, truncated: bool) -> QueryResult {
    let mut order: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for d in &docs {
        for k in d.keys() {
            if seen.insert(k.clone()) {
                order.push(k.clone());
            }
        }
    }
    order.sort_by_key(|k| if k == "_id" { 0 } else { 1 });

    let columns: Vec<ColumnMeta> = order
        .iter()
        .map(|name| ColumnMeta {
            name: name.clone(),
            data_type: infer_column_type(docs.iter().map(|d| d.get(name))),
        })
        .collect();

    let rows: Vec<Vec<Value>> = docs
        .iter()
        .map(|d| {
            order
                .iter()
                .map(|k| d.get(k).map(bson_to_json).unwrap_or(Value::Null))
                .collect()
        })
        .collect();

    // Parallel to `rows`, one type tree per cell. Unlike the SQL drivers, a
    // MongoDB field's type belongs to the individual document (and nested
    // fields have no column at all), so the grid's document list view is told
    // the real types rather than left to infer them from the lossy display
    // JSON — see `bson_type_tree`.
    let row_types: Vec<Vec<Value>> = docs
        .iter()
        .map(|d| {
            order
                .iter()
                .map(|k| {
                    d.get(k)
                        .map(bson_type_tree)
                        .unwrap_or_else(|| Value::String("null".to_string()))
                })
                .collect()
        })
        .collect();

    QueryResult::rows(columns, rows, elapsed_ms)
        .with_truncated(truncated)
        .with_row_types(row_types)
}

/// Single scalar result (used by `count`): one column, one row. `data_type` is
/// passed in by the caller rather than inferred — `count` always returns a
/// concrete, known type (a 64-bit count), so there's nothing to sample.
fn scalar_result(name: &str, data_type: &str, value: Value, elapsed_ms: u64) -> QueryResult {
    QueryResult::rows(
        vec![ColumnMeta {
            name: name.to_string(),
            data_type: data_type.to_string(),
        }],
        vec![vec![value]],
        elapsed_ms,
    )
}

/// Result carrying only an affected-document count (writes).
fn affected_result(count: u64, elapsed_ms: u64) -> QueryResult {
    QueryResult::affected(count, elapsed_ms)
}

/// Execute one parsed `mongosh` statement and shape it into a [`QueryResult`].
pub async fn execute(conn: &MongoConn, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let parsed = shell::parse(sql)?;
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(&parsed.collection);
    let ms = || start.elapsed().as_millis() as u64;

    match parsed.op {
        MongoOp::Find {
            filter,
            projection,
            sort,
            limit,
            skip,
            collation,
            hint,
            one,
        } => {
            let mut action = coll.find(filter);
            if let Some(p) = projection {
                action = action.projection(p);
            }
            if let Some(c) = collation {
                action = action.collation(collation_from_doc(*c)?);
            }
            if let Some(h) = hint {
                action = action.hint(hint_from_bson(*h)?);
            }
            if let Some(s) = sort {
                action = action.sort(s);
            }
            let effective_limit = if one { Some(1) } else { limit };
            if let Some(l) = effective_limit {
                action = action.limit(l);
            }
            if let Some(sk) = skip {
                action = action.skip(sk.max(0) as u64);
            }
            let mut cursor = action.await?;
            let (docs, truncated) = collect_capped(&mut cursor, MAX_ADHOC_QUERY_ROWS).await?;
            Ok(docs_to_result(docs, ms(), truncated))
        }
        MongoOp::Aggregate { pipeline } => {
            let mut cursor = coll.aggregate(pipeline).await?;
            let (docs, truncated) = collect_capped(&mut cursor, MAX_ADHOC_QUERY_ROWS).await?;
            Ok(docs_to_result(docs, ms(), truncated))
        }
        MongoOp::Count { filter } => {
            let n = coll.count_documents(filter).await?;
            Ok(scalar_result("count", "long", Value::from(n), ms()))
        }
        MongoOp::Distinct { field, filter } => {
            // `distinct` has no cursor to cap mid-flight — the driver always
            // materialises every distinct value into one `Vec` before we get
            // control. Truncating what we keep still bounds the IPC payload
            // and the grid's DOM, just not the driver's own peak memory; a
            // field with an unbounded number of distinct values is rare
            // enough (and the command is read-only, uncommon in the editor)
            // that this is an accepted, lesser-scope gap versus `find`/
            // `aggregate`'s unbounded cursors.
            let mut values = coll.distinct(&field, filter).await?;
            let truncated = values.len() > MAX_ADHOC_QUERY_ROWS;
            values.truncate(MAX_ADHOC_QUERY_ROWS);
            let data_type = infer_column_type(values.iter().map(Some));
            let rows: Vec<Vec<Value>> = values.iter().map(|b| vec![bson_to_json(b)]).collect();
            Ok(QueryResult::rows(
                vec![ColumnMeta {
                    name: field,
                    data_type,
                }],
                rows,
                ms(),
            )
            .with_truncated(truncated))
        }
        MongoOp::InsertOne { doc } => {
            coll.insert_one(doc).await?;
            Ok(affected_result(1, ms()))
        }
        MongoOp::InsertMany { docs } => {
            let n = docs.len() as u64;
            coll.insert_many(docs).await?;
            Ok(affected_result(n, ms()))
        }
        MongoOp::UpdateOne { filter, update } => {
            let r = coll
                .update_one(filter, mongodb::options::UpdateModifications::from(update))
                .await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::UpdateMany { filter, update } => {
            let r = coll
                .update_many(filter, mongodb::options::UpdateModifications::from(update))
                .await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::ReplaceOne {
            filter,
            replacement,
        } => {
            let r = coll.replace_one(filter, replacement).await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::DeleteOne { filter } => {
            let r = coll.delete_one(filter).await?;
            Ok(affected_result(r.deleted_count, ms()))
        }
        MongoOp::DeleteMany { filter } => {
            let r = coll.delete_many(filter).await?;
            Ok(affected_result(r.deleted_count, ms()))
        }
        // The DDL arms below deliberately delegate rather than issuing their own
        // run-commands: `super::indexes` owns the `_id_` refusal and the
        // `createIndexes` name defaulting, and `super::schema` owns the
        // `dropTarget: false` pin and the view refusal. A second copy here
        // would be a second set of guards to keep in step, and the index
        // manager is where those guards were reasoned about.
        MongoOp::CreateIndex { keys, options } => {
            super::indexes::create_index_docs(conn, &parsed.collection, keys, options).await?;
            Ok(affected_result(0, ms()))
        }
        MongoOp::DropIndex { name } => {
            super::indexes::drop_index(conn, &parsed.collection, &name).await?;
            Ok(affected_result(0, ms()))
        }
        MongoOp::SetIndexHidden { name, hidden } => {
            super::indexes::set_index_hidden(conn, &parsed.collection, &name, hidden).await?;
            Ok(affected_result(0, ms()))
        }
        MongoOp::DropCollection => {
            coll.drop().await?;
            Ok(affected_result(0, ms()))
        }
        // Same database only, which is what `mongosh` itself accepts here — a
        // cross-database move is `db.adminCommand({renameCollection: …})`
        // there, and the explorer's rename dialog is where it lives in this
        // app. Reading a qualified `"otherDb.coll"` as a move was tempting and
        // wrong: a collection name may legitimately contain dots
        // (`system.views`, `logs.2024`), so `renameCollection("logs.2024")`
        // would silently mean "move to the database `logs`" instead.
        MongoOp::RenameCollection { to } => {
            super::schema::rename_collection(conn, &parsed.collection, &to, None).await?;
            Ok(affected_result(0, ms()))
        }
    }
}

/// Run a batch of `mongosh` statements sequentially (one [`StmtOutcome`] each,
/// stopping at the first failure — mirrors the SQL batch contract).
pub async fn execute_batch(
    conn: &MongoConn,
    statements: &[String],
    sink: &dyn LogSink,
    connection_id: &str,
) -> AppResult<BatchResult> {
    let mut outcomes = Vec::new();
    let mut total_affected = 0u64;
    // Shared across the whole batch, not per statement — see
    // `MAX_BATCH_RESULT_ROWS`.
    let mut rows_kept: usize = 0;

    for (index, raw) in statements.iter().enumerate() {
        let stmt = raw.trim();
        if stmt.is_empty() {
            continue;
        }
        let is_read = shell::parse(stmt).map(|c| c.op.is_read()).unwrap_or(false);
        let start = Instant::now();
        match execute(conn, stmt).await {
            Ok(mut result) => {
                let affected = result.rows_affected;
                total_affected += affected;
                log_sql_sink(
                    sink,
                    connection_id,
                    "mongodb",
                    stmt,
                    start,
                    Some(affected),
                    None,
                );
                let mut results = Vec::new();
                if is_read {
                    if shed_to_batch_budget(&mut result.rows, &mut rows_kept) {
                        // `row_types` is cell-aligned to `rows` and must stay
                        // that way (ADR #29): shedding rows without
                        // shedding their type trees would hand the document
                        // view a type for a row that is not there.
                        if let Some(types) = result.row_types.as_mut() {
                            types.truncate(result.rows.len());
                        }
                        result.truncated = true;
                    }
                    results.push(result);
                }
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(stmt),
                    rows_affected: affected,
                    is_select: is_read,
                    error: None,
                    results,
                });
            }
            Err(e) => {
                log_sql_sink(
                    sink,
                    connection_id,
                    "mongodb",
                    stmt,
                    start,
                    None,
                    Some(&e.to_string()),
                );
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(stmt),
                    rows_affected: 0,
                    is_select: is_read,
                    error: Some(e.to_string()),
                    results: Vec::new(),
                });
                break;
            }
        }
    }

    Ok(BatchResult {
        statements: outcomes,
        total_affected,
    })
}

fn stmt_preview(s: &str) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 {
        let head: String = one_line.chars().take(117).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// Build a mongosh-style `db.<collection>.find(...)` string describing a
/// collection-browse request, for the Console log. `fetch_collection_data`
/// has no single "statement" of its own the way a hand-typed shell command
/// does, so this rebuilds the same filter `find` would run — purely for
/// display, not reused to actually query — to give the Console the same
/// "what ran" record the SQL drivers and the mongo shell tab already get.
pub(crate) fn describe_find(q: &TableQuery) -> String {
    let (collection, predicate, order) = (q.table.as_str(), &q.filter, q.order.as_slice());
    let (projection, limit, offset) = (q.projection.as_ref(), q.limit, q.offset);
    // Infallible on purpose: this is the Console's record of what ran, and the
    // run itself has already reported a bad expression. Without one it is the
    // same document `predicate_doc` builds.
    let filter = predicate_doc(predicate).unwrap_or_else(|_| {
        build_filter(
            &predicate.filters,
            predicate.needle(),
            &predicate.search_columns,
        )
    });
    let filter = Bson::Document(filter).into_canonical_extjson();
    let mut s = match projection_doc(projection) {
        Some(p) => format!(
            "db.{collection}.find({filter}, {})",
            Bson::Document(p).into_canonical_extjson()
        ),
        None => format!("db.{collection}.find({filter})"),
    };
    if let Some(sort) = sort_doc(order) {
        s.push_str(&format!(
            ".sort({})",
            Bson::Document(sort).into_canonical_extjson()
        ));
    }
    // A collation that does not parse has already failed the run; the record
    // simply leaves it out.
    if let Ok(Some(c)) = collation_doc(nonblank(&q.collation)) {
        s.push_str(&format!(
            ".collation({})",
            Bson::Document(c).into_canonical_extjson()
        ));
    }
    if let Some(h) = nonblank(&q.hint) {
        s.push_str(&format!(
            ".hint({})",
            serde_json::to_string(h).unwrap_or_default()
        ));
    }
    if offset > 0 {
        s.push_str(&format!(".skip({offset})"));
    }
    if limit > 0 {
        s.push_str(&format!(".limit({limit})"));
    }
    s
}

/// The whole filter document of a browse: the chips and the free-text search
/// ([`build_filter`]) ANDed with the query panel's expression.
///
/// The expression is read by [`shell::parse_relaxed_value`], the grammar the
/// query tab and the aggregation editor already speak — unquoted keys,
/// `ObjectId(…)`, `ISODate(…)`, regex literals — so a filter typed here means
/// what it would mean there. It has to be a document: `find()` takes nothing
/// else, and saying so beats the driver's error for an array.
pub(crate) fn predicate_doc(predicate: &TableFilter) -> AppResult<Document> {
    let built = build_filter(
        &predicate.filters,
        predicate.needle(),
        &predicate.search_columns,
    );
    let Some(raw) = predicate.raw_text() else {
        return Ok(built);
    };
    let expr = match shell::parse_relaxed_value(raw)
        .map_err(|e| AppError::InvalidInput(format!("expression: {e}")))?
    {
        Bson::Document(d) => d,
        _ => {
            return Err(AppError::InvalidInput(
                "expression: a filter is a document, like { field: value }".into(),
            ))
        }
    };
    if built.is_empty() {
        return Ok(expr);
    }
    if expr.is_empty() {
        return Ok(built);
    }
    Ok(doc! { "$and": [built, expr] })
}

/// A collection name the shell grammar reads as `db.<name>`; anything else
/// goes through `db.getCollection("…")`.
fn shell_collection(collection: &str) -> String {
    let plain = collection
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && collection
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain {
        format!("db.{collection}")
    } else {
        format!(
            "db.getCollection({})",
            serde_json::to_string(collection).unwrap_or_default()
        )
    }
}

/// The browse as a statement the query tab runs — the query panel's *Result*
/// line and its "Open in editor".
///
/// Unlike [`describe_find`] (the Console's record, canonical Extended JSON)
/// this writes the shell grammar through
/// [`super::values::bson_to_shell_text`], which [`shell::parse`] reads back:
/// `ObjectId("…")` rather than `{"$oid": "…"}`. The projection is a chained
/// `.projection(…)`, the form that grammar documents.
pub(crate) fn describe_find_shell(q: &TableQuery) -> AppResult<String> {
    use super::values::bson_to_shell_text;
    let (collection, predicate, order) = (q.table.as_str(), &q.filter, q.order.as_slice());
    let (projection, limit, offset) = (q.projection.as_ref(), q.limit, q.offset);
    let filter = predicate_doc(predicate)?;
    let mut s = format!(
        "{}.find({})",
        shell_collection(collection),
        bson_to_shell_text(&Bson::Document(filter))
    );
    if let Some(p) = projection_doc(projection) {
        s.push_str(&format!(
            ".projection({})",
            bson_to_shell_text(&Bson::Document(p))
        ));
    }
    if let Some(sort) = sort_doc(order) {
        s.push_str(&format!(
            ".sort({})",
            bson_to_shell_text(&Bson::Document(sort))
        ));
    }
    if let Some(c) = collation_doc(nonblank(&q.collation))? {
        s.push_str(&format!(
            ".collation({})",
            bson_to_shell_text(&Bson::Document(c))
        ));
    }
    if let Some(h) = nonblank(&q.hint) {
        s.push_str(&format!(
            ".hint({})",
            serde_json::to_string(h).unwrap_or_default()
        ));
    }
    if offset > 0 {
        s.push_str(&format!(".skip({offset})"));
    }
    if limit > 0 {
        s.push_str(&format!(".limit({limit})"));
    }
    Ok(s)
}

/// Build a Mongo filter document from the grid's column filters + free-text
/// search. `_id` equality/inequality reconstructs the BSON `_id` (ObjectId-aware).
///
/// `pub(crate)` (rather than private) so `commands::mongo::export_collection`
/// can reuse it to scope a collection export to the DataGrid's current
/// filter instead of always dumping the whole collection.
pub(crate) fn build_filter(
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> Document {
    let mut clauses: Vec<Document> = Vec::new();

    for f in filters {
        // Raw string form of the value, for the regex (substring/prefix/suffix)
        // operators — those match text, so an ObjectId-aware conversion isn't
        // wanted here.
        let raw = match &f.value {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let clause = match f.op {
            FilterOp::IsNull => doc! { &f.column: { "$eq": Bson::Null } },
            FilterOp::IsNotNull => doc! { &f.column: { "$ne": Bson::Null } },
            FilterOp::Eq => {
                let v = field_value(&f.column, &f.value);
                doc! { &f.column: v }
            }
            FilterOp::Ne => {
                let v = field_value(&f.column, &f.value);
                doc! { &f.column: { "$ne": v } }
            }
            FilterOp::Gt => doc! { &f.column: { "$gt": field_value(&f.column, &f.value) } },
            FilterOp::Gte => doc! { &f.column: { "$gte": field_value(&f.column, &f.value) } },
            FilterOp::Lt => doc! { &f.column: { "$lt": field_value(&f.column, &f.value) } },
            FilterOp::Lte => doc! { &f.column: { "$lte": field_value(&f.column, &f.value) } },
            // The three text-match operators go through `text_match_branches`
            // so they also see non-string fields — see that function for why a
            // bare `$regex` silently matches nothing on a numeric field.
            FilterOp::Contains => {
                doc! { "$or": text_match_branches(&f.column, &regex_escape(&raw)) }
            }
            // `$nor` negates the *union* of the two branches. Negating each
            // branch separately (`$and` of two `$not`s) would be a different
            // predicate: a document whose field matched the indexed branch
            // would still have to fail the `$expr` one, which it cannot.
            FilterOp::NotContains => {
                doc! { "$nor": text_match_branches(&f.column, &regex_escape(&raw)) }
            }
            FilterOp::StartsWith => {
                doc! { "$or": text_match_branches(&f.column, &format!("^{}", regex_escape(&raw))) }
            }
            FilterOp::EndsWith => {
                doc! { "$or": text_match_branches(&f.column, &format!("{}$", regex_escape(&raw))) }
            }
            FilterOp::Between => doc! {
                &f.column: {
                    "$gte": field_value(&f.column, &f.value),
                    "$lte": field_value(&f.column, &f.value2),
                }
            },
            // `$in` / `$nin` need none of the NULL gymnastics the SQL builder
            // does: Mongo has no three-valued logic, and a `null` in the list
            // matches both an explicit null and a missing field — the same
            // semantics `IsNull` already has here. The degenerate empty list is
            // also already correct: `$in: []` matches nothing, `$nin: []`
            // matches everything.
            FilterOp::In => {
                let vs: Vec<Bson> = f.values.iter().map(|v| field_value(&f.column, v)).collect();
                doc! { &f.column: { "$in": vs } }
            }
            FilterOp::NotIn => {
                let vs: Vec<Bson> = f.values.iter().map(|v| field_value(&f.column, v)).collect();
                doc! { &f.column: { "$nin": vs } }
            }
        };
        clauses.push(clause);
    }

    if let Some(q) = search {
        // Deliberately still a bare `$regex` per column, unlike the three
        // operators above: the free-text box fans out over every visible
        // column, so pairing each with an `$expr` branch would double an
        // already-wide `$or`. The same non-string blind spot applies — a
        // numeric column is not searchable from this box. Left as a known gap
        // rather than widened here; the per-column `contains` filter is the
        // surface that had to be correct.
        if !q.is_empty() && !search_columns.is_empty() {
            let escaped = regex_escape(q);
            let ors: Vec<Document> = search_columns
                .iter()
                .map(|c| doc! { c: { "$regex": &escaped, "$options": "i" } })
                .collect();
            clauses.push(doc! { "$or": ors });
        }
    }

    if clauses.is_empty() {
        Document::new()
    } else if clauses.len() == 1 {
        clauses.into_iter().next().unwrap()
    } else {
        doc! { "$and": clauses }
    }
}

/// Convert a filter value to BSON, treating `_id` specially so an ObjectId
/// rendered as a hex string round-trips to a real ObjectId.
fn field_value(column: &str, value: &Value) -> Bson {
    if column == "_id" {
        id_to_bson(value)
    } else {
        json_to_bson(value)
    }
}

/// The two branches of a case-insensitive text match against `column`.
///
/// BSON's `$regex` only ever inspects **strings**: against a numeric, date or
/// ObjectId field it matches nothing at all, and — this is the part that makes
/// it dangerous — it does so *silently*, reporting zero rows rather than an
/// error. `db.entityLog.countDocuments({ts: {$regex: "1788"}})` returns 0 on a
/// collection where every `ts` is a `long` beginning with those digits, while
/// `{ts: {$gte: 1788422462450}}` over the same documents returns 6. The SQL
/// drivers have no such blind spot: their builder wraps the column in
/// `CAST(col AS TEXT)` before comparing (`commands::query`), so `contains` on
/// an `INT` works everywhere except here.
///
/// So a text match emits both:
///
/// 1. the plain `$regex`, which is the fast path and **can use an index** on a
///    string field — the overwhelmingly common case, and the reason this is
///    not simply replaced by branch 2; and
/// 2. an `$expr` that stringifies the field server-side first, covering
///    numbers, dates and ObjectIds.
///
/// **Cost, deliberately accepted:** branch 2 cannot use an index, so a text
/// match over a large collection degrades to a scan. That is the price of the
/// operator telling the truth instead of returning an empty result set; the
/// alternative — offering `contains` on a numeric column and having it always
/// answer "no rows" — is the failure mode ADRs #29/#30/#39 exist to prevent.
///
/// The `$convert` (rather than a bare `$toString`) is not decoration:
/// `$toString` raises a query-killing error when the field is missing, or holds
/// a document or an array. `onError`/`onNull` fold all three into the empty
/// string, which simply fails to match.
///
/// **Branch 2 maps over the field rather than converting it whole**, because
/// `column` can be a path that traverses an array — `items.qty` addresses the
/// `qty` of *every* element, and that is the shape the advanced filter's field
/// picker now offers (see `lib/grid/fieldPaths.ts`). A field-path expression
/// over such a path resolves to an *array* of values, which `$convert` folds to
/// `""` via `onError`: the exact silent zero-row answer this function exists to
/// prevent, reopened one level down. `$isArray` picks the shape, `$map` +
/// `$anyElementTrue` ask the question per element, and a missing field yields
/// no match rather than an error — checked against a live server, since
/// `$convert`'s behaviour on these inputs is not something the docs spell out.
///
/// **Server floor: MongoDB 4.2**, for `$regexMatch` (`$convert` and `$expr`
/// landed earlier, in 4.0 and 3.6). The Rust driver's own floor is 4.0, so a
/// 4.0/4.1 server — EOL since April 2022 — would now fail these three
/// operators with an unknown-operator error instead of silently returning
/// nothing.
fn text_match_branches(column: &str, pattern: &str) -> Vec<Document> {
    let field = format!("${column}");
    vec![
        doc! { column: { "$regex": pattern, "$options": "i" } },
        doc! { "$expr": { "$anyElementTrue": { "$map": {
            // One element for a scalar field, every element for an array one —
            // see the doc comment for why the array case cannot be left to
            // `$convert`.
            "input": { "$cond": [
                { "$isArray": field.as_str() },
                field.as_str(),
                [field.as_str()],
            ] },
            "in": { "$regexMatch": {
                "input": {
                    "$convert": {
                        "input": "$$this",
                        "to": "string",
                        "onError": "",
                        "onNull": "",
                    }
                },
                "regex": pattern,
                "options": "i",
            } },
        } } } },
    ]
}

/// Escape regex metacharacters so a free-text search is matched literally.
fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// A collation document (`{ locale: 'es', strength: 1 }`) as the driver's
/// typed option. `locale` is required by the server, so its absence is
/// reported here, in words, rather than as a deserialisation error.
pub(crate) fn collation_from_doc(d: Document) -> AppResult<mongodb::options::Collation> {
    if !d.contains_key("locale") {
        return Err(AppError::InvalidInput(
            "collation: `locale` is required, e.g. { locale: 'es', strength: 1 }".into(),
        ));
    }
    mongodb::bson::deserialize_from_document(d)
        .map_err(|e| AppError::InvalidInput(format!("collation: {e}")))
}

/// A collation typed as text, as the document it parses to — checked by
/// [`collation_from_doc`] so a bad one fails the same way wherever it is read.
pub(crate) fn collation_doc(text: Option<&str>) -> AppResult<Option<Document>> {
    let Some(text) = text else { return Ok(None) };
    match shell::parse_relaxed_value(text)
        .map_err(|e| AppError::InvalidInput(format!("collation: {e}")))?
    {
        Bson::Document(d) => {
            collation_from_doc(d.clone())?;
            Ok(Some(d))
        }
        _ => Err(AppError::InvalidInput(
            "collation: a collation is a document, like { locale: 'es', strength: 1 }".into(),
        )),
    }
}

/// Parse a collation typed as text — the query panel's *Collation* field.
pub(crate) fn parse_collation(text: &str) -> AppResult<mongodb::options::Collation> {
    match shell::parse_relaxed_value(text)
        .map_err(|e| AppError::InvalidInput(format!("collation: {e}")))?
    {
        Bson::Document(d) => collation_from_doc(d),
        _ => Err(AppError::InvalidInput(
            "collation: a collation is a document, like { locale: 'es', strength: 1 }".into(),
        )),
    }
}

/// An index hint: a name, or a key document.
pub(crate) fn hint_from_bson(b: Bson) -> AppResult<mongodb::options::Hint> {
    match b {
        Bson::String(name) => Ok(mongodb::options::Hint::Name(name)),
        Bson::Document(keys) => Ok(mongodb::options::Hint::Keys(keys)),
        _ => Err(AppError::InvalidInput(
            "hint: an index name or a key document".into(),
        )),
    }
}

/// The `sort()` document for a browse, or `None` when unsorted. BSON documents
/// preserve insertion order, so a multi-key sort doc honours the requested
/// precedence (`order[0]` is the primary key).
pub(crate) fn sort_doc(order: &[SortSpec]) -> Option<Document> {
    if order.is_empty() {
        return None;
    }
    let mut out = Document::new();
    for s in order {
        out.insert(s.column.clone(), if s.desc { -1 } else { 1 });
    }
    Some(out)
}

/// The `find()` projection document for a browse: `{ a: 1, b: 1 }` to keep
/// fields, `{ a: 0 }` to drop them, or `None` for the whole document.
///
/// Every value is the same `1` or `0`, never mixed: MongoDB rejects a mix
/// except for `_id`, and `_id` needs no entry in either direction. An
/// inclusion keeps it by default, which is what the grid needs to address the
/// document for an edit, and the grid never offers it for exclusion.
pub(crate) fn projection_doc(projection: Option<&Projection>) -> Option<Document> {
    let p = Projection::narrowing(projection)?;
    let flag = if p.exclude { 0 } else { 1 };
    let mut out = Document::new();
    for f in &p.fields {
        out.insert(f.clone(), flag);
    }
    Some(out)
}

/// Paginated collection browse — the MongoDB analogue of `fetch_table_data`.
pub async fn fetch_collection_data(conn: &MongoConn, q: &TableQuery) -> AppResult<QueryResult> {
    let start = Instant::now();
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(&q.table);

    let filter = predicate_doc(&q.filter)?;
    let collation = nonblank(&q.collation).map(parse_collation).transpose()?;

    // Skip the count when the caller already knows the total (sort/page-only
    // change); `count_documents` over a filter is the slow part on big
    // collections, mirroring the SQL COUNT(*) skip in `fetch_table_data`.
    let total = if q.with_count {
        Some(
            count_matching(
                &coll,
                &q.filter,
                filter.clone(),
                collation.clone(),
                nonblank(&q.hint),
                None,
            )
            .await?,
        )
    } else {
        None
    };

    let mut action = coll
        .find(filter)
        .limit(q.limit.max(0))
        .skip(q.offset.max(0) as u64);
    if let Some(p) = projection_doc(q.projection.as_ref()) {
        action = action.projection(p);
    }
    if let Some(sort) = sort_doc(&q.order) {
        action = action.sort(sort);
    }
    if let Some(c) = collation {
        action = action.collation(c);
    }
    if let Some(h) = nonblank(&q.hint) {
        action = action.hint(mongodb::options::Hint::Name(h.to_string()));
    }
    let mut cursor = action.await?;
    let docs = collect(&mut cursor).await?;

    let mut result = docs_to_result(docs, start.elapsed().as_millis() as u64, false);
    seed_id_column(&mut result);
    result.total = total;
    Ok(result)
}

/// Give an empty browse page its `_id` column.
///
/// `docs_to_result` derives columns from the documents it is handed, so a page
/// with none — an empty collection, or a filter that matches nothing — comes
/// back with no columns at all. `infer_columns` already seeds `_id` as the
/// primary key for the empty case, but the grid also requires every PK column
/// to be present in the *result* before it treats the collection as writable
/// (`TableDataTab`'s `hasPk`), so the missing column hid Insert all over again.
/// This is the browse-side half of that fix, the analogue of the catalog
/// fallback `fetch_table_data` does for the SQL drivers (#27).
///
/// Only the browse gets this, not `docs_to_result` itself: an ad-hoc query
/// with no results has no business reporting a field nobody asked for.
fn seed_id_column(result: &mut QueryResult) {
    if result.columns.is_empty() {
        result.columns.push(ColumnMeta {
            name: "_id".to_string(),
            // Same label `infer_columns` gives the seeded key: no value has
            // been observed yet, so there is no BSON type to report.
            data_type: "null".to_string(),
        });
    }
}

/// Count documents for the browse footer, served independently of the data
/// page (the MongoDB analogue of the SQL `count_table_rows`).
///
/// When `mode` allows an estimate (the background count of the whole
/// collection — see [`CountMode::may_estimate`]) this uses `estimatedDocumentCount`,
/// which reads collection metadata in O(1) — the key difference from
/// [`fetch_collection_data`]'s inline `count_documents`, which scans the whole
/// collection and is exactly what made opening a multi-million-document
/// collection feel slow. With any predicate an exact `count_documents` over
/// the filter is unavoidable, but it no longer blocks the first render.
///
/// `hint` is the query panel's index hint: it does not change how many
/// documents match, but it decides which index the count walks, the same one
/// the page itself is read through — see [`count_matching`].
pub async fn count_collection(
    conn: &MongoConn,
    collection: &str,
    predicate: &TableFilter,
    collation: Option<&str>,
    hint: Option<&str>,
    mode: CountMode,
) -> AppResult<CountResult> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    if mode.may_estimate(predicate) {
        let total = coll.estimated_document_count().await?;
        Ok(CountResult {
            total,
            estimated: true,
        })
    } else {
        let filter = predicate_doc(predicate)?;
        // Bounded, unlike the estimate above, because this one is a scan. A
        // filtered count has no index to answer it from in the general case, so
        // on a collection of tens of millions it runs for minutes — holding a
        // pooled connection and competing with the data page the user is
        // actually waiting on, to fill in a number in the footer.
        //
        // On timeout this errors, and the frontend's count path already treats
        // a failure as non-fatal: the footer shows the current range without
        // "/ N". That is the honest degradation. Falling back to
        // `estimated_document_count` would be worse than showing nothing — it
        // ignores the predicate, so it would report the whole collection as if
        // it were the filtered total.
        // A collation changes which documents match (`strength: 1` makes "a"
        // and "A" equal), so the count has to carry it or it would count a
        // different set than the page shows.
        let collation = collation.map(parse_collation).transpose()?;
        let total = count_matching(
            &coll,
            predicate,
            filter,
            collation,
            hint,
            count_ceiling(mode),
        )
        .await?;
        Ok(CountResult {
            total,
            estimated: false,
        })
    }
}

/// Which index a `countDocuments` should walk.
#[derive(Debug, PartialEq, Eq)]
enum CountIndex<'a> {
    /// The planner's choice: there is a predicate and no hint.
    Planner,
    /// The query panel's hint, which the page is read through as well.
    User(&'a str),
    /// The `_id` index, for an exact count of the whole collection.
    Id,
}

impl<'a> CountIndex<'a> {
    fn of(predicate: &TableFilter, hint: Option<&'a str>) -> Self {
        match hint {
            Some(h) => Self::User(h),
            None if predicate.is_unfiltered() => Self::Id,
            None => Self::Planner,
        }
    }
}

/// The `_id` index's name. Every collection has one, except views and
/// time-series collections — see [`hint_unusable`].
const ID_INDEX: &str = "_id_";

/// `countDocuments` over `filter`, through the index [`CountIndex::of`] picks.
///
/// The driver runs `countDocuments` as `$match` + `$group`, and with an empty
/// `$match` the planner has nothing to choose an index by, so it scans the
/// documents themselves: on a collection of 75 million that is every document
/// read off disk and decompressed to add one to a counter. Hinting `_id_`
/// turns the same count into a walk of the `_id` index alone — the pipeline
/// needs no field, so the plan is covered and never fetches a document. It is
/// still linear, but in a structure a fraction of the collection's size.
///
/// The collation is dropped on that path: it changes which documents match a
/// predicate, and there is none, so it cannot change the total — and leaving
/// it off keeps the hint valid whatever collation the `_id` index was built
/// with.
///
/// A user's hint is passed as given and fails the count the way it fails the
/// page; only the hint chosen here falls back, because the collections that
/// cannot take it (views, time-series) still count fine the slow way.
async fn count_matching(
    coll: &mongodb::Collection<Document>,
    predicate: &TableFilter,
    filter: Document,
    collation: Option<mongodb::options::Collation>,
    hint: Option<&str>,
    max_time: Option<Duration>,
) -> AppResult<u64> {
    use mongodb::options::Hint;

    let index = CountIndex::of(predicate, hint);
    let mut count = coll.count_documents(filter.clone());
    if let Some(limit) = max_time {
        count = count.max_time(limit);
    }
    match index {
        CountIndex::Id => {
            match count.hint(Hint::Name(ID_INDEX.to_string())).await {
                Err(e) if hint_unusable(&e) => {}
                r => return Ok(r?),
            }
            let mut count = coll.count_documents(filter);
            if let Some(limit) = max_time {
                count = count.max_time(limit);
            }
            Ok(count.await?)
        }
        CountIndex::User(h) => {
            count = count.hint(Hint::Name(h.to_string()));
            if let Some(c) = collation {
                count = count.collation(c);
            }
            Ok(count.await?)
        }
        CountIndex::Planner => {
            if let Some(c) = collation {
                count = count.collation(c);
            }
            Ok(count.await?)
        }
    }
}

/// True when the server refused the `_id_` hint itself rather than the count:
/// `BadValue` (2) for a collection with no index of that name, and
/// `OptionNotSupportedOnView` (167) for a view — which is also what a
/// time-series collection is underneath.
fn hint_unusable(e: &mongodb::error::Error) -> bool {
    matches!(e.kind.as_ref(), mongodb::error::ErrorKind::Command(c) if c.code == 2 || c.code == 167)
}

/// Ceiling on a filtered document count.
///
/// The unfiltered case reads collection metadata in O(1); this one scans. Ten
/// seconds is generous for a count that can be answered from an index and far
/// too short for one that cannot, which is the distinction worth drawing — a
/// count nobody can wait for is not a slower count, it is a missing one, and
/// the footer already knows how to show a page range without a total.
const COUNT_TIMEOUT_MS: u64 = 10_000;

/// The server-side `maxTimeMS` for a `count_documents` in `mode`: the
/// background ceiling above, or none at all when the user asked for the exact
/// figure. Lifting it is the point of that action — the collections whose
/// estimate is worth doubting are the ones a ten-second cap would fail on.
fn count_ceiling(mode: CountMode) -> Option<Duration> {
    match mode {
        CountMode::Automatic => Some(Duration::from_millis(COUNT_TIMEOUT_MS)),
        CountMode::Exact => None,
    }
}

/// Update one field of one document addressed by `_id` (`$set`).
pub async fn update_cell(
    conn: &MongoConn,
    collection: &str,
    id_value: &Value,
    field: &str,
    value: Option<&str>,
    type_hint: Option<&str>,
) -> AppResult<u64> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let id = id_to_bson(id_value);
    let new_value = string_to_bson(value, type_hint);
    let r = coll
        .update_one(doc! { "_id": id }, doc! { "$set": { field: new_value } })
        .await?;
    Ok(r.modified_count)
}

/// Remove one field from one document addressed by `_id` (`$unset`).
///
/// `field` is a field *path*, so a nested field is addressed the same way it is
/// written: `"customData.format"` unsets that key inside the sub-document, and
/// `"tags.2"` clears (rather than splices) the array slot — MongoDB's own
/// `$unset` semantics, left as-is so the grid never silently reindexes an array
/// behind the user's back.
pub async fn unset_field(
    conn: &MongoConn,
    collection: &str,
    id_value: &Value,
    field: &str,
) -> AppResult<u64> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let id = id_to_bson(id_value);
    let r = coll
        .update_one(doc! { "_id": id }, doc! { "$unset": { field: "" } })
        .await?;
    Ok(r.modified_count)
}

/// Delete documents by their `_id` values (`{_id: {$in: […]}}`).
pub async fn delete_rows(
    conn: &MongoConn,
    collection: &str,
    id_values: &[Value],
) -> AppResult<u64> {
    if id_values.is_empty() {
        return Ok(0);
    }
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let ids: Vec<Bson> = id_values.iter().map(id_to_bson).collect();
    let r = coll.delete_many(doc! { "_id": { "$in": ids } }).await?;
    Ok(r.deleted_count)
}

/// Insert one document built from the grid's column/value pairs. Returns the
/// inserted `_id` as JSON (so the grid can locate the new row).
pub async fn insert_row(
    conn: &MongoConn,
    collection: &str,
    values: &[RowValue],
) -> AppResult<Value> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let res = coll.insert_one(row_document(values)).await?;
    Ok(bson_to_json(&res.inserted_id))
}

/// The document one grid row's column/value pairs make — what [`insert_row`]
/// inserts, and the multi-cell paste's new rows too.
fn row_document(values: &[RowValue]) -> Document {
    let mut document = Document::new();
    for rv in values {
        // Skip an empty/blank `_id` so the server generates an ObjectId.
        if rv.column == "_id" && rv.value.as_deref().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        let bson = string_to_bson(rv.value.as_deref(), rv.column_type.as_deref());
        document.insert(rv.column.clone(), bson);
    }
    document
}

/// One field written by a multi-cell paste: `field` of the document `id`.
pub struct PasteSet<'a> {
    pub id: &'a Value,
    pub field: &'a str,
    pub value: Option<&'a str>,
    pub type_hint: Option<&'a str>,
}

/// What a paste did: how many documents it changed and added, and whether it
/// ran as one transaction.
pub struct PasteOutcome {
    pub updated: u64,
    pub inserted: u64,
    pub atomic: bool,
}

/// Whether the deployment runs multi-document transactions: a replica set
/// member or a `mongos`. A standalone server refuses them outright.
async fn supports_transactions(conn: &MongoConn) -> bool {
    let Ok(db) = resolve_db(conn) else {
        return false;
    };
    match db.run_command(doc! { "hello": 1 }).await {
        Ok(hello) => {
            hello.contains_key("setName") || hello.get_str("msg").is_ok_and(|m| m == "isdbgrid")
        }
        Err(_) => false,
    }
}

/// Apply a multi-cell paste: each `$set` on its document, then each new
/// document. In **one transaction** where the deployment has them (ADR #114);
/// on a standalone server in order, stopping at the first failure — what was
/// applied before it stays, and the error says so.
pub async fn apply_paste(
    conn: &MongoConn,
    collection: &str,
    sets: &[PasteSet<'_>],
    inserts: &[Vec<RowValue>],
) -> AppResult<PasteOutcome> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let update_of = |s: &PasteSet| {
        (
            doc! { "_id": id_to_bson(s.id) },
            doc! { "$set": { s.field: string_to_bson(s.value, s.type_hint) } },
        )
    };

    if supports_transactions(conn).await {
        let mut session = conn.client.start_session().await?;
        session.start_transaction().await?;
        let mut updated = 0;
        for s in sets {
            let (filter, update) = update_of(s);
            match coll.update_one(filter, update).session(&mut session).await {
                Ok(r) => updated += r.matched_count,
                Err(e) => {
                    let _ = session.abort_transaction().await;
                    return Err(e.into());
                }
            }
        }
        let mut inserted = 0;
        for row in inserts {
            match coll
                .insert_one(row_document(row))
                .session(&mut session)
                .await
            {
                Ok(_) => inserted += 1,
                Err(e) => {
                    let _ = session.abort_transaction().await;
                    return Err(e.into());
                }
            }
        }
        session.commit_transaction().await?;
        return Ok(PasteOutcome {
            updated,
            inserted,
            atomic: true,
        });
    }

    let (mut updated, mut inserted) = (0u64, 0u64);
    let stopped = |done: u64, e: mongodb::error::Error| {
        AppError::InvalidInput(format!(
            "{e} — this MongoDB server runs no transactions, so the {done} write(s) before \
             this one were applied and the rest were not"
        ))
    };
    for s in sets {
        let (filter, update) = update_of(s);
        match coll.update_one(filter, update).await {
            Ok(r) => updated += r.matched_count,
            Err(e) => return Err(stopped(updated + inserted, e)),
        }
    }
    for row in inserts {
        match coll.insert_one(row_document(row)).await {
            Ok(_) => inserted += 1,
            Err(e) => return Err(stopped(updated + inserted, e)),
        }
    }
    Ok(PasteOutcome {
        updated,
        inserted,
        atomic: false,
    })
}

/// Update every document matching `filters` with a `$set` built from
/// `set_values` — the MongoDB analogue of the SQL bulk `UPDATE ... WHERE`
/// built by `crate::commands::bulk`. Returns the modified-document count.
pub async fn bulk_update(
    conn: &MongoConn,
    collection: &str,
    filters: &[ColumnFilter],
    set_values: &[RowValue],
) -> AppResult<u64> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let filter = build_filter(filters, None, &[]);
    let set_doc = set_document(set_values);
    let r = coll.update_many(filter, doc! { "$set": set_doc }).await?;
    Ok(r.modified_count)
}

/// Render the filter + `$set` [`bulk_update`] would run as a
/// `db.<collection>.updateMany(...)`-style string, for the bulk-update
/// preview dialog. Built from the same `build_filter`/`set_document` calls
/// `bulk_update` uses, so the preview text can't drift from what actually
/// executes.
pub fn describe_bulk_update(
    collection: &str,
    filters: &[ColumnFilter],
    set_values: &[RowValue],
) -> String {
    let filter = build_filter(filters, None, &[]);
    let set_doc = set_document(set_values);
    format!(
        "db.{collection}.updateMany({}, {{ \"$set\": {} }})",
        Bson::Document(filter).into_canonical_extjson(),
        Bson::Document(set_doc).into_canonical_extjson()
    )
}

/// Build the `$set` document shared by [`bulk_update`] and
/// [`describe_bulk_update`] from column/value pairs (the same `RowValue`
/// shape `insert_row` takes).
fn set_document(set_values: &[RowValue]) -> Document {
    let mut set_doc = Document::new();
    for rv in set_values {
        let bson = string_to_bson(rv.value.as_deref(), rv.column_type.as_deref());
        set_doc.insert(rv.column.clone(), bson);
    }
    set_doc
}

/// Turn hand-typed document source into the documents to insert.
///
/// Pure, and separated from the insert itself so the rules below are testable
/// without a server — the same split `spec_is_view` has, and for the same
/// reason: what stands between a typo and someone's collection should not
/// require a live connection to exercise.
///
/// The grammar is [`shell::parse_relaxed_value`], not `serde_json`. That is the
/// one-parser rule (ADR #33) and it is load-bearing here rather than tidy:
/// a document typed with `_id: ObjectId("…")`, `ISODate("…")` or
/// `NumberLong(…)` has to mean the same thing in this box as it does in the
/// query editor and the aggregation builder, and `serde_json` would either
/// reject those outright or store them as strings. Unquoted keys, single
/// quotes, trailing commas and comments come along for free, which matters
/// because the text people paste here is copied out of a shell session.
///
/// An array is accepted as well as a single document, so pasting the output of
/// a `find()` inserts all of it. `insert_documents` maps that onto
/// `insert_many`.
///
/// Nothing is stripped on the way through — in particular a supplied `_id` is
/// kept. `insert_row`'s column/value path drops a blank one because an empty
/// text box there means "I did not fill this in"; here the document is written
/// out in full, so an absent `_id` is absent and the driver generates one,
/// while an explicit `_id: null` is a real null the server will reject. Both of
/// those are what the author asked for.
pub fn parse_insert_source(source: &str) -> AppResult<Vec<Document>> {
    if source.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "insert: nothing to insert (the document is empty)".into(),
        ));
    }
    match shell::parse_relaxed_value(source)? {
        Bson::Document(d) => Ok(vec![d]),
        Bson::Array(items) => {
            if items.is_empty() {
                return Err(AppError::InvalidInput(
                    "insert: the array is empty, so there is nothing to insert".into(),
                ));
            }
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.into_iter().enumerate() {
                match item {
                    Bson::Document(d) => out.push(d),
                    // Naming the index matters on a pasted array of fifty:
                    // "expected a document" alone leaves the author to find it.
                    other => {
                        return Err(AppError::InvalidInput(format!(
                            "insert: item {i} of the array is {}, not a document",
                            bson_type_name(&other)
                        )))
                    }
                }
            }
            Ok(out)
        }
        other => Err(AppError::InvalidInput(format!(
            "insert: expected a document or an array of documents, found {}",
            bson_type_name(&other)
        ))),
    }
}

/// Insert one or more documents written as source text.
///
/// The free-form counterpart to [`insert_row`], which can only ever set the
/// fields the grid already discovered — a collection is schemaless, so the
/// column set the browser inferred from a sampled page is a description of
/// what happens to be there, not of what a document may contain. Adding a
/// field the sample did not show was impossible through that path.
///
/// Returns the inserted `_id` for a single document and an array of them for
/// several, so the caller can report what landed rather than just a count.
pub async fn insert_documents(
    conn: &MongoConn,
    collection: &str,
    documents: Vec<Document>,
) -> AppResult<Value> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    if documents.len() == 1 {
        let res = coll
            .insert_one(documents.into_iter().next().expect("len checked"))
            .await?;
        return Ok(bson_to_json(&res.inserted_id));
    }

    // Ordered (the driver's default): a failure stops at the offending
    // document rather than carrying on and leaving the author to work out
    // which of fifty went in. Partial inserts are still possible — MongoDB has
    // no multi-document transaction outside a session — and the error carries
    // the index, which is the most a caller can act on.
    let res = coll.insert_many(documents).await?;
    let mut ids: Vec<Value> = Vec::with_capacity(res.inserted_ids.len());
    // `inserted_ids` is keyed by position; report them in that order rather
    // than in whatever order the map iterates.
    let mut keys: Vec<usize> = res.inserted_ids.keys().copied().collect();
    keys.sort_unstable();
    for k in keys {
        ids.push(bson_to_json(&res.inserted_ids[&k]));
    }
    Ok(Value::Array(ids))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_background_count_is_capped() {
        assert_eq!(
            super::count_ceiling(CountMode::Automatic),
            Some(Duration::from_millis(super::COUNT_TIMEOUT_MS))
        );
        assert_eq!(super::count_ceiling(CountMode::Exact), None);
    }

    /// The whole-collection count walks `_id_` unless the user named an
    /// index; a predicate with no hint is left to the planner, which can use
    /// an index for it — `_id_` would force a full index walk instead.
    #[test]
    fn a_count_walks_the_id_index_only_when_nothing_better_is_known() {
        use super::CountIndex;
        let whole = TableFilter::default();
        let filtered = TableFilter {
            raw: Some("{ qty: { $gt: 3 } }".into()),
            ..TableFilter::default()
        };
        assert_eq!(CountIndex::of(&whole, None), CountIndex::Id);
        assert_eq!(CountIndex::of(&filtered, None), CountIndex::Planner);
        assert_eq!(
            CountIndex::of(&whole, Some("ts_1")),
            CountIndex::User("ts_1")
        );
        assert_eq!(
            CountIndex::of(&filtered, Some("ts_1")),
            CountIndex::User("ts_1")
        );
    }

    /// A browse of `table` for the describe functions, which take a whole
    /// `TableQuery` now that collation and hint joined its shape.
    fn browse(
        table: &str,
        filter: TableFilter,
        order: Vec<SortSpec>,
        projection: Option<Projection>,
        limit: i64,
        offset: i64,
    ) -> TableQuery {
        TableQuery {
            connection_id: "c1".into(),
            schema: None,
            table: table.into(),
            limit,
            offset,
            order,
            filter,
            projection,
            collation: None,
            hint: None,
            with_count: false,
        }
    }

    use super::*;

    fn doc_with(pairs: &[(&str, Bson)]) -> Document {
        let mut d = Document::new();
        for (k, v) in pairs {
            d.insert(k.to_string(), v.clone());
        }
        d
    }

    // -- parse_insert_source -------------------------------------------------
    //
    // The rules standing between a typo and a collection, exercised without a
    // server. Everything here is about what reaches `insert_documents`; the
    // grammar itself is `shell::parse_relaxed_value`'s and is tested there.

    #[test]
    fn parse_insert_source_takes_one_document() {
        let docs = parse_insert_source(r#"{ "name": "ada", "n": 3 }"#).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].get_str("name").unwrap(), "ada");
    }

    #[test]
    fn parse_insert_source_takes_an_array_for_a_bulk_insert() {
        let docs = parse_insert_source(r#"[{ "a": 1 }, { "a": 2 }]"#).unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[1].get_i32("a").unwrap(), 2);
    }

    #[test]
    fn parse_insert_source_speaks_the_shell_grammar_not_json() {
        // The point of reusing the one parser: what someone pastes out of a
        // shell session has to mean here what it means in the query editor.
        // `serde_json` would reject every line of this.
        let docs = parse_insert_source(
            r#"{
                 _id: ObjectId("507f1f77bcf86cd799439011"),
                 when: ISODate("2024-01-02T03:04:05Z"),
                 big: NumberLong(301353073),
                 tags: ['a', 'b',], // trailing comma, single quotes, a comment
               }"#,
        )
        .unwrap();
        let d = &docs[0];
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(d.get("when"), Some(Bson::DateTime(_))));
        // Not an Int32: a `Long` narrowed on the way in is ADR #29's trap,
        // and it fits in an i32, so nothing downstream would notice.
        assert!(matches!(d.get("big"), Some(Bson::Int64(301353073))));
    }

    #[test]
    fn parse_insert_source_keeps_a_supplied_id() {
        // `insert_row` drops a blank `_id` because an empty text box there
        // means "not filled in". Here the document is written out in full, so
        // what is present is deliberate.
        let docs = parse_insert_source(r#"{ "_id": 7, "a": 1 }"#).unwrap();
        assert_eq!(docs[0].get_i32("_id").unwrap(), 7);
    }

    #[test]
    fn parse_insert_source_leaves_a_missing_id_absent() {
        let docs = parse_insert_source(r#"{ "a": 1 }"#).unwrap();
        assert!(!docs[0].contains_key("_id"));
    }

    #[test]
    fn parse_insert_source_rejects_a_scalar() {
        let err = parse_insert_source("42").unwrap_err().to_string();
        assert!(err.contains("document"), "{err}");
    }

    #[test]
    fn parse_insert_source_rejects_an_empty_source() {
        assert!(parse_insert_source("   ").is_err());
    }

    #[test]
    fn parse_insert_source_rejects_an_empty_array() {
        // Distinct from a parse failure: the text is valid and means "insert
        // nothing", which is never what was intended.
        let err = parse_insert_source("[]").unwrap_err().to_string();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn parse_insert_source_names_the_offending_array_index() {
        // On a pasted array of fifty, "expected a document" alone leaves the
        // author to find it.
        let err = parse_insert_source(r#"[{ "a": 1 }, 2, { "a": 3 }]"#)
            .unwrap_err()
            .to_string();
        assert!(err.contains("item 1"), "{err}");
    }

    #[test]
    fn parse_insert_source_rejects_trailing_junk() {
        // Inherited from `parse_relaxed_value`, and worth pinning here: two
        // documents pasted without an array around them must not silently
        // insert only the first.
        assert!(parse_insert_source(r#"{ "a": 1 } { "b": 2 }"#).is_err());
    }

    #[test]
    fn docs_to_result_infers_uniform_column_type() {
        let docs = vec![
            doc_with(&[("_id", Bson::Int32(1)), ("name", Bson::String("a".into()))]),
            doc_with(&[("_id", Bson::Int32(2)), ("name", Bson::String("b".into()))]),
        ];
        let result = docs_to_result(docs, 0, false);
        let name_col = result.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name_col.data_type, "string");
    }

    #[test]
    fn docs_to_result_ships_a_type_tree_per_cell() {
        // The grid's list view writes a field back with the type it reads
        // here, so the trees must line up with `rows` cell for cell — a
        // misaligned tree would retype an unrelated field on the next edit.
        let mut nested = Document::new();
        nested.insert("inner", Bson::Int64(9));
        let docs = vec![doc_with(&[
            ("_id", Bson::Int32(1)),
            ("big", Bson::Int64(301_353_073)),
            ("obj", Bson::Document(nested)),
        ])];
        let result = docs_to_result(docs, 0, false);
        let types = result.row_types.expect("mongo results carry row types");
        let index = |name: &str| {
            result
                .columns
                .iter()
                .position(|c| c.name == name)
                .expect("column present")
        };
        assert_eq!(types[0][index("_id")], Value::String("int".into()));
        // The value is a plain JSON number that fits in an i32 — only the tree
        // knows it is a Long.
        assert_eq!(result.rows[0][index("big")], serde_json::json!(301_353_073));
        assert_eq!(types[0][index("big")], Value::String("long".into()));
        assert_eq!(
            types[0][index("obj")],
            serde_json::json!({ "inner": "long" })
        );
    }

    #[test]
    fn docs_to_result_types_a_field_missing_from_a_document_as_null() {
        let docs = vec![
            doc_with(&[("_id", Bson::Int32(1)), ("name", Bson::String("a".into()))]),
            doc_with(&[("_id", Bson::Int32(2))]),
        ];
        let result = docs_to_result(docs, 0, false);
        let types = result.row_types.expect("mongo results carry row types");
        let name = result
            .columns
            .iter()
            .position(|c| c.name == "name")
            .expect("column present");
        assert_eq!(types[1][name], Value::String("null".into()));
    }

    #[test]
    fn docs_to_result_falls_back_to_mixed_on_type_disagreement() {
        let docs = vec![
            doc_with(&[("value", Bson::Int32(1))]),
            doc_with(&[("value", Bson::String("oops".into()))]),
        ];
        let result = docs_to_result(docs, 0, false);
        let col = result.columns.iter().find(|c| c.name == "value").unwrap();
        assert_eq!(col.data_type, "mixed");
    }

    #[test]
    fn docs_to_result_ignores_nulls_when_inferring_type() {
        let docs = vec![
            doc_with(&[("value", Bson::Null)]),
            doc_with(&[("value", Bson::Int64(42))]),
        ];
        let result = docs_to_result(docs, 0, false);
        let col = result.columns.iter().find(|c| c.name == "value").unwrap();
        assert_eq!(col.data_type, "long");
    }

    #[test]
    fn docs_to_result_reports_null_when_field_never_present() {
        let docs = vec![doc_with(&[("_id", Bson::Int32(1))])];
        let result = docs_to_result(docs, 0, false);
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "_id");
        assert_eq!(result.columns[0].data_type, "int");
    }

    #[test]
    fn an_empty_browse_page_still_reports_the_id_column() {
        let mut result = docs_to_result(Vec::new(), 0, false);
        assert!(result.columns.is_empty());
        seed_id_column(&mut result);
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "_id");
        assert!(result.rows.is_empty());
    }

    #[test]
    fn a_populated_browse_page_keeps_its_own_columns() {
        let docs = vec![doc_with(&[
            ("_id", Bson::Int32(1)),
            ("name", Bson::String("a".into())),
        ])];
        let mut result = docs_to_result(docs, 0, false);
        seed_id_column(&mut result);
        let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["_id", "name"]);
        assert_eq!(result.columns[0].data_type, "int");
    }

    #[test]
    fn describe_find_builds_a_readable_mongosh_style_string() {
        let filters = vec![ColumnFilter {
            column: "atnId".to_string(),
            op: FilterOp::Eq,
            value: serde_json::json!(183),
            value2: serde_json::Value::Null,
            values: Vec::new(),
        }];
        let order = vec![SortSpec {
            column: "atnId".to_string(),
            desc: true,
        }];
        let predicate = TableFilter {
            filters,
            ..TableFilter::default()
        };
        let s = describe_find(&browse("events", predicate, order, None, 50, 100));
        assert!(s.starts_with("db.events.find("));
        assert!(s.contains("\"atnId\""));
        assert!(s.contains(".sort("));
        assert!(s.contains(".skip(100)"));
        assert!(s.contains(".limit(50)"));
    }

    fn raw(text: &str) -> TableFilter {
        TableFilter {
            raw: Some(text.to_string()),
            ..TableFilter::default()
        }
    }

    #[test]
    fn predicate_doc_reads_the_shell_grammar() {
        let d = predicate_doc(&raw("{ qty: { $gt: 3 }, code: 'A' }")).unwrap();
        assert_eq!(d, doc! { "qty": { "$gt": 3 }, "code": "A" });
    }

    #[test]
    fn predicate_doc_ands_the_expression_with_the_chips() {
        let p = TableFilter {
            filters: vec![ColumnFilter {
                column: "code".into(),
                op: FilterOp::Eq,
                value: serde_json::json!("A"),
                value2: Value::Null,
                values: Vec::new(),
            }],
            raw: Some("{ qty: 1 }".into()),
            ..TableFilter::default()
        };
        let d = predicate_doc(&p).unwrap();
        let and = d.get_array("$and").expect("chips and expression are ANDed");
        assert_eq!(and.len(), 2);
    }

    #[test]
    fn predicate_doc_refuses_what_is_not_a_document() {
        assert!(predicate_doc(&raw("[1, 2]")).is_err());
        assert!(predicate_doc(&raw("{ qty: ")).is_err());
    }

    #[test]
    fn describe_find_shell_round_trips_through_the_query_tab_parser() {
        let order = vec![SortSpec {
            column: "ts".into(),
            desc: true,
        }];
        let p = Projection {
            fields: vec!["code".into()],
            exclude: false,
        };
        let text = describe_find_shell(&browse(
            "device",
            raw("{ qty: { $gt: 3 } }"),
            order,
            Some(p),
            100,
            200,
        ))
        .unwrap();
        assert!(text.starts_with("db.device.find("), "{text}");
        // What "Open in editor" writes is something the query tab runs.
        assert!(shell::parse(&text).is_ok(), "the shell cannot read: {text}");
    }

    #[test]
    fn describe_find_shell_quotes_an_unusual_collection_name() {
        let text = describe_find_shell(&browse(
            "my-coll",
            TableFilter::default(),
            vec![],
            None,
            0,
            0,
        ))
        .unwrap();
        assert!(text.starts_with("db.getCollection(\"my-coll\")"), "{text}");
        assert!(shell::parse(&text).is_ok(), "the shell cannot read: {text}");
    }

    #[test]
    fn collation_and_hint_round_trip_through_the_query_tab_parser() {
        let mut q = browse("device", TableFilter::default(), vec![], None, 100, 0);
        q.collation = Some("{ locale: 'es', strength: 1 }".into());
        q.hint = Some("code_1".into());
        let text = describe_find_shell(&q).unwrap();
        assert!(text.contains(".collation("), "{text}");
        assert!(text.contains(".hint(\"code_1\")"), "{text}");
        match shell::parse(&text).unwrap().op {
            MongoOp::Find {
                collation, hint, ..
            } => {
                assert_eq!(
                    collation.as_deref(),
                    Some(&doc! { "locale": "es", "strength": 1 })
                );
                assert_eq!(hint.as_deref(), Some(&Bson::String("code_1".into())));
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn a_collation_needs_a_locale() {
        assert!(collation_doc(Some("{ strength: 1 }")).is_err());
        assert!(collation_doc(Some("'es'")).is_err());
        assert!(collation_doc(Some("{ locale: 'es', strength: 2 }")).is_ok());
        assert_eq!(collation_doc(None).unwrap(), None);
    }

    #[test]
    fn projection_doc_includes_or_excludes_and_never_mixes() {
        let include = Projection {
            fields: vec!["ts".into(), "code".into()],
            exclude: false,
        };
        assert_eq!(
            projection_doc(Some(&include)),
            Some(doc! { "ts": 1, "code": 1 })
        );

        let exclude = Projection {
            fields: vec!["configuration".into()],
            exclude: true,
        };
        assert_eq!(
            projection_doc(Some(&exclude)),
            Some(doc! { "configuration": 0 })
        );
    }

    #[test]
    fn an_empty_projection_is_the_whole_document() {
        // What every caller that predates projection sends, spelled two ways.
        assert_eq!(projection_doc(None), None);
        assert_eq!(projection_doc(Some(&Projection::default())), None);
    }

    #[test]
    fn describe_find_shows_the_projection_as_find_s_second_argument() {
        let p = Projection {
            fields: vec!["code".into()],
            exclude: false,
        };
        let s = describe_find(&browse(
            "device",
            TableFilter::default(),
            vec![],
            Some(p),
            0,
            0,
        ));
        assert!(s.starts_with("db.device.find({}, {"), "{s}");
        assert!(s.contains("\"code\""), "{s}");
    }

    #[test]
    fn between_builds_gte_lte_document() {
        let filters = vec![ColumnFilter {
            column: "age".to_string(),
            op: FilterOp::Between,
            value: serde_json::json!(18),
            value2: serde_json::json!(65),
            values: Vec::new(),
        }];
        let filter = build_filter(&filters, None, &[]);
        let age = filter.get_document("age").unwrap();
        assert_eq!(age.get_i32("$gte").unwrap(), 18);
        assert_eq!(age.get_i32("$lte").unwrap(), 65);
    }

    #[test]
    fn in_and_not_in_build_in_nin_documents() {
        let mk = |op: FilterOp| {
            vec![ColumnFilter {
                column: "status".to_string(),
                op,
                value: serde_json::Value::Null,
                value2: serde_json::Value::Null,
                values: vec![serde_json::json!("a"), serde_json::json!("b")],
            }]
        };

        let f = build_filter(&mk(FilterOp::In), None, &[]);
        let status = f.get_document("status").unwrap();
        let list = status.get_array("$in").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].as_str(), Some("a"));

        let f = build_filter(&mk(FilterOp::NotIn), None, &[]);
        let status = f.get_document("status").unwrap();
        assert_eq!(status.get_array("$nin").unwrap().len(), 2);
    }

    #[test]
    fn in_on_id_reconstructs_object_ids() {
        // `_id` values arrive as hex strings from the grid; each one has to go
        // through the ObjectId-aware conversion or the `$in` would compare
        // strings against real ObjectIds and match nothing.
        let hex = "65f1c2d3e4b5a60718293a4b";
        let filters = vec![ColumnFilter {
            column: "_id".to_string(),
            op: FilterOp::In,
            value: serde_json::Value::Null,
            value2: serde_json::Value::Null,
            values: vec![serde_json::json!(hex)],
        }];
        let f = build_filter(&filters, None, &[]);
        let list = f.get_document("_id").unwrap().get_array("$in").unwrap();
        assert!(
            matches!(list[0], Bson::ObjectId(_)),
            "expected an ObjectId, got {:?}",
            list[0]
        );
    }

    #[test]
    fn describe_find_omits_skip_and_limit_when_zero() {
        let s = describe_find(&browse(
            "events",
            TableFilter::default(),
            vec![],
            None,
            0,
            0,
        ));
        assert_eq!(s, "db.events.find({})");
    }

    /// Pull the field-level `$regex` out of a text-match clause's first branch.
    fn first_branch_regex(clause: &Document, key: &str, column: &str) -> String {
        let branches = clause.get_array(key).unwrap();
        branches[0]
            .as_document()
            .unwrap()
            .get_document(column)
            .unwrap()
            .get_str("$regex")
            .unwrap()
            .to_string()
    }

    /// Pull the `$regexMatch` regex out of a text-match clause's `$expr` branch.
    /// Branch 2's per-element `$map`.
    fn expr_branch_map<'a>(clause: &'a Document, key: &str) -> &'a Document {
        clause.get_array(key).unwrap()[1]
            .as_document()
            .unwrap()
            .get_document("$expr")
            .unwrap()
            .get_document("$anyElementTrue")
            .unwrap()
            .get_document("$map")
            .unwrap()
    }

    /// The `$regexMatch` branch 2 applies to each element.
    fn expr_branch_match<'a>(clause: &'a Document, key: &str) -> &'a Document {
        expr_branch_map(clause, key)
            .get_document("in")
            .unwrap()
            .get_document("$regexMatch")
            .unwrap()
    }

    fn expr_branch_regex(clause: &Document, key: &str) -> String {
        expr_branch_match(clause, key)
            .get_str("regex")
            .unwrap()
            .to_string()
    }

    /// The field path branch 2 maps over, read off its `$isArray` test.
    fn expr_branch_field(clause: &Document, key: &str) -> String {
        expr_branch_map(clause, key)
            .get_document("input")
            .unwrap()
            .get_array("$cond")
            .unwrap()[0]
            .as_document()
            .unwrap()
            .get_str("$isArray")
            .unwrap()
            .to_string()
    }

    fn text_filter(op: FilterOp, column: &str, value: &str) -> Vec<ColumnFilter> {
        vec![ColumnFilter {
            column: column.to_string(),
            op,
            value: serde_json::json!(value),
            value2: serde_json::Value::Null,
            values: Vec::new(),
        }]
    }

    /// The frontend decides a filter value's BSON type; this side must not
    /// second-guess it.
    ///
    /// The regression: a `value` field the grid header showed as STRING was
    /// filtered with `$ne` against an `Int32`, because the *frontend* coerced
    /// the typed text using a catalog sample that still described older,
    /// numeric documents. BSON equality is exact by type, so the filter
    /// excluded nothing and reported no error. Nothing here caused that — and
    /// nothing here may ever "helpfully" parse a numeric-looking string into a
    /// number, which would put the same failure back a layer down where no
    /// value-type control can reach it.
    #[test]
    fn a_filter_value_keeps_the_json_type_it_arrived_with() {
        let f = build_filter(&text_filter(FilterOp::Ne, "value", "5682380"), None, &[]);
        assert_eq!(
            f.get_document("value").unwrap().get("$ne"),
            Some(&Bson::String("5682380".into())),
            "a JSON string must stay a BSON string"
        );

        let numeric = vec![ColumnFilter {
            column: "value".into(),
            op: FilterOp::Ne,
            value: serde_json::json!(5682380),
            value2: serde_json::Value::Null,
            values: Vec::new(),
        }];
        assert_eq!(
            build_filter(&numeric, None, &[])
                .get_document("value")
                .unwrap()
                .get("$ne"),
            Some(&Bson::Int32(5682380)),
            "and a JSON number a BSON number"
        );
    }

    /// The Extended JSON the filter row's value-type control emits is decoded
    /// here, which is why that control needed no backend change at all.
    #[test]
    fn extended_json_in_a_filter_value_becomes_its_bson_type() {
        for (tag, raw, expected) in [
            (
                "$numberLong",
                "9007199254740993",
                Bson::Int64(9007199254740993),
            ),
            (
                "$oid",
                "507f1f77bcf86cd799439011",
                Bson::ObjectId(
                    mongodb::bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
                ),
            ),
        ] {
            let f = build_filter(
                &[ColumnFilter {
                    // Deliberately not `_id`: that column has its own
                    // ObjectId-aware path, and `$oid` on any *other* field is
                    // the only way to reach one.
                    column: "ref".into(),
                    op: FilterOp::Eq,
                    value: serde_json::json!({ tag: raw }),
                    value2: serde_json::Value::Null,
                    values: Vec::new(),
                }],
                None,
                &[],
            );
            assert_eq!(f.get("ref"), Some(&expected));
        }
    }

    #[test]
    fn contains_emits_both_an_indexed_and_a_stringifying_branch() {
        // A bare `$regex` never matches a numeric field, and says so by
        // returning zero rows rather than an error. The `$expr` branch is what
        // makes `contains` on a `long` behave like the SQL drivers' CAST.
        let f = build_filter(&text_filter(FilterOp::Contains, "ts", "1788"), None, &[]);
        assert_eq!(f.get_array("$or").unwrap().len(), 2);
        assert_eq!(first_branch_regex(&f, "$or", "ts"), "1788");
        assert_eq!(expr_branch_regex(&f, "$or"), "1788");

        // The stringification has to tolerate a missing field or a subdocument;
        // a bare `$toString` would abort the whole query on either. It converts
        // one element at a time (`$$this`), never the field as a whole — see
        // the array test below.
        let convert = expr_branch_match(&f, "$or")
            .get_document("input")
            .unwrap()
            .get_document("$convert")
            .unwrap();
        assert_eq!(convert.get_str("input").unwrap(), "$$this");
        assert_eq!(convert.get_str("to").unwrap(), "string");
        assert_eq!(convert.get_str("onError").unwrap(), "");
        assert_eq!(convert.get_str("onNull").unwrap(), "");
        assert_eq!(expr_branch_field(&f, "$or"), "$ts");
    }

    #[test]
    fn text_match_asks_per_element_so_a_path_through_an_array_still_matches() {
        // `items.qty` resolves to an array of numbers, and `$convert` folds an
        // array to `""` — so converting the field whole answered zero rows for
        // every numeric field reachable through an array, which is precisely
        // what the nested-path field picker made reachable.
        let f = build_filter(
            &text_filter(FilterOp::Contains, "items.qty", "17"),
            None,
            &[],
        );
        assert_eq!(expr_branch_field(&f, "$or"), "$items.qty");
        assert_eq!(expr_branch_regex(&f, "$or"), "17");
        let cond = expr_branch_map(&f, "$or")
            .get_document("input")
            .unwrap()
            .get_array("$cond")
            .unwrap();
        // Array branch: the field itself. Scalar branch: the field wrapped in a
        // one-element array, so the same `$map` serves both.
        assert_eq!(cond[1].as_str().unwrap(), "$items.qty");
        assert_eq!(cond[2].as_array().unwrap().len(), 1);
    }

    #[test]
    fn not_contains_negates_the_whole_branch_set() {
        // `$nor`, not an `$and` of two negations: a document matching the
        // indexed branch can never also fail the `$expr` one, so per-branch
        // negation would be a different — and always-empty — predicate.
        let f = build_filter(&text_filter(FilterOp::NotContains, "ts", "1788"), None, &[]);
        assert!(
            f.get_array("$or").is_err(),
            "NotContains must not emit a union"
        );
        assert_eq!(f.get_array("$nor").unwrap().len(), 2);
        assert_eq!(first_branch_regex(&f, "$nor", "ts"), "1788");
        assert_eq!(expr_branch_regex(&f, "$nor"), "1788");
    }

    #[test]
    fn starts_with_and_ends_with_anchor_both_branches() {
        // An anchor applied to only one branch would make the two disagree
        // about what matches, which is worse than either alone.
        let f = build_filter(&text_filter(FilterOp::StartsWith, "code", "AB"), None, &[]);
        assert_eq!(first_branch_regex(&f, "$or", "code"), "^AB");
        assert_eq!(expr_branch_regex(&f, "$or"), "^AB");

        let f = build_filter(&text_filter(FilterOp::EndsWith, "code", "AB"), None, &[]);
        assert_eq!(first_branch_regex(&f, "$or", "code"), "AB$");
        assert_eq!(expr_branch_regex(&f, "$or"), "AB$");
    }

    #[test]
    fn text_match_escapes_metacharacters_in_both_branches() {
        let f = build_filter(&text_filter(FilterOp::Contains, "note", "a.b*c"), None, &[]);
        assert_eq!(first_branch_regex(&f, "$or", "note"), "a\\.b\\*c");
        assert_eq!(expr_branch_regex(&f, "$or"), "a\\.b\\*c");
    }

    #[test]
    fn text_match_on_a_dotted_path_builds_a_nested_field_path() {
        // A Mongo column can be a dotted path (ADR #29); the `$expr` branch
        // has to address it as `$a.b`, not as a literal key.
        let f = build_filter(
            &text_filter(FilterOp::Contains, "customData.format", "pdf"),
            None,
            &[],
        );
        assert_eq!(expr_branch_field(&f, "$or"), "$customData.format");
    }
}
