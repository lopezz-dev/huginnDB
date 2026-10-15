/**
 * One database row of a multi-DB connection — the row only, never its subtree.
 *
 * This was `DatabaseRoot` inside `MultiDbExplorer`, which rendered the row and
 * the nested `SingleDbExplorer` under it and owned the per-database pool's
 * state (`childId`, `opening`, `error`). The tree is one virtualised list now
 * (ADR #108): the subtree is rows of its own, and the pool's state lives in
 * `useDatabaseViews` so it survives this row scrolling out of the window.
 * What is left here is the row's chrome and the menu's actions.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  DatabaseZap,
  ListFilter,
} from "lucide-react";

import { PolicyLockHint } from "@/components/common/PolicyLock";
import { DatabaseNodeMenu } from "@/components/schema/DatabaseNodeMenu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { TreeRow } from "@/components/ui/tree-row";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { databaseViewId } from "@/lib/connectionLabel";
import { supportsCreateDatabase, supportsDropDatabase } from "@/lib/db/driver";
import { notify } from "@/lib/notify";
import { usePolicyLock } from "@/lib/policy/access";
import { api } from "@/lib/tauri";
import { cn, formatBytes } from "@/lib/utils";
import { useSchemaTreeDialogs } from "@/stores/dialogs/schemaTreeDialogs";
import { useDatabaseViews } from "@/stores/session/databaseViews";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useTreeSearch } from "@/stores/session/treeSearch";
import type { FlatRow } from "@/lib/schema/flatTree";

type DatabaseRowData = Extract<FlatRow, { kind: "database" }>;

export function DatabaseRow({ row }: { row: DatabaseRowData }) {
  const { t } = useTranslation();
  const { parentId, dbName, driver } = row;
  // See `ConnectionActionsMenu`'s matching state: the row that was
  // right-clicked stops looking hovered as soon as the pointer moves onto the
  // open menu, so this drives the same ring explicitly instead.
  const [menuOpen, setMenuOpen] = useState(false);
  const sizeBadge = row.sizeBytes != null ? formatBytes(row.sizeBytes) : null;

  // Every per-database action resolves the child id through here, opening the
  // pool the first time any of them needs it — on a node that may well be
  // collapsed and never opened (see `useDatabaseViews.ensure`).
  const resolveChildId = () =>
    useDatabaseViews.getState().ensure(parentId, dbName);

  /**
   * Refresh what this node actually shows: the parent for the database list
   * itself, the child for this database's tables. Refreshing only the parent —
   * what this menu once did — re-fetched a list nobody renders and left the
   * visible subtree as it was.
   */
  const refreshThisDatabase = async () => {
    const id = await resolveChildId();
    const schema = useSchema.getState();
    await Promise.all([
      schema.refresh(parentId),
      id ? schema.refresh(id) : Promise.resolve(),
    ]);
  };

  // `confirmIrreversible`, not `confirmDestructive`: a user who turned
  // confirmations off for row deletes must not drop a whole database on a
  // single menu click. On success the child's frontend state goes (its tabs,
  // its slice, the tree's record of its pool) and the parent refreshes so the
  // row disappears; the backend already closed the child pool.
  const dropThisDatabase = async () => {
    if (
      !(await confirmIrreversible(
        t("schema.dropDatabase.confirm", { name: dbName }),
      ))
    )
      return;
    try {
      await api.dropDatabase(parentId, dbName);
      const droppedId = databaseViewId(parentId, dbName);
      useTabs.getState().closeForConnection(droppedId);
      useSchema.getState().drop(droppedId);
      useDatabaseViews.getState().forget(droppedId);
      await useSchema.getState().refresh(parentId);
      notify.success(t("schema.dropDatabase.done", { name: dbName }));
    } catch (e) {
      notify.error(t("schema.dropDatabase.failed", { name: dbName }), {
        description: String(e),
      });
    }
  };

  const onScopeHere = () => {
    const search = useTreeSearch.getState();
    search.narrowTo({ kind: "database", connectionId: parentId, database: dbName });
    search.requestFocus();
  };

  return (
    <DatabaseNodeMenu
      dbName={dbName}
      accessId={databaseViewId(parentId, dbName)}
      driver={driver}
      canDrop={supportsDropDatabase(driver)}
      resolveTargetId={resolveChildId}
      onRefresh={refreshThisDatabase}
      onScopeHere={onScopeHere}
      onDrop={dropThisDatabase}
      onOpenChange={setMenuOpen}
    >
      <TreeRow
        menuOpen={menuOpen}
        className={cn(
          "transition-opacity",
          row.dimmed && "opacity-50 hover:opacity-100",
        )}
        // Expanding only expands: narrowing the search to this database is a
        // separate, deliberate gesture ("Search here only", in the menu).
        onClick={() =>
          useSchema.getState().toggleNode(parentId, `db:${dbName}`)
        }
      >
        {row.expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {/* Always reserve the dot's width so names don't shift when a DB
            becomes the active scope; only the active one is coloured. */}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            row.active ? "bg-brand" : "bg-transparent",
          )}
        />
        <Database
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            row.active ? "text-brand" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "truncate text-xs",
            row.nameMatch && "font-medium text-foreground",
          )}
        >
          {dbName}
        </span>
        {/* One `ml-auto` slot, two possible occupants, and the filter wins:
            the match count answers the question the user just asked, the size
            is ambient, and both would wrap the row at the usual dock width. */}
        {!row.filterActive && row.busy && (
          <Spinner size="xs" className="ml-auto shrink-0 text-muted-foreground" />
        )}
        {!row.filterActive && !row.busy && sizeBadge !== null && (
          <span className="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-muted-foreground">
            {sizeBadge}
          </span>
        )}
        {row.filterActive && (
          // `SimpleTooltip` renders its child untouched when the label is
          // empty, so only a cold database's "—" carries one.
          <SimpleTooltip
            label={row.cold ? t("connectionsTree.filter.counting") : null}
          >
            <span
              className={cn(
                "ml-auto shrink-0 rounded-sm px-1 text-3xs leading-4 tabular-nums",
                // A cold database says "—", never "0": nobody has read it, and
                // a provisional zero is what makes a search look failed.
                row.matchCount === null
                  ? "bg-muted text-muted-foreground/60"
                  : row.matchCount > 0
                    ? "bg-brand/15 text-brand"
                    : "bg-muted text-muted-foreground/60",
              )}
            >
              {row.matchCount ?? "—"}
            </span>
          </SimpleTooltip>
        )}
      </TreeRow>
    </DatabaseNodeMenu>
  );
}

/**
 * A multi-DB connection with no database rows to draw, saying which of the two
 * reasons it is.
 *
 * Until 1.23.1 this rendered literally nothing, which reads as a connection
 * that failed rather than a server that is empty, and left the only way to
 * create the first database somewhere the user had to already know about. A
 * server with none gets "New database"; one whose visible subset hides them
 * all gets the picker — offering "new database" there would answer a question
 * the user did not ask.
 */
export function NoDatabasesRow({
  row,
}: {
  row: Extract<FlatRow, { kind: "no-databases" }>;
}) {
  const { t } = useTranslation();
  const createDbLock = usePolicyLock(row.parentId, "ddl");
  const show = useSchemaTreeDialogs((s) => s.show);
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="text-xs text-muted-foreground">
        {t(row.empty ? "schema.noDatabases.empty" : "schema.noDatabases.allHidden", {
          total: row.total,
        })}
      </div>
      {row.empty ? (
        supportsCreateDatabase(row.driver) && (
          <PolicyLockHint reason={createDbLock}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!!createDbLock}
              onClick={() =>
                show({ kind: "createDatabase", parentId: row.parentId })
              }
            >
              <DatabaseZap className="mr-1.5 h-3.5 w-3.5" />
              {t("schema.createDatabase.title")}
            </Button>
          </PolicyLockHint>
        )
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() =>
            show({ kind: "databaseVisibility", parentId: row.parentId })
          }
        >
          <ListFilter className="mr-1.5 h-3.5 w-3.5" />
          {t("schema.selectDatabases.title")}
        </Button>
      )}
    </div>
  );
}
