//! The foreign-key dropdown: one page of the target table's keys, with a label
//! column when one can be picked.

use super::filter::escape_like;
use crate::commands::schema::list_columns_inner;
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Serialize;
use serde_json::Value;

/// One row in an FK dropdown payload.
#[derive(Debug, Serialize)]
pub struct FkOption {
    pub value: String,
    pub label: Option<String>,
}

/// Page of FK options. `has_more` is true when more matching rows exist
/// beyond `limit`; the caller can switch from client-side filtering to a
/// server-side search request when this is set.
#[derive(Debug, Serialize)]
pub struct FkOptionsPage {
    pub options: Vec<FkOption>,
    pub has_more: bool,
}

/// Render a `serde_json::Value` as the stringified form the cell editor
/// uses for `update_cell` and `insert_row`. Numbers, bools and strings go
/// through as-is; nulls become an empty string (callers should drop the
/// row entirely before reaching here, but we guard for safety).
pub(super) fn value_to_dropdown_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Auto-pick the first non-PK column whose `data_type` looks like a text
/// type (text / varchar / char / citext / name / clob). Case-insensitive.
pub(super) fn pick_label_column(cols: &[crate::commands::schema::ColumnInfo]) -> Option<String> {
    const TEXT_HINTS: &[&str] = &["text", "varchar", "char", "citext", "name", "clob"];
    cols.iter()
        .filter(|c| !c.is_primary_key)
        .find(|c| {
            let t = c.data_type.to_lowercase();
            TEXT_HINTS.iter().any(|h| t.contains(h))
        })
        .map(|c| c.name.clone())
}

/// The options [`super::fetch_fk_options`] returns, once the command has
/// reopened a reaped pool and checked the policy: validate the key against the
/// target's catalog, then read one page of `key` (and `label`) values, `limit`
/// plus one so `has_more` needs no second `COUNT(*)`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn fetch_fk_options_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
    key_column: String,
    label_column: Option<String>,
    search: Option<String>,
    limit: i64,
) -> AppResult<FkOptionsPage> {
    // Catalog validation. Failing here means the target was dropped or
    // moved out from under us; the frontend treats this as "fall back to
    // plain input".
    let cols = list_columns_inner(state, connection_id, schema.clone(), table.clone()).await?;
    if cols.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: target table {table} has no columns or is inaccessible",
        )));
    }
    if !cols.iter().any(|c| c.name == key_column) {
        return Err(AppError::InvalidInput(format!(
            "fetch_fk_options: key column {key_column} not found on {table}",
        )));
    }

    let label_col: Option<String> = match label_column {
        Some(name) if cols.iter().any(|c| c.name == name) => Some(name),
        Some(_) => None, // caller-specified but missing; ignore
        None => pick_label_column(&cols),
    };

    let pool = state.pool_for(connection_id)?;
    // MongoDB has no foreign keys; the FK combobox is not offered for it.
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "foreign-key lookups are not supported on MongoDB".into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;

    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let key_id = dialect.quote_ident(&key_column);
    let label_id = label_col.as_ref().map(|c| dialect.quote_ident(c));

    // Projection: key first, label second (when present).
    let projection = match &label_id {
        Some(l) => format!("{key_id} AS k, {l} AS lbl"),
        None => format!("{key_id} AS k"),
    };

    let search_term = search.as_deref().filter(|s| !s.is_empty());
    let mut binds: Vec<Option<String>> = Vec::new();
    let where_clause = if let Some(term) = search_term {
        let pattern = format!("%{}%", escape_like(term));
        let like_kw = dialect.like_kw();
        let cast_to = dialect.cast_to_text();
        let escape = dialect.like_escape_clause();
        let ph1 = dialect.placeholder(1);
        let ph2 = dialect.placeholder(2);
        let mut parts = vec![format!(
            "CAST({key_id} AS {cast_to}) {like_kw} {ph1}{escape}"
        )];
        binds.push(Some(pattern.clone()));
        if let Some(l) = &label_id {
            parts.push(format!("CAST({l} AS {cast_to}) {like_kw} {ph2}{escape}"));
            binds.push(Some(pattern));
        }
        format!(" WHERE {}", parts.join(" OR "))
    } else {
        String::new()
    };

    // Request limit+1 so we can detect has_more without a second COUNT(*).
    let fetch_limit = limit.max(0).saturating_add(1);
    // There is always an `ORDER BY`, so T-SQL's OFFSET/FETCH needs no filler.
    let page = dialect.paginate(fetch_limit, 0, true);
    let sql = format!("SELECT {projection} FROM {qt}{where_clause} ORDER BY {key_id}{page}");

    // The four arms differed only in which `*_value` decoder they called, so
    // this now goes through `db::exec::query_rows` and reads the two decoded
    // columns positionally. `projection` puts the key first and the optional
    // label second, which is what makes the indices safe.
    let (_cols, rows) = crate::db::exec::query_rows(&pool, &sql, &binds).await?;
    let mut options: Vec<FkOption> = rows
        .into_iter()
        .map(|row| {
            let value = value_to_dropdown_string(row.first().unwrap_or(&Value::Null));
            let label = if label_id.is_some() {
                match row.get(1) {
                    Some(Value::Null) | None => None,
                    Some(other) => Some(value_to_dropdown_string(other)),
                }
            } else {
                None
            };
            FkOption { value, label }
        })
        .collect();

    let has_more = options.len() as i64 > limit;
    if has_more {
        options.truncate(limit.max(0) as usize);
    }
    Ok(FkOptionsPage { options, has_more })
}
