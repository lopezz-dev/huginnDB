//! BSON ⇄ JSON conversion for the MongoDB driver.
//!
//! MongoDB documents carry BSON types that JSON has no representation for
//! (`ObjectId`, `Date`, `Decimal128`, `Long`, `Binary`, …). The rest of the
//! app speaks `serde_json::Value` end-to-end (see [`crate::commands::query::QueryResult`]),
//! so every value crossing the boundary goes through here.
//!
//! Two directions, two different goals:
//!
//! * [`bson_to_json`] — **display**. Renders the *relaxed*, human-readable form
//!   (an `ObjectId` becomes its 24-char hex string, a `Date` becomes an ISO
//!   string, a `Decimal128`/`Long` becomes a number or string). This is what the
//!   grid and the JSON viewer show. Nested documents/arrays stay structured
//!   (`Value::Object`/`Value::Array`) exactly like the existing SQL JSON columns,
//!   so the `CellPreview` panel can pretty-print them.
//! * [`json_to_bson`] — **round-trip**. Reconstructs proper BSON from JSON,
//!   honouring MongoDB Extended JSON tags (`{"$oid": …}`, `{"$date": …}`,
//!   `{"$numberLong": …}`, `{"$numberDecimal": …}`) that the shell parser emits
//!   for constructors like `ObjectId(...)` / `ISODate(...)`.
//!
//! Tradeoff (mirrors gotcha #17's content-over-type philosophy): because display
//! is lossy for type, the edit path leans on a `column_type` hint
//! ([`string_to_bson`]) the same way `update_cell`'s MySQL `BIT` `CAST` does
//! (gotcha #15). An `_id` that is a genuine 24-hex-char *string* is the one
//! ambiguous case on write — see [`id_to_bson`].

use mongodb::bson::{Bson, Decimal128, Document};
use serde_json::{Map, Number, Value};
use std::str::FromStr;

/// Convert a BSON value to its readable JSON form for display in the grid /
/// JSON viewer. Lossy by design: types that JSON lacks are rendered as the
/// string a user expects to read, not as Extended JSON.
pub fn bson_to_json(b: &Bson) -> Value {
    match b {
        Bson::Double(f) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s.clone()),
        Bson::Boolean(v) => Value::Bool(*v),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Int32(i) => Value::Number((*i).into()),
        Bson::Int64(i) => Value::Number((*i).into()),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => Value::String(
            dt.try_to_rfc3339_string()
                .unwrap_or_else(|_| dt.timestamp_millis().to_string()),
        ),
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::Array(a) => Value::Array(a.iter().map(bson_to_json).collect()),
        Bson::Document(d) => document_to_json(d),
        Bson::Binary(bin) => Value::String(format!(
            "Binary({:?}, {} bytes)",
            bin.subtype,
            bin.bytes.len()
        )),
        Bson::RegularExpression(re) => Value::String(format!("/{}/{}", re.pattern, re.options)),
        Bson::JavaScriptCode(c) => Value::String(c.clone()),
        Bson::JavaScriptCodeWithScope(c) => Value::String(c.code.clone()),
        Bson::Timestamp(ts) => Value::String(format!("Timestamp({}, {})", ts.time, ts.increment)),
        Bson::Symbol(s) => Value::String(s.clone()),
        Bson::MaxKey => Value::String("MaxKey".into()),
        Bson::MinKey => Value::String("MinKey".into()),
        Bson::DbPointer(_) => Value::String("DbPointer".into()),
    }
}

/// Convert a whole document to a JSON object, preserving key order.
pub fn document_to_json(d: &Document) -> Value {
    let mut map = Map::with_capacity(d.len());
    for (k, v) in d {
        map.insert(k.clone(), bson_to_json(v));
    }
    Value::Object(map)
}

/// Reconstruct BSON from JSON, honouring MongoDB Extended JSON tags. Used for
/// query arguments produced by the shell parser and for whole-document writes
/// (`insertOne`, `replaceOne`).
pub fn json_to_bson(v: &Value) -> Bson {
    match v {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => number_to_bson(n),
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(a) => Bson::Array(a.iter().map(json_to_bson).collect()),
        Value::Object(map) => object_to_bson(map),
    }
}

/// Map a JSON number to the narrowest BSON numeric type that holds it: integral
/// values that fit become `Int32`/`Int64`, everything else `Double`.
fn number_to_bson(n: &Number) -> Bson {
    if let Some(i) = n.as_i64() {
        if let Ok(i32v) = i32::try_from(i) {
            Bson::Int32(i32v)
        } else {
            Bson::Int64(i)
        }
    } else {
        Bson::Double(n.as_f64().unwrap_or(0.0))
    }
}

/// Convert a JSON object to BSON, intercepting Extended JSON tags first.
fn object_to_bson(map: &Map<String, Value>) -> Bson {
    // Extended JSON: single-key wrappers the shell parser emits for BSON
    // constructors. Anything that doesn't match falls through to a plain doc.
    if map.len() == 1 {
        let (key, val) = map.iter().next().unwrap();
        match key.as_str() {
            "$oid" => {
                if let Some(s) = val.as_str() {
                    if let Ok(oid) = mongodb::bson::oid::ObjectId::from_str(s) {
                        return Bson::ObjectId(oid);
                    }
                }
            }
            "$date" => return ext_date_to_bson(val),
            "$numberLong" => {
                if let Some(i) = val.as_str().and_then(|s| s.parse::<i64>().ok()) {
                    return Bson::Int64(i);
                }
                if let Some(i) = val.as_i64() {
                    return Bson::Int64(i);
                }
            }
            "$numberInt" => {
                if let Some(i) = val.as_str().and_then(|s| s.parse::<i32>().ok()) {
                    return Bson::Int32(i);
                }
            }
            "$numberDouble" => {
                if let Some(f) = val.as_str().and_then(|s| s.parse::<f64>().ok()) {
                    return Bson::Double(f);
                }
            }
            "$numberDecimal" => {
                if let Some(d) = val.as_str().and_then(|s| Decimal128::from_str(s).ok()) {
                    return Bson::Decimal128(d);
                }
            }
            _ => {}
        }
    }
    let mut doc = Document::new();
    for (k, v) in map {
        doc.insert(k.clone(), json_to_bson(v));
    }
    Bson::Document(doc)
}

/// Decode the value side of an `{"$date": …}` Extended JSON wrapper. Accepts
/// either an RFC3339 string or epoch-millis (number or `{"$numberLong": …}`).
fn ext_date_to_bson(val: &Value) -> Bson {
    use mongodb::bson::DateTime;
    match val {
        Value::String(s) => DateTime::parse_rfc3339_str(s)
            .map(Bson::DateTime)
            .unwrap_or(Bson::Null),
        Value::Number(n) => n
            .as_i64()
            .map(|ms| Bson::DateTime(DateTime::from_millis(ms)))
            .unwrap_or(Bson::Null),
        Value::Object(m) => m
            .get("$numberLong")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .map(|ms| Bson::DateTime(DateTime::from_millis(ms)))
            .unwrap_or(Bson::Null),
        _ => Bson::Null,
    }
}

/// Coerce the text a cell editor produced into BSON, using the field's inferred
/// BSON type name (from [`super::schema::infer_columns`]) as a hint. This is the
/// write-side analogue of the lossy [`bson_to_json`] display: a `Date` or `Long`
/// field must not silently degrade to a string just because the editor only
/// emits text. `None` value → `Bson::Null`.
pub fn string_to_bson(value: Option<&str>, type_hint: Option<&str>) -> Bson {
    let Some(s) = value else {
        return Bson::Null;
    };
    let hint = type_hint.unwrap_or("").to_ascii_lowercase();
    match hint.as_str() {
        "objectid" => mongodb::bson::oid::ObjectId::from_str(s.trim())
            .map(Bson::ObjectId)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "int" | "int32" | "integer" => s
            .trim()
            .parse::<i32>()
            .map(Bson::Int32)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "long" | "int64" => s
            .trim()
            .parse::<i64>()
            .map(Bson::Int64)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "double" | "number" => s
            .trim()
            .parse::<f64>()
            .map(Bson::Double)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "decimal128" | "decimal" => Decimal128::from_str(s.trim())
            .map(Bson::Decimal128)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "bool" | "boolean" => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Bson::Boolean(true),
            "false" | "0" => Bson::Boolean(false),
            _ => Bson::String(s.to_string()),
        },
        "date" | "datetime" => mongodb::bson::DateTime::parse_rfc3339_str(s.trim())
            .map(Bson::DateTime)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "null" => Bson::Null,
        "undefined" => Bson::Undefined,
        "minkey" => Bson::MinKey,
        "maxkey" => Bson::MaxKey,
        "javascript" | "code" => {
            try_extjson(s).unwrap_or_else(|| Bson::JavaScriptCode(s.to_string()))
        }
        "symbol" => try_extjson(s).unwrap_or_else(|| Bson::Symbol(s.to_string())),
        // The four types below have no natural plain-text spelling, so the
        // canonical Extended JSON form is accepted first (that is what the
        // document list view's type picker seeds the editor with) and a
        // friendlier shorthand second: raw base64 for `binary`, `/pat/flags`
        // for `regex`, `t,i` or `Timestamp(t, i)` for `timestamp`, and the
        // bare hyphenated form for `uuid`.
        "binary" | "binarydata" => try_extjson(s).unwrap_or_else(|| {
            extjson(serde_json::json!({
                "$binary": { "base64": s.trim(), "subType": "00" }
            }))
            .unwrap_or_else(|| Bson::String(s.to_string()))
        }),
        "uuid" => try_extjson(s).unwrap_or_else(|| {
            extjson(serde_json::json!({ "$uuid": s.trim() }))
                .unwrap_or_else(|| Bson::String(s.to_string()))
        }),
        "regex" | "bsonregexp" => try_extjson(s)
            .unwrap_or_else(|| shorthand_regex(s).unwrap_or(Bson::String(s.to_string()))),
        "timestamp" => try_extjson(s)
            .unwrap_or_else(|| shorthand_timestamp(s).unwrap_or(Bson::String(s.to_string()))),
        // "document" / "array" / unknown: try to parse the text as JSON so the
        // user can paste a nested value; fall back to a plain string.
        "document" | "object" | "array" => serde_json::from_str::<Value>(s)
            .map(|v| json_to_bson(&v))
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        _ => Bson::String(s.to_string()),
    }
}

/// Parse `s` as canonical/relaxed Extended JSON, but only when it actually
/// *is* one of the `$`-tagged wrappers (`{"$binary": …}`, `{"$timestamp": …}`,
/// …). A plain JSON string/number/object is rejected so this can be used as a
/// first attempt without swallowing values meant to be taken literally.
fn try_extjson(s: &str) -> Option<Bson> {
    let v: Value = serde_json::from_str(s.trim()).ok()?;
    let obj = v.as_object()?;
    if !obj.keys().any(|k| k.starts_with('$')) {
        return None;
    }
    extjson(v)
}

/// `Bson::try_from` over an Extended JSON value, discarding the parse error —
/// callers fall back to a plain string, matching every other arm of
/// [`string_to_bson`].
fn extjson(v: Value) -> Option<Bson> {
    Bson::try_from(v).ok()
}

/// `/pattern/flags` → `Bson::RegularExpression`, the same spelling
/// [`bson_to_json`] renders a regex as (so a displayed value round-trips).
fn shorthand_regex(s: &str) -> Option<Bson> {
    let s = s.trim();
    let body = s.strip_prefix('/')?;
    let close = body.rfind('/')?;
    extjson(serde_json::json!({
        "$regularExpression": { "pattern": &body[..close], "options": &body[close + 1..] }
    }))
}

/// `Timestamp(t, i)` / `t,i` / a bare seconds value → `Bson::Timestamp`. The
/// first spelling is what [`bson_to_json`] displays, so a displayed value
/// round-trips.
fn shorthand_timestamp(s: &str) -> Option<Bson> {
    let inner = s
        .trim()
        .trim_start_matches("Timestamp")
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')');
    let mut parts = inner.split(',').map(|p| p.trim());
    let time: u32 = parts.next()?.parse().ok()?;
    let increment: u32 = match parts.next() {
        Some(p) => p.parse().ok()?,
        None => 0,
    };
    extjson(serde_json::json!({
        "$timestamp": { "t": time, "i": increment }
    }))
}

/// Reconstruct a primary-key (`_id`) value as BSON from its JSON display form.
///
/// `_id` is overwhelmingly an `ObjectId`, which [`bson_to_json`] rendered as a
/// 24-char hex string, so a string that parses as an `ObjectId` is treated as
/// one. Otherwise the value round-trips through [`json_to_bson`] (numeric /
/// string / compound `_id`). The one ambiguous case — a genuine `_id` that is a
/// 24-hex-character *string* — is documented in the module header and deferred
/// to the roadmap (typed `_id` round-trip).
pub fn id_to_bson(value: &Value) -> Bson {
    if let Value::String(s) = value {
        if s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
            if let Ok(oid) = mongodb::bson::oid::ObjectId::from_str(s) {
                return Bson::ObjectId(oid);
            }
        }
    }
    json_to_bson(value)
}

/// Short, lowercase BSON type name used by the schema explorer's column list
/// (the MongoDB analogue of a SQL `data_type`).
pub fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "document",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Null | Bson::Undefined => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Decimal128(_) => "decimal128",
        Bson::Symbol(_) => "symbol",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Mirror a BSON value's *type* structure as JSON, so the grid's document list
/// view can label every field — nested ones included — with the type it really
/// has on the server.
///
/// This exists because [`bson_to_json`] is deliberately lossy (gotcha-style
/// "display beats fidelity"): an `Int64`, an `Int32` and a `Double` that all
/// hold `301353073` arrive at the frontend as the same JSON number, and an
/// `ObjectId`, a `Date` and a `Decimal128` all arrive as plain strings. That is
/// fine for *reading*, but the list view also *writes*: it sends the edited
/// field back through [`string_to_bson`] with a type hint, and guessing that
/// hint from the JSON shape would silently rewrite a `Long` as an `Int` (both
/// look like a small JSON number) the first time a user edits an unrelated
/// character of the value. Shipping the real types alongside the values is the
/// only way to keep an edit type-preserving by default.
///
/// Shape: a scalar becomes `Value::String(<type name>)`; a document becomes an
/// object with the same keys, each mapped to its own tree; an array becomes an
/// array of trees. So "is this node a container" is answered by the tree node's
/// own JSON kind, and no extra tagging is needed. Type names are the same
/// lowercase vocabulary [`bson_type_name`] already uses for column types.
pub fn bson_type_tree(b: &Bson) -> Value {
    match b {
        Bson::Document(d) => Value::Object(
            d.iter()
                .map(|(k, v)| (k.clone(), bson_type_tree(v)))
                .collect(),
        ),
        Bson::Array(a) => Value::Array(a.iter().map(bson_type_tree).collect()),
        // `bson_type_name` folds `Undefined` into `"null"` (they render
        // identically in the grid); the type picker distinguishes them, so keep
        // them apart here.
        Bson::Undefined => Value::String("undefined".to_string()),
        other => Value::String(bson_type_name(other).to_string()),
    }
}

// ---------------------------------------------------------------------------
// BSON → editable mongosh source
// ---------------------------------------------------------------------------

/// Render a BSON value as the **relaxed mongosh source** a user edits — the
/// exact grammar [`super::shell::parse_relaxed_value`] reads back.
///
/// This is the third direction the module header's two-way table didn't need
/// until the aggregation editor existed. Neither existing converter works for
/// it: [`bson_to_json`] is display-lossy (an `ObjectId` in a `$match` would
/// come back as a bare string and stop matching anything), and canonical
/// Extended JSON round-trips perfectly but is unreadable as source and is *not*
/// what the server interprets when the pipeline is handed to `aggregate` — a
/// literal `{"$oid": …}` in a pipeline is just a document. So typed values are
/// written as the constructors the parser understands (`ObjectId("…")`,
/// `ISODate("…")`, `NumberLong(…)`, `NumberDecimal("…")`), which both read well
/// and parse back to the same BSON.
///
/// `Int64` is always written as `NumberLong(…)` even when it would fit in an
/// `i32`: a bare integer literal parses back as `Int32`, and a `$match` against
/// a `Long` field written as an `Int` silently stops matching — the same
/// invisible-in-testing, permanent-in-data failure ADR #29 describes.
///
/// **Lossy fallback:** types with no constructor in the grammar (`Binary`,
/// `Timestamp`, `MinKey`/`MaxKey`, regexes outside a `$regex` position, …) are
/// written as their Extended JSON document form. They read correctly and the
/// server accepts the common `{$regex: …}` case, but re-saving a pipeline that
/// contained one rewrites it as a plain document. Pipelines carry filters and
/// field paths rather than stored data, so this is rare in practice; the
/// alternative — refusing to open such a view at all — is strictly worse.
pub fn bson_to_shell_text(b: &Bson) -> String {
    let mut out = String::new();
    write_shell(b, 0, &mut out);
    out
}

/// Render a pipeline (an array of stage documents) as editable source.
pub fn pipeline_to_shell_text(stages: &[Document]) -> String {
    let array = Bson::Array(stages.iter().cloned().map(Bson::Document).collect());
    bson_to_shell_text(&array)
}

fn indent(depth: usize, out: &mut String) {
    out.push_str(&"  ".repeat(depth));
}

fn write_shell(b: &Bson, depth: usize, out: &mut String) {
    match b {
        Bson::Document(d) if d.is_empty() => out.push_str("{}"),
        Bson::Document(d) => {
            out.push_str("{\n");
            let last = d.len() - 1;
            for (i, (k, v)) in d.iter().enumerate() {
                indent(depth + 1, out);
                out.push_str(&shell_key(k));
                out.push_str(": ");
                write_shell(v, depth + 1, out);
                if i != last {
                    out.push(',');
                }
                out.push('\n');
            }
            indent(depth, out);
            out.push('}');
        }
        Bson::Array(a) if a.is_empty() => out.push_str("[]"),
        Bson::Array(a) => {
            out.push_str("[\n");
            let last = a.len() - 1;
            for (i, v) in a.iter().enumerate() {
                indent(depth + 1, out);
                write_shell(v, depth + 1, out);
                if i != last {
                    out.push(',');
                }
                out.push('\n');
            }
            indent(depth, out);
            out.push(']');
        }
        Bson::String(s) => out.push_str(&quote_shell_string(s)),
        Bson::Boolean(v) => out.push_str(if *v { "true" } else { "false" }),
        Bson::Null | Bson::Undefined => out.push_str("null"),
        Bson::Int32(i) => out.push_str(&i.to_string()),
        Bson::Int64(i) => out.push_str(&format!("NumberLong({i})")),
        Bson::Double(f) => {
            // A double that is integral must keep a decimal point, or it parses
            // back as an Int32 (the parser only produces a Double when it sees
            // one). Non-finite values have no literal at all — write null.
            if !f.is_finite() {
                out.push_str("null");
            } else if f.fract() == 0.0 && f.abs() < 1e15 {
                out.push_str(&format!("{f:.1}"));
            } else {
                out.push_str(&f.to_string());
            }
        }
        Bson::ObjectId(oid) => out.push_str(&format!("ObjectId(\"{}\")", oid.to_hex())),
        Bson::DateTime(dt) => match dt.try_to_rfc3339_string() {
            Ok(s) => out.push_str(&format!("ISODate(\"{s}\")")),
            // Out of the range RFC3339 can express — keep the epoch millis,
            // which at least stays a date on the server.
            Err(_) => out.push_str(&format!(
                "{{ \"$date\": {{ \"$numberLong\": \"{}\" }} }}",
                dt.timestamp_millis()
            )),
        },
        Bson::Decimal128(d) => out.push_str(&format!("NumberDecimal(\"{d}\")")),
        // No constructor in the grammar — fall back to Extended JSON (see the
        // doc comment's "lossy fallback" note).
        other => {
            let ext = other.clone().into_relaxed_extjson();
            match serde_json::to_string(&ext) {
                Ok(s) => out.push_str(&s),
                Err(_) => out.push_str("null"),
            }
        }
    }
}

/// A key is written bare when it is a safe identifier (including the leading
/// `$` of an operator), quoted otherwise — dotted field paths like
/// `"customData.format"` must keep their quotes.
fn shell_key(key: &str) -> String {
    let mut chars = key.chars();
    let valid = match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        }
        _ => false,
    };
    if valid {
        key.to_string()
    } else {
        quote_shell_string(key)
    }
}

fn quote_shell_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Construct a BSON binary value.
///
/// `cfg(test)` rather than `allow(dead_code)`: it has only ever had a test
/// caller, and the allowance would keep it compiling silently if that caller
/// went away too.
#[cfg(test)]
pub(crate) fn binary(bytes: Vec<u8>) -> Bson {
    use mongodb::bson::{spec::BinarySubtype, Binary};
    Bson::Binary(Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;

    #[test]
    fn objectid_renders_as_hex_and_round_trips() {
        let oid = ObjectId::from_str("507f1f77bcf86cd799439011").unwrap();
        let json = bson_to_json(&Bson::ObjectId(oid));
        assert_eq!(json, Value::String("507f1f77bcf86cd799439011".into()));
        // id_to_bson recognises the hex string as an ObjectId again.
        assert_eq!(id_to_bson(&json), Bson::ObjectId(oid));
    }

    #[test]
    fn numbers_pick_narrowest_type() {
        assert_eq!(json_to_bson(&serde_json::json!(5)), Bson::Int32(5));
        assert_eq!(
            json_to_bson(&serde_json::json!(5_000_000_000i64)),
            Bson::Int64(5_000_000_000)
        );
        assert!(matches!(
            json_to_bson(&serde_json::json!(1.5)),
            Bson::Double(_)
        ));
    }

    #[test]
    fn extended_json_oid_tag_becomes_objectid() {
        let v = serde_json::json!({"$oid": "507f1f77bcf86cd799439011"});
        assert!(matches!(json_to_bson(&v), Bson::ObjectId(_)));
    }

    #[test]
    fn string_to_bson_honours_type_hint() {
        assert_eq!(string_to_bson(Some("42"), Some("int")), Bson::Int32(42));
        assert_eq!(string_to_bson(Some("42"), Some("long")), Bson::Int64(42));
        assert_eq!(
            string_to_bson(Some("42"), Some("string")),
            Bson::String("42".into())
        );
        assert_eq!(string_to_bson(None, Some("int")), Bson::Null);
    }

    #[test]
    fn string_to_bson_builds_the_exotic_types_the_list_view_offers() {
        assert_eq!(
            string_to_bson(Some("x"), Some("undefined")),
            Bson::Undefined
        );
        assert_eq!(string_to_bson(Some(""), Some("minKey")), Bson::MinKey);
        assert_eq!(string_to_bson(Some(""), Some("maxKey")), Bson::MaxKey);
        assert_eq!(
            string_to_bson(Some("a > b"), Some("javascript")),
            Bson::JavaScriptCode("a > b".into())
        );
        assert_eq!(
            string_to_bson(Some("sym"), Some("symbol")),
            Bson::Symbol("sym".into())
        );
        // Base64 shorthand and the canonical Extended JSON form agree.
        let expected = binary(vec![1, 2, 3]);
        assert_eq!(string_to_bson(Some("AQID"), Some("binary")), expected);
        assert_eq!(
            string_to_bson(
                Some(r#"{"$binary":{"base64":"AQID","subType":"00"}}"#),
                Some("binary")
            ),
            expected
        );
        assert!(matches!(
            string_to_bson(Some("6c4dd3a4-1c9d-4f5a-9c9f-1d0f6c4dd3a4"), Some("uuid")),
            Bson::Binary(_)
        ));
    }

    #[test]
    fn timestamp_and_regex_round_trip_through_their_displayed_form() {
        // What `bson_to_json` renders is what `string_to_bson` accepts back —
        // that is why neither type is treated as opaque by the list view.
        let ts = Bson::Timestamp(mongodb::bson::Timestamp {
            time: 1774861099,
            increment: 2,
        });
        let shown = bson_to_json(&ts);
        assert_eq!(
            string_to_bson(shown.as_str(), Some("timestamp")),
            ts,
            "displayed timestamp must parse back"
        );

        // `/pattern/flags` is exactly what `bson_to_json` prints for a regex.
        let re = string_to_bson(Some("/^ab.*/i"), Some("regex"));
        assert!(matches!(re, Bson::RegularExpression(_)), "{re:?}");
        let shown = bson_to_json(&re);
        assert_eq!(shown, Value::String("/^ab.*/i".into()));
        assert_eq!(string_to_bson(shown.as_str(), Some("regex")), re);
    }

    #[test]
    fn type_tree_mirrors_the_value_structure() {
        let mut inner = Document::new();
        inner.insert("n", Bson::Int64(7));
        inner.insert("s", Bson::String("x".into()));
        let mut doc = Document::new();
        doc.insert("nested", Bson::Document(inner));
        doc.insert("tags", Bson::Array(vec![Bson::Int32(1), Bson::Null]));
        doc.insert(
            "when",
            Bson::DateTime(mongodb::bson::DateTime::from_millis(0)),
        );

        assert_eq!(
            bson_type_tree(&Bson::Document(doc)),
            serde_json::json!({
                "nested": { "n": "long", "s": "string" },
                "tags": ["int", "null"],
                "when": "date",
            })
        );
    }

    #[test]
    fn type_tree_keeps_undefined_apart_from_null() {
        // `bson_type_name` folds the two together (they display identically);
        // the list view's type picker has to tell them apart.
        assert_eq!(bson_type_name(&Bson::Undefined), "null");
        assert_eq!(
            bson_type_tree(&Bson::Undefined),
            Value::String("undefined".into())
        );
    }

    #[test]
    fn nested_documents_stay_structured() {
        let mut inner = Document::new();
        inner.insert("a", Bson::Int32(1));
        let json = bson_to_json(&Bson::Document(inner));
        assert_eq!(json, serde_json::json!({"a": 1}));
    }
}
