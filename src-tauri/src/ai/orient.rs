//! What the assistant is told about the database *before* it starts looking.
//!
//! # The gap this closes
//!
//! Agent mode gave the model tools and nothing else, so its first move was
//! always a guess: it would fix on the one table or the one column the question
//! named and answer about that, because it had no way to know what else was
//! there. Asked about a `settings` column it would describe that column; it
//! could not notice that the answer lived in a neighbouring table, because as
//! far as it knew the neighbour did not exist.
//!
//! A person reading the schema tree has the map on screen before they type. An
//! agent that has to discover the map by spending iterations on it will
//! usually not bother — and a small model, with six steps and a small context,
//! genuinely cannot afford to. So the map is handed over up front: one
//! `list_tables` read, in the system message, before the first model call.
//!
//! # Why this is one read and not a schema dump
//!
//! Names are cheap and structure is not. Eighty table names cost a few hundred
//! tokens; eighty `describe_table` replies would fill the window and leave no
//! room for the question — the same trade `crate::ai::exec`'s size budget
//! exists for. Names are enough to orient: they tell the model what the
//! database is *about*, and which of the tools to spend its steps on.
//!
//! Deliberately not cached. A catalog read against a live connection is
//! milliseconds next to a completion that takes seconds, and a cache here
//! would be a second copy of the schema that can be wrong — the schema tree's
//! own warm state already taught that lesson (ADR #55).

use crate::ai::exec::{AiCall, AiRuntime};
use crate::ai::tools;
use crate::log_bus::LogSink;
use crate::state::AppState;
use serde_json::json;

/// Table names listed in full before the rest are elided.
///
/// Eighty is well past the size of database anyone is asking a 12B about, and
/// short of the point where the list is the prompt. Past it the model is told
/// how many it has not seen, which is more useful than a silently short list:
/// "and 400 more" is a fact about the database.
pub const MAX_LISTED_TABLES: usize = 80;

/// The orientation paragraph, or `None` when there is nothing to say.
///
/// Pure, so the wording is pinned by tests rather than discovered against a
/// live model.
pub fn table_map(names: &[String], max: usize) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let shown = names.len().min(max);
    let mut out = format!(
        "This connection has {} tables: {}",
        names.len(),
        names[..shown].join(", ")
    );
    if names.len() > shown {
        out.push_str(&format!(
            ", and {} more — call list_tables for the whole list",
            names.len() - shown
        ));
    }
    out.push('.');
    // The instruction the list exists for. Without it a model treats the map as
    // trivia; with it, the map is what stops the answer being about whichever
    // name the question happened to mention.
    out.push_str(
        "\nThat is the whole surface — nothing outside that list exists to query. Before you \
         answer about one table, check whether the question is really about a neighbouring one, \
         and describe_table the ones you need rather than assuming what a column holds.",
    );
    Some(out)
}

/// Read the map for `connection`, or `None` when it cannot be read.
///
/// Failure is not an error: a connection that is not open, or a driver that
/// refuses the catalog, means the turn runs without orientation exactly as it
/// did before this existed. Losing the whole turn to it would be the wrong
/// trade for a paragraph.
pub async fn overview(
    state: &AppState,
    sink: &dyn LogSink,
    runtime: AiRuntime,
    connection: &str,
) -> Option<String> {
    let reply = crate::ai::exec::execute(
        state,
        sink,
        runtime,
        &AiCall {
            connection,
            tool: tools::LIST_TABLES,
            args: &json!({}),
        },
    )
    .await
    .ok()?;
    table_map(&crate::ai::tasks::table_names(&reply), MAX_LISTED_TABLES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("t{i}")).collect()
    }

    #[test]
    fn the_map_names_the_tables_and_tells_the_model_what_to_do_with_them() {
        let map = table_map(&["orders".into(), "cfg_app".into()], MAX_LISTED_TABLES)
            .expect("two tables is a map");
        assert!(map.contains("2 tables"), "{map}");
        assert!(map.contains("orders, cfg_app"), "{map}");
        // The two instructions that make the list worth its tokens.
        assert!(map.contains("neighbouring"), "{map}");
        assert!(map.contains("describe_table"), "{map}");
        // And the closure: a name that is not there cannot be queried.
        assert!(map.contains("whole surface"), "{map}");
    }

    #[test]
    fn a_long_list_is_elided_with_its_own_count() {
        let map = table_map(&names(100), 80).expect("a map");
        assert!(map.contains("100 tables"), "{map}");
        assert!(map.contains("and 20 more"), "{map}");
        assert!(map.contains("list_tables"), "{map}");
        assert!(!map.contains("t80"), "{map}");
        assert!(map.contains("t79"), "{map}");
    }

    #[test]
    fn a_short_list_is_not_elided() {
        let map = table_map(&names(3), 80).expect("a map");
        assert!(!map.contains("more —"), "{map}");
        assert!(map.contains("t2."), "{map}");
    }

    /// An empty database says nothing rather than "0 tables": the model would
    /// then answer questions about a database it has been told is empty, which
    /// is worse than it working the list out itself.
    #[test]
    fn an_empty_or_unreadable_catalogue_produces_no_paragraph() {
        assert!(table_map(&[], MAX_LISTED_TABLES).is_none());
    }
}
