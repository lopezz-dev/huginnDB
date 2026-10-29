/**
 * Driver helpers shared by the CLI ad-hoc flow and the connect error paths.
 *
 * `normalizeDriver` maps the free-form `--driver` value (and common aliases)
 * onto the canonical {@link Driver} the backend understands; it returns
 * `null` for an empty/unrecognized value so callers can fall back to the
 * configured default or prompt the user.
 *
 * `driverMismatchHint` turns the cryptic protocol error you get when the
 * wrong driver is pointed at a server (e.g. the Postgres driver reading a
 * MySQL handshake) into an actionable suggestion.
 */

import { DEFAULT_PORTS } from "@/lib/constants";
import type { Driver } from "@/types";

/**
 * The port a profile really connects to, resolving a blank one to the
 * driver's default.
 *
 * A stored port of `0` means "the driver's default", not port zero — the
 * dialog's port field can be left blank, `--port` is optional, and an
 * imported profile can omit it. The backend resolves it the same way
 * (`ConnectionProfile::effective_port`); this is the copy every surface that
 * *shows* a port uses, so a profile the user left blank reads as
 * `db:5432`, which is where it connects, rather than as `db:0`, which is
 * nowhere.
 *
 * SQLite has no port and answers `0`; no SQLite surface prints one.
 */
export function effectivePort(driver: Driver, port: number): number {
  return port > 0 ? port : DEFAULT_PORTS[driver];
}

const DRIVER_ALIASES: Record<string, Driver> = {
  postgres: "postgres",
  postgresql: "postgres",
  postgre: "postgres",
  pg: "postgres",
  psql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  maria: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  mongodb: "mongodb",
  mongo: "mongodb",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  "ms-sql": "sqlserver",
  tsql: "sqlserver",
  azuresql: "sqlserver",
};

/**
 * Per-driver capability gates for the UI.
 *
 * These exist so the explorer doesn't accumulate `driver !== "mongodb" &&
 * driver !== "sqlserver"` chains that read as "not these two engines" when
 * what they actually mean is "this surface is implemented". Each one names the
 * *feature*, and the backend refuses the same operations with
 * `UnsupportedDriver`, so a gate that drifts produces an error message rather
 * than wrong SQL.
 */

/** The structure editor's `CREATE TABLE` / `ALTER TABLE`. MongoDB has no SQL
 *  DDL at all, so its structure tab is read-only (inferred fields and real
 *  indexes). Every SQL engine has a builder in `db::ddl`. */
export function supportsStructureEditing(driver: Driver | undefined): boolean {
  return driver !== "mongodb";
}

/** The view editor's `CREATE VIEW` / `ALTER VIEW`, and renaming a view.
 *
 *  A separate question from `supportsStructureEditing`, because the answer
 *  differs for SQL Server: its table DDL is written, its view DDL is not
 *  (`db::view_ddl` refuses it). Renaming waits for the same builder —
 *  `sp_rename` leaves the old name inside a view's stored definition, so a
 *  correct rename means re-issuing its `CREATE`. MongoDB views are pipelines
 *  edited in the aggregation editor instead. */
export function supportsViewEditing(driver: Driver | undefined): boolean {
  return driver !== "mongodb" && driver !== "sqlserver";
}

/** The structure editor's "CREATE" section: the table's definition as the
 *  server itself stores it. Only MySQL/MariaDB (`SHOW CREATE TABLE`) and
 *  SQLite (`sqlite_master.sql`) keep that text. Postgres and SQL Server would
 *  need it rebuilt from the catalog, and our builder drops comments, `CHECK`s
 *  and table options — not something to offer as "ready to paste". The
 *  backend (`get_table_create_ddl`) refuses the same set. */
export function supportsNativeCreateDdl(driver: Driver | undefined): boolean {
  return driver === "mysql" || driver === "sqlite";
}

/** Whole-database / per-table `.sql` export and import. Needs a per-driver
 *  literal encoder (`db/dump.rs`), which SQL Server doesn't have yet;
 *  MongoDB uses the per-collection JSON path instead. */
export function supportsSqlDump(driver: Driver | undefined): boolean {
  return driver !== "mongodb" && driver !== "sqlserver";
}

/** The dedicated index manager (list / create / hide / recreate / drop).
 *
 *  MongoDB-only, and not because the other engines lack indexes — they have
 *  them *inside* the structure editor, diffed into `CREATE INDEX` /
 *  `DROP INDEX` along with the rest of the table. MongoDB has no DDL to diff,
 *  so its indexes need their own surface and their own commands
 *  (`commands::mongo_indexes`, which refuses every other driver). */
export function supportsIndexManager(driver: Driver | undefined): boolean {
  return driver === "mongodb";
}

/** Creating a database. SQLite's file *is* the database, so there is nothing
 *  to create that the connection dialog does not already do.
 *
 *  MongoDB is in, but only alongside `requiresInitialCollection` below: it has
 *  no `CREATE DATABASE` wire command because an *empty* database is not a
 *  thing the server stores, so creating one means creating its first
 *  collection. Excluding Mongo outright — which is what this did until 1.23.1
 *  — left a server with no databases at all with no way out of the app. */
export function supportsCreateDatabase(driver: Driver | undefined): boolean {
  return (
    driver === "postgres" ||
    driver === "mysql" ||
    driver === "sqlserver" ||
    driver === "mongodb"
  );
}

/** Whether creating a database also requires naming its first collection.
 *
 *  MongoDB only, and not a UI nicety: `create_database`'s MongoDB arm refuses
 *  the call without one, because the alternative is reporting success for a
 *  database the server will not list. */
export function requiresInitialCollection(driver: Driver | undefined): boolean {
  return driver === "mongodb";
}

/** Dropping a database. Everything but SQLite, where deleting the file is the
 *  operation and the app is the wrong place to do it.
 *
 *  **Separate from `supportsCreateDatabase` on purpose.** The two used to be
 *  one predicate, and the tree's "Drop database…" entry read the create one —
 *  so MongoDB, which cannot create an empty database, was also denied the
 *  ability to drop a full one, even though `dropDatabase` is a single command
 *  it has always supported. One predicate cannot answer two questions. */
export function supportsDropDatabase(driver: Driver | undefined): boolean {
  return (
    driver === "postgres" ||
    driver === "mysql" ||
    driver === "sqlserver" ||
    driver === "mongodb"
  );
}

/** Whether the server hosts more than one database, so a database picker and
 *  a per-database browse mode make sense. SQLite's file *is* the database, so
 *  it is the only driver without them. */
export function supportsMultipleDatabases(driver: Driver | undefined): boolean {
  return driver !== "sqlite";
}

/** Whether a connection can be tunnelled over SSH. SQLite opens a local file,
 *  so there is nothing to forward. (A `mongodb+srv://` URI is also refused,
 *  but for a different reason — SRV resolution happens client-side against
 *  DNS, not through the tunnel — so that check stays with the URI it is about.) */
export function supportsSshTunnel(driver: Driver | undefined): boolean {
  return driver !== "sqlite";
}

/** Creating a collection. MongoDB's answer to `CREATE TABLE`, and the only
 *  driver with it: the SQL engines create a relation through the structure
 *  editor's DDL instead. */
export function supportsCreateCollection(driver: Driver | undefined): boolean {
  return driver === "mongodb";
}

/** Whether integer columns carry an `UNSIGNED` modifier, which the structure
 *  editor shows as its own column. MySQL-only — no other dialect we speak has
 *  unsigned integer types at all. */
export function supportsUnsignedIntegers(driver: Driver | undefined): boolean {
  return driver === "mysql";
}

/** Reordering columns in the structure editor. MySQL-only: `MODIFY COLUMN …
 *  FIRST|AFTER col` (and the equivalent `ADD COLUMN … FIRST|AFTER col`) is
 *  the only way any of our dialects can reposition a column without a full
 *  rebuild — Postgres has no equivalent ALTER at all, and SQLite's is the
 *  12-step rebuild the structure editor otherwise avoids for a plain reorder.
 *  See `db::ddl::mysql_column_positions` on the backend. */
export function supportsColumnReorder(driver: Driver | undefined): boolean {
  return driver === "mysql";
}

/**
 * Split an SSMS-style `HOST\INSTANCE` server name into its two parts.
 *
 * The twin of `split_instance` in `src-tauri/src/db/mssql/mod.rs`, which is
 * the authoritative one (it also covers the CLI and the MCP connector). This
 * copy exists only so the connection dialog can *show* the user the split
 * before saving, instead of silently normalising behind their back. Keep the
 * two in sync — the Rust side carries the precedence rationale.
 */
export function splitSqlServerName(
  host: string,
  instance: string,
): { host: string; instance: string } {
  const clean = (s: string) => s.trim();
  const [hostPrefix, hostSuffix] = splitOnce(host);
  const raw = clean(instance);
  const [instPrefix, instName] = raw.includes("\\")
    ? splitOnce(raw)
    : ["", raw];
  return {
    host: clean(hostPrefix) || clean(instPrefix),
    instance: clean(instName) || clean(hostSuffix),
  };
}

function splitOnce(value: string): [string, string] {
  const i = value.indexOf("\\");
  return i < 0 ? [value, ""] : [value.slice(0, i), value.slice(i + 1)];
}

/** Canonicalize a free-form driver string; `null` when empty/unrecognized. */
export function normalizeDriver(
  value: string | null | undefined,
): Driver | null {
  if (!value) return null;
  return DRIVER_ALIASES[value.trim().toLowerCase()] ?? null;
}

/**
 * When a connection fails with a wire-protocol error, guess whether the
 * driver is mismatched and return a human hint. Returns `null` when the error
 * doesn't look driver-related.
 */
export function driverMismatchHint(error: string): string | null {
  const e = error.toLowerCase();
  // Postgres driver talking to a non-Postgres server: sqlx_postgres chokes
  // reading the startup/ReadyForQuery, or on the SSLRequest reply.
  if (
    e.includes("postgres protocol error") ||
    e.includes("unexpected response from sslrequest")
  ) {
    return "the server didn't respond as PostgreSQL — if this is a MySQL/MariaDB server, set the driver to MySQL.";
  }
  // MySQL driver talking to a non-MySQL server.
  if (e.includes("mysql protocol error") || e.includes("malformed packet")) {
    return "the server didn't respond as MySQL — if this is a PostgreSQL server, set the driver to PostgreSQL.";
  }
  // SQL Server driver talking to something that isn't speaking TDS. tiberius
  // surfaces this as a protocol/token error rather than a connection failure,
  // which reads as a server-side problem when it's really the wrong driver.
  if (
    e.includes("sql server error") &&
    (e.includes("protocol error") || e.includes("token"))
  ) {
    return "the server didn't respond as SQL Server — check the port (1433 by default), or the instance name if this is a named instance.";
  }
  // A named instance whose SQL Browser never answered. tiberius reports this
  // as a plain lookup failure that names neither the Browser nor UDP 1434, so
  // without this the user has no way to tell it apart from a wrong hostname.
  if (
    e.includes("sql server error") &&
    (e.includes("no response from the browser") ||
      e.includes("could not find") ||
      e.includes("instance"))
  ) {
    return "the SQL Server Browser (UDP 1434) didn't answer — start that service on the host, or enter the instance's static TCP port in the port field, which is used as a fallback.";
  }
  // A backslash left in the host field: `HOST\INSTANCE` is not a hostname, so
  // resolution fails long before TDS is involved.
  if (e.includes("failed to lookup address information") && e.includes("\\")) {
    return "a server name like HOST\\INSTANCE belongs in the instance field, not the host — HuginnDB splits it for you when you leave the field.";
  }
  return null;
}

/**
 * Marker the backend prefixes onto a connection-limit refusal.
 *
 * Errors cross the IPC boundary as plain strings, so this is the only thing we
 * can match on. Must stay in sync with `TOO_MANY_CONNECTIONS_TAG` in
 * `src-tauri/src/error.rs`.
 */
const TOO_MANY_CONNECTIONS_TAG = "too many connections";

/**
 * Whether `error` is the server (or our own pool) refusing a connection
 * because the limit is reached.
 *
 * The distinction matters because it is the one connection failure with a
 * *client-side* remedy — release pools, lower the ceiling, close a database
 * view — and because it must stop the caller from retrying. The schema
 * explorer's cross-database search in particular re-fires its whole fan-out on
 * every keystroke; without this check it hammers a server that is already
 * turning it away.
 */
export function isTooManyConnections(error: unknown): boolean {
  return String(error).toLowerCase().includes(TOO_MANY_CONNECTIONS_TAG);
}

/**
 * Marker the backend prefixes onto a connect that found no password in the
 * keychain. Must stay in sync with `MISSING_PASSWORD_TAG` in
 * `src-tauri/src/error.rs`.
 */
const MISSING_PASSWORD_TAG = "no stored password";

/**
 * Whether `error` is a connect that needs a password the keychain does not
 * hold — the one connect failure the app can finish for the user by asking.
 * What a person's first connect with their own database user always meets.
 */
export function isMissingPassword(error: unknown): boolean {
  return String(error).toLowerCase().includes(MISSING_PASSWORD_TAG);
}

/**
 * Marker the backend uses when the user closes the native save dialog.
 *
 * Must stay in sync with `EXPORT_CANCELLED` in `src-tauri/src/error.rs`.
 */
const EXPORT_CANCELLED_TAG = "export cancelled";

/**
 * Whether `error` is the user cancelling a save dialog rather than an export
 * failing.
 *
 * Six export commands surface this, and every caller has to tell it apart so it
 * can stay silent — a toast saying "export cancelled" after the user cancelled
 * the export is noise. Three call sites matched the substring by hand; this puts
 * the string beside `isTooManyConnections`, the other backend-error marker the
 * frontend has to recognise.
 */
export function isExportCancelled(error: unknown): boolean {
  return String(error).toLowerCase().includes(EXPORT_CANCELLED_TAG);
}

/**
 * Whether `error` is a server refusing a change because another table's
 * foreign key still points at the row.
 *
 * Unlike the markers above this one is not a tag the backend prefixes: it is
 * the drivers' own wording, which `AppError` passes through untouched — MySQL's
 * "a foreign key constraint fails", Postgres's "violates foreign key
 * constraint", SQLite's "FOREIGN KEY constraint failed" and SQL Server's
 * "conflicted with the REFERENCE constraint". Matching on text keeps the
 * backend error type (and what the MCP tools return) unchanged; the price is
 * that a driver rewording it would silently fall back to the generic message,
 * which still carries the server's full text.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("foreign key constraint") ||
    text.includes("reference constraint")
  );
}
