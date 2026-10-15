/**
 * Single-database explorer: the schema → tables/views/indexes subtree.
 *
 * Used directly for a profile with `database` set, and as the inner subtree of
 * each database node in multi-DB mode (`DatabaseRoot` renders one per database).
 *
 * **The grouping `useMemo` MUST stay above the `if (!cs)` early return.** When a
 * multi-DB filter is cleared several nested explorers unmount while
 * `byConnection` is still settling, and `cs` can flip to `undefined` for a
 * render; a hook below the return would then be skipped on that render and
 * called again on the next — "rendered fewer hooks than expected", which took
 * the whole connection panel to a blank screen (the 1.0.1 bug). The comment at
 * the memo says the same thing; both are load-bearing.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  RefreshCw,
  SquareTerminal,
  Table as TableIcon,
  Table2,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { usePolicyLocker } from "@/lib/policy/access";

import { DatabaseNodeMenu } from "@/components/schema/DatabaseNodeMenu";
import { IndexesSectionHeader } from "@/components/schema/IndexesSectionHeader";
import { SchemaLoadError, TreeSkeleton } from "@/components/schema/TreeStatus";
import { TableSection } from "@/components/schema/SchemaTableSection";
import { DropObjectDialog } from "@/components/schema/dialogs/DropObjectDialog";
import { EmptyTableDialog } from "@/components/schema/dialogs/EmptyTableDialog";
import { RenameObjectDialog } from "@/components/schema/dialogs/RenameObjectDialog";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TreeRow } from "@/components/ui/tree-row";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import {
  supportsDdlEditing,
  supportsDropDatabase,
  supportsMultipleDatabases,
} from "@/lib/db/driver";
import { matchesPatterns } from "@/lib/schema/matchesFilter";
import { useOpenTableKeys } from "@/lib/schema/useOpenTableKeys";
import { QUERY_HERE_LIMIT, selectSnippet } from "@/lib/grid/copyFormats";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { api } from "@/lib/tauri";
import { cn, formatBytes } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useEnsureSchemaLoaded, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import type { TableActions } from "@/components/schema/SchemaTableSection";
import type { TableInfo } from "@/types";

/**
 * Expansion key for the database node.
 *
 * Deliberately not `schema:`-prefixed like the nodes below it: those are
 * schemas, this is the database they live in, and a key that could collide
 * with a schema literally named `database` would fold the wrong node.
 */
const DATABASE_NODE_KEY = "database";

export const SingleDbExplorer = memo(function SingleDbExplorer({
  connectionId,
  headerLevel = "root",
  patterns,
  onTableOpen,
}: {
  connectionId: string;
  /**
   * `nested` skips the schema header when there's exactly one schema to
   * show (see `flattenSingleSchema` below) — used when this subtree lives
   * under a database node and the outer multi-DB explorer already owns
   * the database-level chrome.
   */
  headerLevel?: "root" | "nested";
  /**
   * The committed, parsed needle. Always owned by the tree
   * (`ConnectionsTree.tsx` → `useTreeSearch`), never re-derived here: the
   * string used to come down raw and every level re-split it, which is how a
   * database row could be decided by one needle while its contents were
   * filtered by another for the length of a debounce.
   */
  patterns: string[];
  /**
   * Optional callback fired when the user opens a table (click or context
   * menu). Used by the multi-DB parent to activate this database's scope
   * and collapse the others.
   */
  onTableOpen?: () => void;
}) {
  const { t } = useTranslation();
  const lock = usePolicyLocker(connectionId);
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  const loadColumns = useSchema((s) => s.loadColumns);
  const openTab = useTabs((s) => s.open);

  // Needed by the context menu to compose a driver-correct "Copy SELECT"
  // snippet.
  const driver = useConnectionDriver(connectionId);
  // The profile, for the database this connection is bound to. `find` returns
  // the existing object ref, so the selector is safe (gotcha #1).
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );

  // SQLite's whole-file size, shown on the schema node (#153). Gated on the
  // driver rather than fetched everywhere: see the badge's own comment.
  const isSqlite = driver === "sqlite";
  const loadDatabaseSizes = useSchema((s) => s.loadDatabaseSizes);
  // A primitive out of the record, not a derived object (gotcha #1).
  const sqliteBytes = useSchema((s) =>
    s.byConnection[connectionId]?.databaseSizes["main"],
  );
  useEffect(() => {
    if (isSqlite) void loadDatabaseSizes(connectionId);
  }, [isSqlite, loadDatabaseSizes, connectionId]);
  const fileSize =
    isSqlite && sqliteBytes != null ? formatBytes(sqliteBytes) : null;
  // One O(tabs) pass for every row's "you are here" state, instead of two
  // per row (see the hook's own doc comment).
  const { activeTableKey, openTableKeys } = useOpenTableKeys();

  // Which schema header (if any) currently has its right-click menu open —
  // there's one `ContextMenu` per schema rendered by the `schemas.map(...)`
  // below, so this can't be a `useState` inside that loop (Rules of Hooks);
  // tracking "which name" in the enclosing component instead works the same
  // way since only one context menu can realistically be open at a time.
  const [openSchemaMenu, setOpenSchemaMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<TableInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<TableInfo | null>(null);
  const [emptyTarget, setEmptyTarget] = useState<TableInfo | null>(null);
  const [renameViewTarget, setRenameViewTarget] = useState<TableInfo | null>(
    null,
  );
  const [dropViewTarget, setDropViewTarget] = useState<TableInfo | null>(null);
  /** Which node currently has the database menu open, for the focus ring. */
  const [dbMenuOpen, setDbMenuOpen] = useState(false);

  /**
   * The database this explorer stands for, when it stands for one.
   *
   * Only at `root`: a `nested` explorer is the inside of a database node the
   * multi-DB tree already drew, and drawing a second one would nest a database
   * inside itself. And only where the driver has databases at all — SQLite's
   * file *is* the database, so there is nothing here to create or drop.
   *
   * This is what a single-DB connection was missing. The tree's top node was a
   * *schema* node, which coincides with the database on MySQL and MongoDB and
   * emphatically does not on Postgres (`public`) or SQL Server (`dbo`) — so
   * the two actions that are about the database had been pushed onto the
   * connection's own menu, where nobody looks for them.
   */
  const boundDatabase = headerLevel === "root" ? (profile?.database ?? "") : "";
  const hasDatabaseEntity =
    boundDatabase.length > 0 && supportsMultipleDatabases(driver);

  /**
   * The bound id this database's actions act on.
   *
   * Trivial here and that is the point: multi-DB has to open a synthetic
   * per-database pool to answer the same question, so `DatabaseNodeMenu` asks
   * for a resolver rather than an id and neither caller has to know which kind
   * the other one has.
   */
  const resolveTargetId = useCallback(
    async () => connectionId,
    [connectionId],
  );

  /**
   * Drop the database this connection is bound to, then close the connection.
   *
   * **The disconnect is in a `finally` on purpose.** The backend has to get
   * the pool out of the way before the server will accept the statement (see
   * `drop_database`), so by the time we are here the connection is unusable
   * whether the drop succeeded or not — a pool closed by a refused attempt is
   * just as closed as one closed by a successful one. Leaving it marked active
   * would give the user a connection that fails every later command with
   * something far less legible than the error they just read.
   *
   * The profile itself is left alone. It now points at a database that no
   * longer exists, which the toast says out loud; deleting saved configuration
   * (and a keychain entry) is a bigger decision than the one the user made.
   */
  const dropBoundDatabase = useCallback(async () => {
    if (
      !(await confirmIrreversible(
        t("schema.dropDatabase.confirmBound", { name: boundDatabase }),
      ))
    )
      return;
    try {
      await api.dropDatabase(connectionId, boundDatabase);
      notify.success(
        t("schema.dropDatabase.doneBound", { name: boundDatabase }),
      );
    } catch (e) {
      notify.error(t("schema.dropDatabase.failed", { name: boundDatabase }), {
        description: String(e),
      });
    } finally {
      await useConnections.getState().disconnect(connectionId);
    }
  }, [boundDatabase, connectionId, t]);

  useEnsureSchemaLoaded(connectionId);

  // Group tables by schema, then by kind within each schema. Apply the
  // filter at this stage so empty schemas drop out of the rendered list
  // entirely when nothing matches.
  //
  // This hook MUST stay above the `if (!cs)` early return below. When a
  // multi-DB filter is cleared, several nested explorers unmount while
  // `byConnection` is still settling, and `cs` can flip to `undefined` for
  // a render before the slice reappears. A `useMemo` placed *after* the
  // early return would then be skipped on the `undefined` render and called
  // again on the next one — "rendered fewer hooks than expected", which
  // crashed the whole connection panel to a blank screen (the exact 1.0.1
  // multi-DB blank-panel bug). Keeping it here, reading `cs?.tables`, makes
  // the hook count constant. Memoising also keeps the grouping object
  // reference-stable so the `TableSection` subtree doesn't thrash on every
  // render of the surviving explorers (gotcha #1).
  const filtering = patterns.length > 0;
  const { bySchema, schemas, allSchemas } = useMemo(() => {
    const grouped: Record<string, { tables: TableInfo[]; views: TableInfo[] }> =
      {};
    for (const tbl of cs?.tables ?? []) {
      if (!matchesPatterns(tbl.name, patterns)) continue;
      grouped[tbl.schema] ??= { tables: [], views: [] };
      if (tbl.kind === "view") {
        grouped[tbl.schema].views.push(tbl);
      } else {
        grouped[tbl.schema].tables.push(tbl);
      }
    }
    // `allSchemas` ignores the filter on purpose. It answers "is this
    // connection's top node the database itself?", which is a fact about the
    // server and must not flip while the user types — a needle that happens to
    // match nothing in `public` would otherwise turn a Postgres tree into a
    // MySQL-shaped one mid-search.
    const all = new Set<string>();
    for (const tbl of cs?.tables ?? []) all.add(tbl.schema);
    return {
      bySchema: grouped,
      schemas: Object.keys(grouped).sort(),
      allSchemas: [...all],
    };
  }, [cs?.tables, patterns]);

  // Stable regardless of whether `onTableOpen` is given: it's read at CALL
  // time, not baked into a branch chosen once — so this needs only its own
  // (possibly still-unstable, if the caller doesn't memoize it) identity to
  // settle, rather than recreating itself every render via a ternary.
  const wrappedOpenTab = useCallback<typeof openTab>(
    (config) => {
      onTableOpen?.();
      return openTab(config);
    },
    [onTableOpen, openTab],
  );

  /**
   * `TableSection`/`TableRow` are `memo()`-wrapped (convention #28), which is
   * worthless if their `actions` bundle is a fresh object every render —
   * exactly what this was before the fix, rebuilt unconditionally on every
   * `SingleDbExplorer` render regardless of whether any handler's
   * dependencies had actually changed.
   *
   * Placed here, ABOVE the `if (!cs)` early return below — same load-bearing
   * reason as the `bySchema`/`schemas` memo above: a `useMemo` placed after
   * a conditional return would be skipped whenever `cs` is momentarily
   * `undefined` (the 1.0.1 multi-DB blank-panel bug this file's header
   * comment documents), and this hook is no exception to that rule just
   * because it was added later.
   */
  const tableActions: TableActions = useMemo(
    () => ({
      openTab: wrappedOpenTab,
      onOpenQuery: (tbl) => {
        onTableOpen?.();
        // `resolveTarget: false` is the load-bearing half. In multi-DB mode
        // `connectionId` is already the `<parent>::db::<db>` child this subtree
        // was mounted for, and the default would hand it to `queryTargetFor`,
        // which re-points it at whichever database the *focused tab* happens to
        // be on. "Query this table" means this table's database.
        openQueryTab(connectionId, {
          sql: selectSnippet(driver, tbl.name, QUERY_HERE_LIMIT),
          resolveTarget: false,
        });
      },
      refresh: () => refresh(connectionId),
      onRename: (tbl) => setRenameTarget(tbl),
      onDrop: (tbl) => setDropTarget(tbl),
      onEmpty: (tbl) => {
        // "Don't ask again" (#69): when the user has silenced the prompt,
        // empty straight away; otherwise route through the confirmation
        // dialog. This is a dedicated preference, not the global
        // `confirmDestructive`, so opting out here never weakens other
        // destructive confirmations.
        if (usePreferences.getState().prefs.ui.confirmEmptyTable) {
          setEmptyTarget(tbl);
          return;
        }
        void (async () => {
          try {
            await api.emptyTable(connectionId, tbl.schema, tbl.name);
            notify.success(t("schema.empty.emptied", { name: tbl.name }));
            refresh(connectionId);
          } catch (e) {
            notify.error(String(e));
          }
        })();
      },
      onRenameView: (tbl) => setRenameViewTarget(tbl),
      onDropView: (tbl) => setDropViewTarget(tbl),
      driver,
    }),
    [wrappedOpenTab, onTableOpen, refresh, connectionId, t, driver],
  );

  // The first read, not only the missing slice: `refresh` creates the slice
  // the instant it starts, so `!cs` alone was true for no time at all and an
  // expanded database spent its whole `list_tables` round trip as an empty
  // subtree. A *re*-fetch keeps drawing what it already has.
  if (!cs || (!cs.initialized && !cs.error)) {
    return (
      <TreeSkeleton
        label={t("schema.loading")}
        rows={4}
        className="space-y-1.5 px-3 py-2"
      />
    );
  }

  /**
   * Whether the tree's top schema node *is* the database.
   *
   * True on MySQL and MongoDB, whose single reported schema is the database's
   * own name; false on Postgres and SQL Server, where `public`/`dbo` are
   * schemas inside a database the tree has so far never drawn. The first case
   * merges the two into one node — no extra level, nothing nested under
   * itself — and the second grows the database node that was missing. Same
   * rule as `flattenSingleSchema` below, applied one level up.
   */
  const schemaIsDatabase =
    hasDatabaseEntity &&
    allSchemas.length === 1 &&
    // Case-insensitively: MySQL's identifier case-sensitivity depends on the
    // server's filesystem (`lower_case_table_names`), so the name the profile
    // was saved with and the one `SELECT DATABASE()` reports back can differ in
    // case for the same database. Comparing exactly would grow a second node
    // on those servers and on no others, which is a strange thing to debug.
    allSchemas[0].toLowerCase() === boundDatabase.toLowerCase();
  const needsOwnDatabaseNode = hasDatabaseEntity && !schemaIsDatabase;
  /** Default-open, so growing this node does not fold anyone's tree on
   *  upgrade: the stored key records a *collapse*, not an expansion. */
  const databaseNodeOpen = filtering || !cs.expanded.has(DATABASE_NODE_KEY);
  const canDropDatabase = supportsDropDatabase(driver);

  return (
    <div className="flex flex-col">
      {cs.error && (
        <SchemaLoadError
          message={cs.error}
          onRetry={() => void refresh(connectionId)}
        />
      )}
      <div className="pb-1 text-sm">
        {/* The database node, for the drivers whose schemas are not it. */}
        {needsOwnDatabaseNode && (
          <DatabaseNodeMenu
            dbName={boundDatabase}
            accessId={connectionId}
            driver={driver}
            canDrop={canDropDatabase}
            resolveTargetId={resolveTargetId}
            onRefresh={() => refresh(connectionId)}
            onDrop={dropBoundDatabase}
            onOpenChange={setDbMenuOpen}
          >
            <TreeRow
              menuOpen={dbMenuOpen}
              onClick={() => toggleNode(connectionId, DATABASE_NODE_KEY)}
            >
              {databaseNodeOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs">{boundDatabase}</span>
            </TreeRow>
          </DatabaseNodeMenu>
        )}
        {filtering && schemas.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {/* Indented under the database node when there is one, the same
            way a multi-DB database node indents its own subtree. */}
        <div
          className={cn(
            needsOwnDatabaseNode && "ml-3 border-l border-border/35 pl-0.5",
            needsOwnDatabaseNode && !databaseNodeOpen && "hidden",
          )}
        >
        {(() => {
          // In multi-DB mode, MySQL and SQLite synthetic children report
          // every table under a single "schema" name that coincides with
          // the database name itself (`SELECT DATABASE()` on MySQL,
          // hard-coded "main" on SQLite). Re-rendering that as a Database
          // node under the database we just expanded looks like the
          // database is nested inside itself. When this nested explorer
          // sees exactly one schema, drop the redundant header and pin
          // the sections directly under the parent DB node. Postgres
          // multi-DB legitimately has multiple user schemas
          // (`public`, custom namespaces) — there we keep the per-schema
          // header so they remain distinguishable.
          const flattenSingleSchema =
            headerLevel === "nested" && schemas.length === 1;
          return schemas.map((schema) => {
            const schemaNodeKey = `schema:${schema}`;
            // Force-expand a schema when the filter is active so matching
            // tables under it are visible without the user having to click.
            const schemaOpen =
              flattenSingleSchema || filtering
                ? true
                : cs.expanded.has(schemaNodeKey);
            const { tables, views } = bySchema[schema];

            return (
              <div key={schema}>
                {/* Schema / database header — suppressed when we're a
                    nested explorer with a single schema to avoid a
                    duplicate database node (see comment above). Its
                    right-click menu is where table/view creation belongs
                    ([[schema.context.newTable]] used to live on an existing
                    table's own menu, which meant a database with zero
                    tables had no way to grow one from the tree). */}
                {!flattenSingleSchema &&
                  (() => {
                    // One row, two possible menus. When this node *is* the
                    // database (MySQL, MongoDB, whose single reported schema
                    // is the database's own name) it carries the database
                    // menu, so "New collection" and "Drop database" are found
                    // on the thing they act on instead of on the connection
                    // above it. When it is a schema inside a database
                    // (Postgres, SQL Server) the database has its own node
                    // further up and this keeps the schema menu it always had.
                    const header = (
                      <TreeRow
                        menuOpen={openSchemaMenu === schema}
                        onClick={() => toggleNode(connectionId, schemaNodeKey)}
                      >
                        {schemaOpen ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <Database className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="truncate text-xs">{schema}</span>
                        <span className="ml-auto text-3xs tabular-nums text-muted-foreground">
                          {/* The file's size, ahead of the object count.
                              SQLite only: this connection *is* one file, so
                              the number is the one the OS file browser shows
                              and the node it belongs on is the only node the
                              driver has. Everywhere else this component
                              renders a schema inside a larger server, where
                              `get_database_sizes` answers for the whole server
                              and has nothing to say about one schema —
                              per-schema sizing on Postgres is a different
                              query (`SUM(pg_total_relation_size)` grouped by
                              `nspname`) and is out of scope here. */}
                          {fileSize !== null && `${fileSize} · `}
                          {tables.length + views.length}
                        </span>
                      </TreeRow>
                    );
                    return schemaIsDatabase ? (
                      <DatabaseNodeMenu
                        dbName={boundDatabase}
                        accessId={connectionId}
                        driver={driver}
                        schema={schema}
                        canDrop={canDropDatabase}
                        resolveTargetId={resolveTargetId}
                        onRefresh={() => refresh(connectionId)}
                        onDrop={dropBoundDatabase}
                        onOpenChange={(open) =>
                          setOpenSchemaMenu(open ? schema : null)
                        }
                      >
                        {header}
                      </DatabaseNodeMenu>
                    ) : (
                      <ContextMenu
                        onOpenChange={(open) =>
                          setOpenSchemaMenu(open ? schema : null)
                        }
                      >
                        <ContextMenuTrigger asChild>
                          {header}
                        </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuAction
                          icon={RefreshCw}
                          label={t("schema.refresh")}
                          onSelect={() => refresh(connectionId)}
                        />
                        <ContextMenuSeparator />
                        <ContextMenuAction
                          icon={Table2}
                          label={t("schema.context.newTable")}
                          locked={lock("ddl")}
                          onSelect={() =>
                            wrappedOpenTab({
                              kind: "structure",
                              structureMode: "new",
                              title: t("schema.context.newTable"),
                              connectionId,
                              schema,
                            })
                          }
                        />
                        {supportsDdlEditing(driver) && (
                          <ContextMenuAction
                            icon={Eye}
                            label={t("schema.context.newView")}
                            locked={lock("ddl") ?? lock("freeSql")}
                            onSelect={() =>
                              wrappedOpenTab({
                                kind: "view",
                                viewMode: "new",
                                title: t("schema.context.newView"),
                                connectionId,
                                schema,
                              })
                            }
                          />
                        )}
                        <ContextMenuAction
                          icon={SquareTerminal}
                          label={t("schema.context.newQueryHere")}
                          locked={lock("freeSql")}
                          onSelect={() => openQueryTab(connectionId)}
                        />
                      </ContextMenuContent>
                      </ContextMenu>
                    );
                  })()}

                {schemaOpen && (
                  <div>
                    {/* Tables section */}
                    <TableSection
                      label={t("schema.sectionTables")}
                      icon={
                        <TableIcon className="h-3 w-3 text-muted-foreground/70" />
                      }
                      items={tables}
                      sectionKey={`${schemaNodeKey}:tables`}
                      connectionId={connectionId}
                      cs={cs}
                      toggleNode={toggleNode}
                      loadColumns={loadColumns}
                      actions={tableActions}
                      forceOpen={filtering}
                      activeTableKey={activeTableKey}
                      openTableKeys={openTableKeys}
                    />

                    {/* Views section */}
                    {views.length > 0 && (
                      <TableSection
                        label={t("schema.sectionViews")}
                        icon={
                          <Eye className="h-3 w-3 text-muted-foreground/70" />
                        }
                        items={views}
                        sectionKey={`${schemaNodeKey}:views`}
                        connectionId={connectionId}
                        cs={cs}
                        toggleNode={toggleNode}
                        loadColumns={loadColumns}
                        actions={tableActions}
                        forceOpen={filtering}
                        activeTableKey={activeTableKey}
                        openTableKeys={openTableKeys}
                      />
                    )}

                    {/* Indexes section header — content is per-table */}
                    <IndexesSectionHeader
                      label={t("schema.sectionIndexes")}
                      sectionKey={`${schemaNodeKey}:indexes`}
                      connectionId={connectionId}
                      expanded={cs.expanded}
                      toggleNode={toggleNode}
                    />
                  </div>
                )}
              </div>
            );
          });
        })()}
        </div>
      </div>

      {renameTarget && (
        <RenameObjectDialog
          kind="table"
          connectionId={connectionId}
          target={renameTarget}
          driver={driver}
          databases={cs.databases.map((d) => d.name)}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            // `refreshTree`: a MongoDB rename can move the collection into
            // another database, whose slice is a sibling of this one.
            void useSchema.getState().refreshTree(connectionId);
          }}
        />
      )}
      {dropTarget && (
        <DropObjectDialog
          kind="table"
          connectionId={connectionId}
          target={dropTarget}
          onClose={() => setDropTarget(null)}
          onDone={() => {
            setDropTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {emptyTarget && (
        <EmptyTableDialog
          connectionId={connectionId}
          target={emptyTarget}
          onClose={() => setEmptyTarget(null)}
          onDone={() => {
            setEmptyTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {renameViewTarget && (
        <RenameObjectDialog
          kind="view"
          connectionId={connectionId}
          target={renameViewTarget}
          onClose={() => setRenameViewTarget(null)}
          onDone={() => {
            setRenameViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {dropViewTarget && (
        <DropObjectDialog
          kind="view"
          connectionId={connectionId}
          target={dropViewTarget}
          onClose={() => setDropViewTarget(null)}
          onDone={() => {
            setDropViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
    </div>
  );
});
