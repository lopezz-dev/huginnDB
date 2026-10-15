/**
 * What a table row in the schema tree can do, per connection.
 *
 * `TableActions` used to be built by a `useMemo` inside every
 * `SingleDbExplorer`, closing over that explorer's dialog state and its
 * `onTableOpen` prop. The explorers are gone — the tree is one flat
 * virtualised list (ADR #108) — so the bundle is built from the stores
 * instead: every handler reads what it needs with `getState()` at call time,
 * which makes it a pure function of `(connectionId, driver)` and lets one
 * bundle per connection be cached for the life of the session. A stable
 * bundle is what keeps `TableRow`'s `memo()` worth having.
 */

import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import {
  databaseOfViewId,
  parentConnectionId,
} from "@/lib/connectionLabel";
import { QUERY_HERE_LIMIT, selectSnippet } from "@/lib/grid/copyFormats";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { api } from "@/lib/tauri";
import { usePreferences } from "@/stores/preferences/preferences";
import { useSchemaTreeDialogs } from "@/stores/dialogs/schemaTreeDialogs";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useTreeSearch } from "@/stores/session/treeSearch";
import { useUi } from "@/stores/session/ui";
import type { Driver, TableInfo } from "@/types";

export interface TableActions {
  openTab: ReturnType<typeof useTabs.getState>["open"];
  /**
   * Open a query editor scoped to this relation, seeded with a bounded
   * `SELECT`.
   */
  onOpenQuery: (table: TableInfo) => void;
  refresh: () => void;
  onRename: (table: TableInfo) => void;
  onDrop: (table: TableInfo) => void;
  onEmpty: (table: TableInfo) => void;
  onRenameView: (view: TableInfo) => void;
  onDropView: (view: TableInfo) => void;
  driver: Driver | undefined;
}

/**
 * Note the database a table was just opened from, for the brand accent on its
 * row in a multi-DB tree.
 *
 * It also collapses every *other* expanded database, on the theory that the
 * user is now working in this one — except while a search is running, when
 * the whole point is that results from several databases are on screen at
 * once.
 */
export function activateDatabase(parentId: string, database: string): void {
  useUi.getState().setActiveDatabase(parentId, database);
  if (useTreeSearch.getState().patterns.length > 0) return;
  const schema = useSchema.getState();
  const expanded = schema.byConnection[parentId]?.expanded;
  if (!expanded) return;
  for (const key of expanded) {
    if (key.startsWith("db:") && key !== `db:${database}`) {
      schema.toggleNode(parentId, key);
    }
  }
}

/** For a per-database view, the side effect opening a table has on its parent
 *  tree; nothing for a plain connection. */
function onTableOpened(connectionId: string): void {
  const parentId = parentConnectionId(connectionId);
  if (parentId === connectionId) return;
  activateDatabase(parentId, databaseOfViewId(connectionId));
}

function makeTableActions(
  connectionId: string,
  driver: Driver | undefined,
): TableActions {
  const refresh = () => void useSchema.getState().refresh(connectionId);
  const show = useSchemaTreeDialogs.getState().show;
  return {
    openTab: (config) => {
      onTableOpened(connectionId);
      return useTabs.getState().open(config);
    },
    onOpenQuery: (tbl) => {
      onTableOpened(connectionId);
      // `resolveTarget: false` is the load-bearing half. In multi-DB mode
      // `connectionId` is already the `<parent>::db::<db>` child this row
      // belongs to, and the default would hand it to `queryTargetFor`, which
      // re-points it at whichever database the *focused tab* happens to be on.
      // "Query this table" means this table's database.
      openQueryTab(connectionId, {
        sql: selectSnippet(driver, tbl.name, QUERY_HERE_LIMIT),
        resolveTarget: false,
      });
    },
    refresh,
    onRename: (target) => show({ kind: "rename", connectionId, target }),
    onDrop: (target) => show({ kind: "drop", connectionId, target }),
    onEmpty: (target) => {
      // "Don't ask again" (#69): when the user has silenced the prompt, empty
      // straight away; otherwise route through the confirmation dialog. This
      // is a dedicated preference, not the global `confirmDestructive`, so
      // opting out here never weakens other destructive confirmations.
      if (usePreferences.getState().prefs.ui.confirmEmptyTable) {
        show({ kind: "empty", connectionId, target });
        return;
      }
      void (async () => {
        try {
          await api.emptyTable(connectionId, target.schema, target.name);
          notify.success(i18n.t("schema.empty.emptied", { name: target.name }));
          refresh();
        } catch (e) {
          notify.error(String(e));
        }
      })();
    },
    onRenameView: (target) =>
      show({ kind: "renameView", connectionId, target }),
    onDropView: (target) => show({ kind: "dropView", connectionId, target }),
    driver,
  };
}

const cache = new Map<string, TableActions>();

/** The cached bundle for `connectionId`, rebuilt only if its driver changed
 *  (a profile edited to another engine keeps its id). */
export function tableActionsFor(
  connectionId: string,
  driver: Driver | undefined,
): TableActions {
  const hit = cache.get(connectionId);
  if (hit && hit.driver === driver) return hit;
  const next = makeTableActions(connectionId, driver);
  cache.set(connectionId, next);
  return next;
}
