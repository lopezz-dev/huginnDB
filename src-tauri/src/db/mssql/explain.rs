//! SQL Server's estimated plan for one statement, without running it.
//!
//! SQL Server has no `EXPLAIN`. Its plan comes from `SET SHOWPLAN_XML ON`,
//! which must be a batch of its own; while it is on, every later batch on the
//! session returns its plan **instead of running**. So the plan is read on a
//! session of its own, which is closed afterwards rather than pooled: the next
//! borrower must never inherit a session that only returns plans.
//!
//! What goes back is a summary, not the XML. A plan for one of NAV's object
//! searches runs to hundreds of KB, which would fill a model's context with
//! namespaces. The summary keeps what tells you whether a read is going to
//! hurt: the statement's cost, the operators as a tree with their estimated
//! rows, rows read and table size, the object each reads, the indexes the
//! optimiser wished it had, and its warnings.
//!
//! A small tag scanner rather than an XML parser: showplan is regular,
//! machine-written XML, and only attributes are read. Nothing here depends on
//! text content, CDATA or comments.

use serde_json::{json, Value};

use crate::db::mssql::MsSqlPool;
use crate::error::{AppError, AppResult};
use crate::pulse::ExplainPlan;

/// How many operators the summary lists, in plan order. Enough for the
/// statements a person or a model asks about; past it the summary says how
/// many were left out.
const MAX_OPERATORS: usize = 80;

/// Read the plan SQL Server would use for `sql`, without running it.
///
/// `sql` must already be validated read-only and single —
/// `commands::pulse::pulse_explain_inner` does that, once, for every engine.
pub async fn estimated_plan(pool: &MsSqlPool, sql: &str) -> AppResult<ExplainPlan> {
    let mut client = pool.acquire().await?;
    // Whatever happens next, this session only returns plans from now on.
    client.close_on_drop();
    client
        .batch("SET SHOWPLAN_XML ON")
        .await
        .map_err(permission_hint)?;
    let sets = client.simple_query_sets(sql).await?;
    let xml: Vec<String> = sets
        .iter()
        .flatten()
        .filter_map(|row| row.try_get::<&str, _>(0).ok().flatten().map(str::to_string))
        .collect();
    if xml.is_empty() {
        return Err(AppError::InvalidInput(
            "SQL Server returned no plan for this statement".into(),
        ));
    }
    Ok(ExplainPlan {
        raw: summarize(&xml.join("")),
    })
}

/// SQL Server's refusal, with what to ask for.
fn permission_hint(e: AppError) -> AppError {
    if e.to_string().to_ascii_lowercase().contains("showplan") {
        AppError::InvalidInput(format!(
            "{e}. Reading a plan needs the SHOWPLAN permission on this database \
             (GRANT SHOWPLAN TO <user>); nothing was run."
        ))
    } else {
        e
    }
}

/// An index the optimiser wished it had, column groups by how it would use
/// them.
#[derive(Debug, Default)]
struct MissingIndex {
    table: String,
    equality: Vec<String>,
    inequality: Vec<String>,
    include: Vec<String>,
}

/// One operator of the plan, as the summary lists it.
#[derive(Debug, Default)]
struct Operator {
    depth: usize,
    physical: String,
    logical: String,
    estimate_rows: Option<f64>,
    rows_read: Option<f64>,
    table_cardinality: Option<f64>,
    subtree_cost: Option<f64>,
    object: Option<String>,
}

impl Operator {
    fn to_json(&self) -> Value {
        let mut o = json!({
            "depth": self.depth,
            "op": self.physical,
        });
        let obj = o.as_object_mut().expect("an object");
        if self.logical != self.physical {
            obj.insert("logical".into(), json!(self.logical));
        }
        let mut put = |k: &str, v: Option<f64>| {
            if let Some(v) = v {
                obj.insert(k.into(), json!(round(v)));
            }
        };
        put("estimated_rows", self.estimate_rows);
        put("estimated_rows_read", self.rows_read);
        put("table_rows", self.table_cardinality);
        put("subtree_cost", self.subtree_cost);
        if let Some(object) = &self.object {
            obj.insert("object".into(), json!(object));
        }
        o
    }

    fn is_scan(&self) -> bool {
        matches!(
            self.physical.as_str(),
            "Table Scan" | "Clustered Index Scan" | "Index Scan" | "Columnstore Index Scan"
        )
    }
}

fn round(v: f64) -> f64 {
    if v.abs() >= 100.0 {
        v.round()
    } else {
        (v * 1000.0).round() / 1000.0
    }
}

/// The summary of one or more `ShowPlanXML` documents (one per statement).
pub(crate) fn summarize(xml: &str) -> Value {
    let mut statements = Vec::new();
    let mut operators: Vec<Operator> = Vec::new();
    // Indexes into `operators` of the `RelOp`s still open.
    let mut open: Vec<usize> = Vec::new();
    let mut missing = Vec::new();
    let mut missing_current: Option<MissingIndex> = None;
    let mut usage = String::new();
    let mut warnings = Vec::new();
    let mut in_warnings = false;

    for tag in tags(xml) {
        match (tag.name, tag.closing) {
            ("StmtSimple", false) => {
                let mut s = serde_json::Map::new();
                if let Some(v) = tag.num("StatementSubTreeCost") {
                    s.insert("cost".into(), json!(round(v)));
                }
                if let Some(v) = tag.num("StatementEstRows") {
                    s.insert("estimated_rows".into(), json!(round(v)));
                }
                if let Some(v) = tag.attr("StatementOptmEarlyAbortReason") {
                    s.insert("optimizer_stopped".into(), json!(v));
                }
                statements.push(Value::Object(s));
            }
            ("RelOp", false) => {
                operators.push(Operator {
                    depth: open.len(),
                    physical: tag.attr("PhysicalOp").unwrap_or_default(),
                    logical: tag.attr("LogicalOp").unwrap_or_default(),
                    estimate_rows: tag.num("EstimateRows"),
                    rows_read: tag.num("EstimatedRowsRead"),
                    table_cardinality: tag.num("TableCardinality"),
                    subtree_cost: tag.num("EstimatedTotalSubtreeCost"),
                    object: None,
                });
                if !tag.self_closing {
                    open.push(operators.len() - 1);
                }
            }
            ("RelOp", true) => {
                open.pop();
            }
            ("Object", false) => {
                // The innermost open operator reads it — the first `Object`
                // under a scan or seek is the one it reads.
                if let Some(&i) = open.last() {
                    if operators[i].object.is_none() {
                        let parts: Vec<String> = ["Schema", "Table", "Index"]
                            .iter()
                            .filter_map(|k| tag.attr(k))
                            .collect();
                        if !parts.is_empty() {
                            operators[i].object = Some(parts.join("."));
                        }
                    }
                }
            }
            ("MissingIndex", false) => {
                let table = ["Schema", "Table"]
                    .iter()
                    .filter_map(|k| tag.attr(k))
                    .collect::<Vec<_>>()
                    .join(".");
                missing_current = Some(MissingIndex {
                    table,
                    ..MissingIndex::default()
                });
            }
            ("ColumnGroup", false) => usage = tag.attr("Usage").unwrap_or_default(),
            ("Column", false) => {
                if let (Some(index), Some(name)) = (missing_current.as_mut(), tag.attr("Name")) {
                    match usage.as_str() {
                        "EQUALITY" => index.equality.push(name),
                        "INEQUALITY" => index.inequality.push(name),
                        "INCLUDE" => index.include.push(name),
                        _ => {}
                    }
                }
            }
            ("MissingIndex", true) => {
                if let Some(index) = missing_current.take() {
                    missing.push(json!({
                        "table": index.table,
                        "equality": index.equality,
                        "inequality": index.inequality,
                        "include": index.include,
                    }));
                }
            }
            ("Warnings", false) if !tag.self_closing => in_warnings = true,
            ("Warnings", true) => in_warnings = false,
            (name, false) if in_warnings => warnings.push(name.to_string()),
            _ => {}
        }
    }

    // Where the rows come from: the scans that read the most, which is what
    // makes a read over a big table slow before anything per row is counted.
    let mut scans: Vec<&Operator> = operators.iter().filter(|o| o.is_scan()).collect();
    scans.sort_by(|a, b| {
        let read = |o: &Operator| o.rows_read.or(o.table_cardinality).unwrap_or(0.0);
        read(b).total_cmp(&read(a))
    });
    let biggest_scans: Vec<Value> = scans.iter().take(3).map(|o| o.to_json()).collect();

    let total = operators.len();
    let listed: Vec<Value> = operators
        .iter()
        .take(MAX_OPERATORS)
        .map(Operator::to_json)
        .collect();
    let mut summary = json!({
        "engine": "sqlserver",
        "estimated": true,
        "statements": statements,
        "operators": listed,
        "biggest_scans": biggest_scans,
        "missing_indexes": missing,
        "warnings": warnings,
        "note": "Estimated plan: the statement was not run. Costs are the optimiser's \
                 guesses and do not count per-row work inside scalar functions \
                 (DECOMPRESS, CAST over blobs, user functions): multiply that work by \
                 the rows a scan reads.",
    });
    if total > MAX_OPERATORS {
        summary["operators_omitted"] = json!(total - MAX_OPERATORS);
    }
    summary
}

/// One start or end tag.
struct Tag<'a> {
    /// The local name, without a namespace prefix.
    name: &'a str,
    closing: bool,
    self_closing: bool,
    attrs: &'a str,
}

impl Tag<'_> {
    /// The value of attribute `key`, entities decoded.
    fn attr(&self, key: &str) -> Option<String> {
        let mut rest = self.attrs;
        while let Some(eq) = rest.find('=') {
            let name = rest[..eq].trim();
            let after = rest[eq + 1..].trim_start();
            let quote = after.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let end = after[1..].find(quote)?;
            let value = &after[1..1 + end];
            if name == key {
                return Some(unescape(value));
            }
            rest = &after[end + 2..];
        }
        None
    }

    fn num(&self, key: &str) -> Option<f64> {
        self.attr(key)?.parse().ok()
    }
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Every element tag in `xml`, in order. Skips the declaration, comments and
/// processing instructions; attribute values may hold `>` only as `&gt;`,
/// which is how SQL Server writes them.
fn tags(xml: &str) -> impl Iterator<Item = Tag<'_>> {
    let mut rest = xml;
    std::iter::from_fn(move || loop {
        let start = rest.find('<')?;
        let after = &rest[start + 1..];
        let end = after.find('>')?;
        let body = &after[..end];
        rest = &after[end + 1..];
        if body.starts_with('?') || body.starts_with('!') {
            continue;
        }
        let closing = body.starts_with('/');
        let body = body.trim_start_matches('/');
        let self_closing = body.ends_with('/');
        let body = body.trim_end_matches('/');
        let (qname, attrs) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
        let name = qname.rsplit(':').next().unwrap_or(qname);
        return Some(Tag {
            name,
            closing,
            self_closing,
            attrs,
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real SQL Server 2016 plan: a stream aggregate over a
    /// nested loop, a clustered index scan with a residual predicate, a key
    /// lookup, a missing index and a warning.
    const PLAN: &str = r#"<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.5">
 <BatchSequence><Batch><Statements>
  <StmtSimple StatementText="SELECT COUNT(*) FROM [Object Metadata] o WHERE …" StatementSubTreeCost="1843.27" StatementEstRows="1" StatementOptmEarlyAbortReason="GoodEnoughPlanFound">
   <QueryPlan>
    <Warnings><PlanAffectingConvert ConvertIssue="Cardinality Estimate" Expression="CONVERT(varbinary(max),[o].[User Code],0)" /></Warnings>
    <MissingIndexes><MissingIndexGroup Impact="71.2">
     <MissingIndex Database="[TILES]" Schema="[dbo]" Table="[Object Metadata]">
      <ColumnGroup Usage="EQUALITY"><Column Name="[Object Type]" ColumnId="1" /></ColumnGroup>
      <ColumnGroup Usage="INCLUDE"><Column Name="[User Code]" ColumnId="9" /></ColumnGroup>
     </MissingIndex>
    </MissingIndexGroup></MissingIndexes>
    <RelOp NodeId="0" PhysicalOp="Stream Aggregate" LogicalOp="Aggregate" EstimateRows="1" EstimatedTotalSubtreeCost="1843.27">
     <StreamAggregate>
      <RelOp NodeId="1" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="12000" EstimatedTotalSubtreeCost="1840.1">
       <NestedLoops>
        <RelOp NodeId="2" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="12000" EstimatedRowsRead="48210" TableCardinality="48210" EstimatedTotalSubtreeCost="912.5">
         <IndexScan><Object Database="[TILES]" Schema="[dbo]" Table="[Object Metadata]" Index="[Object Metadata$0]" Alias="[o]" /></IndexScan>
        </RelOp>
        <RelOp NodeId="3" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="927.6">
         <IndexScan><Object Database="[TILES]" Schema="[dbo]" Table="[Object]" Index="[Object$0]" /></IndexScan>
        </RelOp>
       </NestedLoops>
      </RelOp>
     </StreamAggregate>
    </RelOp>
   </QueryPlan>
  </StmtSimple>
 </Statements></Batch></BatchSequence>
</ShowPlanXML>"#;

    #[test]
    fn the_summary_keeps_the_cost_the_tree_and_what_is_read() {
        let s = summarize(PLAN);
        assert_eq!(s["engine"], "sqlserver");
        assert_eq!(s["estimated"], true);
        assert_eq!(s["statements"][0]["cost"], 1843.0);
        assert_eq!(
            s["statements"][0]["optimizer_stopped"],
            "GoodEnoughPlanFound"
        );

        let ops = s["operators"].as_array().unwrap();
        let shape: Vec<(u64, &str)> = ops
            .iter()
            .map(|o| (o["depth"].as_u64().unwrap(), o["op"].as_str().unwrap()))
            .collect();
        assert_eq!(
            shape,
            vec![
                (0, "Stream Aggregate"),
                (1, "Nested Loops"),
                (2, "Clustered Index Scan"),
                (2, "Clustered Index Seek"),
            ],
            "nesting follows the RelOps"
        );
        assert_eq!(ops[1]["logical"], "Inner Join");
        assert!(ops[2].get("logical").is_none(), "same as op: left out");
        assert_eq!(
            ops[2]["object"],
            "[dbo].[Object Metadata].[Object Metadata$0]"
        );
        assert_eq!(ops[2]["estimated_rows_read"], 48210.0);
        assert_eq!(ops[3]["object"], "[dbo].[Object].[Object$0]");
    }

    #[test]
    fn the_summary_names_the_biggest_scan_the_missing_index_and_the_warnings() {
        let s = summarize(PLAN);
        assert_eq!(s["biggest_scans"][0]["table_rows"], 48210.0);
        assert_eq!(s["missing_indexes"][0]["table"], "[dbo].[Object Metadata]");
        assert_eq!(s["missing_indexes"][0]["equality"][0], "[Object Type]");
        assert_eq!(s["missing_indexes"][0]["include"][0], "[User Code]");
        assert_eq!(s["warnings"][0], "PlanAffectingConvert");
        assert!(s["note"].as_str().unwrap().contains("DECOMPRESS"));
        assert!(s.get("operators_omitted").is_none());
    }

    #[test]
    fn a_long_plan_says_how_many_operators_it_left_out() {
        let op =
            r#"<RelOp PhysicalOp="Compute Scalar" LogicalOp="Compute Scalar" EstimateRows="1"/>"#;
        let xml = op.repeat(MAX_OPERATORS + 5);
        let s = summarize(&xml);
        assert_eq!(s["operators"].as_array().unwrap().len(), MAX_OPERATORS);
        assert_eq!(s["operators_omitted"], 5);
        assert_eq!(
            s["operators"][1]["depth"], 0,
            "self-closing RelOps do not nest"
        );
    }

    #[test]
    fn attribute_values_are_unescaped_and_prefixes_dropped() {
        let xml =
            r#"<sp:RelOp PhysicalOp="Filter" LogicalOp="Filter &amp; &quot;x&quot;"></sp:RelOp>"#;
        let s = summarize(xml);
        assert_eq!(s["operators"][0]["op"], "Filter");
        assert_eq!(s["operators"][0]["logical"], "Filter & \"x\"");
    }
}
