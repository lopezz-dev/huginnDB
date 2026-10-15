/**
 * Shared "currently editing cell" state for the JetBrains-style side-panel
 * editor. The data grid and the side panel live in different React subtrees
 * (the panel is a split inside `IslandShell`, not a child of the grid's own
 * tab), so a small Zustand store is the clean bridge between "user asked to
 * edit this cell" and "the side panel renders it".
 *
 * The target carries the commit context as an `onSave` callback supplied by
 * the originating tab (the same `onCellSave` closure the modal already uses).
 * It is captured per open-session, so staleness is bounded to one edit — the
 * same contract the modal `CellEditor` relies on.
 *
 * Subscribe with the single-object selector `s => s.target` so the value stays
 * reference-stable between opens (gotcha #1).
 *
 * `close()` also hides the docked panel itself (`panelLayout.sideEditorOpen`)
 * — before the outer-shell redesign the panel was a dockview group with its
 * own close button, so clearing `target` alone left an empty-but-visible
 * panel for the user to dismiss separately; now the split's visibility IS
 * `sideEditorOpen`, so leaving it untouched here made every discard/save/tab-
 * closed path (all of which route through `close()`) unable to actually
 * dismiss the panel.
 */

import { create } from "zustand";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";

/**
 * Where the edited value lives, for the JSON Schema cascade.
 *
 * One nested object rather than five sibling fields, so the single-object
 * selector below stays reference-stable (gotcha #1) and so adding an axis later
 * touches one type instead of every call site.
 *
 * `connectionId` may still be a synthetic `<parent>::db::<db>` id here — the
 * store that resolves it folds it to the parent profile id, so callers pass
 * whatever the grid has.
 */
export interface CellBindingContext {
  connectionId?: string;
  /** Postgres schema, MySQL/MongoDB database, `main` on SQLite. */
  dbSchema?: string;
  table?: string;
  /**
   * Column name — or, for a MongoDB nested field, its dotted path, which is what
   * the document view already synthesises as the column name (ADR #29).
   */
  column: string;
  /** BSON type of the field, MongoDB only. */
  bsonType?: string;
}

export interface CellEditorTarget {
  /**
   * Id of the tab that opened this cell. The docked side panel lives outside
   * the tab's React subtree, so it uses this to close itself when the source
   * tab is closed (otherwise it lingers with a stale value). Absent for
   * targets with no owning tab.
   */
  ownerId?: string;
  /** Column label shown in the panel header. */
  columnName: string;
  /**
   * Coordinates for the JSON Schema binding, when the value came from a real
   * table. Absent for an ad-hoc query result, which has no column identity to
   * bind to — a binding created there would be an accidental wildcard.
   */
  binding?: CellBindingContext;
  /** Initial text value to edit. */
  value: string;
  /**
   * True when `value` is a live editor buffer being handed over rather than a
   * value freshly read from the grid — today that is only the modal's "move to
   * side panel". The side panel then seeds from it as-is instead of running
   * the auto-formatter over it.
   *
   * Two reasons, and either alone would be enough. **`formatXml` is not
   * idempotent**: it splits on `><`, which already-indented text no longer
   * contains, and its closing-tag test fails against a line with leading
   * spaces, so a second pass drifts the indentation. And semantically a
   * handover of a live buffer is the same kind of event as restoring a parked
   * session — the user's text, as they left it — not a fresh open.
   */
  preformatted?: boolean;
  /** When true the editor is a read-only viewer (no save button). */
  readonly?: boolean;
  /**
   * Commit handler. Absent for read-only targets. Receives the edited text;
   * the panel closes the editing session on success.
   */
  onSave?: (value: string) => Promise<void> | void;
}

interface CellEditorState {
  target: CellEditorTarget | null;
  open: (target: CellEditorTarget) => void;
  close: () => void;
}

export const useCellEditor = create<CellEditorState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => {
    set({ target: null });
    useSessionPanelLayout.getState().closeSideEditor();
  },
}));
