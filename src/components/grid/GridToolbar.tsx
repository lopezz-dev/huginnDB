/**
 * The data grid's responsive toolbar.
 *
 * Split out of `DataGrid` because it shares almost nothing with the grid below
 * it: the bar owns its own measured width, its own collapse rules and its own
 * overflow menu, and needs none of the row model, the virtualizer or the
 * cell-editing state that makes up the rest of that component. What is left
 * here is one widget.
 *
 * Most of its props are `DataGrid`'s own, passed straight through — they are
 * the parent's toolbar slots, which were always destined for this bar and only
 * ever transited the grid.
 */

import { Fragment, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  MoreHorizontal,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { GridSearchInput } from "@/components/grid/GridSearchInput";
import { ServerFilterChip } from "@/components/grid/ServerFilterChips";
import { SortChip } from "@/components/grid/SortControls";
import { useToolbarDensity } from "@/lib/grid/toolbarDensity";
import { cn, formatNumber } from "@/lib/utils";
import type { ColumnFilter, SortSpec } from "@/types";

/**
 * One toolbar action, in BOTH of its presentations.
 *
 * The toolbar is responsive: as the grid's pane narrows, actions move out of
 * the bar and into an overflow menu (see `useToolbarDensity`). A plain
 * `ReactNode` can't make that trip — a `<Button>` dropped inside
 * `DropdownMenuContent` looks wrong and loses the menu's keyboard semantics,
 * and a bar control that is itself a dropdown (Export data) has to become a
 * submenu rather than a nested menu. So each action declares both forms and
 * the grid decides which one to mount; nothing here is derived from the other,
 * because the two really are different components (an icon button with a
 * tooltip vs. a labelled row with a check state).
 *
 * `id` is the React key and exists only for that.
 */
/**
 * One extra way to add data, offered behind the Insert button's chevron.
 *
 * Data, not JSX: these render as a menu row in two places (the chevron's
 * dropdown and the collapsed `⋯` menu), so a caller supplying both
 * presentations the way `GridToolbarItem` asks would be writing the same icon
 * and label twice.
 */
export interface InsertAlternative {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** See `GridToolbarProps.queryChips`. */
export interface QueryChip {
  id: string;
  /** The chip row's section label ("Fields", "Expression"). */
  section: string;
  /** Already phrased: `ts, code`, `all but configuration`, `qty > 3`. */
  label: string;
  editLabel: string;
  removeLabel: string;
  onEdit: () => void;
  onRemove: () => void;
}

export interface GridToolbarItem {
  id: string;
  /** Rendered inline in the toolbar row. */
  bar: ReactNode;
  /**
   * Rendered inside the overflow menu — one or more `DropdownMenuItem`s (or a
   * `DropdownMenuSub`). Must not be a bare `<Button>`.
   */
  menu: ReactNode;
}

interface GridToolbarProps {
  /** Parent-supplied leading cluster (refresh, query panel, sort). */
  toolbarLeading?: GridToolbarItem[];
  /** Parent-supplied cluster beside Insert (import/export, bulk update). */
  insertExtra?: GridToolbarItem[];
  /** Parent-supplied trailing cluster (the table/list view toggle). */
  toolbarTrailing?: GridToolbarItem[];
  /** Live search box value; falls back to the committed filter. */
  filterInput?: string;
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  onGlobalFilterSubmit?: (value: string) => void;
  searchHistory?: string[];
  serverFilters?: ColumnFilter[];
  /** Render filter values with their BSON type visible (MongoDB) — see
   *  `ServerFilterChips`' `valueText`. */
  typedFilterValues?: boolean;
  onRemoveFilter?: (index: number) => void;
  /** Open the query panel focused on the condition at this index — the
   *  chip's position in `serverFilters` is the panel's row index. */
  onEditFilter?: (index: number) => void;
  /** The active sort, drawn as chips after the filter chips — in both view
   *  modes, because the list view has no headers to show it on. Absent (a
   *  query-result grid) draws nothing. */
  sort?: SortSpec[];
  /** Flip one level's direction (chip body). */
  onToggleSort?: (column: string) => void;
  /** Drop one level (chip ✕, summary row). */
  onRemoveSort?: (column: string) => void;
  /**
   * The rest of the active query, one chip each after the filters and the
   * sort: the projection and the hand-written expression. Each opens the query
   * panel and its ✕ clears that part. Both change what the grid shows without
   * a column header or a condition row to say so — a column missing, rows
   * gone — so while one is on it is on screen.
   */
  queryChips?: QueryChip[];
  onInsertRow?: () => void;
  /** Fit every column to its widest visible value. */
  /**
   * Other ways to add data to this relation, offered behind the Insert
   * button's chevron. Data rather than JSX, unlike `GridToolbarItem`: these
   * only ever render as menu rows, in two places, so a caller supplying both
   * presentations would be writing the same icon and label twice.
   *
   * Empty (the SQL drivers) leaves a plain one-click button with no chevron —
   * a split control offering one choice is worse than no split at all.
   */
  insertAlternatives?: InsertAlternative[];
  showRowCount: boolean;
  /** Rows after the client filter — what the count reports. */
  visibleRowCount: number;
  /** Server-side total, when known. */
  total: number | null | undefined;
  elapsedMs: number;
  /** The backend capped the result set (`MAX_ADHOC_QUERY_ROWS`). */
  truncated?: boolean;
}

export function GridToolbar({
  toolbarLeading,
  insertExtra,
  toolbarTrailing,
  filterInput,
  globalFilter,
  onGlobalFilterChange,
  onGlobalFilterSubmit,
  searchHistory,
  serverFilters,
  typedFilterValues,
  onRemoveFilter,
  onEditFilter,
  sort,
  onToggleSort,
  onRemoveSort,
  queryChips,
  onInsertRow,
  insertAlternatives,
  showRowCount,
  visibleRowCount,
  total,
  elapsedMs,
  truncated,
}: GridToolbarProps) {
  const { t } = useTranslation();

  /**
   * Responsive toolbar. The bar is measured (not the viewport — the grid lives
   * in a dockview panel), and as it narrows actions move into a single
   * overflow menu instead of wrapping onto a second row, which is what used to
   * happen and left the filter cluster and the action cluster stacked.
   *
   * Two things collapse, in order of how much room they cost and how little
   * their absence hurts:
   * - `collapseData` — the labelled data actions (Insert plus the parent's
   *   import/export/bulk-update group). They carry text, so they're the widest
   *   things in the bar, and they're deliberate operations nobody triggers
   *   twice a minute.
   * - `collapseChrome` — the icon-only controls: the parent's leading cluster
   *   (refresh, query panel, sort) and the view controls (the table/list
   *   toggle). Cheap in pixels, frequently used, so they only go when the pane
   *   is genuinely too narrow for anything but the search box.
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const density = useToolbarDensity(toolbarRef);
  const collapseData = density !== "wide";
  const collapseChrome = density === "narrow";

  /**
   * The grid's own toolbar actions, in the same two-presentation shape the
   * parent's slots use (`GridToolbarItem`) so the bar and the overflow menu
   * are built from one list each. `null` when the action doesn't apply — no
   * insert callback. Insert itself
   * *is* offered in list view: the draft is drawn as a card there (see
   * `DraftDocumentCard`) and commits through the same `insert_row` call.
   */
  const alternatives = insertAlternatives ?? [];

  /**
   * A **split** button rather than a menu button, where there is more than one
   * way in. MongoDB has three — the inline draft, the free-form document
   * editor, and a JSON file — and before this they were three separate
   * controls in a bar that already collapses for want of room.
   *
   * The distinction from `Export ▾` beside it is deliberate and is why there is
   * a visible divider: that one opens a menu wherever you click it, this one
   * performs its default action on the body and only opens on the chevron.
   * Making Insert a menu button would have been the more consistent-looking
   * choice and would have cost the most frequent action in the grid a second
   * click, with no keyboard path to fall back on — `insert` has no shortcut.
   * Two hit targets need to look like two, hence the divider.
   *
   * The body always does what "Insert" means on every other driver (the inline
   * draft), so the primary action does not change shape between engines; only
   * the chevron appears or does not.
   */
  const insertItem: GridToolbarItem | null = onInsertRow
    ? {
        id: "insert",
        bar: alternatives.length ? (
          <div className="flex items-center overflow-hidden rounded-lg">
            <SimpleTooltip label={t("dataGrid.insertNewRow")}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 rounded-r-none px-2 text-xs"
                onClick={onInsertRow}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("dataGrid.insert")}
              </Button>
            </SimpleTooltip>
            <Separator />
            <DropdownMenu>
              <SimpleTooltip label={t("dataGrid.insertMore")}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("dataGrid.insertMore")}
                    className="h-7 rounded-l-none px-1"
                  >
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="start">
                {alternatives.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    className="text-xs"
                    onSelect={a.onSelect}
                  >
                    <a.icon className="mr-2 h-3.5 w-3.5" />
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <SimpleTooltip label={t("dataGrid.insertNewRow")}>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={onInsertRow}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("dataGrid.insert")}
            </Button>
          </SimpleTooltip>
        ),
        // Flattened in the overflow menu: a submenu inside the `⋯` would be a
        // third level for three rows.
        menu: (
          <>
            <DropdownMenuItem className="text-xs" onSelect={onInsertRow}>
              <Plus className="mr-2 h-3.5 w-3.5" />
              {t("dataGrid.insertNewRow")}
            </DropdownMenuItem>
            {alternatives.map((a) => (
              <DropdownMenuItem
                key={a.id}
                className="text-xs"
                onSelect={a.onSelect}
              >
                <a.icon className="mr-2 h-3.5 w-3.5" />
                {a.label}
              </DropdownMenuItem>
            ))}
          </>
        ),
      }
    : null;

  /**
   * What the overflow menu holds right now, grouped so the menu keeps the
   * bar's reading order (leading · data · view) with a separator between
   * groups. Empty groups are dropped, and an empty result hides the trigger
   * altogether — a `⋯` that opens nothing is worse than no `⋯`.
   */
  const overflowGroups: { id: string; items: GridToolbarItem[] }[] = [
    { id: "leading", items: collapseChrome ? (toolbarLeading ?? []) : [] },
    {
      id: "data",
      items: collapseData
        ? [...(insertItem ? [insertItem] : []), ...(insertExtra ?? [])]
        : [],
    },
    {
      id: "view",
      items: collapseChrome ? [...(toolbarTrailing ?? [])] : [],
    },
  ].filter((g) => g.items.length > 0);

  /**
   * The two readouts (row count, elapsed time) are squeezed out of the bar
   * before anything else — nobody acts on them — but only when the overflow
   * menu exists to keep showing them. A query-result tab passes no toolbar
   * slots and has no insert action, so at `compact` it has nothing to collapse
   * and therefore no `⋯`; hiding the timing there would delete it outright,
   * and the timing is precisely what you're watching on an ad-hoc query.
   */
  const hasOverflow = overflowGroups.length > 0;
  const rowCountInBar = density !== "narrow" || !hasOverflow;
  const elapsedInBar = density === "wide" || !hasOverflow;

  /* Toolbar layout: leading actions (refresh · query · sort) · growing
        search box  ——  then, right-aligned via the cluster's
        `ml-auto`: Insert · insertExtra (TableDataTab's Add/Export
        data/Bulk update, grouped right beside Insert) · optional row count ·
        trailing slot (view toggle) · elapsed time · overflow
        menu. The search box flex-grows (capped) so it's the visual anchor on
        the left; every action that adds, exports, or mass-edits data lives
        together on the right instead of crowding the filter cluster.

        As the pane narrows, actions leave the bar for the overflow menu
        instead of wrapping onto a second row (`density`, measured on this
        element): at `compact` the labelled data actions go, at `narrow`
        everything but the search box does. `flex-wrap` is kept as a safety
        net for the cases the breakpoints can't predict (a future action),
        not as the normal behaviour. The filter and sort chips are not in this
        row at all: they get one of their own underneath (see below). */
  const filterChips = serverFilters ?? [];
  const sortChips = sort && onToggleSort && onRemoveSort ? sort : [];
  const hasChipRow =
    filterChips.length > 0 ||
    sortChips.length > 0 ||
    (queryChips?.length ?? 0) > 0;

  return (
    <div className="border-b border-border bg-background text-xs">
      <div
        ref={toolbarRef}
        className="flex flex-wrap items-center gap-2 px-3 py-1.5"
      >
        {!collapseChrome &&
          toolbarLeading?.map((item) => (
            <Fragment key={item.id}>{item.bar}</Fragment>
          ))}
        {!collapseChrome && toolbarLeading && toolbarLeading.length > 0 && (
          <Separator />
        )}
        <GridSearchInput
          value={filterInput ?? globalFilter ?? ""}
          onChange={onGlobalFilterChange}
          onSubmit={onGlobalFilterSubmit}
          history={searchHistory ?? []}
        />
        {/* Right-aligned cluster. `ml-auto` opens the gap between the growing
            search box (+ filter chips) on the left and this group. Contents:
            Insert · insertExtra (TableDataTab's Add/Export data/Bulk update)
            · optional row count (query/view tabs) · trailing slot (view
            toggle) · elapsed time. Wrapped so the whole group wraps as a unit
            on narrow panes. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!collapseData && insertItem?.bar}
          {!collapseData &&
            insertExtra?.map((item) => (
              <Fragment key={item.id}>{item.bar}</Fragment>
            ))}
          {showRowCount && rowCountInBar && (
            <span className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatNumber(visibleRowCount)}
              </span>{" "}
              {t("dataGrid.rows")}
              {total !== null && total !== undefined && (
                <>
                  {" "}
                  {t("dataGrid.of")}{" "}
                  <span className="font-medium text-foreground">
                    {formatNumber(total)}
                  </span>
                </>
              )}
            </span>
          )}
          {/* Never gated by `showRowCount`/collapse — this is a warning about
              missing data, not a "nice to have" readout, so it stays visible
              even when the toolbar is squeezed. See `MAX_ADHOC_QUERY_ROWS`
              in `src-tauri/src/commands/query.rs`. */}
          {truncated && (
            <span
              className="flex items-center gap-1 rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning"
              title={t("dataGrid.truncatedHint")}
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t("dataGrid.truncated")}
            </span>
          )}
          {!collapseChrome &&
            toolbarTrailing?.map((item) => (
              <Fragment key={item.id}>{item.bar}</Fragment>
            ))}
          {/* The timing is the first thing to go: it's a readout nobody acts
              on, and the overflow menu keeps showing it (with the row count)
              once either is squeezed out of the bar. */}
          {elapsedInBar && (
            <span
              className={cn(
                "tabular-nums",
                // Draw attention only when a query is slow; fast queries stay
                // muted (colouring every timing green/amber would be noise).
                elapsedMs > 2000
                  ? "text-destructive"
                  : elapsedMs > 500
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {elapsedMs} ms
            </span>
          )}
          {overflowGroups.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  icon={MoreHorizontal}
                  label={t("dataGrid.moreActions")}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[13rem]">
                {overflowGroups.map((group, gi) => (
                  <Fragment key={group.id}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    {group.items.map((item) => (
                      <Fragment key={item.id}>{item.menu}</Fragment>
                    ))}
                  </Fragment>
                ))}
                {/* Readouts the bar no longer has room for. Not menu items —
                    there's nothing to select — just the numbers, so collapsing
                    the toolbar never hides information outright. */}
                {(!elapsedInBar || (showRowCount && !rowCountInBar)) && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1 text-xs tabular-nums text-muted-foreground">
                      {showRowCount && !rowCountInBar && (
                        <>
                          {formatNumber(visibleRowCount)} {t("dataGrid.rows")}
                          {total !== null &&
                            total !== undefined &&
                            ` ${t("dataGrid.of")} ${formatNumber(total)}`}
                          {!elapsedInBar && " · "}
                        </>
                      )}
                      {!elapsedInBar && `${elapsedMs} ms`}
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {/* The active filters and sort, on a row of their own. They used to sit
          inline after the search box, where they were the widest thing in
          the bar (each filter chip spells out `column op value`) and shared
          it with the search and every action. The cure then was folding them
          into one summary chip from `compact` down, which hid the conditions
          exactly when there were enough of them to matter. A row of their
          own can simply wrap. It is content, not an action, so it takes no
          part in the overflow-menu collapse, and it is absent when there is
          nothing to show. */}
      {hasChipRow && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 bg-muted/20 px-3 py-1">
          {filterChips.length > 0 && (
            <>
              <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("dataGrid.chipRow.filters")}
              </span>
              {filterChips.map((f, i) => (
                <ServerFilterChip
                  key={`${f.column}-${f.op}-${i}`}
                  filter={f}
                  index={i}
                  typedValues={typedFilterValues}
                  onEdit={onEditFilter}
                  onRemove={onRemoveFilter && (() => onRemoveFilter(i))}
                />
              ))}
            </>
          )}
          {filterChips.length > 0 && sortChips.length > 0 && (
            <Separator />
          )}
          {sortChips.length > 0 && onToggleSort && onRemoveSort && (
            <>
              <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("dataGrid.chipRow.sort")}
              </span>
              {sortChips.map((s, i) => (
                <SortChip
                  key={s.column}
                  spec={s}
                  rank={i + 1}
                  showRank={sortChips.length > 1}
                  onToggle={() => onToggleSort(s.column)}
                  onRemove={() => onRemoveSort(s.column)}
                />
              ))}
            </>
          )}
          {queryChips?.map((c, i) => (
            <Fragment key={c.id}>
              {(i > 0 || filterChips.length > 0 || sortChips.length > 0) && (
                <Separator />
              )}
              <span className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                {c.section}
              </span>
              <span className="flex items-center gap-0.5 rounded-full border border-border bg-muted/40 py-0.5 pl-1 pr-1 font-mono text-2xs">
                <SimpleTooltip label={c.editLabel}>
                  <Button
                    flat
                    variant="ghost"
                    size="xs"
                    className="h-4 max-w-[24rem] rounded-full px-1 font-mono text-2xs hover:bg-transparent hover:text-foreground"
                    onClick={c.onEdit}
                  >
                    <span className="truncate">{c.label}</span>
                  </Button>
                </SimpleTooltip>
                <IconButton
                  flat
                  size="xs"
                  icon={X}
                  label={c.removeLabel}
                  onClick={c.onRemove}
                />
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
