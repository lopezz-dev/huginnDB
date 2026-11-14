//! A query's rows written to a file, row by row, in the formats the query
//! tab's export offers: CSV (`,` or `;`), JSON and SQL `INSERT` (ADR #137,
//! "Everything, from the server…").
//!
//! **These must write the bytes `src/lib/grid/copyFormats.ts` writes**
//! (`toCsv`, `toBulk`, through `lib/query/exportResult.ts`): the same result
//! exported from the grid and from the server is the same file, only longer.
//! So this mirrors the JavaScript, including what JavaScript does by itself:
//!
//! - a number is printed as `Number.prototype.toString` prints it — `1.0` is
//!   `1`, `1e21` is `1e+21`, `0.0000001` is `1e-7` ([`js_number`]);
//! - an object's keys come in JavaScript's order — integer-like keys first,
//!   ascending, then the others as inserted, a repeated key keeping its first
//!   place and its last value ([`js_keys`]);
//! - JSON is `JSON.stringify`'s, compact or with a two-space indent.
//!
//! One fixture serialised by both languages pins it:
//! `testdata/result-export/` (`tests::the_golden_files_match` here, and
//! `copyFormats.golden.test.ts` there). Change one side and that test fails
//! until the other side and the expected files agree.
//!
//! The one place they are allowed to differ: an integer past 2^53 is written
//! exactly here, where the grid has already rounded it to a double.

use std::io::Write;

use serde::Deserialize;
use serde_json::Value;

use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};

/// The formats a result can be written in — `ResultExportFormat` in
/// `lib/query/exportResult.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultFormat {
    Csv,
    CsvSemicolon,
    Json,
    Sql,
}

impl ResultFormat {
    /// The file extension each format is saved with — `fileExtension` there.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv | Self::CsvSemicolon => "csv",
            Self::Json => "json",
            Self::Sql => "sql",
        }
    }

    /// The save dialog's filter label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Csv | Self::CsvSemicolon => "CSV",
            Self::Json => "JSON",
            Self::Sql => "SQL",
        }
    }
}

/// The table a SQL export inserts into, and which table column each result
/// column is — `SqlTarget` there, with its `columnOf` function evaluated by
/// the frontend for each result column, **in result order** (a function does
/// not cross IPC). `None` for an expression, which is left out of the
/// `INSERT`, as `toSqlInsert` leaves it out.
#[derive(Debug, Clone, Deserialize)]
pub struct SqlExportTarget {
    pub table: String,
    pub columns: Vec<Option<String>>,
}

/// Writes rows to `out` in one [`ResultFormat`], one at a time: nothing but
/// the current row is held.
pub struct RowWriter<W: Write> {
    out: W,
    format: ResultFormat,
    dialect: Dialect,
    target: Option<SqlExportTarget>,
    /// The result's column names, once [`Self::begin`] has them.
    columns: Option<Vec<String>>,
    rows: u64,
}

impl<W: Write> RowWriter<W> {
    /// A writer for `format`. `dialect` quotes identifiers and literals for a
    /// SQL export; `target` is required for one, and refused otherwise.
    pub fn new(
        out: W,
        format: ResultFormat,
        dialect: Dialect,
        target: Option<SqlExportTarget>,
    ) -> AppResult<Self> {
        if format == ResultFormat::Sql && target.is_none() {
            return Err(AppError::InvalidInput(
                "a SQL export needs the table to insert into; a result over several tables \
                 has none"
                    .into(),
            ));
        }
        Ok(Self {
            out,
            format,
            dialect,
            target: if format == ResultFormat::Sql {
                target
            } else {
                None
            },
            columns: None,
            rows: 0,
        })
    }

    /// Whether [`Self::begin`] has been called.
    pub fn has_begun(&self) -> bool {
        self.columns.is_some()
    }

    /// The result's columns, before its first row (CSV writes its header
    /// here). A SQL export's target must name as many columns as the result
    /// has: a different count means the statement now returns other columns
    /// than the grid showed, and their mapping cannot be trusted.
    pub fn begin(&mut self, columns: Vec<String>) -> AppResult<()> {
        if let Some(target) = &self.target {
            if target.columns.len() != columns.len() {
                return Err(AppError::InvalidInput(format!(
                    "the query now returns {} columns where the grid showed {}; run it again \
                     before exporting it as SQL",
                    columns.len(),
                    target.columns.len()
                )));
            }
        }
        if let Some(delimiter) = self.csv_delimiter() {
            self.out.write_all("\u{FEFF}".as_bytes())?;
            let header: Vec<String> = columns.iter().map(|c| csv_text(c, delimiter)).collect();
            self.out.write_all(header.join(delimiter).as_bytes())?;
            self.out.write_all(b"\r\n")?;
        }
        self.columns = Some(columns);
        Ok(())
    }

    /// One row, its values in column order.
    pub fn row(&mut self, values: &[Value]) -> AppResult<()> {
        let Some(columns) = &self.columns else {
            return Err(AppError::InvalidInput(
                "a row was written before its columns".into(),
            ));
        };
        let at = |i: usize| values.get(i).unwrap_or(&Value::Null);
        match self.format {
            ResultFormat::Csv | ResultFormat::CsvSemicolon => {
                let delimiter = self.csv_delimiter().unwrap_or(",");
                let fields: Vec<String> = (0..columns.len())
                    .map(|i| csv_field(at(i), delimiter))
                    .collect();
                self.out.write_all(fields.join(delimiter).as_bytes())?;
                self.out.write_all(b"\r\n")?;
            }
            ResultFormat::Json => {
                self.out
                    .write_all(if self.rows == 0 { b"[\n  " } else { b",\n  " })?;
                let entries: Vec<(String, &Value)> = columns
                    .iter()
                    .enumerate()
                    .map(|(i, c)| (c.clone(), at(i)))
                    .collect();
                let mut text = String::new();
                write_object(&mut text, &entries, Some(1));
                self.out.write_all(text.as_bytes())?;
            }
            ResultFormat::Sql => {
                let target = self.target.as_ref().expect("checked in new");
                let dialect = self.dialect;
                let picked: Vec<(&String, &Value)> = target
                    .columns
                    .iter()
                    .enumerate()
                    .filter_map(|(i, c)| c.as_ref().map(|name| (name, at(i))))
                    .collect();
                let names: Vec<String> =
                    picked.iter().map(|(n, _)| dialect.quote_ident(n)).collect();
                let values: Vec<String> = picked
                    .iter()
                    .map(|(_, v)| sql_literal(v, dialect))
                    .collect();
                writeln!(
                    self.out,
                    "INSERT INTO {} ({}) VALUES ({});",
                    dialect.quote_ident(&target.table),
                    names.join(", "),
                    values.join(", ")
                )?;
            }
        }
        self.rows += 1;
        Ok(())
    }

    /// Close the document and hand the output back, with the rows written.
    pub fn finish(mut self) -> AppResult<(W, u64)> {
        if !self.has_begun() {
            // No row and no columns: an empty result whose columns could not
            // be learnt. CSV still gets its byte-order mark and an empty
            // header, as `toCsv` writes for no columns.
            self.begin(Vec::new())?;
        }
        match self.format {
            ResultFormat::Json => {
                self.out
                    .write_all(if self.rows == 0 { b"[]" } else { b"\n]" })?
            }
            // `toBulk(…).join("\n")` plus the trailing newline
            // `serializeResult` adds: one `\n` for no rows at all.
            ResultFormat::Sql if self.rows == 0 => self.out.write_all(b"\n")?,
            _ => {}
        }
        self.out.flush()?;
        Ok((self.out, self.rows))
    }

    fn csv_delimiter(&self) -> Option<&'static str> {
        match self.format {
            ResultFormat::Csv => Some(","),
            ResultFormat::CsvSemicolon => Some(";"),
            _ => None,
        }
    }
}

/// `toCsv`'s field: NULL empty, a JSON value its compact JSON, anything else
/// its text; quoted when it holds the delimiter, a quote or a line break.
fn csv_field(v: &Value, delimiter: &str) -> String {
    let text = match v {
        Value::Null => return String::new(),
        Value::Object(_) | Value::Array(_) => js_json(v, None),
        other => js_string(other),
    };
    csv_text(&text, delimiter)
}

fn csv_text(text: &str, delimiter: &str) -> String {
    if text.contains(delimiter) || text.contains(['"', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

/// `sqlLiteral`: NULL, a number or boolean inline, anything else quoted with
/// `''` escapes — a JSON value as its compact JSON — and, on MySQL, its
/// backslashes doubled.
fn sql_literal(v: &Value, dialect: Dialect) -> String {
    let mut text = match v {
        Value::Null => return "NULL".into(),
        Value::Number(_) | Value::Bool(_) => return js_string(v),
        Value::Object(_) | Value::Array(_) => js_json(v, None),
        Value::String(s) => s.clone(),
    };
    if dialect == Dialect::Mysql {
        text = text.replace('\\', "\\\\");
    }
    format!("'{}'", text.replace('\'', "''"))
}

/// `String(v)` for a scalar.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(_) => js_json(v, None),
    }
}

/// A JSON number as JavaScript prints it (`Number.prototype.toString`, which
/// `JSON.stringify` uses too). An integer is printed exactly — see the
/// module's note on integers past 2^53.
pub fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let Some(f) = n.as_f64() else {
        return n.to_string();
    };
    if f == 0.0 {
        return "0".into();
    }
    if !f.is_finite() {
        // `JSON.stringify` writes `null`; serde_json never holds one anyway.
        return "null".into();
    }
    // `{:e}` is Rust's shortest round-trip digits, as ECMAScript asks for:
    // `d.ddde±x`. ECMA-262 Number::toString(10) then picks the layout.
    let sign = if f < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("a numeric exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `JSON.stringify(v)` (`indent` `None`) or `JSON.stringify(v, null, 2)`
/// nested `indent` levels deep.
pub fn js_json(v: &Value, indent: Option<usize>) -> String {
    let mut out = String::new();
    write_json(&mut out, v, indent);
    out
}

fn write_json(out: &mut String, v: &Value, indent: Option<usize>) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("a string serialises")),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent.map(|d| d + 1));
                write_json(out, item, indent.map(|d| d + 1));
            }
            newline(out, indent);
            out.push(']');
        }
        Value::Object(map) => {
            let entries: Vec<(String, &Value)> = map.iter().map(|(k, v)| (k.clone(), v)).collect();
            write_object(out, &entries, indent);
        }
    }
}

/// An object from `entries` in insertion order, laid out as JavaScript would
/// lay out the object built by assigning them in turn ([`js_keys`]).
fn write_object(out: &mut String, entries: &[(String, &Value)], indent: Option<usize>) {
    let ordered = js_keys(entries);
    if ordered.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push('{');
    for (i, (key, value)) in ordered.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        newline(out, indent.map(|d| d + 1));
        out.push_str(&serde_json::to_string(key).expect("a string serialises"));
        out.push(':');
        if indent.is_some() {
            out.push(' ');
        }
        write_json(out, value, indent.map(|d| d + 1));
    }
    newline(out, indent);
    out.push('}');
}

fn newline(out: &mut String, depth: Option<usize>) {
    if let Some(depth) = depth {
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    }
}

/// The order a JavaScript object built by assigning `entries` in turn holds
/// its keys: array-index keys (canonical integers below 2^32 − 1) first,
/// ascending; then every other key in the order it was first assigned. A key
/// assigned twice keeps its first place and its last value.
fn js_keys<'a>(entries: &[(String, &'a Value)]) -> Vec<(String, &'a Value)> {
    let mut seen: Vec<(String, &'a Value)> = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        match seen.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = *value,
            None => seen.push((key.clone(), *value)),
        }
    }
    let index = |k: &str| -> Option<u32> {
        let n: u32 = k.parse().ok()?;
        (n != u32::MAX && n.to_string() == k).then_some(n)
    };
    let (mut indices, others): (Vec<_>, Vec<_>) =
        seen.into_iter().partition(|(k, _)| index(k).is_some());
    indices.sort_by_key(|(k, _)| index(k));
    indices.extend(others);
    indices
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The fixture both languages serialise — see the module docs.
    #[derive(Deserialize)]
    struct Fixture {
        columns: Vec<String>,
        rows: Vec<Vec<Value>>,
        target: SqlExportTarget,
    }

    const FIXTURE: &str = include_str!("../../../testdata/result-export/fixture.json");

    fn write(format: ResultFormat, dialect: Dialect) -> String {
        let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
        let mut w = RowWriter::new(Vec::new(), format, dialect, Some(fixture.target)).unwrap();
        w.begin(fixture.columns).unwrap();
        for row in &fixture.rows {
            w.row(row).unwrap();
        }
        String::from_utf8(w.finish().unwrap().0).unwrap()
    }

    #[test]
    fn the_golden_files_match() {
        let golden = [
            (
                ResultFormat::Csv,
                Dialect::Postgres,
                include_str!("../../../testdata/result-export/expected.csv"),
            ),
            (
                ResultFormat::CsvSemicolon,
                Dialect::Postgres,
                include_str!("../../../testdata/result-export/expected-semicolon.csv"),
            ),
            (
                ResultFormat::Json,
                Dialect::Postgres,
                include_str!("../../../testdata/result-export/expected.json"),
            ),
            (
                ResultFormat::Sql,
                Dialect::Postgres,
                include_str!("../../../testdata/result-export/expected-postgres.sql"),
            ),
            (
                ResultFormat::Sql,
                Dialect::Mysql,
                include_str!("../../../testdata/result-export/expected-mysql.sql"),
            ),
            (
                ResultFormat::Sql,
                Dialect::MsSql,
                include_str!("../../../testdata/result-export/expected-sqlserver.sql"),
            ),
        ];
        for (format, dialect, expected) in golden {
            assert_eq!(
                write(format, dialect),
                expected,
                "{format:?} / {dialect:?} drifted from lib/grid/copyFormats.ts"
            );
        }
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases = [
            (json!(1.0), "1"),
            (json!(-2.5), "-2.5"),
            (json!(0.1), "0.1"),
            (json!(1e21), "1e+21"),
            (json!(1.5e21), "1.5e+21"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(0.000001), "0.000001"),
            (json!(0.0000001), "1e-7"),
            (json!(1.25e-10), "1.25e-10"),
            (json!(-0.0), "0"),
            (json!(42), "42"),
            (json!(-7), "-7"),
        ];
        for (v, expected) in cases {
            let Value::Number(n) = &v else { unreachable!() };
            assert_eq!(js_number(n), expected, "{v}");
        }
    }

    #[test]
    fn keys_take_javascript_order() {
        let (a, b, c) = (json!(1), json!(2), json!(3));
        let entries = vec![
            ("name".to_string(), &a),
            ("10".to_string(), &b),
            ("2".to_string(), &c),
            ("name".to_string(), &c),
            ("01".to_string(), &a),
        ];
        let keys: Vec<String> = js_keys(&entries).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["2", "10", "name", "01"]);
        assert_eq!(
            js_keys(&entries)[2].1,
            &c,
            "a repeated key keeps its last value"
        );
    }

    #[test]
    fn empty_results_match_the_frontend_too() {
        let empty = |format| {
            let target = SqlExportTarget {
                table: "t".into(),
                columns: vec![Some("a".into())],
            };
            let mut w =
                RowWriter::new(Vec::new(), format, Dialect::Postgres, Some(target)).unwrap();
            w.begin(vec!["a".into()]).unwrap();
            String::from_utf8(w.finish().unwrap().0).unwrap()
        };
        assert_eq!(empty(ResultFormat::Csv), "\u{FEFF}a\r\n");
        assert_eq!(empty(ResultFormat::Json), "[]");
        assert_eq!(empty(ResultFormat::Sql), "\n");
    }

    #[test]
    fn a_sql_export_needs_a_target_whose_columns_still_fit() {
        assert!(RowWriter::new(Vec::new(), ResultFormat::Sql, Dialect::Postgres, None).is_err());
        let target = SqlExportTarget {
            table: "t".into(),
            columns: vec![Some("a".into())],
        };
        let mut w = RowWriter::new(
            Vec::new(),
            ResultFormat::Sql,
            Dialect::Postgres,
            Some(target),
        )
        .unwrap();
        assert!(w.begin(vec!["a".into(), "b".into()]).is_err());
    }
}
