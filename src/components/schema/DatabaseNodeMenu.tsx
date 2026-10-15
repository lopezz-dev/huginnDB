/**
 * The context menu a **database node** carries, wherever that node is drawn.
 *
 * There are two such places and they used to have nothing in common. In
 * multi-DB mode the database row (now `DatabaseRow`) owned this menu outright;
 * in single-DB mode there was no database node at all, so the two actions that
 * are unambiguously *about a database* — creating a collection in it, dropping
 * it — had been pushed up onto the connection's own menu for want of anywhere
 * better. That is the wrong place by the only test that matters: a user who
 * wants to delete a database goes to the database, not to the connection that
 * happens to reach it.
 *
 * So the menu lives here and both call sites render it. The one thing they
 * genuinely differ on is **which connection id is bound to the database**, and
 * that is `resolveTargetId`'s whole job: multi-DB resolves (and lazily opens)
 * the synthetic `<parent>::db::<name>` view, single-DB already *is* bound and
 * hands back its own id. Every action below is written against "the id bound
 * to this database" and neither caller has to care which kind it got.
 *
 * `onDrop` is the second difference and is deliberately not absorbed: dropping
 * a database in multi-DB mode removes a row from a tree the user goes on
 * using, while in single-DB mode it destroys the only thing the connection
 * addresses and the connection has to come down with it. Same statement, two
 * different aftermaths.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Eye,
  FolderPlus,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";

import { CreateCollectionDialog } from "@/components/schema/dialogs/CreateCollectionDialog";
import { ExportDatabaseDialog } from "@/components/schema/dialogs/ExportDatabaseDialog";
import { ImportSqlDialog } from "@/components/schema/dialogs/ImportSqlDialog";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  supportsCreateCollection,
  supportsDdlEditing,
  supportsSqlDump,
} from "@/lib/db/driver";
import { notify } from "@/lib/notify";
import { usePolicyLocker } from "@/lib/policy/access";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import type { Driver } from "@/types";

export function DatabaseNodeMenu({
  dbName,
  accessId,
  driver,
  schema,
  canDrop,
  resolveTargetId,
  onRefresh,
  onScopeHere,
  onDrop,
  onOpenChange,
  children,
}: {
  /** The database this node stands for — shown in the collection dialog and
   *  in every confirmation. */
  dbName: string;
  /**
   * The id the managed policy is asked about for this database — the bound id
   * in single-DB mode, `databaseViewId(parent, dbName)` in multi-DB mode. Known
   * up front, unlike the pool `resolveTargetId` may still have to open, because
   * the locks have to be right the moment the menu shows.
   */
  accessId: string;
  driver: Driver | undefined;
  /**
   * The schema new tables/views should be created in, when the node knows it.
   *
   * Single-DB mode passes it (the node *is* one schema there, so the structure
   * editor can be pointed at it directly); multi-DB mode does not, because a
   * database node sits above however many schemas it contains and picking one
   * for the user would be a guess.
   */
  schema?: string;
  /** Whether dropping is offered — every driver but SQLite. */
  canDrop: boolean;
  /**
   * Resolve the connection id bound to this database, opening a pool if that
   * is what it takes, or `null` when the open failed (the caller reports it).
   * Every action here goes through it rather than assuming an id exists.
   */
  resolveTargetId: () => Promise<string | null>;
  /** Whatever "refresh what this node shows" means to the caller — multi-DB
   *  has to refresh two schema slices, single-DB one. The return value is
   *  ignored, hence `unknown`: a caller should not have to wrap a perfectly
   *  good promise in `void` to satisfy this. */
  onRefresh: () => unknown;
  /** Narrow the tree's search to this database. Multi-DB only — there is
   *  nothing to narrow *from* when the connection is one database. */
  onScopeHere?: () => void;
  onDrop: () => void | Promise<void>;
  /** Mirrors the row's own focus ring while the menu is open on it. */
  onOpenChange?: (open: boolean) => void;
  /** The row that opens the menu (Radix `asChild`). */
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const lock = usePolicyLocker(accessId);
  const ddlLock = lock("ddl");
  /** The bound id the create-collection dialog targets; non-null while open. */
  const [createCollectionId, setCreateCollectionId] = useState<string | null>(
    null,
  );
  // Export / import both need the bound id up front (scope `"single"`, locked
  // to this one database), so it is resolved before either dialog opens.
  const [exportTargetId, setExportTargetId] = useState<string | null>(null);
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const [importStatements, setImportStatements] = useState<string[] | null>(
    null,
  );

  // Every handler below is the same two steps — resolve the bound id, then
  // act on it — and each bails silently when the resolve failed, because
  // `resolveTargetId` has already reported why.
  const openQueryHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    openQueryTab(id);
  };

  const createTableHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    useTabs.getState().open({
      kind: "structure",
      structureMode: "new",
      title: t("schema.context.newTable"),
      connectionId: id,
      ...(schema ? { schema } : {}),
    });
  };

  const createViewHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    useTabs.getState().open({
      kind: "view",
      viewMode: "new",
      title: t("schema.context.newView"),
      connectionId: id,
      ...(schema ? { schema } : {}),
    });
  };

  const openSecurityHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    openSecurityTab(id, t("security.title"));
  };

  const exportThisDatabase = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    setExportTargetId(id);
  };

  const importSqlHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    const statements = await pickAndSplitSqlFile(t);
    if (!statements) return;
    setImportTargetId(id);
    setImportStatements(statements);
  };

  // `create_collection` needs a pool bound to this specific database, which
  // is exactly what the resolved id is.
  const createCollectionHere = async () => {
    const id = await resolveTargetId();
    if (!id) return;
    setCreateCollectionId(id);
  };

  return (
    <>
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuAction
            icon={RefreshCw}
            label={t("schema.refresh")}
            onSelect={() => void onRefresh()}
          />
          <ContextMenuSeparator />
          {supportsDdlEditing(driver) && (
            <ContextMenuAction
              icon={Table2}
              label={t("schema.context.newTable")}
              locked={ddlLock}
              onSelect={() => void createTableHere()}
            />
          )}
          {supportsDdlEditing(driver) && (
            <ContextMenuAction
              icon={Eye}
              label={t("schema.context.newView")}
              // A view's body is free SQL: under a rule that limits relations
              // it could read any of them (`apply_view_change` refuses it).
              locked={ddlLock ?? lock("freeSql")}
              onSelect={() => void createViewHere()}
            />
          )}
          <ContextMenuAction
            icon={SquareTerminal}
            label={t("schema.context.newQueryHere")}
            locked={lock("freeSql")}
            onSelect={() => void openQueryHere()}
          />
          {onScopeHere && (
            <ContextMenuAction
              icon={Search}
              label={t("connectionsTree.filter.scopeHere")}
              onSelect={onScopeHere}
            />
          )}
          {supportsCreateCollection(driver) && (
            <ContextMenuAction
              icon={FolderPlus}
              label={t("schema.createCollection.title")}
              locked={ddlLock}
              onSelect={() => void createCollectionHere()}
            />
          )}
          {/* Whole-database .sql export/import needs a per-driver literal
              encoder: MongoDB databases use the per-collection JSON
              export/import instead (#65), and SQL Server has none yet. */}
          {supportsSqlDump(driver) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={Download}
                label={t("schema.exportDatabase.title")}
                locked={lock("export")}
                onSelect={() => void exportThisDatabase()}
              />
              <ContextMenuAction
                icon={Upload}
                label={t("schema.importSql.title")}
                // A .sql file runs as a batch of free statements.
                locked={lock("freeSql")}
                onSelect={() => void importSqlHere()}
              />
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuAction
            icon={ShieldCheck}
            label={t("security.title")}
            locked={lock("monitor")}
            onSelect={() => void openSecurityHere()}
          />
          {canDrop && (
            <>
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={Trash2}
                destructive
                label={t("schema.context.dropDatabase")}
                locked={ddlLock}
                onSelect={() => void onDrop()}
              />
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {createCollectionId && (
        <CreateCollectionDialog
          connectionId={createCollectionId}
          onClose={() => setCreateCollectionId(null)}
          onDone={(name) => {
            const id = createCollectionId;
            setCreateCollectionId(null);
            void useSchema.getState().refresh(id);
            notify.success(t("schema.createCollection.created", { name }));
          }}
        />
      )}
      {exportTargetId && (
        <ExportDatabaseDialog
          scope={{
            kind: "single",
            connectionId: exportTargetId,
            databaseName: dbName,
          }}
          onClose={() => setExportTargetId(null)}
        />
      )}
      {importTargetId && importStatements && (
        <ImportSqlDialog
          scope={{ kind: "single", connectionId: importTargetId }}
          statements={importStatements}
          onClose={() => {
            setImportTargetId(null);
            setImportStatements(null);
          }}
          onImported={(id) => {
            setImportTargetId(null);
            setImportStatements(null);
            void useSchema.getState().refresh(id);
          }}
        />
      )}
    </>
  );
}
