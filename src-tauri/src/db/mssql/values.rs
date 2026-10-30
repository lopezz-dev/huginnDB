//! SQL Server row → `serde_json::Value` decoding.
//!
//! The counterpart of [`crate::db::values`]'s `pg_value` / `mysql_value` /
//! `sqlite_value`, but structurally simpler: `tiberius` hands back a typed
//! [`ColumnData`] per cell, so this matches on the *value* rather than
//! second-guessing a type *name* the way the `sqlx` decoders have to. That
//! removes the whole class of bugs documented in gotchas #11, #15 and #17.
//!
//! Two deliberate representation choices:
//!
//! * **`bit` decodes to the number 0/1, not a JSON boolean.** SQL Server's
//!   `bit` is its boolean type, and the grid already has a BIT display
//!   preference plus a dedicated 0/1 editor (`BitInput`) driven off the
//!   reported type name. Emitting `0`/`1` keeps that path working and matches
//!   the MySQL `TINYINT(1)` precedent (gotcha #15), where forcing a Rust `bool`
//!   would have thrown information away.
//! * **`decimal`/`numeric` decode to a *string*.** They are arbitrary
//!   precision on the server; routing them through an `f64` would silently
//!   round. Same reasoning as the other drivers' handling of `NUMERIC`. The
//!   string is built by [`numeric_to_string`], **not** by `Numeric`'s own
//!   `Display` — see that function for why. (`money`/`smallmoney` are a
//!   different story: `tiberius` decodes them to `ColumnData::F64` at the
//!   protocol layer, before we ever see them, so they ride the `f64` branch.)
//!
//! Anything that cannot be decoded degrades to `Value::Null` rather than
//! failing the whole query — again matching [`crate::db::values`].

use crate::db::values::hex;
use serde_json::Value;
use tiberius::{ColumnData, ColumnType, Row};

/// Decode cell `idx` of `row` into JSON.
pub fn mssql_value(row: &Row, idx: usize) -> Value {
    let Some((_, data)) = row.cells().nth(idx) else {
        return Value::Null;
    };
    match data {
        ColumnData::Bit(v) => v.map(|b| Value::from(u8::from(b))).unwrap_or(Value::Null),
        ColumnData::U8(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I16(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I32(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I64(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::F32(v) => v.and_then(finite_f32).unwrap_or(Value::Null),
        ColumnData::F64(v) => v.and_then(finite_f64).unwrap_or(Value::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| Value::from(s.as_ref()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(v) => v.map(|g| Value::from(g.to_string())).unwrap_or(Value::Null),
        // Hex, `0x`-prefixed — the literal form T-SQL itself accepts, so a
        // copied cell can be pasted straight back into a query.
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| Value::from(format!("0x{}", hex(b))))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(v) => v
            .map(|n| Value::from(numeric_to_string(n)))
            .unwrap_or(Value::Null),
        ColumnData::Xml(v) => v
            .as_ref()
            .map(|x| Value::from(x.as_ref().to_string()))
            .unwrap_or(Value::Null),
        // The temporal variants carry raw TDS day/tick counts, so they go
        // through `try_get`'s `FromSql` impls (the `chrono` feature) instead of
        // being reinterpreted here.
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Date(_) => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Time(_) => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::DateTimeOffset(_) => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_rfc3339()))
            .unwrap_or(Value::Null),
    }
}

/// Column name + T-SQL type name pairs, in result-set order.
///
/// The type name feeds `ColumnMeta.data_type`, which the grid uses for
/// right-aligning numerics and for picking the BIT editor — so it has to read
/// like a type the user would recognise from the structure view, not like a
/// protocol token.
pub fn mssql_columns(row: &Row) -> Vec<(String, String)> {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), type_name(c.column_type()).to_string()))
        .collect()
}

/// Map a TDS column type onto the T-SQL type name it corresponds to.
///
/// The protocol distinguishes fixed-length from nullable-variable-length forms
/// of the same logical type (`Int4` vs `Intn`, `Datetime` vs `Datetimen`, …);
/// both map to the same user-facing name, since a nullable `int` is still an
/// `int`. Where the protocol genuinely cannot tell two types apart the wider
/// one is reported.
fn type_name(ct: ColumnType) -> &'static str {
    match ct {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        // The nullable integer form carries its width in the value, not the
        // type token; `int` is the overwhelmingly common case.
        ColumnType::Intn => "int",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Decimaln => "decimal",
        ColumnType::Numericn => "numeric",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::BigChar => "char",
        ColumnType::BigVarChar => "varchar",
        ColumnType::NChar => "nchar",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::Text => "text",
        ColumnType::NText => "ntext",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::Image => "image",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::SSVariant => "sql_variant",
    }
}

/// First column of `row` as an `i64` — the `COUNT(*)` / `SELECT 1` shape.
///
/// Accepts every integer width TDS might use for a count (`COUNT(*)` is `int`,
/// `COUNT_BIG` and the partition-stats views are `bigint`) so callers don't
/// have to care which one the server picked.
pub fn first_i64(row: &Row) -> Option<i64> {
    match row.cells().next().map(|(_, d)| d)? {
        ColumnData::U8(v) => v.map(i64::from),
        ColumnData::I16(v) => v.map(i64::from),
        ColumnData::I32(v) => v.map(i64::from),
        ColumnData::I64(v) => *v,
        // `int_part()` rather than parsing the rendered string: the string
        // carries a decimal point whenever the scale is non-zero (`"5.0"` for a
        // `decimal(18,0)`), which `parse::<i64>` rejects outright.
        ColumnData::Numeric(v) => v.and_then(|n| i64::try_from(n.int_part()).ok()),
        _ => None,
    }
}

/// First column of `row` as a string, for the single-value catalog queries.
pub fn first_string(row: &Row) -> Option<String> {
    match row.cells().next().map(|(_, d)| d)? {
        ColumnData::String(v) => v.as_ref().map(|s| s.to_string()),
        _ => None,
    }
}

/// Render a TDS `decimal`/`numeric` exactly, from its raw mantissa and scale.
///
/// **Do not replace this with `Numeric::to_string()`.** `tiberius`'s `Display`
/// impl is `write!(f, "{}.{:0pad$}", self.int_part(), self.dec_part(), pad =
/// scale)`, and both halves are derived from one signed `i128`, so a negative
/// value emits its sign *twice* and loses the zero-padding of the fractional
/// part at the same time: `decimal(18,9)` holding `-18.9` (mantissa
/// `-18_900_000_000`) renders as `-18.-900000000`, and `-18.09` as `-18.-9`.
/// Values whose magnitude is below 1 lose the sign entirely instead
/// (`int_part()` of `-0.5` is `0`, so it renders `0.-5`). A `scale` of 0 still
/// gets a `.0` tail. None of those strings is a number any parser accepts,
/// which is what made the artifact reachable from the grid, the row-copy /
/// CSV-export paths and the `huginndb-mcp` connector alike (`.sql` export is
/// the one consumer spared, only because it refuses SQL Server outright —
/// ADR #31).
///
/// So: take the sign off the mantissa once, format the magnitude as digits,
/// left-pad it to at least `scale + 1` digits (values below 1 need the leading
/// zero) and split it `scale` digits from the right. No `f64` anywhere — the
/// whole reason these columns travel as text is that they hold values an
/// `f64` cannot represent.
pub(crate) fn numeric_to_string(n: tiberius::numeric::Numeric) -> String {
    let sign = if n.value() < 0 { "-" } else { "" };
    // `unsigned_abs` so `i128::MIN` doesn't overflow on negation.
    let digits = n.value().unsigned_abs().to_string();
    let scale = usize::from(n.scale());

    if scale == 0 {
        return format!("{sign}{digits}");
    }

    let digits = if digits.len() <= scale {
        format!("{digits:0>width$}", width = scale + 1)
    } else {
        digits
    };
    let split = digits.len() - scale;
    format!("{sign}{}.{}", &digits[..split], &digits[split..])
}

fn finite_f32(v: f32) -> Option<Value> {
    serde_json::Number::from_f64(f64::from(v)).map(Value::Number)
}

fn finite_f64(v: f64) -> Option<Value> {
    serde_json::Number::from_f64(v).map(Value::Number)
}

#[cfg(test)]
mod tests {
    use super::{numeric_to_string, type_name};
    use tiberius::numeric::Numeric;
    use tiberius::ColumnType;

    /// The regression this function exists for: `tiberius`'s own `Display`
    /// renders these as `-18.-900000000`, `-18.-9` and `0.-5`.
    #[test]
    fn renders_negative_decimals_with_one_sign() {
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(-18_900_000_000, 9)),
            "-18.900000000"
        );
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(-1809, 2)),
            "-18.09"
        );
        assert_eq!(numeric_to_string(Numeric::new_with_scale(-5, 1)), "-0.5");
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(-1, 9)),
            "-0.000000001"
        );
    }

    #[test]
    fn keeps_scale_and_padding_on_positive_values() {
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(18_900_000_000, 9)),
            "18.900000000"
        );
        assert_eq!(numeric_to_string(Numeric::new_with_scale(1809, 2)), "18.09");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(5, 1)), "0.5");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(0, 4)), "0.0000");
    }

    /// A `decimal(18,0)` is an integer and must not grow a `.0` tail — that
    /// string is also what `first_i64` used to try (and fail) to parse.
    #[test]
    fn scale_zero_renders_as_an_integer() {
        assert_eq!(numeric_to_string(Numeric::new_with_scale(23, 0)), "23");
        assert_eq!(numeric_to_string(Numeric::new_with_scale(-23, 0)), "-23");
    }

    /// 38 digits of precision is the type's ceiling, and the point of routing
    /// these columns through text is that no `f64` step rounds them.
    #[test]
    fn survives_full_38_digit_precision() {
        let mantissa = 12_345_678_901_234_567_890_123_456_789_012_345_678i128;
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(mantissa, 10)),
            "1234567890123456789012345678.9012345678"
        );
        assert_eq!(
            numeric_to_string(Numeric::new_with_scale(-mantissa, 10)),
            "-1234567890123456789012345678.9012345678"
        );
    }

    #[test]
    fn maps_protocol_types_to_tsql_names() {
        // The nullable and fixed forms of one logical type must not surface as
        // two different names — a nullable `int` is still an `int`.
        assert_eq!(type_name(ColumnType::Int4), "int");
        assert_eq!(type_name(ColumnType::Intn), "int");
        assert_eq!(type_name(ColumnType::Bit), "bit");
        assert_eq!(type_name(ColumnType::Bitn), "bit");
        // `bit` must keep reporting as exactly "bit": the grid's BIT detection
        // is anchored (`/^bit\b/i`), so anything else silently loses the 0/1
        // editor.
        assert_eq!(type_name(ColumnType::Bitn), "bit");
        assert_eq!(type_name(ColumnType::Guid), "uniqueidentifier");
        assert_eq!(type_name(ColumnType::NVarchar), "nvarchar");
    }
}
