/**
 * One table/view row of the schema tree, the rows under it when it is
 * expanded (its columns, or the shimmer / retry standing in for them), and the
 * leaf helpers only they use: the column-type colour and the row-count/size
 * badge.
 *
 * Split out of `SchemaExplorer.tsx`, where it was the single largest thing in a
 * 2800-line file. The grouping that feeds it is `buildFlatTree`'s, memoised per
 * `(tables, patterns)` (gotcha #1).
 */

import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Eraser,
  ExternalLink,
  Eye,
  KeyRound,
  PencilLine,
  RefreshCw,
  SquarePen,
  SquareTerminal,
  Table as TableIcon,
  Trash2,
  Workflow,
  Wand2,
} from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { TreeSkeleton } from "@/components/schema/TreeStatus";
import { runAiTask } from "@/lib/ai/runTask";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { tableTabTitle } from "@/lib/connectionLabel";
import { supportsDdlEditing, supportsRenameTable } from "@/lib/db/driver";
import { selectSnippet } from "@/lib/grid/copyFormats";
import { cn, formatBytes, formatCount } from "@/lib/utils";
import { usePolicyLocker } from "@/lib/policy/access";
import { useConnections } from "@/stores/session/connections";
import { tableKey, useSchema } from "@/stores/session/schema";
import { copyToClipboard } from "@/lib/clipboard";
import type { TableActions } from "@/lib/schema/tableActions";
import type { ColumnInfo, SchemaTableMetric, TableInfo } from "@/types";

/**
 * Coarse colour for a column's data type, tying the tree's type labels to the
 * grid's semantic hues: numeric → `numeric` (the same amber as numeric cells),
 * boolean → `success`, everything else stays muted. Deliberately restrained —
 * a full per-family palette would need dedicated tokens; this reuses what the
 * grid already establishes so the two surfaces read as one system.
 */
function typeColorClass(dataType: string): string {
  const d = dataType.toLowerCase();
  if (/(int|serial|numeric|decimal|real|double|float|money|bit|number)/.test(d))
    return "text-numeric";
  if (/bool/.test(d)) return "text-success";
  return "text-muted-foreground/70";
}

/** Renders the right-aligned per-table metric badge (row count or size). */
export function tableMetricLabel(
  t: TableInfo,
  metric: SchemaTableMetric,
): string | null {
  // `!= null` covers both `undefined` (field omitted) and `null` (older
  // payloads / drivers that serialized a null stat). `formatCount`/`formatBytes`
  // additionally guard non-finite input, so a stray null can never crash here.
  // It also has to stay `!= null` rather than a truthiness check: a genuine
  // `row_count` of 0 is information, and `if (t.row_count)` would hide it.
  const wantsCount = metric === "row-count" || metric === "both";
  const wantsSize = metric === "size" || metric === "both";
  const parts: string[] = [];
  if (wantsCount && t.row_count != null) parts.push(formatCount(t.row_count));
  if (wantsSize && t.size_bytes != null) parts.push(formatBytes(t.size_bytes));
  // `null`, not `""` — the caller renders the badge element only when this is
  // non-null, so an empty string would paint an empty pill.
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * One table/view row, wrapped in a context menu with the destructive (DROP)
 * and renaming actions. Its column list is rows of their own below it
 * (`ColumnRow`, `ColumnsErrorRow`) — the tree is one virtualised list
 * (ADR #108), and a row that rendered its own children is what made opening a
 * ten-thousand-table section mount ten thousand of these at once.
 *
 * `memo()`-wrapped, which is only useful because every prop is a primitive or
 * a reference that only changes when this row's own facts do: the expansion
 * and column state arrive as booleans, the "you are here" state as two
 * booleans computed once per render of the tree, and `actions` is the cached
 * per-connection bundle (`tableActionsFor`).
 */
export const TableRow = memo(function TableRow({
  table,
  connectionId,
  expanded,
  hasColumns,
  hasColumnError,
  actions,
  metric,
  isActive,
  isOpen,
}: {
  table: TableInfo;
  connectionId: string;
  expanded: boolean;
  /** A column list is already loaded — the chevron only fetches when
   *  neither it nor an error is there. */
  hasColumns: boolean;
  hasColumnError: boolean;
  actions: TableActions;
  metric: SchemaTableMetric;
  /** This table is the active tab ("you are here"). */
  isActive: boolean;
  /** This table is open in *some* tab, active or not. */
  isOpen: boolean;
}) {
  const { t: ct } = useTranslation();
  const t = table;
  const k = tableKey(t.schema, t.name);
  const tableNodeKey = `table:${k}`;
  const tableOpen = expanded;
  const isView = t.kind === "view";
  // See `ConnectionActionsMenu`'s matching state/comment: keeps the row
  // looking targeted once the pointer has moved off it onto the open menu.
  const [menuOpen, setMenuOpen] = useState(false);
  // What the managed policy lets the person do on this relation. Hidden
  // relations never reach the tree (the listing is filtered in Rust), so the
  // locks here are about verbs: a visible table that is read-only for them.
  const lock = usePolicyLocker(connectionId, { schema: t.schema, name: t.name });
  const ddlLock = lock("ddl");

  const copyName = () => {
    void copyToClipboard(t.name);
  };
  const copySelect = () => {
    void copyToClipboard(selectSnippet(actions.driver, t.name));
  };

  const isMongo = actions.driver === "mongodb";
  /** Structure and view editing need a DDL builder for the driver; SQL Server
   *  doesn't have one yet, so it gets the same read-only treatment MongoDB has
   *  — except that its structure *view* is real (see below). */
  const canEditDdl = supportsDdlEditing(actions.driver);
  /** Rename is its own capability: it needs no DDL builder, so MongoDB has it
   *  (`renameCollection`) even though everything above is unavailable there. */
  const canRename = supportsRenameTable(actions.driver);

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "flex items-center pl-8 pr-2 hover:bg-accent",
            // Active-table "you are here" marker: soft brand wash + a 2px
            // inset brand rail (inset shadow, so it adds no layout shift).
            isActive &&
              "bg-brand/10 shadow-[inset_2px_0_0_var(--brand)] hover:bg-brand/15",
            // Right-clicked-and-menu-open marker — see the `menuOpen`
            // state's comment above.
            menuOpen && "ring-1 ring-inset ring-ring",
          )}
        >
          <IconButton
            size="xs"
            flat
            icon={tableOpen ? ChevronDown : ChevronRight}
            label={
              tableOpen
                ? ct("schema.collapseColumns")
                : ct("schema.expandColumns")
            }
            aria-expanded={tableOpen}
            onClick={() => {
              const schema = useSchema.getState();
              schema.toggleNode(connectionId, tableNodeKey);
              // Don't auto-relaunch a failed load on every toggle — the
              // retry row below is the explicit way to try again while the
              // error is still showing.
              if (!hasColumns && !hasColumnError)
                void schema.loadColumns(connectionId, t.schema, t.name);
            }}
            // Only the chevron toggles the column list now — the rest of
            // the row opens the table in a tab (below). A single click
            // anywhere used to expand columns, which surprised users
            // coming from IDEs where clicking a table row opens it.
            // The 24px square is the old `p-1.5` + 12px glyph exactly;
            // `-my-1` keeps it from growing the 24px row.
            className="-my-1 -ml-1 shrink-0"
          />
          <button
            type="button"
            onClick={() =>
              actions.openTab({
                kind: "table",
                title: tableTabTitle(
                  useConnections.getState().profiles,
                  connectionId,
                  t.name,
                ),
                connectionId,
                schema: t.schema,
                table: t.name,
              })
            }
            className="flex flex-1 items-center gap-1 py-1 text-left"
          >
            {isView ? (
              <Eye
                className={cn(
                  "h-3.5 w-3.5",
                  isActive ? "text-brand" : "text-muted-foreground",
                )}
              />
            ) : (
              <TableIcon
                className={cn(
                  "h-3.5 w-3.5",
                  isActive ? "text-brand" : "text-muted-foreground",
                )}
              />
            )}
            <span
              className={cn(
                // min-w-0 lets this flex-item shrink below its content's
                // intrinsic width so `truncate` can actually clip long
                // names — without it the row overflows and the metric
                // badge gets pushed off, forcing horizontal scroll.
                "min-w-0 truncate text-xs",
                // Table name is the row's primary target → the boldest leaf
                // in the 3-tier ramp (section label muted / column muted).
                isActive
                  ? "font-semibold text-brand"
                  : "font-medium text-foreground",
              )}
            >
              {t.name}
            </span>
            {isOpen && !isActive && (
              // "Open in a tab" marker — a soft brand dot so you can tell,
              // while browsing, which tables you already have open (the
              // active one carries the stronger rail + bold instead).
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"
                aria-label={ct("schema.tableOpenTooltip")}
                title={ct("schema.tableOpenTooltip")}
              />
            )}
            {(() => {
              const badge = tableMetricLabel(t, metric);
              return badge ? (
                <span className="ml-auto shrink-0 pl-2 text-3xs tabular-nums text-muted-foreground">
                  {badge}
                </span>
              ) : null;
            })()}
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuAction
          icon={ExternalLink}
          label={ct("schema.context.open")}
          locked={lock("read")}
          onSelect={() =>
            actions.openTab({
              kind: "table",
              title: tableTabTitle(
                useConnections.getState().profiles,
                connectionId,
                t.name,
              ),
              connectionId,
              schema: t.schema,
              table: t.name,
            })
          }
        />
        <ContextMenuAction
          icon={Copy}
          label={ct("schema.context.copyName")}
          onSelect={copyName}
        />
        <ContextMenuAction
          icon={SquareTerminal}
          label={ct("schema.context.queryTableHere")}
          locked={lock("freeSql")}
          onSelect={() => actions.onOpenQuery(t)}
        />
        <ContextMenuAction
          icon={Code2}
          label={ct("schema.context.copySelect")}
          onSelect={copySelect}
        />
        <ContextMenuAction
          icon={Wand2}
          label={ct("ai.task.documentRelationAction")}
          onSelect={() =>
            void runAiTask({
              task: "documentRelation",
              connection: connectionId,
              schema: t.schema,
              table: t.name,
            })
          }
        />
        <ContextMenuAction
          icon={RefreshCw}
          label={ct("schema.context.refresh")}
          onSelect={() => actions.refresh()}
        />
        {/* MongoDB collections: empty + drop. JSON data import/export used to
            live here too (#65) but has moved to the DataGrid toolbar's "Add
            data"/"Export data" controls (see `TableDataTab.tsx`), which act on
            the collection you're actually viewing instead of requiring a
            tree round-trip. No SQL DDL — structure editing is read-only for
            Mongo — but rename *is* offered: `renameCollection` needs no DDL
            builder, and it can move the collection to another database while
            it is at it. */}
        {isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            {/* A pipeline over this collection — the entry point to the
                aggregation editor, and the way a new MongoDB view gets made
                (build the pipeline, then "Save as view"). */}
            <ContextMenuAction
              icon={Workflow}
              label={ct("schema.context.newAggregation")}
              locked={lock("read")}
              onSelect={() =>
                actions.openTab({
                  kind: "aggregation",
                  viewMode: "new",
                  title: `${t.name} (${ct("tabs.aggregationSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            />
            {/* Indexes are the one piece of a Mongo collection's structure
                that is real rather than inferred, and the only part of it
                that can be edited — hence an entry of its own rather than a
                section inside the read-only structure tab. */}
            <ContextMenuAction
              icon={KeyRound}
              label={ct("schema.context.manageIndexes")}
              locked={lock("read")}
              onSelect={() =>
                actions.openTab({
                  kind: "indexes",
                  title: `${t.name} (${ct("tabs.indexesSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            />
            <ContextMenuSeparator />
            {canRename && (
              <ContextMenuAction
                icon={PencilLine}
                label={ct("schema.context.rename")}
                locked={ddlLock}
                onSelect={() => actions.onRename(t)}
              />
            )}
            <ContextMenuAction
              icon={Eraser}
              label={ct("schema.context.empty")}
              locked={ddlLock}
              onSelect={() => actions.onEmpty(t)}
            />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.drop")}
              locked={ddlLock}
              onSelect={() => actions.onDrop(t)}
            />
          </>
        )}
        {/* MongoDB views. Not covered by the `canEditDdl` block below: a Mongo
            view has no `CREATE VIEW` body to edit, it has a *pipeline* — so
            "Edit view" opens the aggregation editor with that pipeline loaded,
            and saving runs `collMod` rather than DDL. Renaming is absent
            because MongoDB has no rename for a view (drop and recreate is the
            only path, which is a different, destructive gesture). */}
        {isMongo && isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Workflow}
              label={ct("schema.context.editViewPipeline")}
              locked={lock("read")}
              onSelect={() =>
                actions.openTab({
                  kind: "aggregation",
                  viewMode: "edit",
                  title: `${t.name} (${ct("tabs.aggregationSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  // No `table`: a view's source is its own `viewOn`, which the
                  // editor reads from the definition rather than assuming.
                  view: t.name,
                })
              }
            />
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.dropView")}
              locked={ddlLock}
              onSelect={() => actions.onDropView(t)}
            />
          </>
        )}
        {/* Views fall through to read-only; we only expose DDL on base tables.
            Table/view *creation* lives one level up, on the database/schema
            node's own menu — see its doc comment — never here: this menu is
            for an existing table, and the old "New table…" entry buried at
            its tail was exactly the bug report that prompted this file's
            menu rework. */}
        {!isMongo && !isView && (
          <>
            <ContextMenuSeparator />
            {/* Opens read-only on a driver without a DDL builder (SQL Server):
                the catalog introspection is complete, only `apply` is missing,
                and columns/PK/FK/index detail is worth showing regardless. */}
            <ContextMenuAction
              icon={SquarePen}
              label={ct("schema.context.editStructure")}
              locked={lock("read")}
              onSelect={() =>
                actions.openTab({
                  kind: "structure",
                  structureMode: "edit",
                  title: `${t.name} (${ct("tabs.structureSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  table: t.name,
                })
              }
            />
            {/* Its own capability, not `canEditDdl`: rename needs no DDL
                builder, which is why MongoDB has it too (below). */}
            {canRename && (
              <ContextMenuAction
                icon={PencilLine}
                label={ct("schema.context.rename")}
                locked={ddlLock}
                onSelect={() => actions.onRename(t)}
              />
            )}
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Eraser}
              label={ct("schema.context.empty")}
              locked={ddlLock}
              onSelect={() => actions.onEmpty(t)}
            />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.drop")}
              locked={ddlLock}
              onSelect={() => actions.onDrop(t)}
            />
          </>
        )}
        {/* Views: no column/index/FK editing (a view has none of its own),
            but the definition itself is editable — see issue #86. MongoDB
            views are read-only aggregation pipelines, so excluded here too
            (same reasoning as the table-DDL guard above). */}
        {canEditDdl && isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={SquarePen}
              label={ct("schema.context.editView")}
              locked={lock("read")}
              onSelect={() =>
                actions.openTab({
                  kind: "view",
                  viewMode: "edit",
                  title: `${t.name} (${ct("tabs.viewSuffix")})`,
                  connectionId,
                  schema: t.schema,
                  view: t.name,
                })
              }
            />
            <ContextMenuAction
              icon={PencilLine}
              label={ct("schema.context.renameView")}
              locked={ddlLock}
              onSelect={() => actions.onRenameView(t)}
            />
            <ContextMenuSeparator />
            <ContextMenuAction
              icon={Trash2}
              destructive
              label={ct("schema.context.dropView")}
              locked={ddlLock}
              onSelect={() => actions.onDropView(t)}
            />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * The guide every row under an expanded table sits in. `ml-8` aligns the
 * hairline with the table row's `pl-8`, so it drops straight down from under
 * the table's chevron — a consistent 12px-per-level ladder (schema 8 → section
 * 20 → table 32). Brand-tinted while the table is the active tab. One wrapper
 * per row rather than one around the whole list: adjacent rows' borders meet,
 * so the line still reads as continuous.
 */
function ColumnGuide({
  isActive,
  children,
}: {
  isActive: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "ml-8 border-l pl-3 pr-2",
        isActive ? "border-brand/40" : "border-border/35",
      )}
    >
      {children}
    </div>
  );
}

/** One column under an expanded table. */
export const ColumnRow = memo(function ColumnRow({
  column: c,
  isActive,
}: {
  column: ColumnInfo;
  isActive: boolean;
}) {
  return (
    <ColumnGuide isActive={isActive}>
      <div className="flex items-center gap-1 py-1 text-2xs text-muted-foreground">
        {c.is_primary_key && (
          <KeyRound
            className="h-2.5 w-2.5 shrink-0 text-pk"
            aria-label="primary key"
          />
        )}
        {c.referenced_table && (
          <KeyRound
            className="h-2.5 w-2.5 shrink-0 text-fk"
            aria-label={`foreign key → ${c.referenced_table}`}
          />
        )}
        <span className="truncate">{c.name}</span>
        <span
          className={cn(
            "ml-auto shrink-0 pl-2 text-3xs uppercase",
            typeColorClass(c.data_type),
          )}
        >
          {c.data_type}
        </span>
      </div>
    </ColumnGuide>
  );
});

/** A table whose column list would not load, with the retry on the line. */
export function ColumnsErrorRow({
  connectionId,
  schema,
  table,
  message,
  isActive,
}: {
  connectionId: string;
  schema: string;
  table: string;
  message: string;
  isActive: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ColumnGuide isActive={isActive}>
      <button
        type="button"
        onClick={() =>
          void useSchema.getState().loadColumns(connectionId, schema, table)
        }
        className="flex items-center gap-1 py-1 text-2xs text-destructive/80 hover:text-destructive"
        title={message}
      >
        <RefreshCw className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{t("schema.columnsLoadError")}</span>
      </button>
    </ColumnGuide>
  );
}

/** A table's column list being read. */
export function ColumnsLoadingRow({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  return (
    <ColumnGuide isActive={isActive}>
      <TreeSkeleton label={t("schema.loadingColumns")} />
    </ColumnGuide>
  );
}
