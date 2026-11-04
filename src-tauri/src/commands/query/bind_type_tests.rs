//! The SQL each write and filter path builds once it knows the column types
//! (ADR #129): Postgres casts the values compared with or assigned to a column,
//! and the other dialects are byte-for-byte what they were — even when handed
//! a type map, which in the app they never are.

use super::*;
use crate::db::sql::BindTypes;
use serde_json::json;

fn pg_types() -> BindTypes {
    BindTypes::new([
        ("id".to_string(), "smallint".to_string()),
        ("tenant".to_string(), "uuid".to_string()),
        ("name".to_string(), "text".to_string()),
        ("mood".to_string(), "public.mood".to_string()),
    ])
}

fn filter(column: &str, op: FilterOp, value: Value) -> ColumnFilter {
    ColumnFilter {
        column: column.into(),
        op,
        value,
        value2: Value::Null,
        values: Vec::new(),
    }
}

#[test]
fn postgres_filter_values_are_cast_to_their_column_type() {
    let filters = vec![
        filter("id", FilterOp::Gte, json!(1)),
        ColumnFilter {
            value2: json!(9),
            ..filter("id", FilterOp::Between, json!(2))
        },
        ColumnFilter {
            values: vec![json!("happy"), json!("ok")],
            ..filter("mood", FilterOp::In, Value::Null)
        },
    ];
    let (clause, binds, next) =
        build_filter_clause_at(1, Dialect::Postgres, &filters, None, &[], &pg_types());
    assert_eq!(
        clause,
        " WHERE \"id\" >= CAST($1 AS smallint) \
         AND \"id\" BETWEEN CAST($2 AS smallint) AND CAST($3 AS smallint) \
         AND \"mood\" IN (CAST($4 AS public.mood), CAST($5 AS public.mood))"
    );
    assert_eq!(binds.len(), 5);
    assert_eq!(next, 6);
}

#[test]
fn postgres_pattern_matches_and_unknown_columns_stay_uncast() {
    let filters = vec![
        filter("id", FilterOp::Contains, json!("4")),
        filter("id", FilterOp::NotContains, json!("5")),
        filter("computed", FilterOp::Eq, json!("x")),
    ];
    let search = vec!["tenant".to_string()];
    let (clause, _, _) = build_filter_clause_at(
        1,
        Dialect::Postgres,
        &filters,
        Some("q"),
        &search,
        &pg_types(),
    );
    assert!(!clause.contains("CAST($"), "{clause}");
    assert!(clause.contains("\"computed\" = $3"), "{clause}");
}

#[test]
fn other_dialects_ignore_the_types() {
    let filters = vec![
        filter("id", FilterOp::Eq, json!(1)),
        ColumnFilter {
            values: vec![json!(1), json!(2)],
            ..filter("id", FilterOp::NotIn, Value::Null)
        },
    ];
    for dialect in [Dialect::Mysql, Dialect::Sqlite, Dialect::MsSql] {
        let typed = build_filter_clause_at(1, dialect, &filters, None, &[], &pg_types());
        let plain = build_filter_clause_at(1, dialect, &filters, None, &[], &BindTypes::default());
        assert_eq!(typed, plain, "{dialect:?}");
    }
}

#[test]
fn postgres_update_cell_casts_the_value_and_every_key() {
    let (sql, binds) = update_cell_statement(
        Dialect::Postgres,
        "\"public\".\"t\"",
        "mood",
        None,
        false,
        &["id".to_string(), "tenant".to_string()],
        None,
        &[json!(1), json!("00000000-0000-0000-0000-000000000001")],
        &pg_types(),
    );
    assert_eq!(
        sql,
        "UPDATE \"public\".\"t\" SET \"mood\" = CAST($1 AS public.mood) \
         WHERE \"id\" = CAST($2 AS smallint) AND \"tenant\" = CAST($3 AS uuid)"
    );
    // SET NULL stays a NULL bind; a cast of NULL is NULL.
    assert_eq!(binds[0], None);
}

#[test]
fn mysql_update_cell_is_unchanged_by_a_type_map() {
    let build = |types: &BindTypes| {
        update_cell_statement(
            Dialect::Mysql,
            "`t`",
            "name",
            None,
            false,
            &["id".to_string()],
            Some("x".into()),
            &[json!(1)],
            types,
        )
    };
    assert_eq!(build(&pg_types()), build(&BindTypes::default()));
    assert_eq!(
        build(&pg_types()).0,
        "UPDATE `t` SET `name` = ? WHERE `id` = ?"
    );
}

#[test]
fn postgres_delete_casts_every_key_of_every_tuple() {
    let (sql, binds) = delete_rows_statement(
        Dialect::Postgres,
        "\"public\".\"t\"",
        &["id".to_string(), "tenant".to_string()],
        &[vec![json!(1), json!("a")], vec![json!(2), json!("b")]],
        &pg_types(),
    );
    assert_eq!(
        sql,
        "DELETE FROM \"public\".\"t\" WHERE (\"id\", \"tenant\") IN \
         ((CAST($1 AS smallint), CAST($2 AS uuid)), (CAST($3 AS smallint), CAST($4 AS uuid)))"
    );
    assert_eq!(binds.len(), 4);
}

#[test]
fn sql_server_delete_is_unchanged_by_a_type_map() {
    let build = |types: &BindTypes| {
        delete_rows_statement(
            Dialect::MsSql,
            "[dbo].[t]",
            &["id".to_string()],
            &[vec![json!(1)], vec![json!(2)]],
            types,
        )
    };
    assert_eq!(build(&pg_types()), build(&BindTypes::default()));
    assert_eq!(
        build(&pg_types()).0,
        "DELETE FROM [dbo].[t] WHERE ([id]) IN ((@P1), (@P2))"
    );
}
