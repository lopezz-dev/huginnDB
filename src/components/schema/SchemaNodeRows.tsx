/**
 * The two rows above a single database's sections: the database itself (for
 * the drivers whose schemas are not the database) and a schema header.
 *
 * Both were drawn inline by `SingleDbExplorer`, which owned their menus'
 * open-state and the "drop the bound database" flow. The tree is one
 * virtualised list now (ADR #108), so each is a row of its own and keeps only
 * its own menu state.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  RefreshCw,
  SquareTerminal,
  Table2,
} from "lucide-react";

import { DatabaseNodeMenu } from "@/components/schema/DatabaseNodeMenu";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TreeRow } from "@/components/ui/tree-row";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { supportsDdlEditing, supportsDropDatabase } from "@/lib/db/driver";
import { notify } from "@/lib/notify";
import { usePolicyLocker } from "@/lib/policy/access";
import { DATABASE_NODE_KEY, type FlatRow } from "@/lib/schema/flatTree";
import { tableActionsFor } from "@/lib/schema/tableActions";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { api } from "@/lib/tauri";
import { formatBytes } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import i18n from "@/lib/i18n";

/**
 * Drop the database a connection is bound to, then close the connection.
 *
 * **The disconnect is in a `finally` on purpose.** The backend has to get the
 * pool out of the way before the server will accept the statement (see
 * `drop_database`), so by the time we are here the connection is unusable
 * whether the drop succeeded or not. Leaving it marked active would give the
 * user a connection that fails every later command with something far less
 * legible than the error they just read.
 *
 * The profile itself is left alone. It now points at a database that no
 * longer exists, which the toast says out loud; deleting saved configuration
 * (and a keychain entry) is a bigger decision than the one the user made.
 */
async function dropBoundDatabase(connectionId: string, dbName: string) {
  const t = i18n.t.bind(i18n);
  if (!(await confirmIrreversible(t("schema.dropDatabase.confirmBound", { name: dbName }))))
    return;
  try {
    await api.dropDatabase(connectionId, dbName);
    notify.success(t("schema.dropDatabase.doneBound", { name: dbName }));
  } catch (e) {
    notify.error(t("schema.dropDatabase.failed", { name: dbName }), {
      description: String(e),
    });
  } finally {
    await useConnections.getState().disconnect(connectionId);
  }
}

/** The bound id a single-DB node's actions act on. Trivial here and that is
 *  the point: multi-DB has to open a per-database pool to answer the same
 *  question, so `DatabaseNodeMenu` asks for a resolver rather than an id. */
const resolveSelf = (connectionId: string) => async () => connectionId;

/**
 * The database node a single-DB connection grows when its schemas are not the
 * database (Postgres' `public`, SQL Server's `dbo`) — what keeps "Drop
 * database" and friends off the connection's own menu, where nobody looks for
 * them.
 */
export function BoundDatabaseRow({
  row,
}: {
  row: Extract<FlatRow, { kind: "bound-database" }>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { connectionId, dbName, driver } = row;
  return (
    <DatabaseNodeMenu
      dbName={dbName}
      accessId={connectionId}
      driver={driver}
      canDrop={supportsDropDatabase(driver)}
      resolveTargetId={resolveSelf(connectionId)}
      onRefresh={() => useSchema.getState().refresh(connectionId)}
      onDrop={() => dropBoundDatabase(connectionId, dbName)}
      onOpenChange={setMenuOpen}
    >
      <TreeRow
        menuOpen={menuOpen}
        onClick={() =>
          useSchema.getState().toggleNode(connectionId, DATABASE_NODE_KEY)
        }
      >
        {row.open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs">{dbName}</span>
      </TreeRow>
    </DatabaseNodeMenu>
  );
}

/**
 * A schema header. Its right-click menu is where table/view creation belongs
 * — a database with zero tables has no other row to grow one from.
 *
 * One row, two possible menus: when this node *is* the database (MySQL,
 * MongoDB) it carries the database menu, so "New collection" and "Drop
 * database" are found on the thing they act on; when it is a schema inside a
 * database (Postgres, SQL Server) the database has its own node above and this
 * keeps the schema menu.
 */
export function SchemaHeaderRow({
  row,
}: {
  row: Extract<FlatRow, { kind: "schema" }>;
}) {
  const { t } = useTranslation();
  const { connectionId, schema, driver } = row;
  const lock = usePolicyLocker(connectionId);
  const [menuOpen, setMenuOpen] = useState(false);
  const refresh = () => useSchema.getState().refresh(connectionId);
  const openTab = tableActionsFor(connectionId, driver).openTab;
  const fileSize = row.fileBytes != null ? formatBytes(row.fileBytes) : null;

  const header = (
    <TreeRow
      menuOpen={menuOpen}
      onClick={() =>
        useSchema.getState().toggleNode(connectionId, `schema:${schema}`)
      }
    >
      {row.open ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
      <Database className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate text-xs">{schema}</span>
      <span className="ml-auto text-3xs tabular-nums text-muted-foreground">
        {/* The file's size, ahead of the object count. SQLite only: this
            connection *is* one file, so the number is the one the OS file
            browser shows. Elsewhere `get_database_sizes` answers for a whole
            database and has nothing to say about one schema. */}
        {fileSize !== null && `${fileSize} · `}
        {row.count}
      </span>
    </TreeRow>
  );

  if (row.asDatabase) {
    return (
      <DatabaseNodeMenu
        dbName={row.boundDatabase}
        accessId={connectionId}
        driver={driver}
        schema={schema}
        canDrop={supportsDropDatabase(driver)}
        resolveTargetId={resolveSelf(connectionId)}
        onRefresh={refresh}
        onDrop={() => dropBoundDatabase(connectionId, row.boundDatabase)}
        onOpenChange={setMenuOpen}
      >
        {header}
      </DatabaseNodeMenu>
    );
  }

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuAction
          icon={RefreshCw}
          label={t("schema.refresh")}
          onSelect={() => void refresh()}
        />
        <ContextMenuSeparator />
        <ContextMenuAction
          icon={Table2}
          label={t("schema.context.newTable")}
          locked={lock("ddl")}
          onSelect={() =>
            openTab({
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
              openTab({
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
}
