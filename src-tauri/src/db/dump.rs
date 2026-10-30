//! Pure logic for "export database to .sql": per-dialect literal encoding and
//! `INSERT` statement assembly. No I/O, no `sqlx` execution — [`crate::commands::dump`]
//! drives the actual queries and file writing.
//!
//! Mirrors [`crate::db::values`]'s per-driver dispatch-by-type-name shape, but
//! emits SQL literal text instead of `serde_json::Value` — the two modules
//! intentionally stay separate rather than sharing a "value" abstraction,
//! since a JSON value and a SQL literal have different escaping/quoting rules
//! per type and forcing them through one representation would obscure both.

use crate::db::sql::Dialect;
use crate::db::values::hex;
use sqlx::{Row, TypeInfo, ValueRef};

/// Escape + quote a text literal for the dialect.
///
/// Postgres and SQLite only need `'` doubled (`standard_conforming_strings`
/// is on by default for both). MySQL's default `sql_mode` also treats `\` as
/// an escape character inside string literals, so MySQL literals additionally
/// double backslashes — done *first*, so doubling `'` afterward doesn't touch
/// the backslashes just inserted.
pub fn quote_text_literal(dialect: Dialect, s: &str) -> String {
    let escaped = if dialect == Dialect::Mysql {
        s.replace('\\', "\\\\").replace('\'', "''")
    } else {
        s.replace('\'', "''")
    };
    format!("'{escaped}'")
}

fn fmt_f64(v: f64) -> String {
    if v.is_finite() {
        v.to_string()
    } else {
        // No portable literal for NaN/Infinity across all three drivers in a
        // plain INSERT; NULL is the closest safe fallback (accepted v1 gap —
        // non-finite floats are vanishingly rare in practice).
        "NULL".to_string()
    }
}

/// One cell → SQL literal text, Postgres.
pub fn pg_literal(row: &sqlx::postgres::PgRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    match raw.type_info().name() {
        "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(|v| if v { "TRUE" } else { "FALSE" }.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT2" => row
            .try_get::<i16, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT4" => row
            .try_get::<i32, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT8" => row
            .try_get::<i64, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "FLOAT4" => row
            .try_get::<f32, _>(idx)
            .map(|v| fmt_f64(v as f64))
            .unwrap_or_else(|_| "NULL".into()),
        "FLOAT8" => row
            .try_get::<f64, _>(idx)
            .map(fmt_f64)
            .unwrap_or_else(|_| "NULL".into()),
        "NUMERIC" => row
            .try_get::<sqlx::types::BigDecimal, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "JSON" | "JSONB" => row
            .try_get::<serde_json::Value, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v.to_rfc3339()))
            .unwrap_or_else(|_| "NULL".into()),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| format!("'\\x{}'", hex(&v)))
            .unwrap_or_else(|_| "NULL".into()),
        // Strings and unknown types (including arrays/MONEY, an accepted v1
        // gap already present in `values::pg_value`) share this fallback.
        _ => row
            .try_get::<String, _>(idx)
            .map(|v| quote_text_literal(Dialect::Postgres, &v))
            .unwrap_or_else(|_| "NULL".into()),
    }
}

/// One cell → SQL literal text, MySQL.
pub fn mysql_literal(row: &sqlx::mysql::MySqlRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    let name = raw.type_info().name().to_uppercase();

    // Must be checked before the generic `INT` branch — see gotcha #15's note
    // in `values::mysql_value` ("TINYINT(1)" contains "INT").
    if name == "BOOL" || name == "TINYINT(1)" {
        return row
            .try_get::<bool, _>(idx)
            .map(|v| if v { "1" } else { "0" }.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("INT") {
        // Same widen-then-narrow fallback chain as `values::mysql_value`
        // (gotcha #15) — sqlx maps each MySQL integer width to a specific
        // Rust type and refuses a mismatched `try_get`.
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i32, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i16, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i8, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u64, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u32, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u16, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u8, _>(idx) {
            return v.to_string();
        }
        return "NULL".into();
    }
    if name.contains("DECIMAL") {
        return row
            .try_get::<sqlx::types::BigDecimal, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("FLOAT") || name.contains("DOUBLE") {
        return row
            .try_get::<f64, _>(idx)
            .map(fmt_f64)
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("JSON") {
        return row
            .try_get::<serde_json::Value, _>(idx)
            .map(|v| quote_text_literal(Dialect::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("BLOB") || name.contains("BINARY") {
        // Same content-based text/binary disambiguation as gotcha #17's
        // `values::mysql_value` — a real `LONGTEXT` can still be reported
        // under a BLOB-ish type name, so bytes are validated as UTF-8 rather
        // than trusting the type name alone. Valid UTF-8 dumps as a quoted
        // string literal (portable, human-readable); otherwise as a hex blob
        // literal.
        if let Ok(bytes) = row.try_get::<Vec<u8>, _>(idx) {
            return match String::from_utf8(bytes) {
                Ok(s) => quote_text_literal(Dialect::Mysql, &s),
                Err(e) => format!("0x{}", hex(e.as_bytes())),
            };
        }
        return "NULL".into();
    }
    if name == "DATETIME" {
        return row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| quote_text_literal(Dialect::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "TIMESTAMP" {
        return row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| quote_text_literal(Dialect::Mysql, &v.to_rfc3339()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "DATE" {
        return row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| quote_text_literal(Dialect::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "TIME" {
        return row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|v| quote_text_literal(Dialect::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "YEAR" {
        return row
            .try_get::<u16, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("BIT") {
        // A literal INSERT is parsed as a plain number by MySQL's grammar
        // even for a BIT column — unlike a bound parameter (gotcha #15's
        // `CAST(? AS UNSIGNED)` requirement is specific to prepared-statement
        // binding), so the bare decimal value round-trips fine here.
        return row
            .try_get::<u64, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    row.try_get::<String, _>(idx)
        .map(|v| quote_text_literal(Dialect::Mysql, &v))
        .unwrap_or_else(|_| "NULL".into())
}

/// One cell → SQL literal text, SQLite. SQLite is dynamically typed, so this
/// tries the supported affinities in the same order as `values::sqlite_value`.
pub fn sqlite_literal(row: &sqlx::sqlite::SqliteRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return v.to_string();
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return fmt_f64(v);
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return quote_text_literal(Dialect::Sqlite, &v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return format!("X'{}'", hex(&v));
    }
    "NULL".into()
}

/// A T-SQL Unicode string literal. `N` matters: without it the text is
/// converted through the database's code page on the way in, and anything
/// outside it (most of Unicode, on a Latin1 collation) becomes `?`.
fn mssql_text(s: &str) -> String {
    crate::db::sql::mssql_nstring(s)
}

/// `datetime2` / `time` fractional seconds: SQL Server keeps 100 ns ticks, so
/// seven digits are exact and the most it will parse.
fn ticks7(nanos: u32) -> String {
    format!("{:07}", nanos / 100)
}

/// One cell → T-SQL literal text.
///
/// Dispatches on the TDS value, not on a type name, the same way
/// `db::mssql::values::mssql_value` does. The temporal forms are what need
/// care:
///
/// * **ISO 8601 with a `T`** (`2024-01-02T03:04:05`). The space-separated form
///   chrono prints by default is read through the session's `DATEFORMAT` for
///   `datetime` and `smalldatetime`, so under `dmy` the same file would load
///   different dates — or fail — depending on the login's language.
/// * **Fraction width by type.** `datetime` parses at most three fractional
///   digits and refuses seven, while `datetime2` keeps seven; each gets its own.
/// * `datetimeoffset` keeps the offset it was stored with.
///
/// Binary as `0x…`, `bit` as `0`/`1`, `uniqueidentifier` and XML as strings,
/// non-finite floats as `NULL` (the gap the other dialects already accept).
pub fn mssql_literal(row: &tiberius::Row, idx: usize) -> String {
    use tiberius::ColumnData;
    let Some((_, data)) = row.cells().nth(idx) else {
        return "NULL".into();
    };
    let null = || "NULL".to_string();
    match data {
        ColumnData::Bit(v) => v.map(|b| if b { "1" } else { "0" }.to_string()),
        ColumnData::U8(v) => v.map(|n| n.to_string()),
        ColumnData::I16(v) => v.map(|n| n.to_string()),
        ColumnData::I32(v) => v.map(|n| n.to_string()),
        ColumnData::I64(v) => v.map(|n| n.to_string()),
        ColumnData::F32(v) => v.map(|f| fmt_f64(f as f64)),
        ColumnData::F64(v) => v.map(fmt_f64),
        ColumnData::Numeric(v) => v.map(crate::db::mssql::values::numeric_to_string),
        ColumnData::String(v) => v.as_ref().map(|s| mssql_text(s)),
        ColumnData::Xml(v) => v.as_ref().map(|x| mssql_text(x.as_ref().as_ref())),
        ColumnData::Guid(v) => v.map(|g| format!("'{g}'")),
        ColumnData::Binary(v) => v.as_ref().map(|b| format!("0x{}", hex(b))),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|d| format!("'{}'", d.format("%Y-%m-%dT%H:%M:%S%.3f"))),
        ColumnData::DateTime2(_) => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|d| {
                use chrono::Timelike;
                format!(
                    "'{}.{}'",
                    d.format("%Y-%m-%dT%H:%M:%S"),
                    ticks7(d.nanosecond())
                )
            }),
        ColumnData::Date(_) => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .ok()
            .flatten()
            .map(|d| format!("'{}'", d.format("%Y-%m-%d"))),
        ColumnData::Time(_) => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .ok()
            .flatten()
            .map(|t| {
                use chrono::Timelike;
                format!("'{}.{}'", t.format("%H:%M:%S"), ticks7(t.nanosecond()))
            }),
        // `FixedOffset`, not `Utc`: a `datetimeoffset` stores the offset it was
        // written with, and reading it as UTC would export `+02:00` as
        // `+00:00` — the same instant, but not the same value.
        ColumnData::DateTimeOffset(_) => row
            .try_get::<chrono::DateTime<chrono::FixedOffset>, _>(idx)
            .ok()
            .flatten()
            .map(|d| {
                use chrono::Timelike;
                format!(
                    "'{}.{}{}'",
                    d.format("%Y-%m-%dT%H:%M:%S"),
                    ticks7(d.nanosecond()),
                    d.format("%:z")
                )
            }),
    }
    .unwrap_or_else(null)
}

/// Columns a T-SQL `INSERT` must not name: `timestamp` / `rowversion`, which
/// the server stamps itself and refuses an explicit value for.
pub fn mssql_insertable(data_type: &str) -> bool {
    let t = data_type.trim().to_ascii_lowercase();
    t != "timestamp" && t != "rowversion"
}

/// Wrap one `INSERT` for a table with an `IDENTITY` column so it may carry the
/// column's values.
///
/// One statement, not three: `SET IDENTITY_INSERT` is session state, and the
/// import path runs every statement as its own call (`sp_executesql`), where
/// a `SET` made inside one does not outlive it. Inside a single batch the
/// three always share a scope — in HuginnDB's importer, in SSMS and in
/// `sqlcmd`. T-SQL needs no `;` between them, which is also what keeps the
/// importer's `;` splitter from cutting them apart. No reseed afterwards:
/// SQL Server raises the identity to the highest value an `IDENTITY_INSERT`
/// wrote on its own.
pub fn mssql_identity_insert(qualified_table: &str, insert: &str) -> String {
    format!(
        "SET IDENTITY_INSERT {qualified_table} ON\n{insert}\nSET IDENTITY_INSERT {qualified_table} OFF"
    )
}

/// Assemble one or more multi-row `INSERT INTO ... VALUES (...), (...);`
/// statements from pre-rendered per-cell literals, chunked at `batch_size`
/// rows per statement (mysqldump-style multi-row insert). `quoted_columns`
/// and `rows` must already be caller-rendered — this only assembles
/// punctuation, so it has no dialect-specific behaviour of its own.
pub fn build_insert_statements(
    qualified_table: &str,
    quoted_columns: &[String],
    rows: &[Vec<String>],
    batch_size: usize,
) -> Vec<String> {
    if rows.is_empty() {
        return vec![];
    }
    let col_list = quoted_columns.join(", ");
    rows.chunks(batch_size.max(1))
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|r| format!("({})", r.join(", ")))
                .collect::<Vec<_>>()
                .join(",\n  ");
            format!("INSERT INTO {qualified_table} ({col_list}) VALUES\n  {values}")
        })
        .collect()
}

/// Postgres: resync an identity/serial column's sequence after loading
/// explicit PK values, so the next native insert doesn't collide with a
/// loaded row. `pg_get_serial_sequence`'s arguments are plain string literals
/// holding the *unquoted* table/column names, not `quote_ident`-quoted
/// identifiers — do not "fix" that later.
pub fn pg_sequence_resync_stmt(
    unquoted_table: &str,
    unquoted_column: &str,
    max_value: i64,
) -> String {
    format!(
        "SELECT setval(pg_get_serial_sequence('{unquoted_table}', '{unquoted_column}'), {max_value}, true)"
    )
}

/// MySQL: resync an `AUTO_INCREMENT` column after loading explicit PK values.
pub fn mysql_auto_increment_resync_stmt(qualified_table: &str, max_value: i64) -> String {
    format!(
        "ALTER TABLE {qualified_table} AUTO_INCREMENT = {}",
        max_value + 1
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_insert_wraps_the_insert_in_one_batch() {
        let insert = "INSERT INTO [dbo].[t] ([id]) VALUES\n  (1)";
        assert_eq!(
            mssql_identity_insert("[dbo].[t]", insert),
            "SET IDENTITY_INSERT [dbo].[t] ON\nINSERT INTO [dbo].[t] ([id]) VALUES\n  (1)\n\
             SET IDENTITY_INSERT [dbo].[t] OFF"
        );
        // No `;` inside: the importer's splitter must see one statement.
        assert!(!mssql_identity_insert("[dbo].[t]", insert).contains(';'));
    }

    #[test]
    fn rowversion_is_never_inserted() {
        assert!(!mssql_insertable("timestamp"));
        assert!(!mssql_insertable(" ROWVERSION "));
        assert!(mssql_insertable("datetime2(7)"));
        assert!(mssql_insertable("binary(8)"));
    }

    #[test]
    fn fractions_are_seven_digit_ticks() {
        assert_eq!(ticks7(0), "0000000");
        assert_eq!(ticks7(123_456_700), "1234567");
        assert_eq!(ticks7(5_000_000), "0050000");
    }

    #[test]
    fn unicode_text_keeps_its_n_prefix() {
        assert_eq!(mssql_text("O'Brien — ñ"), "N'O''Brien — ñ'");
    }
}
