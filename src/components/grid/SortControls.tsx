/**
 * The sort as something you can *see* — chips beside the filter chips (on the
 * toolbar's chip row), and the toolbar's "Sort by" menu.
 *
 * Why this exists: the sort used to be reachable only through the table's
 * column headers. It was always server-side (it becomes the browse's
 * `ORDER BY` / `sort()`) and it kept applying in the list view, but the list
 * view has no headers, so there it could be neither seen nor changed — a
 * collection sorted in table mode stayed sorted in list mode with nothing on
 * screen saying so or offering a way out. The chips render in both view modes
 * for that reason, and in table mode they also keep a sort visible once its
 * column has scrolled out of the viewport.
 *
 * The transitions themselves live in `lib/grid/sortSpec.ts`; this file only
 * draws them. The chips flip or drop a level, the menu builds one (see that
 * module's header for why the two surfaces have different semantics).
 */

import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";

import {
  removeSortLevel,
  sortLevelOf,
  upsertSortLevel,
} from "@/lib/grid/sortSpec";
import type { SortSpec } from "@/types";

/** A field the "Sort by" menu offers: its path (a column name, or a dotted
 *  MongoDB path) and, when known, the type shown in the row's gutter. */
export interface SortField {
  path: string;
  type?: string;
}

/**
 * One sort level: direction arrow, field, and its rank when there is more than
 * one level. The body flips the direction; the ✕ drops the level.
 *
 * The body is the button and the ✕ its sibling, never its child — the same
 * rule `ServerFilterChip` states, for the same reason.
 */
export function SortChip({
  spec,
  rank,
  showRank,
  onToggle,
  onRemove,
}: {
  spec: SortSpec;
  /** 1-based precedence, shown only when `showRank`. */
  rank: number;
  showRank: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const Arrow = spec.desc ? ArrowDown : ArrowUp;
  const tip = spec.desc
    ? t("dataGrid.sort.chipDesc", { field: spec.column })
    : t("dataGrid.sort.chipAsc", { field: spec.column });
  return (
    <span className="flex items-center gap-0.5 rounded-full border border-brand/40 bg-brand/10 py-0.5 pl-1 pr-1 font-mono text-2xs">
      <SimpleTooltip label={tip}>
        <Button
          flat
          variant="ghost"
          size="xs"
          className="h-4 gap-1 rounded-full px-1 font-mono text-2xs hover:bg-transparent hover:text-foreground"
          aria-label={tip}
          onClick={onToggle}
        >
          <Arrow className="h-3 w-3 shrink-0 text-brand" />
          <span className="max-w-[10rem] truncate">{spec.column}</span>
          {showRank && (
            <span className="text-3xs font-semibold text-brand">{rank}</span>
          )}
        </Button>
      </SimpleTooltip>
      <IconButton
        flat
        size="xs"
        icon={X}
        label={t("dataGrid.sort.chipRemove", { field: spec.column })}
        onClick={onRemove}
      />
    </span>
  );
}

/**
 * The rows of the "Sort by" menu, for either of its two hosts: the toolbar
 * button's own dropdown and, when the toolbar has collapsed, a submenu of the
 * `⋯` overflow menu. Returning fragments rather than a whole menu is what lets
 * both share them.
 *
 * One submenu per field (ascending / descending / remove) rather than two rows
 * per field: a 40-column table would otherwise be an 80-row menu, and the
 * submenu trigger has room to show where the field already sits in the sort.
 */
export function SortByMenuItems({
  fields,
  sort,
  onChange,
}: {
  fields: SortField[];
  sort: SortSpec[];
  onChange: (next: SortSpec[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuLabel>{t("dataGrid.sort.menuTitle")}</DropdownMenuLabel>
      {fields.length === 0 && (
        <DropdownMenuItem disabled>
          {t("dataGrid.sort.noFields")}
        </DropdownMenuItem>
      )}
      {fields.map((f) => {
        const level = sortLevelOf(sort, f.path);
        const Arrow = level?.desc ? ArrowDown : ArrowUp;
        return (
          <DropdownMenuSub key={f.path}>
            <DropdownMenuSubTrigger>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="truncate font-mono">{f.path}</span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5 pr-1">
                  {level ? (
                    <>
                      <Arrow className="h-3 w-3 text-brand" />
                      {sort.length > 1 && (
                        <span className="text-3xs font-semibold text-brand">
                          {level.rank}
                        </span>
                      )}
                    </>
                  ) : (
                    f.type && (
                      <span className="text-3xs text-muted-foreground">
                        {f.type}
                      </span>
                    )
                  )}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuCheckboxItem
                checked={level !== null && !level.desc}
                onSelect={() => onChange(upsertSortLevel(sort, f.path, false))}
              >
                <ArrowUp className="mr-2 h-3.5 w-3.5" />
                {t("dataGrid.sort.ascending")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={level !== null && level.desc}
                onSelect={() => onChange(upsertSortLevel(sort, f.path, true))}
              >
                <ArrowDown className="mr-2 h-3.5 w-3.5" />
                {t("dataGrid.sort.descending")}
              </DropdownMenuCheckboxItem>
              {level && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onChange(removeSortLevel(sort, f.path))}
                  >
                    <X className="mr-2 h-3.5 w-3.5" />
                    {t("dataGrid.sort.removeLevel")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
      {sort.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange([])}>
            <X className="mr-2 h-3.5 w-3.5" />
            {t("dataGrid.sort.clear")}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
