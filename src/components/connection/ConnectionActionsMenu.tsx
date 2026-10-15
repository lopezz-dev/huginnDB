/**
 * Right-click menu for a connection, wrapping whatever row represents it.
 *
 * These actions used to be an icon strip in the explorer's header. Once the
 * explorer became a subtree of the connections tree (#107) that strip repeated
 * under every expanded connection — five icons and a filter box each — so it
 * moved here, where a connection's actions belong: on the connection.
 *
 * It used to live inside `SchemaExplorer.tsx` "because everything it drives is
 * already there" — which was true only while the dialogs and the
 * export/import/security helpers were private to that file. They are now their
 * own modules, so the menu lives with the tree that renders it (its only
 * consumer, `ConnectionsTree`, was reaching across into `schema/` for it).
 *
 * What's offered is driver- and mode-aware, and the distinctions are the same
 * ones the two explorers already encoded: creating a database is every driver
 * but SQLite (MongoDB asks for a first collection alongside the name, since it
 * has no empty database), whole-database `.sql` export/import needs exactly
 * one target database, and the visible-databases subset only means anything
 * when there are several.
 *
 * **What is deliberately not here: anything that acts on one database.**
 * Creating a collection in it and dropping it both lived here for a while, for
 * want of anywhere better — single-DB mode had no database node to hang them
 * on. It has one now (`SingleDbExplorer`), so they are on it, and this menu is
 * back to being about the connection: creating a database is an action *on the
 * server*, dropping one is an action on a database.
 *
 * Connect/disconnect are delegated: the tree owns what those do to focus and to
 * its expansion overrides, and duplicating that here would let the two drift.
 */

import { cloneElement, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppWindow,
  DatabaseZap,
  Download,
  ListFilter,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { notify } from "@/lib/notify";

import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CreateDatabaseDialog } from "@/components/schema/dialogs/CreateDatabaseDialog";
import { DatabaseVisibilityDialog } from "@/components/schema/dialogs/DatabaseVisibilityDialog";
import {
  ExportDatabaseDialog,
  type ExportScope,
} from "@/components/schema/dialogs/ExportDatabaseDialog";
import {
  ImportSqlDialog,
  type ImportScope,
} from "@/components/schema/dialogs/ImportSqlDialog";
import { isServerWide } from "@/lib/connectionLabel";
import { supportsCreateDatabase, supportsSqlDump } from "@/lib/db/driver";
import { profileIntent } from "@/lib/cli/startupArgs";
import { usePolicyLocker } from "@/lib/policy/access";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTreeSearch } from "@/stores/session/treeSearch";

export function ConnectionActionsMenu({
  connectionId,
  onConnect,
  onDisconnect,
  children,
}: {
  connectionId: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** A single element (Radix `asChild` requirement) — cloned below to carry
   *  the "menu is open on me" ring while right-clicked. */
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isActive = useConnections((s) => s.active.has(connectionId));
  const lock = usePolicyLocker(connectionId);
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const refreshTree = useSchema((s) => s.refreshTree);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importStatements, setImportStatements] = useState<string[] | null>(
    null,
  );
  /**
   * Open this connection in its own window, already connected.
   *
   * Zero backend: `open_new_window` has always taken an optional
   * `StartupArgs` intent, stores it per window label, and the secondary window
   * drains it on boot via `take_window_startup_intent` (`useCliIntents`). This
   * just supplies the intent the CLI path already supplies.
   *
   * **No second pool is opened.** `AppState` is per *process* and shared
   * across windows, and `connect_inner`'s early return is idempotent — its own
   * comment names this exact scenario — so connecting to a profile the main
   * window already has open reuses that pool: no second endpoint reservation,
   * no second SSH tunnel. Each window shows as active only what it opened
   * itself, because the frontend deliberately does not listen to
   * `huginndb://connection-opened` (see `connection-sync-bridge.ts`, issue
   * #50). Two inherited consequences, neither introduced here: a `disconnect`
   * in any window closes the pool for all of them, and closing the secondary
   * leaves a pool it alone opened alive until the app exits — the CLI path
   * behaves the same way.
   *
   * Nothing here touches `tab_state.json`: every writer sits behind
   * `isMainWindow()` (ADR #8), including the non-obvious path where
   * `connectToProfile` reaches `useEnvironments.switchTo`. Note that if the
   * frontend ever did start listening to `-connection-opened`, the main
   * window would adopt this connection and its next `persistLaunchState`
   * would write it into the environment's launch state — at which point this
   * gesture would begin altering what the app reopens at boot.
   */
  const openInNewWindow = () => {
    void api.openNewWindow(profileIntent(connectionId)).catch((e) => {
      notify.error(String(e));
    });
  };

  /**
   * Open the connection manager already focused on this profile.
   *
   * The only route to a connection's own settings used to be File → Manage
   * connections, and then finding the row again in a list that is routinely
   * fifty long — from a tree node that already knows exactly which profile is
   * meant. `openManage` has taken an id since the command palette needed one,
   * so this is a second caller for an existing capability rather than a new
   * surface: `FileMenu` stays the single mount point for the dialog, and a
   * profile deleted between this click and that render falls back to a new
   * draft on its own.
   */
  const editConnection = () =>
    useConnectionDialog.getState().openManage(connectionId);

  // Right-clicking to open the menu doesn't keep the row hovered (the
  // pointer moves onto the menu itself), so without this the row you
  // targeted looks indistinguishable from any other once the menu is open.
  // Mirrors the row's own `focus-visible:ring-ring` treatment, just driven
  // by the menu's open state instead of keyboard focus.
  const [menuOpen, setMenuOpen] = useState(false);

  const driver = profile?.driver;
  const isMultiDb = isServerWide(profile);
  const canCreateDatabase = supportsCreateDatabase(driver);
  // Whole-database `.sql` export/import used to require single-DB mode
  // (nothing to pick a database *from* otherwise); the export/import
  // dialogs now handle multi-DB themselves — a database picker for export,
  // a target-database dropdown for import — so this is SQL-only, not also
  // single-DB-only.
  const canDumpSql = supportsSqlDump(driver);
  const databases = cs?.databases ?? [];
  const exportScope: ExportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId, databaseName: profile?.database || connectionId };
  const importScope: ImportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId };

  return (
    <>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          {cloneElement(children, {
            className: cn(
              children.props.className,
              menuOpen && "ring-1 ring-inset ring-ring",
            ),
          })}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isActive ? (
            <>
              <ContextMenuAction
                icon={RefreshCw}
                label={t("schema.refresh")}
                // `refreshTree`, not `refresh`: on a multi-DB connection the
                // tables under this row live in the per-database child slices,
                // and refreshing only the profile id left every one of them
                // stale (see the store's note on `refreshTree`).
                onSelect={() => void refreshTree(connectionId)}
              />
              {canCreateDatabase && (
                <ContextMenuAction
                  icon={DatabaseZap}
                  label={t("schema.createDatabase.title")}
                  locked={lock("ddl")}
                  onSelect={() => setCreateDbOpen(true)}
                />
              )}
              {isMultiDb && (
                <ContextMenuAction
                  icon={ListFilter}
                  // Nothing to choose from until the database list has loaded.
                  disabled={databases.length === 0}
                  label={t("schema.selectDatabases.title")}
                  onSelect={() => setDbPickerOpen(true)}
                />
              )}
              {/* Narrowing the tree's search to this connection. Deliberately
                  next to "Databases to show": both answer "I only care about
                  this much of the server right now", one for the search and one
                  for the tree. The difference is that this one is a modifier on
                  a needle and evaporates with it, while that one is a persisted
                  per-environment filter. */}
              <ContextMenuAction
                icon={Search}
                label={t("connectionsTree.filter.scopeHere")}
                onSelect={() => {
                  const search = useTreeSearch.getState();
                  search.narrowTo({ kind: "connection", connectionId });
                  search.requestFocus();
                }}
              />
              {canDumpSql && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuAction
                    icon={Download}
                    label={t("schema.exportDatabase.title")}
                    locked={lock("export")}
                    onSelect={() => setExportOpen(true)}
                  />
                  <ContextMenuAction
                    icon={Upload}
                    label={t("schema.importSql.title")}
                    // A .sql file runs as a batch of free statements.
                    locked={lock("freeSql")}
                    onSelect={() =>
                      void pickAndSplitSqlFile(t).then((statements) => {
                        if (statements) setImportStatements(statements);
                      })
                    }
                  />
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={ShieldCheck}
                label={t("security.title")}
                locked={lock("monitor")}
                onSelect={() => openSecurityTab(connectionId, t("security.title"))}
              />
              {/* Tail group: where this connection *lives*, rather than what
                  it contains. "Open in new window" and "Disconnect" are both
                  lifecycle/placement actions, so they share one separator
                  instead of earning a third. */}
              <ContextMenuSeparator />
              {/* Grouped with the placement actions rather than with the
                  content ones above: this edits the connection *itself*, not
                  anything inside it. */}
              <ContextMenuAction
                icon={Pencil}
                label={t("connectionsTree.editConnection")}
                onSelect={editConnection}
              />
              <ContextMenuAction
                icon={AppWindow}
                label={t("connectionsTree.openInNewWindow")}
                onSelect={openInNewWindow}
              />
              {onDisconnect && (
                <ContextMenuAction
                  icon={PlugZap}
                  label={t("statusBar.disconnect")}
                  onSelect={onDisconnect}
                />
              )}
            </>
          ) : (
            <>
              {onConnect && (
                <ContextMenuAction
                  icon={Plug}
                  label={t("connectionsTree.connect")}
                  // A connection the role may not use, or any while the
                  // policy is broken, refuses to open (`guard::endpoint`).
                  locked={lock("connect")}
                  onSelect={onConnect}
                />
              )}
              {/* Offered while disconnected too, and this is the primary case:
                  "open this server in its own window without disturbing the one
                  I have". Until now that branch offered only "Connect", which
                  is exactly the gap. */}
              <ContextMenuAction
                icon={AppWindow}
                label={t("connectionsTree.openInNewWindow")}
                onSelect={openInNewWindow}
              />
              {/* Offered while disconnected too, and this branch is where it
                  is needed most: a connection that will not open is exactly
                  the one whose host, port or username you want to correct. */}
              <ContextMenuAction
                icon={Pencil}
                label={t("connectionsTree.editConnection")}
                onSelect={editConnection}
              />
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={connectionId}
          onClose={() => setCreateDbOpen(false)}
          onDone={(name) => {
            setCreateDbOpen(false);
            refresh(connectionId);
            // Always toast, unlike the old multi-DB toolbar button, which relied
            // on the new node appearing in the tree as its own confirmation.
            // Driven from a connection row, the subtree may well be collapsed.
            notify.success(t("schema.createDatabase.createdSingleDb", { name }));
          }}
        />
      )}
      {dbPickerOpen && (
        <DatabaseVisibilityDialog
          profileId={connectionId}
          databases={databases.map((db) => db.name)}
          onClose={() => setDbPickerOpen(false)}
        />
      )}
      {exportOpen && (
        <ExportDatabaseDialog scope={exportScope} onClose={() => setExportOpen(false)} />
      )}
      {importStatements && (
        <ImportSqlDialog
          scope={importScope}
          statements={importStatements}
          onClose={() => setImportStatements(null)}
          onImported={(id) => {
            setImportStatements(null);
            refresh(id);
          }}
        />
      )}
    </>
  );
}
