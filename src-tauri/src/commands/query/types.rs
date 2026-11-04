//! The DTOs the query commands take and return — `TableQuery` / `TableScan`
//! in, `QueryResult` / `CountResult` / `BatchResult` out — plus the small
//! helpers that build their column metadata.

use super::filter::TableFilter;
use super::statement::Projection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the query panel's *Result* line shows: the statement a browse would
/// run, in the language of the connection's own editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPreview {
    pub text: String,
    /// `"sql"` or `"mongodb"` — which editor "Open in editor" should expect.
    pub language: &'static str,
}

/// A table plus a predicate over it, with no paging — what
/// [`count_table_rows`] and `export_table_rows` address.
///
/// `order` and `projection` are the browse's *shape*. The export reads them so
/// "export query results" writes what the grid shows, in the order it shows
/// it; the count ignores both, since neither changes how many rows match.
///
/// `filter` is `#[serde(flatten)]`ed, so the IPC payload stays the flat object
/// the frontend already sent (`{ connectionId, schema, table, filters, search,
/// searchColumns }`); only the Rust side gained the grouping.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableScan {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    #[serde(flatten)]
    pub filter: TableFilter,
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(default)]
    pub projection: Option<Projection>,
    /// See [`TableQuery::collation`]. Read by the export (its order) and by the
    /// MongoDB count, where a collation changes which documents match.
    #[serde(default)]
    pub collation: Option<String>,
    /// See [`TableQuery::hint`]. Read by the export.
    #[serde(default)]
    pub hint: Option<String>,
}

/// One page of a table browse: a [`TableScan`]'s address and predicate, plus
/// the ordering, the window and whether to count.
///
/// Declared as one struct rather than embedding [`TableScan`] because a
/// doubly-flattened payload is harder to read than the nine fields it stands
/// for, and this is the shape the frontend types mirror (see `TableQuery` in
/// `src/types.ts` — a field missing on either side is silently dropped by
/// serde, gotcha #14, which is what the round-trip test at the
/// bottom of this module pins down).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub connection_id: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub limit: i64,
    pub offset: i64,
    /// Ordered multi-column sort; `order[0]` is the primary key.
    #[serde(default)]
    pub order: Vec<SortSpec>,
    #[serde(flatten)]
    pub filter: TableFilter,
    /// Fields to return; `None` is every field. See [`Projection`].
    #[serde(default)]
    pub projection: Option<Projection>,
    /// The query panel's *Collation*. SQL: a collation **name**, applied to
    /// every `ORDER BY` key (see [`collate_clause`]). MongoDB: a collation
    /// **document** (`{ locale: 'es', strength: 1 }`), which the server applies
    /// to the filter and the sort alike. Blank is none.
    #[serde(default)]
    pub collation: Option<String>,
    /// The query panel's *Index (hint)*: the name of an index the planner must
    /// use. See [`from_clause`] for the per-dialect syntax, and for PostgreSQL,
    /// which has none. Blank is none.
    #[serde(default)]
    pub hint: Option<String>,
    /// Whether to run the companion `SELECT COUNT(*)`. The GUI passes `false`
    /// when only the sort/offset/page changed (the total cannot have moved)
    /// and reuses its cached total, saving a round trip per interaction; the
    /// headless MCP `browse_table` tool wants the inline count. Defaults to
    /// `true` when the key is absent, which is the pre-struct behaviour of
    /// `Option<bool>::unwrap_or(true)`.
    #[serde(default = "with_count_default")]
    pub with_count: bool,
    /// MongoDB only: replace any top-level field whose BSON size is over this
    /// many bytes with a placeholder in the page, rather than sending it. The
    /// grid's listing sets it from `GridPrefs::trim_large_values_kb`; every
    /// other caller (the MCP connector, the AI panel, export) leaves it `None`
    /// and gets whole documents. See [`QueryResult::trimmed`] and ADR #133.
    #[serde(default)]
    pub trim_above: Option<u32>,
}

pub(super) fn with_count_default() -> bool {
    true
}

/// One level of an `ORDER BY` clause built by [`fetch_table_data`].
///
/// The frontend sends an ordered list (`order[0]` is the primary sort key,
/// `order[1]` the tie-breaker, …) so the data browser can sort by several
/// columns at once. Identifiers are quoted via [`Dialect::quote_ident`]; only the
/// `ASC`/`DESC` keyword is interpolated, derived from the boolean.
#[derive(Debug, Deserialize, Clone)]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// One column/value pair used to build an INSERT statement.
///
/// We use parallel positional encoding (`Vec<RowValue>`) instead of a
/// `HashMap` so column order is preserved verbatim from the frontend —
/// otherwise we cannot pair columns with their placeholders deterministically.
/// `Serialize` as well, for the same reason as [`QueryResult`]: the bridge
/// carries these to whichever process owns the pool.
#[derive(Debug, Serialize, Deserialize)]
pub struct RowValue {
    pub column: String,
    /// Always a string or `null`. The cell editor and `RowEditor` dialog
    /// produce text only; the engine coerces it, or on Postgres the SQL
    /// casts it to the column's type (ADR #129).
    pub value: Option<String>,
    /// Raw `data_type` string from `ColumnMeta` (e.g. `"BIT"` for MySQL BIT
    /// columns). Used to detect columns that need special binding (see
    /// `insert_row`'s MySQL BIT handling). `None` when the frontend has no
    /// type information (safe default: no special handling).
    ///
    /// Spelled `columnType` on the wire, with `column_type` accepted as an
    /// alias. Tauri renames a command's *top-level* arguments from camelCase
    /// but leaves the fields of a nested struct to serde, and a `RowValue`
    /// always arrives nested (`values: Vec<RowValue>`, `setValues: …`). The
    /// frontend sends `columnType`, so without the rename serde dropped it as
    /// an unknown field and every hint read as `None`: a MongoDB insert or
    /// duplicate wrote each field as a string (`string_to_bson`'s fallback
    /// arm), SQL Server lost its binary `CONVERT`, and MySQL only kept `BIT`
    /// working because of the catalogue fallback in `insert_row_inner`.
    #[serde(default, rename = "columnType", alias = "column_type")]
    pub column_type: Option<String>,
}

/// Result set returned to the frontend.
///
/// `Deserialize` as well as `Serialize` since the MCP bridge sends this back
/// across a process boundary: the sidecar re-reads it to apply the connection's
/// MCP row cap (`crate::state::mcp_max_rows`) before handing it to the model.
#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    /// Columns of the result set, in order.
    pub columns: Vec<ColumnMeta>,
    /// One inner `Vec` per row, with values aligned to `columns`.
    pub rows: Vec<Vec<Value>>,
    /// Number of rows affected (`UPDATE`/`DELETE`/`INSERT`) or returned
    /// (`SELECT`).
    pub rows_affected: u64,
    /// Wall-clock time of the round-trip in milliseconds.
    pub elapsed_ms: u64,
    /// For [`fetch_table_data`] only: the total row count of the table
    /// (so the UI can show "1–100 of 12,345").
    pub total: Option<u64>,
    /// `true` when the driver returned more rows than [`MAX_ADHOC_QUERY_ROWS`]
    /// and the excess was discarded rather than sent to the frontend. Only
    /// ever set on a hand-typed SELECT with no `LIMIT`/`TOP`/`.limit()` of its
    /// own — [`fetch_table_data`] always paginates server-side and never
    /// truncates.
    #[serde(default)]
    pub truncated: bool,
    /// MongoDB only: the per-cell BSON *type* structure mirroring `rows`, one
    /// inner `Vec` per row aligned to `columns` (see
    /// [`crate::db::mongo::values::bson_type_tree`]).
    ///
    /// The SQL drivers leave this `None`: their column types are uniform per
    /// column and already carried by [`ColumnMeta::data_type`]. MongoDB's are
    /// not — a field's type is a property of the individual document, and
    /// nested fields have no `ColumnMeta` at all — so the document list view
    /// would otherwise have to guess a type from the (deliberately lossy)
    /// display JSON and would rewrite a `Long` as an `Int` on the first edit.
    ///
    /// Skipped when absent so a SQL result's payload is byte-identical to what
    /// it was before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_types: Option<Vec<Vec<Value>>>,
    /// MongoDB browse only, when [`TableQuery::trim_above`] is set: the cells
    /// that were too large to send. Each one's value in `rows` is `null` and
    /// its entry in `row_types` is the real BSON type name; the value itself
    /// was never read off the server. The grid has to load the document before
    /// anything edits or copies that row — see ADR #133.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trimmed: Option<Vec<TrimmedCell>>,
}

/// One cell of a browse page that [`TableQuery::trim_above`] left out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrimmedCell {
    /// Index into [`QueryResult::rows`].
    pub row: usize,
    /// Index into [`QueryResult::columns`].
    pub column: usize,
    /// The field's BSON size on the server, in bytes.
    pub bytes: u64,
}

impl QueryResult {
    /// A result set. `rows_affected` is the row *count* — every read-shaped
    /// caller set it that way, and the nine struct literals this replaces
    /// each restated the relationship (usually as `data.len() as u64` on the
    /// line above `rows: data`, which only works because the field order puts
    /// it first).
    ///
    /// `total`, `truncated` and `row_types` start at their neutral values and
    /// are added by the three builder methods below, so a caller only mentions
    /// the ones it actually has. That is the point of these: a new field on
    /// [`QueryResult`] is one edit here instead of nine, and — the part a
    /// compiler would not have caught — a field a caller *forgets* to set now
    /// gets the same neutral value as everywhere else rather than whatever the
    /// author assumed.
    pub fn rows(columns: Vec<ColumnMeta>, rows: Vec<Vec<Value>>, elapsed_ms: u64) -> Self {
        Self {
            rows_affected: rows.len() as u64,
            columns,
            rows,
            elapsed_ms,
            total: None,
            truncated: false,
            row_types: None,
            trimmed: None,
        }
    }

    /// A write's affected-row count, with no result set.
    pub fn affected(rows_affected: u64, elapsed_ms: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            elapsed_ms,
            total: None,
            truncated: false,
            row_types: None,
            trimmed: None,
        }
    }

    /// The relation's total row count, for the browse footer's "1–100 of N".
    pub fn with_total(mut self, total: Option<u64>) -> Self {
        self.total = total;
        self
    }

    /// Mark the rows as having been cut at [`MAX_ADHOC_QUERY_ROWS`].
    pub fn with_truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }

    /// MongoDB's per-cell BSON type trees (ADR #29). Must stay cell-aligned
    /// with `rows`.
    pub fn with_row_types(mut self, row_types: Vec<Vec<Value>>) -> Self {
        self.row_types = Some(row_types);
        self
    }

    /// The cells a MongoDB browse left out (see [`QueryResult::trimmed`]).
    /// `None` when there were none, so a page without large values serialises
    /// exactly as before.
    pub fn with_trimmed(mut self, trimmed: Vec<TrimmedCell>) -> Self {
        self.trimmed = (!trimmed.is_empty()).then_some(trimmed);
        self
    }
}

/// Column descriptor in a [`QueryResult`]. `Deserialize` for the same reason
/// as its parent — it crosses the MCP bridge.
#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

/// Result of [`count_table_rows`]: the row total for the current predicate
/// plus whether it is an engine-provided *estimate* (fast, approximate)
/// rather than an exact `COUNT(*)`.
///
/// The count is served separately from the data page (see
/// [`fetch_table_data`], which the GUI now always calls with
/// `with_count = false`) so the grid can paint its first rows immediately —
/// on a multi-million-row table the exact `COUNT(*)` used to gate that first
/// paint. When the whole table is browsed (no filters, no search) we skip the
/// count entirely and return the planner/catalog estimate, which is O(1);
/// any predicate forces an exact count (still off the render's critical path).
#[derive(Debug, Serialize)]
pub struct CountResult {
    pub total: u64,
    /// `true` when `total` came from a statistics estimate (`reltuples` on
    /// Postgres, `information_schema.TABLE_ROWS` on MySQL,
    /// `estimatedDocumentCount` on MongoDB) instead of an exact count. The
    /// frontend renders an estimate as `~N`.
    pub estimated: bool,
}

/// How hard a [`count_table_rows`] should try to be exact.
///
/// The footer's own count is something nobody asked for: it fills in a number
/// beside the page range, so it may answer from the engine's statistics when
/// the whole relation is browsed, and on MongoDB a filtered count is capped
/// (`COUNT_TIMEOUT_MS`) rather than holding a connection for minutes. Both are
/// the right trade for a number the user did not request — and both are wrong
/// once the user clicks *exact count*, because the collections where the
/// estimate is worth doubting are precisely the big ones that a cap would turn
/// into a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountMode {
    /// The footer's background count: an estimate when unfiltered, a bounded
    /// scan on MongoDB otherwise.
    Automatic,
    /// The user's explicit request: never an estimate, and no ceiling — the
    /// same rule as a query the user runs, which stays unbounded (only the
    /// reads the app issues on its own behalf get `operation_timeout`).
    Exact,
}

impl CountMode {
    pub fn of(exact: bool) -> Self {
        if exact {
            Self::Exact
        } else {
            Self::Automatic
        }
    }

    /// True when this count may be served from engine statistics rather than
    /// by counting: only for the background count of a whole relation.
    pub fn may_estimate(self, filter: &TableFilter) -> bool {
        self == Self::Automatic && filter.is_unfiltered()
    }
}

/// Per-statement outcome inside a [`BatchResult`].
///
/// `preview` is a single-line, length-capped echo of the statement (so the
/// UI can label each row of the summary without re-sending the SQL). On a
/// failing statement `error` carries the driver message and the batch stops
/// there — later statements never run, mirroring how a paste of `;`-delimited
/// queries would abort at the first failure in a `psql`/`mysql` session.
///
/// `results` carries whatever the statement *returned*. It is a `Vec` rather
/// than an `Option` because one T-SQL statement can legitimately produce
/// several result sets, and the batch runner used to keep the first non-empty
/// one and discard the rest — "a panel per thing that returns rows" has to
/// mean all of them to be true. The SQL and MongoDB drivers push zero or one.
#[derive(Debug, Serialize)]
pub struct StmtOutcome {
    pub index: usize,
    pub preview: String,
    pub rows_affected: u64,
    pub is_select: bool,
    pub error: Option<String>,
    /// Result sets this statement produced, in the order the driver returned
    /// them. Empty for a write, for a failure, and for a read whose rows were
    /// all shed by [`MAX_BATCH_RESULT_ROWS`].
    pub results: Vec<QueryResult>,
}

/// Result of running a batch of statements via [`execute_batch`].
///
/// Every statement's own result sets travel in its [`StmtOutcome`]. There is
/// deliberately no `last_result` alongside them any more: it used to be how
/// the single grid got its rows, and once each statement carries its own it
/// would be a second, full copy of the largest payload in the batch crossing
/// the IPC boundary for nothing. The one consumer that read it is the query
/// tab, rewritten in the same change; `ImportSqlDialog` and the MCP write path
/// only ever read `statements`/`total_affected`.
#[derive(Debug, Serialize)]
pub struct BatchResult {
    pub statements: Vec<StmtOutcome>,
    pub total_affected: u64,
}

/// One-line, length-capped echo of a statement for the batch summary.
pub(crate) fn stmt_preview(sql: &str) -> String {
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 {
        let head: String = one_line.chars().take(117).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// Map `db::exec::query_rows`'s untyped `(name, type_name)` pairs into the
/// serialisable DTO. The pairs stop at the `db/` boundary (see `query_rows`);
/// this is the one place that crosses them over.
pub(crate) fn column_meta(pairs: Vec<(String, String)>) -> Vec<ColumnMeta> {
    pairs
        .into_iter()
        .map(|(name, data_type)| ColumnMeta { name, data_type })
        .collect()
}

/// A `db::values::*_result` (or `db::mssql::schema::decode_rows`) decode, with
/// its column pairs crossed over by [`column_meta`].
///
/// This module used to carry its own `pg_result` / `mysql_result` /
/// `sqlite_result`, word for word the `db::values` ones plus that mapping, so
/// the two decoders could drift without anything noticing.
pub(crate) fn with_meta(
    (columns, rows): (Vec<(String, String)>, Vec<Vec<Value>>),
) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    (column_meta(columns), rows)
}

#[cfg(test)]
mod row_value_tests {
    use super::*;
    use serde_json::json;

    /// The shape `src/lib/tauri.ts` actually sends. Tauri does not rename the
    /// fields of a nested struct, so this is the spelling that has to work.
    #[test]
    fn row_value_reads_the_frontends_camel_case_type_hint() {
        let rv: RowValue = serde_json::from_value(
            json!({ "column": "atnId", "value": "5", "columnType": "long" }),
        )
        .unwrap();
        assert_eq!(rv.column_type.as_deref(), Some("long"));
    }

    #[test]
    fn row_value_still_accepts_the_snake_case_spelling() {
        let rv: RowValue =
            serde_json::from_value(json!({ "column": "b", "value": "1", "column_type": "BIT" }))
                .unwrap();
        assert_eq!(rv.column_type.as_deref(), Some("BIT"));
    }

    /// The bridge serializes a `RowValue` in one process and deserializes it
    /// in another, so the hint must survive its own round trip.
    #[test]
    fn row_value_type_hint_survives_a_serde_round_trip() {
        let rv = RowValue {
            column: "ts".into(),
            value: Some("1790338189273".into()),
            column_type: Some("long".into()),
        };
        let back: RowValue = serde_json::from_value(serde_json::to_value(&rv).unwrap()).unwrap();
        assert_eq!(back.column_type.as_deref(), Some("long"));
    }
}
