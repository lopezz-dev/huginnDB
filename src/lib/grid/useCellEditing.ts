import { useEffect, useState } from "react";
import { formatValue } from "@/lib/grid/formatValue";
import {
  useCellEditor,
  type CellBindingContext,
} from "@/stores/grid/cellEditor";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import type { FieldSave } from "@/components/grid/DocumentListView";
import type { CellValue, ColumnInfo, ColumnMeta } from "@/types";

/** A field addressed inside a document, for the MongoDB list view. */
export interface FieldRef {
  /** Path from the document root, e.g. `["customData", "format"]`. */
  path: string[];
  /** The field's BSON type, so the write preserves it (ADR #29). */
  type: string;
}

/** What the heavyweight Monaco modal is currently showing. */
export interface EditorTarget {
  rowValues: CellValue[];
  column: ColumnMeta;
  value: string;
  /**
   * Set when the editor was opened from the list view: the commit then goes
   * through `onFieldSave` (which can address a nested field) rather than
   * `onCellSave` (which only knows top-level columns).
   */
  field?: FieldRef;
}

/** The inline single-cell editor's live state. */
export interface InlineEdit {
  rowValues: CellValue[];
  column: ColumnMeta;
  /** The live draft. */
  value: string | null;
  /**
   * The value at activation. Used to skip a no-op save on blur — notably the
   * blur that fires while escalating to the modal via the expand button.
   */
  original: string | null;
}

/** The inline foreign-key combobox's anchor. */
export interface FkEdit {
  rowValues: CellValue[];
  column: ColumnMeta;
}

export type CellSave = (
  rowValues: CellValue[],
  column: string,
  value: string | null,
) => Promise<void>;

export interface CellEditingOptions {
  editable: boolean | undefined;
  connectionId: string | undefined;
  tableSchema: string | undefined;
  tableName: string | undefined;
  /** Tab that owns the docked side editor, so two tabs don't fight over it. */
  tabId: string | undefined;
  /** Modal or docked side panel, from the user's preference. */
  cellEditorMode: "modal" | "side";
  /** Catalog metadata by column name — what makes a cell an FK. */
  columnInfoByName: ReadonlyMap<string, ColumnInfo>;
  /** Backend index by column name; display order can differ. */
  columnIndexByName: ReadonlyMap<string, number>;
  onCellSave: CellSave | undefined;
  onFieldSave: FieldSave | undefined;
}

/**
 * Everything about *editing a cell*: which editor is open on which cell, and
 * the four entry points that decide between them.
 *
 * This is the grid's one genuinely separable sub-system — it owns state rather
 * than borrowing it, which is what keeps its signature honest. Four
 * `useState`s (the modal's open flag and target, the inline FK combobox, the
 * inline text editor) and the Escape listener that closes the FK overlay leave
 * `DataGrid` entirely; what comes back is the openers plus the live values the
 * `cell` renderer reads.
 *
 * **The routing in `openCellEdit` is ADR #12** and is why all four openers
 * live together: a double-click goes to an inline control, never straight to
 * the modal. Split them up and a future caller reaches `openModalEditor`
 * directly and quietly undoes that.
 *
 * **Identity is the row's values array, never a display index** (ADR #7).
 * `inlineEdit.rowValues === rowValues` is what the renderer compares, so an
 * edit survives a sort or filter reshuffle between activation and commit —
 * which a display index does not, since TanStack's `row.index` is the
 * *filtered* position while the parent resolves its primary key from the
 * unfiltered page.
 *
 * The returned functions are deliberately **not** memoised, matching what they
 * replaced. Their stability is already handled a layer up, by the
 * `interactiveRef` / `rowCallbacksRef` pair in `DataGrid`: memoising here as
 * well would add a second, weaker guarantee in front of the real one and
 * invite someone to trust it.
 */
export function useCellEditing(opts: CellEditingOptions) {
  const {
    editable,
    connectionId,
    tableSchema,
    tableName,
    tabId,
    cellEditorMode,
    columnInfoByName,
    columnIndexByName,
    onCellSave,
    onFieldSave,
  } = opts;

  /** Full Monaco editor (opened via CellPreview F11 or double-click). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  /**
   * Inline foreign-key editor anchored to a single cell. Activated on
   * double-click when the column carries a single-column FK constraint;
   * supersedes the Monaco dialog for that path so the user picks a value
   * without losing visual context.
   */
  const [fkEditCell, setFkEditCell] = useState<FkEdit | null>(null);
  /**
   * Inline single-cell editor (double-click on an editable, non-FK column).
   * Reuses the draft-row `CellInput` so editing an existing value feels
   * identical to typing a new one.
   */
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);

  // Escape exits the inline FK editor without committing. Click-outside
  // dismissal is handled by the combobox itself, but clicks land on the
  // panel's trigger button before the close listener fires; for that path the
  // user can press Esc or pick another cell.
  useEffect(() => {
    if (!fkEditCell) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFkEditCell(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fkEditCell]);

  /**
   * Coordinates for the JSON Schema cascade.
   *
   * `column.name` is the field's *dotted path* when the value came from the
   * document view (see `onExpandField`, which synthesises the column that
   * way), so a MongoDB nested binding needs nothing extra.
   *
   * Returns `undefined` without a table name: a query result has no column
   * identity, and a binding created there would be an accidental wildcard.
   */
  function bindingContextFor(
    column: ColumnMeta,
    field?: FieldRef,
  ): CellBindingContext | undefined {
    if (!tableName) return undefined;
    return {
      connectionId,
      dbSchema: tableSchema,
      table: tableName,
      column: column.name,
      bsonType: field?.type,
    };
  }

  /** Open the heavyweight Monaco modal directly (read-only view, or the
   *  "expand" escalation from the inline editor / CellPreview). */
  function openModalEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: FieldRef,
  ) {
    setEditorTarget({ rowValues, column, value, field });
    setEditorOpen(true);
  }

  /** Open the cell in the docked right-side editor (JetBrains-style). Shares
   *  the same commit path as the modal (`onCellSave`), or read-only when the
   *  grid isn't editable. */
  function openSidePanelEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: FieldRef,
  ) {
    // A list-view field commits through `onFieldSave` (it may be nested and
    // carries its own type); a table cell through `onCellSave` as before.
    const canSave = !!(editable && (field ? onFieldSave : onCellSave));
    useCellEditor.getState().open({
      ownerId: tabId,
      columnName: column.name,
      value,
      binding: bindingContextFor(column, field),
      readonly: !canSave,
      onSave: canSave
        ? (v) =>
            field
              ? onFieldSave!(rowValues, field.path, v, field.type)
              : onCellSave!(rowValues, column.name, v)
        : undefined,
    });
    useSessionPanelLayout.getState().openSideEditor();
  }

  /** Escalate from inline/preview to the heavyweight editor, honouring the
   *  user's `cellEditorMode` preference (modal vs docked side panel). */
  function openHeavyEditor(
    rowValues: CellValue[],
    column: ColumnMeta,
    value: string,
    field?: FieldRef,
  ) {
    if (cellEditorMode === "side") {
      openSidePanelEditor(rowValues, column, value, field);
    } else {
      openModalEditor(rowValues, column, value, field);
    }
  }

  /**
   * Double-click entry point (ADR #12). Routes to the right editor:
   * - single-column FK → inline combobox of valid referenced values;
   * - editable cell → inline `CellInput` (with an expand-to-modal affordance);
   * - read-only result grid → the Monaco modal as a viewer.
   */
  function openCellEdit(rowValues: CellValue[], column: ColumnMeta) {
    const info = columnInfoByName.get(column.name);
    if (editable && onCellSave && connectionId && info?.referenced_table) {
      setFkEditCell({ rowValues, column });
      return;
    }
    const cur = rowValues[columnIndexByName.get(column.name) ?? -1];
    const fmt = cur === null || cur === undefined ? null : formatValue(cur);
    if (editable && onCellSave) {
      setInlineEdit({ rowValues, column, value: fmt, original: fmt });
      return;
    }
    openModalEditor(rowValues, column, fmt ?? "");
  }

  return {
    editorOpen,
    setEditorOpen,
    editorTarget,
    fkEditCell,
    setFkEditCell,
    inlineEdit,
    setInlineEdit,
    bindingContextFor,
    openModalEditor,
    openSidePanelEditor,
    openHeavyEditor,
    openCellEdit,
  };
}
