//! Which of the two axes in [`crate::ai`]'s coupling rule is in force for one
//! tool call.
//!
//! Pure by construction: the resolver takes the endpoint's declared trust and
//! the connection's own opt-in and returns a decision. Neither input is read
//! from disk here, so the rule that decides whether rows may leave the machine
//! is testable without an `AppState` (convention #52).

use serde::{Deserialize, Serialize};

/// How much HuginnDB trusts the configured inference endpoint with data.
///
/// **Declared by the user, never sniffed.** Phase 3's Settings UI pre-fills the
/// guess from loopback / RFC1918 detection, but the value it stores is the
/// user's answer: `ai-internal` is a hostname, DNS is not a security boundary,
/// and a rule derived from a resolver's answer is a rule an attacker on the
/// network gets to edit. Honest and auditable beats clever.
///
/// [`Self::Untrusted`] is the [`Default`] on purpose — the same reasoning that
/// makes `McpWritePolicy::ReadOnly` one. A half-written `prefs.json`, or one
/// from a version that predates the field, must not resolve to "may read rows".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointTrust {
    /// A third party's endpoint, or one the user has not vouched for.
    #[default]
    Untrusted,
    /// Loopback, or infrastructure the user has declared as their own.
    Trusted,
}

/// What a tool call is allowed to put into the model's context.
///
/// [`Self::MetadataOnly`] is the [`Default`] for the same reason
/// [`EndpointTrust::Untrusted`] is: a value that was never resolved must not be
/// the permissive one. `crate::ai::tasks::TaskContext` derives `Default`, so
/// this is reachable — and a `TaskContext` built without a scope having "rows"
/// in it would be a hole in the rule opened by a derive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DataScope {
    /// Table and column names, types, indexes, view bodies, `EXPLAIN` output.
    /// No row ever reaches the prompt.
    #[default]
    MetadataOnly,
    /// Metadata plus row data.
    Rows,
}

impl DataScope {
    /// Apply the coupling rule.
    ///
    /// A trusted endpoint may read rows. An untrusted one gets metadata only,
    /// unless this particular connection has been opted in explicitly
    /// (`ConnectionProfile::ai_rows_allowed`, default `false`).
    ///
    /// Note the asymmetry this leaves, deliberately, in v1: a *trusted*
    /// endpoint ignores the per-connection flag, so "never send this
    /// connection's rows anywhere, not even to our own box" is expressed by
    /// clearing `ConnectionProfile::ai_enabled` rather than by this flag.
    /// Splitting the flag into a two-sided consent is a v2 question; the
    /// roadmap's locked rule is the one implemented here.
    pub fn resolve(trust: EndpointTrust, rows_allowed: bool) -> Self {
        match trust {
            EndpointTrust::Trusted => Self::Rows,
            EndpointTrust::Untrusted if rows_allowed => Self::Rows,
            EndpointTrust::Untrusted => Self::MetadataOnly,
        }
    }

    /// Whether a tool whose result carries rows may be offered and executed.
    pub fn allows_rows(self) -> bool {
        matches!(self, Self::Rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coupling_rule_is_the_whole_truth_table() {
        let cases = [
            (EndpointTrust::Trusted, false, DataScope::Rows),
            (EndpointTrust::Trusted, true, DataScope::Rows),
            (EndpointTrust::Untrusted, false, DataScope::MetadataOnly),
            (EndpointTrust::Untrusted, true, DataScope::Rows),
        ];
        for (trust, rows_allowed, expected) in cases {
            assert_eq!(
                DataScope::resolve(trust, rows_allowed),
                expected,
                "{trust:?} + ai_rows_allowed={rows_allowed}"
            );
        }
    }

    /// The whole feature's promise rests on this default. A `prefs.json` that
    /// predates `AiPrefs`, or one hand-edited into an incomplete state, must
    /// deserialise into the configuration that sends the *least*.
    #[test]
    fn an_unstated_trust_level_is_untrusted() {
        assert_eq!(EndpointTrust::default(), EndpointTrust::Untrusted);
        assert_eq!(
            DataScope::resolve(EndpointTrust::default(), false),
            DataScope::MetadataOnly
        );
        let from_absent: EndpointTrust = serde_json::from_str("\"untrusted\"").unwrap();
        assert_eq!(from_absent, EndpointTrust::Untrusted);
    }

    /// A `DataScope` that was never resolved must be the withholding one — the
    /// same argument that makes `EndpointTrust::Untrusted` the default, applied
    /// to the type a `#[derive(Default)]` elsewhere can conjure.
    #[test]
    fn an_unresolved_scope_withholds_rows() {
        assert_eq!(DataScope::default(), DataScope::MetadataOnly);
        assert!(!DataScope::default().allows_rows());
    }

    #[test]
    fn only_the_rows_scope_allows_rows() {
        assert!(DataScope::Rows.allows_rows());
        assert!(!DataScope::MetadataOnly.allows_rows());
    }
}
