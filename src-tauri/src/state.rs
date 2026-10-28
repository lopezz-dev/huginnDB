//! Application-wide runtime state.
//!
//! Stores two pieces of cross-command state behind interior-mutable locks:
//!
//! * `profiles` — the user's saved connection profiles. Loaded from disk
//!   at startup, written back whenever the user adds, edits, or removes
//!   one.
//! * `connections` — the pools that are currently open. Lives only in
//!   memory; reconnecting after a restart is an explicit user action.
//!
//! Passwords are **not** part of this state. They are read on-demand from
//! the OS keychain via [`crate::keychain`].

use mongodb::Client as MongoClient;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, PgPool, SqlitePool};
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{AppError, AppResult};

/// Database backend selected for a [`ConnectionProfile`].
///
/// `PartialEq`/`Eq`/`Hash` so it can take part in
/// [`crate::db::endpoint::EndpointKey`], which keys the per-server budget map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
    /// MongoDB. The document model diverges sharply from the SQL drivers
    /// above: all of its logic is concentrated in [`crate::db::mongo`] and
    /// dispatched through thin `DbPool::Mongo` arms in the command layer.
    /// Serialised as `"mongodb"` (not `"mongo"`) to match the frontend
    /// `Driver` union and the conventional driver name.
    #[serde(rename = "mongodb")]
    Mongo,
    /// Microsoft SQL Server, over TDS via `tiberius` (see [`crate::db::mssql`]).
    /// `sqlx` has no MSSQL driver, so this one carries its own client and
    /// session pool, but unlike MongoDB it speaks SQL and therefore shares the
    /// whole SQL command path via [`crate::db::sql::Dialect::MsSql`].
    /// Serialised as `"sqlserver"` to match the frontend `Driver` union.
    #[serde(rename = "sqlserver")]
    MsSql,
}

impl Driver {
    /// The driver's wire name — the same string `serde` writes to
    /// `profiles.json` and the frontend's `Driver` union uses.
    ///
    /// Every user-visible driver label goes through here: the Console panel's
    /// per-entry tag and the MCP `list_connections` tool. Before this existed
    /// the Console built the string with three duplicated `match` helpers and
    /// the MCP tool used `format!("{:?}")`, which reported `"mongo"` where the
    /// profile said `"mongodb"` — a Debug repr is not a wire format.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Sqlite => "sqlite",
            Self::Mongo => "mongodb",
            Self::MsSql => "sqlserver",
        }
    }

    /// The port this driver listens on when the profile does not name one.
    ///
    /// `None` for SQLite, which has no server and therefore no port to
    /// default to. Every other driver returns the value its own documentation
    /// calls the default, which is the number the user would otherwise have to
    /// know and retype into every profile.
    ///
    /// This is the **backend** copy of the frontend's `DEFAULT_PORTS`
    /// (`src/lib/constants.ts`). The duplication is deliberate and the
    /// direction matters: the dialog uses its copy to *prefill* a field, while
    /// this one decides what a profile carrying no port actually connects to —
    /// including profiles the dialog never touched, which arrive from the CLI,
    /// from an imported `.json`, and from a shared origin.
    pub fn default_port(self) -> Option<u16> {
        match self {
            Self::Postgres => Some(5432),
            Self::Mysql => Some(3306),
            Self::Sqlite => None,
            Self::Mongo => Some(27017),
            // A *default* instance. A named one is discovered through the SQL
            // Browser instead — see `crate::db::mssql`'s `Reach`.
            Self::MsSql => Some(1433),
        }
    }
}

/// How a SQL Server connection authenticates.
///
/// `Sql` is a SQL Server login (username + password stored in the OS keychain
/// like every other driver). `Windows` is NTLM with an explicit
/// `DOMAIN\user` + password — supported only by Windows builds, because
/// `tiberius`'s `AuthMethod::Windows` is `cfg(windows)`-gated. Integrated /
/// SSPI (authenticate as the logged-in Windows user with no credentials typed)
/// and Entra ID tokens are deliberately not offered yet.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MsSqlAuth {
    #[default]
    Sql,
    Windows,
}

/// SQL Server-specific connection settings.
///
/// Nested (like [`SshTunnel`]) rather than flattened into
/// [`ConnectionProfile`], so the other four drivers' profiles don't carry three
/// fields that mean nothing to them.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MsSqlOptions {
    /// Named instance (`SQLEXPRESS` in `HOST\SQLEXPRESS`). The combined
    /// `HOST\INSTANCE` form is accepted here and in [`ConnectionProfile::host`]
    /// — see `db::mssql::split_instance`. When set, the port is discovered
    /// through the SQL Browser instead of being used as given, except as the
    /// fallback tried when the Browser doesn't answer.
    #[serde(default)]
    pub instance: Option<String>,
    /// Accept the server's TLS certificate without validating it. Most on-prem
    /// instances present a self-signed certificate, so an encrypted connection
    /// to them cannot be established without this.
    #[serde(default)]
    pub trust_server_certificate: bool,
    #[serde(default)]
    pub auth: MsSqlAuth,
}

/// How far the headless MCP connector (`huginndb-mcp`) may go when writing to
/// this connection. Per-connection policy — the sidecar reads it fresh from
/// `profiles.json` on every write attempt, so changing it in the app takes
/// effect without restarting the MCP client.
///
/// * `ReadOnly` (default) — reads only; every write tool and any non-read-only
///   `run_query` is refused.
/// * `Data` — row-level DML: `INSERT`/`UPDATE`/`DELETE` (and their Mongo
///   equivalents), plus the structured write tools. No schema changes.
/// * `Full` — adds DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) through
///   `run_query`, plus the `save_view` / `drop_view` tools. There is no
///   structure-editor tool on any tier; table DDL goes through `run_query`.
///
/// This is metadata-only from the backend's perspective (like
/// [`ConnectionProfile::visible_databases`]); the desktop app never acts on
/// it — only the sidecar's enforcement path does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum McpWritePolicy {
    /// The default for any profile that has never opted in: an MCP client may
    /// read but never mutate. Deliberately the `Default` so a profile
    /// deserialised from an older `profiles.json` (which has no such field)
    /// can never come back as writable.
    #[default]
    ReadOnly,
    Data,
    Full,
}

// Consumed by the headless connector's enforcement path (`crate::mcp`) and,
// since the MCP bridge landed, by `crate::bridge::server` — which re-checks the
// policy inside the *desktop app*, built without the `mcp` feature. That second
// caller is why these are no longer gated behind it.
impl McpWritePolicy {
    /// The verbs this policy grants. `ReadOnly` grants reads; `Data` adds the
    /// three row-level writes **together** — this per-connection setting never
    /// split them, and a managed policy is what grants them one by one; `Full`
    /// adds DDL.
    pub fn verbs(self) -> crate::db::sql::Verbs {
        use crate::db::sql::Verbs;
        match self {
            McpWritePolicy::ReadOnly => Verbs::SELECT,
            McpWritePolicy::Data => Verbs::SELECT | Verbs::WRITES,
            McpWritePolicy::Full => Verbs::ALL,
        }
    }

    /// Whether an operation that needs `needed` is permitted under this
    /// policy: every verb it needs has to be granted.
    pub fn allows(self, needed: crate::db::sql::Verbs) -> bool {
        self.verbs().contains(needed)
    }

    /// Lowercased wire label (`read-only` / `data` / `full`) for error
    /// messages and logs.
    pub fn label(self) -> &'static str {
        match self {
            McpWritePolicy::ReadOnly => "read-only",
            McpWritePolicy::Data => "data",
            McpWritePolicy::Full => "full",
        }
    }
}

/// Default for the global `connections.mcpMaxRows` preference: the most rows
/// one MCP tool call returns when neither the connection nor the sidecar's
/// command line says otherwise.
///
/// 200, down from the 1000 the sidecar hard-coded until 1.37. The cap exists to
/// keep a result inside the model's context, and 1000 did not: Claude Code
/// refuses an MCP tool result over 25 000 tokens by default, and a thousand
/// rows of an ordinary ten-column table serialise to several times that — so
/// the old default produced a result the client threw away instead of a
/// truncated one the model could act on. Two hundred such rows land around
/// 10–15 000 tokens, which fits with room for the rest of the turn, and is
/// still more than an assistant needs to see a table's shape; past that it
/// should be aggregating or paging, which is what the truncation notice tells
/// it to do.
pub const DEFAULT_MCP_MAX_ROWS: u32 = 200;

/// Highest row cap any source may set. Well past what any client accepts in
/// one result; it exists so a hand-edited `profiles.json` cannot ask the
/// sidecar to buffer and serialise an unbounded result.
pub const MAX_MCP_MAX_ROWS: u32 = 10_000;

/// Which setting decided an [`McpRowCap`] — named in the truncation notice so
/// the model can tell the user exactly which knob to turn.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpRowCapSource {
    /// The connection's own [`ConnectionProfile::mcp_max_rows`].
    Connection,
    /// The sidecar's `--max-rows` argument, standing in for the preference.
    Flag,
    /// The global `connections.mcpMaxRows` preference.
    Preference,
    /// A managed policy's `mcpMaxRows` ceiling, which was lower than all of
    /// the above.
    Policy,
}

#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
impl McpRowCapSource {
    /// Where a person changes it, in the words the truncation notice uses.
    pub fn describe(self) -> &'static str {
        match self {
            McpRowCapSource::Connection => {
                "this connection's own limit (HuginnDB → Settings → MCP, next to the connection)"
            }
            McpRowCapSource::Flag => "the --max-rows argument in the MCP client's configuration",
            McpRowCapSource::Preference => "the default limit in HuginnDB → Settings → MCP",
            McpRowCapSource::Policy => {
                "the organization's managed policy (mcpMaxRows), which only an administrator can raise"
            }
        }
    }
}

/// The row cap in force for one connection, and what set it.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpRowCap {
    pub rows: u32,
    pub source: McpRowCapSource,
}

/// The one place the MCP row cap is decided.
///
/// The connection's own value wins; without one, the sidecar's `--max-rows`
/// (a client-wide default someone typed into that client's config) stands in
/// for the global `preference`. Whatever comes out is clamped into
/// `1..=MAX_MCP_MAX_ROWS`, and then a managed policy's ceiling applies on top —
/// it only ever lowers the number, never raises one a person chose below it.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn mcp_max_rows(
    profile: Option<&ConnectionProfile>,
    preference: u32,
    flag: Option<u32>,
    policy: Option<u32>,
) -> McpRowCap {
    let (rows, source) = match (profile.and_then(|p| p.mcp_max_rows), flag) {
        (Some(rows), _) => (rows, McpRowCapSource::Connection),
        (None, Some(rows)) => (rows, McpRowCapSource::Flag),
        (None, None) => (preference, McpRowCapSource::Preference),
    };
    let rows = rows.clamp(1, MAX_MCP_MAX_ROWS);
    match policy {
        Some(ceiling) if ceiling.max(1) < rows => McpRowCap {
            rows: ceiling.max(1),
            source: McpRowCapSource::Policy,
        },
        _ => McpRowCap { rows, source },
    }
}

/// User-defined connection profile stored on disk.
///
/// Only contains non-sensitive metadata; the matching password is kept in
/// the OS keychain under the account returned by [`Self::keyring_account`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    /// Stable identifier. Generated server-side on first save.
    pub id: String,
    /// User-facing display name.
    pub name: String,
    /// Backend driver.
    pub driver: Driver,
    /// Host or, for SQLite, the empty string.
    pub host: String,
    /// TCP port for server-backed drivers. Ignored for SQLite.
    ///
    /// **Zero means "the driver's default"**, not port zero: nothing can
    /// listen on 0, so the value is free to carry that meaning, and it is what
    /// a blank port field in the connection dialog stores. Never dial this
    /// field directly — go through [`ConnectionProfile::effective_port`], which
    /// resolves it against [`Driver::default_port`].
    pub port: u16,
    /// Database / catalog name. For SQLite this is the filesystem path.
    pub database: String,
    /// Username used at connect-time.
    pub username: String,
    /// Whether the driver should negotiate TLS.
    #[serde(default)]
    pub ssl: bool,
    /// Optional SSH tunnel configuration. When set,
    /// [`crate::db::pool::open_pool`] brings the tunnel up first and points the
    /// driver at `127.0.0.1:<local-port>` — see [`SshTunnel`] and
    /// [`crate::db::ssh`]. Ignored for SQLite (a local file has nothing to
    /// tunnel to).
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnel>,
    /// Raw connection URI, used by MongoDB as the primary connection input.
    /// When set (`mongodb://…` / `mongodb+srv://…`) it is passed verbatim to
    /// the driver and takes precedence over the discrete host/port/database
    /// fields, which Mongo only keeps as best-effort parsed conveniences.
    /// `None` for the SQL drivers, which assemble their URL from the discrete
    /// fields in [`crate::db::pool::build_url`].
    #[serde(default)]
    pub connection_string: Option<String>,
    /// MongoDB `authSource` (the auth database, e.g. `admin`). The form-built
    /// `connection_string` already carries it as a query option; it is stored
    /// separately so the URI-less fallback in [`crate::db::mongo::open_pool`]
    /// (CLI `--auth-source`) and form repopulation have it explicitly. `None`
    /// for the SQL drivers.
    #[serde(default)]
    pub auth_source: Option<String>,
    /// SQL Server-specific settings (named instance, certificate trust, auth
    /// mode). `None` for every other driver, and for a SQL Server profile that
    /// predates the field — [`MsSqlOptions::default`] is the plain
    /// SQL-login-over-an-explicit-port case.
    #[serde(default)]
    pub mssql: Option<MsSqlOptions>,
    /// Session-only profile that must never be persisted to `profiles.json`.
    /// Set for ad-hoc connections opened from the CLI (`--host …`): they live
    /// in `state.profiles` in memory so the explorer / tabs / `pool_for` treat
    /// them like any other connection, but [`crate::store::save_profiles`]
    /// filters them out, so they vanish on the next launch. The matching
    /// password is already in-memory only (handed straight to `connect`), so
    /// nothing about an ephemeral profile ever touches disk or the keychain.
    #[serde(default)]
    pub ephemeral: bool,
    /// Free-text group/folder label for organizing the connection list (e.g.
    /// several drivers/environments for the same client). `None`/empty means
    /// ungrouped. Grouping is purely a display concern — no separate group
    /// registry, just equality-matched on this string in the frontend.
    #[serde(default)]
    pub group: Option<String>,
    /// DataGrip-style subset of databases to show for a multi-DB connection
    /// (#64). `None` (or absent) means "show all" — the historical behaviour;
    /// `Some(names)` restricts the multi-DB explorer to those databases and
    /// scopes the background warm to them. Purely a frontend display/perf
    /// concern; the backend stores it opaquely and never acts on it.
    #[serde(default)]
    pub visible_databases: Option<Vec<String>>,
    /// How far the MCP connector may write to this connection (#1.9.0). Absent
    /// / `None` on older profiles is treated as [`McpWritePolicy::ReadOnly`] —
    /// the safe default, so an upgrade never silently grants write access.
    /// Only the headless sidecar's enforcement path reads this; the desktop
    /// app stores it opaquely. See [`McpWritePolicy`].
    #[serde(default)]
    pub mcp_write: McpWritePolicy,
    /// Ceiling on how many simultaneous connections HuginnDB may hold against
    /// this server, overriding the global `connections.maxConnections`
    /// preference. `None` (the default, and every profile written before this
    /// field existed) means "use the preference".
    ///
    /// Connection capacity is a fact about a *server*, not about a session,
    /// which is why it lives on the profile rather than in `prefs.json`:
    /// a shared staging box that tolerates three sessions needs that recorded
    /// next to its host and port. Two things fall out of that placement for
    /// free — it exports/imports with the profile ([`crate::transfer`]) and
    /// syncs through shared origins, and the headless MCP sidecar honours it
    /// without any extra plumbing, because it reads the same `profiles.json`.
    ///
    /// Clamped at use time by [`crate::db::pool::PoolLimits`]; a value below
    /// the floor there is raised rather than rejected, so a hand-edited `0`
    /// can't produce a pool that deadlocks.
    #[serde(default)]
    pub max_connections: Option<u32>,
    /// Ceiling, in seconds, for a single read-only introspection call against
    /// this server — overriding the global `connections.operationTimeoutSecs`
    /// preference. `None` (the default, and every profile written before this
    /// field existed) means "use the preference".
    ///
    /// It exists because 20 seconds is a guess about *someone else's* server.
    /// A SQL Server holding several hundred databases answers `list_databases`
    /// — a `HAS_DBACCESS` per database, possibly after opening a fresh session
    /// — in well over that, and the failure looks exactly like a broken
    /// connection to the person trying to expand the tree. Nothing about the
    /// query can be made faster from here, so the ceiling has to be the user's.
    ///
    /// Same placement argument as [`Self::max_connections`], and for the same
    /// reason: how long a server takes to answer is a fact about the *server*,
    /// so it belongs next to its host and port. It exports and imports with the
    /// profile ([`crate::transfer`]), syncs through shared origins, and the
    /// headless MCP sidecar honours it without any extra plumbing because it
    /// reads the same `profiles.json`.
    ///
    /// **Deliberately absent from the sync's preserve list**
    /// (`commands::origins::merge_into`), unlike `mcp_write`, `mcp_exposed`,
    /// `pulse_enabled` and the `ai_*` pair. Those are local decisions about
    /// trust or about this machine's resources, which a publisher cannot know.
    /// This one describes the shared server, which is precisely what the
    /// publisher *does* know — so a refresh is allowed to correct it.
    ///
    /// Clamped at use time by [`crate::db::pool::operation_timeout`]; a
    /// hand-edited `0` is raised to the floor rather than making every
    /// introspection call fail instantly.
    #[serde(default)]
    pub operation_timeout_secs: Option<u32>,
    /// Id of the shared origin this profile was imported from (#108), or `None`
    /// for a profile the user created locally.
    ///
    /// A profile carrying this is **read-only in the UI**: it is a copy of an
    /// entry in a file somebody else curates, so editing it locally would be
    /// silently undone by the next sync. To vary one, duplicate it — the copy
    /// has no `origin_id` and is an ordinary local profile.
    ///
    /// The backend stores it opaquely and never acts on it beyond the sync
    /// itself; enforcement of the read-only rule is a frontend concern, the
    /// same split as `visible_databases`.
    #[serde(default)]
    pub origin_id: Option<String>,
    /// Whether `pulse::sampler` persists this connection's vital signs into
    /// the on-disk history every `PulsePrefs::history_interval_secs`. Opt-in,
    /// off by default — same reasoning as `mcp_write`: an upgrade must never
    /// silently start polling and storing data about a server the user
    /// didn't ask to be tracked. Unlike `mcp_write`/`visible_databases`, the
    /// backend itself reads this (the sampler, not just a headless sidecar).
    #[serde(default)]
    pub pulse_enabled: bool,
    /// Whether the headless MCP connector may reach this connection at all.
    ///
    /// Opt-in, off by default, for the same reason as `mcp_write` and
    /// `pulse_enabled`: an upgrade must never silently widen what an AI client
    /// can see. Before this field the exposed set lived only in the MCP
    /// client's own config (`--connections <uuid>,<uuid>`), which put the
    /// coarsest and most frequently changed knob in the one place the app
    /// cannot reach — so adding a connection meant looking its uuid up in this
    /// very file and hand-editing a client config, per client, then restarting
    /// it. `mcp_write`, the *more* sensitive half, was already here and already
    /// hot-reloaded; this closes the asymmetry.
    ///
    /// The sidecar re-reads it fresh per call, so ticking the box in
    /// Settings → MCP takes effect without restarting the MCP client, and an
    /// explicit `--connections` on the command line still wins (see
    /// `crate::mcp::Config`).
    ///
    /// **Strictly local, in both directions.** `merge_into` preserves it across
    /// a shared-origin sync and `apply_profile_imports` clears it on import:
    /// which of your servers your AI clients may reach is a decision about
    /// *this* machine, and a publisher two machines away must not be able to
    /// make it — nor a bundle you imported to look at.
    #[serde(default)]
    pub mcp_exposed: bool,
    /// Most rows one MCP tool call may hand an AI client from this connection,
    /// overriding the global `connections.mcpMaxRows` preference. `None` (the
    /// default, and every profile written before this field existed) means
    /// "use the preference".
    ///
    /// Per connection because the right number depends on what the rows *are*:
    /// a lookup table of codes is cheap to read whole, while a table with a
    /// JSON column per row floods the model's context at a few dozen.
    ///
    /// **Strictly local**, like `mcp_write`: how much of a server this
    /// machine's AI clients may read in one go is a decision about this
    /// machine, so `merge_into` preserves it across a shared-origin sync.
    /// Resolved — with the preference, the sidecar's `--max-rows` and a
    /// managed policy's ceiling — only by [`mcp_max_rows`], which also clamps a
    /// hand-edited value into `1..=MAX_MCP_MAX_ROWS`.
    #[serde(default)]
    pub mcp_max_rows: Option<u32>,
    /// Whether the in-app AI panel may reach this connection at all.
    ///
    /// Opt-in, off by default, and strictly local — the same three properties
    /// `mcp_exposed` has, for the same reasons: an upgrade must never silently
    /// widen what a language model can see, and a publisher two machines away
    /// does not get to decide what *this* machine's assistant may read.
    /// [`crate::commands::origins::merge_into`] preserves it across a
    /// shared-origin sync and the bundle import clears it.
    ///
    /// The gate is [`crate::ai::exec::resolve_connection`], which resolves a
    /// model's connection reference *only* among enabled profiles — so a
    /// connection that is off is unreachable by name as well as by id, rather
    /// than reachable-and-then-refused.
    #[serde(default)]
    pub ai_enabled: bool,
    /// Whether row data from this connection may be sent to an **untrusted**
    /// inference endpoint.
    ///
    /// The per-connection half of [`crate::ai`]'s coupling rule, and the reason
    /// that rule needs two axes: "read-only" does not mean "nothing leaves",
    /// because a `SELECT` puts rows in the prompt. A *trusted* endpoint
    /// (loopback, or infrastructure the user has declared as their own) may
    /// read rows without this; anything else gets metadata only until it is
    /// set. See [`crate::ai::scope::DataScope::resolve`].
    ///
    /// Local and off by default, exactly like `ai_enabled` above.
    #[serde(default)]
    pub ai_rows_allowed: bool,
    /// What the *user* knows about this database that its schema does not say.
    ///
    /// The gap it closes is the one thing tools cannot: a model can read every
    /// table and still not know that `cfg_*` holds one row per tenant, that
    /// `status` uses the codes an old system wrote, or that the table everyone
    /// asks about is the one with the least obvious name. A person answering
    /// database questions carries that knowledge; an assistant given a schema
    /// and six steps does not, and it shows up as an answer that fixes on
    /// whichever table the question happened to name.
    ///
    /// Prepended to every prompt for this connection — agent turns and assisted
    /// tasks alike — bounded by `crate::ai::exec::MAX_AI_NOTES_CHARS` so a
    /// pasted-in wiki page cannot crowd out the question.
    ///
    /// Local, like the two flags above, and for a weaker reason: notes describe
    /// the *database*, so a publisher documenting it once for a team is a
    /// genuinely good idea — but that means a field in the origin document and
    /// a schema version, which is its own decision. Until then a refresh must
    /// not erase what the user wrote here.
    #[serde(default)]
    pub ai_notes: Option<String>,
    /// This machine's own password for an origin-owned connection takes
    /// precedence over the one the origin publishes.
    ///
    /// The gap it closes: a shared origin's whole value is that one person
    /// curates the credentials, and its whole failure mode is that the server
    /// resets a password at 9am and everybody is locked out until that person
    /// gets round to republishing. Before this the only thing a consumer could
    /// do was retype the password into the connection dialog on **every single
    /// connect**, for the rest of the day — `connect` takes a password
    /// ad-hoc and persists nothing, and `save_profile` is refused for an
    /// origin-owned profile because the next sync would undo it.
    ///
    /// So the override is deliberately *narrow*: it covers the secret and
    /// nothing else. Host, port, database, user and the rest stay the file's to
    /// dictate, because those are what "somebody curates this" means; a
    /// password that no longer works is not a curation decision, it is a fact
    /// about the server that the consumer learned first.
    ///
    /// **Strictly local**, like `mcp_write` / `mcp_exposed` / `pulse_enabled`
    /// and preserved by `merge_into` for the same reason — with one difference
    /// that matters: those three are permanent local decisions, and this one
    /// **expires**. See [`SecretOverride::supersedes`].
    #[serde(default)]
    pub secret_override: Option<SecretOverride>,
    /// The database user **this person** signs in as, in place of the one a
    /// shared origin publishes — phase 3 of managed policy
    /// (`docs/POLICY_ROADMAP.md` §7): with a database user per person, the
    /// database itself enforces what the policy says, and a shared password
    /// that could open another client never has to reach the workstation.
    ///
    /// Strictly local, like `secret_override`: `merge_into` clears it on every
    /// incoming row and restores this machine's value, and neither an origin
    /// file nor an export carries it. A managed policy can pin the user
    /// instead (a rule's `dbUser`), which wins over this —
    /// [`crate::credentials::effective_profile`] is the one place that decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_username: Option<String>,
}

/// A consumer's own password standing in for the one a shared origin publishes.
///
/// See [`ConnectionProfile::secret_override`] for why it exists. This type is
/// only about *when it stops*: an override that never expired would mean a
/// publisher could fix the credential for the whole team and one machine would
/// quietly keep failing with a stale password nobody remembers typing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretOverride {
    /// The published ciphertext fingerprint
    /// ([`crate::transfer::secrets_fingerprint`]) that was in force when the
    /// user took over, or `None` when the origin published no usable secret
    /// for this connection at the time.
    ///
    /// The override holds for exactly as long as the origin keeps publishing
    /// *this* ciphertext, and the next sync that brings a different one drops
    /// it and lands the published secret instead: the publisher has since
    /// answered the question the override was a stopgap for.
    ///
    /// The known cost of comparing ciphertext rather than plaintext is a
    /// passphrase **rotation**, which re-encrypts every envelope in the
    /// document without changing a single password. Every override on that
    /// origin expires with it, and the consumer is back to the shared
    /// credential — the state they were in before overriding. That is the
    /// wrong answer in a case that is rare, publisher-initiated and visible
    /// (the sync reports it), and the alternative is keeping password-derived
    /// material in `profiles.json`, which is a file that is guaranteed to hold
    /// no secrets.
    pub supersedes: Option<String>,
    /// RFC 3339, for the banner that says how long this machine has been
    /// running on its own credential. Display only — nothing branches on it.
    pub set_at: String,
}

/// How the client decides whether to trust the SSH server's host key.
///
/// `AcceptNew` mirrors `ssh -o StrictHostKeyChecking=accept-new`: trust on
/// first use, then strict afterwards. `Strict` requires a pre-existing
/// fingerprint in `known_hosts.json`. `AcceptAny` skips verification.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    Strict,
    /// Trust-on-first-use: an unknown host is recorded, a *changed* key is
    /// refused. The `Default` because it is the only setting that is both
    /// usable without a manual known-hosts step and still detects a MITM on
    /// every subsequent connect.
    #[default]
    AcceptNew,
    AcceptAny,
}

/// Authentication method used to log into the SSH server.
///
/// The matching secret (password or private-key passphrase) is **not**
/// stored here — it lives in the OS keychain under the account returned by
/// [`ConnectionProfile::ssh_keyring_account`]. Storing only metadata keeps
/// the on-disk profile free of plaintext credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuth {
    /// Authenticate with a password. Secret is the SSH password.
    Password,
    /// Authenticate with a private-key file. Secret is the (optional)
    /// passphrase for the key; an empty string means no passphrase.
    Key { path: String },
}

/// SSH tunnel configuration attached to a [`ConnectionProfile`].
///
/// When present, [`crate::db::pool::open_pool`] opens a local TCP listener
/// that proxies into the remote `(profile.host, profile.port)` over an
/// SSH `direct-tcpip` channel before pointing `sqlx` at `127.0.0.1`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnel {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// Local port to bind for the tunnel listener. `0` asks the OS to pick
    /// a free ephemeral port; the actual port is returned on the
    /// [`crate::db::ssh::SshTunnelHandle`].
    #[serde(default)]
    pub local_port: u16,
    /// Host-key trust policy. Older profiles without this field default to
    /// [`HostKeyPolicy::AcceptNew`] for ergonomic backwards compatibility.
    #[serde(default)]
    pub host_key_policy: HostKeyPolicy,
}

impl ConnectionProfile {
    /// Everything that decides *where* and *as whom* a pool for this profile
    /// signs in, rendered as one comparable string.
    ///
    /// A pool is opened once and then reused by id, so without this nothing
    /// noticed when the profile behind a live pool was edited: pointing a
    /// connection from `db-1` to `db-2` in HuginnDB left the MCP connector
    /// answering from `db-1` until its client was restarted. The pool records
    /// this value when it opens ([`ActivePool::dialed`]) and whoever reuses it
    /// compares ([`ActiveConnections::redialed`]).
    ///
    /// Deliberately an allowlist of the fields the drivers dial with. Name,
    /// group, colour and every local flag (`mcp_*`, `pulse_enabled`, `ai_*`)
    /// can change without making an open session wrong, and closing a
    /// connection because it was renamed would be its own bug. The password is
    /// not here either: it lives in the keychain, and a session that already
    /// authenticated stays valid when it changes, exactly as in the app.
    ///
    /// Call it on the [`crate::credentials::effective_profile`], so a personal
    /// database user taking effect counts as a change of `username`.
    pub fn dial_target(&self) -> String {
        serde_json::json!([
            self.driver,
            self.host,
            self.port,
            self.database,
            self.username,
            self.ssl,
            self.ssh_tunnel,
            self.connection_string,
            self.auth_source,
            self.mssql,
        ])
        .to_string()
    }

    /// Key under which the password is stored in the OS keychain.
    ///
    /// We include the profile id so multiple profiles for the same user
    /// don't collide on shared hosts.
    ///
    /// Keyed by `username` as it stands on *this* value. Connecting goes
    /// through [`crate::credentials::effective_profile`] first, so a person's
    /// own user keys their own password (`id::alopez`) and never the one a
    /// shared origin lands (`id::erp_app`).
    pub fn keyring_account(&self) -> String {
        format!("{}::{}", self.id, self.username)
    }

    /// The port this profile actually connects to.
    ///
    /// A profile may legitimately carry no port at all — the dialog's port
    /// field can be left blank, the CLI's `--port` is optional, and an
    /// imported or origin-synced profile can simply omit it — and all three
    /// land here as `0`. Until 1.27.0 that zero was dialled verbatim: the URL
    /// builders wrote `host:0`, `tiberius` was handed `Config::port(0)`, and
    /// the user got a connection refused naming a port they never typed.
    ///
    /// Resolving it here rather than at save time is what keeps the stored
    /// profile honest: `profiles.json` records that the user did not choose a
    /// port, so the profile follows the driver's default if it ever moves,
    /// and a shared origin does not propagate a number its publisher never
    /// entered.
    ///
    /// SQLite has no port; it returns `0`, which no SQLite code path reads.
    pub fn effective_port(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        self.driver.default_port().unwrap_or(0)
    }

    /// Key under which the SSH secret (password or key passphrase) is
    /// stored in the OS keychain, namespaced so it cannot collide with the
    /// database password account.
    pub fn ssh_keyring_account(&self) -> Option<String> {
        self.ssh_tunnel
            .as_ref()
            .map(|t| format!("{}::ssh::{}", self.id, t.username))
    }
}

/// Live, driver-typed pool for an active connection.
///
/// `Clone` here is cheap because the inner `sqlx` pools share their state
/// behind an `Arc`.
#[derive(Clone)]
pub enum DbPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
    /// A MongoDB client bound to a target database. Unlike the `sqlx` pools
    /// this is not a SQL connection pool — the driver manages its own internal
    /// connection pooling — but it is `Clone` (cheap, `Arc`-backed) so it slots
    /// into the same [`ActiveConnections`] map and `pool_for` lookup pattern.
    Mongo(MongoConn),
    /// A SQL Server session pool (see [`crate::db::mssql::MsSqlPool`]). Not a
    /// `sqlx` pool — `tiberius` has none of its own, so this is ours — but
    /// `Clone` and `Arc`-backed like the rest, so it slots into
    /// [`ActiveConnections`] unchanged.
    MsSql(crate::db::mssql::MsSqlPool),
}

impl DbPool {
    /// Connections this pool holds open against its server right now — the
    /// number the server itself would count, as opposed to the *reservation*
    /// its endpoint grant makes (a ceiling the pool may never reach). `None`
    /// for SQLite, which has no server.
    ///
    /// A Mongo view shares its parent's client, so it reports the client's
    /// whole count; callers that sum must skip views (they hold no grant).
    pub fn open_connections(&self) -> Option<u32> {
        match self {
            Self::Postgres(p) => Some(p.size()),
            Self::Mysql(p) => Some(p.size()),
            Self::Sqlite(_) => None,
            Self::Mongo(c) => Some(c.sockets.load(std::sync::atomic::Ordering::Relaxed)),
            Self::MsSql(p) => Some(p.open_sessions()),
        }
    }

    /// The wire name of the driver behind this pool — see
    /// [`Driver::wire_name`], which this mirrors for the runtime side.
    pub fn driver_name(&self) -> &'static str {
        match self {
            Self::Postgres(_) => Driver::Postgres.wire_name(),
            Self::Mysql(_) => Driver::Mysql.wire_name(),
            Self::Sqlite(_) => Driver::Sqlite.wire_name(),
            Self::Mongo(_) => Driver::Mongo.wire_name(),
            Self::MsSql(_) => Driver::MsSql.wire_name(),
        }
    }
}

/// A live MongoDB client plus the database a given connection handle targets.
///
/// A single [`mongodb::Client`] can reach every database in the cluster, so
/// the per-database "views" the explorer opens (mirroring the SQL
/// `<id>::db::<name>` synthetic connections) reuse the parent's client and
/// only re-tag `database`. The parent connection's `database` is the URI's
/// default database (often `None` → "let me pick a database from the tree").
#[derive(Clone)]
pub struct MongoConn {
    pub client: MongoClient,
    pub database: Option<String>,
    /// Pooled connections the driver has open right now, kept by a CMAP event
    /// handler on the client (see `db::mongo::open_pool`). The driver exposes
    /// no pool size of its own. Shared by every view of the same client,
    /// exactly as the client is — which is why only the parent is counted in
    /// the footprint ([`DbPool::open_connections`]'s callers group by the
    /// endpoint grant, which views do not hold).
    pub sockets: Arc<std::sync::atomic::AtomicU32>,
}

// ---------------------------------------------------------------------------
// Synthetic per-database connection ids
// ---------------------------------------------------------------------------

/// Separator between a profile id and a database name in the synthetic
/// connection id `commands::connection::open_database_view` registers for a
/// per-database browse session on a server-wide connection.
///
/// One spelling, here. The helpers below are the *only* things that should know
/// this string: it used to be written out at eight sites across four layers
/// (`state`, `db::pool`, `pool_reaper`, `bridge::server`), each re-deriving
/// "is this a view?" or "what is the parent?" by hand. This lives in `state`
/// rather than beside `open_database_view` because `db::pool` and `pool_reaper`
/// are *below* `commands` and must not depend upward; `commands::connection`
/// re-exports the two it had so its public paths keep working.
pub const DB_VIEW_SEP: &str = "::db::";

/// Synthetic connection id for a per-database browse session under `parent_id`.
///
/// Format is stable so callers can derive the id without a round-trip when they
/// only need to address an already-open child.
pub fn database_view_id(parent_id: &str, database: &str) -> String {
    format!("{parent_id}{DB_VIEW_SEP}{database}")
}

/// The id prefix shared by every per-database view under `parent_id`, for
/// `starts_with` scans over the live connection map.
pub fn database_view_prefix(parent_id: &str) -> String {
    format!("{parent_id}{DB_VIEW_SEP}")
}

/// Split a synthetic id into `(parent profile id, database name)`, or `None`
/// for a plain top-level id.
///
/// Splits at the *first* separator: a database whose own name contains the
/// separator would otherwise re-parent the id (see `PoolOwnership::for_id`'s
/// test, which pins this).
pub fn split_database_view(id: &str) -> Option<(&str, &str)> {
    id.split_once(DB_VIEW_SEP)
}

/// Whether `id` names a synthetic per-database view rather than a profile.
pub fn is_database_view(id: &str) -> bool {
    id.contains(DB_VIEW_SEP)
}

/// The *profile* id behind a connection id: `id` itself for a plain one, the
/// parent for a synthetic `<parent>::db::<database>` child.
///
/// Rust twin of `lib/connectionLabel.ts`'s `parentConnectionId` (ADR #36).
pub fn parent_connection_id(id: &str) -> &str {
    match split_database_view(id) {
        Some((parent, _)) => parent,
        None => id,
    }
}

/// Monotonic milliseconds since the first call, used to timestamp pool usage.
///
/// Deliberately not wall-clock: the reaper compares ages, and a system clock
/// that jumps (NTP correction, suspend/resume, a user changing the timezone)
/// would make a `SystemTime` delta either negative or enormous, and reap live
/// pools out from under an active session either way.
pub fn now_millis() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// Who asked for a pool, and therefore what is allowed to close it.
///
/// The distinction did not exist before the MCP bridge shipped, and
/// [`crate::pool_reaper`] leans on its absence: it never reaps a *top-level*
/// pool, on the stated grounds that such a pool represents a connection the
/// user opened explicitly and the UI shows as connected, so closing one behind
/// their back would be a lie.
///
/// A pool [`crate::bridge::server`] opened on a sidecar's behalf falsifies
/// every clause of that. The user did not open it, no window shows it (the
/// frontend deliberately does not listen for `connection-opened` — see
/// `src/lib/bridges/connection-sync-bridge.ts`), nobody will ever disconnect
/// it, and `release_idle_pools` skips top-level pools by contract. Until this
/// marker existed, restarting the app was the only thing that released one.
/// See ADR #67.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolOrigin {
    /// A connection a human opened. Lives until an explicit `disconnect`.
    ///
    /// The deliberately conservative default: a call site that forgets to
    /// classify itself leaks a pool, which is recoverable, rather than having
    /// the reaper close a connection a window is showing as live.
    User,
    /// Opened by the bridge because an MCP client asked for it. Reaped once
    /// idle — which is what the sidecar already does to the equivalent pool
    /// when it owns one itself (`mcp::spawn_idle_pool_reaper`).
    Bridge,
}

/// A live database pool plus, optionally, the SSH tunnel that fronts it.
///
/// Kept together so the tunnel is dropped (and its local listener freed)
/// exactly when the pool itself is removed from [`ActiveConnections`]. The
/// `_ssh` handle is owned uniquely by this struct; the pool may still be
/// cloned out for query workers via [`ActiveConnections::get`].
pub struct ActivePool {
    pub pool: DbPool,
    pub _ssh: Option<crate::db::ssh::SshTunnelHandle>,
    /// Background keepalive ping (see [`crate::keepalive`]). `None` for the
    /// synthetic per-database pools opened by `open_database_view`, which
    /// deliberately don't get their own heartbeat.
    pub _keepalive: Option<crate::keepalive::KeepaliveHandle>,
    /// This pool's reservation against its server's connection budget (see
    /// [`crate::db::endpoint`]). `None` for the pools that spend no budget: a
    /// SQLite file, and a Mongo per-database view that reuses its parent's
    /// client.
    ///
    /// Held here purely so it lives exactly as long as the pool does — the
    /// grant releases on `Drop`, which is what keeps the four different
    /// removal paths from having to remember to give the budget back.
    pub _endpoint: Option<crate::db::endpoint::EndpointGrant>,
    /// [`now_millis`] at the last [`ActiveConnections::get`] — i.e. the last
    /// time any command resolved this pool in order to use it.
    ///
    /// `Arc<AtomicU64>` rather than a plain field for two reasons: `get` takes
    /// `&self` (every command path goes through a read lock, and taking a
    /// write lock just to stamp a timestamp would serialise all query
    /// dispatch), and the keepalive task holds a clone so it can skip a tick
    /// whose liveness the user's own traffic already proved.
    ///
    /// Fed by `get`, which is the single choke point every one of the
    /// per-module `pool_for` helpers funnels through — so this stays accurate
    /// without touching any of them.
    pub last_used: Arc<std::sync::atomic::AtomicU64>,
    /// Who asked for this pool. Decides whether the reaper may close it —
    /// see [`PoolOrigin`].
    pub origin: PoolOrigin,
    /// Labels of the windows using this connection right now.
    ///
    /// Every window shares this one process and this one map, so a window
    /// closing used to release nothing: a connection opened from a secondary
    /// window outlived it, invisible (no other window lists a connection it
    /// did not open itself), unreapable (top-level pools a person opened are
    /// never reaped) and kept awake by its keepalive — one socket and possibly
    /// an SSH tunnel per connection, until the app exited. The same shape as
    /// ADR #67, for windows instead of the MCP bridge.
    ///
    /// A window joins when it connects or reuses the connection, and a
    /// detached tab or Pulse window joins when it is created for one. When the
    /// last of them is destroyed the pool is closed (see
    /// [`ActiveConnections::release_window`]). Empty on every pool a window did
    /// not open — `::db::` views, which follow their parent, and bridge pools,
    /// which the reaper owns — and an empty set never triggers a close by
    /// itself; only a window *leaving* does.
    pub holders: std::collections::HashSet<String>,
    /// The profile's [`ConnectionProfile::dial_target`] when this pool was
    /// opened, so a reuse can tell that the profile has been edited since.
    ///
    /// `None` where nobody recorded it — the `::db::` views, which follow
    /// their parent and are closed with it — and a `None` pool is never
    /// called stale: guessing would close pools that are fine.
    pub dialed: Option<String>,
}

impl ActivePool {
    /// A pool with no tunnel and no heartbeat, stamped as used right now — the
    /// shape every synthetic per-database child and every headless (MCP) pool
    /// takes.
    ///
    /// [`PoolOrigin::User`] because that is the conservative default (see the
    /// enum), and because it is *irrelevant* to both shapes this constructor
    /// actually serves: a `::db::` child is reaped by the child sweep, which
    /// keys on the id rather than the origin, and the sidecar's own pools are
    /// reaped origin-blind by [`ActiveConnections::idle_pools`]. Only the
    /// app-side bridge path has to say `Bridge` explicitly, and it builds the
    /// struct with `..ActivePool::bare(pool)` around an override.
    pub fn bare(pool: DbPool) -> Self {
        Self {
            pool,
            _ssh: None,
            _keepalive: None,
            _endpoint: None,
            last_used: Arc::new(std::sync::atomic::AtomicU64::new(now_millis())),
            origin: PoolOrigin::User,
            holders: std::collections::HashSet::new(),
            dialed: None,
        }
    }

    /// The server budget this pool draws on, if it draws on one.
    pub fn endpoint_key(&self) -> Option<&crate::db::endpoint::EndpointKey> {
        self._endpoint.as_ref().map(|g| g.key())
    }

    /// [`now_millis`] value at the last use.
    pub fn last_used_millis(&self) -> u64 {
        self.last_used.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// How long this pool has been idle, as of `now`.
    ///
    /// `now` is passed in rather than read here so the eviction policy is a
    /// pure function of its inputs: [`now_millis`] is anchored to the first
    /// call in the process, which for a unit test is the test itself, leaving
    /// no room to express "this pool was last used ten seconds ago".
    pub fn idle_millis_at(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_used_millis())
    }
}

/// Map of profile-id → live pool.
#[derive(Default)]
pub struct ActiveConnections {
    inner: HashMap<String, ActivePool>,
}

impl ActiveConnections {
    /// Insert or replace a pool for `id`. Any previous pool is dropped,
    /// which tears down its SSH tunnel (if any) before this one starts.
    pub fn insert(&mut self, id: String, pool: ActivePool) {
        self.inner.insert(id, pool);
    }

    /// Remove the pool for `id`, if any. The pool and any associated SSH
    /// tunnel will be dropped (and gracefully closed) when the last clone
    /// goes out of scope.
    ///
    /// Prefer routing removals through [`crate::db::pool::close_pool`] so the
    /// driver gets an awaited, graceful shutdown instead of a bare `Drop` —
    /// see that function's docs for why the difference is load-bearing.
    pub fn remove(&mut self, id: &str) -> Option<ActivePool> {
        self.inner.remove(id)
    }

    /// Cheap, cloning lookup. Pools are themselves cheap to clone; the
    /// tunnel handle stays owned by the [`ActivePool`] so query workers
    /// don't need to know it exists.
    ///
    /// **Also stamps `last_used`.** Every command that touches a database goes
    /// through here (via its module's `pool_for`), which makes this the one
    /// place that can keep the idle reaper honest. A lookup that must *not*
    /// count as use — the reaper's own bookkeeping — reads `inner` directly
    /// through the accessors below instead.
    pub fn get(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).map(|a| {
            a.last_used
                .store(now_millis(), std::sync::atomic::Ordering::Relaxed);
            a.pool.clone()
        })
    }

    /// [`Self::get`] for a background task: the pool, **without** stamping
    /// `last_used`.
    ///
    /// For work nobody asked for — Pulse's sampler — which must not keep a
    /// pool looking busy. Stamping is how the reapers tell a connection in use
    /// from one that can go; a background reader that stamps makes every pool
    /// it touches immortal.
    pub fn peek(&self, id: &str) -> Option<DbPool> {
        self.inner.get(id).map(|a| a.pool.clone())
    }

    /// Synthetic per-database children of `parent_id`, oldest use first.
    ///
    /// The ordering is what makes the per-parent cap an LRU rather than an
    /// arbitrary eviction: callers take from the front.
    pub fn children_by_lru(&self, parent_id: &str) -> Vec<String> {
        let prefix = database_view_prefix(parent_id);
        let mut children: Vec<(&String, u64)> = self
            .inner
            .iter()
            .filter(|(id, _)| id.starts_with(&prefix))
            .map(|(id, active)| (id, active.last_used_millis()))
            .collect();
        // Oldest use first == longest idle first. Ties broken by id so the
        // order is deterministic; a `HashMap` iteration order is not, and an
        // eviction that picks a different victim on each run is untestable and
        // unexplainable to the user.
        children.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        children.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// Every synthetic per-database child pool (any parent) idle for at least
    /// `ttl_millis` as of `now`. Top-level pools are never returned: they
    /// represent a connection the user explicitly opened and are only closed by
    /// an explicit disconnect, or when the last window using them closes (see
    /// [`Self::release_window`]) — never for being idle.
    pub fn idle_children(&self, now: u64, ttl_millis: u64) -> Vec<String> {
        self.inner
            .iter()
            .filter(|(id, active)| is_database_view(id) && active.idle_millis_at(now) >= ttl_millis)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Synthetic per-database views drawing on `key`, longest-unused first.
    ///
    /// Feeds the reclaim step in `open_database_view`: when a server's budget
    /// is spent, closing the view the user looked at least recently is a far
    /// better answer than refusing to open the one they just clicked. Scoped to
    /// a single endpoint on purpose — evicting a view on an unrelated server
    /// would free nothing that the caller is waiting for.
    pub fn views_on_endpoint_by_lru(&self, key: &crate::db::endpoint::EndpointKey) -> Vec<String> {
        let mut views: Vec<(&String, u64)> = self
            .inner
            .iter()
            .filter(|(id, active)| is_database_view(id) && active.endpoint_key() == Some(key))
            .map(|(id, active)| (id, active.last_used_millis()))
            .collect();
        views.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        views.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// Every top-level pool the **bridge** opened that has been idle for at
    /// least `ttl_millis`.
    ///
    /// The app-side counterpart to [`Self::idle_pools`], and deliberately
    /// narrower: the sidecar has no UI contract at all, so origin buys it
    /// nothing and it reaps every idle pool it owns. The app does have one, so
    /// it may only reap the pools no window is showing — the ones opened for a
    /// connector rather than for a person. See [`PoolOrigin`] and ADR #67.
    ///
    /// Reads `inner` directly rather than going through [`Self::get`], which
    /// would stamp the very `last_used` the decision is based on.
    pub fn idle_bridge_pools(&self, now: u64, ttl_millis: u64) -> Vec<String> {
        self.inner
            .iter()
            .filter(|(id, active)| {
                !is_database_view(id)
                    && active.origin == PoolOrigin::Bridge
                    && active.idle_millis_at(now) >= ttl_millis
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Reclassify a bridge-opened pool as one the user opened, handing back
    /// what a keepalive needs to be started for it.
    ///
    /// Called when a human connects to a profile the connector already had
    /// open. From that moment a window *is* showing it, so the reaper must stop
    /// treating it as disposable — and the heartbeat the bridge path
    /// deliberately skipped has to start, or the adopted connection would be
    /// the one connection in the app without lost-connection detection.
    ///
    /// `None` means there was nothing to adopt: no such pool, or one that is
    /// already [`PoolOrigin::User`]. Idempotent, so a second `connect` for the
    /// same profile falls through to the ordinary reuse path.
    pub fn adopt_from_bridge(
        &mut self,
        id: &str,
    ) -> Option<(DbPool, Arc<std::sync::atomic::AtomicU64>)> {
        let active = self.inner.get_mut(id)?;
        if active.origin != PoolOrigin::Bridge {
            return None;
        }
        active.origin = PoolOrigin::User;
        Some((active.pool.clone(), active.last_used.clone()))
    }

    /// Record that the window `label` is using the top-level connection `id`.
    ///
    /// A `::db::` view id is folded to its parent: a window showing a
    /// database is holding the connection that database lives on. Returns
    /// whether there was a pool to hold.
    pub fn hold(&mut self, id: &str, label: &str) -> bool {
        let parent = parent_connection_id(id);
        match self.inner.get_mut(parent) {
            Some(active) => {
                active.holders.insert(label.to_string());
                true
            }
            None => false,
        }
    }

    /// Forget the window `label` everywhere, and return the top-level
    /// connections a **person** opened that no window is using any more.
    ///
    /// The caller closes them; this only decides, without I/O, so the rule is
    /// testable on its own. Only a pool that *lost* its last holder here is
    /// returned — one that never had any (a bridge pool, a pool from before a
    /// window could be recorded) is not this window's to close.
    pub fn release_window(&mut self, label: &str) -> Vec<String> {
        let mut orphaned: Vec<String> = self
            .inner
            .iter_mut()
            .filter(|(id, _)| !is_database_view(id))
            .filter_map(|(id, active)| {
                let was_held = active.holders.remove(label);
                (was_held && active.holders.is_empty() && active.origin == PoolOrigin::User)
                    .then(|| id.clone())
            })
            .collect();
        orphaned.sort();
        orphaned
    }

    /// Connections actually open per server, summed over the pools that hold a
    /// budget grant there. Pools without one are skipped on purpose: SQLite
    /// has no server, and a Mongo view shares its parent's client, so counting
    /// it would count the parent's sockets twice.
    pub fn open_by_endpoint(&self) -> HashMap<crate::db::endpoint::EndpointKey, u32> {
        let mut open: HashMap<crate::db::endpoint::EndpointKey, u32> = HashMap::new();
        for active in self.inner.values() {
            let (Some(key), Some(n)) = (active.endpoint_key(), active.pool.open_connections())
            else {
                continue;
            };
            *open.entry(key.clone()).or_insert(0) += n;
        }
        open
    }

    /// Local port of the SSH tunnel fronting the pool `id`, if it has one.
    /// What a per-database view dials to ride its parent's tunnel instead of
    /// opening its own (see `db::pool::TunnelRoute::Through`).
    pub fn tunnel_port(&self, id: &str) -> Option<u16> {
        self.inner
            .get(id)
            .and_then(|active| active._ssh.as_ref())
            .map(|tunnel| tunnel.local_port)
    }

    /// Every id in the map, views first, for the exit sweep: a view rides on
    /// its parent's SSH tunnel, so it has to close while that tunnel is up.
    pub fn take_all_views_first(&mut self) -> Vec<(String, ActivePool)> {
        let mut all: Vec<(String, ActivePool)> = self.inner.drain().collect();
        all.sort_by_key(|(id, _)| !is_database_view(id));
        all
    }

    /// Give a pool the heartbeat it did not have. Only [`Self::adopt_from_bridge`]
    /// needs this: every other pool decides its keepalive when it is inserted.
    pub fn attach_keepalive(
        &mut self,
        id: &str,
        keepalive: Option<crate::keepalive::KeepaliveHandle>,
    ) {
        if let Some(active) = self.inner.get_mut(id) {
            active._keepalive = keepalive;
        }
    }

    /// How many live top-level pools the bridge opened. Feeds the pool
    /// footprint in Settings → Connections, which otherwise cannot answer
    /// "how many of these did the MCP connector open?".
    pub fn bridge_connections(&self) -> usize {
        self.inner
            .iter()
            .filter(|(id, active)| !is_database_view(id) && active.origin == PoolOrigin::Bridge)
            .count()
    }

    /// Every pool — top-level included — idle for at least `ttl_millis`.
    ///
    /// Only the headless MCP sidecar uses this: it has no user watching a
    /// connection indicator, so an untouched pool there is pure cost, whoever
    /// asked for it — which is why this one stays origin-blind while the app's
    /// [`Self::idle_bridge_pools`] does not. The desktop app deliberately keeps
    /// the top-level pools a *person* opened until disconnect — hence the
    /// dead-code allowance in a normal `pnpm tauri:build`, matching the
    /// `McpWritePolicy` helpers above.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    pub fn idle_pools(&self, now: u64, ttl_millis: u64) -> Vec<String> {
        self.inner
            .iter()
            .filter(|(_, active)| active.idle_millis_at(now) >= ttl_millis)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// How many pools are live right now, split into top-level and synthetic
    /// per-database children. Feeds the connection-limit error message, which
    /// is only actionable if it can tell the user what HuginnDB itself holds.
    pub fn counts(&self) -> (usize, usize) {
        let children = self.inner.keys().filter(|id| is_database_view(id)).count();
        (self.inner.len() - children, children)
    }

    /// Whether `id` already has a live pool. Used by `connect` to make
    /// re-connecting to an already-active profile from a second window a
    /// no-op instead of tearing down the first window's pool (and any SSH
    /// tunnel) via [`Self::insert`]'s replace semantics.
    pub fn contains(&self, id: &str) -> bool {
        self.inner.contains_key(id)
    }

    /// The origin of the pool for `id` when it was opened for a different
    /// [`ConnectionProfile::dial_target`] than `target` — i.e. the profile was
    /// edited while the pool stayed open, and reusing it would answer from
    /// the old server, database or user. `None` when there is no pool, when it
    /// matches, or when it never recorded what it dialed.
    ///
    /// Returns the origin rather than a bool because the two callers may only
    /// act on what is theirs: the sidecar owns every pool it holds, the app's
    /// bridge only the ones no window is showing.
    pub fn redialed(&self, id: &str, target: &str) -> Option<PoolOrigin> {
        let active = self.inner.get(id)?;
        let dialed = active.dialed.as_deref()?;
        (dialed != target).then_some(active.origin)
    }

    /// Of `targets` (profile id, current [`ConnectionProfile::dial_target`]),
    /// the ids whose open pool a **person** opened for a different target —
    /// the connections a window is still showing with settings the profile no
    /// longer has. Bridge pools are left out: the bridge reopens those itself
    /// on its next call.
    pub fn redialed_by_people<'a>(
        &self,
        targets: impl IntoIterator<Item = (&'a str, String)>,
    ) -> Vec<String> {
        targets
            .into_iter()
            .filter(|(id, target)| self.redialed(id, target) == Some(PoolOrigin::User))
            .map(|(id, _)| id.to_string())
            .collect()
    }

    /// Ids of every currently active connection.
    pub fn ids(&self) -> Vec<String> {
        self.inner.keys().cloned().collect()
    }
}

/// Arguments parsed from the command line at startup.
///
/// Passed to [`AppState::new_with_args`] and stored so the frontend can
/// retrieve them via the `get_startup_args` command after hydration. Fields
/// are all `Option` / `bool` so the struct is self-describing and the
/// frontend knows which flags were actually supplied.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct StartupArgs {
    /// Name or UUID of an existing saved profile to connect to automatically.
    pub connect_profile: Option<String>,
    /// When `true`, `connect_profile` is a UUID rather than a display name.
    pub connect_by_id: bool,
    // Ad-hoc connection parameters (no saved profile required).
    pub adhoc_host: Option<String>,
    pub adhoc_port: Option<u16>,
    pub adhoc_database: Option<String>,
    pub adhoc_username: Option<String>,
    /// One of "postgres", "mysql", "sqlite", "mongodb".
    pub adhoc_driver: Option<String>,
    /// Raw connection URI for an ad-hoc connection (`--uri` /
    /// `--connection-string`). The primary way to reach MongoDB — especially
    /// Atlas `mongodb+srv://` — from the CLI, where the discrete host/port
    /// fields can't express an SRV seed list or URI options. When present and
    /// no `--driver` is given, the driver defaults to `mongodb`.
    pub adhoc_connection_string: Option<String>,
    /// MongoDB `authSource` supplied via `--auth-source`. Folded into the
    /// assembled URI when no `--uri` is given (the URI-less ad-hoc path).
    pub adhoc_auth_source: Option<String>,
    /// Display name for the ad-hoc connection.
    pub adhoc_name: Option<String>,
    /// Optional password supplied via `--password`/`--pass`. Opt-in and kept
    /// only in memory for this launch: it is handed straight to `connect` and
    /// never persisted to the OS keychain. When absent, the password is
    /// resolved from the keychain (saved profile) or requested via the
    /// `ConnectPasswordDialog` flow once the app is open.
    pub adhoc_password: Option<String>,
}

/// In-memory, session-only secrets captured when a connection is opened,
/// keyed by profile id. Lets child pools (`open_database_view`) reuse a
/// password / SSH secret that was supplied via the CLI or the connect dialog
/// and deliberately never written to the OS keychain. Cleared on disconnect.
#[derive(Clone, Default)]
pub struct SessionSecret {
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
}

/// Top-level state managed by Tauri.
pub struct AppState {
    /// Pools that have been connected this session.
    pub connections: Arc<RwLock<ActiveConnections>>,
    /// Session-only secrets keyed by profile id (see [`SessionSecret`]).
    pub session_secrets: Arc<RwLock<HashMap<String, SessionSecret>>>,
    /// Per-server connection budgets. See [`crate::db::endpoint`] — this is
    /// what stops two profiles pointing at the same host from getting two
    /// independent allowances.
    pub endpoints: Arc<crate::db::endpoint::EndpointRegistry>,
    /// The running MCP bridge listener, when enabled. `None` means the bridge
    /// is off and any sidecar falls back to its own pools.
    ///
    /// A `parking_lot::Mutex` rather than an `RwLock` because it is only ever
    /// swapped, never read concurrently under load; dropping the handle is what
    /// stops the listener and removes the discovery file.
    pub mcp_bridge: parking_lot::Mutex<Option<crate::bridge::server::BridgeHandle>>,
    /// Persisted profiles loaded from disk.
    pub profiles: Arc<RwLock<Vec<ConnectionProfile>>>,
    /// User-tunable preferences loaded from `prefs.json`.
    pub prefs: Arc<RwLock<crate::prefs::Preferences>>,
    /// Per-connection tab state loaded from `tab_state.json`.
    pub tab_state: Arc<RwLock<crate::tab_state::PersistedTabState>>,
    /// User-defined JSON Schema library loaded from `json_schemas.json`.
    ///
    /// Global rather than per environment, and in a file of its own rather than
    /// in `prefs.json` — see [`crate::json_schemas`] for both arguments.
    pub json_schemas: Arc<RwLock<crate::json_schemas::JsonSchemaLibrary>>,
    /// Trusted SSH host-key fingerprints loaded from `known_hosts.json`.
    /// Shared with every SSH tunnel opened during the session.
    pub known_hosts: crate::ssh_known_hosts::SharedKnownHosts,
    /// CLI arguments parsed before the Tauri builder ran.
    pub startup_args: StartupArgs,
    /// Connection intent forwarded by a *second* launch (see the
    /// single-instance handler in `lib.rs`). Buffered here because Tauri
    /// events are not replayed: if the second launch lands while the window
    /// is still booting, a listener attached afterwards would miss the
    /// `huginndb://cli-connect` event. The frontend drains this via
    /// `take_pending_cli_connect` once its bridge is mounted, then relies on
    /// the live event for every subsequent launch.
    pub pending_cli_connect: Arc<RwLock<Option<StartupArgs>>>,
    /// Connection intent stashed for a freshly-opened secondary window,
    /// keyed by its Tauri window label. Populated by `open_new_window` and
    /// drained exactly once by `take_window_startup_intent` when that
    /// window's frontend boots.
    pub window_startup_intents: Arc<RwLock<HashMap<String, StartupArgs>>>,
    /// Serialized `AppTab` payload for a freshly-opened detached-tab window
    /// (the "pop out to a real OS window" action), keyed by its Tauri window
    /// label. Kept as an opaque `serde_json::Value` — the shape is owned by
    /// the frontend's `AppTab` type and this state never inspects it (see
    /// gotcha #14 on why a typed intermediate would silently drop
    /// fields). Populated by `open_tab_window` and drained exactly once by
    /// `take_detached_tab_intent` when that window's frontend boots.
    pub detached_tab_intents: Arc<RwLock<HashMap<String, serde_json::Value>>>,
    /// Connection id a freshly-opened Pulse window should measure, keyed by its
    /// Tauri window label. A plain `String` rather than a serialized tab
    /// because Pulse is deliberately *not* a `TabKind` — it never appears in
    /// the workspace, so there is no tab to carry. Populated by
    /// `open_pulse_window` and drained exactly once by
    /// `take_pulse_window_intent` when that window's frontend boots.
    pub pulse_window_intents: Arc<RwLock<HashMap<String, String>>>,
    /// Environment id a freshly-opened secondary window should start on, keyed
    /// by its Tauri window label ("Open environment in new window"). A plain
    /// `String` for the same reason as [`Self::pulse_window_intents`] — the
    /// window only needs to be told *which* environment, and it reads that
    /// environment's own state from `list_environments`. Kept apart from
    /// `window_startup_intents` on purpose: that map carries the CLI's
    /// connection payload, which is applied by a different effect that races
    /// the environment store's `load()`. Populated by `open_new_window` and
    /// drained exactly once by `take_window_environment_intent`.
    pub window_environment_intents: Arc<RwLock<HashMap<String, String>>>,
    /// The `pulse.db` history — opened lazily on first use (a read or the
    /// first sampler tick), not at startup, so an install with Pulse never
    /// enabled never creates the file. See [`crate::pulse::store::PulseStore`].
    pub pulse_store: crate::pulse::store::PulseStore,
    /// The AI panel's last capability probe, or `None` before the first one.
    ///
    /// Cached because the probe costs a real completion against the user's
    /// endpoint — on a local 7B that is seconds, and re-running it every time
    /// the settings panel mounts would make the panel feel broken. Keyed by
    /// [`crate::ai::provider::Endpoint::fingerprint`] inside the report, so a
    /// changed base URL or model invalidates it rather than showing the
    /// previous endpoint's verdict; see [`crate::ai::probe::cached`].
    ///
    /// Session-only, deliberately. Nothing about it goes to disk: the answer is
    /// about a server that may not be up next time, and a stale "agent mode is
    /// available" restored from a file is worse than no answer at all.
    pub ai_probe: Arc<RwLock<Option<crate::ai::probe::ProbeReport>>>,
    /// In-flight AI turns, keyed by the turn id the panel generated, each
    /// holding the handle `ai_cancel` notifies.
    ///
    /// A [`tokio::sync::Notify`] rather than a flag polled between chunks,
    /// because the difference is whether cancellation *works* on the case that
    /// needs it: a model that has stalled sends no chunks, so a polled flag
    /// would not be read again until the read timeout — minutes of a spinner
    /// after the user pressed stop. `commands::ai` selects on this against the
    /// streaming future, and dropping that future closes the socket, which is
    /// what makes the abort real rather than cosmetic.
    pub ai_turns: Arc<RwLock<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// This machine's managed policy (`crate::policy`). Starts unmanaged in
    /// every `AppState`; the desktop app and the MCP sidecar call
    /// `policy::install` on it at startup, so a test never inherits the policy
    /// of the machine it runs on.
    pub policy: crate::policy::SharedPolicy,
    /// One lock per connection id being opened. See [`AppState::open_lock`].
    pub open_locks: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AppState {
    /// The live pool for `id`, or [`AppError::NotConnected`].
    ///
    /// Every command module had a byte-identical private `pool_for` (seven of
    /// them) before this existed. Cloning the `DbPool` out under the read lock
    /// rather than handing back a guard is what keeps the lock off the `await`
    /// points that follow in the caller — the pools are `Arc`-backed, so the
    /// clone is cheap.
    pub fn pool_for(&self, id: &str) -> AppResult<DbPool> {
        self.connections
            .read()
            .get(id)
            .ok_or_else(|| AppError::NotConnected(id.to_string()))
    }

    /// The live MongoDB handle for `id`, for a surface that only exists on
    /// MongoDB (the aggregation editor, the index manager).
    ///
    /// `unsupported` is the whole message for the non-Mongo case, not a
    /// fragment: each caller points the user at the SQL equivalent of its own
    /// feature, and a templated "X is MongoDB-only" would lose that half.
    pub fn mongo_for(&self, id: &str, unsupported: &str) -> AppResult<MongoConn> {
        match self.pool_for(id)? {
            DbPool::Mongo(conn) => Ok(conn),
            _ => Err(AppError::UnsupportedDriver(unsupported.into())),
        }
    }

    /// Load any existing profiles, preferences, and tab state from disk;
    /// failures degrade silently to defaults so a corrupted file doesn't
    /// prevent the app from launching.
    ///
    /// The desktop app always goes through [`Self::new_with_args`]; this
    /// argument-less constructor is the headless MCP binary's entry point.
    #[cfg_attr(not(feature = "mcp"), allow(dead_code))]
    pub fn new() -> Self {
        Self::new_with_args(StartupArgs::default())
    }

    /// The lock that serialises opening the pool for `id`.
    ///
    /// Opening checks the map, then awaits a connect, then inserts — and with
    /// nothing held across that await, two openers of the same id (a window
    /// and the MCP bridge, two sidecars, the tree's expand effect and a
    /// context-menu action) both found it absent and both connected. The second
    /// insert replaced the first pool with a bare `Drop` rather than an awaited
    /// close, so the server briefly saw both. Openers now take this lock
    /// *before* the check, so the second one finds the first one's pool.
    ///
    /// Entries are never removed: there is one per profile and per database
    /// view ever opened, a few bytes each, and removing one safely would need
    /// to know nobody is waiting on it.
    pub fn open_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.open_locks
            .lock()
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Same as [`Self::new`] but attaches pre-parsed CLI arguments so the
    /// frontend can retrieve them via `get_startup_args`.
    pub fn new_with_args(startup_args: StartupArgs) -> Self {
        // Tab state loads first: a v4→v5 migration (origins moving to a
        // global registry, `tab_state`'s module doc) can dedupe two
        // environments' origins that shared a `path`, and the returned remap
        // (old id → surviving id) has to be applied to `profiles.json` — a
        // separate file `tab_state` knows nothing about — before it's read.
        // Without this, a profile synced from the deduped-away id would be
        // left with a dangling `origin_id` pointing at nothing.
        let (tab_state, origin_id_remap) = crate::tab_state::load_tab_state();
        let mut profiles = crate::store::load_profiles().unwrap_or_default();
        if !origin_id_remap.is_empty() {
            let mut changed = false;
            for p in &mut profiles {
                if let Some(old_id) = p.origin_id.clone() {
                    if let Some(new_id) = origin_id_remap.get(&old_id) {
                        p.origin_id = Some(new_id.clone());
                        changed = true;
                    }
                }
            }
            // Best-effort, same philosophy as the rest of this function: a
            // failed save here just means the remap recomputes identically
            // (and re-applies harmlessly) on the next launch, since it's a
            // pure function of the still-unmigrated tab_state.json blob.
            if changed {
                let _ = crate::store::save_profiles(&profiles);
            }
            let _ = crate::tab_state::save_tab_state(&tab_state);
        }
        let prefs = crate::prefs::load_preferences();
        let json_schemas = crate::json_schemas::load_library();
        Self {
            connections: Arc::new(RwLock::new(ActiveConnections::default())),
            session_secrets: Arc::new(RwLock::new(HashMap::new())),
            endpoints: Arc::new(crate::db::endpoint::EndpointRegistry::default()),
            mcp_bridge: parking_lot::Mutex::new(None),
            profiles: Arc::new(RwLock::new(profiles)),
            prefs: Arc::new(RwLock::new(prefs)),
            tab_state: Arc::new(RwLock::new(tab_state)),
            json_schemas: Arc::new(RwLock::new(json_schemas)),
            known_hosts: crate::ssh_known_hosts::load_shared(),
            startup_args,
            pending_cli_connect: Arc::new(RwLock::new(None)),
            window_startup_intents: Arc::new(RwLock::new(HashMap::new())),
            detached_tab_intents: Arc::new(RwLock::new(HashMap::new())),
            pulse_window_intents: Arc::new(RwLock::new(HashMap::new())),
            window_environment_intents: Arc::new(RwLock::new(HashMap::new())),
            pulse_store: crate::pulse::store::PulseStore::new(),
            ai_probe: Arc::new(RwLock::new(None)),
            ai_turns: Arc::new(RwLock::new(HashMap::new())),
            policy: crate::policy::unmanaged(),
            open_locks: parking_lot::Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pool object that never does I/O — these tests only exercise the
    /// bookkeeping. `connect_lazy` still wants a reactor for the pool's own
    /// maintenance task, hence the async tests.
    fn dummy_pool() -> DbPool {
        DbPool::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .connect_lazy("sqlite::memory:")
                .expect("lazy pool construction does not touch the filesystem"),
        )
    }

    // -----------------------------------------------------------------------
    // Which windows hold a connection, and what closing one releases
    // -----------------------------------------------------------------------

    fn held(by: &[&str]) -> ActivePool {
        ActivePool {
            holders: by.iter().map(|s| s.to_string()).collect(),
            ..ActivePool::bare(dummy_pool())
        }
    }

    /// The per-server *open* count beside the reservation. A Mongo view shares
    /// its parent's client and so reports the parent's sockets; it holds no
    /// grant, which is what keeps it from being counted twice.
    #[tokio::test]
    async fn open_connections_are_summed_per_server_without_counting_views_twice() {
        let options = mongodb::options::ClientOptions::parse("mongodb://127.0.0.1:1")
            .await
            .unwrap();
        let client = mongodb::Client::with_options(options).unwrap();
        let sockets = Arc::new(std::sync::atomic::AtomicU32::new(3));
        let conn = |database: Option<&str>| {
            DbPool::Mongo(MongoConn {
                client: client.clone(),
                database: database.map(str::to_string),
                sockets: sockets.clone(),
            })
        };
        let profile = ConnectionProfile {
            driver: Driver::Mongo,
            host: "db".into(),
            port: 27017,
            ..crate::testkit::profile("p")
        };
        let key = crate::db::endpoint::EndpointKey::for_profile(&profile).unwrap();
        let registry = Arc::new(crate::db::endpoint::EndpointRegistry::default());

        let mut conns = ActiveConnections::default();
        conns.insert(
            "p".into(),
            ActivePool {
                _endpoint: Some(registry.reserve(&key, 5, 10, 2).unwrap()),
                ..ActivePool::bare(conn(None))
            },
        );
        conns.insert("p::db::a".into(), ActivePool::bare(conn(Some("a"))));
        // A pool with no server at all contributes nothing.
        conns.insert("lite".into(), ActivePool::bare(dummy_pool()));

        let open = conns.open_by_endpoint();
        assert_eq!(open.get(&key), Some(&3), "the parent's 3, not 3 + 3");
        assert_eq!(open.len(), 1);
    }

    /// Pulse samples every minute through `peek`. If that counted as use, a
    /// bridge pool for a Pulse-enabled profile would never go idle and never be
    /// reaped — ADR #67's permanent pool, by another route.
    #[tokio::test]
    async fn a_background_peek_is_not_use() {
        let mut conns = ActiveConnections::default();
        conns.insert(
            "p".into(),
            ActivePool {
                origin: PoolOrigin::Bridge,
                ..ActivePool::bare(dummy_pool())
            },
        );
        conns
            .inner
            .get("p")
            .unwrap()
            .last_used
            .store(0, std::sync::atomic::Ordering::Relaxed);
        assert!(conns.peek("p").is_some());
        assert_eq!(
            conns.idle_bridge_pools(10_000, 5_000),
            vec!["p".to_string()]
        );
        // Whereas a real lookup is use, and takes it off the reaper's list.
        assert!(conns.get("p").is_some());
        assert!(conns.idle_bridge_pools(now_millis(), 5_000).is_empty());
    }

    #[tokio::test]
    async fn closing_the_only_window_using_a_connection_releases_it() {
        let mut conns = ActiveConnections::default();
        conns.insert("p".into(), held(&["win-1"]));
        assert_eq!(conns.release_window("win-1"), vec!["p".to_string()]);
    }

    #[tokio::test]
    async fn a_connection_another_window_still_uses_survives() {
        let mut conns = ActiveConnections::default();
        conns.insert("p".into(), held(&["main", "win-1"]));
        assert!(conns.release_window("win-1").is_empty());
        // …until that one goes too.
        assert_eq!(conns.release_window("main"), vec!["p".to_string()]);
    }

    #[tokio::test]
    async fn a_window_that_never_held_a_connection_releases_nothing() {
        // A pool no window ever held (the bridge's, or one opened headless)
        // is not any window's to close.
        let mut conns = ActiveConnections::default();
        conns.insert("p".into(), ActivePool::bare(dummy_pool()));
        conns.insert("q".into(), held(&["main"]));
        assert!(conns.release_window("win-1").is_empty());
    }

    #[tokio::test]
    async fn a_bridge_pool_is_left_to_the_reaper() {
        let mut conns = ActiveConnections::default();
        conns.insert(
            "p".into(),
            ActivePool {
                origin: PoolOrigin::Bridge,
                ..held(&["win-1"])
            },
        );
        assert!(conns.release_window("win-1").is_empty());
    }

    // -----------------------------------------------------------------------
    // A pool whose profile was edited while it stayed open
    // -----------------------------------------------------------------------

    #[test]
    fn the_dial_target_moves_with_where_a_pool_signs_in_and_nothing_else() {
        let base = crate::testkit::profile("p");
        let target = base.dial_target();

        // The reported case: same server, another database.
        let moved = ConnectionProfile {
            database: "db-2".into(),
            ..base.clone()
        };
        assert_ne!(moved.dial_target(), target);
        for changed in [
            ConnectionProfile {
                host: "elsewhere".into(),
                ..base.clone()
            },
            ConnectionProfile {
                username: "someone-else".into(),
                ..base.clone()
            },
            ConnectionProfile {
                ssl: !base.ssl,
                ..base.clone()
            },
        ] {
            assert_ne!(changed.dial_target(), target);
        }

        // A rename or a local flag must not close a working session.
        let cosmetic = ConnectionProfile {
            name: "Renamed".into(),
            group: Some("prod".into()),
            mcp_exposed: !base.mcp_exposed,
            pulse_enabled: !base.pulse_enabled,
            ai_enabled: !base.ai_enabled,
            ..base.clone()
        };
        assert_eq!(cosmetic.dial_target(), target);
    }

    #[tokio::test]
    async fn a_pool_is_redialed_only_when_it_recorded_a_different_target() {
        let mut conns = ActiveConnections::default();
        conns.insert(
            "p".into(),
            ActivePool {
                origin: PoolOrigin::Bridge,
                dialed: Some("old".into()),
                ..ActivePool::bare(dummy_pool())
            },
        );
        conns.insert("q".into(), ActivePool::bare(dummy_pool()));

        assert_eq!(conns.redialed("p", "new"), Some(PoolOrigin::Bridge));
        assert_eq!(conns.redialed("p", "old"), None);
        // Nothing recorded: never guessed stale.
        assert_eq!(conns.redialed("q", "anything"), None);
        // No pool at all.
        assert_eq!(conns.redialed("absent", "new"), None);
    }

    #[tokio::test]
    async fn only_a_persons_pool_is_reported_as_edited_under_a_window() {
        let mut conns = ActiveConnections::default();
        for (id, origin) in [("mine", PoolOrigin::User), ("bridge", PoolOrigin::Bridge)] {
            conns.insert(
                id.into(),
                ActivePool {
                    origin,
                    dialed: Some("old".into()),
                    ..ActivePool::bare(dummy_pool())
                },
            );
        }
        conns.insert(
            "fresh".into(),
            ActivePool {
                dialed: Some("same".into()),
                ..ActivePool::bare(dummy_pool())
            },
        );
        let edited = conns.redialed_by_people([
            ("mine", "new".to_string()),
            ("bridge", "new".to_string()),
            ("fresh", "same".to_string()),
            ("closed", "new".to_string()),
        ]);
        assert_eq!(edited, vec!["mine".to_string()]);
    }

    #[tokio::test]
    async fn holding_a_database_view_holds_its_connection() {
        // A detached tab on `p::db::sales` keeps `p` itself alive.
        let mut conns = ActiveConnections::default();
        conns.insert("p".into(), held(&["main"]));
        conns.insert("p::db::sales".into(), ActivePool::bare(dummy_pool()));
        assert!(conns.hold("p::db::sales", "tabwin-1"));
        assert!(conns.release_window("main").is_empty());
        assert_eq!(conns.release_window("tabwin-1"), vec!["p".to_string()]);
        // Nothing to hold when the connection is not open.
        assert!(!conns.hold("absent", "tabwin-2"));
    }

    #[tokio::test]
    async fn the_exit_sweep_takes_views_before_their_parents() {
        let mut conns = ActiveConnections::default();
        conns.insert("p".into(), held(&["main"]));
        conns.insert("p::db::a".into(), ActivePool::bare(dummy_pool()));
        conns.insert("q".into(), held(&["main"]));
        conns.insert("q::db::b".into(), ActivePool::bare(dummy_pool()));
        let order: Vec<bool> = conns
            .take_all_views_first()
            .iter()
            .map(|(id, _)| is_database_view(id))
            .collect();
        assert_eq!(order, vec![true, true, false, false]);
        assert!(conns.ids().is_empty());
    }

    /// Two openers of one id must not both find it absent: the second waits
    /// for the first and then sees its pool.
    #[tokio::test]
    async fn the_open_lock_serialises_openers_of_one_id() {
        let state = Arc::new(AppState::new());
        let first = state.open_lock("p");
        let guard = first.lock().await;
        let s2 = Arc::clone(&state);
        let second = tokio::spawn(async move {
            let lock = s2.open_lock("p");
            let _g = lock.lock().await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!second.is_finished(), "the second opener must wait");
        // A different id is not blocked by it.
        let other = state.open_lock("q");
        assert!(other.try_lock().is_ok());
        drop(guard);
        second.await.unwrap();
    }

    /// Every `profiles.json` on every existing install predates the two AI
    /// flags, and the whole promise is that an upgrade grants a language model
    /// nothing. `#[serde(default)]` is the mechanism; this is the test that
    /// says so, because a field added without it deserialises as an error
    /// rather than as `false` and the failure would be "all my connections
    /// disappeared" (`profiles.json` is the one state file whose parse failure
    /// is deliberately hard).
    #[test]
    fn a_profile_written_before_the_ai_flags_loads_with_them_off() {
        let stored = serde_json::json!({
            "id": "p1",
            "name": "Producción",
            "driver": "postgres",
            "host": "db.internal",
            "port": 5432,
            "database": "shop",
            "username": "reader"
        });
        let profile: ConnectionProfile = serde_json::from_value(stored).expect("must still parse");
        assert!(!profile.ai_enabled);
        assert!(!profile.ai_rows_allowed);
    }

    /// A port left blank in the dialog, omitted by the CLI, or missing from an
    /// imported profile all reach the backend as `0`. Dialling that verbatim
    /// is what produced `host:0` connection refusals; each driver answers with
    /// the number its own documentation calls the default instead.
    #[test]
    fn a_blank_port_resolves_to_the_drivers_default() {
        for (driver, expected) in [
            (Driver::Postgres, 5432),
            (Driver::Mysql, 3306),
            (Driver::Mongo, 27017),
            (Driver::MsSql, 1433),
        ] {
            let profile = ConnectionProfile {
                driver,
                port: 0,
                ..crate::testkit::profile("p")
            };
            assert_eq!(profile.effective_port(), expected, "{driver:?}");
        }
    }

    #[test]
    fn a_port_the_user_typed_is_never_second_guessed() {
        let profile = ConnectionProfile {
            driver: Driver::Postgres,
            port: 6432,
            ..crate::testkit::profile("p")
        };
        assert_eq!(profile.effective_port(), 6432);
    }

    /// SQLite is a file path, not a socket: there is no default to fall back
    /// to and nothing reads the value, so it stays `0` rather than borrowing
    /// another driver's number.
    #[test]
    fn sqlite_has_no_default_port_to_fall_back_to() {
        assert_eq!(Driver::Sqlite.default_port(), None);
        let profile = ConnectionProfile {
            driver: Driver::Sqlite,
            port: 0,
            ..crate::testkit::profile("p")
        };
        assert_eq!(profile.effective_port(), 0);
    }

    fn insert(conns: &mut ActiveConnections, id: &str, origin: PoolOrigin, idle_millis: u64) {
        let active = ActivePool {
            origin,
            ..ActivePool::bare(dummy_pool())
        };
        active.last_used.store(
            1_000_000u64.saturating_sub(idle_millis),
            std::sync::atomic::Ordering::Relaxed,
        );
        conns.insert(id.to_string(), active);
    }

    #[tokio::test]
    async fn idle_bridge_pools_sees_only_top_level_connector_pools() {
        let mut conns = ActiveConnections::default();
        insert(&mut conns, "mine", PoolOrigin::User, 999_999);
        insert(&mut conns, "from-mcp", PoolOrigin::Bridge, 999_999);
        insert(&mut conns, "from-mcp-fresh", PoolOrigin::Bridge, 10);
        // A view under a connector-opened parent is still a view: the child
        // sweep owns it, and this accessor must not double-claim it.
        insert(
            &mut conns,
            "from-mcp::db::sales",
            PoolOrigin::Bridge,
            999_999,
        );

        assert_eq!(
            conns.idle_bridge_pools(1_000_000, 1_000),
            vec!["from-mcp".to_string()]
        );
    }

    #[tokio::test]
    async fn bridge_connections_counts_only_what_the_connector_opened() {
        let mut conns = ActiveConnections::default();
        assert_eq!(conns.bridge_connections(), 0);
        insert(&mut conns, "mine", PoolOrigin::User, 0);
        insert(&mut conns, "from-mcp", PoolOrigin::Bridge, 0);
        insert(&mut conns, "from-mcp::db::sales", PoolOrigin::Bridge, 0);
        assert_eq!(
            conns.bridge_connections(),
            1,
            "one top-level connection, not its views and not the user's own"
        );
        // `counts()` still reports the whole footprint, which is what the
        // connection-limit message needs.
        assert_eq!(conns.counts(), (2, 1));
    }

    #[tokio::test]
    async fn adoption_flips_the_origin_once_and_hands_back_the_stamp() {
        let mut conns = ActiveConnections::default();
        insert(&mut conns, "from-mcp", PoolOrigin::Bridge, 0);
        let (_, stamp) = conns
            .adopt_from_bridge("from-mcp")
            .expect("a connector-opened pool is adoptable");
        // The same Arc the pool carries, so the keepalive the caller starts
        // skips a tick the user's own traffic already proved.
        assert!(Arc::ptr_eq(
            &stamp,
            &conns.inner.get("from-mcp").unwrap().last_used
        ));
        assert!(conns.adopt_from_bridge("from-mcp").is_none());
        assert!(conns.adopt_from_bridge("never-existed").is_none());
    }

    /// Pins the exact JSON the frontend's `profileIntent` sends to
    /// `open_new_window`.
    ///
    /// This is gotcha #14's shape from the other side. `StartupArgs` derives
    /// `Default` but carries no `#[serde(default)]`, and serde only fills a
    /// missing key for `Option` fields — so `connect_by_id`, a bare `bool`,
    /// is *required* in the payload. Omitting it fails the whole deserialize
    /// at the IPC boundary, at runtime, and the new window boots with no
    /// intent while `tsc` sees nothing wrong. The mirror test lives in
    /// `src/lib/cli/startupArgs.test.ts`.
    #[test]
    fn a_profile_intent_from_the_frontend_deserialises() {
        let args: StartupArgs = serde_json::from_value(serde_json::json!({
            "connect_profile": "7f3c-uuid",
            "connect_by_id": true,
            "adhoc_host": null,
            "adhoc_port": null,
            "adhoc_database": null,
            "adhoc_username": null,
            "adhoc_driver": null,
            "adhoc_connection_string": null,
            "adhoc_auth_source": null,
            "adhoc_name": null,
            "adhoc_password": null,
        }))
        .expect("the payload `profileIntent` builds must deserialize");

        assert_eq!(args.connect_profile.as_deref(), Some("7f3c-uuid"));
        assert!(
            args.connect_by_id,
            "by id, not by name — display names are not unique"
        );
        assert!(args.adhoc_password.is_none(), "no secret ever travels here");
    }

    #[test]
    fn a_payload_missing_connect_by_id_is_rejected() {
        // The regression this guards. If serde ever starts tolerating this,
        // the helper's "spell out all eleven fields" rule loses its teeth and
        // the reason for it should be re-examined rather than silently kept.
        let err = serde_json::from_value::<StartupArgs>(serde_json::json!({
            "connect_profile": "7f3c-uuid",
        }));
        assert!(err.is_err(), "a bare `bool` field cannot be defaulted away");
    }

    #[test]
    fn omitted_option_fields_are_none() {
        // The other half of the same rule, and why only `connect_by_id` is the
        // problem: serde does fill a missing `Option` with `None`.
        let args: StartupArgs = serde_json::from_value(serde_json::json!({
            "connect_by_id": false,
        }))
        .expect("Option fields may be omitted");
        assert!(args.connect_profile.is_none());
        assert!(args.adhoc_host.is_none());
    }

    /// The MCP row cap's precedence, in one table: the connection's own value,
    /// then `--max-rows`, then the preference — clamped — and a policy ceiling
    /// that only ever lowers the result.
    #[test]
    fn mcp_row_cap_resolves_connection_then_flag_then_preference_under_policy() {
        use McpRowCapSource::*;
        let with = |rows: Option<u32>| ConnectionProfile {
            mcp_max_rows: rows,
            ..crate::testkit::profile("p")
        };
        let cap = |rows, source| McpRowCap { rows, source };

        assert_eq!(mcp_max_rows(None, 200, None, None), cap(200, Preference));
        assert_eq!(
            mcp_max_rows(Some(&with(None)), 200, None, None),
            cap(200, Preference)
        );
        assert_eq!(
            mcp_max_rows(Some(&with(None)), 200, Some(50), None),
            cap(50, Flag)
        );
        assert_eq!(
            mcp_max_rows(Some(&with(Some(30))), 200, Some(50), None),
            cap(30, Connection),
            "the connection's own limit outranks a client-wide flag"
        );

        // Clamped, so a hand-edited file can neither return nothing nor
        // buffer an unbounded result.
        assert_eq!(
            mcp_max_rows(Some(&with(Some(0))), 200, None, None),
            cap(1, Connection)
        );
        assert_eq!(
            mcp_max_rows(Some(&with(Some(u32::MAX))), 200, None, None),
            cap(MAX_MCP_MAX_ROWS, Connection)
        );

        // A policy ceiling lowers a larger limit and leaves a smaller one.
        assert_eq!(
            mcp_max_rows(Some(&with(Some(500))), 200, None, Some(100)),
            cap(100, Policy)
        );
        assert_eq!(
            mcp_max_rows(Some(&with(Some(20))), 200, None, Some(100)),
            cap(20, Connection)
        );
        assert_eq!(
            mcp_max_rows(None, 200, None, Some(100_000)),
            cap(200, Preference)
        );
    }

    /// A profile written before the field existed has no row cap of its own.
    #[test]
    fn a_profile_without_mcp_max_rows_defers_to_the_preference() {
        let json = serde_json::to_value(crate::testkit::profile("p")).unwrap();
        let mut object = json.as_object().unwrap().clone();
        object.remove("mcp_max_rows");
        let profile: ConnectionProfile =
            serde_json::from_value(serde_json::Value::Object(object)).unwrap();
        assert_eq!(profile.mcp_max_rows, None);
    }

    /// The per-connection MCP policy never split the row writes, and the verb
    /// split must not change what it admits: `data` grants all three together.
    #[test]
    fn mcp_write_policy_grants_the_same_operations_in_verbs() {
        use crate::db::sql::Verbs;

        assert_eq!(McpWritePolicy::ReadOnly.verbs(), Verbs::SELECT);
        assert_eq!(McpWritePolicy::Data.verbs(), Verbs::SELECT | Verbs::WRITES);
        assert_eq!(McpWritePolicy::Full.verbs(), Verbs::ALL);
        for write in [Verbs::INSERT, Verbs::UPDATE, Verbs::DELETE, Verbs::WRITES] {
            assert!(!McpWritePolicy::ReadOnly.allows(write));
            assert!(McpWritePolicy::Data.allows(write));
            assert!(McpWritePolicy::Full.allows(write));
        }
        assert!(!McpWritePolicy::Data.allows(Verbs::DDL));
        assert!(!McpWritePolicy::Data.allows(Verbs::DELETE | Verbs::DDL));
        assert!(McpWritePolicy::Full.allows(Verbs::DDL));
    }
}
