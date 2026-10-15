/**
 * The schema tree as one flat list of rows (ADR #108).
 *
 * Until 1.34 the tree was a tree of components: `ConnectionTreeRow` rendered
 * `SchemaExplorer`, which rendered `MultiDbExplorer` → `DatabaseRoot` →
 * `SingleDbExplorer` → `TableSection` → `TableRow`, each one mounting every
 * child it had. A SQL Server database with ten thousand tables therefore
 * mounted ten thousand `TableRow`s — each with its own Radix context menu and
 * store subscriptions — the moment its section was opened, and the panel
 * froze. `content-visibility: auto` saved the paint and nothing else: React
 * still built every one of them.
 *
 * This function walks the same structure the components used to walk and
 * returns it as rows, so the panel can hand them to one virtualiser and mount
 * only what is near the viewport. It is pure on purpose: every decision the
 * explorers made inline (which schema header to suppress, when a database
 * auto-expands, what the filter folds) is made here, once, where a test can
 * reach it.
 *
 * Alongside the rows it reports what the visible structure **needs** — slices
 * to load, database views to open, sizes to ask for. Those used to be effects
 * inside the explorer components, which only ran while the component was
 * mounted; in a virtualised list "mounted" means "near the viewport", which is
 * the wrong condition for "open the pool of this expanded database". The tree
 * runs the needs in one effect instead (`useSchemaTreeNeeds`).
 */

import { databaseViewId, isServerWide } from "@/lib/connectionLabel";
import { supportsMultipleDatabases } from "@/lib/db/driver";
import { scopeIncludesDatabase, type FilterScope } from "@/lib/schema/filterScope";
import { matchesPatterns } from "@/lib/schema/matchesFilter";
import type { ConnectionMatchSummary } from "@/lib/schema/treeMatches";
import type { DatabaseViewStatus } from "@/stores/session/databaseViews";
import type { ConnectionSchema } from "@/stores/session/schema";
import { tableKey } from "@/stores/session/schema";
import type { ColumnInfo, ConnectionProfile, Driver, TableInfo } from "@/types";

/**
 * Expansion key for a single-DB connection's own database node.
 *
 * Deliberately not `schema:`-prefixed like the nodes below it: those are
 * schemas, this is the database they live in, and a key that could collide
 * with a schema literally named `database` would fold the wrong node.
 */
export const DATABASE_NODE_KEY = "database";

interface RowBase {
  /** Stable across renders and unique across the whole tree — the
   *  virtualiser's item key. */
  key: string;
  /** How many tree guides (the `border-l` hairlines) this row sits inside. */
  guides: number;
}

/** What retrying a failed read means for the row that shows it. */
export type RetryTarget =
  | { kind: "refresh"; connectionId: string }
  | { kind: "reopen-view"; childId: string };

export type FlatRow = RowBase &
  (
    | { kind: "all-hidden" }
    | { kind: "group"; name: string; count: number; collapsed: boolean }
    | { kind: "connection"; profile: ConnectionProfile }
    | { kind: "origin-notice"; profileId: string }
    | {
        kind: "skeleton";
        /** `block`: a whole subtree being read. `columns`: one table's
         *  column list, drawn inside the table's own guide. */
        variant: "block" | "columns";
        rows: number;
        /** Set for `columns`, so the guide takes the active table's tint. */
        tableTabKey?: { connectionId: string; schema: string; table: string };
      }
    | { kind: "load-error"; message: string; retry: RetryTarget }
    | {
        kind: "subset-note";
        count: number;
        total: number;
        /** The subset is this environment's override, not the profile's. */
        local: boolean;
      }
    | { kind: "no-matches" }
    | {
        kind: "no-databases";
        parentId: string;
        driver: Driver | undefined;
        /** The server has none, rather than all of them being hidden. */
        empty: boolean;
        total: number;
      }
    | {
        kind: "database";
        parentId: string;
        dbName: string;
        driver: Driver | undefined;
        expanded: boolean;
        busy: boolean;
        sizeBytes: number | undefined;
        filterActive: boolean;
        /** Matches inside, or `null` when there is nothing to say. */
        matchCount: number | null;
        cold: boolean;
        nameMatch: boolean;
        active: boolean;
        dimmed: boolean;
      }
    | {
        kind: "bound-database";
        connectionId: string;
        dbName: string;
        driver: Driver | undefined;
        open: boolean;
      }
    | {
        kind: "schema";
        connectionId: string;
        schema: string;
        driver: Driver | undefined;
        open: boolean;
        count: number;
        /** SQLite's whole-file size, when known. */
        fileBytes: number | undefined;
        /** This node *is* the bound database (MySQL, MongoDB): it carries
         *  the database menu instead of the schema one. */
        asDatabase: boolean;
        boundDatabase: string;
      }
    | {
        kind: "section";
        connectionId: string;
        section: "tables" | "views";
        sectionKey: string;
        count: number;
        open: boolean;
      }
    | {
        kind: "table";
        connectionId: string;
        table: TableInfo;
        driver: Driver | undefined;
        expanded: boolean;
        /** Whether a column list (or its error) is already there — the
         *  chevron only loads when neither is. */
        hasColumns: boolean;
        hasColumnError: boolean;
      }
    | {
        kind: "column";
        connectionId: string;
        schema: string;
        table: string;
        column: ColumnInfo;
      }
    | {
        kind: "columns-error";
        connectionId: string;
        schema: string;
        table: string;
        message: string;
      }
    | {
        kind: "indexes";
        connectionId: string;
        sectionKey: string;
        open: boolean;
      }
  );

export type FlatRowKind = FlatRow["kind"];

/** Side effects the visible structure asks for. All idempotent. */
export interface TreeNeeds {
  /** Slices with no completed (or running) first read. */
  load: string[];
  /** Expanded databases whose view is not open, opening or failed. */
  openViews: { parentId: string; database: string }[];
  /** Ids to ask `loadDatabaseSizes` for. */
  sizes: string[];
  /** Child ids whose node is effectively expanded — a failure on any other
   *  is forgotten, so the next expand tries afresh. */
  expandedViews: Set<string>;
}

export interface FlatTreeInput {
  /** The connections the panel shows, after the visible-connections subset. */
  buckets: {
    ungrouped: ConnectionProfile[];
    groups: { name: string; items: ConnectionProfile[] }[];
  };
  /** Profiles exist but the subset hides every one of them. */
  allHidden: boolean;
  isGroupCollapsed: (name: string) => boolean;
  /** Whether a connection row is open (live, not folded by the user or the
   *  filter). */
  isConnectionExpanded: (profile: ConnectionProfile) => boolean;
  active: ReadonlySet<string>;
  /** Profiles with a vanished-origin notice to show. */
  vanished: ReadonlySet<string>;
  byConnection: Record<string, ConnectionSchema>;
  /** The committed, parsed needle. Its identity is stable between commits. */
  patterns: string[];
  scope: FilterScope;
  matchCounts: ReadonlyMap<string, ConnectionMatchSummary>;
  /** Resolved visible-databases subset per profile (`null` = all). */
  visibleDatabases: (profile: ConnectionProfile) => string[] | null;
  /** The subset in force is this environment's override. */
  subsetIsLocal: (profileId: string) => boolean;
  activeDatabaseByConnection: Record<string, string | null>;
  views: Record<string, DatabaseViewStatus>;
}

export interface FlatTree {
  rows: FlatRow[];
  needs: TreeNeeds;
}

export interface Grouped {
  bySchema: Record<string, { tables: TableInfo[]; views: TableInfo[] }>;
  schemas: string[];
  /** Every schema, ignoring the filter. */
  allSchemas: string[];
}

/**
 * Tables grouped by schema and kind, filtered, remembered per `(tables,
 * patterns)`.
 *
 * Keyed on the `tables` array because `useSchema` replaces it rather than
 * mutating it (the property `treeMatches`' name cache relies on too), and
 * `patterns` keeps its identity between commits, so a column load anywhere —
 * which rebuilds the whole row list — regroups nothing.
 */
const groupedCache = new WeakMap<
  TableInfo[],
  { patterns: string[]; grouped: Grouped }
>();

export function groupTables(tables: TableInfo[], patterns: string[]): Grouped {
  const hit = groupedCache.get(tables);
  if (hit && hit.patterns === patterns) return hit.grouped;
  const bySchema: Grouped["bySchema"] = {};
  const all = new Set<string>();
  for (const tbl of tables) {
    all.add(tbl.schema);
    if (!matchesPatterns(tbl.name, patterns)) continue;
    bySchema[tbl.schema] ??= { tables: [], views: [] };
    if (tbl.kind === "view") bySchema[tbl.schema].views.push(tbl);
    else bySchema[tbl.schema].tables.push(tbl);
  }
  const grouped = {
    bySchema,
    schemas: Object.keys(bySchema).sort(),
    // `allSchemas` ignores the filter on purpose. It answers "is this
    // connection's top node the database itself?", which is a fact about the
    // server and must not flip while the user types — a needle that happens to
    // match nothing in `public` would otherwise turn a Postgres tree into a
    // MySQL-shaped one mid-search.
    allSchemas: [...all],
  };
  groupedCache.set(tables, { patterns, grouped });
  return grouped;
}

/** `\0`-joined so no identifier can collide with the separator. */
const k = (...parts: string[]) => parts.join("\0");

/** A slice that has never finished a first read (nor failed one). */
function isFirstLoad(cs: ConnectionSchema | undefined): boolean {
  return !cs || (!cs.initialized && !cs.error);
}

export function buildFlatTree(input: FlatTreeInput): FlatTree {
  const rows: FlatRow[] = [];
  const needs: TreeNeeds = {
    load: [],
    openViews: [],
    sizes: [],
    expandedViews: new Set(),
  };
  const { byConnection, patterns } = input;
  const filtering = patterns.length > 0;

  /** The fetch-on-mount guard `useEnsureSchemaLoaded` applies, run for every
   *  slice the tree shows. `!loading` matters: `refresh` mints a new slice
   *  the instant it starts, and asking again would join, not repeat — but
   *  there is no reason to ask at all. */
  const ensureLoaded = (id: string) => {
    const cs = byConnection[id];
    if (!cs || (!cs.initialized && !cs.loading)) needs.load.push(id);
  };

  function emitSingle(
    connectionId: string,
    driver: Driver | undefined,
    boundDatabase: string,
    headerLevel: "root" | "nested",
    guides: number,
  ) {
    ensureLoaded(connectionId);
    // SQLite's whole-file size, shown on the schema node (#153).
    if (driver === "sqlite") needs.sizes.push(connectionId);
    const cs = byConnection[connectionId];
    // The first read, not only the missing slice: `refresh` creates the slice
    // the instant it starts, so `!cs` alone was true for no time at all. A
    // *re*-fetch keeps drawing what it already has.
    if (!cs || isFirstLoad(cs)) {
      rows.push({
        kind: "skeleton",
        variant: "block",
        rows: 4,
        key: k("loading", connectionId),
        guides,
      });
      return;
    }
    if (cs.error) {
      rows.push({
        kind: "load-error",
        message: cs.error,
        retry: { kind: "refresh", connectionId },
        key: k("error", connectionId),
        guides,
      });
    }

    const { bySchema, schemas, allSchemas } = groupTables(cs.tables, patterns);
    // A database node only at `root`: a `nested` subtree is the inside of a
    // database node the multi-DB tree already drew. And only where the driver
    // has databases at all — SQLite's file *is* the database.
    const hasDatabaseEntity =
      headerLevel === "root" &&
      boundDatabase.length > 0 &&
      supportsMultipleDatabases(driver);
    // True on MySQL and MongoDB, whose single reported schema is the
    // database's own name; false on Postgres and SQL Server, where
    // `public`/`dbo` are schemas inside a database. Case-insensitively:
    // MySQL's identifier case depends on `lower_case_table_names`.
    const schemaIsDatabase =
      hasDatabaseEntity &&
      allSchemas.length === 1 &&
      allSchemas[0].toLowerCase() === boundDatabase.toLowerCase();
    const needsOwnDatabaseNode = hasDatabaseEntity && !schemaIsDatabase;
    // Default-open: the stored key records a *collapse*.
    const databaseNodeOpen =
      filtering || !cs.expanded.has(DATABASE_NODE_KEY);

    if (needsOwnDatabaseNode) {
      rows.push({
        kind: "bound-database",
        connectionId,
        dbName: boundDatabase,
        driver,
        open: databaseNodeOpen,
        key: k("bound-db", connectionId),
        guides,
      });
    }
    if (filtering && schemas.length === 0) {
      rows.push({ kind: "no-matches", key: k("none", connectionId), guides });
    }
    if (needsOwnDatabaseNode && !databaseNodeOpen) return;
    const inner = needsOwnDatabaseNode ? guides + 1 : guides;

    // In multi-DB mode, MySQL and SQLite children report every table under a
    // single "schema" named after the database itself; drawing it as a node
    // under the database just expanded looks like the database nested inside
    // itself. Postgres legitimately has several schemas and keeps the header.
    const flattenSingleSchema = headerLevel === "nested" && schemas.length === 1;
    const fileBytes = cs.databaseSizes["main"];

    for (const schema of schemas) {
      const schemaNodeKey = `schema:${schema}`;
      // Force-expanded while filtering, so matches show without a click.
      const schemaOpen =
        flattenSingleSchema || filtering ? true : cs.expanded.has(schemaNodeKey);
      const { tables, views } = bySchema[schema];
      if (!flattenSingleSchema) {
        rows.push({
          kind: "schema",
          connectionId,
          schema,
          driver,
          open: schemaOpen,
          count: tables.length + views.length,
          fileBytes: driver === "sqlite" ? fileBytes : undefined,
          asDatabase: schemaIsDatabase,
          boundDatabase,
          key: k("schema", connectionId, schema),
          guides: inner,
        });
      }
      if (!schemaOpen) continue;
      emitSection(cs, connectionId, driver, "tables", schemaNodeKey, tables, inner);
      if (views.length > 0) {
        emitSection(cs, connectionId, driver, "views", schemaNodeKey, views, inner);
      }
      const indexesKey = `${schemaNodeKey}:indexes`;
      rows.push({
        kind: "indexes",
        connectionId,
        sectionKey: indexesKey,
        open: cs.expanded.has(indexesKey),
        key: k("section", connectionId, indexesKey),
        guides: inner,
      });
    }
  }

  function emitSection(
    cs: ConnectionSchema,
    connectionId: string,
    driver: Driver | undefined,
    section: "tables" | "views",
    schemaNodeKey: string,
    items: TableInfo[],
    guides: number,
  ) {
    const sectionKey = `${schemaNodeKey}:${section}`;
    const open = filtering || cs.expanded.has(sectionKey);
    rows.push({
      kind: "section",
      connectionId,
      section,
      sectionKey,
      count: items.length,
      open,
      key: k("section", connectionId, sectionKey),
      guides,
    });
    if (!open) return;
    for (const table of items) {
      const tk = tableKey(table.schema, table.name);
      const expanded = cs.expanded.has(`table:${tk}`);
      const columns = cs.columns[tk];
      const columnError = cs.columnErrors?.[tk];
      rows.push({
        kind: "table",
        connectionId,
        table,
        driver,
        expanded,
        hasColumns: columns !== undefined,
        hasColumnError: columnError !== undefined,
        key: k("table", connectionId, section, tk),
        guides,
      });
      if (!expanded) continue;
      if (columns) {
        for (const column of columns) {
          rows.push({
            kind: "column",
            connectionId,
            schema: table.schema,
            table: table.name,
            column,
            key: k("column", connectionId, section, tk, column.name),
            guides,
          });
        }
      } else if (columnError !== undefined) {
        rows.push({
          kind: "columns-error",
          connectionId,
          schema: table.schema,
          table: table.name,
          message: columnError,
          key: k("columns-error", connectionId, section, tk),
          guides,
        });
      } else {
        rows.push({
          kind: "skeleton",
          variant: "columns",
          rows: 3,
          tableTabKey: { connectionId, schema: table.schema, table: table.name },
          key: k("columns-loading", connectionId, section, tk),
          guides,
        });
      }
    }
  }

  function emitMulti(profile: ConnectionProfile, guides: number) {
    const parentId = profile.id;
    const driver = profile.driver;
    ensureLoaded(parentId);
    const cs = byConnection[parentId];
    if (!cs || isFirstLoad(cs)) {
      rows.push({
        kind: "skeleton",
        variant: "block",
        rows: 4,
        key: k("loading", parentId),
        guides,
      });
      return;
    }
    const visibleDatabases = input.visibleDatabases(profile);
    const visibleSet =
      visibleDatabases && visibleDatabases.length > 0
        ? new Set(visibleDatabases)
        : null;
    if (visibleSet) {
      // The only sign left that a subset is hiding databases, since the
      // picker moved into the connection's context menu.
      rows.push({
        kind: "subset-note",
        count: visibleSet.size,
        total: cs.databases.length,
        local: input.subsetIsLocal(parentId),
        key: k("subset", parentId),
        guides,
      });
    }
    if (cs.error) {
      rows.push({
        kind: "load-error",
        message: cs.error,
        retry: { kind: "refresh", connectionId: parentId },
        key: k("error", parentId),
        guides,
      });
    }

    // Which database rows to render. With no filter, simply the visible
    // subset. With one, a database earns its row by containing a match, by its
    // own name matching, or by being cold — we have not read it, so hiding it
    // would be claiming it is empty.
    const { scope } = input;
    const summary = input.matchCounts.get(parentId);
    const visible = cs.databases
      .filter((db) => !visibleSet || visibleSet.has(db.name))
      // A database scope on *this* connection hides its siblings; one naming
      // a different connection must not blank out this server's list.
      .filter(
        (db) =>
          scope.kind !== "database" ||
          scope.connectionId !== parentId ||
          scopeIncludesDatabase(scope, parentId, db.name),
      );
    const cold = new Set(summary?.coldDatabases ?? []);
    const nameMatches = new Set(summary?.databaseNameMatches ?? []);
    const dbRows = filtering
      ? visible.flatMap((db) => {
          const count = summary?.byDatabase.get(db.name) ?? 0;
          const isCold = cold.has(db.name);
          const nameMatch = nameMatches.has(db.name);
          if (count === 0 && !isCold && !nameMatch) return [];
          return [{ db, count, cold: isCold, nameMatch }];
        })
      : visible.map((db) => ({ db, count: 0, cold: false, nameMatch: false }));

    if (filtering && dbRows.length === 0) {
      rows.push({ kind: "no-matches", key: k("none", parentId), guides });
    }
    if (!filtering && dbRows.length === 0) {
      rows.push({
        kind: "no-databases",
        parentId,
        driver,
        empty: cs.databases.length === 0,
        total: cs.databases.length,
        key: k("no-dbs", parentId),
        guides,
      });
    }
    // Asked for when database rows exist, not when the connection opens:
    // `loadDatabaseSizes` is guarded, so this is one sweep per server.
    if (dbRows.length > 0) needs.sizes.push(parentId);

    const activeDatabase = input.activeDatabaseByConnection[parentId] ?? null;
    for (const { db, count, cold: isCold, nameMatch } of dbRows) {
      const childId = databaseViewId(parentId, db.name);
      const status = input.views[childId];
      const childOpen = status?.state === "open";
      // Three ways the subtree is open: the chevron; a search, over a
      // database already opened earlier; or the filter found matches inside
      // and opens it Compass-style. A name-only match stays collapsed — the
      // user is presumably picking the database, not browsing inside it.
      const effectiveExpanded =
        cs.expanded.has(`db:${db.name}`) ||
        count > 0 ||
        (filtering && childOpen);
      rows.push({
        kind: "database",
        parentId,
        dbName: db.name,
        driver,
        expanded: effectiveExpanded,
        busy:
          status?.state === "opening" ||
          (byConnection[childId]?.loading ?? false),
        sizeBytes: cs.databaseSizes[db.name],
        filterActive: filtering,
        matchCount: filtering && !isCold ? count : null,
        cold: isCold,
        nameMatch,
        active: activeDatabase === db.name,
        // Only dim siblings when a concrete database is the accent.
        dimmed: activeDatabase != null && activeDatabase !== db.name,
        key: k("db", parentId, db.name),
        guides,
      });
      if (!effectiveExpanded) continue;
      needs.expandedViews.add(childId);
      if (status?.state === "error") {
        rows.push({
          kind: "load-error",
          message: status.message,
          retry: { kind: "reopen-view", childId },
          key: k("error", childId),
          guides: guides + 1,
        });
      } else if (!childOpen) {
        if (status?.state !== "opening") {
          needs.openViews.push({ parentId, database: db.name });
        }
        rows.push({
          kind: "skeleton",
          variant: "block",
          rows: 3,
          key: k("loading", childId),
          guides: guides + 1,
        });
      } else {
        emitSingle(childId, driver, "", "nested", guides + 1);
      }
    }
  }

  function emitConnection(profile: ConnectionProfile, guides: number) {
    rows.push({ kind: "connection", profile, key: k("conn", profile.id), guides });
    // Only a live connection has a subtree to show.
    if (!input.active.has(profile.id) || !input.isConnectionExpanded(profile)) {
      return;
    }
    if (input.vanished.has(profile.id)) {
      rows.push({
        kind: "origin-notice",
        profileId: profile.id,
        key: k("origin", profile.id),
        guides: guides + 1,
      });
    }
    // Multi-DB mode: the profile addresses a whole server rather than one
    // database, so the tree grows a database layer.
    if (isServerWide(profile)) emitMulti(profile, guides + 1);
    else {
      emitSingle(
        profile.id,
        profile.driver,
        profile.database ?? "",
        "root",
        guides + 1,
      );
    }
  }

  if (input.allHidden) rows.push({ kind: "all-hidden", key: "all-hidden", guides: 0 });
  for (const p of input.buckets.ungrouped) emitConnection(p, 0);
  for (const { name, items } of input.buckets.groups) {
    const collapsed = input.isGroupCollapsed(name);
    rows.push({
      kind: "group",
      name,
      count: items.length,
      collapsed,
      key: k("group", name),
      guides: 0,
    });
    if (collapsed) continue;
    // One guide per folder, nested the same way a connection's own subtree
    // nests under it — indentation reads as depth everywhere in this tree.
    for (const p of items) emitConnection(p, 1);
  }
  return { rows, needs };
}
