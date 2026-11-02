//! Statements the write and filter paths build, run against a real Postgres.
//!
//! `#[ignore]`d because they need a server: point `HUGINNDB_TEST_PG_URL` at a
//! throwaway database (every run drops and recreates its own schema) and run
//!
//! ```text
//! cargo test pg_live -- --ignored --nocapture
//! ```
//!
//! They exist because the unit tests beside each builder only assert on SQL
//! *text*, and issue #268 was a failure that text cannot show: `sqlx` declares
//! every `Option<String>` bind as `text` (OID 25), and Postgres will not
//! compare or assign `text` to a `smallint`, `uuid`, `boolean`, enum… column.

use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;

use crate::commands::insert::{build_insert_statement, InsertClauses, InsertColumn};
use crate::commands::query::{
    build_filter_clause_at, delete_rows_statement, update_cell_statement, ColumnFilter, FilterOp,
};
use crate::db::exec;
use crate::db::sql::Dialect;
use crate::state::DbPool;

const SCHEMA: &str = "huginndb_pg_live";

async fn pool() -> Option<DbPool> {
    let url = std::env::var("HUGINNDB_TEST_PG_URL").ok()?;
    let p = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("HUGINNDB_TEST_PG_URL is set but the server is unreachable");
    Some(DbPool::Postgres(p))
}

async fn setup(pool: &DbPool) {
    for stmt in [
        format!("DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"),
        format!("CREATE SCHEMA {SCHEMA}"),
        format!("CREATE TYPE {SCHEMA}.mood AS ENUM ('sad', 'ok', 'happy')"),
        format!(
            "CREATE TABLE {SCHEMA}.t (\
               id smallint PRIMARY KEY, \
               name text, \
               flag boolean, \
               uid uuid, \
               amount numeric(10,2), \
               at timestamptz, \
               doc jsonb, \
               raw bytea, \
               tags integer[], \
               mood {SCHEMA}.mood, \
               code char(3), \
               bits bit(3), \
               short varchar(4))"
        ),
        format!(
            "INSERT INTO {SCHEMA}.t VALUES \
             (1, 'one', true, '00000000-0000-0000-0000-000000000001', 1.50, \
              '2026-01-01T00:00:00Z', '{{\"a\":1}}', '\\x0102', '{{1,2}}', 'ok', 'abc', B'101', 'abcd'), \
             (2, 'two', false, '00000000-0000-0000-0000-000000000002', 2.25, \
              '2026-06-01T00:00:00Z', '{{\"a\":2}}', '\\x0304', '{{3}}', 'happy', 'xyz', B'010', 'wxyz')"
        ),
    ] {
        exec::execute(pool, &stmt).await.expect(&stmt);
    }
}

fn qt() -> String {
    Dialect::Postgres.qualify_defaulted(Some(SCHEMA), "t")
}

fn f(column: &str, op: FilterOp, value: Value) -> ColumnFilter {
    ColumnFilter {
        column: column.into(),
        op,
        value,
        value2: Value::Null,
        values: Vec::new(),
    }
}

/// Run one case, returning `name: error` on failure so a run reports every
/// broken path at once instead of stopping at the first.
async fn check(
    pool: &DbPool,
    name: &str,
    sql: &str,
    binds: &[Option<String>],
    want_rows: Option<usize>,
) -> Option<String> {
    let res = if sql.trim_start().starts_with("SELECT") || sql.contains(" RETURNING ") {
        exec::query_rows(pool, sql, binds)
            .await
            .map(|(_, rows)| rows.len() as u64)
    } else {
        exec::execute_params(pool, sql, binds).await
    };
    match res {
        Ok(n) => match want_rows {
            Some(w) if n as usize != w => {
                Some(format!("{name}: {n} rows, expected {w}\n    {sql}"))
            }
            _ => None,
        },
        Err(e) => Some(format!("{name}: {e}\n    {sql}")),
    }
}

#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn pg_live_typed_binds() {
    let Some(pool) = pool().await else {
        panic!("set HUGINNDB_TEST_PG_URL to run this test");
    };
    setup(&pool).await;
    let mut failures: Vec<String> = Vec::new();
    let d = Dialect::Postgres;
    // What every write and filter path now reads before building (ADR #129).
    let types = exec::bind_types(&pool, &qt()).await.expect("bind_types");
    assert_eq!(types.of("id"), Some("smallint"));
    assert_eq!(
        types.of("code"),
        Some("bpchar"),
        "no modifier: char(3) would truncate"
    );
    assert_eq!(types.of("mood"), Some("huginndb_pg_live.mood"));

    // --- filters (grid, query panel, export, bulk update's WHERE) ---------
    let filter_cases: Vec<(&str, Vec<ColumnFilter>, usize)> = vec![
        (
            "filter smallint =",
            vec![f("id", FilterOp::Eq, json!(1))],
            1,
        ),
        (
            "filter smallint = (string)",
            vec![f("id", FilterOp::Eq, json!("1"))],
            1,
        ),
        (
            "filter smallint >",
            vec![f("id", FilterOp::Gt, json!(1))],
            1,
        ),
        (
            "filter boolean =",
            vec![f("flag", FilterOp::Eq, json!(true))],
            1,
        ),
        (
            "filter uuid =",
            vec![f(
                "uid",
                FilterOp::Eq,
                json!("00000000-0000-0000-0000-000000000002"),
            )],
            1,
        ),
        (
            "filter numeric >=",
            vec![f("amount", FilterOp::Gte, json!("2"))],
            1,
        ),
        (
            "filter timestamptz <",
            vec![f("at", FilterOp::Lt, json!("2026-03-01T00:00:00Z"))],
            1,
        ),
        (
            "filter jsonb =",
            vec![f("doc", FilterOp::Eq, json!("{\"a\":2}"))],
            1,
        ),
        (
            "filter bytea =",
            vec![f("raw", FilterOp::Eq, json!("\\x0102"))],
            1,
        ),
        (
            "filter int[] =",
            vec![f("tags", FilterOp::Eq, json!("{3}"))],
            1,
        ),
        (
            "filter enum =",
            vec![f("mood", FilterOp::Eq, json!("happy"))],
            1,
        ),
        (
            "filter enum <>",
            vec![f("mood", FilterOp::Ne, json!("happy"))],
            1,
        ),
        (
            "filter char(3) =",
            vec![f("code", FilterOp::Eq, json!("abc"))],
            1,
        ),
        (
            "filter bit(3) =",
            vec![f("bits", FilterOp::Eq, json!("101"))],
            1,
        ),
        (
            "filter text =",
            vec![f("name", FilterOp::Eq, json!("two"))],
            1,
        ),
        (
            "filter text = (number)",
            vec![f("name", FilterOp::Eq, json!(1))],
            0,
        ),
        (
            "filter smallint BETWEEN",
            vec![ColumnFilter {
                value2: json!(2),
                ..f("id", FilterOp::Between, json!(1))
            }],
            2,
        ),
        (
            "filter smallint IN",
            vec![ColumnFilter {
                values: vec![json!(1), json!(2)],
                ..f("id", FilterOp::In, Value::Null)
            }],
            2,
        ),
        (
            "filter smallint NOT IN + NULL",
            vec![ColumnFilter {
                values: vec![json!(1), Value::Null],
                ..f("id", FilterOp::NotIn, Value::Null)
            }],
            1,
        ),
        (
            "filter enum IN",
            vec![ColumnFilter {
                values: vec![json!("ok"), json!("sad")],
                ..f("mood", FilterOp::In, Value::Null)
            }],
            1,
        ),
        (
            "filter smallint contains",
            vec![f("id", FilterOp::Contains, json!("2"))],
            1,
        ),
        (
            "filter smallint not contains",
            vec![f("id", FilterOp::NotContains, json!("2"))],
            1,
        ),
        (
            "filter text ilike",
            vec![f("name", FilterOp::StartsWith, json!("T"))],
            1,
        ),
        (
            "filter IS NULL",
            vec![f("name", FilterOp::IsNull, Value::Null)],
            0,
        ),
    ];
    for (name, filters, want) in filter_cases {
        let (clause, binds, _) = build_filter_clause_at(1, d, &filters, None, &[], &types);
        let sql = format!("SELECT * FROM {}{clause}", qt());
        failures.extend(check(&pool, name, &sql, &binds, Some(want)).await);
    }
    // The grid's search box over every column, typed or not.
    let search_cols: Vec<String> = ["id", "name", "uid", "mood"].map(String::from).to_vec();
    let (clause, binds, _) = build_filter_clause_at(1, d, &[], Some("w"), &search_cols, &types);
    let sql = format!("SELECT * FROM {}{clause}", qt());
    failures.extend(check(&pool, "search box", &sql, &binds, Some(1)).await);

    // --- update_cell ------------------------------------------------------
    let update_cases: Vec<(&str, &str, Option<&str>)> = vec![
        ("update text by smallint pk", "name", Some("uno")),
        ("update boolean", "flag", Some("false")),
        (
            "update uuid",
            "uid",
            Some("00000000-0000-0000-0000-0000000000ff"),
        ),
        ("update numeric", "amount", Some("9.99")),
        ("update timestamptz", "at", Some("2026-02-02 10:00:00+01")),
        ("update jsonb", "doc", Some("{\"b\": [1, 2]}")),
        ("update bytea", "raw", Some("\\xdeadbeef")),
        ("update int[]", "tags", Some("{7,8,9}")),
        ("update enum", "mood", Some("sad")),
        ("update char(3)", "code", Some("q")),
        ("update bit(3)", "bits", Some("111")),
        ("update to NULL", "name", None),
    ];
    for (name, column, value) in update_cases {
        let (sql, binds) = update_cell_statement(
            d,
            &qt(),
            column,
            None,
            false,
            &["id".to_string()],
            value.map(str::to_string),
            &[json!(1)],
            &types,
        );
        failures.extend(check(&pool, name, &sql, &binds, Some(1)).await);
    }
    // A value too long for the column must still be refused, not truncated.
    let (sql, binds) = update_cell_statement(
        d,
        &qt(),
        "short",
        None,
        false,
        &["id".to_string()],
        Some("toolong".into()),
        &[json!(1)],
        &types,
    );
    if exec::execute_params(&pool, &sql, &binds).await.is_ok() {
        failures.push(format!("varchar(4) overflow was accepted\n    {sql}"));
    }

    // --- insert_row / insert_rows -----------------------------------------
    let cols = |names: &[&str]| -> Vec<InsertColumn> {
        names
            .iter()
            .map(|n| InsertColumn {
                name: (*n).into(),
                data_type: None,
            })
            .collect()
    };
    let ins_cols = cols(&["id", "name", "flag", "uid", "amount", "mood", "tags"]);
    let row = |id: &str| -> Vec<Option<String>> {
        vec![
            Some(id.into()),
            Some("new".into()),
            Some("1".into()),
            Some("00000000-0000-0000-0000-0000000000aa".into()),
            Some("3.5".into()),
            Some("ok".into()),
            None,
        ]
    };
    let built = build_insert_statement(
        d,
        &qt(),
        &ins_cols,
        &[row("10")],
        InsertClauses::default(),
        &types,
    );
    failures.extend(check(&pool, "insert one row", &built.sql, &built.binds, Some(1)).await);
    let built = build_insert_statement(
        d,
        &qt(),
        &ins_cols,
        &[row("11")],
        InsertClauses {
            returning: Some("\"id\""),
            ..Default::default()
        },
        &types,
    );
    failures.extend(check(&pool, "insert RETURNING", &built.sql, &built.binds, Some(1)).await);
    let built = build_insert_statement(
        d,
        &qt(),
        &ins_cols,
        &[row("12"), row("13")],
        InsertClauses::default(),
        &types,
    );
    failures.extend(check(&pool, "insert two rows", &built.sql, &built.binds, Some(2)).await);

    // --- delete_rows ------------------------------------------------------
    let (sql, binds) = delete_rows_statement(
        d,
        &qt(),
        &["id".to_string()],
        &[vec![json!(12)], vec![json!("13")]],
        &types,
    );
    failures.extend(check(&pool, "delete by smallint pk", &sql, &binds, Some(2)).await);

    if !failures.is_empty() {
        panic!(
            "{} of the Postgres cases failed:\n  {}",
            failures.len(),
            failures.join("\n  ")
        );
    }
}

/// The alternative ADR #129 rejected, kept as evidence: bind the value as
/// `unknown` (OID 705) so Postgres infers its type from context, the way it
/// does for a hand-typed literal. It cannot work with `sqlx`, which sends every
/// parameter in the *binary* format — Postgres infers `smallint` and then reads
/// the UTF-8 bytes of `"1"` with `int2recv`. This test asserts that failure, so
/// if a future `sqlx` starts sending text-format parameters it will say so.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn pg_live_unknown_oid_cannot_carry_a_text_value() {
    use sqlx::encode::IsNull;
    use sqlx::postgres::types::Oid;
    use sqlx::postgres::{PgArgumentBuffer, PgTypeInfo};

    struct Unknown<'a>(&'a str);
    impl sqlx::Type<sqlx::Postgres> for Unknown<'_> {
        fn type_info() -> PgTypeInfo {
            PgTypeInfo::with_oid(Oid(705))
        }
    }
    impl sqlx::Encode<'_, sqlx::Postgres> for Unknown<'_> {
        fn encode_by_ref(
            &self,
            buf: &mut PgArgumentBuffer,
        ) -> Result<IsNull, sqlx::error::BoxDynError> {
            buf.extend_from_slice(self.0.as_bytes());
            Ok(IsNull::No)
        }
    }

    let Some(DbPool::Postgres(p)) = pool().await else {
        panic!("set HUGINNDB_TEST_PG_URL to run this test");
    };
    // A text column works: `textrecv` takes the raw bytes as they are.
    let text: (String,) = sqlx::query_as("SELECT 'x' || $1")
        .bind(Unknown("y"))
        .fetch_one(&p)
        .await
        .expect("unknown → text");
    assert_eq!(text.0, "xy");
    // A smallint context does not.
    let err = sqlx::query("SELECT 1 WHERE 1::smallint = $1")
        .bind(Unknown("1"))
        .execute(&p)
        .await
        .expect_err("unknown → smallint was expected to fail in binary format");
    eprintln!("unknown → smallint: {err}");
}

/// The same fix, one level up: every command core the grid and the MCP
/// connector call, on a smallint-keyed table, through a real `AppState`.
#[tokio::test]
#[ignore = "needs HUGINNDB_TEST_PG_URL"]
async fn pg_live_command_cores() {
    use crate::commands::bulk::{apply_bulk_update_inner, BulkUpdateArgs};
    use crate::commands::insert::insert_rows_inner;
    use crate::commands::paste::{apply_paste_inner, PasteArgs};
    use crate::commands::query::{
        count_table_rows_inner, delete_rows_inner, fetch_table_data_inner, insert_row_inner,
        update_cell_inner, CountMode, RowValue, TableFilter, TableQuery, TableScan,
    };
    use crate::log_bus::{LogEntry, LogSink};
    use crate::state::{ActivePool, AppState};

    let Some(pool) = pool().await else {
        panic!("set HUGINNDB_TEST_PG_URL to run this test");
    };
    setup(&pool).await;
    let state = AppState::new();
    state
        .connections
        .write()
        .insert("pg".into(), ActivePool::bare(pool));
    // `log_bus::NoopSink` exists only under the `mcp` feature.
    struct Discard;
    impl LogSink for Discard {
        fn log(&self, _entry: LogEntry) {}
    }
    let sink = Discard;
    let schema = || Some(SCHEMA.to_string());
    let rv = |c: &str, v: &str| RowValue {
        column: c.into(),
        value: Some(v.into()),
        column_type: None,
    };
    let by_id = |id: Value| -> Vec<ColumnFilter> { vec![f("id", FilterOp::Eq, id)] };

    // As the frontend sends it: `FilterOp` is deserialise-only.
    let browse = |filters: Value| {
        serde_json::from_value::<TableQuery>(json!({
            "connectionId": "pg", "schema": SCHEMA, "table": "t",
            "limit": 50, "offset": 0, "withCount": true, "filters": filters,
        }))
        .expect("TableQuery")
    };

    // Browse + count with a filter on the smallint key.
    let page = fetch_table_data_inner(
        &sink,
        &state,
        browse(json!([{"column": "id", "op": "eq", "value": 1}])),
    )
    .await
    .expect("browse filtered by smallint");
    assert_eq!(page.rows.len(), 1);
    let count = count_table_rows_inner(
        &sink,
        &state,
        TableScan {
            connection_id: "pg".into(),
            schema: schema(),
            table: "t".into(),
            filter: TableFilter {
                filters: by_id(json!(2)),
                ..TableFilter::default()
            },
            order: Vec::new(),
            projection: None,
            collation: None,
            hint: None,
        },
        CountMode::Exact,
    )
    .await
    .expect("count filtered by smallint");
    assert_eq!(count.total, 1);

    // Edit a cell, insert a row (with RETURNING), delete it.
    let n = update_cell_inner(
        &sink,
        &state,
        "pg".into(),
        schema(),
        "t".into(),
        vec!["id".into()],
        vec![json!(1)],
        "mood".into(),
        Some("sad".into()),
        None,
    )
    .await
    .expect("update_cell");
    assert_eq!(n, 1);
    let returned = insert_row_inner(
        &sink,
        &state,
        "pg".into(),
        schema(),
        "t".into(),
        Some("id".into()),
        vec![rv("id", "20"), rv("flag", "true"), rv("amount", "1.25")],
    )
    .await
    .expect("insert_row");
    assert_eq!(returned, json!(20));
    let n = delete_rows_inner(
        &sink,
        &state,
        "pg".into(),
        schema(),
        "t".into(),
        vec!["id".into()],
        vec![vec![json!(20)]],
    )
    .await
    .expect("delete_rows");
    assert_eq!(n, 1);

    // Paste JSON rows, paste over the grid, bulk update.
    let summary = insert_rows_inner(
        &sink,
        &state,
        "pg".into(),
        schema(),
        "t".into(),
        r#"[{"id": 30, "uid": "00000000-0000-0000-0000-000000000030", "mood": "ok"},
            {"id": 31, "uid": "00000000-0000-0000-0000-000000000031", "mood": "sad"}]"#
            .into(),
    )
    .await
    .expect("insert_rows");
    assert_eq!(summary.inserted, 2);
    let pasted = apply_paste_inner(
        &sink,
        &state,
        serde_json::from_value::<PasteArgs>(json!({
            "connectionId": "pg", "schema": SCHEMA, "table": "t",
            "pkColumns": ["id"],
            "updates": [{"pkValues": [30], "column": "amount", "value": "4.5"}],
            "inserts": [[{"column": "id", "value": "32"}, {"column": "flag", "value": "false"}]],
        }))
        .expect("PasteArgs"),
    )
    .await
    .expect("apply_paste");
    assert_eq!((pasted.updated, pasted.inserted), (1, 1));
    let n = apply_bulk_update_inner(
        &sink,
        &state,
        serde_json::from_value::<BulkUpdateArgs>(json!({
            "connectionId": "pg", "schema": SCHEMA, "table": "t",
            "filters": [{"column": "id", "op": "in", "values": [30, 31, 32]}],
            "setValues": [{"column": "mood", "value": "happy"}, {"column": "flag", "value": "true"}],
        }))
        .expect("BulkUpdateArgs"),
    )
    .await
    .expect("apply_bulk_update");
    assert_eq!(n, 3);
}
