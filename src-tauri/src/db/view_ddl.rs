//! Pure, dialect-aware DDL generation for the view editor.
//!
//! Mirrors [`crate::db::ddl`]'s "diff original vs desired, return ordered
//! statements" shape, but for `CREATE VIEW` instead of `CREATE TABLE`: the
//! editor sends the *desired* view definition (and, when editing, the
//! original snapshot); [`build_view_ddl`] diffs them and returns the
//! statements. Preview and apply call the same function, so what the user
//! sees is exactly what runs.
//!
//! A view has no ALTER-column machinery to diff — the entire body is a
//! single opaque SQL string — so unlike [`crate::db::ddl`] there is no
//! per-column comparison here, only "did the name change" / "did the body
//! change". Identifier safety (SECURITY.md, convention #4): the view/schema name
//! goes through [`crate::db::ddl::validate_ident`] before being quoted. The
//! query body itself is arbitrary user SQL — it cannot be bound as a
//! parameter in DDL, so it is only checked for non-emptiness. This is the
//! same risk class the free-form Query Editor already accepts, not a new
//! one introduced here.

use crate::db::ddl::validate_ident;
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// DTOs — mirrored in src/types.ts (camelCase on the wire).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDefinition {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    /// The view body only (a `SELECT ...` statement), never the surrounding
    /// `CREATE VIEW ... AS`. Drivers that only expose the full statement
    /// (SQLite, SQL Server) have it stripped by [`strip_view_header`] before
    /// reaching this struct.
    pub query: String,
}

// ---------------------------------------------------------------------------
// Reading a stored definition back
// ---------------------------------------------------------------------------

/// Strip a `CREATE VIEW ... AS` header, leaving just the body.
///
/// Lives here rather than in a driver module because two drivers need it and
/// this is the module that knows how such a header is *built*: SQLite's
/// `sqlite_master.sql` and SQL Server's `sys.sql_modules.definition` both store
/// the whole statement, unlike Postgres (`pg_get_viewdef`) and MySQL
/// (`information_schema.views.VIEW_DEFINITION`), which expose only the body.
/// Stripping it here is what makes [`ViewDefinition::query`] mean the same
/// thing on all five drivers.
///
/// No SQL parser, and no new `regex` dependency (CLAUDE.md asks that new crates
/// be discussed first, and this doesn't warrant one). Both grammars are
/// `CREATE [OR ALTER | TEMP[ORARY]] VIEW [IF NOT EXISTS] name [(col, ...)]
/// [WITH ...] AS select-stmt`, so the parenthesised column list is the only
/// thing before the body that can contain an `AS`-like substring, and column
/// lists are bare names with no expressions. Tracking paren depth and taking
/// the first whole-word `AS` at depth 0 is therefore exact for any statement
/// either engine would itself have produced. Falls back to the raw text when no
/// such `AS` is found — better to hand back something editable than to block
/// outright.
pub fn strip_view_header(create_sql: &str) -> String {
    let upper = create_sql.to_ascii_uppercase();
    let chars: Vec<(usize, char)> = upper.char_indices().collect();
    let n = chars.len();
    let mut depth = 0i32;
    let mut idx = 0usize;
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    while idx < n {
        let c = chars[idx].1;
        if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
        } else if depth == 0 && c == 'A' && idx + 1 < n && chars[idx + 1].1 == 'S' {
            let prev_ok = idx == 0 || !is_word(chars[idx - 1].1);
            let next_ok = idx + 2 >= n || !is_word(chars[idx + 2].1);
            if prev_ok && next_ok {
                let body_start = if idx + 2 < n {
                    chars[idx + 2].0
                } else {
                    upper.len()
                };
                return create_sql[body_start..].trim().to_string();
            }
        }
        idx += 1;
    }
    create_sql.trim().to_string()
}

fn validate_view(v: &ViewDefinition) -> AppResult<()> {
    validate_ident("view", &v.name)?;
    if let Some(schema) = &v.schema {
        if !schema.is_empty() {
            validate_ident("schema", schema)?;
        }
    }
    if v.query.trim().is_empty() {
        return Err(AppError::InvalidInput("view query is empty".into()));
    }
    Ok(())
}

/// Build the ordered DDL statements to take `original` to `desired`.
///
/// `original = None` means "create a new view"; `Some(snapshot)` diffs the
/// two on name and body.
pub fn build_view_ddl(
    dialect: Dialect,
    original: Option<&ViewDefinition>,
    desired: &ViewDefinition,
) -> AppResult<(Vec<String>, bool)> {
    // SQL Server would need `CREATE OR ALTER VIEW` (2016+) and `EXEC sp_rename`
    // rather than a rename clause; deferred with the rest of its DDL support
    // (see `crate::db::ddl`).
    if dialect == Dialect::MsSql {
        return Err(AppError::UnsupportedDriver(
            "the view editor does not support SQL Server yet".into(),
        ));
    }
    validate_view(desired)?;
    let qt = dialect.qualify(desired.schema.as_deref(), &desired.name);

    let Some(orig) = original else {
        return Ok((
            vec![format!("CREATE VIEW {qt} AS {}", desired.query.trim())],
            false,
        ));
    };
    validate_view(orig)?;

    let renamed = orig.name != desired.name || orig.schema.as_deref() != desired.schema.as_deref();
    let body_changed = orig.query.trim() != desired.query.trim();
    if !renamed && !body_changed {
        return Ok((vec![], false));
    }

    match dialect {
        Dialect::Sqlite => {
            // No CREATE OR REPLACE / ALTER VIEW on SQLite — always drop the
            // original name and recreate under the desired one.
            let old_qt = dialect.qualify(orig.schema.as_deref(), &orig.name);
            let stmts = vec![
                format!("DROP VIEW IF EXISTS {old_qt}"),
                format!("CREATE VIEW {qt} AS {}", desired.query.trim()),
            ];
            Ok((stmts, true))
        }
        Dialect::Postgres => {
            let mut stmts = Vec::new();
            if renamed {
                let old_qt = dialect.qualify(orig.schema.as_deref(), &orig.name);
                stmts.push(format!(
                    "ALTER VIEW {old_qt} RENAME TO {}",
                    dialect.quote_ident(&desired.name)
                ));
            }
            if body_changed {
                stmts.push(format!(
                    "CREATE OR REPLACE VIEW {qt} AS {}",
                    desired.query.trim()
                ));
            }
            Ok((stmts, false))
        }
        Dialect::Mysql => {
            let mut stmts = Vec::new();
            if renamed {
                let old_qt = dialect.qualify(orig.schema.as_deref(), &orig.name);
                stmts.push(format!("RENAME TABLE {old_qt} TO {qt}"));
            }
            if body_changed {
                stmts.push(format!(
                    "CREATE OR REPLACE VIEW {qt} AS {}",
                    desired.query.trim()
                ));
            }
            Ok((stmts, false))
        }
        Dialect::MsSql => unreachable!("SQL Server is rejected above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(schema: Option<&str>, name: &str, query: &str) -> ViewDefinition {
        ViewDefinition {
            schema: schema.map(String::from),
            name: name.into(),
            query: query.into(),
        }
    }

    #[test]
    fn create_new_view() {
        let (stmts, rebuild) = build_view_ddl(
            Dialect::Postgres,
            None,
            &view(Some("public"), "v_active", "SELECT 1"),
        )
        .unwrap();
        assert_eq!(
            stmts,
            vec!["CREATE VIEW \"public\".\"v_active\" AS SELECT 1"]
        );
        assert!(!rebuild);
    }

    #[test]
    fn postgres_body_change_uses_create_or_replace() {
        let orig = view(None, "v", "SELECT 1");
        let desired = view(None, "v", "SELECT 2");
        let (stmts, rebuild) = build_view_ddl(Dialect::Postgres, Some(&orig), &desired).unwrap();
        assert_eq!(stmts, vec!["CREATE OR REPLACE VIEW \"v\" AS SELECT 2"]);
        assert!(!rebuild);
    }

    #[test]
    fn postgres_rename_and_redefine() {
        let orig = view(None, "old", "SELECT 1");
        let desired = view(None, "new", "SELECT 2");
        let (stmts, _) = build_view_ddl(Dialect::Postgres, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            vec![
                "ALTER VIEW \"old\" RENAME TO \"new\"",
                "CREATE OR REPLACE VIEW \"new\" AS SELECT 2"
            ]
        );
    }

    #[test]
    fn mysql_rename_only_no_body_change() {
        let orig = view(None, "old", "SELECT 1");
        let desired = view(None, "new", "SELECT 1");
        let (stmts, _) = build_view_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert_eq!(stmts, vec!["RENAME TABLE `old` TO `new`"]);
    }

    #[test]
    fn sqlite_always_drop_and_recreate() {
        let orig = view(None, "v", "SELECT 1");
        let desired = view(None, "v", "SELECT 2");
        let (stmts, rebuild) = build_view_ddl(Dialect::Sqlite, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            vec!["DROP VIEW IF EXISTS \"v\"", "CREATE VIEW \"v\" AS SELECT 2"]
        );
        assert!(rebuild);
    }

    #[test]
    fn no_change_yields_no_statements() {
        let orig = view(None, "v", "SELECT 1");
        let (stmts, rebuild) =
            build_view_ddl(Dialect::Postgres, Some(&orig), &orig.clone()).unwrap();
        assert!(stmts.is_empty());
        assert!(!rebuild);
    }

    #[test]
    fn empty_query_rejected() {
        assert!(build_view_ddl(Dialect::Postgres, None, &view(None, "v", "   ")).is_err());
    }

    // -----------------------------------------------------------------------
    // strip_view_header
    // -----------------------------------------------------------------------

    #[test]
    fn strips_a_plain_create_view_header() {
        assert_eq!(strip_view_header("CREATE VIEW v AS SELECT 1"), "SELECT 1");
    }

    #[test]
    fn strips_temp_and_if_not_exists_variants() {
        // Every optional clause SQLite's grammar allows before the body.
        assert_eq!(
            strip_view_header("CREATE TEMP VIEW v AS SELECT 1"),
            "SELECT 1"
        );
        assert_eq!(
            strip_view_header("CREATE TEMPORARY VIEW IF NOT EXISTS v AS SELECT 1"),
            "SELECT 1"
        );
        // SQL Server's spelling, including a pre-body WITH clause.
        assert_eq!(
            strip_view_header("CREATE VIEW [dbo].[v] WITH SCHEMABINDING AS SELECT 1"),
            "SELECT 1"
        );
    }

    #[test]
    fn a_column_list_cannot_be_mistaken_for_the_body() {
        // The parenthesised column list is the only thing before the body that
        // can hold an `AS`-like token; depth tracking is what keeps a column
        // actually named `as_of` (or a bare `as`) from ending the header early.
        assert_eq!(
            strip_view_header("CREATE VIEW v (a, as_of, b) AS SELECT 1, 2, 3"),
            "SELECT 1, 2, 3"
        );
    }

    #[test]
    fn a_word_containing_as_is_not_the_separator() {
        // `LAST` and `ASSET` both contain the letters; neither is a whole word.
        assert_eq!(
            strip_view_header("CREATE VIEW assets AS SELECT last_seen FROM t"),
            "SELECT last_seen FROM t"
        );
    }

    #[test]
    fn falls_back_to_the_raw_text_when_no_header_is_found() {
        // Documented behaviour: hand back something editable rather than block.
        assert_eq!(strip_view_header("  SELECT 1  "), "SELECT 1");
    }
}
