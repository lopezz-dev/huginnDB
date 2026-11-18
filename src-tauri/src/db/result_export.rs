//! A result's rows written to a file, row by row, in every format a grid's
//! export offers: CSV (`,` or `;`), JSON, SQL `INSERT` and Excel (`.xlsx`).
//!
//! **This is the one place an exported file's bytes are decided** (ADR #138):
//! the query tab's rows shown (`export_query_result`), its "Everything, from
//! the server…" (`export_query_rows`, ADR #137) and a table's rows through its
//! query panel (`export_table_rows`) all write through [`RowWriter`]. Only a
//! table's SQL dump keeps its own writer in `commands::dump`, because it is a
//! dump of a table (batched, `IDENTITY_INSERT` on SQL Server), not of a result.
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
//!
//! Excel has no counterpart in the clipboard, so it has no golden file: its
//! cells are a number, a boolean or text, as `XlsxSheet::cell` decides.

use std::io::Write;

use serde::Deserialize;
use serde_json::Value;

use rust_xlsxwriter::{Format, Workbook, XlsxError};

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
    Xlsx,
}

impl ResultFormat {
    /// The file extension each format is saved with.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv | Self::CsvSemicolon => "csv",
            Self::Json => "json",
            Self::Sql => "sql",
            Self::Xlsx => "xlsx",
        }
    }

    /// The save dialog's filter label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Csv | Self::CsvSemicolon => "CSV",
            Self::Json => "JSON",
            Self::Sql => "SQL",
            Self::Xlsx => "Excel",
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

/// What a SQL export needs and no other format does: the table to insert
/// into and the dialect that quotes it. One value, so a writer cannot be
/// given one without the other — and a MongoDB result, which has no dialect,
/// is never asked for one to export as CSV.
#[derive(Debug, Clone)]
pub struct InsertInto {
    pub dialect: Dialect,
    pub target: SqlExportTarget,
}

/// What [`RowWriter::finish`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Written {
    pub rows: u64,
    /// Excel cells cut to fit its 32 767 characters (always 0 for the other
    /// formats, which keep every character).
    pub truncated_cells: u64,
}

/// What a rows export tells the frontend: where the file went, and how many
/// cells had to be cut to fit it — the notification says so when it is not
/// zero. `RowsExported` in `src/types.ts`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsExported {
    pub path: String,
    pub truncated_cells: u64,
}

/// Writes rows to `out` in one [`ResultFormat`], one at a time: nothing but
/// the current row is held.
pub struct RowWriter<W: Write> {
    out: W,
    format: ResultFormat,
    /// `Some` exactly when `format` is [`ResultFormat::Sql`].
    insert: Option<InsertInto>,
    /// `Some` exactly when `format` is [`ResultFormat::Xlsx`].
    xlsx: Option<XlsxSheet>,
    /// The result's column names, once [`Self::begin`] has them.
    columns: Option<Vec<String>>,
    rows: u64,
}

impl<W: Write> RowWriter<W> {
    /// A writer for `format`. `insert` is required for a SQL export and
    /// ignored by every other format.
    pub fn new(out: W, format: ResultFormat, insert: Option<InsertInto>) -> AppResult<Self> {
        if format == ResultFormat::Sql && insert.is_none() {
            return Err(AppError::InvalidInput(
                "a SQL export needs the table to insert into; a result over several tables \
                 has none"
                    .into(),
            ));
        }
        Ok(Self {
            out,
            format,
            insert: insert.filter(|_| format == ResultFormat::Sql),
            xlsx: (format == ResultFormat::Xlsx).then(XlsxSheet::new),
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
        if let Some(InsertInto { target, .. }) = &self.insert {
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
        if let Some(sheet) = &mut self.xlsx {
            sheet.begin(&columns)?;
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
            ResultFormat::Xlsx => {
                let sheet = self.xlsx.as_mut().expect("set in new");
                sheet.row(values)?;
            }
            ResultFormat::Sql => {
                let InsertInto { dialect, target } = self.insert.as_ref().expect("checked in new");
                let dialect = *dialect;
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

    /// Close the document and hand the output back, with what was written.
    pub fn finish(mut self) -> AppResult<(W, Written)> {
        if !self.has_begun() {
            // No row and no columns: an empty result whose columns could not
            // be learnt. CSV still gets its byte-order mark and an empty
            // header, as `toCsv` writes for no columns.
            self.begin(Vec::new())?;
        }
        let mut truncated_cells = 0;
        match self.format {
            ResultFormat::Json => {
                self.out
                    .write_all(if self.rows == 0 { b"[]" } else { b"\n]" })?
            }
            // `toBulk(…).join("\n")` plus the trailing newline
            // `serializeResult` adds: one `\n` for no rows at all.
            ResultFormat::Sql if self.rows == 0 => self.out.write_all(b"\n")?,
            ResultFormat::Xlsx => {
                let sheet = self.xlsx.take().expect("set in new");
                truncated_cells = sheet.truncated;
                self.out.write_all(&sheet.finish()?)?;
            }
            _ => {}
        }
        self.out.flush()?;
        let written = Written {
            rows: self.rows,
            truncated_cells,
        };
        Ok((self.out, written))
    }

    fn csv_delimiter(&self) -> Option<&'static str> {
        match self.format {
            ResultFormat::Csv => Some(","),
            ResultFormat::CsvSemicolon => Some(";"),
            _ => None,
        }
    }
}

/// The most rows one worksheet holds, its header included (Excel's limit).
const XLSX_SHEET_ROWS: u32 = 1_048_576;
/// The most columns one worksheet holds (Excel's limit).
const XLSX_COLUMNS: usize = 16_384;
/// The longest integer Excel shows exactly: it stores every number as a
/// double and displays 15 significant digits, so a longer one — an 18-digit
/// id — would come back changed. Such an integer is written as text.
const XLSX_EXACT_DIGITS: u32 = 15;
/// The most a cell holds, in UTF-16 code units (Excel's limit).
const XLSX_CELL_UNITS: usize = 32_767;
/// A column's starting width, in characters: see `XlsxSheet::new_sheet`.
const XLSX_MIN_WIDTH: usize = 15;
const XLSX_MAX_WIDTH: usize = 50;
/// What ends a cell cut to fit [`XLSX_CELL_UNITS`]. Language-neutral on
/// purpose: the backend does not know the interface's language, and `[…]`
/// reads as "something was left out" in Spanish and English alike. How many
/// cells were cut is told in the person's language, by the notification.
const XLSX_CUT_MARK: &str = " […]";

/// An Excel workbook being written, one row at a time.
///
/// Rows go through `rust_xlsxwriter`'s constant-memory mode: each finished
/// row is spilled to a temp file, so the sheet is never held — the format
/// streams like the others, and the workbook is assembled (compressed) only
/// in [`Self::finish`]. A result past one sheet's 1 048 575 data rows goes on
/// in a new sheet with the header repeated, rather than failing or being cut.
///
/// A cell is what its JSON value is: a number, a boolean, NULL left empty, an
/// object or array its compact JSON, and a string **always text** — a value
/// the driver returned as text (a `DECIMAL`, a date, a zip code with a leading
/// zero) is not guessed into a number or a date. An integer is formatted `0`,
/// so a millisecond timestamp reads `1794645204422`, not `1,79E+12`; one
/// longer than Excel can show exactly is text.
///
/// **A text longer than a cell holds is cut**, ending in [`XLSX_CUT_MARK`],
/// and counted in [`Self::truncated`] for the notification to report. A log
/// or JSON column routinely exceeds 32 767 characters, and refusing the whole
/// export for it — what this did first — made Excel useless for any table
/// with one (decided with Alex on 2026-11-17, after Dev | Tencer's
/// `logRecord`). CSV and JSON keep every character.
struct XlsxSheet {
    book: Workbook,
    header: Format,
    integer: Format,
    columns: Vec<String>,
    /// The index of the worksheet being written.
    sheet: usize,
    /// The next row to write on that worksheet.
    next: u32,
    /// Cells cut to fit [`XLSX_CELL_UNITS`].
    truncated: u64,
    /// Rows per worksheet, the header included: [`XLSX_SHEET_ROWS`], lower
    /// only in tests, which cannot afford a million rows to reach it.
    per_sheet: u32,
}

impl XlsxSheet {
    fn new() -> Self {
        Self {
            book: Workbook::new(),
            header: Format::new().set_bold(),
            integer: Format::new().set_num_format("0"),
            columns: Vec::new(),
            sheet: 0,
            next: 0,
            truncated: 0,
            per_sheet: XLSX_SHEET_ROWS,
        }
    }

    fn begin(&mut self, columns: &[String]) -> AppResult<()> {
        if columns.len() > XLSX_COLUMNS {
            return Err(AppError::InvalidInput(format!(
                "Excel holds at most {XLSX_COLUMNS} columns and this result has {}; export it \
                 as CSV instead",
                columns.len()
            )));
        }
        self.columns = columns.to_vec();
        self.new_sheet()
    }

    /// A new worksheet, its header row written and frozen.
    fn new_sheet(&mut self) -> AppResult<()> {
        let sheet = self
            .book
            .add_worksheet_with_constant_memory()
            .map_err(xlsx)?;
        // Every width before the first cell: in constant-memory mode the
        // sheet's column list is written with its first cell, so a width set
        // after it is dropped — and it cannot follow the values either. The
        // header's width, between a floor wide enough for a 13-digit
        // millisecond timestamp (a `0` format shows it as `########` in
        // Excel's default 8.43) and a ceiling that keeps one long header from
        // pushing the rest off screen.
        for (col, name) in self.columns.iter().enumerate() {
            let width = (name.chars().count() + 2).clamp(XLSX_MIN_WIDTH, XLSX_MAX_WIDTH);
            sheet
                .set_column_width(col as u16, width as f64)
                .map_err(xlsx)?;
        }
        for (col, name) in self.columns.iter().enumerate() {
            let (name, _) = fit_cell(name);
            sheet
                .write_string_with_format(0, col as u16, name.as_ref(), &self.header)
                .map_err(xlsx)?;
        }
        if !self.columns.is_empty() {
            sheet.set_freeze_panes(1, 0).map_err(xlsx)?;
        }
        self.sheet = self.book.worksheets().len() - 1;
        self.next = 1;
        Ok(())
    }

    fn row(&mut self, values: &[Value]) -> AppResult<()> {
        if self.next == self.per_sheet {
            self.new_sheet()?;
        }
        let row = self.next;
        let width = self.columns.len();
        let sheet = self.book.worksheet_from_index(self.sheet).map_err(xlsx)?;
        for col in 0..width {
            let value = values.get(col).unwrap_or(&Value::Null);
            let cut = Self::cell(sheet, &self.integer, row, col as u16, value).map_err(xlsx)?;
            self.truncated += u64::from(cut);
        }
        self.next += 1;
        Ok(())
    }

    /// Write one cell; `true` when its text had to be cut to fit.
    fn cell(
        sheet: &mut rust_xlsxwriter::Worksheet,
        integer: &Format,
        row: u32,
        col: u16,
        value: &Value,
    ) -> Result<bool, XlsxError> {
        let text = match value {
            Value::Null => return Ok(false),
            Value::Bool(b) => {
                sheet.write_boolean(row, col, *b)?;
                return Ok(false);
            }
            Value::Number(n) => {
                let whole = n.as_i64().map(i64::unsigned_abs).or_else(|| n.as_u64());
                match (whole, n.as_f64()) {
                    // An integer Excel shows exactly: a number, shown whole.
                    (Some(i), Some(f)) if i < 10u64.pow(XLSX_EXACT_DIGITS) => {
                        sheet.write_number_with_format(row, col, f, integer)?;
                        return Ok(false);
                    }
                    // A fraction: a double already, as Excel's own numbers are.
                    (None, Some(f)) if f.is_finite() => {
                        sheet.write_number(row, col, f)?;
                        return Ok(false);
                    }
                    // Longer than Excel shows exactly: text, every digit kept.
                    _ => js_number(n),
                }
            }
            Value::String(s) => s.clone(),
            Value::Object(_) | Value::Array(_) => js_json(value, None),
        };
        let (fitted, cut) = fit_cell(&text);
        sheet.write_string(row, col, fitted.as_ref())?;
        Ok(cut)
    }

    /// The workbook's bytes.
    fn finish(mut self) -> AppResult<Vec<u8>> {
        self.book.save_to_buffer().map_err(xlsx)
    }
}

/// `text` as it fits in one Excel cell: whole when it does, otherwise cut on a
/// character boundary and ended with [`XLSX_CUT_MARK`] — the whole within
/// [`XLSX_CELL_UNITS`] UTF-16 units, which is how Excel counts. `true` when
/// it was cut.
fn fit_cell(text: &str) -> (std::borrow::Cow<'_, str>, bool) {
    if text.len() <= XLSX_CELL_UNITS || text.encode_utf16().count() <= XLSX_CELL_UNITS {
        return (std::borrow::Cow::Borrowed(text), false);
    }
    let budget = XLSX_CELL_UNITS - XLSX_CUT_MARK.encode_utf16().count();
    let mut units = 0;
    let mut end = 0;
    for (i, c) in text.char_indices() {
        if units + c.len_utf16() > budget {
            break;
        }
        units += c.len_utf16();
        end = i + c.len_utf8();
    }
    (
        std::borrow::Cow::Owned(format!("{}{XLSX_CUT_MARK}", &text[..end])),
        true,
    )
}

fn xlsx(e: XlsxError) -> AppError {
    AppError::Transfer(format!("could not write the Excel file: {e}"))
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
        let insert = InsertInto {
            dialect,
            target: fixture.target,
        };
        let mut w = RowWriter::new(Vec::new(), format, Some(insert)).unwrap();
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
            let insert = InsertInto {
                dialect: Dialect::Postgres,
                target,
            };
            let mut w = RowWriter::new(Vec::new(), format, Some(insert)).unwrap();
            w.begin(vec!["a".into()]).unwrap();
            String::from_utf8(w.finish().unwrap().0).unwrap()
        };
        assert_eq!(empty(ResultFormat::Csv), "\u{FEFF}a\r\n");
        assert_eq!(empty(ResultFormat::Json), "[]");
        assert_eq!(empty(ResultFormat::Sql), "\n");
    }

    /// Every XML part of a written workbook, concatenated: whether a string
    /// is inline or shared is the library's business, not this test's.
    fn xlsx_text(columns: &[&str], rows: &[Vec<Value>]) -> String {
        use std::io::Read as _;
        let mut w = RowWriter::new(Vec::new(), ResultFormat::Xlsx, None).unwrap();
        w.begin(columns.iter().map(|c| c.to_string()).collect())
            .unwrap();
        for row in rows {
            w.row(row).unwrap();
        }
        let (bytes, written) = w.finish().unwrap();
        assert_eq!(written.rows, rows.len() as u64);
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut all = String::new();
        for i in 0..zip.len() {
            let mut part = zip.by_index(i).unwrap();
            if part.name().ends_with(".xml") {
                part.read_to_string(&mut all).unwrap();
            }
        }
        all
    }

    #[test]
    fn an_excel_cell_is_what_its_value_is() {
        let xml = xlsx_text(
            &["id", "name", "price", "ok", "doc", "big", "none"],
            &[vec![
                json!(42),
                json!("00123"),
                json!(9.5),
                json!(true),
                json!({"a": [1, 2]}),
                json!(123_456_789_012_345_678_i64),
                Value::Null,
            ]],
        );
        // Numbers and booleans are cells of their type…
        assert!(xml.contains("<v>42</v>"), "{xml}");
        assert!(xml.contains("<v>9.5</v>"), "{xml}");
        assert!(xml.contains(r#"t="b""#), "{xml}");
        // …text stays text, a leading zero included…
        assert!(xml.contains("00123"), "{xml}");
        assert!(xml.contains(r#"{&quot;a&quot;:[1,2]}"#) || xml.contains(r#"{"a":[1,2]}"#));
        // …and an integer longer than Excel shows exactly is text, not a
        // double that would read back as 123456789012345000.
        assert!(xml.contains("123456789012345678"), "{xml}");
        assert!(!xml.contains("<v>1.23456789012346E+17</v>"));
        // The header is there, bold and frozen.
        assert!(xml.contains("price"));
        assert!(xml.contains("<pane"), "{xml}");
    }

    #[test]
    fn a_result_past_one_sheet_goes_on_in_the_next() {
        use std::io::Read as _;
        let mut w = RowWriter::new(Vec::new(), ResultFormat::Xlsx, None).unwrap();
        w.xlsx.as_mut().unwrap().per_sheet = 3;
        w.begin(vec!["n".into()]).unwrap();
        for n in 1..=5 {
            w.row(&[json!(n)]).unwrap();
        }
        let (bytes, written) = w.finish().unwrap();
        assert_eq!(written.rows, 5, "no row is cut");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut sheet = |name: &str| {
            let mut text = String::new();
            zip.by_name(name)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            text
        };
        let (first, second, third) = (
            sheet("xl/worksheets/sheet1.xml"),
            sheet("xl/worksheets/sheet2.xml"),
            sheet("xl/worksheets/sheet3.xml"),
        );
        assert!(first.contains("<v>2</v>") && !first.contains("<v>3</v>"));
        assert!(second.contains("<v>3</v>") && second.contains("<v>4</v>"));
        assert!(third.contains("<v>5</v>"));
    }

    #[test]
    fn an_empty_excel_result_still_has_its_header() {
        let xml = xlsx_text(&["only"], &[]);
        assert!(xml.contains("only"));
    }

    #[test]
    fn a_cell_too_long_for_excel_is_cut_and_counted() {
        use std::io::Read as _;
        let mut w = RowWriter::new(Vec::new(), ResultFormat::Xlsx, None).unwrap();
        w.begin(vec!["body".into(), "doc".into()]).unwrap();
        // A string, and a JSON value whose text is too long, both cut.
        w.row(&[
            json!("x".repeat(40_000)),
            json!({ "k": "y".repeat(40_000) }),
        ])
        .unwrap();
        w.row(&[json!("short"), Value::Null]).unwrap();
        let (bytes, written) = w.finish().unwrap();
        assert_eq!(written.rows, 2, "the export goes through");
        assert_eq!(written.truncated_cells, 2);
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut sheet = String::new();
        zip.by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut sheet)
            .unwrap();
        let kept = format!("{}{XLSX_CUT_MARK}", "x".repeat(XLSX_CELL_UNITS - 4));
        assert!(sheet.contains(&kept), "cut to the limit, mark included");
        assert!(!sheet.contains(&"x".repeat(XLSX_CELL_UNITS - 3)));
        assert!(sheet.contains("short"));
    }

    #[test]
    fn a_cut_never_splits_a_character_and_fits_in_utf16_units() {
        // "€" is one UTF-16 unit and three UTF-8 bytes; "𝄞" is two units.
        for text in ["€".repeat(40_000), "𝄞".repeat(20_000)] {
            let (fitted, cut) = fit_cell(&text);
            assert!(cut);
            assert!(fitted.encode_utf16().count() <= XLSX_CELL_UNITS);
            assert!(fitted.ends_with(XLSX_CUT_MARK));
        }
        let fits = "€".repeat(XLSX_CELL_UNITS);
        assert_eq!(
            fit_cell(&fits),
            (std::borrow::Cow::Borrowed(fits.as_str()), false)
        );
    }

    #[test]
    fn an_integer_is_shown_whole_not_in_scientific_notation() {
        let xml = xlsx_text(
            &["ts", "ratio"],
            &[vec![json!(1_794_645_204_422_i64), json!(0.25)]],
        );
        assert!(xml.contains("<v>1794645204422</v>"), "{xml}");
        // Wide enough to show it: Excel draws `########` in a 8.43 column.
        // Both columns take the floor, so they share one `<col>`; the library
        // rounds 15 characters through pixels to 15.71….
        assert!(
            xml.contains(r#"<col min="1" max="2" width="15."#),
            "the columns keep Excel's default width"
        );
        // Formatted `0`: Excel's built-in format 1, or the same code declared.
        assert!(
            xml.contains(r#"numFmtId="1""#) || xml.contains(r#"formatCode="0""#),
            "no `0` number format in the styles"
        );
    }

    #[test]
    fn a_sql_export_needs_a_target_whose_columns_still_fit() {
        assert!(RowWriter::new(Vec::new(), ResultFormat::Sql, None).is_err());
        let insert = InsertInto {
            dialect: Dialect::Postgres,
            target: SqlExportTarget {
                table: "t".into(),
                columns: vec![Some("a".into())],
            },
        };
        let mut w = RowWriter::new(Vec::new(), ResultFormat::Sql, Some(insert)).unwrap();
        assert!(w.begin(vec!["a".into(), "b".into()]).is_err());
    }
}
