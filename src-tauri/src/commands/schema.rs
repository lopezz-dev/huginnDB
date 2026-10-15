//! Schema introspection commands (databases, tables, columns, indexes, server info).
//!
//! Every command takes a `connection_id` so it can resolve the right pool
//! from [`crate::state::AppState`]. Queries are written against the
//! standard `information_schema` views where available, with `pg_*` /
//! `sqlite_master` fallbacks for engine-specific metadata.

use crate::db::sql::{Dialect, Relation};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Serialize;
use tauri::State;

/// One row in the database/catalog list.
#[derive(Debug, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
}

/// A database's approximate on-disk size, answered by [`get_database_sizes`].
///
/// **A separate command, not a field on [`DatabaseInfo`], for three reasons.**
/// Cost: `pg_database_size` is not a catalog read but
/// `calculate_database_size()`, which walks the database's directory calling
/// `stat` per file — seconds on a server with nineteen large databases, and
/// `list_databases` sits on the critical path of expanding a connection, under
/// the connection's `with_timeout_for` ceiling. Honesty: an `Option<u64>` populated by one driver in
/// five is a field that lies by omission. And contract: `list_databases` is
/// also an MCP tool that travels over the bridge, so a new command touches
/// nothing that already ships.
///
/// **Every number here is best-effort and they do not agree with each other.**
/// Postgres counts the whole directory including free space; MySQL sums
/// `DATA_LENGTH + INDEX_LENGTH` and cannot see free space at all; SQLite
/// multiplies out the page count, freelist included but the `-wal` sidecar
/// excluded; MongoDB reports `sizeOnDisk`, which is *compressed*; SQL Server
/// sums the allocated `ROWS` files and excludes the log. They also will not
/// match the sum of the per-table badges, nor the Pulse storage panel. There
/// is no reconciling them — the engines disagree about what a database's size
/// is — so the UI names its source per driver instead of pretending otherwise.
#[derive(Debug, Serialize)]
pub struct DatabaseSize {
    pub name: String,
    /// `None` means "the engine would not say", never "empty".
    ///
    /// The distinction is the whole contract: a MySQL login without the
    /// privilege gets `NULL` from the aggregate, and reporting that as `0`
    /// would tell the user a database with 31 tables is empty.
    ///
    /// Omitted from the JSON rather than serialized as `null`, matching
    /// [`TableInfo::size_bytes`] — the note there records that emitting `null`
    /// once already slipped past the frontend's `undefined` guard and crashed
    /// `formatBytes`.
    #[serde(rename = "size_bytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// One row in the table/view list.
#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    /// Approximate row count sourced from the engine's statistics catalog.
    ///
    /// - **Postgres** — `pg_stat_user_tables.n_live_tup` (updated by autovacuum; may be 0
    ///   for brand-new tables or views).
    /// - **MySQL** — `information_schema.TABLES.TABLE_ROWS` (engine-maintained estimate;
    ///   can differ significantly from `COUNT(*)` on InnoDB).
    /// - **SQLite** — always `None`. Reliable per-table counts require individual
    ///   `COUNT(*)` queries, which become prohibitively expensive on schemas with
    ///   many tables. Use `SELECT COUNT(*) FROM table` manually when an exact count
    ///   is needed.
    // Omit when absent (`None`) rather than emitting JSON `null`. The frontend
    // types this as `row_count?: number` and guards on `undefined`; serializing
    // `null` slipped past that guard and crashed `formatCount`/`formatBytes`.
    #[serde(rename = "row_count", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    /// Approximate on-disk size in bytes (data + indexes) sourced from the engine.
    ///
    /// - **Postgres** — `pg_total_relation_size(...)`, only for ordinary tables
    ///   (`pg_class.relkind = 'r'`); views and foreign tables yield `None`.
    /// - **MySQL** — `DATA_LENGTH + INDEX_LENGTH` from `information_schema.TABLES`.
    ///   `None` for views.
    /// - **SQLite** — best-effort via the optional `dbstat` virtual table. If the
    ///   build does not include `dbstat`, the first probe fails and every entry
    ///   in this list falls back to `None` for the rest of the call.
    #[serde(rename = "size_bytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Column metadata as displayed in the schema explorer.
///
/// `referenced_*` fields are populated for **single-column** FOREIGN KEY
/// constraints only. Composite FKs are intentionally ignored in this
/// iteration — the UI degrades to a plain text input for them.
#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub referenced_schema: Option<String>,
    pub referenced_table: Option<String>,
    pub referenced_column: Option<String>,
}

/// A foreign key on *another* table that points at the one being asked about —
/// the reverse of [`ColumnInfo::referenced_table`], answered by
/// [`list_referencing_foreign_keys`].
///
/// `schema` is the referencing table's own schema, which need not be the
/// target's: MySQL and Postgres both allow cross-schema FKs, and a drop
/// warning that omitted the schema would send the user looking in the wrong
/// database. SQLite reports `None` (one schema only).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IncomingForeignKey {
    pub schema: Option<String>,
    pub table: String,
    pub constraint: String,
    /// The referencing table's columns, in constraint order.
    pub columns: Vec<String>,
}

/// Fold one-row-per-column catalog output into one entry per constraint.
///
/// Every driver's query returns `(schema, table, constraint, column)` ordered
/// by the first three and then by the column's position in the key, so a
/// composite FK arrives as consecutive rows. Folding consecutive runs (rather
/// than a map keyed on the constraint name) keeps that order and does not
/// merge two same-named constraints living on different tables — constraint
/// names are only unique per table on Postgres and SQLite.
pub(crate) fn group_incoming_fks(
    rows: impl IntoIterator<Item = (Option<String>, String, String, String)>,
) -> Vec<IncomingForeignKey> {
    let mut out: Vec<IncomingForeignKey> = Vec::new();
    for (schema, table, constraint, column) in rows {
        match out.last_mut() {
            Some(last)
                if last.schema == schema
                    && last.table == table
                    && last.constraint == constraint =>
            {
                last.columns.push(column)
            }
            _ => out.push(IncomingForeignKey {
                schema,
                table,
                constraint,
                columns: vec![column],
            }),
        }
    }
    out
}

/// Index summary including the participating columns.
#[derive(Debug, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// An [`IndexInfo`] plus, on MongoDB, the full index definition.
///
/// The MCP connector's read shape, and the reason it is not simply
/// [`IndexInfo`]: that DTO carries a *field list*, so an AI client asked to
/// recreate `{createdAt: -1}` reads back `["createdAt"]` and rebuilds it
/// **ascending** — invisible in testing, permanent in the data. The same
/// argument that made `db/mongo/indexes.rs` a second index reader alongside
/// `db/mongo/schema.rs` applies to any caller that might write what it read.
///
/// Follows 1.18.0's `describe_table` + `view` shape: the same array, each entry
/// gaining an object only where there is something to add. The explorer keeps
/// calling [`list_indexes_inner`], so the `$collStats` / `$indexStats` cost of
/// the rich reader is paid only here.
#[derive(Debug, Serialize)]
pub struct IndexDetail {
    #[serde(flatten)]
    pub base: IndexInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mongo: Option<crate::db::mongo::indexes::MongoIndexInfo>,
}

/// One server-side user/role, as surfaced by the "Security" panel.
///
/// Field meaning is necessarily driver-specific:
/// - **Postgres** — one row per `pg_roles` entry. `name` is the role name.
/// - **MySQL** — one row per `mysql.user` account. `name` is `"user@host"`
///   (MySQL accounts are scoped by host, so the pair is the real identity —
///   the same user name can exist multiple times with different hosts).
/// - **SQLite** — always empty; the engine has no user/permission concept.
/// - **MongoDB** — one row per user document in the resolved database
///   (`db.runCommand({usersInfo: 1})`). `name` is the bare username.
#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub name: String,
    /// True for a superuser/admin-equivalent account. `false` where the
    /// engine has no such concept or it couldn't be determined.
    pub is_superuser: bool,
    /// True unless the account is explicitly locked/disabled. Defaults to
    /// `true` for engines that don't expose this.
    pub can_login: bool,
    /// Group/role memberships. Postgres: role names this role is a member
    /// of. MySQL: granted roles (MySQL 8 roles, if any). MongoDB:
    /// `"role@db"` strings. Always empty for SQLite.
    pub roles: Vec<String>,
}

/// One granted privilege, as surfaced when the user expands a row in the
/// "Security" panel.
///
/// `schema` / `table` are `None` for a server- or database-wide grant (e.g.
/// Postgres/MySQL `GRANT ... ON *.*`, or a MongoDB privilege whose resource
/// has no collection). Both are `Some` for a grant scoped to one
/// table/collection.
#[derive(Debug, Serialize)]
pub struct PrivilegeInfo {
    pub privilege: String,
    pub schema: Option<String>,
    pub table: Option<String>,
}

/// List visible databases / schemas / catalogs for the connection.
#[tauri::command]
pub async fn list_databases(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DatabaseInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::endpoint(state.inner(), &connection_id)?;
    let databases = crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_databases",
        list_databases_inner(state.inner(), &connection_id),
    )
    .await?;
    Ok(crate::commands::guard::databases(
        state.inner(),
        &connection_id,
        databases,
    ))
}

/// Borrowed-state core of [`list_databases`], reused by the headless MCP
/// `list_databases` tool.
pub async fn list_databases_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<DatabaseInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_databases(&p).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_databases(&p).await,
        DbPool::Sqlite(_) => Ok(crate::db::sqlite::schema::list_databases()),
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_databases(&conn).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::list_databases(&p).await,
    }
}

/// Approximate on-disk size per database, for the schema tree's badge (#153).
///
/// Deliberately deferred rather than folded into [`list_databases`] — see
/// [`DatabaseSize`] for why, and for what each driver's number actually
/// measures. Failure is per-database, never per-call: a database the login
/// cannot read comes back with `size_bytes: None` and the rest still answer.
#[tauri::command]
pub async fn get_database_sizes(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DatabaseSize>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::endpoint(state.inner(), &connection_id)?;
    let sizes = crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "get_database_sizes",
        get_database_sizes_inner(state.inner(), &connection_id),
    )
    .await?;
    // Sizes name databases, so they are filtered like the list itself.
    Ok(sizes
        .into_iter()
        .filter(|d| {
            crate::commands::guard::database(state.inner(), &connection_id, &d.name).is_ok()
        })
        .collect())
}

/// Borrowed-state core of [`get_database_sizes`].
///
/// Five explicit arms and no `_ =>` (ADR #30): a new driver must state what
/// its size means rather than silently inheriting Postgres's.
pub async fn get_database_sizes_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<DatabaseSize>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::database_sizes(&p).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::database_sizes(&p).await,
        DbPool::Sqlite(p) => crate::db::sqlite::schema::database_sizes(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::schema::database_sizes(&conn).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::database_sizes(&p).await,
    }
}

/// Create a new database/catalog on the server behind `connection_id`.
///
/// Server-level DDL, so it runs regardless of which database the pool happens
/// to be connected to. SQLite is the one driver rejected outright: the file
/// *is* the database, so there is nothing to create without also choosing a
/// path, which is what the connection dialog is for.
///
/// **MongoDB needs `initial_collection` and the SQL drivers refuse it.** A
/// MongoDB database does not exist as an empty thing — the server materialises
/// it when its first collection is written and forgets it again when the last
/// one is dropped — so "create a database" there means "create a database and
/// its first collection", exactly as Compass asks for both. That asymmetry is
/// why this takes an `Option` rather than being split into two commands: the
/// *intent* is one intent, and splitting it would move the per-driver branch
/// into the frontend, where `lib/tauri.ts` would then have to know which of
/// the two to call. Passing one to a SQL driver is an error rather than a
/// silently ignored argument, because a caller that sent it believed something
/// about what it was about to do.
///
/// `name` goes through the same [`crate::db::ddl::validate_ident`] allowlist
/// used by the structure editor (ADR #16) — `CREATE DATABASE` cannot bind
/// the name as a parameter, so validating before quoting is the only
/// injection defense available. MongoDB adds
/// [`crate::db::mongo::schema::validate_database_name`] on top, which is about
/// namespace legality rather than quoting (see its doc comment).
#[tauri::command]
pub async fn create_database(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    initial_collection: Option<String>,
) -> AppResult<()> {
    crate::db::ddl::validate_ident("database", &name)?;
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::database_ddl(state.inner(), &connection_id, &name)?;
    let pool = state.pool_for(&connection_id)?;
    if initial_collection.is_some() && !matches!(pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "an initial collection only applies to MongoDB".into(),
        ));
    }
    match pool {
        DbPool::Postgres(p) => {
            let sql = format!("CREATE DATABASE {}", Dialect::Postgres.quote_ident(&name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            let sql = format!("CREATE DATABASE {}", Dialect::Mysql.quote_ident(&name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(_) => {
            return Err(AppError::InvalidInput(
                "SQLite has no separate databases — each file is one database".into(),
            ));
        }
        DbPool::Mongo(conn) => {
            let collection = initial_collection.ok_or_else(|| {
                AppError::InvalidInput(
                    "MongoDB needs a first collection to create a database with — an empty \
                     database does not exist on the server"
                        .into(),
                )
            })?;
            crate::db::mongo::schema::validate_database_name(&name)?;
            let collection = crate::db::mongo::schema::validate_collection(&collection)?;
            // Checked rather than left to the server, which has no error for
            // this: `create_collection` against an existing database succeeds
            // and quietly adds a collection to it, so "create database" would
            // report success having created no database at all.
            if conn
                .client
                .list_database_names()
                .await?
                .iter()
                .any(|existing| existing == &name)
            {
                return Err(AppError::InvalidInput(format!(
                    "the database {name} already exists"
                )));
            }
            conn.client
                .database(&name)
                .create_collection(collection)
                .await?;
        }
        DbPool::MsSql(p) => {
            let sql = format!("CREATE DATABASE {}", Dialect::MsSql.quote_ident(&name));
            p.acquire().await?.simple_execute(&sql).await?;
        }
    }
    Ok(())
}

/// Drop a database/catalog on the server behind `connection_id`.
///
/// The mirror of [`create_database`], and mirrored deliberately: every driver
/// that can create a database can drop one. MongoDB was the exception until
/// 1.23.1 — not because `dropDatabase` is unavailable there (it is one command
/// and always has been) but because the UI gate for dropping was wired to
/// *`supportsCreateDatabase`*, so Mongo's inability to create an **empty**
/// database was read as an inability to delete a full one. One predicate
/// answering two questions; the frontend now asks each separately.
///
/// `name` is validated through the same `validate_ident` allowlist because
/// `DROP DATABASE` can't bind its identifier as a parameter.
///
/// `connection_id` is the *parent* connection. Before issuing the drop we
/// close any synthetic per-database pool this session opened while browsing
/// the target (`<connection_id>::db::<name>`, see `open_database_view`):
/// Postgres refuses to drop a database that still has sessions attached, and
/// our own child pool is the most likely holder. `Pool::close().await` waits
/// for those connections to actually go away rather than relying on the lazy
/// drop of the `ActivePool`.
///
/// # Dropping the database the connection itself is bound to
///
/// A profile with a `database` set has its pool *inside* the database the user
/// is asking to delete, and the four engines disagree about what that means:
///
/// - **MySQL and MongoDB** allow it. The session is left with no default
///   database, which is correct, since it no longer has one.
/// - **Postgres** refuses categorically — a session cannot drop the database it
///   is connected to, and it also refuses while *any* session is attached, so
///   issuing the statement from elsewhere is not enough on its own. Both halves
///   are handled here: the pool is closed first (the app's own sessions are the
///   ones in the way), then the statement runs over a single short-lived
///   connection to the `postgres` maintenance database, built by cloning the
///   pool's own [`sqlx::postgres::PgConnectOptions`]. Cloning them rather than
///   rebuilding a URL is what keeps this honest — same host and port (the SSH
///   tunnel's local listener included), same credentials, same TLS mode, and no
///   second trip to the keychain.
/// - **SQL Server** refuses while the database is in use, which the pool's own
///   idle sessions are enough to trigger. The checked-out session moves itself
///   to `master` and [`MsSqlPool::close_idle`] drops the rest.
///
/// **This leaves the connection unusable, on purpose.** In the Postgres case
/// its pool is closed outright; in the others the pool survives but its default
/// database is gone. The caller is expected to disconnect afterwards — the
/// frontend does, whether the drop succeeded or failed, because a pool closed
/// by a *failed* attempt is just as dead as one closed by a successful one.
/// Nothing is removed from the connection registry here: the `ActivePool` also
/// owns the SSH tunnel, and tearing it down before the maintenance connection
/// is made would pull the listener out from under it.
#[tauri::command]
pub async fn drop_database(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    crate::db::ddl::validate_ident("database", &name)?;
    crate::commands::guard::database_ddl(state.inner(), &connection_id, &name)?;
    // Remove + close our child pool first. The write guard is released at the
    // end of this statement, so the subsequent `.close().await` never holds
    // the lock across an await point.
    let child_id = crate::commands::connection::database_view_id(&connection_id, &name);
    let removed = state.connections.write().remove(&child_id);
    if let Some(active) = removed {
        match &active.pool {
            DbPool::Postgres(p) => p.close().await,
            DbPool::Mysql(p) => p.close().await,
            // MongoDB and SQL Server have no pool to drain here: the Mongo
            // handle is a cloned `Client` whose own pool outlives this entry,
            // and neither server refuses a drop over an idle session the way
            // Postgres does. Dropping the registry entry is the whole job.
            _ => {}
        }
    }
    // Whether this connection's *own* pool sits inside the database being
    // dropped. Read from the profile rather than asked of the server: it is
    // the same fact (`profile.database` is what the pool was opened with), it
    // costs no round trip, and on a pool we are about to close a failed extra
    // query would be a worse way to find out.
    let bound_to_target = state
        .profiles
        .read()
        .iter()
        .find(|p| p.id == connection_id)
        .is_some_and(|p| p.database == name);
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    let pool = state.pool_for(&connection_id)?;
    match pool {
        DbPool::Postgres(p) => {
            let sql = format!("DROP DATABASE {}", Dialect::Postgres.quote_ident(&name));
            if bound_to_target {
                // Capture the options *before* closing: they are what the
                // maintenance connection is built from, tunnel endpoint and
                // all.
                let options = (*p.connect_options()).clone();
                p.close().await;
                // `postgres` is the maintenance database every server has, and
                // is itself droppable — so when it is the target, fall back to
                // `template1`, the other database `initdb` always creates.
                let maintenance = if name == "postgres" {
                    "template1"
                } else {
                    "postgres"
                };
                let mut conn = <sqlx::postgres::PgConnection as sqlx::Connection>::connect_with(
                    &options.database(maintenance),
                )
                .await?;
                let result = sqlx::query(&sql).execute(&mut conn).await;
                // Closed explicitly rather than by drop: a lingering session on
                // the maintenance database is exactly the kind of thing that
                // makes the *next* drop fail for no visible reason.
                let _ = sqlx::Connection::close(conn).await;
                result?;
            } else {
                sqlx::query(&sql).execute(&p).await?;
            }
        }
        DbPool::Mysql(p) => {
            // MySQL drops the session's own default database without
            // complaint, so both cases are the same statement.
            let sql = format!("DROP DATABASE {}", Dialect::Mysql.quote_ident(&name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(_) => {
            return Err(AppError::InvalidInput(
                "SQLite has no separate databases — delete the file instead".into(),
            ));
        }
        DbPool::Mongo(conn) => {
            crate::db::mongo::schema::validate_database_name(&name)?;
            // `dropDatabase` against a name that does not exist is a no-op
            // reported as success, so this check is what makes a typo visible
            // instead of being confirmed back to the user as a deletion.
            if !conn
                .client
                .list_database_names()
                .await?
                .iter()
                .any(|existing| existing == &name)
            {
                return Err(AppError::InvalidInput(format!(
                    "no database named {name} on this server"
                )));
            }
            conn.client.database(&name).drop().await?;
        }
        DbPool::MsSql(p) => {
            let sql = format!("DROP DATABASE {}", Dialect::MsSql.quote_ident(&name));
            let mut client = p.acquire().await?;
            if bound_to_target {
                // Two statements, deliberately not batched into one `USE …;
                // DROP …`: if the `USE` fails (no access to `master`) the drop
                // must not be attempted from inside the doomed database, and a
                // batch would report one error for the pair.
                client.simple_execute("USE [master]").await?;
                p.close_idle().await;
            }
            client.simple_execute(&sql).await?;
        }
    }
    Ok(())
}

/// Create a MongoDB collection on the database `connection_id` is scoped to (#61).
///
/// MongoDB creates a collection implicitly on first write, so there was no way
/// to materialize an empty collection from the UI — this issues an explicit
/// `create` command (via the driver's `create_collection`) so it shows up in
/// the explorer before any document is inserted, matching MongoDB Compass.
///
/// MongoDB-only by design: the SQL drivers have their table-creation path
/// through the structure editor (`preview_structure_change`/`apply_structure_change`,
/// ADR #16), so a non-Mongo pool is rejected here rather than silently doing
/// nothing. `connection_id` may be a synthetic `<parent>::db::<db>` view id —
/// `resolve_db` reads the database the Mongo pool is bound to either way.
///
/// `name` is validated (non-empty, no `system.` prefix which MongoDB reserves
/// for internal namespaces) before the wire command. This isn't a
/// SQL-injection surface — the name is a `create` command argument, never
/// string-interpolated into a query — but rejecting reserved/empty names up
/// front gives a clean error instead of a cryptic server-side one.
#[tauri::command]
pub async fn create_collection(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    // `validate_collection` rather than the three checks this used to inline:
    // it is the same rule every other collection-level write already goes
    // through (`create_index`, `rename_collection`, …), and a second copy here
    // was one edit away from disagreeing with them about what MongoDB accepts.
    let trimmed = crate::db::mongo::schema::validate_collection(&name)?;
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        None,
        trimmed,
        crate::db::sql::Verbs::DDL,
    )?;
    let pool = state.pool_for(&connection_id)?;
    match &pool {
        DbPool::Mongo(conn) => {
            let db = crate::db::mongo::schema::resolve_db(conn)?;
            db.create_collection(trimmed).await?;
            Ok(())
        }
        _ => Err(AppError::InvalidInput(
            "creating a collection is only supported for MongoDB; use the structure editor to create a table".into(),
        )),
    }
}

/// List user-visible tables and views, with approximate row counts where available.
///
/// Row counts are sourced from engine statistics catalogs in a single query to
/// avoid N+1 round-trips. See [`TableInfo::row_count`] for per-driver details.
#[tauri::command]
pub async fn list_tables(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    _database: Option<String>,
) -> AppResult<Vec<TableInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::endpoint(state.inner(), &connection_id)?;
    let tables = crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_tables",
        list_table_names_inner(state.inner(), &connection_id),
    )
    .await?;
    Ok(crate::commands::guard::tables(
        state.inner(),
        &connection_id,
        tables,
    ))
}

/// Borrowed-state core of the **complete** table listing — names *and* every
/// driver's approximate row counts and sizes — reused by the headless MCP
/// `list_tables` tool, the dump's progress estimate and the bridge. The
/// `_database` argument the command accepts is unused (the pool is already
/// bound to one database), so the inner form drops it.
///
/// Not what the schema tree draws from any more: see
/// [`list_table_names_inner`].
pub async fn list_tables_inner(state: &AppState, connection_id: &str) -> AppResult<Vec<TableInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_tables(&p).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_tables(&p).await,
        DbPool::Sqlite(p) => crate::db::sqlite::schema::list_tables(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_collections_with_stats(&conn).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::list_tables(&p).await,
    }
}

/// The listing a person is waiting on: [`list_tables_inner`] minus any figure
/// that costs a round trip **per relation**.
///
/// Only MongoDB differs. The SQL drivers read counts and sizes from one
/// statistics catalog in the same query that lists the tables, so leaving them
/// out would save nothing. MongoDB has no such catalog — each collection's
/// count is its own command — and behind an SSH tunnel those commands were
/// nearly the whole of the wait before a database's collections appeared. The
/// tree asks for them afterwards through [`get_table_stats`].
///
/// Explicit arms, no `_ =>` (ADR #30): a new driver states which half it
/// belongs to.
pub async fn list_table_names_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<TableInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_collections(&conn).await,
        DbPool::Postgres(_) | DbPool::Mysql(_) | DbPool::Sqlite(_) | DbPool::MsSql(_) => {
            list_tables_inner(state, connection_id).await
        }
    }
}

/// The per-relation figures [`list_tables`] left out, for the schema tree to
/// fill its badges in after the names are already on screen.
///
/// Returns the same [`TableInfo`] rows as [`list_tables_inner`], so the
/// frontend merges by `(schema, name)` and the visibility filter is the one
/// the listing itself goes through. **Empty for every driver whose listing
/// already carried its figures** — answered without touching the server, so
/// the frontend can call this unconditionally rather than knowing which
/// drivers need it.
#[tauri::command]
pub async fn get_table_stats(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<TableInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::endpoint(state.inner(), &connection_id)?;
    let stats = crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "get_table_stats",
        get_table_stats_inner(state.inner(), &connection_id),
    )
    .await?;
    // Rows name relations, so they are filtered like the list itself.
    Ok(crate::commands::guard::tables(
        state.inner(),
        &connection_id,
        stats,
    ))
}

/// Borrowed-state core of [`get_table_stats`]. Explicit arms (ADR #30).
pub async fn get_table_stats_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<TableInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_collections_with_stats(&conn).await,
        // Already in `list_tables`' answer; see `list_table_names_inner`.
        DbPool::Postgres(_) | DbPool::Mysql(_) | DbPool::Sqlite(_) | DbPool::MsSql(_) => {
            Ok(Vec::new())
        }
    }
}

/// List columns for `schema.table` in catalog order.
///
/// The `is_primary_key` flag is determined by joining against
/// `information_schema.table_constraints` (Postgres), `column_key`
/// (MySQL), or the `pk` field of `PRAGMA table_info` (SQLite).
///
/// Single-column foreign-key references are surfaced via
/// `referenced_schema` / `referenced_table` / `referenced_column`.
/// Composite FKs are deliberately filtered out to keep the FK-dropdown
/// UI simple — they fall back to a plain text input.
#[tauri::command]
pub async fn list_columns(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::read(state.inner(), &connection_id, schema.as_deref(), &table)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_columns",
        list_columns_inner(state.inner(), &connection_id, schema, table),
    )
    .await
}

/// Borrowed-state variant of [`list_columns`] so other command handlers can
/// reuse the catalog lookup without re-entering the Tauri State guard.
pub async fn list_columns_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_columns(&p, schema, table).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_columns(&p, schema, table).await,
        DbPool::Sqlite(p) => crate::db::sqlite::schema::list_columns(&p, schema, table).await,
        DbPool::Mongo(conn) => crate::db::mongo::schema::infer_columns(&conn, &table).await,
        DbPool::MsSql(p) => {
            crate::db::mssql::schema::list_columns(&p, schema.as_deref(), &table).await
        }
    }
}

/// List indexes for `schema.table`, with the columns each one covers.
#[tauri::command]
pub async fn list_indexes(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::read(state.inner(), &connection_id, schema.as_deref(), &table)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_indexes",
        list_indexes_inner(state.inner(), &connection_id, schema, table),
    )
    .await
}

/// Borrowed-state core of [`list_indexes`], reused by the headless MCP
/// `list_indexes` tool.
pub async fn list_indexes_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_indexes(&p, schema, table).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_indexes(&p, schema, table).await,
        DbPool::Sqlite(p) => crate::db::sqlite::schema::list_indexes(&p, schema, table).await,
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_indexes(&conn, &table).await,
        DbPool::MsSql(p) => {
            crate::db::mssql::schema::list_indexes(&p, schema.as_deref(), &table).await
        }
    }
}

/// [`list_indexes_inner`] widened with MongoDB's full index definitions.
///
/// On MongoDB it reads the *rich* catalogue once and derives the SQL-shaped
/// triple from it, rather than calling both readers — the field list is a
/// projection of the key document, so a second round trip could only disagree
/// with the first. Every other driver passes straight through, so the two
/// readers `db/mongo/indexes.rs` deliberately keeps apart stay apart.
pub async fn list_indexes_detailed_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexDetail>> {
    if let DbPool::Mongo(conn) = state.pool_for(connection_id)? {
        let rich = crate::db::mongo::indexes::list_indexes(&conn, &table).await?;
        return Ok(rich
            .into_iter()
            .map(|m| IndexDetail {
                base: IndexInfo {
                    name: m.name.clone(),
                    columns: m.keys.iter().map(|k| k.field.clone()).collect(),
                    unique: m.unique,
                },
                mongo: Some(m),
            })
            .collect());
    }
    Ok(list_indexes_inner(state, connection_id, schema, table)
        .await?
        .into_iter()
        .map(|base| IndexDetail { base, mongo: None })
        .collect())
}

/// Drop a table. `schema` is optional — when omitted the driver applies
/// its default (Postgres → `public`; MySQL → current `DATABASE()`; SQLite
/// has no schema concept).
///
/// All identifiers are sourced from the schema explorer, which itself comes
/// from a catalog query, so the [`Dialect::quote_ident`] usage matches the rule in
/// `SECURITY.md` — never applied to free-form user input.
#[tauri::command]
pub async fn drop_table(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::DDL,
    )?;
    let pool = state.pool_for(&connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        let db = crate::db::mongo::schema::resolve_db(conn)?;
        db.collection::<mongodb::bson::Document>(&table)
            .drop()
            .await?;
        return Ok(());
    }
    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let sql = format!("DROP TABLE {qt}");
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}

/// The foreign keys on other tables that reference `schema.table` — what
/// stands between the user and a `DROP TABLE`.
///
/// The drop dialog asks this before the user confirms. Without it the only
/// signal was the server's refusal after the fact, and on MySQL 5.7 / MariaDB
/// that refusal (1217/1451, "a foreign key constraint fails") names no table
/// at all; MySQL 8.0's 3730 names one even when several reference it.
///
/// **Self-references are left out** by every driver's query: a table's FK to
/// itself does not block dropping it, and listing it would be a warning about
/// nothing. MongoDB has no foreign keys and answers an empty list.
#[tauri::command]
pub async fn list_referencing_foreign_keys(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IncomingForeignKey>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::read(state.inner(), &connection_id, schema.as_deref(), &table)?;
    let incoming = crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_referencing_foreign_keys",
        list_referencing_foreign_keys_inner(state.inner(), &connection_id, schema, table),
    )
    .await?;
    // Each entry names the table the key comes *from*: one the person may not
    // see is left out, or the list would name it.
    Ok(incoming
        .into_iter()
        .filter(|fk| {
            crate::commands::guard::visible(
                state.inner(),
                &connection_id,
                fk.schema.as_deref(),
                &fk.table,
            )
        })
        .collect())
}

async fn list_referencing_foreign_keys_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IncomingForeignKey>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => {
            crate::db::postgres::schema::referencing_fks(&p, schema.as_deref(), &table).await
        }
        DbPool::Mysql(p) => {
            crate::db::mysql::schema::referencing_fks(&p, schema.as_deref(), &table).await
        }
        DbPool::Sqlite(p) => crate::db::sqlite::schema::referencing_fks(&p, &table).await,
        DbPool::MsSql(p) => {
            crate::db::mssql::schema::referencing_fks(&p, schema.as_deref(), &table).await
        }
        DbPool::Mongo(_) => Ok(Vec::new()),
    }
}

/// Empty a table — remove every row while keeping the table itself (#69).
///
/// Postgres/MySQL use `TRUNCATE TABLE` (fast, non-logged); SQLite has no
/// `TRUNCATE`, so a plain `DELETE FROM` clears it. MongoDB deletes every
/// document (`delete_many({})`) rather than dropping the collection. Same
/// catalog-sourced identifier guarantees as [`drop_table`] — `schema`/`table`
/// come from the schema explorer, never free-form input, so [`Dialect::quote_ident`]
/// is used per the `SECURITY.md` rule.
#[tauri::command]
pub async fn empty_table(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<()> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::DDL,
    )?;
    let pool = state.pool_for(&connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        let db = crate::db::mongo::schema::resolve_db(conn)?;
        db.collection::<mongodb::bson::Document>(&table)
            .delete_many(mongodb::bson::Document::new())
            .await?;
        return Ok(());
    }
    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &table);
    let sql = dialect.truncate_stmt(&qt);
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}

/// Rename a table, or a MongoDB collection. Same identifier-source guarantees
/// as [`drop_table`].
///
/// MySQL uses `RENAME TABLE old TO new`; Postgres and SQLite both accept
/// `ALTER TABLE old RENAME TO new`. The new name is sent as a quoted
/// identifier (never bound) because SQL does not allow binding for DDL
/// identifiers — but the caller's UI restricts the value to safe characters
/// before it reaches the command (see `SchemaExplorer` rename dialog).
///
/// `new_schema` is MongoDB-only: `renameCollection` qualifies both sides with
/// a database, so moving a collection to another one costs nothing extra. The
/// SQL drivers ignore it — a cross-schema move is a different operation there
/// (`ALTER TABLE … SET SCHEMA` on Postgres, nothing at all on SQLite) and is
/// not offered by the UI.
// A Tauri command's arguments *are* its IPC payload, so folding them into a
// struct would change the wire shape rather than simplify anything.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rename_table(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    new_name: String,
    new_schema: Option<String>,
) -> AppResult<()> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "rename_table: new_name must not be empty".into(),
        ));
    }
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    // Both ends: the relation being renamed, and the name (and, on MongoDB, the
    // database) it would land under.
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        schema.as_deref(),
        &table,
        crate::db::sql::Verbs::DDL,
    )?;
    crate::commands::guard::relation(
        state.inner(),
        &connection_id,
        new_schema.as_deref().or(schema.as_deref()),
        new_name.trim(),
        crate::db::sql::Verbs::DDL,
    )?;
    let pool = state.pool_for(&connection_id)?;
    // MongoDB has no DDL to build: `renameCollection` is a run-command on
    // `admin` that takes both sides fully qualified, so it also covers the
    // move-to-another-database case the SQL drivers don't offer.
    if let DbPool::Mongo(conn) = &pool {
        crate::db::mongo::schema::rename_collection(
            conn,
            &table,
            new_name.trim(),
            new_schema.as_deref(),
        )
        .await?;
        return Ok(());
    }
    let dialect = Dialect::try_of(&pool)?;
    let sql = dialect.rename_stmt(schema.as_deref(), &table, new_name.trim(), Relation::Table)?;
    crate::db::exec::execute(&pool, &sql).await?;
    Ok(())
}

/// Return a short version string for the connected server.
///
/// The string is formatted as `"{engine} {version}"` for easy display in
/// the status bar (e.g. `"sqlite 3.45.3"`, `"postgresql 16.2"`, `"mysql 8.0.35"`).
///
/// Drivers:
/// - **Postgres** — `SELECT version()`, first two tokens lowercased.
/// - **MySQL** — `SELECT VERSION()`, stripped to `major.minor.patch` before the
///   distro suffix.
/// - **SQLite** — `SELECT sqlite_version()`.
#[tauri::command]
pub async fn server_version(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<String> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::endpoint(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "server_version",
        server_version_inner(state.inner(), &connection_id),
    )
    .await
}

/// Borrowed-state core of [`server_version`], reused by the headless MCP
/// `server_version` tool.
pub async fn server_version_inner(state: &AppState, connection_id: &str) -> AppResult<String> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::server_version(&p).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::server_version(&p).await,
        DbPool::Sqlite(p) => crate::db::sqlite::schema::server_version(&p).await,
        DbPool::Mongo(conn) => crate::db::mongo::schema::server_version(&conn).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::server_version(&p).await,
    }
}

/// List server-side users/roles visible to the connection.
///
/// Always returns a (possibly empty) list rather than an error for engines
/// with reduced visibility — e.g. a MySQL account without `SELECT` on
/// `mysql.user` falls back to reporting just itself via `CURRENT_USER()`
/// instead of failing the whole panel.
#[tauri::command]
pub async fn list_users(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<UserInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_users",
        list_users_inner(state.inner(), &connection_id),
    )
    .await
}

/// Borrowed-state core of [`list_users`], reused by the headless MCP
/// `list_users` tool.
pub async fn list_users_inner(state: &AppState, connection_id: &str) -> AppResult<Vec<UserInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_users(&p).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_users(&p).await,
        // SQLite has no user model at all: the file's permissions are the
        // access control. An empty list is the honest answer, and the Security
        // panel renders its own explanation for it.
        DbPool::Sqlite(_) => Ok(vec![]),
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_users(&conn).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::list_users(&p).await,
    }
}

/// List the privileges granted to `user` (as returned by [`list_users`]).
#[tauri::command]
pub async fn list_privileges(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    user: String,
) -> AppResult<Vec<PrivilegeInfo>> {
    crate::commands::ensure_view(&app, &window, state.inner(), &connection_id).await;
    crate::commands::guard::monitor(state.inner(), &connection_id)?;
    crate::error::with_timeout_for(
        state.inner(),
        &connection_id,
        "list_privileges",
        list_privileges_inner(state.inner(), &connection_id, user),
    )
    .await
}

/// Borrowed-state core of [`list_privileges`], reused by the headless MCP
/// `list_privileges` tool.
pub async fn list_privileges_inner(
    state: &AppState,
    connection_id: &str,
    user: String,
) -> AppResult<Vec<PrivilegeInfo>> {
    match state.pool_for(connection_id)? {
        DbPool::Postgres(p) => crate::db::postgres::schema::list_privileges(&p, user).await,
        DbPool::Mysql(p) => crate::db::mysql::schema::list_privileges(&p, user).await,
        // No users, so no privileges — see `list_users_inner`.
        DbPool::Sqlite(_) => Ok(vec![]),
        DbPool::Mongo(conn) => crate::db::mongo::schema::list_privileges(&conn, &user).await,
        DbPool::MsSql(p) => crate::db::mssql::schema::list_privileges(&p, &user).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        schema: Option<&str>,
        table: &str,
        fk: &str,
        col: &str,
    ) -> (Option<String>, String, String, String) {
        (schema.map(Into::into), table.into(), fk.into(), col.into())
    }

    #[test]
    fn incoming_fks_fold_a_composite_key_into_one_entry_in_key_order() {
        let got = group_incoming_fks([
            row(Some("shop"), "lines", "fk_lines_order", "order_id"),
            row(Some("shop"), "lines", "fk_lines_order", "order_rev"),
            row(Some("shop"), "payments", "fk_pay_order", "order_id"),
        ]);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].columns, vec!["order_id", "order_rev"]);
        assert_eq!(got[1].table, "payments");
    }

    #[test]
    fn incoming_fks_keep_same_named_constraints_on_different_tables_apart() {
        // Postgres and SQLite scope constraint names per table, so `fk_order`
        // can exist twice; merging them would invent a composite key.
        let got = group_incoming_fks([
            row(Some("public"), "a", "fk_order", "order_id"),
            row(Some("public"), "b", "fk_order", "order_id"),
            row(Some("archive"), "b", "fk_order", "order_id"),
        ]);
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(|f| f.columns == vec!["order_id"]));
    }

    /// `DatabaseSize` is a wire contract, and the difference between an absent
    /// key and a `null` one has already cost this codebase a crash once — the
    /// note on `TableInfo::size_bytes` records it. These pin the serialised
    /// shape without touching a database or the disk (convention #52).
    #[test]
    fn an_unknown_size_omits_the_key_rather_than_emitting_null() {
        let json = serde_json::to_value(DatabaseSize {
            name: "prod".into(),
            size_bytes: None,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "name": "prod" }));
        assert!(
            json.get("size_bytes").is_none(),
            "a null here slips past the frontend's `undefined` guard and crashes formatBytes"
        );
    }

    #[test]
    fn a_genuine_zero_is_still_reported() {
        // The other half of the contract. `skip_serializing_if` keys on `None`,
        // not on falsiness, so an engine that really does answer 0 must not be
        // rounded off into "would not say".
        let json = serde_json::to_value(DatabaseSize {
            name: "empty".into(),
            size_bytes: Some(0),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "name": "empty", "size_bytes": 0 })
        );
    }

    #[test]
    fn a_known_size_serialises_as_a_number() {
        let json = serde_json::to_value(DatabaseSize {
            name: "prod".into(),
            size_bytes: Some(5_497_558_138_880),
        })
        .unwrap();
        assert_eq!(json["size_bytes"], serde_json::json!(5_497_558_138_880u64));
    }
}
