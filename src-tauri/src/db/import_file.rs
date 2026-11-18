//! A CSV, JSON or Excel file read into columns and rows of cells — the reading
//! half of a file import into a table (ADR #139).
//!
//! **Pure**: bytes in, a [`Sheet`] out. No pool, no catalogue, no policy. What
//! a cell *means* for a column is decided later, by
//! `commands::import::cell_bind`, which has the column's type; here a cell is
//! only what the file says it is.
//!
//! Cells are `serde_json::Value`s, so the import shares the paste's coercion
//! (`commands::insert::coerce_value`): a CSV field is a string, a JSON value is
//! itself, and an Excel cell is a number, a boolean or text.
//!
//! It is meant to read back what HuginnDB exports (ADR #138): CSV with `,` or
//! `;`, UTF-8 with a BOM and CRLF; a JSON array of objects; `.xlsx` with a
//! header row and integers as numbers. It also reads what a Spanish Excel
//! saves: `;`, Windows-1252, and a decimal comma (the comma itself is handled
//! by `cell_bind`, which knows the column is numeric).

use std::collections::BTreeSet;
use std::io::Cursor;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::{AppError, AppResult};

/// Upper bound on the rows one file may carry. The whole file is held in
/// memory while it is mapped and inserted, so the bound is what keeps a
/// runaway file from freezing the app; a refusal naming it is a better
/// ending than a half-read file.
pub const MAX_IMPORT_ROWS: usize = 200_000;

/// The formats a file can be imported from. Not the export's `ResultFormat`
/// (ADR #138): there is no SQL import here, and a CSV's delimiter is a reader
/// option ([`ReadOptions::delimiter`]), not a format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportFormat {
    Csv,
    Json,
    Xlsx,
}

impl ImportFormat {
    /// The format a file's extension names: `.csv`, `.tsv` and `.txt` are
    /// delimited text, `.json` is JSON, `.xlsx`/`.xlsm` are Excel.
    pub fn from_path(path: &Path) -> AppResult<Self> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        match ext.as_str() {
            "csv" | "tsv" | "txt" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            "xlsx" | "xlsm" => Ok(Self::Xlsx),
            "xls" => Err(AppError::InvalidInput(
                "import: the old Excel format (.xls) is not supported — save the file as .xlsx \
                 or .csv"
                    .into(),
            )),
            other => Err(AppError::InvalidInput(format!(
                "import: cannot import a .{other} file — use CSV, JSON or Excel (.xlsx)"
            ))),
        }
    }
}

/// How to read a file. Every field has a meaning for one format only and is
/// ignored by the others.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    /// CSV: the field delimiter; `None` detects it from the first line.
    #[serde(default)]
    pub delimiter: Option<char>,
    /// Excel: the sheet to read; `None` is the first.
    #[serde(default)]
    pub sheet: Option<String>,
    /// CSV and Excel: whether the first row names the columns. When it does
    /// not, they are called `Column 1`, `Column 2`, … JSON names its own.
    #[serde(default = "yes")]
    pub has_header: bool,
}

fn yes() -> bool {
    true
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            delimiter: None,
            sheet: None,
            has_header: true,
        }
    }
}

/// A file read into a table of cells. Every row has exactly `columns.len()`
/// cells — a short CSV line is padded with empty strings, a missing JSON key
/// is `null` — so the mapping can index any row by any column.
#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub format: ImportFormat,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// CSV: the delimiter that was used (given or detected).
    pub delimiter: Option<char>,
    /// CSV: the encoding the bytes were decoded from.
    pub encoding: Option<&'static str>,
    /// Excel: every sheet in the workbook, in workbook order.
    pub sheets: Vec<String>,
    /// Excel: the sheet that was read.
    pub sheet: Option<String>,
    /// How many lines of the file come before the first data row (the header,
    /// when there is one) — so an error can name the row as the file numbers
    /// it. Always 0 for JSON, whose rows are array items.
    pub first_row_offset: usize,
}

/// Read the file at `path`, in the format its extension names.
pub fn read_file(path: &Path, options: &ReadOptions) -> AppResult<Sheet> {
    let format = ImportFormat::from_path(path)?;
    let bytes = std::fs::read(path)?;
    read_bytes(format, &bytes, options)
}

/// Read `bytes` as `format`.
pub fn read_bytes(format: ImportFormat, bytes: &[u8], options: &ReadOptions) -> AppResult<Sheet> {
    let sheet = match format {
        ImportFormat::Csv => {
            let (text, encoding) = decode_text(bytes);
            read_csv(&text, encoding, options)?
        }
        ImportFormat::Json => {
            let (text, _) = decode_text(bytes);
            read_json(&text)?
        }
        ImportFormat::Xlsx => read_xlsx(bytes, options)?,
    };
    if sheet.columns.is_empty() {
        return Err(AppError::InvalidInput(
            "import: the file has no columns".into(),
        ));
    }
    if sheet.rows.len() > MAX_IMPORT_ROWS {
        return Err(AppError::InvalidInput(format!(
            "import: the file has {} rows, more than the {MAX_IMPORT_ROWS} one import takes — \
             split it into smaller files",
            sheet.rows.len()
        )));
    }
    Ok(sheet)
}

/// Text from bytes: UTF-8 (a BOM dropped) when they are valid UTF-8, otherwise
/// Windows-1252 — what Excel's "CSV (delimited by commas)" writes on a Western
/// European Windows. Every byte sequence is valid Windows-1252, so this never
/// fails; a file in some third encoding comes out with odd characters that the
/// preview shows before anything is written.
fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "UTF-8"),
        Err(_) => {
            let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (text.into_owned(), "Windows-1252")
        }
    }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/// The delimiter the first line uses most, outside quotes: `,`, `;` or tab.
/// `,` when it uses none (a one-column file).
fn detect_delimiter(text: &str) -> char {
    let mut counts = [(',', 0usize), (';', 0), ('\t', 0)];
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            '\n' | '\r' if !quoted => break,
            _ if !quoted => {
                if let Some(slot) = counts.iter_mut().find(|(d, _)| *d == c) {
                    slot.1 += 1;
                }
            }
            _ => {}
        }
    }
    // `max_by_key` keeps the last of equal maxima; iterate reversed so a tie
    // goes to the earlier entry, `,`.
    counts
        .iter()
        .rev()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n > 0)
        .map_or(',', |(d, _)| *d)
}

/// RFC 4180 records: fields split on `delimiter`, `"` quoting with `""` for a
/// quote inside, and a line ending of CRLF, LF or CR. A completely empty line
/// is skipped rather than read as a record of one empty field — Excel leaves
/// them at the end of a file. Text after a closing quote is kept as written
/// (`"a"b` is `ab`), which is what Excel does with it.
fn parse_csv_records(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    // Whether the current line has produced anything — a delimiter, a quote or
    // a character — so an empty line can be told from a line of empty fields.
    let mut touched = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                touched = true;
            }
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                if touched {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                touched = false;
            }
            _ if c == delimiter => {
                record.push(std::mem::take(&mut field));
                touched = true;
            }
            _ => {
                field.push(c);
                touched = true;
            }
        }
    }
    if touched {
        record.push(field);
        records.push(record);
    }
    records
}

fn read_csv(text: &str, encoding: &'static str, options: &ReadOptions) -> AppResult<Sheet> {
    let delimiter = options.delimiter.unwrap_or_else(|| detect_delimiter(text));
    let mut records = parse_csv_records(text, delimiter).into_iter();
    let header = if options.has_header {
        records.next().unwrap_or_default()
    } else {
        Vec::new()
    };
    let rows: Vec<Vec<String>> = records.collect();
    let width = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .max(header.len());
    let columns = column_names(header.into_iter().map(Some), width);
    let rows = rows
        .into_iter()
        .map(|r| {
            let mut cells: Vec<Value> = r.into_iter().map(Value::String).collect();
            cells.resize(width, Value::String(String::new()));
            cells
        })
        .collect();
    Ok(Sheet {
        format: ImportFormat::Csv,
        columns,
        rows,
        delimiter: Some(delimiter),
        encoding: Some(encoding),
        sheets: Vec::new(),
        sheet: None,
        first_row_offset: usize::from(options.has_header),
    })
}

/// `width` column names: the header's, trimmed, and `Column N` (1-based) for a
/// blank one or one past the header's end.
fn column_names(header: impl Iterator<Item = Option<String>>, width: usize) -> Vec<String> {
    let mut names: Vec<String> = header
        .map(|h| h.map(|s| s.trim().to_string()).unwrap_or_default())
        .collect();
    names.resize(width, String::new());
    names
        .into_iter()
        .enumerate()
        .map(|(i, n)| {
            if n.is_empty() {
                format!("Column {}", i + 1)
            } else {
                n
            }
        })
        .collect()
}

// ── JSON ─────────────────────────────────────────────────────────────────────

/// An array of objects, or one object. The columns are the union of every
/// object's keys, in alphabetical order: `serde_json` is built without
/// `preserve_order`, so the file's own order is not there to keep (the same
/// fact `commands::insert::resolve_columns` documents). A key one object lacks
/// is `null` in its row.
fn read_json(text: &str) -> AppResult<Sheet> {
    let parsed: Value = serde_json::from_str(text.trim())
        .map_err(|e| AppError::InvalidInput(format!("import: not valid JSON — {e}")))?;
    let objects: Vec<Map<String, Value>> = match parsed {
        Value::Object(o) => vec![o],
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(i, item)| match item {
                Value::Object(o) => Ok(o),
                _ => Err(AppError::InvalidInput(format!(
                    "import: item {} of the array is not an object",
                    i + 1
                ))),
            })
            .collect::<AppResult<_>>()?,
        _ => {
            return Err(AppError::InvalidInput(
                "import: expected a JSON array of objects, or one object".into(),
            ))
        }
    };
    let columns: Vec<String> = objects
        .iter()
        .flat_map(|o| o.keys().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let rows = objects
        .into_iter()
        .map(|mut o| {
            columns
                .iter()
                .map(|c| o.remove(c).unwrap_or(Value::Null))
                .collect()
        })
        .collect();
    Ok(Sheet {
        format: ImportFormat::Json,
        columns,
        rows,
        delimiter: None,
        encoding: None,
        sheets: Vec::new(),
        sheet: None,
        first_row_offset: 0,
    })
}

// ── Excel ────────────────────────────────────────────────────────────────────

fn read_xlsx(bytes: &[u8], options: &ReadOptions) -> AppResult<Sheet> {
    use calamine::{Reader, Xlsx};

    let fail = |e: calamine::XlsxError| {
        AppError::InvalidInput(format!("import: cannot read the Excel file — {e}"))
    };
    let mut book: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(fail)?;
    let sheets = book.sheet_names();
    let name = match &options.sheet {
        Some(wanted) => sheets
            .iter()
            .find(|s| *s == wanted)
            .cloned()
            .ok_or_else(|| {
                AppError::InvalidInput(format!("import: the workbook has no sheet \"{wanted}\""))
            })?,
        None => sheets
            .first()
            .cloned()
            .ok_or_else(|| AppError::InvalidInput("import: the workbook has no sheets".into()))?,
    };
    let range = book.worksheet_range(&name).map_err(fail)?;
    // Where the used range starts: a sheet whose data begins at row 3 numbers
    // its first row 3, and an error should say so.
    let top = range.start().map_or(0, |(row, _)| row as usize);

    let mut grid: Vec<Vec<Value>> = Vec::with_capacity(range.height());
    for (r, cells) in range.rows().enumerate() {
        let row = cells
            .iter()
            .enumerate()
            .map(|(c, cell)| {
                excel_cell(cell).map_err(|kind| {
                    AppError::InvalidInput(format!(
                        "import: row {}, column {} of sheet \"{name}\" holds the Excel error \
                         {kind} — fix it in Excel, or clear the cell",
                        top + r + 1,
                        c + 1
                    ))
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        grid.push(row);
    }
    // Rows Excel keeps in the used range after the data — formatted but empty.
    while grid
        .last()
        .is_some_and(|r| r.iter().all(|v| v.is_null() || v == ""))
    {
        grid.pop();
    }

    let width = range.width();
    let mut rows = grid.into_iter();
    let header: Vec<Option<String>> = if options.has_header {
        rows.next()
            .unwrap_or_default()
            .into_iter()
            .map(|v| match v {
                Value::Null => None,
                Value::String(s) => Some(s),
                other => Some(other.to_string()),
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Sheet {
        format: ImportFormat::Xlsx,
        columns: column_names(header.into_iter(), width),
        rows: rows.collect(),
        delimiter: None,
        encoding: None,
        sheets,
        sheet: Some(name),
        first_row_offset: top + usize::from(options.has_header),
    })
}

/// One Excel cell as a JSON value, or the error a formula left in it.
///
/// A number with no fraction is an integer — Excel stores every number as a
/// double, and the export (ADR #138) writes an integer column's values that
/// way, so `3.0` must come back as `3` or an integer column refuses it. A
/// date is ISO 8601 text, which every engine's date types parse.
fn excel_cell(cell: &calamine::Data) -> Result<Value, String> {
    use calamine::Data;
    Ok(match cell {
        Data::Empty => Value::Null,
        Data::String(s) => Value::String(s.clone()),
        Data::Bool(b) => Value::Bool(*b),
        Data::Int(i) => Value::Number((*i).into()),
        Data::Float(f) => float_value(*f),
        Data::DateTimeIso(s) | Data::DurationIso(s) => Value::String(s.clone()),
        Data::DateTime(dt) if dt.is_datetime() => Value::String(excel_datetime(dt)),
        // A duration (`[h]:mm:ss`) has no calendar date; its value is a
        // fraction of a day, which is what the cell holds.
        Data::DateTime(dt) => float_value(dt.as_f64()),
        Data::Error(e) => return Err(e.to_string()),
    })
}

/// A double as a JSON number: an integer when it has no fraction and fits in
/// the doubles that count integers exactly (2^53), the double otherwise.
fn float_value(f: f64) -> Value {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    if f.fract() == 0.0 && f.abs() <= EXACT {
        return Value::Number((f as i64).into());
    }
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `YYYY-MM-DD` for a date with no time, `HH:MM:SS` for a time with no date,
/// `YYYY-MM-DD HH:MM:SS` (with `.mmm` when there are milliseconds) otherwise.
fn excel_datetime(dt: &calamine::ExcelDateTime) -> String {
    let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
    let time = if ms > 0 {
        format!("{h:02}:{mi:02}:{s:02}.{ms:03}")
    } else {
        format!("{h:02}:{mi:02}:{s:02}")
    };
    let value = dt.as_f64();
    if (0.0..1.0).contains(&value) {
        time
    } else if value.fract() == 0.0 {
        format!("{y:04}-{mo:02}-{d:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02} {time}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn csv(text: &str) -> Sheet {
        read_bytes(ImportFormat::Csv, text.as_bytes(), &ReadOptions::default()).unwrap()
    }

    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }

    #[test]
    fn the_format_is_the_extension() {
        let f = |p: &str| ImportFormat::from_path(Path::new(p));
        assert_eq!(f("a.CSV").unwrap(), ImportFormat::Csv);
        assert_eq!(f("a.tsv").unwrap(), ImportFormat::Csv);
        assert_eq!(f("a.json").unwrap(), ImportFormat::Json);
        assert_eq!(f("a.xlsx").unwrap(), ImportFormat::Xlsx);
        assert!(f("a.xls").unwrap_err().to_string().contains(".xlsx"));
        assert!(f("a.parquet").is_err());
    }

    /// What `result_export` writes for CSV: BOM, CRLF, a header, `NULL` as an
    /// empty field, quotes doubled.
    #[test]
    fn a_huginndb_csv_export_reads_back() {
        let sheet = csv("\u{FEFF}id,name,note\r\n1,\"Smith, J\",\r\n2,\"say \"\"hi\"\"\",x\r\n");
        assert_eq!(sheet.columns, ["id", "name", "note"]);
        assert_eq!(sheet.delimiter, Some(','));
        assert_eq!(sheet.encoding, Some("UTF-8"));
        assert_eq!(
            sheet.rows,
            vec![
                vec![s("1"), s("Smith, J"), s("")],
                vec![s("2"), s("say \"hi\""), s("x")],
            ]
        );
        assert_eq!(sheet.first_row_offset, 1);
    }

    #[test]
    fn the_delimiter_is_detected_outside_quotes() {
        assert_eq!(detect_delimiter("a;b;c\n1,5;2;3"), ';');
        assert_eq!(detect_delimiter("\"x;y;z\",b\n"), ',');
        assert_eq!(detect_delimiter("a\tb\n"), '\t');
        assert_eq!(detect_delimiter("single\n"), ',');
        assert_eq!(csv("a;b\r\n1,5;2\r\n").rows, vec![vec![s("1,5"), s("2")]]);
    }

    #[test]
    fn a_quoted_field_keeps_its_line_breaks_and_empty_lines_are_skipped() {
        let sheet = csv("a,b\n\"one\ntwo\",2\n\n\n3,4\n");
        assert_eq!(
            sheet.rows,
            vec![vec![s("one\ntwo"), s("2")], vec![s("3"), s("4")]]
        );
        // A line of empty fields is a row, unlike an empty line.
        assert_eq!(csv("a,b\n,\n").rows, vec![vec![s(""), s("")]]);
    }

    #[test]
    fn short_and_long_lines_fit_one_width() {
        let sheet = csv("a,b\n1\n1,2,3\n");
        assert_eq!(sheet.columns, ["a", "b", "Column 3"]);
        assert_eq!(sheet.rows[0], vec![s("1"), s(""), s("")]);
    }

    #[test]
    fn without_a_header_the_columns_are_numbered() {
        let opts = ReadOptions {
            has_header: false,
            ..ReadOptions::default()
        };
        let sheet = read_bytes(ImportFormat::Csv, b"1,2\n3,4\n", &opts).unwrap();
        assert_eq!(sheet.columns, ["Column 1", "Column 2"]);
        assert_eq!(sheet.rows.len(), 2);
        assert_eq!(sheet.first_row_offset, 0);
    }

    /// What Excel saves as "CSV (delimitado por comas)" on a Spanish Windows.
    #[test]
    fn a_windows_1252_csv_is_decoded() {
        let bytes = b"nombre;a\xF1o\r\nJos\xE9;2024\r\n";
        let sheet = read_bytes(ImportFormat::Csv, bytes, &ReadOptions::default()).unwrap();
        assert_eq!(sheet.encoding, Some("Windows-1252"));
        assert_eq!(sheet.columns, ["nombre", "año"]);
        assert_eq!(sheet.rows, vec![vec![s("José"), s("2024")]]);
    }

    #[test]
    fn json_columns_are_the_union_of_the_keys() {
        let text = r#"[{"b": 1, "a": "x"}, {"a": null, "c": true, "b": {"n": 1}}]"#;
        let sheet =
            read_bytes(ImportFormat::Json, text.as_bytes(), &ReadOptions::default()).unwrap();
        assert_eq!(sheet.columns, ["a", "b", "c"]);
        assert_eq!(
            sheet.rows,
            vec![
                vec![s("x"), json!(1), Value::Null],
                vec![Value::Null, json!({"n": 1}), json!(true)],
            ]
        );
        let one = read_bytes(ImportFormat::Json, br#"{"a": 1}"#, &ReadOptions::default()).unwrap();
        assert_eq!(one.rows, vec![vec![json!(1)]]);
    }

    #[test]
    fn json_that_is_not_rows_is_refused() {
        let read = |t: &str| read_bytes(ImportFormat::Json, t.as_bytes(), &ReadOptions::default());
        assert!(read("[1, 2]").unwrap_err().to_string().contains("item 1"));
        assert!(read("42").is_err());
        assert!(read("{")
            .unwrap_err()
            .to_string()
            .contains("not valid JSON"));
        assert!(read("[]").unwrap_err().to_string().contains("no columns"));
    }

    #[test]
    fn a_whole_double_is_an_integer() {
        assert_eq!(float_value(3.0), json!(3));
        assert_eq!(float_value(-12.0), json!(-12));
        assert_eq!(float_value(0.1), json!(0.1));
        assert_eq!(float_value(1e300), json!(1e300));
    }

    /// A workbook as `result_export` writes one — built here with
    /// `rust_xlsxwriter` would need that crate, so the fixture is a minimal
    /// `.xlsx` assembled from its XML parts.
    fn workbook(sheet_xml: &str) -> Vec<u8> {
        use std::io::Write;
        let mut out = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            let opts = zip::write::SimpleFileOptions::default();
            let parts: [(&str, String); 5] = [
                (
                    "[Content_Types].xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#.into(),
                ),
                (
                    "_rels/.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.into(),
                ),
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/></sheets></workbook>"#.into(),
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.into(),
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    format!(
                        r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_xml}</sheetData></worksheet>"#
                    ),
                ),
            ];
            for (name, body) in parts {
                zip.start_file(name, opts).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.start_file("xl/styles.xml", opts).unwrap();
            // Style 1 is a date (numFmtId 14), for the date cell below.
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn an_excel_sheet_reads_numbers_booleans_dates_and_text() {
        let bytes = workbook(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>price</t></is></c><c r="C1" t="inlineStr"><is><t>ok</t></is></c><c r="D1" t="inlineStr"><is><t>day</t></is></c><c r="E1" t="inlineStr"><is><t>note</t></is></c></row>
               <row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>3.25</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"><v>45611</v></c><c r="E2" t="inlineStr"><is><t>hello</t></is></c></row>
               <row r="3"><c r="A3"><v>2</v></c></row>"#,
        );
        let sheet = read_bytes(ImportFormat::Xlsx, &bytes, &ReadOptions::default()).unwrap();
        assert_eq!(sheet.sheets, ["Datos"]);
        assert_eq!(sheet.sheet.as_deref(), Some("Datos"));
        assert_eq!(sheet.columns, ["id", "price", "ok", "day", "note"]);
        assert_eq!(
            sheet.rows,
            vec![
                vec![
                    json!(1),
                    json!(3.25),
                    json!(true),
                    s("2024-11-15"),
                    s("hello")
                ],
                vec![json!(2), Value::Null, Value::Null, Value::Null, Value::Null],
            ]
        );
        assert_eq!(sheet.first_row_offset, 1);
    }

    #[test]
    fn an_excel_error_cell_is_refused_with_its_place() {
        let bytes = workbook(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="2"><c r="A2" t="e"><v>#N/A</v></c></row>"#,
        );
        let err = read_bytes(ImportFormat::Xlsx, &bytes, &ReadOptions::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("row 2, column 1"), "{err}");
        assert!(err.contains("#N/A"), "{err}");
    }

    #[test]
    fn an_unknown_sheet_is_refused() {
        let bytes = workbook(r#"<row r="1"><c r="A1"><v>1</v></c></row>"#);
        let opts = ReadOptions {
            sheet: Some("Nope".into()),
            ..ReadOptions::default()
        };
        assert!(read_bytes(ImportFormat::Xlsx, &bytes, &opts).is_err());
    }
}
