//! Draft a JSON Schema from sample values.
//!
//! This is the onboarding path for the whole feature: "write a JSON Schema by
//! hand" has an adoption rate near zero, so the badge in the cell editor offers
//! "create from this value" and lands the user on a working draft they then
//! refine.
//!
//! # Why this lives in Rust
//!
//! It is pure, total, and combinatorial (type unification, `required` as an
//! intersection, the enum threshold, determinism, depth limits) — exactly the
//! shape of code this repo already tests with `cargo test` (`db/ddl.rs`,
//! `db/sql.rs`, `tab_state.rs`), and there is no frontend test runner at all.
//! Its failure mode is also the one ADR #29 names by its proper name:
//! *invisible in testing, permanent in the data*. A `required` that quietly
//! became a union instead of an intersection, or an unordered key emission that
//! makes every diff unreadable, is not something anyone catches by hand.
//!
//! The IPC cost is nil: this runs once, when the user clicks a button.
//!
//! # Determinism
//!
//! Every map is walked through a sorted key list and the output object is built
//! in a fixed keyword order, so `serde_json::to_string_pretty` is byte-stable
//! for the same input. That is what makes a re-generated schema produce a
//! readable diff instead of a whole-file churn. Sorting is by Rust's byte
//! ordering on `&str`, never a locale-aware collation.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The draft this module targets.
///
/// Emitted **always**, and it is load-bearing rather than decorative: Monaco's
/// JSON language service falls back to 2020-12 semantics when a schema carries
/// no `$schema`, which changes how `items`-as-array, `exclusiveMinimum` and
/// `$defs` behave. Stating the draft is what makes the generated schema mean
/// what it looks like it means.
pub const DRAFT_07: &str = "http://json-schema.org/draft-07/schema#";

/// Knobs for [`infer_schema`]. All defaults are deliberately permissive: a
/// schema drafted from three rows that then rejects the fourth legitimate value
/// is worse than no schema at all.
#[derive(Debug, Clone, Copy)]
pub struct InferOptions {
    /// Stop after this many samples.
    pub max_samples: usize,
    /// Emit `{}` (anything goes) below this nesting depth.
    pub max_depth: usize,
    /// Largest number of distinct scalars still worth emitting as an `enum`.
    pub enum_threshold: usize,
    /// Infer `format` for strings that all match one shape.
    pub detect_formats: bool,
    /// Emit `additionalProperties: false` on objects.
    pub closed_objects: bool,
}

impl Default for InferOptions {
    fn default() -> Self {
        Self {
            max_samples: 200,
            max_depth: 12,
            enum_threshold: 12,
            detect_formats: true,
            closed_objects: false,
        }
    }
}

/// What the caller may want to warn about.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferStats {
    /// Samples actually inspected.
    pub samples: usize,
    /// `true` when nesting was cut off at [`InferOptions::max_depth`].
    pub truncated_depth: bool,
    /// `true` when an array was longer than the per-array sample cap.
    pub truncated_arrays: bool,
    /// Dotted paths where a field held structurally different types, and so had
    /// to be emitted as `anyOf`. Worth surfacing: it usually means the samples
    /// straddled a format change.
    pub mixed_paths: Vec<String>,
}

/// The result of a draft.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferResult {
    /// The schema, pretty-printed and ready to drop into an editor.
    pub body: String,
    pub stats: InferStats,
}

/// Per-array element sampling cap. An array of 50 000 log lines does not need
/// 50 000 unifications to reveal that its elements are objects of one shape.
const MAX_ARRAY_SAMPLES: usize = 50;

/// Accumulated evidence about one slot (the document root, an object property,
/// or "the elements of this array").
#[derive(Debug, Default)]
struct Acc {
    nulls: usize,
    bools: usize,
    ints: usize,
    floats: usize,
    strings: usize,
    /// How many object values landed here — the denominator for `required`.
    objects: usize,
    arrays: usize,
    /// How many of the `objects` samples carried each key.
    presence: BTreeMap<String, usize>,
    props: BTreeMap<String, Acc>,
    /// One accumulator unifying the elements of *every* array seen here.
    items: Option<Box<Acc>>,
    /// Distinct scalar values, capped at `enum_threshold + 1` so overflow is
    /// detectable without holding the whole domain.
    scalars: BTreeSet<String>,
    scalar_count: usize,
    scalar_overflow: bool,
}

impl Acc {
    /// How many scalar (non-object, non-array, non-null) samples landed here.
    fn scalar_samples(&self) -> usize {
        self.bools + self.ints + self.floats + self.strings
    }

    /// Did anything structural land here?
    fn structural(&self) -> bool {
        self.objects > 0 || self.arrays > 0
    }

    /// Distinct JSON type names observed, in a stable order.
    fn type_names(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.arrays > 0 {
            v.push("array");
        }
        if self.bools > 0 {
            v.push("boolean");
        }
        if self.ints > 0 && self.floats == 0 {
            v.push("integer");
        }
        if self.floats > 0 {
            v.push("number");
        }
        if self.nulls > 0 {
            v.push("null");
        }
        if self.objects > 0 {
            v.push("object");
        }
        if self.strings > 0 {
            v.push("string");
        }
        v
    }
}

/// Fold one value into an accumulator.
fn accumulate(acc: &mut Acc, value: &Value, stats: &mut InferStats) {
    match value {
        Value::Null => acc.nulls += 1,
        Value::Bool(b) => {
            acc.bools += 1;
            note_scalar(acc, b.to_string());
        }
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                acc.ints += 1;
            } else {
                acc.floats += 1;
            }
            note_scalar(acc, n.to_string());
        }
        Value::String(s) => {
            acc.strings += 1;
            note_scalar(acc, s.clone());
        }
        Value::Object(map) => {
            acc.objects += 1;
            for (k, v) in map {
                *acc.presence.entry(k.clone()).or_insert(0) += 1;
                let child = acc.props.entry(k.clone()).or_default();
                accumulate(child, v, stats);
            }
        }
        Value::Array(items) => {
            acc.arrays += 1;
            if items.len() > MAX_ARRAY_SAMPLES {
                stats.truncated_arrays = true;
            }
            let child = acc.items.get_or_insert_with(Box::default);
            for v in items.iter().take(MAX_ARRAY_SAMPLES) {
                accumulate(child, v, stats);
            }
        }
    }
}

/// Record a distinct scalar, giving up once past the cap.
fn note_scalar(acc: &mut Acc, repr: String) {
    acc.scalar_count += 1;
    if acc.scalar_overflow {
        return;
    }
    acc.scalars.insert(repr);
    // The cap is checked against a generous ceiling here and re-checked against
    // the real threshold at emit time, so one `Acc` can serve any threshold.
    if acc.scalars.len() > 64 {
        acc.scalar_overflow = true;
        acc.scalars.clear();
    }
}

/// Emit a subschema from accumulated evidence.
///
/// Keys are inserted in a fixed order (`type`, `format`, `enum`, `properties`,
/// `required`, `items`, `additionalProperties`, `anyOf`) so the pretty-printed
/// output is byte-stable. `serde_json::Map` is a `BTreeMap` in this tree, which
/// would sort them anyway — the explicit order is documentation, and insurance
/// against anyone ever turning `preserve_order` on.
fn emit(acc: &Acc, depth: usize, path: &str, opts: &InferOptions, stats: &mut InferStats) -> Value {
    if depth > opts.max_depth {
        stats.truncated_depth = true;
        return json!({});
    }

    // Structural mixing (object and/or array alongside something else) cannot
    // be expressed with a `type` array without losing `properties`/`items`, so
    // it becomes `anyOf` — one branch per observed structure.
    let mixed = acc.structural() && (acc.type_names().len() > 1);
    if mixed {
        if !path.is_empty() {
            stats.mixed_paths.push(path.to_string());
        }
        let mut branches: Vec<Value> = Vec::new();
        if acc.objects > 0 {
            branches.push(emit_object(acc, depth, path, opts, stats));
        }
        if acc.arrays > 0 {
            branches.push(emit_array(acc, depth, path, opts, stats));
        }
        let scalars = acc
            .type_names()
            .into_iter()
            .filter(|t| *t != "object" && *t != "array")
            .collect::<Vec<_>>();
        if !scalars.is_empty() {
            let mut m = Map::new();
            m.insert(
                "type".into(),
                if scalars.len() == 1 {
                    Value::String(scalars[0].into())
                } else {
                    Value::Array(scalars.iter().map(|t| Value::String((*t).into())).collect())
                },
            );
            branches.push(Value::Object(m));
        }
        let mut out = Map::new();
        out.insert("anyOf".into(), Value::Array(branches));
        return Value::Object(out);
    }

    if acc.objects > 0 {
        return emit_object(acc, depth, path, opts, stats);
    }
    if acc.arrays > 0 {
        return emit_array(acc, depth, path, opts, stats);
    }
    emit_scalar(acc, opts)
}

fn emit_object(
    acc: &Acc,
    depth: usize,
    path: &str,
    opts: &InferOptions,
    stats: &mut InferStats,
) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), Value::String("object".into()));

    if !acc.props.is_empty() {
        let mut props = Map::new();
        // `BTreeMap` iteration is already sorted, which is the determinism the
        // module doc promises.
        for (key, child) in &acc.props {
            let child_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            props.insert(
                key.clone(),
                emit(child, depth + 1, &child_path, opts, stats),
            );
        }
        out.insert("properties".into(), Value::Object(props));

        // `required` is an INTERSECTION: only keys present in *every* object
        // sample. A union would produce a schema that rejects the very rows it
        // was drafted from.
        let required: Vec<Value> = acc
            .presence
            .iter()
            .filter(|(_, seen)| **seen == acc.objects)
            .map(|(k, _)| Value::String(k.clone()))
            .collect();
        if !required.is_empty() {
            out.insert("required".into(), Value::Array(required));
        }
    }

    if opts.closed_objects {
        out.insert("additionalProperties".into(), Value::Bool(false));
    }
    Value::Object(out)
}

fn emit_array(
    acc: &Acc,
    depth: usize,
    path: &str,
    opts: &InferOptions,
    stats: &mut InferStats,
) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), Value::String("array".into()));
    // Only when elements were actually seen. An always-empty array gets no
    // `items` at all rather than `items: {}` — which would read as a deliberate
    // "anything" instead of "we never saw one".
    if let Some(items) = acc.items.as_ref() {
        if items.nulls + items.scalar_samples() + items.objects + items.arrays > 0 {
            let child_path = if path.is_empty() {
                "[]".to_string()
            } else {
                format!("{path}[]")
            };
            out.insert(
                "items".into(),
                emit(items, depth + 1, &child_path, opts, stats),
            );
        }
    }
    Value::Object(out)
}

fn emit_scalar(acc: &Acc, opts: &InferOptions) -> Value {
    let mut out = Map::new();
    let types = acc.type_names();

    if types.is_empty() {
        // Nothing was ever observed here.
        return Value::Object(out);
    }
    out.insert(
        "type".into(),
        if types.len() == 1 {
            Value::String(types[0].into())
        } else {
            Value::Array(types.iter().map(|t| Value::String((*t).into())).collect())
        },
    );

    // `format` only when every string sample agrees and there were at least two
    // of them. The whitelist is short on purpose: `uri`, `hostname` and `ipv4`
    // are false-positive magnets and add little description.
    if opts.detect_formats && acc.strings >= 2 && acc.strings == acc.scalar_samples() {
        if let Some(fmt) = common_format(&acc.scalars) {
            out.insert("format".into(), Value::String(fmt.into()));
        }
    }

    // `enum` needs repetition to be evidence rather than coincidence: three
    // distinct values out of three samples is not a closed domain, it is a
    // sample size of three.
    let distinct = acc.scalars.len();
    if !acc.scalar_overflow
        && !acc.structural()
        && acc.nulls == 0
        && acc.bools == 0
        && distinct > 0
        && distinct <= opts.enum_threshold
        && distinct < acc.scalar_count
    {
        let values: Vec<Value> = acc
            .scalars
            .iter()
            .map(|s| {
                if acc.strings > 0 {
                    Value::String(s.clone())
                } else {
                    serde_json::from_str(s).unwrap_or_else(|_| Value::String(s.clone()))
                }
            })
            .collect();
        out.insert("enum".into(), Value::Array(values));
    }

    Value::Object(out)
}

/// The one `format` every sample matches, if any.
fn common_format(values: &BTreeSet<String>) -> Option<&'static str> {
    if values.is_empty() {
        return None;
    }
    for (name, test) in [
        ("date-time", looks_like_date_time as fn(&str) -> bool),
        ("date", looks_like_date),
        ("uuid", looks_like_uuid),
        ("email", looks_like_email),
    ] {
        if values.iter().all(|v| test(v)) {
            return Some(name);
        }
    }
    None
}

fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..].iter().all(u8::is_ascii_digit)
}

fn looks_like_date_time(s: &str) -> bool {
    // `YYYY-MM-DDT…` plus a zone marker. Deliberately shallow: this is an
    // annotation, and a stricter parser would need a date library for no gain.
    s.len() >= 20
        && looks_like_date(&s[..10.min(s.len())])
        && matches!(s.as_bytes().get(10), Some(b'T') | Some(b't'))
        && (s.ends_with('Z') || s.ends_with('z') || s[11..].contains('+') || s[11..].contains('-'))
}

fn looks_like_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}

fn looks_like_email(s: &str) -> bool {
    match s.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains('@')
        }
        None => false,
    }
}

/// Draft a schema from `values`.
///
/// `values` are already-parsed JSON documents — the caller decides where they
/// came from (one cell, or the column across the page currently loaded).
pub fn infer_schema(values: &[Value], opts: InferOptions) -> InferResult {
    let mut stats = InferStats::default();
    let mut acc = Acc::default();

    for v in values.iter().take(opts.max_samples) {
        accumulate(&mut acc, v, &mut stats);
        stats.samples += 1;
    }

    let mut schema = match emit(&acc, 0, "", &opts, &mut stats) {
        Value::Object(m) => m,
        other => {
            let mut m = Map::new();
            m.insert("allOf".into(), Value::Array(vec![other]));
            m
        }
    };
    schema.insert("$schema".into(), Value::String(DRAFT_07.into()));
    stats.mixed_paths.sort();
    stats.mixed_paths.dedup();

    InferResult {
        body: serde_json::to_string_pretty(&Value::Object(schema))
            .unwrap_or_else(|_| "{}".to_string()),
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(raw: &[&str]) -> Value {
        let values: Vec<Value> = raw
            .iter()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        let out = infer_schema(&values, InferOptions::default());
        serde_json::from_str(&out.body).unwrap()
    }

    #[test]
    fn always_states_the_draft() {
        // Load-bearing: without `$schema` Monaco validates with 2020-12
        // semantics instead of draft-07.
        assert_eq!(draft(&["{}"])["$schema"], json!(DRAFT_07));
    }

    #[test]
    fn an_object_gets_properties_and_required() {
        let s = draft(&[r#"{"a":1,"b":"x"}"#]);
        assert_eq!(s["type"], json!("object"));
        assert_eq!(s["properties"]["a"]["type"], json!("integer"));
        assert_eq!(s["properties"]["b"]["type"], json!("string"));
        assert_eq!(s["required"], json!(["a", "b"]));
    }

    #[test]
    fn required_is_an_intersection_not_a_union() {
        // `b` is missing from one sample, so requiring it would reject a row
        // the schema was drafted from.
        let s = draft(&[r#"{"a":1,"b":2}"#, r#"{"a":3}"#]);
        assert_eq!(s["required"], json!(["a"]));
        assert!(s["properties"].get("b").is_some());
    }

    #[test]
    fn an_empty_object_gets_no_properties_or_required() {
        let s = draft(&["{}"]);
        assert_eq!(s["type"], json!("object"));
        assert!(s.get("properties").is_none());
        assert!(s.get("required").is_none());
    }

    #[test]
    fn additional_properties_is_left_open_by_default() {
        let s = draft(&[r#"{"a":1}"#]);
        assert!(s.get("additionalProperties").is_none());
    }

    #[test]
    fn a_closed_object_is_opt_in() {
        let values = vec![serde_json::json!({"a": 1})];
        let out = infer_schema(
            &values,
            InferOptions {
                closed_objects: true,
                ..Default::default()
            },
        );
        let s: Value = serde_json::from_str(&out.body).unwrap();
        assert_eq!(s["additionalProperties"], json!(false));
    }

    #[test]
    fn an_integer_stays_an_integer_until_a_float_appears() {
        assert_eq!(
            draft(&["{\"n\":1}"])["properties"]["n"]["type"],
            json!("integer")
        );
        let mixed = draft(&["{\"n\":1}", "{\"n\":1.5}"]);
        assert_eq!(mixed["properties"]["n"]["type"], json!("number"));
    }

    #[test]
    fn a_nullable_scalar_uses_a_type_array() {
        // A `type` array keeps completions working, which `anyOf` would not.
        let s = draft(&[r#"{"a":"x"}"#, r#"{"a":null}"#]);
        assert_eq!(s["properties"]["a"]["type"], json!(["null", "string"]));
    }

    #[test]
    fn an_always_null_field_is_typed_null() {
        let s = draft(&[r#"{"a":null}"#]);
        assert_eq!(s["properties"]["a"]["type"], json!("null"));
    }

    #[test]
    fn structural_mixing_becomes_any_of_and_is_reported() {
        let values: Vec<Value> = vec![json!({"a": 1}), json!({"a": {"b": 1}})];
        let out = infer_schema(&values, InferOptions::default());
        let s: Value = serde_json::from_str(&out.body).unwrap();
        let branches = s["properties"]["a"]["anyOf"].as_array().unwrap();
        assert_eq!(branches.len(), 2);
        assert_eq!(out.stats.mixed_paths, vec!["a".to_string()]);
    }

    #[test]
    fn an_empty_array_gets_no_items() {
        let s = draft(&[r#"{"a":[]}"#]);
        assert_eq!(s["properties"]["a"]["type"], json!("array"));
        assert!(s["properties"]["a"].get("items").is_none());
    }

    #[test]
    fn array_items_unify_across_every_array_seen() {
        let s = draft(&[r#"{"a":[1,2]}"#, r#"{"a":["x"]}"#]);
        assert_eq!(
            s["properties"]["a"]["items"]["type"],
            json!(["integer", "string"])
        );
    }

    #[test]
    fn an_enum_needs_repetition_to_count_as_evidence() {
        // Three distinct values out of three samples is a sample size, not a
        // closed domain.
        let unique = draft(&[r#"{"s":"a"}"#, r#"{"s":"b"}"#, r#"{"s":"c"}"#]);
        assert!(unique["properties"]["s"].get("enum").is_none());

        let repeated = draft(&[r#"{"s":"a"}"#, r#"{"s":"b"}"#, r#"{"s":"a"}"#]);
        assert_eq!(repeated["properties"]["s"]["enum"], json!(["a", "b"]));
        // `type` survives alongside it, for better completion labels.
        assert_eq!(repeated["properties"]["s"]["type"], json!("string"));
    }

    #[test]
    fn a_wide_domain_does_not_become_an_enum() {
        let values: Vec<Value> = (0..40).chain(0..40).map(|i| json!({ "n": i })).collect();
        let out = infer_schema(&values, InferOptions::default());
        let s: Value = serde_json::from_str(&out.body).unwrap();
        assert!(s["properties"]["n"].get("enum").is_none());
    }

    #[test]
    fn booleans_never_get_an_enum() {
        let s = draft(&[r#"{"b":true}"#, r#"{"b":false}"#, r#"{"b":true}"#]);
        assert!(s["properties"]["b"].get("enum").is_none());
        assert_eq!(s["properties"]["b"]["type"], json!("boolean"));
    }

    #[test]
    fn formats_are_inferred_only_when_every_sample_agrees() {
        let dates = draft(&[r#"{"d":"2026-08-19"}"#, r#"{"d":"2026-01-02"}"#]);
        assert_eq!(dates["properties"]["d"]["format"], json!("date"));

        let mixed = draft(&[r#"{"d":"2026-08-19"}"#, r#"{"d":"not a date"}"#]);
        assert!(mixed["properties"]["d"].get("format").is_none());
    }

    #[test]
    fn a_single_string_sample_gets_no_format() {
        // One sample is not evidence of a shape.
        let s = draft(&[r#"{"d":"2026-08-19"}"#]);
        assert!(s["properties"]["d"].get("format").is_none());
    }

    #[test]
    fn date_time_uuid_and_email_are_recognised() {
        let dt = draft(&[
            r#"{"v":"2026-08-19T10:00:00Z"}"#,
            r#"{"v":"2026-08-20T11:30:00Z"}"#,
        ]);
        assert_eq!(dt["properties"]["v"]["format"], json!("date-time"));

        let uuid = draft(&[
            r#"{"v":"5f9d1b2e-1c3a-4d5e-8f70-a1b2c3d4e5f6"}"#,
            r#"{"v":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}"#,
        ]);
        assert_eq!(uuid["properties"]["v"]["format"], json!("uuid"));

        let mail = draft(&[r#"{"v":"a@b.com"}"#, r#"{"v":"c@d.org"}"#]);
        assert_eq!(mail["properties"]["v"]["format"], json!("email"));
    }

    #[test]
    fn deep_nesting_is_cut_off_and_flagged() {
        let mut v = json!(1);
        for _ in 0..20 {
            v = json!({ "n": v });
        }
        let out = infer_schema(&[v], InferOptions::default());
        assert!(out.stats.truncated_depth);
    }

    #[test]
    fn a_long_array_is_sampled_and_flagged() {
        let big: Vec<Value> = (0..MAX_ARRAY_SAMPLES + 10).map(|i| json!(i)).collect();
        let out = infer_schema(&[json!({ "a": big })], InferOptions::default());
        assert!(out.stats.truncated_arrays);
    }

    #[test]
    fn no_samples_yields_an_empty_permissive_schema() {
        let out = infer_schema(&[], InferOptions::default());
        let s: Value = serde_json::from_str(&out.body).unwrap();
        assert_eq!(out.stats.samples, 0);
        // Only `$schema` — "anything goes". The caller refuses to save this.
        assert_eq!(s.as_object().unwrap().len(), 1);
    }

    #[test]
    fn the_sample_cap_is_honoured() {
        let values: Vec<Value> = (0..500).map(|_| json!({})).collect();
        let out = infer_schema(&values, InferOptions::default());
        assert_eq!(out.stats.samples, 200);
    }

    #[test]
    fn output_is_byte_stable_for_the_same_input() {
        // The property that makes a re-generated schema diff readable.
        let values: Vec<Value> = vec![json!({"z": 1, "a": {"m": "x", "b": 2}, "k": [1, 2]})];
        let a = infer_schema(&values, InferOptions::default()).body;
        let b = infer_schema(&values, InferOptions::default()).body;
        assert_eq!(a, b);
        // …and keys come out sorted, not in insertion order.
        let first_prop = a.find("\"a\"").unwrap();
        let later_prop = a.find("\"z\"").unwrap();
        assert!(first_prop < later_prop);
    }

    #[test]
    fn a_scalar_root_is_described_directly() {
        let out = infer_schema(&[json!(42)], InferOptions::default());
        let s: Value = serde_json::from_str(&out.body).unwrap();
        assert_eq!(s["type"], json!("integer"));
    }
}
