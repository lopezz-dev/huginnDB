/**
 * The context menu of a table, view or collection in the schema tree, as a
 * description (`MenuSpec`, ADR #143).
 *
 * `TableRow` keeps what needs React — the policy locks and the row's own
 * "open this table" gesture, which its click shares — and hands the rest over;
 * order, headings and colour are `ContextActionMenu`'s. Runs only while the
 * menu is open.
 *
 * Four kinds of relation, four sets of edits: a SQL table (structure, rename,
 * import a file, empty, drop), a SQL view (its definition, rename, drop), a
 * MongoDB collection (a pipeline over it, its indexes, rename, empty, drop)
 * and a MongoDB view (its pipeline, drop). Being in `danger` is what makes
 * Empty red now; it used to sit plain beside a red Drop.
 */

import type { TFunction } from "i18next";
import {
  Code2,
  Copy,
  Eraser,
  ExternalLink,
  KeyRound,
  PencilLine,
  RefreshCw,
  SquarePen,
  SquareTerminal,
  Trash2,
  Upload,
  Wand2,
  Workflow,
} from "lucide-react";

import { runAiTask } from "@/lib/ai/runTask";
import { copyToClipboard } from "@/lib/clipboard";
import { supportsViewEditing } from "@/lib/db/driver";
import { selectSnippet } from "@/lib/grid/copyFormats";
import type { MenuEntry, MenuSpec } from "@/lib/menu/menuSpec";
import type { PolicyNeed } from "@/lib/policy/access";
import type { TableActions } from "@/lib/schema/tableActions";
import type { TableInfo } from "@/types";

export interface TableMenuContext {
  t: TFunction;
  connectionId: string;
  table: TableInfo;
  /** The per-connection bundle the tree already caches (`tableActionsFor`). */
  actions: TableActions;
  /** `usePolicyLocker(connectionId, relation)`. */
  lock: (need: PolicyNeed) => string | null;
  /** Open the relation's data in a tab — the same gesture as clicking it. */
  openTable: () => void;
}

/** What kind of relation the header names. A MongoDB base table is a
 *  collection; a view is a view on either side. */
export function relationKind(table: TableInfo, isMongo: boolean) {
  if (table.kind === "view") return "view" as const;
  return isMongo ? ("collection" as const) : ("table" as const);
}

export function tableMenu(ctx: TableMenuContext): MenuSpec {
  const { t, connectionId, table, actions: a, lock } = ctx;
  const isMongo = a.driver === "mongodb";
  const kind = relationKind(table, isMongo);
  const kindLabel: Record<typeof kind, string> = {
    table: t("schema.context.kind.table"),
    view: t("schema.context.kind.view"),
    collection: t("schema.context.kind.collection"),
  };
  const ddlLock = lock("ddl");

  return {
    header: { title: table.name, tags: [kindLabel[kind]] },
    entries: [
      {
        id: "open",
        section: "navigate",
        icon: ExternalLink,
        label: t("schema.context.open"),
        locked: lock("read"),
        onSelect: ctx.openTable,
      },
      {
        id: "copyName",
        section: "copy",
        icon: Copy,
        label: t("schema.context.copyName"),
        onSelect: () => void copyToClipboard(table.name),
      },
      {
        id: "copySelect",
        section: "copy",
        icon: Code2,
        label: t("schema.context.copySelect"),
        onSelect: () => void copyToClipboard(selectSnippet(a.driver, table.name)),
      },
      {
        id: "refresh",
        section: "view",
        icon: RefreshCw,
        label: t("schema.context.refresh"),
        onSelect: () => a.refresh(),
      },
      {
        id: "documentWithAi",
        section: "view",
        icon: Wand2,
        label: t("ai.task.documentRelationAction"),
        onSelect: () =>
          void runAiTask({
            task: "documentRelation",
            connection: connectionId,
            schema: table.schema,
            table: table.name,
          }),
      },
      {
        id: "newQuery",
        section: "create",
        icon: SquareTerminal,
        label: t("schema.context.newQueryOnTable"),
        locked: lock("freeSql"),
        onSelect: () => a.onOpenQuery(table),
      },
      ...editEntries(ctx, kind, ddlLock),
    ],
  };
}

/** The `create` / `edit` / `transfer` / `danger` entries that depend on what
 *  kind of relation this is. */
function editEntries(
  ctx: TableMenuContext,
  kind: ReturnType<typeof relationKind>,
  ddlLock: string | null,
): (MenuEntry | false)[] {
  const { t, connectionId, table, actions: a, lock } = ctx;
  const isMongo = a.driver === "mongodb";
  const rename: MenuEntry = {
    id: "rename",
    section: "edit",
    icon: PencilLine,
    label: t("schema.context.rename"),
    locked: ddlLock,
    onSelect: () => a.onRename(table),
  };
  const empty: MenuEntry = {
    id: "empty",
    section: "danger",
    icon: Eraser,
    label: t("schema.context.empty"),
    locked: ddlLock,
    onSelect: () => a.onEmpty(table),
  };
  const drop: MenuEntry = {
    id: "drop",
    section: "danger",
    icon: Trash2,
    label: t("schema.context.drop"),
    locked: ddlLock,
    onSelect: () => a.onDrop(table),
  };
  const dropView: MenuEntry = {
    id: "dropView",
    section: "danger",
    icon: Trash2,
    label: t("schema.context.dropView"),
    locked: ddlLock,
    onSelect: () => a.onDropView(table),
  };

  if (isMongo && kind === "collection") {
    // No SQL DDL — structure is read-only for Mongo — but rename is offered:
    // `renameCollection` needs no DDL builder. JSON import/export lives on the
    // grid's toolbar, which acts on the collection being viewed (#65).
    return [
      // A pipeline over this collection: the aggregation editor, and the way a
      // new MongoDB view gets made ("Save as view").
      {
        id: "newAggregation",
        section: "create",
        icon: Workflow,
        label: t("schema.context.newAggregation"),
        locked: lock("read"),
        onSelect: () =>
          a.openTab({
            connectionId,
            schema: table.schema,
            kind: "aggregation",
            viewMode: "new",
            title: `${table.name} (${t("tabs.aggregationSuffix")})`,
            table: table.name,
          }),
      },
      // Indexes are the one piece of a collection's structure that is real
      // rather than inferred, and the only part that can be edited.
      {
        id: "indexes",
        section: "edit",
        icon: KeyRound,
        label: t("schema.context.manageIndexes"),
        locked: lock("read"),
        onSelect: () =>
          a.openTab({
            connectionId,
            schema: table.schema,
            kind: "indexes",
            title: `${table.name} (${t("tabs.indexesSuffix")})`,
            table: table.name,
          }),
      },
      rename,
      empty,
      drop,
    ];
  }
  if (isMongo) {
    // A MongoDB view is a pipeline: "Edit pipeline" opens the aggregation
    // editor with it loaded and saving runs `collMod`. No rename — MongoDB has
    // none for a view.
    return [
      {
        id: "editPipeline",
        section: "edit",
        icon: Workflow,
        label: t("schema.context.editViewPipeline"),
        locked: lock("read"),
        onSelect: () =>
          a.openTab({
            connectionId,
            schema: table.schema,
            kind: "aggregation",
            viewMode: "edit",
            title: `${table.name} (${t("tabs.aggregationSuffix")})`,
            // No `table`: a view's source is its own `viewOn`, read from the
            // definition.
            view: table.name,
          }),
      },
      dropView,
    ];
  }
  if (kind === "table") {
    // Table/view *creation* lives one level up, on the database or schema
    // node: this menu is about an existing table.
    return [
      {
        id: "editStructure",
        section: "edit",
        icon: SquarePen,
        label: t("schema.context.editStructure"),
        locked: lock("read"),
        onSelect: () =>
          a.openTab({
            connectionId,
            schema: table.schema,
            kind: "structure",
            structureMode: "edit",
            title: `${table.name} (${t("tabs.structureSuffix")})`,
            table: table.name,
          }),
      },
      rename,
      {
        id: "importFile",
        section: "transfer",
        icon: Upload,
        label: t("dataGrid.importFile.action"),
        locked: lock("insert"),
        onSelect: () => a.onImportFile(table),
      },
      empty,
      drop,
    ];
  }
  // A SQL view: no columns, indexes or keys of its own, but its definition is
  // editable (#86) where the driver has a view-DDL builder.
  if (!supportsViewEditing(a.driver)) return [];
  return [
    {
      id: "editView",
      section: "edit",
      icon: SquarePen,
      label: t("schema.context.editView"),
      locked: lock("read"),
      onSelect: () =>
          a.openTab({
            connectionId,
            schema: table.schema,
          kind: "view",
          viewMode: "edit",
          title: `${table.name} (${t("tabs.viewSuffix")})`,
          view: table.name,
        }),
    },
    {
      id: "renameView",
      section: "edit",
      icon: PencilLine,
      label: t("schema.context.renameView"),
      locked: ddlLock,
      onSelect: () => a.onRenameView(table),
    },
    dropView,
  ];
}
