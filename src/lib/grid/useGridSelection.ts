/**
 * Row selection for the data grid: which rows are picked, how a click changes
 * that, and the derived answers the toolbar and context menus need.
 *
 * Extracted from `DataGrid` (245 lines with no JSX in them). The rules that make
 * this more than a `Set<string>`:
 *
 * - **A row is identified by its key, never by a display index** (ADR #7).
 *   `getRowKey` comes from the parent — the primary-key tuple for a
 *   table, `null` for a query result with no identity — and a `null`-keyed row
 *   simply cannot be selected, because there would be no way to address it in a
 *   later UPDATE or DELETE.
 * - **The selection is pruned to the visible rows**, so a refetch that dropped
 *   rows or a filter that narrowed them cannot leave the user about to delete
 *   something they can no longer see, nor make the header checkbox lie about
 *   "all selected".
 * - **Select-all only ever touches the visible set**, for the same reason.
 * - **Clicks follow the OS convention**: Ctrl/Cmd toggles one row, Shift extends
 *   a contiguous range from the last-touched anchor, and a plain click clears a
 *   multi-selection while leaving the single-row highlight (which the grid
 *   tracks separately) alone.
 * - **`selectedColumnValues` reports a *distinct* count**, because that is what
 *   the "filter by the selected rows" menu label promises: 40 rows sharing 3
 *   values build a 3-element `IN` list, and NULL is counted apart from the
 *   formatted values since `formatValue(null)` is `""` and a column holding both
 *   would otherwise be undercounted.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { formatValue } from "@/lib/grid/formatValue";
import type { CellValue } from "@/types";

export interface GridSelection {
  /** The selected keys, for the per-row `isMultiSelected` check. */
  selectedKeys: Set<string>;
  /** The selected rows as values arrays, in visible order. */
  selectedRows: CellValue[][];
  /** Any row selected at all — drives the always-visible checkbox affordance. */
  hasSelection: boolean;
  /** Every selectable visible row is selected. */
  allSelected: boolean;
  /** Some but not all — drives the checkbox's indeterminate dash. */
  someSelected: boolean;
  toggleRowKey: (key: string) => void;
  applyRowSelectionClick: (
    rowKey: string | null,
    event: React.MouseEvent,
  ) => void;
  toggleSelectAll: () => void;
  selectedColumnValues: (colIndex: number) => {
    values: CellValue[];
    distinct: number;
  };
}

export function useGridSelection({
  visibleRows,
  getRowKey,
  onSelectionChange,
}: {
  /** Rows currently rendered — already through any client-side filter. */
  visibleRows: CellValue[][];
  /** Stable identity for a row, or `null` when it has none. */
  getRowKey?: (row: CellValue[]) => string | null;
  /** Mirrors `(selected, visible)` up to the parent for the status bar. */
  onSelectionChange?: (selected: number, visible: number) => void;
}): GridSelection {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  /** Anchor for Shift-click range selection (the last row toggled). */
  const lastClickedKeyRef = useRef<string | null>(null);

  /**
   * Visible rows paired with their stable key (or null when unresolvable),
   * memoised so the per-row render and the range-selection math read a stable
   * list. `null`-keyed rows simply can't be selected.
   */
  const keyedVisibleRows = useMemo(() => {
    if (!getRowKey) return [] as { key: string | null; row: CellValue[] }[];
    return visibleRows.map((row) => ({ key: getRowKey(row), row }));
  }, [visibleRows, getRowKey]);

  /**
   * The currently-selected rows, as values arrays, in visible order. Drives
   * the bulk context-menu actions and the selection count. Memoised on the
   * selection set + the visible rows so its identity is stable across
   * unrelated renders.
   */
  const selectedRows = useMemo(() => {
    if (selectedKeys.size === 0) return [] as CellValue[][];
    return keyedVisibleRows
      .filter((r) => r.key !== null && selectedKeys.has(r.key))
      .map((r) => r.row);
  }, [keyedVisibleRows, selectedKeys]);

  /**
   * Mirror the selection count + visible-row total up to the parent (which
   * forwards it to the status bar keyed by tab id). Effect, not a render-time
   * call, so we never set external state during render.
   */
  useEffect(() => {
    onSelectionChange?.(selectedRows.length, keyedVisibleRows.length);
  }, [onSelectionChange, selectedRows.length, keyedVisibleRows.length]);

  /**
   * Prune selected keys that no longer correspond to a visible row (e.g.
   * after a refetch that dropped rows, or a filter narrowing). Keeps the
   * checkbox header's "all selected" state honest and avoids deleting rows
   * the user can no longer see. Runs only when the visible key set changes.
   */
  useEffect(() => {
    if (selectedKeys.size === 0) return;
    const live = new Set(
      keyedVisibleRows.map((r) => r.key).filter((k): k is string => k !== null),
    );
    let changed = false;
    const next = new Set<string>();
    for (const k of selectedKeys) {
      if (live.has(k)) next.add(k);
      else changed = true;
    }
    if (changed) setSelectedKeys(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyedVisibleRows]);

  /** Toggle a single row key (Ctrl/Cmd-click, or plain checkbox click). */
  function toggleRowKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastClickedKeyRef.current = key;
  }

  /** Select the contiguous range (in visible order) between the anchor and
   *  `key`, additively. Falls back to a single toggle when there's no anchor. */
  function selectRangeTo(key: string) {
    const anchor = lastClickedKeyRef.current;
    if (!anchor) {
      toggleRowKey(key);
      return;
    }
    const keys = keyedVisibleRows
      .map((r) => r.key)
      .filter((k): k is string => k !== null);
    const a = keys.indexOf(anchor);
    const b = keys.indexOf(key);
    if (a < 0 || b < 0) {
      toggleRowKey(key);
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(keys[i]);
      return next;
    });
  }

  /**
   * OS-explorer-style selection from a row/cell click. Ctrl/Cmd-click toggles
   * a single row; Shift-click extends a contiguous range from the anchor; a
   * plain click clears any multi-selection (keeping the single-row blue
   * highlight, handled separately by `setSelectedRowIndex`). No-op for rows
   * without a resolvable key.
   */
  function applyRowSelectionClick(
    rowKey: string | null,
    e: React.MouseEvent,
  ) {
    if (rowKey === null) return;
    if (e.ctrlKey || e.metaKey) {
      toggleRowKey(rowKey);
    } else if (e.shiftKey) {
      selectRangeTo(rowKey);
    } else if (selectedKeys.size > 0) {
      setSelectedKeys(new Set());
      lastClickedKeyRef.current = rowKey;
    } else {
      lastClickedKeyRef.current = rowKey;
    }
  }

  /**
   * The selection's values for one column, plus how many of them are actually
   * distinct — the pair behind the "filter by the selected rows" action (#114).
   *
   * The distinct count is what the menu label advertises: selecting 40 rows that
   * share 3 values builds a 3-element `IN` list (the backend dedupes), so
   * promising "40 values" would misdescribe the filter about to be applied.
   * NULL is counted apart from the formatted values instead of being folded in
   * with them: `formatValue(null)` is `""`, indistinguishable from an empty
   * string, so a column holding both would be undercounted.
   */
  function selectedColumnValues(colIndex: number): {
    values: CellValue[];
    distinct: number;
  } {
    const values = selectedRows.map((r) => r[colIndex] ?? null);
    const nonNull = values.filter((v) => v !== null);
    const distinct =
      new Set(nonNull.map((v) => formatValue(v))).size +
      (nonNull.length === values.length ? 0 : 1);
    return { values, distinct };
  }

  /**
   * Header tri-state select-all state, computed over the *visible* rows that
   * have a resolvable key. `allSelected` when every selectable visible row is
   * in the set; `someSelected` drives the checkbox's indeterminate dash.
   * Toggling only ever touches the visible set — never rows filtered out of
   * view (mirrors the prune effect above that keeps the set honest).
   */
  const selectableVisibleKeys = useMemo(
    () =>
      keyedVisibleRows
        .map((r) => r.key)
        .filter((k): k is string => k !== null),
    [keyedVisibleRows],
  );
  const allSelected =
    selectableVisibleKeys.length > 0 &&
    selectableVisibleKeys.every((k) => selectedKeys.has(k));
  const someSelected = selectedKeys.size > 0 && !allSelected;
  /** Any row selected at all — drives the always-visible checkbox affordance. */
  const hasSelection = selectedKeys.size > 0;

  /** Select-all / clear from the header checkbox. */
  function toggleSelectAll() {
    setSelectedKeys((prev) => {
      const everyVisibleSelected =
        prev.size > 0 && selectableVisibleKeys.every((k) => prev.has(k));
      return everyVisibleSelected ? new Set() : new Set(selectableVisibleKeys);
    });
    lastClickedKeyRef.current = null;
  }

  return {
    selectedKeys,
    selectedRows,
    hasSelection,
    allSelected,
    someSelected,
    toggleRowKey,
    applyRowSelectionClick,
    toggleSelectAll,
    selectedColumnValues,
  };
}
