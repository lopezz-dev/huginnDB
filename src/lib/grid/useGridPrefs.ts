import { useMemo } from "react";
import { selectGridPrefs, usePreferences } from "@/stores/preferences/preferences";
import { getBinding } from "@/lib/keybindings";
import type { GridPrefs, UiPrefs } from "@/types";

/**
 * The subset of `GridPrefs` the data grid actually reads. Derived from the
 * stored shape rather than restated, so a renamed preference is a compile
 * error here instead of a silently missing one (same reasoning as `PrefId`).
 */
type StoredGridPrefs = Pick<
  GridPrefs,
  | "bitDisplay"
  | "nullDisplay"
  | "truncateLongTextAt"
  | "zebraStripes"
  | "stickyHeader"
  | "cellPreview"
  | "listExpandNested"
  | "listShowTypes"
  | "listLineNumbers"
  | "rowHeight"
>;

export interface DataGridPrefs extends StoredGridPrefs {
  /** Default surface for the heavyweight editor: modal or docked side panel. */
  cellEditorMode: UiPrefs["cellEditorMode"];
  /** User-rebindable combo for "expand selected cell" (issues #78/#75). */
  expandCellCombo: string;
  /**
   * Writer for the grid preference slice. Both the Ctrl+wheel row zoom
   * (ADR #13) and the persisted column widths go through it, so it travels
   * with the values it writes.
   */
  updateGrid: ReturnType<typeof usePreferences.getState>["updateGrid"];
}

/**
 * Every preference the data grid reads, in one call.
 *
 * `DataGrid` subscribed to thirteen of these one at a time, most carrying the
 * same "subscribed as a primitive (gotcha #1)" comment — thirteen chances to
 * write the one selector that returns a fresh object and takes the app down
 * with an update-depth loop.
 *
 * **The individual `usePreferences` calls below are the point and must stay
 * that way.** Zustand compares a selector's result with `Object.is`, so a
 * selector returning `{ … }` is a different value on every store change and
 * re-renders forever. What is safe is assembling the object *after* the
 * subscriptions, in a `useMemo` keyed on the primitives — a plain React memo,
 * not a store selector. Do not fold this into
 * `usePreferences((s) => ({ … }))`.
 *
 * Callers **destructure** the result rather than passing the object into a
 * dependency array. That matters for one consumer in particular: the grid's
 * `columns` memo depends on four of these, and rebuilding it remounts the
 * whole table body (see the `interactiveRef` note in `DataGrid`). Depending on
 * this object instead would rebuild `columns` whenever an unrelated preference
 * changed — an invisible performance regression, and a caret that jumps to the
 * end of an inline edit if the change lands mid-typing.
 */
export function useGridPrefs(): DataGridPrefs {
  const bitDisplay = usePreferences((s) => selectGridPrefs(s).bitDisplay);
  const cellEditorMode = usePreferences((s) => s.prefs.ui.cellEditorMode);
  const nullDisplay = usePreferences((s) => selectGridPrefs(s).nullDisplay);
  const truncateLongTextAt = usePreferences(
    (s) => selectGridPrefs(s).truncateLongTextAt,
  );
  const zebraStripes = usePreferences((s) => selectGridPrefs(s).zebraStripes);
  const stickyHeader = usePreferences((s) => selectGridPrefs(s).stickyHeader);
  const cellPreview = usePreferences((s) => selectGridPrefs(s).cellPreview);
  const listExpandNested = usePreferences(
    (s) => selectGridPrefs(s).listExpandNested,
  );
  const listShowTypes = usePreferences((s) => selectGridPrefs(s).listShowTypes);
  const listLineNumbers = usePreferences(
    (s) => selectGridPrefs(s).listLineNumbers,
  );
  const rowHeight = usePreferences((s) => selectGridPrefs(s).rowHeight);
  // `getBinding` returns a string, which Zustand compares by value — so this
  // stays reference-stable despite looking like a derivation.
  const expandCellCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "expandSelectedCell"),
  );
  const updateGrid = usePreferences((s) => s.updateGrid);

  return useMemo(
    () => ({
      bitDisplay,
      cellEditorMode,
      nullDisplay,
      truncateLongTextAt,
      zebraStripes,
      stickyHeader,
      cellPreview,
      listExpandNested,
      listShowTypes,
      listLineNumbers,
      rowHeight,
      expandCellCombo,
      updateGrid,
    }),
    [
      bitDisplay,
      cellEditorMode,
      nullDisplay,
      truncateLongTextAt,
      zebraStripes,
      stickyHeader,
      cellPreview,
      listExpandNested,
      listShowTypes,
      listLineNumbers,
      rowHeight,
      expandCellCombo,
      updateGrid,
    ],
  );
}
