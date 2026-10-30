//! Pure, dialect-aware DDL generation for the visual table-structure editor.
//!
//! The editor sends the *desired* table structure (and, when editing, the
//! original snapshot) to the backend; [`build_ddl`] diffs them and returns the
//! ordered SQL statements. The same function drives both the preview pane and
//! the apply step, so what the user sees is exactly what runs.
//!
//! Identifier safety (SECURITY.md, convention #4): table / column / index /
//! constraint names are *user input* here, but identifiers cannot be bound
//! parameters in DDL. Every name therefore goes through [`validate_ident`]
//! before it is quoted, and `data_type` / `default` go through narrower
//! validators. Nothing in this module executes SQL — it only builds strings.

use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// DTOs — mirrored in src/types.ts (camelCase on the wire).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    /// Current name (what the column should be called after apply).
    pub name: String,
    /// Original name when editing an existing column; `None` for a new column.
    /// Used to distinguish a rename from a drop+add.
    #[serde(default)]
    pub original_name: Option<String>,
    /// Raw type text, e.g. "varchar(255)", "int", "bigint".
    pub data_type: String,
    pub nullable: bool,
    /// Raw default expression, or `None`.
    #[serde(default)]
    pub default: Option<String>,
    pub is_primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    /// `None` → engine/auto-named on create.
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<ColumnDef>,
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_IDENT_LEN: usize = 128;

/// Validate a user-supplied identifier before it is quoted into DDL.
///
/// We reject empties, over-long names, and anything containing a quote /
/// backtick / backslash / control character — those are the bytes that could
/// break out of the quoting in [`Dialect::quote_ident`]. Ordinary names (letters,
/// digits, underscore, spaces, unicode) are allowed; the per-dialect quoting
/// handles the rest.
pub fn validate_ident(kind: &str, name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::InvalidInput(format!("{kind} name is empty")));
    }
    if name.len() > MAX_IDENT_LEN {
        return Err(AppError::InvalidInput(format!(
            "{kind} name is too long (>{MAX_IDENT_LEN})"
        )));
    }
    if name
        .chars()
        .any(|c| c == '"' || c == '`' || c == '\\' || c.is_control())
    {
        return Err(AppError::InvalidInput(format!(
            "{kind} name contains an illegal character: {name:?}"
        )));
    }
    Ok(())
}

/// Validate a raw column type string. We allow a leading identifier-ish type
/// name optionally followed by a parenthesised length/precision spec and a
/// trailing keyword run (e.g. "int", "varchar(255)", "decimal(10,2)",
/// "timestamp with time zone", "int unsigned"). We reject statement
/// terminators and quote/backslash bytes that could escape the DDL context.
pub fn validate_type(ty: &str) -> AppResult<()> {
    let t = ty.trim();
    if t.is_empty() {
        return Err(AppError::InvalidInput("column type is empty".into()));
    }
    if t.len() > 64 {
        return Err(AppError::InvalidInput("column type is too long".into()));
    }
    let ok = t.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')' || c == ',' || c == ' '
    });
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "column type contains an illegal character: {ty:?}"
        )));
    }
    Ok(())
}

/// Validate a column default expression conservatively. Accepts: numbers,
/// single-quoted string literals (with `''` escapes), and a small allowlist of
/// keywords/functions. Anything else is rejected for 1.0.2 — the user can run
/// custom DDL by hand for exotic defaults.
pub fn validate_default(expr: &str) -> AppResult<()> {
    let e = expr.trim();
    if e.is_empty() {
        return Err(AppError::InvalidInput("default is empty".into()));
    }
    let upper = e.to_ascii_uppercase();
    const KEYWORDS: &[&str] = &[
        "NULL",
        "TRUE",
        "FALSE",
        "CURRENT_TIMESTAMP",
        "CURRENT_DATE",
        "CURRENT_TIME",
        "NOW()",
        // SQL Server's spellings of "now" and of a generated key.
        "GETDATE()",
        "GETUTCDATE()",
        "SYSDATETIME()",
        "SYSUTCDATETIME()",
        "SYSDATETIMEOFFSET()",
        "NEWID()",
        "NEWSEQUENTIALID()",
    ];
    if KEYWORDS.contains(&upper.as_str()) {
        return Ok(());
    }
    // Numeric literal (int or decimal, optional sign).
    if e.parse::<f64>().is_ok() {
        return Ok(());
    }
    // Single-quoted string literal: starts and ends with ', internal quotes
    // doubled. We don't allow a closing quote that isn't doubled mid-string.
    if e.len() >= 2 && e.starts_with('\'') && e.ends_with('\'') {
        let inner = &e[1..e.len() - 1];
        // Reject an odd run of quotes / a backslash escape attempt.
        if !inner.contains('\\') {
            let mut chars = inner.chars().peekable();
            let mut ok = true;
            while let Some(c) = chars.next() {
                if c == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                return Ok(());
            }
        }
    }
    Err(AppError::InvalidInput(format!(
        "unsupported default expression: {expr:?} (use a number, a quoted string, or a known keyword)"
    )))
}

fn validate_referential_action(dialect: Dialect, action: &str) -> AppResult<()> {
    let action = action.trim().to_ascii_uppercase();
    // T-SQL has no `RESTRICT`: `NO ACTION` is its only "refuse" action, and it
    // already behaves the way `RESTRICT` does elsewhere (checked at the end of
    // the statement, which in SQL Server is the only time it ever checks).
    if dialect == Dialect::MsSql && action == "RESTRICT" {
        return Err(AppError::InvalidInput(
            "SQL Server has no RESTRICT referential action — use NO ACTION".into(),
        ));
    }
    match action.as_str() {
        "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" | "SET DEFAULT" => Ok(()),
        other => Err(AppError::InvalidInput(format!(
            "unsupported referential action: {other:?}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/// Build the ordered DDL statements to take `original` to `desired`.
///
/// `original = None` means "create a new table"; `Some(snapshot)` diffs the
/// two. Returns the statements as strings (no trailing semicolons stripped —
/// each is a complete statement) so the preview pane and the apply executor
/// share one source of truth.
pub fn build_ddl(
    dialect: Dialect,
    original: Option<&TableStructure>,
    desired: &TableStructure,
) -> AppResult<Vec<String>> {
    validate_structure(dialect, desired, original)?;
    match original {
        None => build_create(dialect, desired),
        Some(orig) => build_alter(dialect, orig, desired),
    }
}

/// `original` lets a column's default skip re-validation when it hasn't
/// changed from what's already on the live catalog. A live default can be in
/// a dialect-native form the allowlist doesn't (and shouldn't have to) know —
/// MySQL reports a `BIT` default as `b'0'`/`b'1'`, Postgres reports a
/// cast-style default like `'foo'::text` — and the user never typed it, so
/// there's nothing to gate. Only a default the user actually entered or
/// changed goes through [`validate_default`]. See gotcha-style note on
/// [`build_create`] for the sibling case (CREATE / SQLite rebuild), which
/// skips the allowlist entirely for the same reason.
fn validate_structure(
    dialect: Dialect,
    s: &TableStructure,
    original: Option<&TableStructure>,
) -> AppResult<()> {
    validate_ident("table", &s.name)?;
    if let Some(schema) = &s.schema {
        if !schema.is_empty() {
            validate_ident("schema", schema)?;
        }
    }
    if s.columns.is_empty() {
        return Err(AppError::InvalidInput(
            "a table must have at least one column".into(),
        ));
    }
    let orig_by_name: std::collections::HashMap<&str, &ColumnDef> = original
        .map(|o| o.columns.iter().map(|c| (c.name.as_str(), c)).collect())
        .unwrap_or_default();
    for c in &s.columns {
        validate_ident("column", &c.name)?;
        validate_type(&c.data_type)?;
        if let Some(d) = &c.default {
            let unchanged = c
                .original_name
                .as_deref()
                .and_then(|n| orig_by_name.get(n))
                .is_some_and(|prev| prev.default.as_deref().map(str::trim) == Some(d.trim()));
            if !unchanged {
                validate_default(d)?;
            }
        }
    }
    for idx in &s.indexes {
        if let Some(n) = &idx.name {
            validate_ident("index", n)?;
        }
        for col in &idx.columns {
            validate_ident("index column", col)?;
        }
    }
    for fk in &s.foreign_keys {
        if let Some(n) = &fk.name {
            validate_ident("constraint", n)?;
        }
        validate_ident("referenced table", &fk.ref_table)?;
        if let Some(rs) = &fk.ref_schema {
            if !rs.is_empty() {
                validate_ident("referenced schema", rs)?;
            }
        }
        for col in &fk.columns {
            validate_ident("foreign-key column", col)?;
        }
        for col in &fk.ref_columns {
            validate_ident("referenced column", col)?;
        }
        if let Some(a) = &fk.on_delete {
            validate_referential_action(dialect, a)?;
        }
        if let Some(a) = &fk.on_update {
            validate_referential_action(dialect, a)?;
        }
    }
    Ok(())
}

/// Render a single column definition for a CREATE / ADD COLUMN clause.
fn column_clause(dialect: Dialect, c: &ColumnDef, include_inline_pk: bool) -> String {
    let mut parts = vec![dialect.quote_ident(&c.name), c.data_type.trim().to_string()];

    // Auto-increment phrasing differs per dialect.
    match dialect {
        Dialect::Mysql => {
            if !c.nullable || c.is_primary_key {
                parts.push("NOT NULL".into());
            }
            if c.auto_increment {
                parts.push("AUTO_INCREMENT".into());
            }
        }
        Dialect::Sqlite => {
            // For SQLite a single-column INTEGER PRIMARY KEY [AUTOINCREMENT]
            // must be declared inline; composite PKs use a table constraint.
            if include_inline_pk && c.is_primary_key {
                parts.push("PRIMARY KEY".into());
                if c.auto_increment {
                    parts.push("AUTOINCREMENT".into());
                }
            }
            if !c.nullable && !c.is_primary_key {
                parts.push("NOT NULL".into());
            }
        }
        Dialect::Postgres => {
            if c.auto_increment {
                // Prefer GENERATED identity over the legacy serial pseudo-type.
                parts.push("GENERATED BY DEFAULT AS IDENTITY".into());
            }
            if !c.nullable {
                parts.push("NOT NULL".into());
            }
        }
        Dialect::MsSql => {
            if c.auto_increment {
                parts.push("IDENTITY(1,1)".into());
            }
            // Spelled out both ways: a bare column's nullability in SQL Server
            // depends on the session's ANSI_NULL_DFLT settings, so leaving
            // `NULL` implicit would make the result depend on the connection.
            parts.push(mssql_null_clause(c).into());
        }
    }

    if let Some(d) = &c.default {
        if !d.trim().is_empty() {
            parts.push(format!("DEFAULT {}", d.trim()));
        }
    }
    parts.join(" ")
}

/// Build a from-scratch CREATE for `s`: bare `CREATE TABLE` first (no FK —
/// PG/MySQL emit those as separate `ALTER TABLE ADD CONSTRAINT` statements,
/// SQLite inlines them), followed by FK/CREATE INDEX statements. `stmts[0]`
/// is always the bare CREATE TABLE for PG/MySQL, `stmts[1..]` the rest —
/// [`crate::db::dump`] relies on this exact split to phase a whole-database
/// export without needing a table-dependency topological sort. `pub(crate)`
/// so `dump` can call it directly and skip [`build_ddl`]'s `validate_default`
/// allowlist, which is meant to gate *user-typed* structure-editor input, not
/// defaults already round-tripped from a live catalog (e.g. Postgres's
/// `'foo'::text` cast-style defaults, which the allowlist would reject).
pub(crate) fn build_create(dialect: Dialect, s: &TableStructure) -> AppResult<Vec<String>> {
    let qt = dialect.qualify(s.schema.as_deref(), &s.name);
    let pk_cols: Vec<&ColumnDef> = s.columns.iter().filter(|c| c.is_primary_key).collect();
    // SQLite: a single INTEGER PRIMARY KEY AUTOINCREMENT must be inline.
    let sqlite_inline_pk =
        dialect == Dialect::Sqlite && pk_cols.len() == 1 && pk_cols[0].auto_increment;

    let mut col_lines: Vec<String> = s
        .columns
        .iter()
        .map(|c| column_clause(dialect, c, sqlite_inline_pk))
        .collect();

    // Table-level PRIMARY KEY (skipped for the SQLite inline case and when
    // there are no PK columns).
    if !pk_cols.is_empty() && !sqlite_inline_pk {
        let cols = pk_cols
            .iter()
            .map(|c| dialect.quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        col_lines.push(format!("PRIMARY KEY ({cols})"));
    }

    // SQLite requires FK clauses inline in CREATE TABLE.
    if dialect == Dialect::Sqlite {
        for fk in &s.foreign_keys {
            col_lines.push(fk_clause(dialect, fk, true));
        }
    }

    let mut out = vec![format!(
        "CREATE TABLE {qt} (\n  {}\n)",
        col_lines.join(",\n  ")
    )];

    // PG/MySQL: FKs as separate ALTER TABLE ADD CONSTRAINT statements.
    if dialect != Dialect::Sqlite {
        for fk in &s.foreign_keys {
            out.push(format!(
                "ALTER TABLE {qt} ADD {}",
                fk_clause(dialect, fk, false)
            ));
        }
    }

    // Indexes (all drivers) as separate CREATE INDEX statements.
    for (i, idx) in s.indexes.iter().enumerate() {
        out.push(create_index_stmt(dialect, s, idx, i));
    }
    Ok(out)
}

/// A `[CONSTRAINT name] FOREIGN KEY (cols) REFERENCES tbl (cols) [ON …]`
/// clause. `inline = true` omits nothing but is used inside CREATE TABLE.
fn fk_clause(dialect: Dialect, fk: &ForeignKeyDef, _inline: bool) -> String {
    let cols = fk
        .columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_cols = fk
        .ref_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_tbl = dialect.qualify(fk.ref_schema.as_deref(), &fk.ref_table);
    let mut s = String::new();
    if let Some(name) = &fk.name {
        s.push_str(&format!("CONSTRAINT {} ", dialect.quote_ident(name)));
    }
    s.push_str(&format!(
        "FOREIGN KEY ({cols}) REFERENCES {ref_tbl} ({ref_cols})"
    ));
    if let Some(a) = &fk.on_delete {
        s.push_str(&format!(" ON DELETE {}", a.trim().to_uppercase()));
    }
    if let Some(a) = &fk.on_update {
        s.push_str(&format!(" ON UPDATE {}", a.trim().to_uppercase()));
    }
    s
}

fn create_index_stmt(
    dialect: Dialect,
    s: &TableStructure,
    idx: &IndexDef,
    ordinal: usize,
) -> String {
    let qt = dialect.qualify(s.schema.as_deref(), &s.name);
    let unique = if idx.unique { "UNIQUE " } else { "" };
    let cols = idx
        .columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    // Fall back to a deterministic generated name when none was supplied.
    let name = idx
        .name
        .clone()
        .unwrap_or_else(|| format!("{}_idx_{}", s.name, ordinal));
    let qname = dialect.quote_ident(&name);
    format!("CREATE {unique}INDEX {qname} ON {qt} ({cols})")
}

// ---------------------------------------------------------------------------
// ALTER (edit existing table) — diff original vs desired.
// ---------------------------------------------------------------------------

fn build_alter(
    dialect: Dialect,
    orig: &TableStructure,
    desired: &TableStructure,
) -> AppResult<Vec<String>> {
    match dialect {
        Dialect::Sqlite => build_alter_sqlite(orig, desired),
        Dialect::Postgres | Dialect::Mysql => build_alter_pg_mysql(dialect, orig, desired),
        Dialect::MsSql => build_alter_mssql(orig, desired),
    }
}

fn build_alter_pg_mysql(
    dialect: Dialect,
    orig: &TableStructure,
    desired: &TableStructure,
) -> AppResult<Vec<String>> {
    let qt = dialect.qualify(desired.schema.as_deref(), &desired.name);
    let mut out = Vec::new();

    // 0. Table rename, if any — first, so every clause below (all built from
    // `qt`, i.e. `desired.name`) targets a table that actually exists by the
    // time it runs.
    if orig.name != desired.name {
        let from = dialect.qualify(orig.schema.as_deref(), &orig.name);
        out.push(format!(
            "ALTER TABLE {from} RENAME TO {}",
            dialect.quote_ident(&desired.name)
        ));
    }

    // Match desired columns to originals by original_name (rename-aware).
    let orig_by_name: std::collections::HashMap<&str, &ColumnDef> =
        orig.columns.iter().map(|c| (c.name.as_str(), c)).collect();

    // 1. Column renames next so subsequent clauses see the new name.
    for c in &desired.columns {
        if let Some(orig_name) = &c.original_name {
            if orig_name != &c.name {
                out.push(format!(
                    "ALTER TABLE {qt} RENAME COLUMN {} TO {}",
                    dialect.quote_ident(orig_name),
                    dialect.quote_ident(&c.name)
                ));
            }
        }
    }

    // 2. Dropped columns (present in orig, no desired column claims them).
    let claimed: std::collections::HashSet<&str> = desired
        .columns
        .iter()
        .filter_map(|c| c.original_name.as_deref())
        .collect();
    for oc in &orig.columns {
        if !claimed.contains(oc.name.as_str()) {
            out.push(format!(
                "ALTER TABLE {qt} DROP COLUMN {}",
                dialect.quote_ident(&oc.name)
            ));
        }
    }

    // 3. Added + modified + reordered columns. Column reordering is MySQL-
    // only: `MODIFY COLUMN … FIRST|AFTER col` and `ADD COLUMN … FIRST|AFTER
    // col` are the only way any of our dialects can reposition a column
    // without a full rebuild, and Postgres has no equivalent at all.
    let positions: std::collections::HashMap<String, String> = if dialect == Dialect::Mysql {
        mysql_column_positions(dialect, orig, desired)
    } else {
        std::collections::HashMap::new()
    };
    for c in &desired.columns {
        match &c.original_name {
            None => {
                // New column.
                let mut clause = column_clause(dialect, c, false);
                if let Some(pos) = positions.get(&c.name) {
                    clause.push(' ');
                    clause.push_str(pos);
                }
                out.push(format!("ALTER TABLE {qt} ADD COLUMN {clause}"));
            }
            Some(orig_name) => {
                let prev = orig_by_name.get(orig_name.as_str());
                if let Some(prev) = prev {
                    let position = positions.get(&c.name).map(String::as_str);
                    if column_changed(prev, c) || position.is_some() {
                        out.extend(alter_column_stmts(dialect, &qt, c, position));
                    }
                }
            }
        }
    }

    // 4. Index diff (by name; unnamed indexes are treated as additive).
    diff_indexes(dialect, desired, orig, &qt, &mut out);

    // 5. FK diff (by name).
    diff_foreign_keys(dialect, desired, orig, &qt, &mut out);

    Ok(out)
}

// ---------------------------------------------------------------------------
// SQL Server — T-SQL ALTER.
// ---------------------------------------------------------------------------

/// `NULL` / `NOT NULL` for a T-SQL column. A primary-key column is always
/// `NOT NULL`: SQL Server refuses a key over a nullable column rather than
/// tightening it the way MySQL does.
fn mssql_null_clause(c: &ColumnDef) -> &'static str {
    if c.nullable && !c.is_primary_key {
        "NULL"
    } else {
        "NOT NULL"
    }
}

/// Drop whichever default constraint is bound to `column`, if any.
///
/// A T-SQL default is a named constraint, and `TableStructure` does not carry
/// its name — it is usually server-generated (`DF__orders__statu__3B75D760`),
/// so it cannot be predicted either. The statement looks it up in
/// `sys.default_constraints` and drops it through dynamic SQL, in one batch
/// the preview shows exactly as it runs. A column with no default is a no-op.
///
/// Needed before three things SQL Server otherwise refuses with "object is
/// dependent on column": dropping the column, changing its type, and giving it
/// a different default.
fn mssql_drop_default(qt: &str, column: &str) -> String {
    use crate::db::sql::mssql_nstring;
    let lookup = format!(
        "SELECT dc.name FROM sys.default_constraints dc \
         JOIN sys.columns c ON c.object_id = dc.parent_object_id \
         AND c.column_id = dc.parent_column_id \
         WHERE dc.parent_object_id = OBJECT_ID({obj}) AND c.name = {col}",
        obj = mssql_nstring(qt),
        col = mssql_nstring(column),
    );
    mssql_drop_named_constraint(qt, &lookup)
}

/// Drop the table's primary-key constraint, whatever it is called — the same
/// lookup as [`mssql_drop_default`], through `sys.key_constraints`.
fn mssql_drop_primary_key(qt: &str) -> String {
    use crate::db::sql::mssql_nstring;
    let lookup = format!(
        "SELECT name FROM sys.key_constraints \
         WHERE parent_object_id = OBJECT_ID({obj}) AND type = 'PK'",
        obj = mssql_nstring(qt),
    );
    mssql_drop_named_constraint(qt, &lookup)
}

/// One batch that drops the constraint `lookup` names, or does nothing when it
/// names none.
///
/// The statement is assembled into a variable and run through `sp_executesql`.
/// `EXEC(N'…' + QUOTENAME(@n))` reads naturally but is not T-SQL: `EXEC(…)`
/// takes only literals and variables joined with `+`, never a function call, so
/// SQL Server refuses the batch at parse time ("Incorrect syntax near
/// 'QUOTENAME'"). Every structure change that dropped a default or the primary
/// key failed that way until this ran against a real server. `QUOTENAME(NULL)`
/// is `NULL`, so `@sql` stays `NULL` when the lookup found nothing.
fn mssql_drop_named_constraint(qt: &str, lookup: &str) -> String {
    use crate::db::sql::mssql_nstring;
    format!(
        "DECLARE @sql nvarchar(max) = {alter} + QUOTENAME(({lookup}));\n\
         IF @sql IS NOT NULL EXEC sp_executesql @sql",
        alter = mssql_nstring(&format!("ALTER TABLE {qt} DROP CONSTRAINT ")),
    )
}

/// The ordered T-SQL that takes `orig` to `desired`.
///
/// The order is not cosmetic. SQL Server refuses to drop or retype a column
/// while anything depends on it — a default constraint, an index, a foreign
/// key, the primary key — so everything that goes away is dropped first and
/// everything new is added last:
///
/// 1. renames (`sp_rename`), so every later statement uses the new names;
/// 2. removed foreign keys and indexes, and the primary key when it changes;
/// 3. removed columns, each after its default;
/// 4. changed columns: default off, `ALTER COLUMN`, default back on;
/// 5. new columns;
/// 6. the new primary key, new indexes, new foreign keys.
///
/// `apply` runs the list in one transaction (`db::exec::execute_all`), so a
/// statement the server refuses halfway leaves the table as it was.
///
/// `IDENTITY` cannot be switched on or off an existing column: T-SQL has no
/// `ALTER COLUMN` for it, and the only way is to rebuild the table — copy the
/// rows out, drop it, recreate it — which this editor deliberately does not do
/// behind a checkbox. That case is refused with the reason, rather than
/// producing statements that would not do what the checkbox says.
fn build_alter_mssql(orig: &TableStructure, desired: &TableStructure) -> AppResult<Vec<String>> {
    use crate::db::sql::mssql_sp_rename;
    let dialect = Dialect::MsSql;
    let orig_by_name: std::collections::HashMap<&str, &ColumnDef> =
        orig.columns.iter().map(|c| (c.name.as_str(), c)).collect();

    // Refuse first, before a single statement is built.
    for c in &desired.columns {
        let Some(prev) = c.original_name.as_deref().and_then(|n| orig_by_name.get(n)) else {
            continue;
        };
        if prev.auto_increment != c.auto_increment {
            return Err(AppError::InvalidInput(format!(
                "SQL Server cannot add or remove IDENTITY on the existing column {:?}: \
                 that takes rebuilding the table. Add a new column instead, or change it \
                 by hand with a script",
                c.name
            )));
        }
    }

    // Unqualified when the structure carries no schema, like `build_create`
    // and `create_index_stmt`: the name then resolves through the login's
    // default schema, which is not necessarily `dbo`.
    let qt = dialect.qualify(desired.schema.as_deref(), &desired.name);
    let mut out = Vec::new();

    // 1. Renames: the table, then its columns (addressed under the new table
    // name, which is what `qt` already says).
    if orig.name != desired.name {
        let from = dialect.qualify(orig.schema.as_deref(), &orig.name);
        out.push(mssql_sp_rename(&from, &desired.name, None));
    }
    for c in &desired.columns {
        if let Some(orig_name) = &c.original_name {
            if orig_name != &c.name {
                let object = format!("{qt}.{}", dialect.quote_ident(orig_name));
                out.push(mssql_sp_rename(&object, &c.name, Some("COLUMN")));
            }
        }
    }

    // 2. What goes away, before the columns it may depend on.
    let desired_fk_names: std::collections::HashSet<&str> = desired
        .foreign_keys
        .iter()
        .filter_map(|f| f.name.as_deref())
        .collect();
    for fk in &orig.foreign_keys {
        if let Some(n) = &fk.name {
            if !desired_fk_names.contains(n.as_str()) {
                out.push(format!(
                    "ALTER TABLE {qt} DROP CONSTRAINT {}",
                    dialect.quote_ident(n)
                ));
            }
        }
    }
    let desired_idx_names: std::collections::HashSet<&str> = desired
        .indexes
        .iter()
        .filter_map(|i| i.name.as_deref())
        .collect();
    for idx in &orig.indexes {
        if let Some(n) = &idx.name {
            if !desired_idx_names.contains(n.as_str()) {
                out.push(drop_index_stmt(dialect, &qt, n));
            }
        }
    }
    // The key compared by the names the columns will have, in table order —
    // so renaming a key column is not a key change.
    let renamed: std::collections::HashMap<&str, &str> = desired
        .columns
        .iter()
        .filter_map(|c| c.original_name.as_deref().map(|o| (o, c.name.as_str())))
        .collect();
    let orig_pk: Vec<&str> = orig
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| renamed.get(c.name.as_str()).copied().unwrap_or(""))
        .collect();
    let desired_pk: Vec<&str> = desired
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.as_str())
        .collect();
    let pk_changed = orig_pk != desired_pk;
    if pk_changed && !orig_pk.is_empty() {
        out.push(mssql_drop_primary_key(&qt));
    }

    // 3. Removed columns.
    let claimed: std::collections::HashSet<&str> = desired
        .columns
        .iter()
        .filter_map(|c| c.original_name.as_deref())
        .collect();
    for oc in &orig.columns {
        if !claimed.contains(oc.name.as_str()) {
            if oc.default.is_some() {
                out.push(mssql_drop_default(&qt, &oc.name));
            }
            out.push(format!(
                "ALTER TABLE {qt} DROP COLUMN {}",
                dialect.quote_ident(&oc.name)
            ));
        }
    }

    // 4. Changed columns; 5. new ones.
    fn trimmed(d: &Option<String>) -> Option<&str> {
        d.as_deref().map(str::trim).filter(|d| !d.is_empty())
    }
    for c in &desired.columns {
        let col = dialect.quote_ident(&c.name);
        let Some(prev) = c.original_name.as_deref().and_then(|n| orig_by_name.get(n)) else {
            out.push(format!(
                "ALTER TABLE {qt} ADD {}",
                column_clause(dialect, c, false)
            ));
            continue;
        };
        let retype = prev.data_type.trim() != c.data_type.trim()
            || mssql_null_clause(prev) != mssql_null_clause(c);
        let old_default = trimmed(&prev.default);
        let new_default = trimmed(&c.default);
        // A bound default blocks the retype as well as its own replacement.
        let unbind = old_default.is_some() && (retype || old_default != new_default);
        if unbind {
            out.push(mssql_drop_default(&qt, &c.name));
        }
        if retype {
            out.push(format!(
                "ALTER TABLE {qt} ALTER COLUMN {col} {} {}",
                c.data_type.trim(),
                mssql_null_clause(c)
            ));
        }
        if let Some(d) = new_default {
            if unbind || old_default.is_none() {
                out.push(format!("ALTER TABLE {qt} ADD DEFAULT {d} FOR {col}"));
            }
        }
    }

    // 6. What is new, once every column it may name exists.
    if pk_changed && !desired_pk.is_empty() {
        let cols = desired_pk
            .iter()
            .map(|c| dialect.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!("ALTER TABLE {qt} ADD PRIMARY KEY ({cols})"));
    }
    let orig_idx_names: std::collections::HashSet<&str> = orig
        .indexes
        .iter()
        .filter_map(|i| i.name.as_deref())
        .collect();
    for (i, idx) in desired.indexes.iter().enumerate() {
        let is_new = idx
            .name
            .as_deref()
            .is_none_or(|n| !orig_idx_names.contains(n));
        if is_new {
            out.push(create_index_stmt(dialect, desired, idx, i));
        }
    }
    let orig_fk_names: std::collections::HashSet<&str> = orig
        .foreign_keys
        .iter()
        .filter_map(|f| f.name.as_deref())
        .collect();
    for fk in &desired.foreign_keys {
        let is_new = fk
            .name
            .as_deref()
            .is_none_or(|n| !orig_fk_names.contains(n));
        if is_new {
            out.push(format!(
                "ALTER TABLE {qt} ADD {}",
                fk_clause(dialect, fk, false)
            ));
        }
    }

    Ok(out)
}

/// Compute which columns need an explicit `FIRST`/`AFTER <col>` clause to
/// land in their `desired` slot — MySQL only (see the call site).
///
/// A plain `MODIFY COLUMN` with no position clause leaves a surviving column
/// where it already sits, and a plain `ADD COLUMN` appends a new one at the
/// end; those are the two "natural" outcomes with no move required. This
/// walks `desired.columns` left to right against that natural order and,
/// wherever they diverge, records the move needed to fix that slot before
/// continuing — the same technique as a minimal selection-sort diff: once
/// position `i` is corrected it is never touched again, so the moves found
/// this way, applied in order, reproduce the desired order exactly. Only
/// columns that actually need to move get an entry — a column already in the
/// right slot must not be forced through a needless `MODIFY`.
fn mysql_column_positions(
    dialect: Dialect,
    orig: &TableStructure,
    desired: &TableStructure,
) -> std::collections::HashMap<String, String> {
    let renamed: std::collections::HashMap<&str, &str> = desired
        .columns
        .iter()
        .filter_map(|c| c.original_name.as_deref().map(|o| (o, c.name.as_str())))
        .collect();
    // Columns as they naturally sit today: original order, survivors only
    // (dropped columns are absent from `renamed`), renamed in place.
    let mut natural: Vec<String> = orig
        .columns
        .iter()
        .filter_map(|oc| renamed.get(oc.name.as_str()).map(|n| n.to_string()))
        .collect();
    // New columns land at the tail, in the order they appear in `desired`.
    for c in &desired.columns {
        if c.original_name.is_none() {
            natural.push(c.name.clone());
        }
    }
    let target: Vec<&str> = desired.columns.iter().map(|c| c.name.as_str()).collect();
    let mut moves = std::collections::HashMap::new();
    for (i, name) in target.iter().enumerate() {
        if natural.get(i).map(String::as_str) != Some(*name) {
            let pos = natural
                .iter()
                .position(|n| n == name)
                .expect("every desired column name is present in `natural` by construction");
            natural.remove(pos);
            natural.insert(i, name.to_string());
            let clause = if i == 0 {
                "FIRST".to_string()
            } else {
                format!("AFTER {}", dialect.quote_ident(target[i - 1]))
            };
            moves.insert(name.to_string(), clause);
        }
    }
    moves
}

fn column_changed(a: &ColumnDef, b: &ColumnDef) -> bool {
    a.data_type.trim() != b.data_type.trim()
        || a.nullable != b.nullable
        || a.default.as_deref().map(str::trim) != b.default.as_deref().map(str::trim)
        || a.is_primary_key != b.is_primary_key
        || a.auto_increment != b.auto_increment
}

/// `position`, when given, is a MySQL `FIRST` / `AFTER <col>` clause to
/// append after the column definition — always `None` on the Postgres arm,
/// which has no equivalent.
fn alter_column_stmts(
    dialect: Dialect,
    qt: &str,
    c: &ColumnDef,
    position: Option<&str>,
) -> Vec<String> {
    match dialect {
        Dialect::Mysql => {
            // MySQL carries the whole new definition in one MODIFY.
            let mut clause = column_clause(dialect, c, false);
            if let Some(pos) = position {
                clause.push(' ');
                clause.push_str(pos);
            }
            vec![format!("ALTER TABLE {qt} MODIFY COLUMN {clause}")]
        }
        Dialect::Postgres => {
            let col = dialect.quote_ident(&c.name);
            let mut v = vec![format!(
                "ALTER TABLE {qt} ALTER COLUMN {col} TYPE {}",
                c.data_type.trim()
            )];
            if c.nullable {
                v.push(format!("ALTER TABLE {qt} ALTER COLUMN {col} DROP NOT NULL"));
            } else {
                v.push(format!("ALTER TABLE {qt} ALTER COLUMN {col} SET NOT NULL"));
            }
            match &c.default {
                Some(d) if !d.trim().is_empty() => v.push(format!(
                    "ALTER TABLE {qt} ALTER COLUMN {col} SET DEFAULT {}",
                    d.trim()
                )),
                _ => v.push(format!("ALTER TABLE {qt} ALTER COLUMN {col} DROP DEFAULT")),
            }
            v
        }
        Dialect::Sqlite => unreachable!("SQLite alters go through build_alter_sqlite"),
        Dialect::MsSql => unreachable!("SQL Server alters go through build_alter_mssql"),
    }
}

fn diff_indexes(
    dialect: Dialect,
    desired: &TableStructure,
    orig: &TableStructure,
    qt: &str,
    out: &mut Vec<String>,
) {
    let orig_names: std::collections::HashSet<&str> = orig
        .indexes
        .iter()
        .filter_map(|i| i.name.as_deref())
        .collect();
    let desired_names: std::collections::HashSet<&str> = desired
        .indexes
        .iter()
        .filter_map(|i| i.name.as_deref())
        .collect();

    // Dropped indexes.
    for idx in &orig.indexes {
        if let Some(n) = &idx.name {
            if !desired_names.contains(n.as_str()) {
                out.push(drop_index_stmt(dialect, qt, n));
            }
        }
    }
    // Added indexes (new name, or unnamed → always added).
    for (i, idx) in desired.indexes.iter().enumerate() {
        let is_new = match &idx.name {
            Some(n) => !orig_names.contains(n.as_str()),
            None => true,
        };
        if is_new {
            out.push(create_index_stmt(dialect, desired, idx, i));
        }
    }
}

fn drop_index_stmt(dialect: Dialect, qt: &str, name: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("ALTER TABLE {qt} DROP INDEX {}", dialect.quote_ident(name)),
        // PG: DROP INDEX is schema-qualified but operates on the index name,
        // not the table; the table qualifier isn't used. SQLite is similar.
        Dialect::Postgres | Dialect::Sqlite => {
            format!("DROP INDEX {}", dialect.quote_ident(name))
        }
        // T-SQL needs the table: `DROP INDEX ix ON tbl`. Spelled out rather
        // than left to a catch-all so the arm is a deliberate choice — this is
        // exactly the kind of statement that used to silently take the
        // Postgres path and produce invalid SQL.
        Dialect::MsSql => format!("DROP INDEX {} ON {qt}", dialect.quote_ident(name)),
    }
}

fn diff_foreign_keys(
    dialect: Dialect,
    desired: &TableStructure,
    orig: &TableStructure,
    qt: &str,
    out: &mut Vec<String>,
) {
    let desired_names: std::collections::HashSet<&str> = desired
        .foreign_keys
        .iter()
        .filter_map(|f| f.name.as_deref())
        .collect();

    // Dropped FKs (named ones present in orig but not desired).
    for fk in &orig.foreign_keys {
        if let Some(n) = &fk.name {
            if !desired_names.contains(n.as_str()) {
                out.push(match dialect {
                    Dialect::Mysql => {
                        format!(
                            "ALTER TABLE {qt} DROP FOREIGN KEY {}",
                            dialect.quote_ident(n)
                        )
                    }
                    Dialect::Postgres | Dialect::Sqlite | Dialect::MsSql => {
                        format!(
                            "ALTER TABLE {qt} DROP CONSTRAINT {}",
                            dialect.quote_ident(n)
                        )
                    }
                });
            }
        }
    }
    // Added FKs (unnamed → always added; named & new).
    let orig_names: std::collections::HashSet<&str> = orig
        .foreign_keys
        .iter()
        .filter_map(|f| f.name.as_deref())
        .collect();
    for fk in &desired.foreign_keys {
        let is_new = match &fk.name {
            Some(n) => !orig_names.contains(n.as_str()),
            None => true,
        };
        if is_new {
            out.push(format!(
                "ALTER TABLE {qt} ADD {}",
                fk_clause(dialect, fk, false)
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// SQLite — classify ops; rebuild the table when ALTER can't express the change.
// ---------------------------------------------------------------------------

/// Does the diff require a full table rebuild on SQLite? SQLite ALTER only
/// supports RENAME TABLE / RENAME COLUMN / ADD COLUMN / DROP COLUMN. Anything
/// else (type / nullability / default / PK / FK / index-on-existing changes)
/// needs the 12-step recreate.
fn sqlite_needs_rebuild(orig: &TableStructure, desired: &TableStructure) -> bool {
    // Column-level changes beyond rename/add/drop.
    let orig_by_name: std::collections::HashMap<&str, &ColumnDef> =
        orig.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    for c in &desired.columns {
        if let Some(orig_name) = &c.original_name {
            if let Some(prev) = orig_by_name.get(orig_name.as_str()) {
                if column_changed(prev, c) {
                    return true;
                }
            }
        }
    }
    // FK changes always need a rebuild on SQLite (no ADD/DROP CONSTRAINT).
    if fk_signature(orig) != fk_signature(desired) {
        return true;
    }
    false
}

fn fk_signature(s: &TableStructure) -> Vec<(Vec<String>, String, Vec<String>)> {
    let mut v: Vec<_> = s
        .foreign_keys
        .iter()
        .map(|f| {
            (
                f.columns.clone(),
                f.ref_table.clone(),
                f.ref_columns.clone(),
            )
        })
        .collect();
    v.sort();
    v
}

fn build_alter_sqlite(orig: &TableStructure, desired: &TableStructure) -> AppResult<Vec<String>> {
    let dialect = Dialect::Sqlite;
    if sqlite_needs_rebuild(orig, desired) {
        return build_sqlite_rebuild(orig, desired);
    }

    // Simple, natively-supported path: rename / add / drop columns.
    let qt = dialect.qualify(None, &desired.name);
    let mut out = Vec::new();

    // Table rename first, same reasoning as the PG/MySQL path above: `qt`
    // (used by every statement below) is already `desired.name`.
    if orig.name != desired.name {
        out.push(format!(
            "ALTER TABLE {} RENAME TO {qt}",
            dialect.qualify(None, &orig.name)
        ));
    }

    for c in &desired.columns {
        if let Some(orig_name) = &c.original_name {
            if orig_name != &c.name {
                out.push(format!(
                    "ALTER TABLE {qt} RENAME COLUMN {} TO {}",
                    dialect.quote_ident(orig_name),
                    dialect.quote_ident(&c.name)
                ));
            }
        }
    }
    let claimed: std::collections::HashSet<&str> = desired
        .columns
        .iter()
        .filter_map(|c| c.original_name.as_deref())
        .collect();
    for oc in &orig.columns {
        if !claimed.contains(oc.name.as_str()) {
            out.push(format!(
                "ALTER TABLE {qt} DROP COLUMN {}",
                dialect.quote_ident(&oc.name)
            ));
        }
    }
    for c in &desired.columns {
        if c.original_name.is_none() {
            out.push(format!(
                "ALTER TABLE {qt} ADD COLUMN {}",
                column_clause(dialect, c, false)
            ));
        }
    }
    // Index diff is ALTER-free in SQLite (CREATE/DROP INDEX).
    diff_indexes(dialect, desired, orig, &qt, &mut out);
    Ok(out)
}

/// The canonical SQLite 12-step table rebuild. Marked destructive in the UI
/// because it drops and recreates the table. The PRAGMA toggles sit outside
/// the transaction (SQLite requires `foreign_keys` to be changed outside a
/// transaction); the executor runs the list verbatim.
fn build_sqlite_rebuild(orig: &TableStructure, desired: &TableStructure) -> AppResult<Vec<String>> {
    let dialect = Dialect::Sqlite;
    let table = &desired.name;
    let tmp = format!("{table}__huginn_new");
    validate_ident("temp table", &tmp)?;

    // Build the new table under the temp name.
    let tmp_struct = TableStructure {
        schema: None,
        name: tmp.clone(),
        columns: desired.columns.clone(),
        indexes: vec![], // indexes recreated against the final name below
        foreign_keys: desired.foreign_keys.clone(),
    };
    let create = build_create(dialect, &tmp_struct)?;

    // Columns to copy: those that survive (matched by original_name), mapping
    // old name → new name. New columns are excluded from the SELECT and take
    // their default / NULL.
    let mut new_cols = Vec::new();
    let mut old_cols = Vec::new();
    for c in &desired.columns {
        if let Some(orig_name) = &c.original_name {
            if orig.columns.iter().any(|oc| &oc.name == orig_name) {
                new_cols.push(dialect.quote_ident(&c.name));
                old_cols.push(dialect.quote_ident(orig_name));
            }
        }
    }

    // The live table is still under `orig.name` right up until the final
    // rename below — the SELECT source and the DROP target must read from
    // there, not from `desired.name` (which, on a rename, doesn't exist as a
    // real table yet).
    let qt = dialect.quote_ident(table);
    let qt_orig = dialect.quote_ident(&orig.name);
    let qtmp = dialect.quote_ident(&tmp);

    let mut out = Vec::new();
    out.push("PRAGMA foreign_keys=OFF".to_string());
    out.extend(create);
    if !new_cols.is_empty() {
        out.push(format!(
            "INSERT INTO {qtmp} ({}) SELECT {} FROM {qt_orig}",
            new_cols.join(", "),
            old_cols.join(", ")
        ));
    }
    out.push(format!("DROP TABLE {qt_orig}"));
    out.push(format!("ALTER TABLE {qtmp} RENAME TO {qt}"));
    // Recreate indexes against the final table name.
    for (i, idx) in desired.indexes.iter().enumerate() {
        out.push(create_index_stmt(dialect, desired, idx, i));
    }
    out.push("PRAGMA foreign_keys=ON".to_string());
    Ok(out)
}

/// Whether applying `original`→`desired` on SQLite will rebuild the table
/// (used by the command layer to flag the destructive confirmation).
pub fn sqlite_rebuild_required(
    original: Option<&TableStructure>,
    desired: &TableStructure,
) -> bool {
    match original {
        Some(orig) => sqlite_needs_rebuild(orig, desired),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            original_name: None,
            data_type: ty.into(),
            nullable: true,
            default: None,
            is_primary_key: false,
            auto_increment: false,
        }
    }

    fn existing(name: &str, ty: &str) -> ColumnDef {
        ColumnDef {
            original_name: Some(name.into()),
            ..col(name, ty)
        }
    }

    fn table(name: &str, cols: Vec<ColumnDef>) -> TableStructure {
        TableStructure {
            schema: None,
            name: name.into(),
            columns: cols,
            indexes: vec![],
            foreign_keys: vec![],
        }
    }

    #[test]
    fn validate_ident_rejects_quotes_and_empties() {
        assert!(validate_ident("column", "ok_name").is_ok());
        assert!(validate_ident("column", "weird name").is_ok());
        assert!(validate_ident("column", "").is_err());
        assert!(validate_ident("column", "bad\"name").is_err());
        assert!(validate_ident("column", "back`tick").is_err());
        assert!(validate_ident("column", "drop\\table").is_err());
    }

    #[test]
    fn validate_default_allows_safe_forms_only() {
        assert!(validate_default("42").is_ok());
        assert!(validate_default("-3.14").is_ok());
        assert!(validate_default("'hello'").is_ok());
        assert!(validate_default("'it''s ok'").is_ok());
        assert!(validate_default("CURRENT_TIMESTAMP").is_ok());
        assert!(validate_default("NULL").is_ok());
        assert!(validate_default("'; DROP TABLE x; --").is_err());
        assert!(validate_default("now() || sleep(5)").is_err());
    }

    #[test]
    fn create_postgres_table_with_pk() {
        let mut c = col("id", "int");
        c.is_primary_key = true;
        c.nullable = false;
        c.auto_increment = true;
        let stmts = build_ddl(Dialect::Postgres, None, &table("users", vec![c])).unwrap();
        assert_eq!(stmts.len(), 1);
        assert!(stmts[0].contains("CREATE TABLE \"users\""));
        assert!(stmts[0].contains("GENERATED BY DEFAULT AS IDENTITY"));
        assert!(stmts[0].contains("PRIMARY KEY (\"id\")"));
    }

    #[test]
    fn mysql_rename_and_modify_column() {
        let orig = table("t", vec![existing("a", "int")]);
        let mut desired_col = existing("a", "bigint");
        desired_col.name = "b".into(); // rename a -> b, retype int -> bigint
        desired_col.nullable = false;
        let desired = table("t", vec![desired_col]);
        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert!(stmts.iter().any(|s| s.contains("RENAME COLUMN `a` TO `b`")));
        assert!(stmts
            .iter()
            .any(|s| s.contains("MODIFY COLUMN `b` bigint NOT NULL")));
    }

    #[test]
    fn postgres_add_and_drop_column() {
        let orig = table("t", vec![existing("keep", "int"), existing("gone", "text")]);
        let desired = table("t", vec![existing("keep", "int"), col("fresh", "text")]);
        let stmts = build_ddl(Dialect::Postgres, Some(&orig), &desired).unwrap();
        assert!(stmts.iter().any(|s| s.contains("DROP COLUMN \"gone\"")));
        assert!(stmts
            .iter()
            .any(|s| s.contains("ADD COLUMN \"fresh\" text")));
    }

    #[test]
    fn sqlite_simple_ops_use_alter() {
        let orig = table("t", vec![existing("a", "TEXT")]);
        let mut renamed = existing("a", "TEXT");
        renamed.name = "b".into();
        let desired = table("t", vec![renamed, col("c", "TEXT")]);
        let stmts = build_ddl(Dialect::Sqlite, Some(&orig), &desired).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("RENAME COLUMN \"a\" TO \"b\"")));
        assert!(stmts.iter().any(|s| s.contains("ADD COLUMN \"c\" TEXT")));
        assert!(!stmts.iter().any(|s| s.contains("__huginn_new")));
    }

    #[test]
    fn sqlite_type_change_triggers_rebuild() {
        let orig = table("t", vec![existing("a", "TEXT"), existing("b", "TEXT")]);
        let desired = table("t", vec![existing("a", "INTEGER"), existing("b", "TEXT")]);
        assert!(sqlite_rebuild_required(Some(&orig), &desired));
        let stmts = build_ddl(Dialect::Sqlite, Some(&orig), &desired).unwrap();
        assert_eq!(stmts.first().unwrap(), "PRAGMA foreign_keys=OFF");
        assert_eq!(stmts.last().unwrap(), "PRAGMA foreign_keys=ON");
        assert!(stmts
            .iter()
            .any(|s| s.contains("CREATE TABLE \"t__huginn_new\"")));
        assert!(stmts
            .iter()
            .any(|s| s.contains("INSERT INTO \"t__huginn_new\"")));
        assert!(stmts.iter().any(|s| s == "DROP TABLE \"t\""));
        assert!(stmts.iter().any(|s| s.contains("RENAME TO \"t\"")));
    }

    #[test]
    fn mysql_table_rename_only() {
        let orig = table("old_name", vec![existing("a", "int")]);
        let desired = table("new_name", vec![existing("a", "int")]);
        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert_eq!(stmts, vec!["ALTER TABLE `old_name` RENAME TO `new_name`"]);
    }

    #[test]
    fn sqlite_table_rename_only() {
        let orig = table("old_name", vec![existing("a", "TEXT")]);
        let desired = table("new_name", vec![existing("a", "TEXT")]);
        let stmts = build_ddl(Dialect::Sqlite, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            vec!["ALTER TABLE \"old_name\" RENAME TO \"new_name\""]
        );
    }

    #[test]
    fn sqlite_rename_combined_with_rebuild_reads_from_original_table() {
        // Renaming *and* changing a column's type at once forces the
        // rebuild path; the temp table must copy FROM the original name
        // (still the live table at that point) and DROP the original name,
        // not the not-yet-existing desired one.
        let orig = table("old_name", vec![existing("a", "TEXT")]);
        let desired = table("new_name", vec![existing("a", "INTEGER")]);
        let stmts = build_ddl(Dialect::Sqlite, Some(&orig), &desired).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("INSERT INTO \"new_name__huginn_new\"")
                && s.contains("FROM \"old_name\"")));
        assert!(stmts.iter().any(|s| s == "DROP TABLE \"old_name\""));
        assert!(stmts.iter().any(|s| s.contains("RENAME TO \"new_name\"")));
    }

    #[test]
    fn create_index_and_fk_statements() {
        let mut s = table(
            "orders",
            vec![
                {
                    let mut c = col("id", "int");
                    c.is_primary_key = true;
                    c.nullable = false;
                    c
                },
                col("user_id", "int"),
            ],
        );
        s.indexes.push(IndexDef {
            name: Some("idx_user".into()),
            columns: vec!["user_id".into()],
            unique: false,
        });
        s.foreign_keys.push(ForeignKeyDef {
            name: Some("fk_user".into()),
            columns: vec!["user_id".into()],
            ref_schema: None,
            ref_table: "users".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: None,
        });
        let stmts = build_ddl(Dialect::Postgres, None, &s).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("CREATE INDEX \"idx_user\" ON \"orders\" (\"user_id\")")));
        assert!(stmts.iter().any(|s| s.contains(
            "ADD CONSTRAINT \"fk_user\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\") ON DELETE CASCADE"
        )));
    }

    #[test]
    fn empty_table_rejected() {
        assert!(build_ddl(Dialect::Postgres, None, &table("t", vec![])).is_err());
    }

    #[test]
    fn unchanged_catalog_default_skips_validation() {
        // A MySQL BIT column round-trips its default as `b'0'`/`b'1'` from
        // the catalog — not something `validate_default`'s allowlist knows
        // about, and not something the user typed. Editing an unrelated
        // column in the same table must not choke on it.
        let mut bit_col = existing("enabled", "bit(1)");
        bit_col.default = Some("b'0'".into());
        let orig = table("t", vec![existing("id", "int"), bit_col.clone()]);

        let mut renamed_id = existing("id", "bigint"); // the actual edit
        renamed_id.name = "id".into();
        let desired = table("t", vec![renamed_id, bit_col]);

        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("MODIFY COLUMN `id` bigint")));
        assert!(!stmts.iter().any(|s| s.contains("enabled")));
    }

    #[test]
    fn unchanged_catalog_default_still_rejected_if_user_edits_it() {
        let mut bit_col = existing("enabled", "bit(1)");
        bit_col.default = Some("b'0'".into());
        let orig = table("t", vec![bit_col.clone()]);

        let mut edited = bit_col;
        edited.default = Some("b'0'; DROP TABLE t; --".into());
        let desired = table("t", vec![edited]);

        assert!(build_ddl(Dialect::Mysql, Some(&orig), &desired).is_err());
    }

    #[test]
    fn mysql_reorders_existing_column() {
        // Move `b` in front of `a` without changing anything else.
        let orig = table("t", vec![existing("a", "int"), existing("b", "int")]);
        let desired = table("t", vec![existing("b", "int"), existing("a", "int")]);
        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("MODIFY COLUMN `b` int FIRST")));
        // `a` is already correctly placed once `b` moves in front of it.
        assert!(!stmts.iter().any(|s| s.contains("MODIFY COLUMN `a`")));
    }

    #[test]
    fn mysql_new_column_inserted_in_the_middle() {
        let orig = table("t", vec![existing("a", "int"), existing("b", "int")]);
        let desired = table(
            "t",
            vec![
                existing("a", "int"),
                col("mid", "int"),
                existing("b", "int"),
            ],
        );
        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert!(stmts
            .iter()
            .any(|s| s.contains("ADD COLUMN `mid` int AFTER `a`")));
    }

    #[test]
    fn mysql_unmoved_columns_produce_no_reorder_statement() {
        let orig = table("t", vec![existing("a", "int"), existing("b", "int")]);
        let desired = table("t", vec![existing("a", "int"), existing("b", "int")]);
        let stmts = build_ddl(Dialect::Mysql, Some(&orig), &desired).unwrap();
        assert!(stmts.is_empty());
    }

    #[test]
    fn postgres_has_no_reorder_support() {
        // Postgres can't express a reorder at all; the diff must not try.
        let orig = table("t", vec![existing("a", "int"), existing("b", "int")]);
        let desired = table("t", vec![existing("b", "int"), existing("a", "int")]);
        let stmts = build_ddl(Dialect::Postgres, Some(&orig), &desired).unwrap();
        assert!(stmts.is_empty());
    }

    // -----------------------------------------------------------------------
    // SQL Server
    // -----------------------------------------------------------------------

    fn dbo(name: &str, cols: Vec<ColumnDef>) -> TableStructure {
        TableStructure {
            schema: Some("dbo".into()),
            ..table(name, cols)
        }
    }

    fn pk(mut c: ColumnDef) -> ColumnDef {
        c.is_primary_key = true;
        c.nullable = false;
        c
    }

    #[test]
    fn mssql_create_spells_identity_and_nullability() {
        let mut id = pk(col("id", "int"));
        id.auto_increment = true;
        let mut status = col("status", "nvarchar(20)");
        status.default = Some("'new'".into());
        let mut t = dbo("orders", vec![id, status]);
        t.indexes.push(IndexDef {
            name: Some("ix_status".into()),
            columns: vec!["status".into()],
            unique: false,
        });
        let stmts = build_ddl(Dialect::MsSql, None, &t).unwrap();
        assert_eq!(
            stmts[0],
            "CREATE TABLE [dbo].[orders] (\n  [id] int IDENTITY(1,1) NOT NULL,\n  \
             [status] nvarchar(20) NULL DEFAULT 'new',\n  PRIMARY KEY ([id])\n)"
        );
        assert_eq!(
            stmts[1],
            "CREATE INDEX [ix_status] ON [dbo].[orders] ([status])"
        );
    }

    #[test]
    fn mssql_renames_go_first_through_sp_rename() {
        let orig = dbo("orders", vec![existing("qty", "int")]);
        let mut renamed = existing("qty", "int");
        renamed.name = "quantity".into();
        let desired = dbo("order_lines", vec![renamed]);
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            [
                "EXEC sp_rename N'[dbo].[orders]', N'order_lines'",
                "EXEC sp_rename N'[dbo].[order_lines].[qty]', N'quantity', N'COLUMN'",
            ]
        );
    }

    #[test]
    fn mssql_drops_a_columns_default_before_the_column() {
        let mut flag = existing("flag", "bit");
        flag.default = Some("(0)".into());
        let orig = dbo("t", vec![existing("id", "int"), flag]);
        let desired = dbo("t", vec![existing("id", "int")]);
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &desired).unwrap();
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("FROM sys.default_constraints"));
        assert!(stmts[0].contains("OBJECT_ID(N'[dbo].[t]')"));
        assert!(stmts[0].contains("c.name = N'flag'"));
        assert!(stmts[0].starts_with(
            "DECLARE @sql nvarchar(max) = N'ALTER TABLE [dbo].[t] DROP CONSTRAINT ' + QUOTENAME(("
        ));
        assert!(stmts[0].ends_with("IF @sql IS NOT NULL EXEC sp_executesql @sql"));
        // `EXEC(<literal> + <function call>)` is not T-SQL: SQL Server refuses
        // the whole batch at parse time, which is how this first shipped.
        assert!(!stmts[0].contains("EXEC("));
        assert_eq!(stmts[1], "ALTER TABLE [dbo].[t] DROP COLUMN [flag]");
    }

    #[test]
    fn mssql_retype_unbinds_and_rebinds_an_unchanged_default() {
        let mut prev = existing("qty", "int");
        prev.default = Some("(0)".into());
        let mut next = prev.clone();
        next.data_type = "bigint".into();
        next.nullable = false;
        let stmts = build_ddl(
            Dialect::MsSql,
            Some(&dbo("t", vec![prev])),
            &dbo("t", vec![next]),
        )
        .unwrap();
        assert_eq!(stmts.len(), 3);
        assert!(stmts[0].starts_with("DECLARE @sql nvarchar(max)"));
        assert_eq!(
            stmts[1],
            "ALTER TABLE [dbo].[t] ALTER COLUMN [qty] bigint NOT NULL"
        );
        assert_eq!(stmts[2], "ALTER TABLE [dbo].[t] ADD DEFAULT (0) FOR [qty]");
    }

    #[test]
    fn mssql_a_new_default_alone_is_one_statement() {
        let prev = existing("note", "nvarchar(50)");
        let mut next = prev.clone();
        next.default = Some("'n/a'".into());
        let stmts = build_ddl(
            Dialect::MsSql,
            Some(&dbo("t", vec![prev])),
            &dbo("t", vec![next]),
        )
        .unwrap();
        assert_eq!(
            stmts,
            ["ALTER TABLE [dbo].[t] ADD DEFAULT 'n/a' FOR [note]"]
        );
    }

    #[test]
    fn mssql_a_key_change_drops_the_old_key_and_adds_the_new_one_last() {
        let orig = dbo("t", vec![pk(existing("a", "int")), existing("b", "int")]);
        let desired = dbo(
            "t",
            vec![pk(existing("a", "int")), pk(existing("b", "int"))],
        );
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &desired).unwrap();
        assert!(stmts[0].contains("FROM sys.key_constraints"));
        assert!(stmts[0].contains("type = 'PK'"));
        // `b` has to become NOT NULL before it can join the key.
        assert_eq!(
            stmts[1],
            "ALTER TABLE [dbo].[t] ALTER COLUMN [b] int NOT NULL"
        );
        assert_eq!(stmts[2], "ALTER TABLE [dbo].[t] ADD PRIMARY KEY ([a], [b])");
        assert_eq!(stmts.len(), 3);
    }

    #[test]
    fn mssql_renaming_a_key_column_is_not_a_key_change() {
        let orig = dbo("t", vec![pk(existing("id", "int"))]);
        let mut renamed = pk(existing("id", "int"));
        renamed.name = "order_id".into();
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &dbo("t", vec![renamed])).unwrap();
        assert_eq!(
            stmts,
            ["EXEC sp_rename N'[dbo].[t].[id]', N'order_id', N'COLUMN'"]
        );
    }

    #[test]
    fn mssql_dependents_go_before_columns_and_come_back_after() {
        let mut orig = dbo("t", vec![existing("id", "int"), existing("old", "int")]);
        orig.indexes.push(IndexDef {
            name: Some("ix_old".into()),
            columns: vec!["old".into()],
            unique: false,
        });
        orig.foreign_keys.push(ForeignKeyDef {
            name: Some("fk_old".into()),
            columns: vec!["old".into()],
            ref_schema: Some("dbo".into()),
            ref_table: "other".into(),
            ref_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        });
        let mut desired = dbo("t", vec![existing("id", "int"), col("fresh", "int")]);
        desired.indexes.push(IndexDef {
            name: Some("ix_fresh".into()),
            columns: vec!["fresh".into()],
            unique: true,
        });
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            [
                "ALTER TABLE [dbo].[t] DROP CONSTRAINT [fk_old]",
                "DROP INDEX [ix_old] ON [dbo].[t]",
                "ALTER TABLE [dbo].[t] DROP COLUMN [old]",
                "ALTER TABLE [dbo].[t] ADD [fresh] int NULL",
                "CREATE UNIQUE INDEX [ix_fresh] ON [dbo].[t] ([fresh])",
            ]
        );
    }

    #[test]
    fn mssql_refuses_to_toggle_identity_on_an_existing_column() {
        let orig = dbo("t", vec![pk(existing("id", "int"))]);
        let mut next = pk(existing("id", "int"));
        next.auto_increment = true;
        let err = build_ddl(Dialect::MsSql, Some(&orig), &dbo("t", vec![next]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("IDENTITY"), "{err}");
        // A new column may still be born with it.
        let mut fresh = col("seq", "int");
        fresh.auto_increment = true;
        fresh.nullable = false;
        let stmts = build_ddl(
            Dialect::MsSql,
            Some(&orig),
            &dbo("t", vec![pk(existing("id", "int")), fresh]),
        )
        .unwrap();
        assert_eq!(
            stmts,
            ["ALTER TABLE [dbo].[t] ADD [seq] int IDENTITY(1,1) NOT NULL"]
        );
    }

    #[test]
    fn mssql_has_no_restrict() {
        let mut t = dbo("t", vec![existing("id", "int")]);
        t.foreign_keys.push(ForeignKeyDef {
            name: None,
            columns: vec!["id".into()],
            ref_schema: None,
            ref_table: "other".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("RESTRICT".into()),
            on_update: None,
        });
        assert!(build_ddl(Dialect::MsSql, None, &t).is_err());
        assert!(build_ddl(Dialect::Postgres, None, &t).is_ok());
    }

    #[test]
    fn mssql_names_with_quotes_are_escaped_inside_strings() {
        let mut flag = existing("it's", "bit");
        flag.default = Some("(0)".into());
        let orig = dbo("o'neil", vec![existing("id", "int"), flag]);
        let desired = dbo("o'neil", vec![existing("id", "int")]);
        let stmts = build_ddl(Dialect::MsSql, Some(&orig), &desired).unwrap();
        assert!(
            stmts[0].contains("OBJECT_ID(N'[dbo].[o''neil]')"),
            "{}",
            stmts[0]
        );
        assert!(stmts[0].contains("c.name = N'it''s'"), "{}", stmts[0]);
    }
}
