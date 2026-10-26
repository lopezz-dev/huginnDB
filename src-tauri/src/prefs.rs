//! User preferences persisted to disk.
//!
//! Lives next to `profiles.json` in the platform config dir:
//!
//! * Windows — `%APPDATA%\HuginnDB\prefs.json`
//! * Linux   — `$XDG_CONFIG_HOME/HuginnDB/prefs.json`
//! * macOS   — `~/Library/Application Support/HuginnDB/prefs.json`
//!
//! A missing or corrupted file degrades to [`Preferences::default()`] — the
//! user can always relaunch the app even if they hand-edit the JSON into
//! garbage. Writes go through an atomic temp-file rename so a crash mid-save
//! cannot leave a half-written file on Windows.

use crate::ai::scope::EndpointTrust;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// File name used for the persisted preferences blob.
const PREFS_FILE: &str = "prefs.json";

/// Accepts both shapes of the `keybindings` map: the pre-1.19
/// `{"runQuery": "Ctrl+Enter"}` and the current
/// `{"runQuery": ["Mod+Enter", "F9"]}`.
///
/// Keeping the *same* field name (rather than adding a `keybindings2` and
/// deprecating the old one) means an existing `prefs.json` needs no migration
/// pass and no version bump. The cost, accepted knowingly: a downgrade to a
/// build that predates this cannot parse the list form, and since a bad
/// `prefs.json` degrades to `Preferences::default()`, such a downgrade loses
/// *all* preferences rather than just the shortcuts.
fn string_or_vec<'de, D>(deserializer: D) -> Result<HashMap<String, Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }

    let raw: HashMap<String, OneOrMany> = HashMap::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .map(|(k, v)| {
            let list = match v {
                OneOrMany::One(s) => vec![s],
                OneOrMany::Many(v) => v,
            };
            (k, list)
        })
        .collect())
}

/// Top-level preferences blob. Bumped on incompatible schema changes; the
/// `#[serde(default)]` everywhere means older files keep loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub version: u32,
    pub editor: EditorPrefs,
    pub grid: GridPrefs,
    pub ui: UiPrefs,
    /// Where notifications appear, how long they stay and how many are
    /// remembered. See [`NotificationPrefs`].
    pub notifications: NotificationPrefs,
    /// How many database connections HuginnDB is allowed to hold, and for how
    /// long. See [`ConnectionPrefs`].
    pub connections: ConnectionPrefs,
    /// How Pulse's background history sampler behaves. See [`PulsePrefs`].
    pub pulse: PulsePrefs,
    /// Where the AI panel's model lives and how much it is trusted. See
    /// [`AiPrefs`].
    pub ai: AiPrefs,
    /// Whether the theme browser may reach an extension registry, and which
    /// one. See [`ThemePrefs`].
    pub themes: ThemePrefs,
    /// Whether HuginnDB installs updates in the background. See
    /// [`UpdatePrefs`].
    pub updates: UpdatePrefs,
    /// The terminal panel: whether it is offered, and which `mongosh` and
    /// shell it starts. See [`TerminalPrefs`].
    pub terminal: TerminalPrefs,
    /// The app lock's own settings — how long the app may sit idle before it
    /// locks itself. Whether the lock is on is not a preference: it is the
    /// existence of the vault (`crate::vault`). See [`LockPrefs`].
    pub lock: LockPrefs,
    /// User-rebound keyboard shortcuts, keyed by action id (e.g.
    /// `"openSettings"`, `"expandSelectedCell"`) to an ordered list of
    /// bindings (e.g. `["Mod+K"]`, `["Mod+Enter", "F9"]`). The first entry is
    /// the primary one; the rest are aliases that fire just as well, and an
    /// empty list means the user deliberately unbound the action.
    ///
    /// Missing entries fall back to that action's defaults — the frontend's
    /// `ACTIONS` table in `src/lib/keybindings/actions.ts` is the single source
    /// of truth for those, so an empty map here is a perfectly valid,
    /// fully-functional state.
    ///
    /// Pre-1.19 files stored one bare string per action; [`string_or_vec`]
    /// reads those unchanged and folds each into a one-element list. Writes are
    /// always in the list form.
    #[serde(deserialize_with = "string_or_vec")]
    pub keybindings: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorPrefs {
    pub font_family: String,
    pub font_size: u16,
    pub tab_size: u16,
    pub word_wrap: bool,
    pub minimap: bool,
    pub line_numbers: bool,
    pub format_on_paste: bool,
    /// Monaco theme id (e.g. `"huginn-dark"`, `"one-dark-pro"`,
    /// `"github-dark"`, `"vs-light"`). Stringly-typed so the frontend's theme
    /// catalogue stays the single source of truth — the backend just
    /// round-trips whatever id the user picked.
    pub theme: String,
    /// Underline values that violate the JSON Schema bound to their column.
    ///
    /// Three switches rather than one because the language service splits them,
    /// and because a loose schema is useful for completion long before anyone
    /// wants squiggles. This one maps to `schemaValidation`, *not* to
    /// `diagnostics`: silencing the latter would also hide plain syntax errors.
    /// And it never gates a save — the database is the authority.
    pub json_schema_validation: bool,
    /// Offer the bound schema's properties and enum values while typing.
    pub json_schema_completion: bool,
    /// Show a property's schema `description` on hover.
    pub json_schema_hover: bool,
    /// Pretty-print a cell's value the moment the editor (or the preview
    /// panel) opens, per detected content type.
    ///
    /// Three flags rather than one because the types are not one want: someone
    /// who keeps JSON blobs in a column wants those unfolded without also
    /// having their XML reflowed. They are also three so each gets its own
    /// addressable row — `PrefId` derives from these key names, so a nested
    /// object would collapse the three into one command-palette entry with no
    /// in-place toggle.
    ///
    /// JSON and XML default **on**, which is the one place the "a new flag
    /// starts off" convention bends, and for a concrete reason: the read-only
    /// `CellPreview` panel has always formatted unconditionally, so shipping
    /// these off would quietly take that away from every existing install. Off
    /// would not be a neutral default here — it would be a regression.
    ///
    /// SQL defaults off. It is the genuinely new capability, and unlike the
    /// other two its formatter rewrites the statement (keyword casing) rather
    /// than only its whitespace, so it cannot clear the losslessness check the
    /// automatic path applies to the other two.
    pub auto_format_json: bool,
    pub auto_format_xml: bool,
    pub auto_format_sql: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GridPrefs {
    pub row_height: u16,
    pub null_display: String,
    pub truncate_long_text_at: u32,
    pub zebra_stripes: bool,
    pub sticky_header: bool,
    pub default_page_size: u32,
    /// Whether the floating cell-value preview panel appears when a cell is
    /// selected in the data grid. Defaults to `true` (the historical
    /// behaviour); turning it off keeps single-click as pure navigation.
    pub cell_preview: bool,
    /// How MySQL `BIT` columns are rendered. One of "true_false" | "zero_one".
    /// Stringly-typed; the backend always ships BIT as a number and the
    /// frontend grid maps it to the chosen representation, so toggling this
    /// re-renders without re-querying.
    pub bit_display: String,
    /// User-resized column widths (px), keyed by `"<schema>.<table>"` then by
    /// column name. Only populated for real browsed tables — ad-hoc query
    /// result grids resize in-session only and never write here. Entries are
    /// tiny (a `u16` each), so unlike `tab_state.json`'s query bodies this
    /// isn't pruned; even thousands of tables/columns stay a small blob.
    pub column_widths: HashMap<String, HashMap<String, u16>>,
    /// Column names pinned to the left edge (freeze-panes style), keyed the
    /// same way as `column_widths`. Stacked in the columns' natural
    /// left-to-right order, not the order they were pinned in — the frontend
    /// recomputes stacking order from its own column list, this is just the
    /// membership set. Only populated for real browsed tables, like
    /// `column_widths`.
    pub pinned_columns: HashMap<String, Vec<String>>,
    /// How a browsed table/collection renders: one of "table" | "list". A
    /// single global toggle (not per-relation). Named after the *document*
    /// (row-as-document) layout it selects, not after MongoDB: the list view
    /// started out MongoDB-only but is available on every driver, so the key is
    /// kept as-is only to avoid resetting the preference of anyone who already
    /// set it. Stringly-typed; the frontend owns the enum.
    pub document_view_mode: String,
    /// List view: whether nested objects/arrays start expanded. Default `false`
    /// — a document with a big sub-document is unreadable when everything is
    /// unfolded at once, so folds open on demand.
    pub list_expand_nested: bool,
    /// List view: whether each field's type is shown in the right-hand gutter.
    pub list_show_types: bool,
    /// List view: whether fields are numbered in the left-hand gutter.
    pub list_line_numbers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiPrefs {
    pub confirm_destructive: bool,
    /// Whether emptying a table (the schema-explorer "Empty table" action,
    /// #69) asks for confirmation first. Separate from `confirm_destructive`
    /// so the "don't ask again" checkbox in that dialog only silences the
    /// empty-table prompt, not every destructive confirmation. Default `true`.
    pub confirm_empty_table: bool,
    pub query_history_limit: u32,
    pub restore_tabs_on_open: bool,
    /// Whether the main window reconnects, on launch, to the connections that
    /// were live when it last closed (their ids are persisted in
    /// `tab_state.json`). Reconnect uses the secrets already in the OS
    /// keychain; a connection whose secret isn't there (or whose host is
    /// unreachable) is skipped without blocking startup. Default `true`.
    /// Independent of `restore_tabs_on_open`, which governs whether a
    /// connection's tabs/layout come back *once* it is connected.
    pub reconnect_on_launch: bool,
    /// Schema-tree metric column. One of "none" | "row-count" | "size" | "both".
    /// Stringly-typed so the frontend `ViewMenu` enum stays the source of
    /// truth; the backend doesn't interpret the value — which is what made
    /// adding "both" a frontend-only change, with an old `prefs.json` still
    /// parsing and an older build degrading to no badge rather than failing.
    pub schema_table_metric: String,
    /// UI language. BCP-47-ish short code ("en", "es"). The frontend's
    /// i18next instance owns the list of supported locales; the backend
    /// just round-trips whatever string the user picked.
    pub language: String,
    /// Where the heavyweight cell editor opens by default when escalated
    /// from an inline edit / preview. One of "modal" | "side". Stringly-typed;
    /// the frontend owns the enum.
    pub cell_editor_mode: String,
    /// Driver used when a connection is created without an explicit choice.
    /// One of "postgres" | "mysql" | "sqlite", or `None` (not configured) —
    /// in which case the CLI prompts for the driver instead of guessing.
    /// Stringly-typed; the frontend owns the enum.
    pub default_driver: Option<String>,
    /// Remembered choice for the "second launch" connect dialog when a
    /// running instance receives a new CLI connection intent. One of
    /// "ask" | "current" | "new". "ask" (the default) always shows the
    /// dialog; the other two apply that action silently. Stringly-typed;
    /// the frontend owns the enum.
    pub cli_connect_default: String,
    /// Names of connection-list groups (`ConnectionProfile.group`) currently
    /// collapsed in the sidebar. Purely a display convenience — matched by
    /// string equality against the live group names, so a renamed/deleted
    /// group's stale entry here is harmless (it just never matches again).
    pub collapsed_connection_groups: Vec<String>,
    /// Visual treatment for a tab's active/colour accent. One of
    /// "cap" | "rail" | "boxed". Stringly-typed; the frontend owns the enum
    /// and applies it via CSS + an inline style, the backend just round-trips.
    pub tab_accent_style: String,
    /// How grouped connections start out in the tree views (File menu,
    /// connections manager). One of "expanded" | "collapsed" | "remember".
    /// "remember" defers to `collapsed_connection_groups`; the other two force
    /// the initial state (per-surface session toggles still apply on top).
    /// Stringly-typed; the frontend owns the enum.
    pub connection_group_expand_mode: String,
    /// Whether the taskbar Jump List shows the recent-connections category
    /// (`crate::jump_list`). Windows only; ignored elsewhere.
    ///
    /// On by default, against the house rule that a new flag starts off
    /// (ADRs #58, #83), and the exception is argued rather than assumed:
    /// that rule is about flags that *grant* something — an AI reaching a
    /// database, a machine writing to a share — where "off" is the safe state.
    /// This one grants nothing. It writes connection names and ids (never a
    /// host, a database or a secret; see `jump_list::driver_label`) to a list
    /// Windows keeps under the user's own profile, the same place it already
    /// records every app's recent files, and it is what a user expects a
    /// right-click on the taskbar button to show. Off, the feature would be
    /// invisible to anyone who has not gone looking for it in Settings.
    pub jump_list_recent: bool,
}

/// How notifications behave: where they appear, how long they stay, how many
/// at once, and how much of them is remembered.
///
/// Its own group rather than more fields on [`UiPrefs`] because the frontend
/// hands the whole struct to one component tree (the `<Toaster>` container plus
/// the notification store) and reads it as a unit; a group also gives the
/// settings dialog a section and the command palette a `notifications.*`
/// `prefId` namespace for free.
///
/// Everything enum-shaped is stringly-typed, like [`GridPrefs::bit_display`]:
/// the frontend owns the enum, the backend just round-trips whatever it stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationPrefs {
    /// Corner or edge the *card* stack grows from — errors, file notifications
    /// and anything escalated out of a one-line pill. One of "top-left" |
    /// "top-center" | "top-right" | "bottom-left" | "bottom-center" |
    /// "bottom-right".
    pub position: String,
    /// Corner or edge the *pill* stack grows from — the one-line anatomy every
    /// non-error kind uses. Same six values as [`NotificationPrefs::position`];
    /// setting it equal to that one collapses both anatomies back into a single
    /// stack, which the frontend implements by mounting one host instead of two.
    pub pill_position: String,
    /// How long a dismissible notification lives, in milliseconds. `0` means
    /// "until dismissed".
    ///
    /// Defaults to **6000**, not the 4000 the toast library uses: the old value
    /// was not long enough to read a file path or a driver error, which is what
    /// made the notifications feel like they had happened to somebody else.
    /// Clamped into `[MIN_DURATION_MS, MAX_DURATION_MS]` by the frontend before
    /// it reaches the container.
    pub duration_ms: u32,
    /// Whether errors ignore `duration_ms` and wait to be dismissed. On by
    /// default — an error usually carries a message the user has to act on
    /// (copy it, retry, report it), and none of that fits in six seconds.
    pub errors_persist: bool,
    /// How many notifications are on screen at once; the rest collapse behind
    /// a counter and go straight to the history.
    pub max_visible: u32,
    /// Whether hovering the stack expands it and freezes every timer.
    pub expand_on_hover: bool,
    /// Card density. One of "comfortable" | "compact" — compact drops the body
    /// line and keeps title plus actions on one row.
    pub density: String,
    /// How many past notifications the window remembers. `0` disables the
    /// history (and hides the bell).
    ///
    /// In-memory and per window: notifications are already scoped to the window
    /// that raised them (see the `target` rule in `log-bridge.ts`), and a
    /// history that outlived the session would be a state file nobody asked
    /// for. The number is here only so the cap is the user's to set.
    pub history_limit: u32,
    /// Whether the status bar shows the notification bell. With it off the
    /// history is still kept and still reachable from the command palette.
    pub show_bell: bool,
}

/// Connection-pool policy.
///
/// Until 1.13.0 none of this was configurable and most of it wasn't even
/// stated: pools were built with a hardcoded ceiling and `sqlx`'s implicit
/// defaults for everything else. That was survivable while HuginnDB was the
/// only thing talking to a server, and stopped being survivable once the same
/// database was also serving a JetBrains data source, an application backend's
/// own pool, and one `huginndb-mcp` sidecar per MCP client.
///
/// The values here are the *global* fallback. A single server that needs a
/// different budget is better expressed per profile
/// ([`crate::state::ConnectionProfile::max_connections`]), which travels with
/// the connection and is also honoured by the headless sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionPrefs {
    /// **Total** connections HuginnDB may hold against one server endpoint,
    /// shared by every profile and every database view that reaches it.
    ///
    /// This was a per-*pool* ceiling before 1.13.0, which is precisely why the
    /// footprint was unbounded: three profiles pointing at the same host each
    /// got their own allowance and nothing could see the sum. See
    /// [`crate::db::endpoint`]. Clamped into
    /// `[MIN_MAX_CONNECTIONS, MAX_MAX_CONNECTIONS]` at use time.
    pub max_connections: u32,
    /// Ceiling for each synthetic per-database child pool. Kept low on purpose:
    /// these are the pools that multiply with the number of databases browsed.
    pub child_max_connections: u32,
    /// How long a child pool may go untouched before the reaper closes it, in
    /// seconds. `0` disables reaping entirely (children then live until their
    /// parent disconnects, the pre-1.13.0 behaviour).
    pub child_idle_ttl_secs: u32,
    /// Most child pools any one connection may hold at once; the
    /// longest-unused are closed past this. `0` means unlimited.
    pub max_child_pools: u32,
    /// Whether the desktop app runs the local MCP bridge, letting a
    /// `huginndb-mcp` sidecar borrow the app's pools instead of opening its own
    /// (see [`crate::bridge`]).
    ///
    /// **Off by default.** The bridge fronts every database the user has saved,
    /// and a listening socket that does that is not something to switch on
    /// behind someone's back — however narrow the exposure (loopback only,
    /// token-gated, write policy re-checked server-side).
    pub mcp_bridge: bool,
    /// How long a connection the **MCP bridge** opened may go untouched before
    /// the reaper closes it, in seconds. `0` disables it, restoring the
    /// pre-1.21 behaviour where such a connection lived until the app exited.
    ///
    /// Separate from [`Self::child_idle_ttl_secs`] because it releases a
    /// different thing for a different reason: a child pool is a browsing
    /// cache, while this is a whole top-level connection that a person never
    /// asked for and no window shows. It defaults to the sidecar's own
    /// `mcp::POOL_IDLE_TTL` so that a connector-driven connection behaves
    /// identically whether the sidecar borrowed the app's pool or opened one of
    /// its own — the divergence between those two modes was the bug (gotcha
    /// #67).
    ///
    /// Interacts with [`Self::keepalive_secs`]: a bridge-opened pool never gets
    /// a heartbeat, so `IDLE_TIMEOUT` can actually decay its sockets while it
    /// waits out this TTL.
    pub bridge_idle_ttl_secs: u32,
    /// Keepalive ping interval in seconds. `0` disables the heartbeat.
    ///
    /// The heartbeat holds one connection per top-level pool alive
    /// indefinitely — it pings more often than [`crate::db::pool::IDLE_TIMEOUT`]
    /// reaps, by design, so the next thing the user clicks is instant and so a
    /// dropped connection is discovered before a query hits it. That is a
    /// defensible one-socket-per-open-connection cost, but on a server the user
    /// is rationing it may not be, hence the off switch.
    pub keepalive_secs: u32,
    /// Ceiling, in seconds, for a single read-only introspection call —
    /// listing databases and tables, describing a relation, the keepalive
    /// ping. Never for a data query, whose runtime is the user's own SQL.
    ///
    /// The global fallback. A single slow or very large server is better
    /// expressed per profile
    /// ([`crate::state::ConnectionProfile::operation_timeout_secs`]), which
    /// travels with the connection and is also honoured by the headless
    /// sidecar; this is for a whole workstation that reaches every server the
    /// slow way, over a VPN. Clamped into
    /// `[MIN_OPERATION_TIMEOUT_SECS, MAX_OPERATION_TIMEOUT_SECS]` at use time
    /// by [`crate::db::pool::operation_timeout`].
    pub operation_timeout_secs: u32,
}

impl Default for ConnectionPrefs {
    fn default() -> Self {
        Self {
            max_connections: crate::db::pool::DEFAULT_ENDPOINT_BUDGET,
            child_max_connections: crate::db::pool::DEFAULT_CHILD_MAX_CONNECTIONS,
            mcp_bridge: false,
            child_idle_ttl_secs: 300,
            max_child_pools: 8,
            bridge_idle_ttl_secs: crate::db::pool::MCP_IDLE_TTL.as_secs() as u32,
            keepalive_secs: crate::keepalive::DEFAULT_KEEPALIVE_INTERVAL.as_secs() as u32,
            operation_timeout_secs: crate::db::pool::DEFAULT_OPERATION_TIMEOUT.as_secs() as u32,
        }
    }
}

/// Which of the AI panel's two capability modes the user has chosen.
///
/// A closed set with a real default, unlike the stringly-typed fields
/// elsewhere in this file: those keep a *frontend-owned* catalogue (theme ids,
/// notification corners) as the single source of truth, whereas both of these
/// are decided in Rust — the agent loop either runs or it does not.
///
/// [`Self::Assisted`] is the default because it is the mode that works on the
/// hardware most users have. Choosing [`Self::Agent`] is not enough to get it:
/// [`crate::ai::probe::Capability::ToolCapable`] must agree, or the panel
/// stays in assisted mode and says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiMode {
    /// One model call, context assembled deterministically in Rust, no tool
    /// loop. Works on a 4B.
    #[default]
    Assisted,
    /// A real tool-call loop. Needs a tool-capable model.
    Agent,
}

/// How much a *thinking* model should be told to think.
///
/// Maps onto `reasoning_effort` on `/v1/chat/completions`. Nearly every model
/// on Ollama's current library is a thinking model, and on one of those the
/// default behaviour is to spend a paragraph of reasoning before the first
/// useful token — which in a chat panel reads as a hang, and which some servers
/// deliver *inside* `content` rather than in a field of its own (see
/// `crate::ai::parts`'s counterpart on the frontend).
///
/// [`Self::Auto`] omits the field entirely, and is the default for a
/// compatibility reason rather than a taste one: OpenAI *validates* it and
/// rejects the request outright on a non-reasoning model, so a build that
/// always sent something would break BYOK against half of their catalogue.
/// Every other value is worth setting deliberately once the user knows what
/// their endpoint serves — `None` for a local thinking model in assisted mode
/// is the combination this feature is built around.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiReasoningEffort {
    /// Send no `reasoning_effort` at all. Safe against every server.
    #[default]
    Auto,
    /// Ask a thinking model not to think. What assisted mode wants.
    None,
    Low,
    Medium,
    High,
    /// Ollama accepts this; OpenAI does not. See [`Self::Auto`].
    Max,
}

impl AiReasoningEffort {
    /// The wire value, or `None` when the field must be omitted.
    pub fn wire(self) -> Option<&'static str> {
        match self {
            Self::Auto => Option::None,
            Self::None => Some("none"),
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
            Self::Max => Some("max"),
        }
    }
}

/// The AI panel's configuration.
///
/// Off by default, and the two fields that decide what leaves the machine are
/// the *conservative* ones when absent: [`Self::enabled`] is `false` and
/// [`Self::endpoint_trust`] is [`EndpointTrust::Untrusted`], so a `prefs.json`
/// written before this struct existed — which is every one of them — loads into
/// a configuration that neither talks to a model nor would send it a row.
///
/// The endpoint's API key is deliberately **not** here. It lives in the OS
/// keychain, keyed by the endpoint's origin; see [`crate::ai::secrets`] for why
/// `prefs.json` is the wrong place for a secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiPrefs {
    /// Whether the panel is available at all.
    pub enabled: bool,
    /// The OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`.
    ///
    /// Kept as a `String` rather than a parsed URL because this is what a
    /// person types into a text field, and it is invalid at almost every
    /// keystroke. Parsing and validation happen once, at
    /// [`crate::ai::provider::Endpoint::new`], which is also where a scheme
    /// other than http/https is refused.
    pub base_url: String,
    /// The model id to ask for. Empty until the user picks one — there is no
    /// sensible default, since it depends entirely on what their endpoint
    /// serves.
    pub model: String,
    /// How much the user has declared this endpoint may be trusted with data.
    ///
    /// Declared, never sniffed. See [`EndpointTrust`] and
    /// [`crate::ai::scope::DataScope::resolve`] — this is one half of the
    /// coupling rule, the other being `ConnectionProfile::ai_rows_allowed`.
    pub endpoint_trust: EndpointTrust,
    /// Assisted or agent. See [`AiMode`].
    pub mode: AiMode,
    /// Ceiling on how many rows one tool reply may put in the model's context.
    /// Clamped at use time by [`crate::ai::exec::effective_row_cap`], so a
    /// hand-edited million cannot blow up a context window.
    pub max_context_rows: i64,
    /// How long a socket may go without delivering a byte before the request
    /// is declared dead. Not a total budget — a slow model is not a broken
    /// one; see [`crate::ai::provider::client`].
    pub request_timeout_secs: u64,
    /// What to send as `reasoning_effort`. See [`AiReasoningEffort`].
    pub reasoning_effort: AiReasoningEffort,
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            // Ollama's default, which is the endpoint most users will have
            // first and costs nothing to pre-fill for the rest.
            base_url: "http://localhost:11434/v1".into(),
            model: String::new(),
            endpoint_trust: EndpointTrust::default(),
            mode: AiMode::default(),
            max_context_rows: crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS,
            request_timeout_secs: 120,
            reasoning_effort: AiReasoningEffort::default(),
        }
    }
}

/// The theme browser's access to an extension registry.
///
/// **`enabled` defaults to `true`, against this project's rule that a new flag
/// starts off** (ADRs #58 and #83), and the exception is argued rather than
/// assumed. Those flags are per-connection and guard a *database*: leaving one
/// on by default would expose a server the user never offered. Nothing of the
/// user's leaves the machine here — the browser issues anonymous GETs for
/// public packages, sends no credentials, no telemetry and no schema — and the
/// app already makes outbound requests for the updater and the issue reporter,
/// so this is not a new capability, only a new destination. A browser that
/// shipped off would also be a feature nobody finds.
///
/// `url` exists because "the registry" is not always open-vsx.org: companies
/// run their own Open VSX instance, and an air-gapped install needs to point
/// somewhere reachable or turn the whole thing off. It is stored per installed
/// theme as well (`themes::store::ThemeSource`), so changing it here cannot
/// silently re-target an update at a different registry's extension that
/// happens to share a name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemePrefs {
    pub registry_enabled: bool,
    pub registry_url: String,
}

impl Default for ThemePrefs {
    fn default() -> Self {
        Self {
            registry_enabled: true,
            registry_url: crate::themes::registry::DEFAULT_REGISTRY_URL.into(),
        }
    }
}

/// Pulse's background history sampler — the one part of Pulse with a real,
/// recurring cost, so every knob here exists to keep that cost bounded and
/// visible rather than to add features. Nothing here has any effect on a
/// connection unless `ConnectionProfile::pulse_enabled` is also set — a
/// preference change alone can never start sampling a server the user hasn't
/// opted in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PulsePrefs {
    /// Whether Pulse is offered at all: its icon in the right activity bar,
    /// and the background sampler. **On** by default — Pulse shipped visible,
    /// and an upgrade must not take away a panel someone was using. Off is
    /// the "I do not monitor from here" switch: the icon goes, and
    /// `pulse::sampler` skips every tick even for connections whose
    /// `pulse_enabled` is still set, so turning the module off is a promise
    /// that it costs nothing rather than only that it is out of sight. The
    /// per-connection opt-ins are kept, so turning it back on resumes exactly
    /// what was sampled before.
    pub enabled: bool,
    /// How often the dock panel / expanded window poll a connection's live
    /// vital signs, in seconds, while that surface is on screen. Frontend-only
    /// — the backend never schedules this tick, `usePulseLive` does — kept
    /// here anyway so both clocks live in one place a user tuning "how much
    /// does Pulse cost" can find.
    pub live_interval_secs: u32,
    /// How often `pulse::sampler` writes a tick to `pulse.db`, in seconds,
    /// for every connection with `pulse_enabled` set. This is the number
    /// that actually costs a round trip against someone's server.
    pub history_interval_secs: u32,
    /// How long a history point survives before it is pruned. Governs the
    /// *outer* edge of the retention staircase — the 48h/5-minute downsample
    /// step is not user-tunable, since exposing it would let someone dial a
    /// month of history down to nothing and call it a bug.
    pub retention_days: u32,
    /// Whether the sampler keeps ticking while the main window is minimised.
    /// **On** by default: a monitoring tool that stops watching the instant
    /// you look away from it is not one you can trust for an incident that
    /// started before you opened the app. Off trades that promise for zero
    /// server load whenever HuginnDB itself isn't on screen.
    pub sample_when_minimized: bool,
    /// Soft cap on `pulse.db`'s size, in megabytes. `0` disables it — the
    /// same "0 means unlimited" convention `ConnectionPrefs::max_child_pools`
    /// uses. Past this, `PulseStore::prune` sheds the oldest tenth of what's
    /// left on top of the normal retention pass; it exists as a blunt safety
    /// valve for a fleet of connections nobody sized the retention window
    /// for; the day-to-day owner of disk usage is `retention_days`.
    pub max_disk_mb: u32,
}

impl Default for PulsePrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            live_interval_secs: 5,
            history_interval_secs: 60,
            retention_days: 30,
            sample_when_minimized: true,
            max_disk_mb: 20,
        }
    }
}

/// The silent updater (`crate::updater`).
///
/// **On** by default, and so on for every existing `prefs.json` too, against
/// the usual "a new flag starts off" rule: the point is that someone who only
/// uses the MCP connector, and never opens the app, is kept up to date without
/// doing anything — an opt-in would reach exactly nobody of them. A managed
/// policy is not required for any of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdatePrefs {
    /// Install new versions in the background, through the scheduled tasks
    /// `updater::schedule` registers. Off removes them; the interface's own
    /// updater keeps offering updates with a button either way.
    pub auto_install: bool,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self { auto_install: true }
    }
}

/// The app lock (`crate::vault`, ADR #118).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LockPrefs {
    /// Minutes without a key press, click or scroll in any window before the
    /// app locks itself; `0` never does. Only read while the lock is on.
    ///
    /// Fifteen by default: Windows' own screen-saver lock suggests ten to
    /// fifteen, and a database client is often left open beside the work it
    /// supports, reading rather than typing — shorter would lock someone
    /// mid-thought. The person stepping away for coffee is the case this
    /// covers; locking the Windows session covers the rest (phase 3).
    pub idle_minutes: u32,
}

impl Default for LockPrefs {
    fn default() -> Self {
        Self { idle_minutes: 15 }
    }
}

/// The terminal panel (`crate::terminal`).
///
/// **On** by default, unlike the AI panel: a terminal adds no endpoint, sends
/// nothing anywhere and touches a database only through a `mongosh` the user
/// installed themselves, signed in with the credentials the connection
/// already uses. It is the escape hatch for the MongoDB scripts AI tools
/// write — variables, loops, `printjson` — that the query editor's bounded
/// parser (`db::mongo::shell`) refuses by design.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalPrefs {
    /// Whether the panel is offered: its icon in the right activity bar, and
    /// the commands that open a session (which refuse while this is off).
    pub enabled: bool,
    /// Full path to the `mongosh` executable. Empty means "find it":
    /// `PATH` first, then the places the official installers put it — a GUI
    /// app on Linux or macOS does not inherit the login shell's `PATH`, so
    /// the lookup cannot stop at `PATH` alone. See [`crate::terminal::mongosh`].
    pub mongosh_path: String,
    /// Full path to the shell a plain terminal starts. Empty means the
    /// platform default: PowerShell 7 (`pwsh`) if installed, else Windows
    /// PowerShell, on Windows; `$SHELL`, else `bash`, else `sh`, elsewhere.
    pub shell_path: String,
}

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            mongosh_path: String::new(),
            shell_path: String::new(),
        }
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            editor: EditorPrefs::default(),
            grid: GridPrefs::default(),
            ui: UiPrefs::default(),
            notifications: NotificationPrefs::default(),
            connections: ConnectionPrefs::default(),
            pulse: PulsePrefs::default(),
            ai: AiPrefs::default(),
            themes: ThemePrefs::default(),
            updates: UpdatePrefs::default(),
            terminal: TerminalPrefs::default(),
            lock: LockPrefs::default(),
            keybindings: HashMap::new(),
        }
    }
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".into(),
            font_size: 13,
            tab_size: 2,
            word_wrap: false,
            minimap: false,
            line_numbers: true,
            format_on_paste: false,
            // The brand editor theme, matching `resolveMonacoTheme`'s own
            // fallback. Installs that already picked a theme keep it.
            theme: "huginn-dark".into(),
            // All on: a bound schema that did nothing visible would read as
            // broken, and the user opted in by creating the binding.
            json_schema_validation: true,
            json_schema_completion: true,
            json_schema_hover: true,
            // On, so the preview panel keeps doing what it has always done —
            // see the doc comment on the fields.
            auto_format_json: true,
            auto_format_xml: true,
            // Off: new capability, new dependency, and a formatter that
            // rewrites more than whitespace.
            auto_format_sql: false,
        }
    }
}

impl Default for GridPrefs {
    fn default() -> Self {
        Self {
            row_height: 26,
            null_display: "NULL".into(),
            truncate_long_text_at: 200,
            zebra_stripes: true,
            sticky_header: true,
            default_page_size: 100,
            cell_preview: true,
            bit_display: "true_false".into(),
            column_widths: HashMap::new(),
            pinned_columns: HashMap::new(),
            document_view_mode: "table".into(),
            list_expand_nested: false,
            list_show_types: true,
            list_line_numbers: true,
        }
    }
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            confirm_destructive: true,
            confirm_empty_table: true,
            query_history_limit: 50,
            restore_tabs_on_open: true,
            reconnect_on_launch: true,
            // Mirrors `DEFAULT_PREFS` in `src/stores/preferences/preferences.ts`.
            // `"size"` rather than `"none"`: every driver fills
            // `TableInfo.size_bytes` regardless of this setting, so hiding the
            // badge saved no work — it only withheld a number the app had
            // already paid for.
            schema_table_metric: "size".into(),
            language: "en".into(),
            cell_editor_mode: "modal".into(),
            default_driver: None,
            cli_connect_default: "ask".into(),
            collapsed_connection_groups: Vec::new(),
            tab_accent_style: "cap".into(),
            connection_group_expand_mode: "remember".into(),
            jump_list_recent: true,
        }
    }
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            // Where they already were, and still the least intrusive corner:
            // away from the editing caret and next to the bell.
            position: "bottom-right".into(),
            // Not the card corner: bottom-centre is the canonical spot for
            // ephemeral state, and it leaves bottom-right — where the bell and
            // the status bar already live — to the cards.
            pill_position: "bottom-center".into(),
            duration_ms: 6000,
            errors_persist: true,
            max_visible: 3,
            expand_on_hover: true,
            density: "comfortable".into(),
            history_limit: 50,
            show_bell: true,
        }
    }
}

/// Read the preferences blob from disk.
///
/// Returns [`Preferences::default`] when the file is missing or unparseable —
/// the underlying error is logged but never blocks app startup on a corrupted
/// prefs file.
pub fn load_preferences() -> Preferences {
    crate::state_file::load_or_default(PREFS_FILE, "prefs")
}

/// Persist `prefs` to disk atomically (see [`crate::state_file::save_atomic`]).
pub fn save_preferences(prefs: &Preferences) -> AppResult<()> {
    crate::state_file::save_atomic(PREFS_FILE, prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip() {
        let original = Preferences::default();
        let bytes = serde_json::to_vec(&original).unwrap();
        let parsed: Preferences = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.version, original.version);
        assert_eq!(parsed.editor.font_size, original.editor.font_size);
        assert_eq!(
            parsed.grid.default_page_size,
            original.grid.default_page_size
        );
        assert_eq!(
            parsed.ui.schema_table_metric,
            original.ui.schema_table_metric
        );
        assert!(parsed.keybindings.is_empty());
    }

    /// Every existing `prefs.json` predates `updates`, so this is the upgrade
    /// path for every install, and the default is load-bearing: an MCP-only
    /// user is kept up to date without ever opening Settings.
    #[test]
    fn a_blob_without_the_updates_group_installs_in_the_background() {
        let before = r#"{ "version": 1, "editor": { "fontSize": 13 } }"#;
        let parsed: Preferences = serde_json::from_str(before).unwrap();
        assert!(parsed.updates.auto_install);
    }

    /// Every existing `prefs.json` predates both switches. The terminal is
    /// offered on upgrade (it is new, and it is the point of the release), and
    /// Pulse stays exactly as visible — and sampling — as it was.
    #[test]
    fn a_blob_without_the_terminal_group_offers_it_and_keeps_pulse_on() {
        let before = r#"{ "version": 1, "pulse": { "retentionDays": 7 } }"#;
        let parsed: Preferences = serde_json::from_str(before).unwrap();
        assert!(parsed.terminal.enabled);
        assert_eq!(parsed.terminal.mongosh_path, "");
        assert_eq!(parsed.terminal.shell_path, "");
        assert!(parsed.pulse.enabled);
        assert_eq!(parsed.pulse.retention_days, 7, "the rest must survive");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // Older clients may write a partial blob; we want to read it back without losing fields.
        let partial = r#"{ "version": 1, "editor": { "fontSize": 17 } }"#;
        let parsed: Preferences = serde_json::from_str(partial).unwrap();
        assert_eq!(parsed.editor.font_size, 17);
        assert_eq!(parsed.editor.font_family, "JetBrains Mono");
        assert_eq!(parsed.grid.default_page_size, 100);
        assert!(parsed.ui.restore_tabs_on_open);
    }

    /// Every existing `prefs.json` predates the `ai` group, so this is the
    /// upgrade path for every install. Two of the defaults are load-bearing
    /// rather than cosmetic: `enabled: false` means an upgrade never talks to
    /// a model, and `endpointTrust: untrusted` means that even once it does,
    /// the coupling rule starts at metadata-only.
    #[test]
    fn a_blob_without_the_ai_group_loads_switched_off_and_untrusted() {
        let before = r#"{ "version": 1, "pulse": { "retentionDays": 7 } }"#;
        let parsed: Preferences = serde_json::from_str(before).unwrap();
        assert_eq!(parsed.pulse.retention_days, 7, "the rest must survive");
        assert!(!parsed.ai.enabled);
        assert_eq!(parsed.ai.endpoint_trust, EndpointTrust::Untrusted);
        assert_eq!(parsed.ai.mode, AiMode::Assisted);
        assert_eq!(parsed.ai.model, "", "no model can be guessed for the user");
        assert_eq!(parsed.ai.base_url, "http://localhost:11434/v1");
        assert_eq!(
            parsed.ai.max_context_rows,
            crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS
        );
    }

    /// A half-written `ai` group — a user hand-editing the file, or a
    /// downgrade — must not resolve to "trusted". Absence has to mean the
    /// conservative answer field by field, not only for the group as a whole.
    #[test]
    fn a_partial_ai_group_still_defaults_the_fields_it_omits() {
        let partial = r#"{ "ai": { "enabled": true, "model": "llama3.1:8b" } }"#;
        let parsed: Preferences = serde_json::from_str(partial).unwrap();
        assert!(parsed.ai.enabled);
        assert_eq!(parsed.ai.model, "llama3.1:8b");
        assert_eq!(parsed.ai.endpoint_trust, EndpointTrust::Untrusted);
        assert_eq!(parsed.ai.request_timeout_secs, 120);
        // Omitting the field is the only value guaranteed not to be rejected
        // by a strict server, so absence must resolve to it.
        assert_eq!(parsed.ai.reasoning_effort, AiReasoningEffort::Auto);
    }

    /// The wire values `reasoning_effort` accepts, and the one that means
    /// "send nothing".
    #[test]
    fn reasoning_effort_maps_onto_the_openai_field() {
        assert_eq!(AiReasoningEffort::Auto.wire(), None);
        assert_eq!(AiReasoningEffort::None.wire(), Some("none"));
        assert_eq!(AiReasoningEffort::Low.wire(), Some("low"));
        assert_eq!(AiReasoningEffort::Medium.wire(), Some("medium"));
        assert_eq!(AiReasoningEffort::High.wire(), Some("high"));
        assert_eq!(AiReasoningEffort::Max.wire(), Some("max"));
        assert_eq!(AiReasoningEffort::default(), AiReasoningEffort::Auto);
    }

    /// The wire names the frontend mirrors in `types.ts`.
    #[test]
    fn the_ai_group_serialises_in_camel_case() {
        let json = serde_json::to_value(AiPrefs::default()).unwrap();
        for key in [
            "enabled",
            "baseUrl",
            "model",
            "endpointTrust",
            "mode",
            "maxContextRows",
            "requestTimeoutSecs",
            "reasoningEffort",
        ] {
            assert!(json.get(key).is_some(), "missing {key} in {json}");
        }
        assert_eq!(json["endpointTrust"], serde_json::json!("untrusted"));
        assert_eq!(json["mode"], serde_json::json!("assisted"));
        assert_eq!(json["reasoningEffort"], serde_json::json!("auto"));
    }

    /// A `prefs.json` written before the notifications group existed — i.e.
    /// every install upgrading into this version — must load with the new
    /// defaults rather than dropping the rest of the blob.
    #[test]
    fn blob_without_notifications_gets_the_new_defaults() {
        let before = r#"{ "version": 1, "grid": { "rowHeight": 30 }, "ui": { "language": "es" } }"#;
        let parsed: Preferences = serde_json::from_str(before).unwrap();
        assert_eq!(parsed.grid.row_height, 30);
        assert_eq!(parsed.ui.language, "es");
        assert_eq!(parsed.notifications.position, "bottom-right");
        assert_eq!(parsed.notifications.duration_ms, 6000);
        assert!(parsed.notifications.errors_persist);
        assert_eq!(parsed.notifications.max_visible, 3);
        assert_eq!(parsed.notifications.history_limit, 50);
    }

    /// Same migration guarantee as the notifications test above, for the
    /// block added after it: a `prefs.json` written before Pulse existed
    /// must load with its defaults, not fail to parse.
    #[test]
    fn blob_without_pulse_gets_the_new_defaults() {
        let before = r#"{ "version": 1, "ui": { "language": "es" } }"#;
        let parsed: Preferences = serde_json::from_str(before).unwrap();
        assert_eq!(parsed.pulse.live_interval_secs, 5);
        assert_eq!(parsed.pulse.history_interval_secs, 60);
        assert_eq!(parsed.pulse.retention_days, 30);
        assert!(parsed.pulse.sample_when_minimized);
        assert_eq!(parsed.pulse.max_disk_mb, 20);
    }

    /// The camelCase spelling is the IPC contract with `src/types.ts`; a rename
    /// on either side has to break here.
    #[test]
    fn notifications_use_the_camel_case_keys_the_frontend_sends() {
        let sent = r#"{
            "notifications": {
                "position": "top-center",
                "pillPosition": "bottom-left",
                "durationMs": 10000,
                "errorsPersist": false,
                "maxVisible": 5,
                "expandOnHover": false,
                "density": "compact",
                "historyLimit": 0,
                "showBell": false
            }
        }"#;
        let parsed: Preferences = serde_json::from_str(sent).unwrap();
        let n = &parsed.notifications;
        assert_eq!(n.position, "top-center");
        assert_eq!(n.pill_position, "bottom-left");
        assert_eq!(n.duration_ms, 10000);
        assert!(!n.errors_persist);
        assert_eq!(n.max_visible, 5);
        assert!(!n.expand_on_hover);
        assert_eq!(n.density, "compact");
        assert_eq!(n.history_limit, 0);
        assert!(!n.show_bell);

        // And back out again in the same spelling.
        let json = serde_json::to_value(&parsed).unwrap();
        assert!(json["notifications"]["durationMs"].is_number());
        assert!(json["notifications"]["errorsPersist"].is_boolean());
        assert_eq!(json["notifications"]["pillPosition"], "bottom-left");
    }

    /// The pre-1.19 shape stored one bare string per action. Those files are
    /// still out there, and losing every rebind on upgrade would be worse than
    /// the type change is worth — `string_or_vec` folds each into a one-element
    /// list on read.
    #[test]
    fn keybindings_accept_the_legacy_bare_string_shape() {
        let sent = r#"{
            "keybindings": {
                "runQuery": "Ctrl+Enter",
                "expandSelectedCell": "Space"
            }
        }"#;
        let parsed: Preferences = serde_json::from_str(sent).unwrap();
        assert_eq!(
            parsed.keybindings["runQuery"],
            vec!["Ctrl+Enter".to_string()]
        );
        assert_eq!(
            parsed.keybindings["expandSelectedCell"],
            vec!["Space".to_string()]
        );
    }

    /// The list shape is what the frontend sends now: primary first, aliases
    /// after, and an empty list meaning "the user unbound this on purpose" —
    /// which must survive the round trip rather than collapsing to a missing
    /// key, since a missing key means "use the default" instead.
    #[test]
    fn keybindings_round_trip_the_list_shape_the_frontend_sends() {
        let sent = r#"{
            "keybindings": {
                "runQuery": ["Mod+Enter", "F9"],
                "openSettings": []
            }
        }"#;
        let parsed: Preferences = serde_json::from_str(sent).unwrap();
        assert_eq!(
            parsed.keybindings["runQuery"],
            vec!["Mod+Enter".to_string(), "F9".to_string()]
        );
        assert!(parsed.keybindings["openSettings"].is_empty());

        // And back out again as arrays, never as bare strings.
        let json = serde_json::to_value(&parsed).unwrap();
        assert!(json["keybindings"]["runQuery"].is_array());
        assert_eq!(json["keybindings"]["runQuery"][1], "F9");
        assert!(json["keybindings"]["openSettings"].is_array());
    }

    #[test]
    fn corrupt_json_does_not_panic() {
        let parsed: Result<Preferences, _> = serde_json::from_str("{ this is not json");
        assert!(parsed.is_err());
    }
}
