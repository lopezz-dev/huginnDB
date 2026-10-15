import { useState, type KeyboardEvent, type RefObject } from "react";
import type { Table } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import { copyToClipboard, readFromClipboard } from "@/lib/clipboard";
import { normalizeBitValue } from "@/lib/grid/columnKinds";
import { formatValue, rawCellText } from "@/lib/grid/formatValue";
import { matchesBinding } from "@/lib/keybindings";
import type { CellValue, ColumnInfo, ColumnMeta, GridPrefs } from "@/types";
import type { InlineEdit } from "@/lib/grid/useCellEditing";

/** `{ r, c }` into the visible row model and the visible leaf columns. */
export interface ActiveCell {
  r: number;
  c: number;
}

/** The cell a chord acts on, resolved from either selection mechanism. */
interface TargetCell {
  rowValues: CellValue[];
  column: ColumnMeta;
  value: CellValue;
}

/**
 * The rendered grid the keyboard walks through. These five travel together
 * because every movement needs all of them: the table for the row and column
 * counts, the virtualizer to mount a row that is currently outside the window,
 * the scroll container to find the resulting DOM node, and the two column
 * lookups to turn a *display* position back into a backend column.
 */
export interface KeyboardGrid {
  table: Table<CellValue[]>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Columns in backend order. */
  columns: readonly ColumnMeta[];
  columnIndexByName: ReadonlyMap<string, number>;
}

/** The editing surface the keyboard hands off to; see `useCellEditing`. */
export interface KeyboardEditing {
  inlineEdit: InlineEdit | null;
  fkEditCell: unknown | null;
  setInlineEdit: (edit: InlineEdit | null) => void;
  openCellEdit: (rowValues: CellValue[], column: ColumnMeta) => void;
  openHeavyEditor: (
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
  ) => void;
}

export interface GridKeyboardNavOptions {
  grid: KeyboardGrid;
  editing: KeyboardEditing;
  /** The mouse-selected cell, which already carries its value. */
  selectedCell: { rowValues: CellValue[]; column: ColumnMeta; value: CellValue } | null;
  /** Moving the active cell also moves the row highlight. */
  setSelectedRowIndex: (index: number | null) => void;
  /** Catalog metadata by column name — an FK column has no text to paste into. */
  columnInfoByName: ReadonlyMap<string, ColumnInfo>;
  /** Names of MySQL `BIT` columns, likewise not free-text. */
  bitColNames: ReadonlySet<string>;
  bitDisplay: GridPrefs["bitDisplay"];
  /** User-rebindable combo for "expand selected cell". */
  expandCellCombo: string;
  editable: boolean | undefined;
  onCellSave:
    | ((
        rowValues: CellValue[],
        columnName: string,
        value: string | null,
      ) => Promise<void>)
    | undefined;
}

/**
 * Grid-level keyboard navigation: the inset-ring active cell, the arrows /
 * Home / End that move it, Enter to edit, Escape to clear, and the three
 * chords (Ctrl+C, Ctrl+V, expand-cell).
 *
 * The grid was mouse-only before this existed, which contradicts the app's
 * keyboard-first identity. What makes it worth its own file is not the length
 * but the *kind* of code: it is imperative choreography over the virtualizer
 * and the DOM (mount a row that isn't rendered, wait for React, then scroll
 * the cell into view), which is the one thing in the grid with nothing
 * declarative about it.
 *
 * **The option count is the real coupling and is not hidden here.** Moving
 * between cells genuinely needs the table, the virtualizer, the scroll
 * container and both column lookups, and the chords genuinely need the
 * editing surface; grouping them into `grid` and `editing` names the two
 * clusters rather than pretending they are fewer. What the hook buys is that
 * `DataGrid` no longer contains any of it.
 *
 * The ring never animates its movement: this fires on every keypress, so
 * motion would read as lag (the app's keyboard-action rule).
 */
export function useGridKeyboardNav(opts: GridKeyboardNavOptions) {
  const {
    grid,
    editing,
    selectedCell,
    setSelectedRowIndex,
    columnInfoByName,
    bitColNames,
    bitDisplay,
    expandCellCombo,
    editable,
    onCellSave,
  } = opts;

  /**
   * Keyboard-navigable active cell. Set on cell click too (so the keyboard
   * picks up where the mouse left off) and cleared on Escape.
   */
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);

  /**
   * The cell a Ctrl+C/Ctrl+V chord should act on: the mouse-selected cell
   * (which carries its value already) or, as a keyboard-only fallback, the
   * active cell resolved the same way the Enter handler does.
   */
  function resolveTargetCell(): TargetCell | null {
    if (selectedCell) {
      return {
        rowValues: selectedCell.rowValues,
        column: selectedCell.column,
        value: selectedCell.value,
      };
    }
    if (activeCell) {
      const rows = grid.table.getRowModel().rows;
      const row = rows[activeCell.r];
      const cell = row?.getVisibleCells()[activeCell.c];
      const bi = cell ? (grid.columnIndexByName.get(cell.column.id) ?? -1) : -1;
      if (row && bi >= 0) {
        const rowValues = row.original as CellValue[];
        return { rowValues, column: grid.columns[bi], value: rowValues[bi] };
      }
    }
    return null;
  }

  /**
   * Ctrl+C copies the raw value (same as the context menu's "Copy"); Ctrl+V
   * seeds `inlineEdit` with the pasted text so it flows through the existing
   * commit/cancel path unchanged. FK columns have no free-text control to
   * paste into, so paste is a no-op there. BIT columns use a `<select>`
   * (`BitInput`) instead of `inlineEdit`'s free-text `CellInput`, which has no
   * way to "confirm" a pasted value — so BIT paste normalizes the text itself
   * (same coercion `BitInput` applies) and commits directly via `onCellSave`,
   * skipping the round trip if the normalized value is already what's there.
   */
  function handleCopyPasteChord(key: "c" | "v") {
    const cell = resolveTargetCell();
    if (!cell) return;
    if (key === "c") {
      void copyToClipboard(formatValue(cell.value));
      return;
    }
    if (!editable || !onCellSave) return;
    const info = columnInfoByName.get(cell.column.name);
    if (info?.referenced_table) return;
    const isBit = bitColNames.has(cell.column.name);
    // Through the shared seam, which reads the clipboard in Rust. Reading it
    // from JS here is what used to make Ctrl+V raise WebView2's own "allow
    // this site to see your clipboard" prompt — inside a desktop app, on a
    // paste the user just asked for (ADR #63).
    void readFromClipboard().then((text) => {
      // `null` is "nothing readable in the clipboard", not an error: there is
      // nothing useful to say about an empty clipboard, same convention as
      // `copyToClipboard` swallowing a failed write.
      if (text === null) return;
      const cur =
        cell.rowValues[grid.columnIndexByName.get(cell.column.name) ?? -1];
      const original =
        cur === null || cur === undefined ? null : formatValue(cur);
      if (isBit) {
        const normalized = normalizeBitValue(text);
        const value = normalized === "" ? null : normalized;
        if (value === original) return;
        // The rejection is already reported by `DataGrid`'s save seam (which
        // notifies and rethrows); swallowing it here only keeps the
        // unhandled-rejection warning out of the console.
        onCellSave(cell.rowValues, cell.column.name, value).catch(() => {});
        return;
      }
      editing.setInlineEdit({
        rowValues: cell.rowValues,
        column: cell.column,
        value: text,
        original,
      });
    });
  }

  /**
   * Bound to the (focusable) scroll container. Guards: skip when an inline
   * editor is open or focus is inside a form control. Ctrl+C/Ctrl+V and the
   * expand combo are the only modified chords handled here; every other
   * modified chord is left alone for the browser.
   */
  function handleGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const key = e.key.toLowerCase();
    const isCopyPasteChord =
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (key === "c" || key === "v");
    const isExpandChord = matchesBinding(e, expandCellCombo);
    if (
      (e.ctrlKey || e.metaKey || e.altKey) &&
      !isCopyPasteChord &&
      !isExpandChord
    )
      return;
    if (editing.inlineEdit || editing.fkEditCell) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) {
      return;
    }
    if (isCopyPasteChord) {
      e.preventDefault();
      handleCopyPasteChord(key as "c" | "v");
      return;
    }
    if (isExpandChord) {
      e.preventDefault();
      const cell = resolveTargetCell();
      if (cell) {
        editing.openHeavyEditor(
          cell.rowValues,
          cell.column,
          rawCellText(cell.value, bitColNames.has(cell.column.name), bitDisplay),
        );
      }
      return;
    }
    const rows = grid.table.getRowModel().rows;
    const colCount = grid.table.getVisibleLeafColumns().length;
    if (rows.length === 0 || colCount === 0) return;

    const focusCell = (r: number, c: number) => {
      setActiveCell({ r, c });
      setSelectedRowIndex(r);
      // With virtualized rows, target row `r` may have no DOM node at all yet
      // (it's outside the currently-mounted window) — `scrollToIndex` mounts
      // it (a no-op if it's already in view). Keep the cell in view without
      // smooth scrolling (instant per the no-motion-on-keyboard rule); two
      // nested frames give React's render (triggered by the virtualizer's own
      // scroll-driven state update) time to actually mount the row before the
      // `querySelector` below runs — a single frame can race it on a jump of
      // more than a screenful of rows.
      grid.rowVirtualizer.scrollToIndex(r, { align: "auto" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          grid.scrollRef.current
            ?.querySelector<HTMLElement>(`[data-cell="${r}-${c}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      });
    };

    if (e.key === "Escape") {
      if (activeCell) {
        e.preventDefault();
        setActiveCell(null);
      }
      return;
    }

    const navKeys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
    ];

    // First nav keypress with no active cell just anchors at the top-left
    // rather than jumping a step past it.
    if (!activeCell) {
      if (navKeys.includes(e.key)) {
        e.preventDefault();
        focusCell(0, 0);
      }
      return;
    }

    if (e.key === "Enter") {
      const row = rows[activeCell.r];
      const cell = row?.getVisibleCells()[activeCell.c];
      const bi = cell ? (grid.columnIndexByName.get(cell.column.id) ?? -1) : -1;
      if (!row || bi < 0) return;
      e.preventDefault();
      editing.openCellEdit(row.original as CellValue[], grid.columns[bi]);
      return;
    }

    let { r, c } = activeCell;
    switch (e.key) {
      case "ArrowDown":
        r = Math.min(r + 1, rows.length - 1);
        break;
      case "ArrowUp":
        r = Math.max(r - 1, 0);
        break;
      case "ArrowRight":
        c = Math.min(c + 1, colCount - 1);
        break;
      case "ArrowLeft":
        c = Math.max(c - 1, 0);
        break;
      case "Home":
        c = 0;
        break;
      case "End":
        c = colCount - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusCell(r, c);
  }

  return { activeCell, setActiveCell, handleGridKeyDown };
}
