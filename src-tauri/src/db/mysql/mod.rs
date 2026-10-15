//! MySQL-specific logic. See [`crate::db::postgres`] for why this exists.

pub mod pulse;
pub mod schema;

/// True when `type_name` names a MySQL `BIT` column.
///
/// The test is `starts_with` on the trimmed, upper-cased name so `BIT(1)` and
/// `BIT(8)` both match. It ran in three places — `update_cell`'s frontend hint,
/// its catalog fallback, and `insert_row`'s per-value hint — each spelling out
/// `.trim().to_ascii_uppercase().starts_with("BIT")` inline.
pub fn is_bit_type(type_name: &str) -> bool {
    type_name.trim().to_ascii_uppercase().starts_with("BIT")
}

/// Wrap a bound placeholder so MySQL reads the literal as a number.
///
/// Cell values travel as text end-to-end (ADR #5) and drivers coerce them
/// server-side, which is wrong for `BIT`: binding the string `"1"` stores the
/// ASCII byte `0x31`, not the integer 1, so editing a BIT cell silently wrote
/// garbage. `CAST(? AS UNSIGNED)` forces the numeric reading, and
/// `CAST(NULL AS UNSIGNED)` is still `NULL`, so the set-NULL path is
/// unaffected. Only MySQL needs it — Postgres and SQLite cast a textual
/// literal to their bit/blob types correctly on their own, and SQL Server has
/// the same class of problem with a different answer
/// ([`crate::db::mssql::binary_convert`]).
pub fn bit_cast(placeholder: &str) -> String {
    format!("CAST({placeholder} AS UNSIGNED)")
}

/// Normalize a cell value for a MySQL `BIT` write.
///
/// `"true"`/`"false"` (case-insensitive) become `"1"`/`"0"` so [`bit_cast`]
/// receives a digit string: MySQL evaluates `CAST('true' AS UNSIGNED)` as 0,
/// which silently clears any bit the user set after the cell editor rendered
/// it as `true`. Anything else passes through, so `"1"`, `"0"` and `"255"` are
/// untouched.
pub fn normalize_bit_value(s: &str) -> String {
    match s.trim().to_lowercase().as_str() {
        "true" => "1".to_string(),
        "false" => "0".to_string(),
        other => other.to_string(),
    }
}
