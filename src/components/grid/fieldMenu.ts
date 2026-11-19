/**
 * The document view's field menu, as a description (`MenuSpec`, ADR #143):
 * the right-click on one line of a document in the grid's list view.
 *
 * Moved out of `DocumentListView`, where it was the last data menu still
 * written as JSX (`FieldMenuItems`). The view decides *whether* a field gets a
 * menu — none while its value is being edited — and hands over what the row
 * knows; order, headings and colour are `ContextActionMenu`'s. Runs only while
 * the menu is open, so the labels that interpolate the field's path are built
 * once per right-click, not once per field row.
 *
 * Sorting here *replaces* the sort, like a plain header click in the table
 * view; building a multi-level sort is the toolbar's "Sort by" menu's job (see
 * `lib/grid/sortSpec.ts`).
 */

import type { TFunction } from "i18next";
import { ArrowDown, ArrowUp, Copy, Filter, FilterX, X } from "lucide-react";

import { viewAsDateEntry } from "@/components/epoch/viewAsDate";
import { pathKey, type DocField } from "@/lib/grid/documentTree";
import type { MenuSpec } from "@/lib/menu/menuSpec";

/** What the menu can do to a field — the slice of the view's per-row actions
 *  it calls. */
export interface FieldMenuActions {
  copyValue: (f: DocField) => void;
  sortBy: (f: DocField, desc: boolean) => void;
  unsort: (f: DocField) => void;
  filterBy: (f: DocField, exclude: boolean) => void;
}

export interface FieldMenuContext {
  t: TFunction;
  language: string;
  /** The field maps to a browse column the server can sort by. */
  sortable: boolean;
  /** The field's place in the current sort: `null` unsorted, `false`
   *  ascending, `true` descending. */
  sortDesc: boolean | null;
  /** The field maps to a column the server can filter by, and its value was
   *  sent — a trimmed field's `null` is a stand-in (ADR #133). */
  filterable: boolean;
  actions: FieldMenuActions;
}

export function fieldMenu(ctx: FieldMenuContext, f: DocField): MenuSpec {
  const { t, actions, sortDesc } = ctx;
  const field = pathKey(f.path);
  const isNull = f.value === null || f.value === undefined;
  return {
    header: {
      title: field,
      // A trimmed field shows what the page left on the server instead of a
      // value, and its `null` is not a NULL.
      tags: [f.type, f.trimmed, !f.trimmed && isNull && "NULL"],
    },
    entries: [
      {
        id: "copy",
        section: "copy",
        icon: Copy,
        label: t("dataGrid.ctxCopy"),
        // No key: the grid's Ctrl+C (`FIXED_KEYS.copyCell`) is the table
        // view's — `DataGrid` drops its keyboard handler in list mode — and
        // the list view answers no copy key of its own, so a chip here would
        // promise a copy the key does not make.
        onSelect: () => actions.copyValue(f),
      },
      // The driver is left to the panel's fallback — the workspace's current
      // connection, which is the one this document came from.
      !f.trimmed && viewAsDateEntry(f.value, { column: field }, t, ctx.language),
      ctx.sortable && {
        id: "sortAsc",
        section: "sort",
        icon: ArrowUp,
        label: t("dataGrid.sort.byAsc", { field }),
        disabled: sortDesc === false,
        onSelect: () => actions.sortBy(f, false),
      },
      ctx.sortable && {
        id: "sortDesc",
        section: "sort",
        icon: ArrowDown,
        label: t("dataGrid.sort.byDesc", { field }),
        disabled: sortDesc === true,
        onSelect: () => actions.sortBy(f, true),
      },
      ctx.sortable &&
        sortDesc !== null && {
          id: "unsort",
          section: "sort",
          icon: X,
          label: t("dataGrid.sort.removeField", { field }),
          onSelect: () => actions.unsort(f),
        },
      ctx.filterable && {
        id: "filterBy",
        section: "filter",
        icon: Filter,
        label: t("dataGrid.ctxFilterBy"),
        onSelect: () => actions.filterBy(f, false),
      },
      ctx.filterable && {
        id: "filterExcluding",
        section: "filter",
        icon: FilterX,
        label: t("dataGrid.ctxFilterExcluding"),
        onSelect: () => actions.filterBy(f, true),
      },
    ],
  };
}
