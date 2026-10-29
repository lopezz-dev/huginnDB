//! Small SQL helpers shared across command handlers.

use crate::error::{AppError, AppResult};
use crate::state::DbPool;

/// The SQL dialect spoken by one connection.
///
/// This is the single source of truth for every place the generated SQL has to
/// differ per engine: identifier quoting, positional placeholders, the cast
/// target used by text predicates, `LIKE` semantics and pagination. It
/// deliberately has **no MongoDB variant** — Mongo is not a SQL dialect and
/// every command dispatches it to [`crate::db::mongo`] before any SQL is built,
/// so [`Dialect::try_of`] rejects it instead of inventing a meaningless answer.
///
/// It replaces the old `quote_ident(pg_or_sqlite: bool, …)` flag, which encoded
/// a three-way choice in one bit and could not express a fourth engine (SQL
/// Server quotes with `[brackets]`, numbers placeholders `@P1`, and has no
/// `LIMIT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    MsSql,
}

impl Dialect {
    /// The dialect of a live pool.
    ///
    /// `Err(UnsupportedDriver)` for MongoDB: callers that can reach a Mongo
    /// pool must have handled it before asking for a dialect.
    pub fn try_of(pool: &DbPool) -> AppResult<Self> {
        match pool {
            DbPool::Postgres(_) => Ok(Self::Postgres),
            DbPool::Mysql(_) => Ok(Self::Mysql),
            DbPool::Sqlite(_) => Ok(Self::Sqlite),
            DbPool::MsSql(_) => Ok(Self::MsSql),
            DbPool::Mongo(_) => Err(AppError::UnsupportedDriver(
                "MongoDB does not speak SQL; this operation is SQL-only".into(),
            )),
        }
    }

    /// Wrap `name` in this dialect's identifier quotes, escaping any embedded
    /// quote character by doubling it (the standard SQL rule, and the one SQL
    /// Server follows for `]` inside brackets).
    ///
    /// Callers are still responsible for sourcing `name` from a trusted catalog
    /// query — this is for layout, not for sanitising arbitrary user input. The
    /// one sanctioned exception is the DDL builder, which validates every
    /// user-entered name through [`crate::db::ddl::validate_ident`] first.
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            Self::Postgres | Self::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
            Self::Mysql => format!("`{}`", name.replace('`', "``")),
            Self::MsSql => format!("[{}]", name.replace(']', "]]")),
        }
    }

    /// The `index`-th (1-based) positional placeholder.
    ///
    /// Postgres and SQL Server number their placeholders, so the caller has to
    /// thread a counter; MySQL/SQLite ignore `index` entirely.
    pub fn placeholder(self, index: usize) -> String {
        match self {
            Self::Postgres => format!("${index}"),
            Self::Mysql | Self::Sqlite => "?".to_string(),
            Self::MsSql => format!("@P{index}"),
        }
    }

    /// Cast target that turns any column into text, for the `LIKE`-based
    /// filters. MySQL rejects `CAST(x AS TEXT)`; SQL Server needs a length.
    pub fn cast_to_text(self) -> &'static str {
        match self {
            Self::Postgres | Self::Sqlite => "TEXT",
            Self::Mysql => "CHAR",
            Self::MsSql => "NVARCHAR(MAX)",
        }
    }

    /// Keyword for a case-insensitive `LIKE`. Only Postgres has a dedicated
    /// one; MySQL and SQL Server are case-insensitive through their default
    /// collation, and SQLite's `LIKE` is ASCII-case-insensitive by default.
    pub fn like_kw(self) -> &'static str {
        match self {
            Self::Postgres => "ILIKE",
            Self::Mysql | Self::Sqlite | Self::MsSql => "LIKE",
        }
    }

    /// Whether a *negated* case-insensitive match has to fold both sides with
    /// `lower()`.
    ///
    /// `ILIKE` has no negated spelling that composes with the surrounding
    /// `CAST(...)`, so on Postgres "not contains" is emitted as
    /// `lower(CAST(col AS TEXT)) NOT LIKE lower($1)`. The other dialects get
    /// case-insensitivity from the collation, so their plain `NOT LIKE` is
    /// already case-insensitive.
    pub fn not_like_needs_lower(self) -> bool {
        matches!(self, Self::Postgres)
    }

    /// `ESCAPE` clause matching the `\` escape character the filter builder
    /// emits, rendered correctly for this dialect.
    ///
    /// MySQL/MariaDB interprets `\` as an escape inside *string literals*, so
    /// the SQL text must carry `ESCAPE '\\'` (two backslashes → one literal
    /// backslash); the single-backslash form leaves the literal unterminated
    /// and raises error 1064. The others use standard-SQL string literals where
    /// `\` is itself. Returned with a leading space so callers can append it
    /// straight after the placeholder.
    pub fn like_escape_clause(self) -> &'static str {
        match self {
            Self::Mysql => " ESCAPE '\\\\'",
            Self::Postgres | Self::Sqlite | Self::MsSql => " ESCAPE '\\'",
        }
    }

    /// Trailing pagination clause, with a leading space, for a statement that
    /// already carries `order_clause` (empty when the user hasn't sorted).
    ///
    /// SQL Server has no `LIMIT`: it needs `OFFSET n ROWS FETCH NEXT m ROWS
    /// ONLY`, which is only legal after an `ORDER BY` — hence the
    /// `ORDER BY (SELECT NULL)` filler when there is no user sort. That syntax
    /// requires **SQL Server 2012 or newer**; 2008 and older would need a
    /// `ROW_NUMBER()` window instead.
    pub fn paginate(self, limit: i64, offset: i64, has_order_by: bool) -> String {
        match self {
            Self::Postgres | Self::Mysql | Self::Sqlite => {
                format!(" LIMIT {limit} OFFSET {offset}")
            }
            Self::MsSql => {
                let filler = if has_order_by {
                    ""
                } else {
                    " ORDER BY (SELECT NULL)"
                };
                format!("{filler} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
            }
        }
    }

    /// Whether this dialect namespaces objects under a schema. SQLite doesn't
    /// (its `main`/`temp` prefixes are attached databases, not schemas), so
    /// every qualifier builder skips it there.
    pub fn has_schemas(self) -> bool {
        !matches!(self, Self::Sqlite)
    }

    /// The schema assumed when the caller doesn't name one. `None` for MySQL
    /// (the session's current database already scopes an unqualified name) and
    /// SQLite (no schemas at all).
    pub fn default_schema(self) -> Option<&'static str> {
        match self {
            Self::Postgres => Some("public"),
            Self::MsSql => Some("dbo"),
            Self::Mysql | Self::Sqlite => None,
        }
    }

    /// `schema.table`, quoted — schema included only when this dialect has
    /// schemas and the caller supplied a non-empty one.
    pub fn qualify(self, schema: Option<&str>, table: &str) -> String {
        match schema {
            Some(s) if !s.is_empty() && self.has_schemas() => {
                format!("{}.{}", self.quote_ident(s), self.quote_ident(table))
            }
            _ => self.quote_ident(table),
        }
    }

    /// Like [`Self::qualify`], but falling back to [`Self::default_schema`]
    /// when the caller passed none. Used by the data-browsing path, where an
    /// unqualified Postgres name would resolve through `search_path` instead of
    /// the schema the explorer actually showed.
    pub fn qualify_defaulted(self, schema: Option<&str>, table: &str) -> String {
        match schema {
            Some(s) if !s.is_empty() => self.qualify(Some(s), table),
            _ => self.qualify(self.default_schema(), table),
        }
    }

    /// The statement that empties `qualified` of every row.
    ///
    /// `TRUNCATE TABLE` everywhere it exists; SQLite has no `TRUNCATE`, so it
    /// gets an unfiltered `DELETE FROM` (which SQLite itself optimises into the
    /// truncate fast path when there are no triggers).
    ///
    /// Spelled out per dialect rather than "SQLite, else TRUNCATE". The
    /// difference is not "SQLite is the odd one out" — it is a per-engine fact
    /// about which statement exists, and the next engine added has to state its
    /// own answer instead of silently inheriting Postgres's. That is the whole
    /// reason this enum owns the generated SQL, and this call site was the one
    /// place still guessing.
    pub fn truncate_stmt(self, qualified: &str) -> String {
        match self {
            Dialect::Postgres | Dialect::Mysql | Dialect::MsSql => {
                format!("TRUNCATE TABLE {qualified}")
            }
            Dialect::Sqlite => format!("DELETE FROM {qualified}"),
        }
    }
}

/// Skip leading whitespace and SQL comments (`-- …` line comments and
/// `/* … */` block comments) so the keyword-prefix classifiers below aren't
/// fooled by a comment sitting in front of the real statement — e.g. the
/// query editor's own placeholder text (`-- write a SQL query…`) left above
/// a pasted `SELECT` used to make [`is_read_only`] fall through to the write
/// path: the statement still ran and reported a row count, but
/// `execute_query` only fetches a result set on the read path, so the grid
/// stayed empty even though the query genuinely returned rows.
///
/// Not a real lexer — doesn't understand string/identifier quoting, so a
/// `--` or `/*` inside a string literal before the statement proper would
/// misfire. Statements never legitimately start with a quoted literal, so
/// this is good enough for "what kind of statement is this".
pub(crate) fn skip_leading_noise(sql: &str) -> &str {
    let mut s = sql;
    loop {
        let trimmed = s.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            match rest.find('\n') {
                Some(nl) => {
                    s = &rest[nl + 1..];
                    continue;
                }
                None => return "",
            }
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => {
                    s = &rest[end + 2..];
                    continue;
                }
                None => return "",
            }
        }
        return trimmed;
    }
}

/// Which kind of relation a [`Dialect::rename_stmt`] call is renaming.
///
/// The only thing it changes is Postgres's keyword and the wording of the SQL
/// Server refusal — MySQL's `RENAME TABLE` and SQLite's `ALTER TABLE … RENAME`
/// apply to a view as-is, which is exactly why the two command bodies were
/// byte-identical apart from those two strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Table,
    View,
}

impl Relation {
    fn noun(self) -> &'static str {
        match self {
            Relation::Table => "table",
            Relation::View => "view",
        }
    }
}

impl Dialect {
    /// The statement that renames `current` (in `schema`) to `new_name`.
    ///
    /// `new_name` must already be trimmed and validated; it is quoted here.
    ///
    /// SQL Server renames a table through [`mssql_sp_rename`], whose arguments
    /// are strings rather than identifiers. A *view* is refused here: a bare
    /// `sp_rename` leaves the old name inside the view's stored definition
    /// (`sys.sql_modules`), so `OBJECT_DEFINITION` and any script generated
    /// from it would recreate the view under its old name. `rename_view` sends
    /// SQL Server through `db::view_ddl::build_view_ddl` instead, which
    /// follows the rename with an `ALTER VIEW` that rewrites that text.
    ///
    /// MongoDB never reaches this: `renameCollection` is a run-command on
    /// `admin`, dispatched before any SQL is built.
    pub fn rename_stmt(
        self,
        schema: Option<&str>,
        current: &str,
        new_name: &str,
        relation: Relation,
    ) -> AppResult<String> {
        let new_ident = self.quote_ident(new_name);
        Ok(match self {
            Dialect::Postgres => {
                let kw = match relation {
                    Relation::Table => "ALTER TABLE",
                    Relation::View => "ALTER VIEW",
                };
                format!(
                    "{kw} {} RENAME TO {new_ident}",
                    self.qualify_defaulted(schema, current)
                )
            }
            // MySQL has no `ALTER VIEW … RENAME`; `RENAME TABLE` is the one
            // statement for both, and it re-qualifies the target rather than
            // taking a bare new name.
            Dialect::Mysql => match schema {
                Some(s) => format!(
                    "RENAME TABLE {} TO {}.{new_ident}",
                    self.qualify(Some(s), current),
                    self.quote_ident(s)
                ),
                None => format!("RENAME TABLE {} TO {new_ident}", self.quote_ident(current)),
            },
            // SQLite has no schemas and no `ALTER VIEW`; `ALTER TABLE` renames
            // a view there too.
            Dialect::Sqlite => format!(
                "ALTER TABLE {} RENAME TO {new_ident}",
                self.quote_ident(current)
            ),
            Dialect::MsSql => match relation {
                Relation::Table => {
                    mssql_sp_rename(&self.qualify_defaulted(schema, current), new_name, None)
                }
                Relation::View => {
                    return Err(AppError::UnsupportedDriver(format!(
                        "renaming a {} is not supported on SQL Server yet",
                        relation.noun()
                    )))
                }
            },
        })
    }
}

/// A T-SQL Unicode string literal: `N'…'`, single quotes doubled.
///
/// For the places T-SQL takes a name as a *string* — `sp_rename`'s arguments,
/// `OBJECT_ID(…)`, a catalog lookup by column name, the text handed to
/// `EXEC(…)` — where [`Dialect::quote_ident`]'s brackets would not be enough:
/// [`crate::db::ddl::validate_ident`] lets a `'` through, since it is a legal
/// character in a bracketed name.
pub fn mssql_nstring(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

/// `EXEC sp_rename N'<object>', N'<new>'[, N'<kind>']`.
///
/// `object` is the *current* name as `sp_rename` parses it — bracket-quoted
/// and schema-qualified, as [`Dialect::qualify`] renders it (`[dbo].[t]`, or
/// `[dbo].[t].[col]` for a column). `new_name` is passed **bare**: `sp_rename`
/// does not unquote its second argument, so a bracketed one would become part
/// of the name. `kind` is `Some("COLUMN")` / `Some("INDEX")`, or `None` for an
/// object.
pub fn mssql_sp_rename(object: &str, new_name: &str, kind: Option<&str>) -> String {
    let mut sql = format!(
        "EXEC sp_rename {}, {}",
        mssql_nstring(object),
        mssql_nstring(new_name)
    );
    if let Some(kind) = kind {
        sql.push_str(", ");
        sql.push_str(&mssql_nstring(kind));
    }
    sql
}

/// Best-effort classification of a SQL statement as a read-only query.
///
/// We use this to decide whether [`crate::commands::query::execute_query`]
/// should fetch a result set or just report `rows_affected`. The check is
/// intentionally simple — it inspects the first keyword after leading
/// whitespace, comments and opening parentheses. Anything unusual (DDL that
/// returns rows on some drivers) falls back to the write path and the user
/// still sees the row-count summary.
///
/// Three of the things it recognises were added because an *AI client* writes
/// SQL differently from a person at the editor, and this function decides
/// whether `crate::ai`'s `run_query` is allowed to run at all:
///
/// * **`DESCRIBE` / `DESC`** is how a model asks MySQL for a table's shape.
///   It is a read (MySQL implements it as `EXPLAIN`), it returns a result set,
///   and treating it as a write meant the assistant was refused its own read
///   and told to hand the statement to the user — the exact behaviour gotcha
///   #74 is about. Fixing it here also fixes the editor, which until now ran
///   `DESCRIBE t` down the DML path and showed a row count instead of the
///   columns.
/// * **A leading `(`**, because `(SELECT …) UNION (SELECT …)` is a perfectly
///   ordinary query that no `starts_with("select")` will ever match.
pub fn is_read_only(sql: &str) -> bool {
    let head = skip_leading_noise(sql)
        .trim_start_matches(|c: char| c == '(' || c.is_whitespace())
        .to_ascii_lowercase();
    head.starts_with("select")
        || head.starts_with("with")
        || head.starts_with("show")
        || head.starts_with("explain")
        || head.starts_with("pragma")
        || head.starts_with("describe")
        || head.starts_with("desc ")
        || head == "desc"
}

/// Write-capability tier a single SQL statement requires. Drives the MCP
/// connector's per-connection enforcement against [`crate::state::McpWritePolicy`]:
/// a `read-only` connection admits only [`StmtClass::Read`], `data` admits
/// [`StmtClass::DataWrite`] as well, and `full` admits [`StmtClass::Ddl`] too.
///
/// This classifier (and its siblings below) is consumed only by the `mcp`
/// feature's enforcement path, but its unit tests run under the default
/// feature set, so it stays compiled unconditionally and only silences the
/// dead-code lint when `mcp` is off.
/// The variants are declared least- to most-privileged.
///
/// A tier is **derived**, never decided on its own: [`Verbs::class`] maps a
/// statement's verb set onto it, so [`classify`] and [`verbs`] cannot disagree.
/// It survives because most callers only ask "is this a read?" and a few speak
/// in tiers to people (the MCP policy's "needs at least `data`").
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StmtClass {
    /// `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` / `DESCRIBE` — reads
    /// nothing back that changes state.
    Read,
    /// Row-level DML: `INSERT` / `UPDATE` / `DELETE` / `MERGE` / … — changes
    /// data but not schema.
    DataWrite,
    /// Schema / privilege change: `CREATE` / `DROP` / `ALTER` / `TRUNCATE` /
    /// `RENAME` / `GRANT` / `REVOKE` / `COMMENT`.
    Ddl,
}

/// What a statement does, as a set — the grain a permission is granted in.
///
/// [`StmtClass`] folds every row write into one `DataWrite` tier, which is all
/// the per-connection MCP policy ever needed (`data` grants the three writes
/// together). A managed policy grants them **separately** — a department may
/// insert and update but not delete — so the classifier answers in verbs and
/// the tier is derived from them ([`Verbs::class`]).
///
/// `SELECT` is listed for a statement that reads and nothing else. A write is
/// not also marked as a read even when it reads to find its rows (`UPDATE …
/// WHERE id IN (SELECT …)`): a grant that allows a write without allowing reads
/// is a policy question, answered where policies are validated, not by
/// inflating every write's verb set here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Verbs(u8);

impl Verbs {
    pub const NONE: Verbs = Verbs(0);
    pub const SELECT: Verbs = Verbs(1);
    pub const INSERT: Verbs = Verbs(1 << 1);
    pub const UPDATE: Verbs = Verbs(1 << 2);
    pub const DELETE: Verbs = Verbs(1 << 3);
    /// Schema and privilege changes, `TRUNCATE` included — kept whole, like
    /// the `full` tier it maps to.
    pub const DDL: Verbs = Verbs(1 << 4);
    /// Every row-level write: what an unrecognised statement is assumed to do.
    pub const WRITES: Verbs = Verbs(Self::INSERT.0 | Self::UPDATE.0 | Self::DELETE.0);
    pub const ALL: Verbs = Verbs(Self::SELECT.0 | Self::WRITES.0 | Self::DDL.0);

    /// Whether every verb in `needed` is in `self`.
    pub fn contains(self, needed: Verbs) -> bool {
        self.0 & needed.0 == needed.0
    }

    /// Whether `self` and `other` share any verb.
    pub fn intersects(self, other: Verbs) -> bool {
        self.0 & other.0 != 0
    }

    /// The verbs both sets hold.
    pub fn intersection(self, other: Verbs) -> Verbs {
        Verbs(self.0 & other.0)
    }

    /// `self` without the verbs in `other`.
    pub fn without(self, other: Verbs) -> Verbs {
        Verbs(self.0 & !other.0)
    }

    /// The tier this set needs: any DDL makes it `Ddl`, any row write
    /// `DataWrite`, otherwise it is a `Read`.
    pub fn class(self) -> StmtClass {
        if self.intersects(Self::DDL) {
            StmtClass::Ddl
        } else if self.intersects(Self::WRITES) {
            StmtClass::DataWrite
        } else {
            StmtClass::Read
        }
    }
}

impl std::ops::BitOr for Verbs {
    type Output = Verbs;
    fn bitor(self, other: Verbs) -> Verbs {
        Verbs(self.0 | other.0)
    }
}

/// Whether `sql` sets session or transaction state instead of reading or
/// writing data: `USE`, `SET`, `LOCK`, and every way the engines spell
/// opening, ending or marking a transaction.
///
/// Two consumers, two reasons. The AI panel refuses these with their own
/// message, because a model writes them out of habit when it believes it has
/// to select a database first. The MCP connector's `run_writes` refuses them
/// because it owns the transaction its writes run in: a `COMMIT` inside the
/// list would make everything before it permanent and leave the rest outside
/// the promise the tool makes.
///
/// A prefix check on the first statement only — callers that accept text from
/// a model split it first and refuse more than one statement.
///
/// Leading comments are skipped first, as [`is_read_only`] does. Without that,
/// `/* note */ COMMIT` was not session control, `run_writes` sent it inside
/// its transaction, and the writes before it stayed committed while the reply
/// to a later failure said everything had been rolled back.
pub fn is_session_statement(sql: &str) -> bool {
    let head = skip_leading_noise(sql).to_ascii_lowercase();
    let bare = head.trim_end().trim_end_matches(';').trim_end();
    // PostgreSQL's `END` and `ABORT` are `COMMIT` and `ROLLBACK` under other
    // names; matched whole so no other statement that starts with the letters
    // is caught.
    if matches!(bare, "end" | "abort") {
        return true;
    }
    [
        "use ",
        "set ",
        "begin",
        "start transaction",
        "commit",
        "rollback",
        "savepoint ",
        "release ",
        "save tran",
        "end transaction",
        "end work",
        "abort ",
        "xa ",
        "lock ",
        "unlock ",
    ]
    .iter()
    .any(|verb| head.starts_with(verb))
}

/// Best-effort classification of a statement as DDL (schema/privilege change).
///
/// Mostly the same first-keyword heuristic as [`is_read_only`]. `TRUNCATE` is
/// grouped with DDL rather than DML on purpose: it is an irreversible
/// whole-table operation, so it belongs behind the strictest (`full`) tier, not
/// the row-level `data` tier.
///
/// Two additions exist for T-SQL, whose statement vocabulary the plain
/// keyword-prefix rule classifies too leniently:
///
/// * **`EXEC` / `EXECUTE`** is opaque. `EXEC sp_rename …` renames an object and
///   `EXEC('DROP TABLE t')` runs arbitrary text, so a procedure call cannot be
///   assumed to be data-only. It is put behind the `full` tier, which means a
///   read-only `EXEC sp_help` is refused too — the safe direction for a
///   security boundary.
/// * **`SELECT … INTO t`** creates a table. It starts with `select`, so the
///   prefix rule alone reports a read.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_ddl(sql: &str) -> bool {
    let head = skip_leading_noise(sql).to_ascii_lowercase();
    const DDL_PREFIXES: [&str; 10] = [
        "create", "drop", "alter", "truncate", "rename", "grant", "revoke", "comment", "exec",
        "execute",
    ];
    DDL_PREFIXES.iter().any(|p| head.starts_with(p)) || is_select_into(&head)
}

/// Whether an already-lowercased, comment-stripped statement is T-SQL's
/// table-creating `SELECT … INTO <table> FROM …`.
///
/// `INTO` is matched as a whole word anywhere in the statement rather than
/// positionally, so a literal or alias that merely contains the word can push a
/// genuine read into the DDL tier. That is the deliberate direction: the cost is
/// a refused `SELECT 'into'` under a restricted MCP policy, whereas the
/// opposite error would let a statement that creates a table pass as a read.
/// [`is_read_only`] is intentionally *not* changed by this — it also drives
/// whether the GUI fetches a result set, and there a false positive would blank
/// the grid for an ordinary query.
///
/// Under a `WITH` head the `INTO` of `INSERT INTO` / `MERGE INTO` is not a
/// `SELECT … INTO`: that statement is row-level DML behind a CTE, and reporting
/// it as DDL put `WITH src AS (…) INSERT INTO t SELECT …` out of reach of a
/// `data` connection. [`with_dml_verbs`] gives it its real verbs instead.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn is_select_into(head_lower: &str) -> bool {
    if head_lower.starts_with("select") {
        return contains_word(head_lower, "into");
    }
    if !head_lower.starts_with("with") {
        return false;
    }
    let words = words(head_lower);
    words.iter().enumerate().any(|(i, w)| {
        *w == "into" && !matches!(i.checked_sub(1).map(|p| words[p]), Some("insert" | "merge"))
    })
}

/// The row-level writes a statement that opens with `WITH` performs — empty
/// when it only reads.
///
/// Postgres lets a CTE carry DML — `WITH d AS (DELETE FROM t RETURNING *)
/// SELECT * FROM d` — and both Postgres and MySQL 8 accept a `WITH` in front of
/// a top-level `INSERT` / `UPDATE` / `DELETE`. By its first keyword every one of
/// them is a read, and [`classify`] reported exactly that until this check
/// existed: a `read-only` MCP connection and the AI panel's no-write rule both
/// let a `WITH`-prefixed `DELETE` through, and the server ran it.
///
/// A DML keyword anywhere in the statement's *code* counts, each for its own
/// verb. Literals, quoted identifiers and comments are blanked first by
/// [`mask_non_code`], so `WHERE action = 'update'` is still a read. The
/// spellings of the keywords that are not DML are excluded — the row-locking
/// clauses `FOR UPDATE` / `FOR NO KEY UPDATE`, and T-SQL's `MERGE JOIN` hint —
/// but only those: `ON DUPLICATE KEY UPDATE` is an update. A `MERGE` claims all
/// three writes. Anything else errs towards the write, which is the safe
/// direction for a boundary.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn with_dml_verbs(sql: &str) -> Verbs {
    let masked = String::from_utf8_lossy(&mask_non_code(sql)).to_ascii_lowercase();
    let words = words(&masked);
    let back = |i: usize, n: usize| i.checked_sub(n).and_then(|j| words.get(j)).copied();
    words
        .iter()
        .enumerate()
        .fold(Verbs::NONE, |verbs, (i, w)| match *w {
            "insert" => verbs | Verbs::INSERT,
            "delete" => verbs | Verbs::DELETE,
            "update" if back(i, 1) == Some("for") => verbs,
            "update" if back(i, 1) == Some("key") && back(i, 2) == Some("no") => verbs,
            "update" => verbs | Verbs::UPDATE,
            "merge" if words.get(i + 1) == Some(&"join") => verbs,
            "merge" => verbs | Verbs::WRITES,
            _ => verbs,
        })
}

/// The writes a statement that is neither DDL nor read-shaped performs.
///
/// Read from the statement's own keywords, most of them from the first:
///
/// * `INSERT` inserts — and updates as well when it is an upsert (`ON CONFLICT
///   … DO UPDATE`, MySQL's `ON DUPLICATE KEY UPDATE`), and deletes as well as
///   SQLite's `INSERT OR REPLACE`, which removes the conflicting row first.
/// * `REPLACE` (MySQL, SQLite) is a delete-then-insert.
/// * `UPDATE` updates, `DELETE` deletes.
/// * `MERGE` does what its `WHEN … THEN` branches say; with none that can be
///   read (only `DO NOTHING`, or text this cannot follow) it claims all three.
/// * Anything else — `CALL`, `DO`, `COPY`, `LOAD DATA`, `SET`, … — claims all
///   three: an unrecognised statement must not slip in under a narrower grant.
///
/// Never empty, and never only `SELECT`: a statement that reaches this is not
/// a read, and returning less would lower its tier.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn dml_verbs(sql: &str) -> Verbs {
    let masked =
        String::from_utf8_lossy(&mask_non_code(skip_leading_noise(sql))).to_ascii_lowercase();
    let words = words(&masked);
    let has_pair = |a: &str, b: &str| words.windows(2).any(|w| w[0] == a && w[1] == b);
    match words.first().copied() {
        Some("insert") => {
            let mut verbs = Verbs::INSERT;
            if has_pair("do", "update") || has_pair("key", "update") {
                verbs = verbs | Verbs::UPDATE;
            }
            if words.get(1) == Some(&"or") && words.get(2) == Some(&"replace") {
                verbs = verbs | Verbs::DELETE;
            }
            verbs
        }
        Some("replace") => Verbs::INSERT | Verbs::DELETE,
        Some("update") => Verbs::UPDATE,
        Some("delete") => Verbs::DELETE,
        Some("merge") => {
            let branches =
                words
                    .windows(2)
                    .filter(|w| w[0] == "then")
                    .fold(Verbs::NONE, |verbs, w| match w[1] {
                        "insert" => verbs | Verbs::INSERT,
                        "update" => verbs | Verbs::UPDATE,
                        "delete" => verbs | Verbs::DELETE,
                        _ => verbs,
                    });
            if branches == Verbs::NONE {
                Verbs::WRITES
            } else {
                branches
            }
        }
        _ => Verbs::WRITES,
    }
}

/// The statement an `EXPLAIN ANALYZE` runs, if `head_lower` is one.
///
/// `EXPLAIN ANALYZE` is not a preview: Postgres (and MySQL 8's `EXPLAIN
/// ANALYZE`) *execute* the statement to measure it, so `EXPLAIN ANALYZE DELETE
/// FROM t` deletes. A plain `EXPLAIN` only plans, and stays a read. Accepts
/// both the parenthesised option list (`EXPLAIN (ANALYZE, BUFFERS) …`, where any
/// mention of `ANALYZE` counts — `ANALYZE false` is rare enough that erring
/// towards "it runs" costs nothing) and the bare keywords, in either spelling,
/// with `VERBOSE` and MySQL's `FORMAT = …` around them.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn explain_analyze_target(head_lower: &str) -> Option<&str> {
    let mut rest = head_lower.strip_prefix("explain")?.trim_start();
    let mut analyze = false;
    if let Some(options) = rest.strip_prefix('(') {
        let close = options.find(')')?;
        analyze = contains_word(&options[..close], "analyze")
            || contains_word(&options[..close], "analyse");
        rest = options[close + 1..].trim_start();
    } else {
        loop {
            let word_end = rest
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            match &rest[..word_end] {
                "analyze" | "analyse" => analyze = true,
                "verbose" => {}
                "format" => {
                    // `FORMAT = TREE`, `FORMAT=JSON`: skip the `=` and its value.
                    let after = rest[word_end..]
                        .trim_start()
                        .strip_prefix('=')?
                        .trim_start();
                    let value_end = after
                        .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                        .unwrap_or(after.len());
                    rest = after[value_end..].trim_start();
                    continue;
                }
                _ => break,
            }
            rest = rest[word_end..].trim_start();
        }
    }
    analyze.then_some(rest)
}

/// What a read-looking statement really does: a `SELECT`, unless it is a
/// `WITH` that carries DML or an `EXPLAIN ANALYZE` of something that is not a
/// read.
///
/// Kept apart from [`is_read_only`] on purpose — that one also decides whether
/// the GUI fetches a result set, and a `WITH … DELETE … RETURNING` does return
/// rows. This is only about what the statement *needs*.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn read_verbs(sql: &str) -> Verbs {
    let head = skip_leading_noise(sql)
        .trim_start_matches(|c: char| c == '(' || c.is_whitespace())
        .to_ascii_lowercase();
    if head.starts_with("with") {
        let writes = with_dml_verbs(&head);
        if writes != Verbs::NONE {
            return writes;
        }
    }
    if let Some(target) = explain_analyze_target(&head) {
        // Nothing after the options means there is nothing we can vouch for.
        return if target.is_empty() {
            Verbs::WRITES
        } else {
            verbs_one(target)
        };
    }
    Verbs::SELECT
}

/// Split `sql` into its top-level statements.
///
/// A `;` separates only when it is not inside a string literal, a quoted
/// identifier (`"…"`, `` `…` ``, `[…]`), a comment, or a Postgres
/// dollar-quoted body. Empty statements — a trailing semicolon, a `;;` — are
/// dropped, so a single statement written either way yields exactly one part.
///
/// # Why this exists
///
/// [`classify`] used to read the first keyword of whatever text it was handed
/// and report *one* tier for it. That is correct for one statement and wrong
/// for two: `SELECT 1; DELETE FROM t` classified as a read, and both
/// enforcement points that consume this — the MCP connector's per-connection
/// policy and `crate::ai::exec`'s no-write rule — took that answer. Whether
/// the second statement actually ran was then a driver accident rather than a
/// decision: the prepared protocol rejects a multi-statement string on
/// Postgres and MySQL, while a T-SQL batch and SQLite's own loop run every
/// statement in it. An authorisation boundary that holds on three drivers out
/// of five is not a boundary.
///
/// This is not a SQL parser and is not trying to be (ADR #33): it only
/// needs to know where a statement ends, which is a lexical question.
pub fn split_statements(sql: &str) -> Vec<&str> {
    let masked = mask_non_code(sql);
    let mut parts = Vec::new();
    let mut start = 0usize;
    for (i, &byte) in masked.iter().enumerate() {
        if byte == b';' {
            parts.push(&sql[start..i]);
            start = i + 1;
        }
    }
    parts.push(&sql[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

/// `sql` with every byte that is not code blanked to a space: string literals,
/// quoted identifiers (`"…"`, `` `…` ``, `[…]`), comments and Postgres
/// dollar-quoted bodies, delimiters included.
///
/// Byte offsets line up with `sql`, which is what lets [`split_statements`]
/// cut the original text wherever the mask still shows a `;`, and lets
/// [`with_dml_verbs`] look for keywords without a literal `'delete'`
/// counting as one. One lexer for both, so the two can never disagree about
/// where a string ends. Bytes rather than a `String`: the offsets are what
/// matter, and nothing here should be able to panic on odd input.
fn mask_non_code(sql: &str) -> Vec<u8> {
    let bytes = sql.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        let from = i;
        match bytes[i] {
            // A string literal or a quoted identifier. The closing quote may be
            // doubled to escape itself in every dialect here, and backslash-
            // escaped inside MySQL's string literals.
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' && quote != b'`' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == quote {
                        if bytes.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            // T-SQL's bracketed identifier: `]]` escapes a bracket.
            b'[' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b']' {
                        if bytes.get(i + 1) == Some(&b']') {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            // Postgres nests block comments; the others do not, and treating
            // them as nesting only ever ends a comment later than they would.
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                let mut depth = 1usize;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            // `$tag$ … $tag$`, which is how a Postgres function body carries
            // semicolons. An unterminated one swallows the rest, which is the
            // safe direction: the statement is one statement.
            b'$' => match dollar_tag(&sql[i..]) {
                Some(tag) => {
                    i += tag.len();
                    match sql[i..].find(tag) {
                        Some(at) => i += at + tag.len(),
                        None => i = bytes.len(),
                    }
                }
                None => {
                    i += 1;
                    continue;
                }
            },
            // Code, `;` included: left as it is.
            _ => {
                i += 1;
                continue;
            }
        }
        // A backslash escape can step past the end of an unterminated literal.
        let to = i.min(bytes.len());
        out[from..to].fill(b' ');
    }
    out
}

/// The identifier-shaped words of `s`, in order — the tokeniser
/// [`contains_word`] uses, for callers that also need a word's neighbours.
fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .collect()
}

/// The `$tag$` opening a dollar-quoted body at the start of `rest`, if there is
/// one. `$$` is the anonymous tag; `$1` (a bind placeholder) is not a tag.
fn dollar_tag(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    debug_assert_eq!(bytes.first(), Some(&b'$'));
    let mut end = 1;
    while bytes
        .get(end)
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
    {
        end += 1;
    }
    (bytes.get(end) == Some(&b'$')).then(|| &rest[..=end])
}

/// Classify `sql` into the write tier it requires — the **strictest** tier any
/// statement in it requires, if it carries more than one.
///
/// Per statement, DDL is checked first, then reads, then everything else falls
/// to row-level DML — the conservative default, since an unrecognised non-read
/// statement must not slip in under a read-only or data-only policy. The
/// DDL-first order matters: [`is_ddl`] catches statements that *look* like reads
/// by their first keyword but change schema (`SELECT … INTO`), and it must win
/// over [`is_read_only`] for those.
///
/// Taking the strictest tier over [`split_statements`] is what makes the answer
/// safe for text an AI client wrote: see that function for what the head-only
/// version let through.
///
/// Derived from [`verbs`], never decided on its own: the tier is the verb set's
/// [`Verbs::class`], so the two cannot disagree about a statement. Callers go
/// through `db::classify::classify_statement`, which picks the grammar first;
/// this is the SQL half, kept for the tests that pin tiers.
#[cfg(test)]
pub fn classify(sql: &str) -> StmtClass {
    verbs(sql).class()
}

/// Everything `sql` does, as a set of [`Verbs`] — the union over every
/// statement in it (ADR #76), so `SELECT 1; DELETE FROM t` needs `delete`.
///
/// Nothing to classify — an empty string, or only semicolons — needs every row
/// write, for the same reason an unrecognised statement does: the conservative
/// direction is the safe one.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn verbs(sql: &str) -> Verbs {
    let parts = split_statements(sql);
    if parts.is_empty() {
        return Verbs::WRITES;
    }
    parts
        .into_iter()
        .map(verbs_one)
        .fold(Verbs::NONE, |all, one| all | one)
}

#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn verbs_one(sql: &str) -> Verbs {
    if is_ddl(sql) {
        Verbs::DDL
    } else if is_read_only(sql) {
        read_verbs(sql)
    } else {
        dml_verbs(sql)
    }
}

/// Whether `sql` is an `UPDATE` or `DELETE` with no `WHERE` clause — a
/// whole-table mutation. The MCP connector refuses these outright (even at
/// `data`/`full` tiers): an AI client emitting an unqualified `DELETE FROM t`
/// or `UPDATE t SET …` is a classic footgun, and requiring an explicit
/// predicate (a literal `WHERE 1=1` if the user really means "all rows")
/// turns a silent whole-table wipe into a deliberate one.
///
/// `WHERE` is matched as a whole token (case-insensitive) so a column or value
/// merely containing the substring doesn't count. A `WHERE` living only inside
/// a comment is a tolerated blind spot — single AI-authored statements rarely
/// carry comments, and this is a guard-rail layered on top of the tier check,
/// not the primary authorisation.
/// Checked per statement, for the same reason [`classify`] is: the guard has to
/// see a whole-table `DELETE` that arrives behind a harmless first statement.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_unfiltered_write(sql: &str) -> bool {
    split_statements(sql).into_iter().any(|part| {
        let head = part.trim_start().to_ascii_lowercase();
        if !(head.starts_with("update") || head.starts_with("delete")) {
            return false;
        }
        !contains_word(&head, "where")
    })
}

/// True if `word` appears in `haystack_lower` (already lowercased) delimited by
/// non-identifier characters on both sides — a poor-man's tokeniser good enough
/// to spot SQL keywords without a full parser.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn contains_word(haystack_lower: &str, word: &str) -> bool {
    haystack_lower
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|tok| tok == word)
}

#[cfg(test)]
mod tests {
    use super::{
        classify, is_ddl, is_read_only, is_unfiltered_write, mssql_sp_rename, split_statements,
        verbs, Dialect, Relation, StmtClass, Verbs,
    };

    #[test]
    fn truncate_stmt_is_delete_only_on_sqlite() {
        assert_eq!(
            Dialect::Postgres.truncate_stmt("\"public\".\"t\""),
            "TRUNCATE TABLE \"public\".\"t\""
        );
        assert_eq!(
            Dialect::Mysql.truncate_stmt("`db`.`t`"),
            "TRUNCATE TABLE `db`.`t`"
        );
        assert_eq!(
            Dialect::MsSql.truncate_stmt("[dbo].[t]"),
            "TRUNCATE TABLE [dbo].[t]"
        );
        // SQLite has no TRUNCATE at all.
        assert_eq!(Dialect::Sqlite.truncate_stmt("\"t\""), "DELETE FROM \"t\"");
    }

    #[test]
    fn rename_differs_from_a_view_rename_only_on_postgres() {
        // MySQL's `RENAME TABLE` and SQLite's `ALTER TABLE … RENAME` are the
        // statement for a view too, which is why the two command bodies this
        // replaced were byte-identical apart from Postgres's keyword.
        for relation in [Relation::Table, Relation::View] {
            assert_eq!(
                Dialect::Mysql
                    .rename_stmt(Some("shop"), "album", "record", relation)
                    .unwrap(),
                "RENAME TABLE `shop`.`album` TO `shop`.`record`"
            );
            assert_eq!(
                Dialect::Sqlite
                    .rename_stmt(None, "album", "record", relation)
                    .unwrap(),
                "ALTER TABLE \"album\" RENAME TO \"record\""
            );
        }
        assert_eq!(
            Dialect::Postgres
                .rename_stmt(None, "album", "record", Relation::Table)
                .unwrap(),
            "ALTER TABLE \"public\".\"album\" RENAME TO \"record\""
        );
        assert_eq!(
            Dialect::Postgres
                .rename_stmt(None, "album", "record", Relation::View)
                .unwrap(),
            "ALTER VIEW \"public\".\"album\" RENAME TO \"record\""
        );
    }

    #[test]
    fn mysql_rename_re_qualifies_the_target_only_when_a_schema_is_known() {
        assert_eq!(
            Dialect::Mysql
                .rename_stmt(None, "album", "record", Relation::Table)
                .unwrap(),
            "RENAME TABLE `album` TO `record`"
        );
    }

    #[test]
    fn sql_server_renames_a_table_through_sp_rename_but_not_a_view() {
        // The current name bracket-quoted and qualified (defaulting to `dbo`),
        // the new one bare, both as N-strings with `'` doubled.
        assert_eq!(
            Dialect::MsSql
                .rename_stmt(None, "album", "record", Relation::Table)
                .unwrap(),
            "EXEC sp_rename N'[dbo].[album]', N'record'"
        );
        assert_eq!(
            Dialect::MsSql
                .rename_stmt(Some("sales"), "o'neil", "x]y", Relation::Table)
                .unwrap(),
            "EXEC sp_rename N'[sales].[o''neil]', N'x]y'"
        );
        // A view's stored definition would keep the old name.
        let err = Dialect::MsSql
            .rename_stmt(None, "album", "record", Relation::View)
            .unwrap_err()
            .to_string();
        assert!(err.contains("view"), "{err}");
    }

    #[test]
    fn sp_rename_takes_a_kind_for_columns() {
        assert_eq!(
            mssql_sp_rename("[dbo].[t].[old]", "new", Some("COLUMN")),
            "EXEC sp_rename N'[dbo].[t].[old]', N'new', N'COLUMN'"
        );
    }

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::Postgres.quote_ident("tbl"), "\"tbl\"");
        assert_eq!(Dialect::Sqlite.quote_ident("tbl"), "\"tbl\"");
        assert_eq!(Dialect::Mysql.quote_ident("tbl"), "`tbl`");
        assert_eq!(Dialect::MsSql.quote_ident("tbl"), "[tbl]");
    }

    #[test]
    fn escapes_the_closing_quote_character_by_doubling_it() {
        // A catalog can legitimately hand us an identifier containing the
        // quote character; doubling it is the standard SQL escape and the one
        // SQL Server uses for `]` inside brackets.
        assert_eq!(Dialect::Postgres.quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(Dialect::Mysql.quote_ident("we`ird"), "`we``ird`");
        assert_eq!(Dialect::MsSql.quote_ident("we]ird"), "[we]]ird]");
    }

    #[test]
    fn numbers_placeholders_only_where_the_dialect_does() {
        assert_eq!(Dialect::Postgres.placeholder(3), "$3");
        assert_eq!(Dialect::MsSql.placeholder(3), "@P3");
        assert_eq!(Dialect::Mysql.placeholder(3), "?");
        assert_eq!(Dialect::Sqlite.placeholder(3), "?");
    }

    #[test]
    fn paginates_with_limit_offset_or_offset_fetch() {
        assert_eq!(
            Dialect::Postgres.paginate(50, 100, true),
            " LIMIT 50 OFFSET 100"
        );
        // The ORDER BY is not optional in T-SQL's OFFSET/FETCH, so an unsorted
        // browse gets a filler one.
        assert_eq!(
            Dialect::MsSql.paginate(50, 100, true),
            " OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY"
        );
        assert_eq!(
            Dialect::MsSql.paginate(50, 0, false),
            " ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY"
        );
    }

    #[test]
    fn qualifies_names_per_dialect() {
        assert_eq!(
            Dialect::Postgres.qualify(Some("s"), "t"),
            "\"s\".\"t\"".to_string()
        );
        assert_eq!(
            Dialect::MsSql.qualify(Some("s"), "t"),
            "[s].[t]".to_string()
        );
        assert_eq!(Dialect::Mysql.qualify(None, "t"), "`t`".to_string());
        // SQLite has no schemas: a stray one is dropped rather than emitted as
        // an attached-database prefix.
        assert_eq!(Dialect::Sqlite.qualify(Some("main"), "t"), "\"t\"");
        // The defaulted variant pins the engine's default schema so an
        // unqualified name can't resolve through `search_path`.
        assert_eq!(
            Dialect::Postgres.qualify_defaulted(None, "t"),
            "\"public\".\"t\""
        );
        assert_eq!(Dialect::MsSql.qualify_defaulted(None, "t"), "[dbo].[t]");
        assert_eq!(Dialect::Mysql.qualify_defaulted(None, "t"), "`t`");
        assert_eq!(Dialect::Sqlite.qualify_defaulted(None, "t"), "\"t\"");
    }

    #[test]
    fn classifies_reads_as_read_only() {
        for sql in [
            "SELECT * FROM t",
            "  select 1",
            "\n\tWITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "PRAGMA table_info(t)",
        ] {
            assert!(is_read_only(sql), "expected read-only: {sql:?}");
        }
    }

    #[test]
    fn a_leading_comment_does_not_defeat_read_only_detection() {
        // The query editor's own placeholder ("-- write a SQL query and
        // press Ctrl+Enter") left above a pasted SELECT used to make this
        // fall through to the write path, which silently drops the result
        // set (execute_query only fetches rows on the read path).
        for sql in [
            "-- write a SQL query and press Ctrl+Enter\nSELECT * FROM t",
            "-- a comment\n-- another comment\nselect 1",
            "/* block comment */ SELECT 1",
            "/* multi\nline */\nSELECT 1",
        ] {
            assert!(is_read_only(sql), "expected read-only: {sql:?}");
        }
    }

    #[test]
    fn an_unterminated_leading_comment_is_not_read_only() {
        // No real statement follows the comment, so there is nothing to
        // classify as a read — falling to the write path is the safe default.
        for sql in ["-- trailing comment with no newline", "/* unterminated"] {
            assert!(!is_read_only(sql), "expected non-read-only: {sql:?}");
        }
    }

    #[test]
    fn classifies_writes_as_not_read_only() {
        // Backs the MCP `run_query` guard: none of these may pass in the
        // read-only server mode.
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "CREATE TABLE t (id INT)",
            "ALTER TABLE t ADD COLUMN c INT",
            "TRUNCATE t",
        ] {
            assert!(!is_read_only(sql), "expected write: {sql:?}");
        }
    }

    #[test]
    fn classify_splits_read_data_and_ddl() {
        assert_eq!(classify("SELECT 1"), StmtClass::Read);
        assert_eq!(
            classify("  with x as (select 1) select * from x"),
            StmtClass::Read
        );
        assert_eq!(classify("INSERT INTO t VALUES (1)"), StmtClass::DataWrite);
        assert_eq!(
            classify("UPDATE t SET a = 1 WHERE id = 2"),
            StmtClass::DataWrite
        );
        assert_eq!(classify("delete from t where id = 1"), StmtClass::DataWrite);
        assert_eq!(classify("CREATE TABLE t (id INT)"), StmtClass::Ddl);
        assert_eq!(classify("drop table t"), StmtClass::Ddl);
        assert_eq!(classify("ALTER TABLE t ADD COLUMN c INT"), StmtClass::Ddl);
        assert_eq!(classify("TRUNCATE t"), StmtClass::Ddl);
        assert_eq!(classify("GRANT SELECT ON t TO u"), StmtClass::Ddl);
        // An unrecognised non-read statement is conservatively DataWrite so it
        // can never pass under a read-only policy. `MERGE INTO` is DML, not
        // DDL, even though it carries the `INTO` that `SELECT … INTO` is
        // detected by — the `select`/`with` prefix requirement keeps them
        // apart.
        assert_eq!(
            classify("MERGE INTO t USING s ON (t.id = s.id)"),
            StmtClass::DataWrite
        );
    }

    #[test]
    fn t_sql_statements_that_look_like_reads_are_classified_as_ddl() {
        // `SELECT … INTO` creates a table; the first-keyword rule alone reads
        // it as a plain SELECT, which would let it through a read-only MCP
        // policy.
        assert_eq!(
            classify("SELECT * INTO archive FROM orders"),
            StmtClass::Ddl
        );
        assert_eq!(
            classify("with x as (select 1) select * into t from x"),
            StmtClass::Ddl
        );
        // A procedure call is opaque: it can rename objects or run dynamic
        // DDL, so it sits behind the strictest tier.
        assert_eq!(classify("EXEC sp_rename 'a', 'b'"), StmtClass::Ddl);
        assert_eq!(classify("execute dbo.DoSomething"), StmtClass::Ddl);
        // A plain SELECT with no INTO stays a read.
        assert_eq!(classify("SELECT TOP 10 * FROM orders"), StmtClass::Read);
    }

    #[test]
    fn a_semicolon_only_splits_outside_quotes_comments_and_dollar_bodies() {
        // The ordinary cases: one statement however it is punctuated.
        for sql in ["SELECT 1", "SELECT 1;", "  SELECT 1 ;; ", ";SELECT 1"] {
            assert_eq!(split_statements(sql).len(), 1, "{sql:?}");
        }
        assert_eq!(split_statements("SELECT 1; SELECT 2").len(), 2);

        // A semicolon that is data, not punctuation.
        for sql in [
            "SELECT ';'",
            "SELECT 'it''s; fine'",
            "SELECT 'escaped\\'; still one'",
            "SELECT \"a;b\" FROM t",
            "SELECT `a;b` FROM t",
            "SELECT [a;b] FROM t",
            "SELECT 1 -- ; not a statement",
            "SELECT 1 /* ; nor this */",
            "SELECT 1 /* /* nested ; */ */",
            "SELECT $$a; b$$",
            "SELECT $tag$a; b$tag$",
        ] {
            assert_eq!(split_statements(sql).len(), 1, "{sql:?}");
        }

        // A bind placeholder is not a dollar-quoted body, so the semicolon
        // after it still separates.
        assert_eq!(split_statements("SELECT $1; SELECT $2").len(), 2);
        // Non-ASCII text is sliced on the right boundaries.
        assert_eq!(
            split_statements("SELECT 'año'; SELECT 'ñ'"),
            vec!["SELECT 'año'", "SELECT 'ñ'"]
        );
    }

    /// The hole this closed: a write hidden behind a leading read.
    ///
    /// `classify` reported `Read` for the whole string, so both the MCP
    /// connector's read-only tier and the AI panel's no-write rule admitted it,
    /// and whether the `DELETE` ran came down to which driver's protocol
    /// happened to reject multi-statement text.
    #[test]
    fn a_write_behind_a_read_is_classified_as_the_write() {
        assert_eq!(
            classify("SELECT 1; DELETE FROM t WHERE id = 1"),
            StmtClass::DataWrite
        );
        assert_eq!(classify("SELECT 1; DROP TABLE t"), StmtClass::Ddl);
        assert_eq!(
            classify("-- innocent\nSELECT 1;\nGRANT ALL ON t TO u"),
            StmtClass::Ddl
        );
        // And the guard sees it too, wherever in the batch it sits.
        assert!(is_unfiltered_write("SELECT 1; DELETE FROM t"));
        assert!(!is_unfiltered_write("SELECT 1; DELETE FROM t WHERE id = 1"));

        // Several reads stay a read: the rule is the strictest tier present,
        // not "more than one statement is suspicious".
        assert_eq!(classify("SELECT 1; SELECT 2"), StmtClass::Read);
    }

    #[test]
    fn row_writes_are_told_apart() {
        let (i, u, d) = (Verbs::INSERT, Verbs::UPDATE, Verbs::DELETE);
        for (sql, expected) in [
            ("INSERT INTO t VALUES (1)", i),
            ("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING", i),
            ("INSERT IGNORE INTO t VALUES (1)", i),
            ("INSERT INTO t SELECT * FROM s", i),
            // A literal that reads like an upsert clause is still a literal.
            ("INSERT INTO t VALUES ('on duplicate key update')", i),
            ("UPDATE t SET a = 1 WHERE id = 1", u),
            ("DELETE FROM t WHERE id = 1", d),
            (
                "-- note
DELETE FROM t WHERE id = 1",
                d,
            ),
        ] {
            assert_eq!(verbs(sql), expected, "{sql}");
        }
    }

    #[test]
    fn a_statement_that_does_two_things_needs_both() {
        let (i, u, d) = (Verbs::INSERT, Verbs::UPDATE, Verbs::DELETE);
        for (sql, expected) in [
            // Upserts update the rows they collide with.
            ("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1", i | u),
            ("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1", i | u),
            // A replace removes the conflicting row, then inserts.
            ("REPLACE INTO t VALUES (1)", i | d),
            ("INSERT OR REPLACE INTO t VALUES (1)", i | d),
            // MERGE does what its branches say.
            (
                "MERGE INTO t USING s ON t.id = s.id                  WHEN MATCHED THEN UPDATE SET a = s.a                  WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)",
                i | u,
            ),
            (
                "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
                d,
            ),
            // A batch needs everything any statement in it needs.
            ("INSERT INTO t VALUES (1); UPDATE t SET a = 2 WHERE id = 1", i | u),
            ("SELECT 1; DELETE FROM t WHERE id = 1", Verbs::SELECT | d),
            // Behind a WITH, and behind EXPLAIN ANALYZE.
            ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", d),
            (
                "WITH s AS (SELECT 1 AS id) INSERT INTO t SELECT id FROM s                  ON DUPLICATE KEY UPDATE a = 1",
                i | u,
            ),
            ("EXPLAIN ANALYZE UPDATE t SET a = 1 WHERE id = 1", u),
        ] {
            assert_eq!(verbs(sql), expected, "{sql}");
        }
    }

    #[test]
    fn what_cannot_be_read_claims_every_row_write() {
        for sql in [
            "CALL do_things()",
            "DO $$ BEGIN DELETE FROM t; END $$",
            "COPY t FROM '/tmp/x.csv'",
            "LOAD DATA INFILE 'x' INTO TABLE t",
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DO NOTHING",
            "",
            ";;",
        ] {
            assert_eq!(verbs(sql), Verbs::WRITES, "{sql:?}");
        }
    }

    #[test]
    fn reads_and_ddl_keep_their_verb() {
        for sql in [
            "SELECT 1",
            "SHOW TABLES",
            "EXPLAIN DELETE FROM t",
            "WITH x AS (SELECT 1) SELECT * FROM x",
        ] {
            assert_eq!(verbs(sql), Verbs::SELECT, "{sql}");
        }
        for sql in [
            "DROP TABLE t",
            "TRUNCATE t",
            "SELECT a INTO t2 FROM t",
            "EXEC sp_help",
        ] {
            assert_eq!(verbs(sql), Verbs::DDL, "{sql}");
        }
    }

    #[test]
    fn a_tier_is_the_class_of_its_verbs() {
        assert_eq!(Verbs::SELECT.class(), StmtClass::Read);
        for write in [Verbs::INSERT, Verbs::UPDATE, Verbs::DELETE, Verbs::WRITES] {
            assert_eq!(write.class(), StmtClass::DataWrite);
            assert_eq!((Verbs::SELECT | write).class(), StmtClass::DataWrite);
        }
        assert_eq!((Verbs::DELETE | Verbs::DDL).class(), StmtClass::Ddl);
        assert_eq!(Verbs::ALL.class(), StmtClass::Ddl);
        assert!(Verbs::WRITES.contains(Verbs::UPDATE));
        assert!(!Verbs::INSERT.contains(Verbs::INSERT | Verbs::DELETE));
    }

    #[test]
    fn a_with_that_carries_dml_is_a_write() {
        for sql in [
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "WITH u AS (UPDATE t SET a = 1 WHERE id = 2 RETURNING *) SELECT * FROM u",
            "with d as (delete from t returning id) select count(*) from d",
            "WITH src AS (SELECT 1 AS id) INSERT INTO t (id) SELECT id FROM src",
            "WITH src AS (SELECT id FROM s) UPDATE t SET a = 1 WHERE id IN (SELECT id FROM src)",
            "WITH src AS (SELECT id FROM s) DELETE FROM t WHERE id IN (SELECT id FROM src)",
            "-- looks harmless\nWITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "(WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d)",
        ] {
            assert_eq!(classify(sql), StmtClass::DataWrite, "{sql}");
            // The GUI still fetches their result set: `RETURNING` returns rows.
            assert!(is_read_only(sql) || sql.contains("INSERT"), "{sql}");
        }
    }

    #[test]
    fn a_with_that_only_reads_stays_a_read() {
        for sql in [
            "WITH x AS (SELECT 1) SELECT * FROM x",
            // The words are data or names here, not statements.
            "WITH x AS (SELECT * FROM log WHERE action = 'delete') SELECT * FROM x",
            "WITH x AS (SELECT \"update\" FROM t) SELECT * FROM x",
            "WITH x AS (SELECT 1 /* delete */) SELECT * FROM x",
            "WITH x AS (SELECT $$insert$$) SELECT * FROM x",
            // Row locks and a join hint borrow the keywords.
            "WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x",
            "WITH x AS (SELECT * FROM t FOR NO KEY UPDATE) SELECT * FROM x",
            "WITH x AS (SELECT * FROM a INNER MERGE JOIN b ON a.id = b.id) SELECT * FROM x",
        ] {
            assert_eq!(classify(sql), StmtClass::Read, "{sql}");
        }
    }

    #[test]
    fn a_with_in_front_of_insert_into_is_dml_not_select_into() {
        // It used to be DDL, because of the `into`, which kept it away from a
        // `data` connection that is allowed to insert.
        let sql = "WITH src AS (SELECT 1 AS id) INSERT INTO t (id) SELECT id FROM src";
        assert!(!is_ddl(sql));
        assert_eq!(classify(sql), StmtClass::DataWrite);
        // A real `SELECT … INTO` behind a `WITH` still creates a table.
        assert_eq!(
            classify("WITH x AS (SELECT 1 AS a) SELECT a INTO t2 FROM x"),
            StmtClass::Ddl
        );
    }

    #[test]
    fn explain_analyze_takes_the_tier_of_what_it_runs() {
        for sql in [
            "EXPLAIN ANALYZE DELETE FROM t WHERE id = 1",
            "EXPLAIN ANALYSE UPDATE t SET a = 1 WHERE id = 1",
            "EXPLAIN (ANALYZE, BUFFERS) INSERT INTO t VALUES (1)",
            "EXPLAIN (FORMAT JSON, ANALYZE true) DELETE FROM t WHERE id = 1",
            "EXPLAIN ANALYZE VERBOSE DELETE FROM t WHERE id = 1",
            "EXPLAIN ANALYZE FORMAT=TREE UPDATE t SET a = 1 WHERE id = 1",
            // Nothing after the options: there is nothing to vouch for.
            "EXPLAIN ANALYZE",
        ] {
            assert_eq!(classify(sql), StmtClass::DataWrite, "{sql}");
        }
        assert_eq!(
            classify("EXPLAIN ANALYZE CREATE TABLE t2 AS SELECT * FROM t"),
            StmtClass::Ddl
        );
        assert_eq!(
            classify("EXPLAIN ANALYZE WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
            StmtClass::DataWrite
        );
    }

    #[test]
    fn a_plain_explain_only_plans_and_stays_a_read() {
        for sql in [
            "EXPLAIN DELETE FROM t WHERE id = 1",
            "EXPLAIN FORMAT=JSON UPDATE t SET a = 1 WHERE id = 1",
            "EXPLAIN (FORMAT JSON) DELETE FROM t WHERE id = 1",
            "EXPLAIN QUERY PLAN DELETE FROM t WHERE id = 1",
            "EXPLAIN ANALYZE SELECT * FROM t",
            "EXPLAIN (ANALYZE) SELECT * FROM t",
        ] {
            assert_eq!(classify(sql), StmtClass::Read, "{sql}");
        }
    }

    #[test]
    fn masking_keeps_offsets_and_blanks_only_non_code() {
        let sql = "SELECT 'a;b', \"c;d\" /* e;f */ FROM t; -- g;h\nSELECT ñ";
        let masked = super::mask_non_code(sql);
        assert_eq!(masked.len(), sql.len());
        let semis: Vec<usize> = masked
            .iter()
            .enumerate()
            .filter(|(_, b)| **b == b';')
            .map(|(i, _)| i)
            .collect();
        assert_eq!(semis, vec![sql.find("t;").unwrap() + 1]);
        // Code outside the literals, multi-byte identifiers included, is kept.
        assert!(String::from_utf8_lossy(&masked).ends_with("SELECT ñ"));
    }

    /// `DESCRIBE` is how a model asks MySQL for a table's shape, and it is a
    /// read. Classified as a write, it was refused on the AI surface with an
    /// instruction to hand the statement to the user — gotcha #74's failure,
    /// arriving through the classifier instead of through a description.
    #[test]
    fn metadata_reads_a_model_actually_writes_are_reads() {
        for sql in [
            "DESCRIBE logRecord",
            "desc logRecord",
            "DESC `logRecord`",
            "(SELECT 1) UNION (SELECT 2)",
        ] {
            assert!(is_read_only(sql), "expected a read: {sql:?}");
            assert_eq!(classify(sql), StmtClass::Read, "{sql:?}");
        }
        // Not a false positive on a column that merely starts the same way.
        assert!(!is_read_only("UPDATE t SET description = 1"));
    }

    #[test]
    fn is_ddl_matches_schema_and_privilege_statements() {
        for sql in [
            "CREATE TABLE t (id INT)",
            "drop index i",
            "REVOKE ALL ON t FROM u",
        ] {
            assert!(is_ddl(sql), "expected DDL: {sql:?}");
        }
        for sql in ["SELECT 1", "UPDATE t SET a = 1", "INSERT INTO t VALUES (1)"] {
            assert!(!is_ddl(sql), "expected non-DDL: {sql:?}");
        }
    }

    #[test]
    fn flags_whole_table_updates_and_deletes() {
        for sql in [
            "DELETE FROM t",
            "  delete from t  ",
            "UPDATE t SET a = 1",
            "update t set a = 1",
            // A column whose name merely contains "where" is not a WHERE clause,
            // so this whole-table update is still flagged.
            "UPDATE t SET wherever = 1",
        ] {
            assert!(
                is_unfiltered_write(sql),
                "expected whole-table write: {sql:?}"
            );
        }
        for sql in [
            "DELETE FROM t WHERE id = 1",
            "UPDATE t SET a = 1 WHERE id = 2",
            "SELECT * FROM t",
            "INSERT INTO t VALUES (1)",
            // Real WHERE clause even though a value also contains the substring.
            "DELETE FROM t WHERE note = 'nowhere'",
        ] {
            assert!(!is_unfiltered_write(sql), "expected not-flagged: {sql:?}");
        }
    }
}
