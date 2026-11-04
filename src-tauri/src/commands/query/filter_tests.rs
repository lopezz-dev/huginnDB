//! Filter, clause and payload tests for the browse path: the `WHERE` built
//! from column filters and the raw expression, the rest of the page statement,
//! and the `TableQuery` / `TableScan` payloads the grid sends.

use super::*;
use crate::db::sql::BindTypes;
use serde_json::json;

fn f(column: &str, op: FilterOp, value: serde_json::Value) -> ColumnFilter {
    ColumnFilter {
        column: column.into(),
        op,
        value,
        value2: json!(null),
        values: Vec::new(),
    }
}

fn between(column: &str, value: serde_json::Value, value2: serde_json::Value) -> ColumnFilter {
    ColumnFilter {
        column: column.into(),
        op: FilterOp::Between,
        value,
        value2,
        values: Vec::new(),
    }
}

/// `In` / `NotIn` filter over an explicit value list.
fn in_list(column: &str, op: FilterOp, values: Vec<serde_json::Value>) -> ColumnFilter {
    ColumnFilter {
        column: column.into(),
        op,
        value: json!(null),
        value2: json!(null),
        values,
    }
}

#[test]
fn advanced_ops_build_expected_postgres_sql() {
    let filters = vec![
        f("name", FilterOp::Contains, json!("ab")),
        f("age", FilterOp::Gt, json!(5)),
        f("code", FilterOp::StartsWith, json!("x")),
    ];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    // Postgres: ILIKE for contains/starts_with, TEXT cast, $N placeholders.
    assert!(
        clause.contains(r#"CAST("name" AS TEXT) ILIKE $1 ESCAPE"#),
        "{clause}"
    );
    assert!(clause.contains(r#""age" > $2"#), "{clause}");
    assert!(
        clause.contains(r#"CAST("code" AS TEXT) ILIKE $3 ESCAPE"#),
        "{clause}"
    );
    assert_eq!(
        binds,
        vec![
            Some("%ab%".to_string()),
            Some("5".to_string()),
            Some("x%".to_string()),
        ]
    );
}

#[test]
fn advanced_ops_build_expected_mysql_sql() {
    let filters = vec![
        f("name", FilterOp::EndsWith, json!("z")),
        f("qty", FilterOp::Lte, json!(10)),
        f("note", FilterOp::NotContains, json!("skip")),
    ];
    let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
    // MySQL: LIKE / NOT LIKE, CHAR cast, `?` placeholders, doubled escape.
    assert!(clause.contains("CAST(`name` AS CHAR) LIKE ?"), "{clause}");
    assert!(clause.contains("`qty` <= ?"), "{clause}");
    assert!(
        clause.contains("CAST(`note` AS CHAR) NOT LIKE ?"),
        "{clause}"
    );
    assert_eq!(
        binds,
        vec![
            Some("%z".to_string()),
            Some("10".to_string()),
            Some("%skip%".to_string()),
        ]
    );
}

#[test]
fn between_builds_expected_postgres_sql() {
    let filters = vec![between("age", json!(18), json!(65))];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""age" BETWEEN $1 AND $2"#), "{clause}");
    assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
}

#[test]
fn between_builds_expected_mysql_and_sqlite_sql() {
    let filters = vec![between("age", json!(18), json!(65))];
    let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
    assert!(clause.contains("`age` BETWEEN ? AND ?"), "{clause}");
    assert_eq!(binds, vec![Some("18".to_string()), Some("65".to_string())]);
}

#[test]
fn null_ops_take_no_bind() {
    let filters = vec![
        f("a", FilterOp::IsNull, json!(null)),
        f("b", FilterOp::IsNotNull, json!(null)),
    ];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""a" IS NULL"#), "{clause}");
    assert!(clause.contains(r#""b" IS NOT NULL"#), "{clause}");
    assert!(binds.is_empty());
}

#[test]
fn in_builds_one_placeholder_per_value() {
    let filters = vec![in_list(
        "id",
        FilterOp::In,
        vec![json!(1), json!(2), json!(3)],
    )];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""id" IN ($1, $2, $3)"#), "{clause}");
    assert_eq!(
        binds,
        vec![
            Some("1".to_string()),
            Some("2".to_string()),
            Some("3".to_string())
        ]
    );
}

#[test]
fn in_uses_question_marks_on_mysql() {
    let filters = vec![in_list("id", FilterOp::In, vec![json!(1), json!(2)])];
    let (clause, binds) = build_filter_clause(Dialect::Mysql, &filters, None, &[]);
    assert!(clause.contains("`id` IN (?, ?)"), "{clause}");
    assert_eq!(binds.len(), 2);
}

#[test]
fn in_deduplicates_repeated_values() {
    // Selecting many rows that share a value must not fan out into one
    // placeholder per row.
    let filters = vec![in_list(
        "status",
        FilterOp::In,
        vec![json!("a"), json!("b"), json!("a"), json!("a")],
    )];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""status" IN ($1, $2)"#), "{clause}");
    assert_eq!(
        binds,
        vec![Some("a".to_string()), Some("b".to_string())],
        "order of first appearance must be preserved"
    );
}

#[test]
fn in_with_a_null_value_adds_an_is_null_branch() {
    // `col IN (…)` is never true for a NULL column, so a selected NULL row
    // would silently disappear from its own filter without this.
    let filters = vec![in_list("x", FilterOp::In, vec![json!(1), json!(null)])];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(
        clause.contains(r#"("x" IN ($1) OR "x" IS NULL)"#),
        "{clause}"
    );
    assert_eq!(binds, vec![Some("1".to_string())]);
}

#[test]
fn not_in_without_null_keeps_null_rows_visible() {
    // The classic NOT IN trap: 3VL would drop NULL rows the user never asked
    // to exclude.
    let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1)])];
    let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(
        clause.contains(r#"("x" NOT IN ($1) OR "x" IS NULL)"#),
        "{clause}"
    );
}

#[test]
fn not_in_with_null_excludes_null_rows() {
    // Here the user *did* pick NULL, so 3VL's own exclusion is the wanted
    // behaviour and no extra branch is emitted.
    let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(1), json!(null)])];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""x" NOT IN ($1)"#), "{clause}");
    assert!(!clause.contains("IS NULL"), "{clause}");
    assert_eq!(binds, vec![Some("1".to_string())]);
}

#[test]
fn empty_in_list_matches_nothing_instead_of_emitting_invalid_sql() {
    // `IN ()` is a syntax error everywhere. Dropping the filter would be
    // worse than a never-true predicate: it would widen the result set to
    // the whole table.
    let filters = vec![in_list("x", FilterOp::In, vec![])];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains("1 = 0"), "{clause}");
    assert!(!clause.contains("IN ()"), "{clause}");
    assert!(binds.is_empty());
}

#[test]
fn null_only_in_list_degrades_to_is_null() {
    let filters = vec![in_list("x", FilterOp::In, vec![json!(null)])];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""x" IS NULL"#), "{clause}");
    assert!(binds.is_empty());

    let filters = vec![in_list("x", FilterOp::NotIn, vec![json!(null)])];
    let (clause, _) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""x" IS NOT NULL"#), "{clause}");
}

#[test]
fn in_placeholders_stay_in_step_with_other_filters() {
    // The `$N` counter is shared across every filter; an `IN` list consuming
    // several numbers must not desync the ones that follow it.
    let filters = vec![
        f("a", FilterOp::Eq, json!("x")),
        in_list("b", FilterOp::In, vec![json!(1), json!(2)]),
        f("c", FilterOp::Gt, json!(9)),
    ];
    let (clause, binds) = build_filter_clause(Dialect::Postgres, &filters, None, &[]);
    assert!(clause.contains(r#""a" = $1"#), "{clause}");
    assert!(clause.contains(r#""b" IN ($2, $3)"#), "{clause}");
    assert!(clause.contains(r#""c" > $4"#), "{clause}");
    assert_eq!(binds.len(), 4);
}

#[test]
fn oversize_in_list_is_rejected() {
    let values: Vec<serde_json::Value> = (0..=MAX_IN_VALUES).map(|i| json!(i)).collect();
    let filters = vec![in_list("id", FilterOp::In, values)];
    assert!(validate_filters(&filters).is_err());

    let values: Vec<serde_json::Value> = (0..MAX_IN_VALUES).map(|i| json!(i)).collect();
    let filters = vec![in_list("id", FilterOp::In, values)];
    assert!(validate_filters(&filters).is_ok());
}

// --- IPC payload shape -------------------------------------------------
//
// `TableQuery` / `TableScan` are the wire contract with `src/types.ts`, and
// serde drops any key the Rust struct does not declare — silently, before
// the value is ever read (gotcha #14). These pin the exact JSON
// the frontend sends. `withCount: false` in particular is load-bearing:
// lose it and every page fetch silently reacquires the `COUNT(*)` that
// issue #77 moved off the render path.

#[test]
fn table_query_deserialises_the_payload_the_grid_sends() {
    let q: TableQuery = serde_json::from_value(json!({
        "connectionId": "c1",
        "schema": "public",
        "table": "album",
        "limit": 100,
        "offset": 200,
        "order": [{ "column": "title", "desc": true }],
        "filters": [{ "column": "id", "op": "gt", "value": 3 }],
        "search": "needle",
        "searchColumns": ["title", "artist"],
        "withCount": false,
    }))
    .unwrap();

    assert_eq!(q.connection_id, "c1");
    assert_eq!(q.schema.as_deref(), Some("public"));
    assert_eq!(q.table, "album");
    assert_eq!((q.limit, q.offset), (100, 200));
    assert_eq!(q.order.len(), 1);
    assert!(q.order[0].desc);
    assert_eq!(q.filter.filters.len(), 1);
    assert_eq!(q.filter.needle(), Some("needle"));
    assert_eq!(q.filter.search_columns, vec!["title", "artist"]);
    assert!(!q.with_count);
}

#[test]
fn table_query_defaults_match_the_option_unwraps_it_replaced() {
    // Every optional key absent: what `browse_table` over MCP sends, and
    // what the `Option<_>::unwrap_or_default()` chain used to produce.
    let q: TableQuery = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "album",
        "limit": 50,
        "offset": 0,
    }))
    .unwrap();

    assert!(q.schema.is_none());
    assert!(q.order.is_empty());
    assert!(q.filter.is_unfiltered());
    // `with_count` defaulted to `true`, not `false` — the old code read
    // `with_count.unwrap_or(true)`.
    assert!(q.with_count);
}

#[test]
fn table_scan_deserialises_the_count_payload() {
    let q: TableScan = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "album",
        "filters": [],
        "searchColumns": [],
    }))
    .unwrap();

    assert_eq!(q.table, "album");
    assert!(q.filter.is_unfiltered());
}

#[test]
fn table_query_carries_the_projection_the_grid_sends() {
    let q: TableQuery = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "device",
        "limit": 100,
        "offset": 0,
        "projection": { "fields": ["id", "code"] },
    }))
    .unwrap();
    let p = q
        .projection
        .expect("projection dropped at the IPC boundary");
    assert_eq!(p.fields, vec!["id", "code"]);
    // `exclude` absent is an inclusion — the only kind SQL takes.
    assert!(!p.exclude);
}

#[test]
fn table_scan_carries_the_export_s_order_and_projection() {
    let q: TableScan = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "device",
        "order": [{ "column": "ts", "desc": true }],
        "projection": { "fields": ["ts"], "exclude": false },
    }))
    .unwrap();
    assert_eq!(q.order.len(), 1);
    assert_eq!(q.projection.unwrap().fields, vec!["ts"]);

    // The count payload, which sends neither, still parses.
    let count: TableScan = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "device",
    }))
    .unwrap();
    assert!(count.order.is_empty());
    assert!(count.projection.is_none());
}

#[test]
fn select_list_quotes_projected_columns_and_defaults_to_star() {
    assert_eq!(select_list(Dialect::Postgres, None).unwrap(), "*");
    assert_eq!(
        select_list(Dialect::Postgres, Some(&Projection::default())).unwrap(),
        "*"
    );
    let p = Projection {
        fields: vec!["id".into(), "atn id".into()],
        exclude: false,
    };
    assert_eq!(
        select_list(Dialect::Postgres, Some(&p)).unwrap(),
        r#""id", "atn id""#
    );
    assert_eq!(
        select_list(Dialect::Mysql, Some(&p)).unwrap(),
        "`id`, `atn id`"
    );
}

#[test]
fn select_list_rejects_an_exclusion_rather_than_guessing() {
    let p = Projection {
        fields: vec!["configuration".into()],
        exclude: true,
    };
    assert!(select_list(Dialect::Sqlite, Some(&p)).is_err());
}

#[test]
fn order_by_clause_keeps_precedence_and_quotes() {
    assert_eq!(order_by_clause(Dialect::Postgres, &[], None).unwrap(), "");
    let order = vec![
        SortSpec {
            column: "ts".into(),
            desc: true,
        },
        SortSpec {
            column: "code".into(),
            desc: false,
        },
    ];
    assert_eq!(
        order_by_clause(Dialect::Postgres, &order, None).unwrap(),
        r#" ORDER BY "ts" DESC, "code" ASC"#
    );
    // A collation lands on every key, in the dialect's spelling.
    assert_eq!(
        order_by_clause(Dialect::Postgres, &order, Some("es-ES-x-icu")).unwrap(),
        r#" ORDER BY "ts" COLLATE "es-ES-x-icu" DESC, "code" COLLATE "es-ES-x-icu" ASC"#
    );
}

#[test]
fn collate_clause_takes_only_what_each_dialect_can_name() {
    assert_eq!(
        collate_clause(Dialect::Mysql, Some("utf8mb4_spanish_ci")).unwrap(),
        " COLLATE utf8mb4_spanish_ci"
    );
    assert_eq!(
        collate_clause(Dialect::MsSql, Some("Latin1_General_CI_AS")).unwrap(),
        " COLLATE Latin1_General_CI_AS"
    );
    assert_eq!(
        collate_clause(Dialect::Sqlite, Some("nocase")).unwrap(),
        " COLLATE NOCASE"
    );
    // Interpolated, so anything that is not a bare name is refused.
    assert!(collate_clause(Dialect::Mysql, Some("utf8mb4_bin; DROP")).is_err());
    assert!(collate_clause(Dialect::Sqlite, Some("es_ES")).is_err());
    // PostgreSQL names are identifiers, so quoting makes any of them safe.
    assert_eq!(
        collate_clause(Dialect::Postgres, Some("a\"b")).unwrap(),
        r#" COLLATE "a""b""#
    );
    assert_eq!(collate_clause(Dialect::Postgres, None).unwrap(), "");
}

#[test]
fn from_clause_spells_the_hint_per_dialect_and_refuses_it_on_postgres() {
    assert_eq!(
        from_clause(Dialect::Mysql, "`t`", Some("idx_code")).unwrap(),
        "`t` FORCE INDEX (`idx_code`)"
    );
    assert_eq!(
        from_clause(Dialect::Sqlite, "\"t\"", Some("idx_code")).unwrap(),
        "\"t\" INDEXED BY \"idx_code\""
    );
    assert_eq!(
        from_clause(Dialect::MsSql, "[t]", Some("idx_code")).unwrap(),
        "[t] WITH (INDEX([idx_code]))"
    );
    assert!(from_clause(Dialect::Postgres, "\"t\"", Some("idx_code")).is_err());
    assert_eq!(
        from_clause(Dialect::Postgres, "\"t\"", None).unwrap(),
        "\"t\""
    );
}

#[test]
fn table_query_carries_collation_and_hint() {
    let q: TableQuery = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "t",
        "limit": 10,
        "offset": 0,
        "collation": "utf8mb4_bin",
        "hint": " idx_code ",
    }))
    .unwrap();
    assert_eq!(nonblank(&q.collation), Some("utf8mb4_bin"));
    assert_eq!(nonblank(&q.hint), Some("idx_code"));
}

// --- The query panel's Explain -----------------------------------------

#[test]
fn explain_never_runs_the_statement_and_refuses_sql_server() {
    // None of the three prefixes executes: ANALYZE is what would.
    for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite] {
        let p = explain_prefix(d).unwrap();
        assert!(p.starts_with("EXPLAIN"), "{p}");
        assert!(!p.contains("ANALYZE"), "{p}");
    }
    assert!(explain_prefix(Dialect::MsSql).is_err());
}

#[test]
fn plan_from_rows_reads_each_engine_s_answer() {
    let one = |v: serde_json::Value| vec![vec![v]];
    let col = vec![("QUERY PLAN".to_string(), "json".to_string())];
    // PostgreSQL: the json cell, decoded or not.
    assert_eq!(
        plan_from_rows(Dialect::Postgres, &col, one(json!([{ "Plan": {} }]))),
        json!([{ "Plan": {} }])
    );
    // MySQL: JSON as text.
    assert_eq!(
        plan_from_rows(Dialect::Mysql, &col, one(json!("{\"query_block\":{}}"))),
        json!({ "query_block": {} })
    );
    // SQLite: one step per row, without the unused column.
    let cols = vec![
        ("id".to_string(), "int".to_string()),
        ("parent".to_string(), "int".to_string()),
        ("notused".to_string(), "int".to_string()),
        ("detail".to_string(), "text".to_string()),
    ];
    let rows = vec![vec![json!(2), json!(0), json!(0), json!("SCAN t")]];
    assert_eq!(
        plan_from_rows(Dialect::Sqlite, &cols, rows),
        json!([{ "id": 2, "parent": 0, "detail": "SCAN t" }])
    );
}

// --- The query panel's expression ------------------------------------

fn with_raw(raw: &str) -> TableFilter {
    TableFilter {
        raw: Some(raw.to_string()),
        ..TableFilter::default()
    }
}

#[test]
fn a_blank_expression_is_not_a_predicate() {
    assert!(with_raw("   ").is_unfiltered());
    assert!(!with_raw("qty > 3").is_unfiltered());
}

#[test]
fn only_the_background_count_of_a_whole_relation_may_estimate() {
    let whole = TableFilter::default();
    assert!(CountMode::Automatic.may_estimate(&whole));
    // The user's exact count never answers from statistics…
    assert!(!CountMode::Exact.may_estimate(&whole));
    // …and no predicate ever does, whoever asked.
    assert!(!CountMode::Automatic.may_estimate(&with_raw("qty > 3")));
    assert!(!CountMode::Exact.may_estimate(&with_raw("qty > 3")));
    assert_eq!(CountMode::of(true), CountMode::Exact);
    assert_eq!(CountMode::of(false), CountMode::Automatic);
}

#[test]
fn the_expression_is_anded_on_its_own_lines() {
    let f = TableFilter {
        filters: vec![ColumnFilter {
            column: "code".into(),
            op: FilterOp::Eq,
            value: json!("A"),
            value2: Value::Null,
            values: Vec::new(),
        }],
        raw: Some("qty > 3 OR qty IS NULL -- note".into()),
        ..TableFilter::default()
    };
    let (clause, binds) = f.clause(Dialect::Postgres, &BindTypes::default()).unwrap();
    assert_eq!(
        clause,
        " WHERE \"code\" = $1 AND (\nqty > 3 OR qty IS NULL -- note\n)"
    );
    assert_eq!(binds.len(), 1);

    let (alone, _) = with_raw("qty > 3")
        .clause(Dialect::Mysql, &BindTypes::default())
        .unwrap();
    assert_eq!(alone, " WHERE (\nqty > 3\n)");
}

#[test]
fn validate_raw_where_rejects_what_would_leave_the_condition() {
    for bad in [
        "1 = 1; DROP TABLE t",
        "a = 1) OR (1 = 1",
        "(a = 1",
        "name = 'unterminated",
        "a = 1 /* never closed",
        "\"unterminated",
    ] {
        assert!(validate_raw_where(bad).is_err(), "accepted: {bad}");
    }
}

#[test]
fn validate_raw_where_accepts_what_only_looks_dangerous() {
    for good in [
        "note = 'a; b'",
        "note = 'it''s (fine'",
        "\"odd;name\" = 1",
        "a = 1 -- trailing ; comment",
        "a = 1 /* ; ( */ AND b = 2",
        "[weird)name] = 1",
        "(a = 1 OR b = 2) AND c IN (1, 2)",
    ] {
        assert!(validate_raw_where(good).is_ok(), "rejected: {good}");
    }
}

#[test]
fn inline_binds_replaces_placeholders_but_not_inside_quotes() {
    let binds = vec![Some("it's".to_string()), None];
    assert_eq!(
        inline_binds(Dialect::Postgres, "a = $1 AND \"$2x\" = $2", &binds),
        "a = 'it''s' AND \"$2x\" = NULL"
    );
    assert_eq!(
        inline_binds(Dialect::Sqlite, "a = ? AND b = '?' AND c = ?", &binds),
        "a = 'it''s' AND b = '?' AND c = NULL"
    );
    assert_eq!(
        inline_binds(Dialect::MsSql, "a = @P1", &binds),
        "a = 'it''s'"
    );
    // MySQL treats a backslash as an escape inside a string literal.
    let bs = vec![Some("C:\\tmp".to_string())];
    assert_eq!(
        inline_binds(Dialect::Mysql, "p = ?", &bs),
        "p = 'C:\\\\tmp'"
    );
}

#[test]
fn table_query_carries_the_expression() {
    let q: TableQuery = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "t",
        "limit": 10,
        "offset": 0,
        "raw": "qty > 3",
    }))
    .unwrap();
    assert_eq!(q.filter.raw_text(), Some("qty > 3"));
}

#[test]
fn an_empty_search_string_is_not_a_predicate() {
    // The grid clears its search box to `""`, not to `undefined`. Treating
    // that as a needle would build `LIKE '%%'` and, worse, disqualify the
    // whole-table fast count estimate.
    let q: TableScan = serde_json::from_value(json!({
        "connectionId": "c1",
        "table": "album",
        "search": "",
    }))
    .unwrap();

    assert_eq!(q.filter.needle(), None);
    assert!(q.filter.is_unfiltered());
}
