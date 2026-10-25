import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  KeyRound,
  Lock,
  Maximize2,
  SquarePlus,
} from "lucide-react";
import { BitInput } from "@/components/grid/BitInput";
import { CellInput } from "@/components/grid/CellInput";
import { FkCombobox } from "@/components/grid/FkCombobox";
import {
  formatValue,
  rawCellText,
  truncateForDisplay,
} from "@/lib/grid/formatValue";
import { defaultColumnWidth } from "@/lib/grid/columnKinds";
import { formatComboForDisplay } from "@/lib/keybindings";
import type { FkEdit, InlineEdit } from "@/lib/grid/useCellEditing";
import type {
  CellValue,
  ColumnInfo,
  ColumnMeta,
  GridPrefs,
  SortSpec,
} from "@/types";

/** What a `SelectedCell` looks like to the renderer; see `DataGrid`. */
interface SelectedCellLike {
  rowValues: CellValue[];
  column: ColumnMeta;
}

/**
 * The three fast-changing values the `cell` renderers read **through a ref**
 * rather than from a closure. See `interactiveRef` in `DataGrid` for the full
 * rationale; the short version is that putting them in the dependency array
 * below rebuilds every `cell` function on every keystroke, and TanStack treats
 * `columnDef.cell` as a component *type*, so React unmounts and remounts the
 * whole table body mid-edit.
 */
export interface InteractiveCellState {
  fkEditCell: FkEdit | null;
  inlineEdit: InlineEdit | null;
  selectedCell: SelectedCellLike | null;
}

/** How a value becomes text, and how wide a cell may get. */
export interface ColumnDisplay {
  numericColNames: ReadonlySet<string>;
  bitColNames: ReadonlySet<string>;
  bitDisplay: GridPrefs["bitDisplay"];
  nullDisplay: string;
  truncateLongTextAt: number;
  /** Shown in the expand button's tooltip. */
  expandCellCombo: string;
}

/** Per-column facts the header and the FK overlay need. */
export interface ColumnMetaMaps {
  /** Catalog metadata by column name (nullability, FK target). */
  columnInfoByName: ReadonlyMap<string, ColumnInfo>;
  /** Backend index by column name; display order can differ. */
  columnIndexByName: ReadonlyMap<string, number>;
  pkNameSet: ReadonlySet<string>;
  fkNameSet: ReadonlySet<string>;
  /** Columns the managed policy will not let this person change (ADR #113). */
  lockedNameSet?: ReadonlySet<string>;
  /** Columns they may not change but may fill when adding a row. */
  insertOnlyNameSet?: ReadonlySet<string>;
  /** Name of the JSON Schema bound to a column, when there is one. */
  boundSchemaNames: ReadonlyMap<string, string>;
}

/** The editing surface a cell hands off to; see `useCellEditing`. */
export interface ColumnEditing {
  interactiveRef: { current: InteractiveCellState };
  setFkEditCell: (edit: FkEdit | null) => void;
  setInlineEdit: (
    edit: InlineEdit | null | ((prev: InlineEdit | null) => InlineEdit | null),
  ) => void;
  openHeavyEditor: (
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) => void;
}

export interface GridColumnsOptions {
  /** Columns in backend order. */
  resultColumns: readonly ColumnMeta[];
  display: ColumnDisplay;
  meta: ColumnMetaMaps;
  editing: ColumnEditing;
  sort: SortSpec[] | undefined;
  onSortChange: ((column: string, additive: boolean) => void) | undefined;
  connectionId: string | undefined;
  tableSchema: string | undefined;
  onCellSave:
    | ((rowValues: CellValue[], column: string, value: string | null) => Promise<void>)
    | undefined;
}

/**
 * The grid's TanStack column definitions: the sortable header with its key
 * icons and type hint, and the `cell` renderer that paints a value or swaps in
 * whichever inline editor is open on it.
 *
 * Three hundred lines of JSX-bearing data, which is why it lives in `lib/`
 * beside `useCommands` rather than as a component: it *returns* definitions, it
 * does not render. Extracting it is also what makes the invariant below
 * legible instead of buried two thirds of the way down a 2000-line file.
 *
 * ## The dependency array is load-bearing
 *
 * `columnDef.cell` is treated by TanStack's `flexRender` as a component TYPE —
 * anything `typeof === "function"` is rendered as `<Comp {...props} />`. So a
 * rebuild of this array is a *new element type for every cell*, and React
 * responds by unmounting and remounting the entire table body. Mid-edit, that
 * destroys the focused input and remounts it with `autoFocus`, which plants
 * the caret at the end: the "cursor jumps to the end while typing" bug.
 *
 * Two consequences, and neither is optional:
 *
 * 1. The fast-changing interactive state (`fkEditCell`, `inlineEdit`,
 *    `selectedCell`) is read from `editing.interactiveRef.current`, never from
 *    a closure, and is **absent from the dependency array on purpose**.
 * 2. Callers must pass the individual preference values, not a bundle object —
 *    see the note on `useGridPrefs`. Depending on a bundle would rebuild these
 *    definitions whenever any unrelated preference changed.
 */
export function useGridColumns(
  opts: GridColumnsOptions,
): ColumnDef<CellValue[]>[] {
  const { t } = useTranslation();
  const { resultColumns, display, meta, editing, connectionId, tableSchema } =
    opts;
  const { sort, onSortChange, onCellSave } = opts;
  const {
    numericColNames,
    bitColNames,
    bitDisplay,
    nullDisplay,
    truncateLongTextAt,
    expandCellCombo,
  } = display;
  const {
    columnInfoByName,
    columnIndexByName,
    pkNameSet,
    fkNameSet,
    lockedNameSet,
    insertOnlyNameSet,
    boundSchemaNames,
  } = meta;
  const { interactiveRef, setFkEditCell, setInlineEdit, openHeavyEditor } =
    editing;

  const columns = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      resultColumns.map((col, idx) => ({
        id: col.name,
        header: () => {
          // Sort level for this column (-1 when not sorted). The arrow shows
          // the direction; the number only renders for a multi-column sort,
          // where precedence matters.
          const sortIndex = sort?.findIndex((s) => s.column === col.name) ?? -1;
          const active = sortIndex >= 0;
          const spec = active ? sort![sortIndex] : null;
          const showRank = active && (sort?.length ?? 0) > 1;
          const info = columnInfoByName.get(col.name);
          // The tooltip describes the FIELD, not what a click does. Two
          // reasons: the name is the first thing a narrow column clips, so
          // the tooltip is where the user recovers it (plus the full type,
          // which is clipped even earlier — see the spans below); and the
          // old wording ("Ctrl/Cmd+click to add a column") was read as an
          // offer to CREATE a column, which is both wrong and alarming in a
          // window that can also run DDL. Sorting stays discoverable through
          // the arrow glyph and the sort state reported on the last line.
          const facts: string[] = [col.data_type];
          const locked = lockedNameSet?.has(col.name) ?? false;
          const insertOnly = insertOnlyNameSet?.has(col.name) ?? false;
          if (locked) facts.push(t("dataGrid.headerPolicyLocked"));
          if (insertOnly) facts.push(t("dataGrid.headerInsertOnly"));
          if (pkNameSet.has(col.name)) facts.push(t("dataGrid.headerPk"));
          if (fkNameSet.has(col.name)) {
            facts.push(
              info?.referenced_table
                ? t("dataGrid.headerFkTo", {
                    target: `${info.referenced_table}.${
                      info.referenced_column ?? "id"
                    }`,
                  })
                : t("dataGrid.headerFk"),
            );
          }
          // `info` is absent for ad-hoc query results (no catalog metadata),
          // where nullability is unknown — say nothing rather than guess.
          if (info) {
            facts.push(
              info.nullable
                ? t("dataGrid.headerNullable")
                : t("dataGrid.headerNotNull"),
            );
          }
          if (active) {
            const dir = spec!.desc
              ? t("dataGrid.headerSortedDesc")
              : t("dataGrid.headerSortedAsc");
            facts.push(
              showRank
                ? `${dir} (${t("dataGrid.headerSortLevel", {
                    level: sortIndex + 1,
                  })})`
                : dir,
            );
          }
          return (
            <button
              className="group/sort -mx-1 flex w-full items-center gap-1 rounded-sm px-1 hover:bg-accent/50 hover:text-foreground"
              onClick={(e) =>
                onSortChange?.(col.name, e.ctrlKey || e.metaKey)
              }
              title={`${col.name}\n${facts.join(" · ")}`}
            >
              {locked && (
                <Lock
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                  aria-label={t("dataGrid.headerPolicyLocked")}
                />
              )}
              {insertOnly && (
                <SquarePlus
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                  aria-label={t("dataGrid.headerInsertOnly")}
                />
              )}
              {pkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-pk"
                  aria-label={t("dataGrid.headerPk")}
                />
              )}
              {fkNameSet.has(col.name) && (
                <KeyRound
                  className="h-3 w-3 shrink-0 text-fk"
                  aria-label={t("dataGrid.headerFk")}
                />
              )}
              {/* The NAME is the header's payload; the type is a hint. Both
                  used to be plain flex items with the default `flex-shrink:
                  1`, but only the name carried `truncate` — and `overflow:
                  hidden` is what lets a flex item shrink past its min-content
                  width. So in a column narrower than its content the name
                  collapsed to nothing while the type stayed fully legible
                  (a `BOOLEAN` column rendering as just "BOOL", with no clue
                  which field it was). Giving the type `overflow-hidden` +
                  a huge shrink factor inverts the priority: the type is
                  clipped away first (down to zero width) and the name only
                  starts eliding once the type is gone. `text-clip` rather
                  than an ellipsis because a lone "…" where the type used to
                  be is noise; the full type lives in the tooltip. */}
              <span className="min-w-0 truncate">{col.name}</span>
              <span className="min-w-0 shrink-[9999] overflow-hidden whitespace-nowrap text-clip text-3xs uppercase text-muted-foreground/50">
                {col.data_type}
              </span>
              {active ? (
                <span className="ml-auto flex shrink-0 items-center text-brand">
                  {spec!.desc ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <ArrowUp className="h-3 w-3" />
                  )}
                  {showRank && (
                    <span className="ml-0.5 text-3xs font-semibold tabular-nums">
                      {sortIndex + 1}
                    </span>
                  )}
                </span>
              ) : (
                // Persistent (not near-invisible) glyph that brightens on
                // header hover so sortability is discoverable at a glance.
                <ArrowUpDown className="ml-auto h-3 w-3 shrink-0 opacity-40 transition-opacity group-hover/sort:opacity-100" />
              )}
            </button>
          );
        },
        accessorFn: (row) => row[idx],
        // Only a starting point: `columnSizing` (persisted per table, or
        // in-session for ad-hoc results) always wins once the user resizes
        // a column, same as TanStack's own precedence.
        size: defaultColumnWidth(col.data_type) ?? undefined,
        cell: (info) => {
          const v = info.getValue() as CellValue;
          const rowValues = info.row.original as CellValue[];
          const colInfo = columnInfoByName.get(col.name);
          // Read live, not from the outer closure — see `interactiveRef` above.
          const { fkEditCell, inlineEdit, selectedCell } = interactiveRef.current;
          // FK edit identity is the row's value array (referential
          // identity from TanStack's row.original) — stable across
          // sort / filter reshuffles between activation and commit.
          const editingFk =
            fkEditCell?.rowValues === rowValues &&
            fkEditCell.column.name === col.name;
          if (editingFk && connectionId && colInfo?.referenced_table) {
            // Inline overlay: replace the read-only cell content with a
            // combobox of valid referenced values. The popover panel
            // hangs below this anchor so the user keeps the row in view.
            return (
              <FkCombobox
                connectionId={connectionId}
                refSchema={
                  colInfo.referenced_schema ?? tableSchema ?? undefined
                }
                refTable={colInfo.referenced_table}
                refColumn={colInfo.referenced_column ?? "id"}
                value={v === null ? null : formatValue(v)}
                nullable={colInfo.nullable}
                onChange={(picked) => {
                  setFkEditCell(null);
                  // Skip the round-trip if the user picks the same value
                  // that was already there (common when they just open
                  // the dropdown and dismiss).
                  const current = v === null ? null : formatValue(v);
                  if (picked === current) return;
                  // The rejection is already reported by `DataGrid`'s save seam (which
                  // notifies and rethrows); swallowing it here only keeps the
                  // unhandled-rejection warning out of the console.
                  onCellSave?.(rowValues, col.name, picked).catch(() => {});
                }}
              />
            );
          }
          // Inline single-cell editor (double-click on an editable, non-FK
          // cell). Same identity rule as the FK overlay above.
          const editingInline =
            inlineEdit?.rowValues === rowValues &&
            inlineEdit.column.name === col.name;
          if (editingInline && inlineEdit) {
            const commit = () => {
              const { value, original, rowValues: rv, column } = inlineEdit;
              setInlineEdit(null);
              // No-op when unchanged — also makes the blur that fires while
              // escalating to the modal harmless (expand leaves value as-is).
              if (value === original) return;
              // The rejection is already reported by `DataGrid`'s save seam (which
              // notifies and rethrows); swallowing it here only keeps the
              // unhandled-rejection warning out of the console.
              onCellSave?.(rv, column.name, value).catch(() => {});
            };
            const expand = () => {
              openHeavyEditor(
                inlineEdit.rowValues,
                inlineEdit.column,
                inlineEdit.value ?? "",
              );
              setInlineEdit(null);
            };
            // BIT columns get a dedicated 0/1 control. A `<select>` commits on
            // pick, so we save straight from `onSelect` with the chosen value
            // (no stale-state hop through `inlineEdit.value`).
            if (bitColNames.has(col.name)) {
              return (
                <BitInput
                  autoFocus
                  value={inlineEdit.value}
                  bitDisplay={bitDisplay}
                  nullable={colInfo?.nullable ?? false}
                  onSelect={(nv) => {
                    const { original, rowValues: rv, column } = inlineEdit;
                    setInlineEdit(null);
                    if (nv === original) return;
                    // The rejection is already reported by `DataGrid`'s save seam (which
                    // notifies and rethrows); swallowing it here only keeps the
                    // unhandled-rejection warning out of the console.
                    onCellSave?.(rv, column.name, nv).catch(() => {});
                  }}
                  onCancel={() => setInlineEdit(null)}
                />
              );
            }
            return (
              <CellInput
                autoFocus
                value={inlineEdit.value}
                onChange={(nv) =>
                  setInlineEdit((prev) => (prev ? { ...prev, value: nv } : prev))
                }
                onCommit={commit}
                onCancel={() => setInlineEdit(null)}
                onExpand={expand}
                schemaBound={boundSchemaNames.has(inlineEdit.column.name)}
                expandTitle={
                  boundSchemaNames.has(inlineEdit.column.name)
                    ? t("dataGrid.expandEditorWithSchema", {
                        name: boundSchemaNames.get(inlineEdit.column.name),
                      })
                    : t("dataGrid.expandEditor")
                }
              />
            );
          }
          const rawDisplay = rawCellText(v, bitColNames.has(col.name), bitDisplay);
          const display = truncateForDisplay(rawDisplay, truncateLongTextAt);
          const isNumeric = numericColNames.has(col.name);
          // Selected-but-not-editing: offer a direct "expand" affordance so
          // the full value can be viewed (modal / side panel per
          // `cellEditorMode`) without first entering inline edit (issue #78).
          const isSelected =
            selectedCell?.rowValues === rowValues &&
            selectedCell.column.name === col.name;
          return (
            <div className="flex min-w-0 items-center gap-1">
              <span
                className={`truncate font-mono ${
                  isNumeric ? "text-numeric" : ""
                }`}
              >
                {v === null ? (
                  <span className="italic text-muted-foreground">
                    {nullDisplay}
                  </span>
                ) : (
                  display
                )}
              </span>
              {isSelected && (
                <button
                  type="button"
                  tabIndex={-1}
                  title={`${t("dataGrid.expandEditor")} (${formatComboForDisplay(expandCellCombo)})`}
                  // `sticky` (not just `ml-auto`) so a wide column doesn't
                  // hide the button off the right edge of the scroll
                  // container until the user scrolls that specific cell into
                  // view. Deliberately no background: this cell's own fill
                  // varies (selected, zebra, hover) and a flat `bg-background`
                  // patch didn't track it, showing as a visibly mismatched
                  // rectangle over a tinted cell — the same seam class
                  // `CellInput`'s own sticky button was fixed for. Plain text
                  // scrolling underneath while both sticky and selected is
                  // the accepted trade-off for that.
                  className="sticky right-1 z-[1] ml-auto shrink-0 rounded px-1 text-muted-foreground/80 hover:text-foreground"
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    openHeavyEditor(rowValues, col, rawDisplay);
                  }}
                >
                  <Maximize2 className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        },
      })),
    // numericColNames is derived from resultColumns so they change together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      resultColumns,
      numericColNames,
      bitColNames,
      bitDisplay,
      nullDisplay,
      truncateLongTextAt,
      sort,
      pkNameSet,
      fkNameSet,
      lockedNameSet,
      insertOnlyNameSet,
      onSortChange,
      expandCellCombo,
      columnInfoByName,
      columnIndexByName,
      connectionId,
      tableSchema,
      onCellSave,
      boundSchemaNames,
      t,
    ],
  );

  return columns;
}
