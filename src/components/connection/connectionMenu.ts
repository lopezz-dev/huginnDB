/**
 * A connection's context menu, as a description (`MenuSpec`, ADR #143).
 *
 * `ConnectionActionsMenu` keeps what needs React — the profile and schema it
 * reads from the stores, the policy locks, the dialogs the actions open — and
 * hands this function the facts and the callbacks; order, headings and colour
 * are `ContextActionMenu`'s. Runs only while the menu is open.
 *
 * The sections are what fixes the old menu's two orders: connected and
 * disconnected used to list "Edit connection" and "Open in a new window" the
 * other way round. Here *Edit* always comes before *Session*, whatever the
 * state.
 */

import type { TFunction } from "i18next";
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

import { driverLabel } from "@/components/common/DriverBadge";
import { supportsCreateDatabase, supportsSqlDump } from "@/lib/db/driver";
import type { MenuShortcut, MenuSpec } from "@/lib/menu/menuSpec";
import type { PolicyNeed } from "@/lib/policy/access";
import type { Driver } from "@/types";

/** What the connection menu offers to do. `connect` / `disconnect` are absent
 *  where the row does not offer them, and an absent one removes its item. */
export interface ConnectionMenuActions {
  refresh: () => void;
  createDatabase: () => void;
  chooseDatabases: () => void;
  scopeSearchHere: () => void;
  exportDatabase: () => void;
  importSql: () => void;
  openSecurity: () => void;
  editConnection: () => void;
  openInNewWindow: () => void;
  connect?: () => void;
  disconnect?: () => void;
}

export interface ConnectionMenuContext {
  t: TFunction;
  /** The profile's name — the menu's subject. */
  name: string;
  driver: Driver | undefined;
  /** Connected in this window. A disconnected connection offers only what
   *  does not need the pool: connect, edit, open elsewhere. */
  isActive: boolean;
  /** Server-wide (multi-DB): there are databases to choose among. */
  isMultiDb: boolean;
  /** The database list has loaded, so "Databases to show" has something to
   *  show. */
  hasDatabases: boolean;
  /**
   * This connection is the selected one (`useUi.selectedConnectionId`), read
   * when the menu opens. Refresh and "Search only here" have keys, but those
   * keys act on the *selected* connection (`App.tsx`), so they are advertised
   * only when that is the one the menu is about.
   */
  isSelected: boolean;
  /** `usePolicyLocker(connectionId)`: the reason a need is refused, or null. */
  lock: (need: PolicyNeed) => string | null;
  actions: ConnectionMenuActions;
}

export function connectionMenu(ctx: ConnectionMenuContext): MenuSpec {
  const { t, driver, lock, actions: a } = ctx;
  const header = { title: ctx.name, tags: [driver && driverLabel(driver)] };
  const key = (shortcut: MenuShortcut) => (ctx.isSelected ? shortcut : undefined);
  const edit = {
    id: "editConnection",
    section: "edit",
    icon: Pencil,
    label: t("connectionsTree.editConnection"),
    onSelect: a.editConnection,
  } as const;
  const newWindow = {
    id: "openInNewWindow",
    section: "session",
    icon: AppWindow,
    label: t("connectionsTree.openInNewWindow"),
    onSelect: a.openInNewWindow,
  } as const;

  if (!ctx.isActive) {
    return {
      header,
      entries: [
        edit,
        a.connect && {
          id: "connect",
          section: "session",
          icon: Plug,
          label: t("connectionsTree.connect"),
          // A connection the role may not use, or any while the policy is
          // broken, refuses to open (`guard::endpoint`).
          locked: lock("connect"),
          onSelect: a.connect,
        },
        // Offered while disconnected too, and this is the primary case: "open
        // this server in its own window without disturbing the one I have".
        newWindow,
      ],
    };
  }

  // Whole-database `.sql` export/import: every SQL driver with a literal
  // encoder. The dialogs handle multi-DB themselves (a database picker for
  // export, a target dropdown for import), so it is not single-DB-only.
  const canDumpSql = supportsSqlDump(driver);
  return {
    header,
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
        shortcut: key({ action: "refreshSchema" }),
        onSelect: a.refresh,
      },
      ctx.isMultiDb && {
        id: "chooseDatabases",
        section: "filter",
        icon: ListFilter,
        // Nothing to choose from until the database list has loaded.
        disabled: !ctx.hasDatabases,
        label: t("schema.selectDatabases.title"),
        onSelect: a.chooseDatabases,
      },
      // Beside "Databases to show": both answer "I only care about this much
      // of the server right now" — one for the search, one for the tree.
      {
        id: "scopeHere",
        section: "filter",
        icon: Search,
        label: t("connectionsTree.filter.scopeHere"),
        shortcut: key({ action: "scopeFilterToConnection" }),
        onSelect: a.scopeSearchHere,
      },
      supportsCreateDatabase(driver) && {
        id: "createDatabase",
        section: "create",
        icon: DatabaseZap,
        label: t("schema.createDatabase.title"),
        locked: lock("ddl"),
        onSelect: a.createDatabase,
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
      edit,
      newWindow,
      a.disconnect && {
        id: "disconnect",
        section: "session",
        icon: PlugZap,
        label: t("statusBar.disconnect"),
        onSelect: a.disconnect,
      },
    ],
  };
}
