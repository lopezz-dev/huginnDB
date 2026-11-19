/**
 * The context menus of the two container nodes of the schema tree, as
 * descriptions (`MenuSpec`, ADR #143): a database (`DatabaseNodeMenu`, drawn
 * by both explorers) and a schema inside one (`SchemaHeaderRow`).
 *
 * They share their *Create* section — new table, new view, new query — so it
 * is written once, in {@link createHereEntries}, and the two menus cannot
 * drift apart on what a container offers to create or which lock guards it.
 * The components keep what needs React (the locks, the dialogs, resolving the
 * bound connection id); order, headings and colour are `ContextActionMenu`'s.
 */

import type { TFunction } from "i18next";
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

import { driverLabel } from "@/components/common/DriverBadge";
import {
  supportsCreateCollection,
  supportsSqlDump,
  supportsStructureEditing,
  supportsViewEditing,
} from "@/lib/db/driver";
import type { MenuEntry, MenuSpec } from "@/lib/menu/menuSpec";
import type { PolicyNeed } from "@/lib/policy/access";
import type { Driver } from "@/types";

/** What a container node offers to create in itself. */
export interface CreateHereActions {
  newTable: () => void;
  newView: () => void;
  newQuery: () => void;
}

/** New table, new view, new query — each where the driver can do it, each
 *  behind the lock that the backend would refuse it with. */
export function createHereEntries(
  t: TFunction,
  driver: Driver | undefined,
  lock: (need: PolicyNeed) => string | null,
  a: CreateHereActions,
): (MenuEntry | false)[] {
  return [
    supportsStructureEditing(driver) && {
      id: "newTable",
      section: "create",
      icon: Table2,
      label: t("schema.context.newTable"),
      locked: lock("ddl"),
      onSelect: a.newTable,
    },
    supportsViewEditing(driver) && {
      id: "newView",
      section: "create",
      icon: Eye,
      label: t("schema.context.newView"),
      // A view's body is free SQL: under a rule that limits relations it could
      // read any of them (`apply_view_change` refuses it).
      locked: lock("ddl") ?? lock("freeSql"),
      onSelect: a.newView,
    },
    {
      id: "newQuery",
      section: "create",
      icon: SquareTerminal,
      label: t("schema.context.newQueryHere"),
      locked: lock("freeSql"),
      onSelect: a.newQuery,
    },
  ];
}

export interface DatabaseMenuActions extends CreateHereActions {
  openSecurity: () => void;
  refresh: () => void;
  /** Multi-DB only: there is nothing to narrow *from* when the connection is
   *  one database, and an absent one removes the item. */
  scopeSearchHere?: () => void;
  newCollection: () => void;
  exportDatabase: () => void;
  importSql: () => void;
  drop: () => void;
}

export interface DatabaseMenuContext {
  t: TFunction;
  dbName: string;
  driver: Driver | undefined;
  /** Every driver but SQLite. */
  canDrop: boolean;
  /** `usePolicyLocker(accessId)`. */
  lock: (need: PolicyNeed) => string | null;
  actions: DatabaseMenuActions;
}

/**
 * A database's menu. No item advertises a key: the catalogue's Refresh and
 * "Search only here" act on the selected *connection*, not on one of its
 * databases.
 */
export function databaseMenu(ctx: DatabaseMenuContext): MenuSpec {
  const { t, driver, lock, actions: a } = ctx;
  // Whole-database .sql export/import needs a per-driver literal encoder,
  // which every SQL engine has; MongoDB uses the per-collection JSON
  // export/import instead (#65).
  const canDumpSql = supportsSqlDump(driver);
  return {
    header: { title: ctx.dbName, tags: [driver && driverLabel(driver)] },
    entries: [
      {
        id: "security",
        section: "navigate",
        icon: ShieldCheck,
        label: t("security.title"),
        locked: lock("monitor"),
        onSelect: a.openSecurity,
      },
      {
        id: "refresh",
        section: "view",
        icon: RefreshCw,
        label: t("schema.refresh"),
        onSelect: a.refresh,
      },
      a.scopeSearchHere && {
        id: "scopeHere",
        section: "filter",
        icon: Search,
        label: t("connectionsTree.filter.scopeHere"),
        onSelect: a.scopeSearchHere,
      },
      ...createHereEntries(t, driver, lock, a),
      supportsCreateCollection(driver) && {
        id: "newCollection",
        section: "create",
        icon: FolderPlus,
        label: t("schema.createCollection.title"),
        locked: lock("ddl"),
        onSelect: a.newCollection,
      },
      canDumpSql && {
        id: "exportDatabase",
        section: "transfer",
        icon: Download,
        label: t("schema.exportDatabase.title"),
        locked: lock("export"),
        onSelect: a.exportDatabase,
      },
      canDumpSql && {
        id: "importSql",
        section: "transfer",
        icon: Upload,
        label: t("schema.importSql.title"),
        // A .sql file runs as a batch of free statements.
        locked: lock("freeSql"),
        onSelect: a.importSql,
      },
      ctx.canDrop && {
        id: "dropDatabase",
        section: "danger",
        icon: Trash2,
        label: t("schema.context.dropDatabase"),
        locked: lock("ddl"),
        onSelect: a.drop,
      },
    ],
  };
}

export interface SchemaMenuContext {
  t: TFunction;
  schema: string;
  driver: Driver | undefined;
  /** `usePolicyLocker(connectionId)`. */
  lock: (need: PolicyNeed) => string | null;
  actions: CreateHereActions & { refresh: () => void };
}

/** A schema inside a database (Postgres' `public`, SQL Server's `dbo`). */
export function schemaMenu(ctx: SchemaMenuContext): MenuSpec {
  const { t, lock, actions: a } = ctx;
  return {
    header: { title: ctx.schema },
    entries: [
      {
        id: "refresh",
        section: "view",
        icon: RefreshCw,
        label: t("schema.refresh"),
        onSelect: a.refresh,
      },
      ...createHereEntries(t, ctx.driver, lock, a),
    ],
  };
}
