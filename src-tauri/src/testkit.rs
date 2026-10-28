//! Fixtures shared by the unit tests, so a new field on a domain struct is one
//! edit rather than six.
//!
//! Six test modules — `commands::connection`, `store`, `transfer`,
//! `db::pool`, `db::endpoint` and `pool_reaper` — each carried a private
//! `fn profile(..)` building the same twenty-odd-field [`ConnectionProfile`],
//! varying one to three of them. Every field added to that struct since has
//! had to be added to all six before the suite compiled again, which is
//! busywork that also quietly discourages adding a test module.
//!
//! The baseline is deliberately boring: a local Postgres profile with no
//! tunnel, no group, no origin and default everything else. A test that needs
//! something else says so with struct-update syntax, which keeps the *reason*
//! visible at the test rather than buried in a fixture:
//!
//! ```ignore
//! ConnectionProfile { host: "alpha".into(), ..testkit::profile("p") }
//! ```

use crate::state::{ConnectionProfile, Driver};

/// A minimal, valid [`ConnectionProfile`] identified by `id` (and named after
/// it). Override whatever the test is actually about with `..`.
pub fn profile(id: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        name: id.into(),
        driver: Driver::Postgres,
        host: "localhost".into(),
        port: 5432,
        database: String::new(),
        username: "u".into(),
        ssl: false,
        ssh_tunnel: None,
        connection_string: None,
        auth_source: None,
        mssql: None,
        ephemeral: false,
        group: None,
        visible_databases: None,
        mcp_write: Default::default(),
        max_connections: None,
        operation_timeout_secs: None,
        origin_id: None,
        pulse_enabled: false,
        mcp_exposed: false,
        mcp_max_rows: None,
        ai_enabled: false,
        ai_rows_allowed: false,
        ai_notes: None,
        secret_override: None,
        personal_username: None,
    }
}
