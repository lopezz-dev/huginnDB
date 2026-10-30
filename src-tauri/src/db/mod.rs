//! Database abstraction layer.
//!
//! Five backends: PostgreSQL, MySQL and SQLite through [`sqlx`], plus MongoDB
//! through the `mongodb` crate (since 1.1.0) and Microsoft SQL Server through
//! `tiberius` — `sqlx` has no MSSQL driver, so that one brings its own client
//! and connection pool. The submodules here hold the logic that is independent
//! of which Tauri command is invoking it:
//!
//! * [`endpoint`] — per-server connection budgets, so pools stop being
//!   accounted for per profile.
//! * [`pool`] — open/close pools and build connection options per driver.
//! * [`values`] — decode `sqlx` rows into `serde_json::Value`. The
//!   driver-specific type quirks documented here are load-bearing; read the
//!   comments before touching a decode branch.
//! * [`sql`] — driver-aware SQL helpers: identifier quoting and the statement
//!   classifier that drives the MCP connector's write policy.
//! * [`exec`] — the counterpart of [`sql`] for *running* a statement on any
//!   pool, so a command never has to enumerate the drivers itself.
//! * [`session`] — one borrowed session on any SQL pool, for the batch,
//!   script and write-batch paths whose statements must share it.
//! * [`ddl`] — pure builder that diffs two table structures into ordered DDL,
//!   shared by structure-editor preview and apply so they cannot drift.
//! * [`view_ddl`] — the same idea for views.
//! * [`dump`] — render rows back into `INSERT` statements for SQL export.
//! * [`ssh`] — SSH tunnel: host-key verification and local port forwarding.
//! * [`mongo`] — shell-syntax parsing, query execution and BSON conversion.
//! * [`mssql`] — the SQL Server client: its own session pool, `sys.*` catalog
//!   introspection and `ColumnData` → JSON decoding.

pub mod classify;
pub mod ddl;
pub mod dump;
pub mod endpoint;
pub mod exec;
pub mod mongo;
pub mod mssql;
pub mod mysql;
pub mod pool;
pub mod postgres;
pub mod session;
pub mod sql;
pub mod sqlite;
pub mod ssh;
pub mod values;
pub mod view_ddl;
