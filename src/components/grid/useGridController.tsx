/**
 * The one controller that acts on a {@link GridSource} (ADR #135).
 *
 * A source decides what may be written and how; this hook does it, the same
 * way for every source: it saves cells and fields, removes fields, stages and
 * confirms deletes, plans and confirms pastes, runs the inline draft row for
 * insert and duplicate, reloads after each write, and reports the selection to
 * the status bar. It hands back the `DataGrid` props that wire all of that,
 * and the dialogs to render beside the grid.
 *
 * It wires a gesture only when the source's capability is available, and
 * performs it only through the operations that capability carries — there is
 * no path from a blocked gesture to a write.
 *
 * What it reloads after a write is part of the behaviour, not a detail:
 *
 * - a cell or field save, and a field removal, reload the **page** — the row
 *   count cannot have changed;
 * - a delete, a paste (it may add rows) and an insert reload **all** — the
 *   page and the total.
 *
 * The chrome around the grid — toolbar entries, pagination, the browse's own
 * dialogs — stays with whoever renders it; only what acts on rows is here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { usePreferences } from "@/stores/preferences/preferences";
import { useGridSelection } from "@/stores/grid/gridSelection";
import { DeleteRowsDialog } from "@/components/grid/dialogs/DeleteRowsDialog";
import { PasteCellsDialog } from "@/components/grid/dialogs/PasteCellsDialog";
import {
  opsOf,
  reasonOf,
  type ColumnLock,
  type DraftCommitOps,
  type GridSource,
} from "@/lib/grid/gridSource";
import type { PastePlan } from "@/lib/grid/pastePlan";
import type { GridPaste } from "@/lib/grid/useGridKeyboardNav";
import type { CellValue, DraftCell, DraftRow, RowValue } from "@/types";

export interface GridControllerOptions {
  /** The owning tab — the selection report is scoped to it. */
  tabId: string;
  /** Report the selection to the status bar (default on). */
  reportSelection?: boolean;
  /**
   * Where a gesture that cannot even start says why — a row whose key cannot
   * be read. Server refusals are not routed here: each dialog shows its own in
   * place, and an unconfirmed delete raises a toast.
   */
  onError: (message: string) => void;
}

/** The `DataGrid` props the controller owns. Spread them onto the grid. */
export interface GridControllerProps {
  editable: boolean;
  columnLock: ColumnLock | undefined;
  draftColumnLock: ColumnLock | undefined;
  pkColumnNames: string[] | undefined;
  getRowKey: ((row: CellValue[]) => string | null) | undefined;
  onSelectionChange: ((count: number, total: number) => void) | undefined;
  onCellSave:
    | ((row: CellValue[], column: string, value: string | null) => Promise<void>)
    | undefined;
  onFieldSave:
    | ((
        row: CellValue[],
        path: string[],
        value: string | null,
        typeHint?: string,
      ) => Promise<void>)
    | undefined;
  onFieldDelete: ((row: CellValue[], path: string[]) => Promise<void>) | undefined;
  onNavigateFk: ((column: string, value: CellValue) => void) | undefined;
  onPasteBlock: ((paste: GridPaste) => Promise<void>) | undefined;
  onDeleteRow: ((row: CellValue[]) => void) | undefined;
  onBulkDelete: ((rows: CellValue[][]) => void) | undefined;
  onInsertRow: (() => void) | undefined;
  insertBlocked: string | null;
  onDuplicateRow: ((row: CellValue[]) => Promise<void>) | undefined;
  draftRow: DraftRow | null;
  onDraftCellChange: (column: string, cell: DraftCell) => void;
  onDraftCommit: () => Promise<void>;
  onDraftCancel: () => void;
}

export interface GridController {
  gridProps: GridControllerProps;
  /** The delete and paste confirmations, to render beside the grid. */
  dialogs: React.ReactNode;
}

/** A draft row and the operations that will commit it — those of the gesture
 *  that started it, so a duplicate commits even where Insert is blocked. */
interface DraftState {
  row: DraftRow;
  commit: DraftCommitOps;
}

export function useGridController(
  source: GridSource,
  { tabId, reportSelection = true, onError }: GridControllerOptions,
): GridController {
  const { t } = useTranslation();
  const { refreshPage, refreshAll, keyOf, hydrate } = source;
  const update = opsOf(source.update);
  const del = opsOf(source.delete);
  const insert = opsOf(source.insert);
  const duplicate = opsOf(source.duplicate);
  const paste = opsOf(source.paste);
  const unset = opsOf(source.fieldUnset);
  const fk = opsOf(source.fkNavigate);

  // --- selection --------------------------------------------------------------
  const report = useGridSelection((s) => s.report);
  const clearSelection = useGridSelection((s) => s.clear);
  const onSelectionChange = useCallback(
    (count: number, total: number) => report(tabId, count, total),
    [report, tabId],
  );
  // Drop this tab's entry when it unmounts (close / disconnect) so the status
  // bar never reads a stale count.
  useEffect(() => () => clearSelection(tabId), [tabId, clearSelection]);

  // --- saves ------------------------------------------------------------------
  /**
   * A list-view field save, and the base of the cell save below. Keyed on the
   * operation itself, not on the ops object around it (rebuilt whenever any
   * capability moves), so it is exactly as stable as the source's `saveField`.
   */
  const saveField = update?.saveField;
  const onFieldSave = useCallback(
    async (
      row: CellValue[],
      path: string[],
      value: string | null,
      typeHint?: string,
    ) => {
      if (!saveField) return;
      await saveField(row, path, value, typeHint);
      await refreshPage();
    },
    [saveField, refreshPage],
  );

  /**
   * A table-view cell save: one column, no type hint of its own. This has to
   * be as stable as `onFieldSave`: it reaches `useGridColumns` as
   * `onCellSave`, whose whole `columns` array — and the table body with it —
   * is rebuilt every time this identity changes.
   */
  const onCellSave = useCallback(
    (row: CellValue[], column: string, value: string | null) =>
      onFieldSave(row, [column], value),
    [onFieldSave],
  );

  const unsetField = unset?.unsetField;
  const onFieldDelete = useCallback(
    async (row: CellValue[], path: string[]) => {
      if (!unsetField) return;
      await unsetField(row, path);
      await refreshPage();
    },
    [unsetField, refreshPage],
  );

  // --- delete -----------------------------------------------------------------
  /** One tuple per row to delete, each in the target's key order. A
   *  single-row delete is a one-element list: one path for one and many. */
  const [pendingDelete, setPendingDelete] = useState<CellValue[][] | null>(null);

  const deleteRows = del?.deleteRows;
  /** Perform the delete and reload. Rejects when the server refuses: the
   *  dialog says why in place, and without a dialog the caller toasts. */
  const runDelete = useCallback(
    async (pkValueRows: CellValue[][]) => {
      if (!deleteRows) return;
      await deleteRows(pkValueRows);
      setPendingDelete(null);
      await refreshAll();
    },
    [deleteRows, refreshAll],
  );

  /** With `ui.confirmDestructive` on (default) open the confirmation; off,
   *  delete straight away — skipping the prompt is the toggle's purpose. */
  const requestDelete = useCallback(
    (pkValueRows: CellValue[][]) => {
      if (pkValueRows.length === 0) return;
      if (usePreferences.getState().prefs.ui.confirmDestructive) {
        setPendingDelete(pkValueRows);
      } else {
        void runDelete(pkValueRows).catch((e: unknown) =>
          notify.error(t("tableData.deleteFailedTitle"), {
            description: String(e),
          }),
        );
      }
    },
    [runDelete, t],
  );

  const onDeleteRows = useCallback(
    (rows: CellValue[][]) => {
      try {
        requestDelete(rows.map((r) => keyOf(r)));
      } catch (e) {
        onError(String(e));
      }
    },
    [requestDelete, keyOf, onError],
  );
  const onDeleteRow = useCallback(
    (row: CellValue[]) => onDeleteRows([row]),
    [onDeleteRows],
  );

  // --- paste (ADR #114) -------------------------------------------------------
  const [pendingPaste, setPendingPaste] = useState<PastePlan | null>(null);

  /**
   * Work out what a pasted block writes and ask before sending any of it. The
   * plan compares each target cell with what is there to skip the ones that
   * would not change, so it needs the rows whole: a value the page left on the
   * server stands in as `null`, which is not what is there (ADR #133).
   */
  const planPaste = paste?.planPaste;
  const onPasteBlock = useCallback(
    async (block: GridPaste) => {
      if (!planPaste) return;
      const rows = await Promise.all(block.rows.map(hydrate)).catch(() => null);
      if (!rows) return;
      setPendingPaste(planPaste(block, rows));
    },
    [planPaste, hydrate],
  );

  const applyPasteOp = paste?.applyPaste;
  const applyPaste = useCallback(
    async (plan: PastePlan) => {
      if (!applyPasteOp) return;
      const summary = await applyPasteOp(plan);
      setPendingPaste(null);
      notify.success(
        t("dataGrid.paste.done", {
          cells: summary.updated,
          count: summary.inserted,
        }),
      );
      await refreshAll();
    },
    [applyPasteOp, refreshAll, t],
  );

  // --- insert / duplicate: the inline draft row -------------------------------
  /**
   * Rather than a dialog, the grid renders a draft row pinned to the top: Tab
   * moves between fields, Esc cancels, leaving the row (or Enter) commits. A
   * refused insert keeps the draft with the server's error, so nothing typed
   * is lost.
   */
  const [draft, setDraft] = useState<DraftState | null>(null);

  const onInsertRow = useCallback(() => {
    if (draft || !insert) return;
    setDraft({ row: insert.newDraft(), commit: insert });
  }, [draft, insert]);

  const onDuplicateRow = useCallback(
    async (original: CellValue[]) => {
      if (draft || !duplicate) return;
      // A copy of a cut cell would insert the `null` that stands in for it.
      const row = await hydrate(original).catch(() => null);
      if (!row) return;
      setDraft({ row: duplicate.duplicateDraft(row), commit: duplicate });
    },
    [draft, duplicate, hydrate],
  );

  const onDraftCellChange = useCallback((column: string, cell: DraftCell) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            row: {
              ...prev.row,
              cells: { ...prev.row.cells, [column]: cell },
              error: null,
            },
          }
        : prev,
    );
  }, []);

  const onDraftCancel = useCallback(() => setDraft(null), []);

  const setDraftRow = (patch: Partial<DraftRow>) =>
    setDraft((prev) => (prev ? { ...prev, row: { ...prev.row, ...patch } } : prev));

  const onDraftCommit = useCallback(async () => {
    if (!draft || draft.row.saving) return;
    const { commit } = draft;
    const values: RowValue[] = Object.entries(draft.row.cells)
      .filter(([column, c]) => c.touched && !commit.columnLock?.(column))
      .map(([column, c]) => ({
        column,
        value: c.value,
        // A per-cell type wins: the list view's draft card lets a MongoDB
        // field be written as a chosen BSON type, and only the cell knows it.
        columnType: c.type ?? commit.columnType(column),
      }));
    // Nothing typed → cancel rather than send an `INSERT () VALUES ()` the
    // backend would reject.
    if (values.length === 0) {
      setDraft(null);
      return;
    }
    setDraftRow({ saving: true, error: null });
    try {
      await commit.insertRow(values);
      setDraft(null);
      await refreshAll();
    } catch (e) {
      setDraftRow({ saving: false, error: String(e) });
    }
  }, [draft, refreshAll]);

  // --- wiring -----------------------------------------------------------------
  const gridProps: GridControllerProps = {
    editable: !!update,
    columnLock: update?.columnLock,
    // The open draft's own locks; with none open, Insert's — the grid reads
    // them to tell "locked" from "only when adding a row" in its headers.
    draftColumnLock: draft ? draft.commit.columnLock : insert?.columnLock,
    pkColumnNames: source.pkResultNames,
    getRowKey: source.getRowKey,
    onSelectionChange: reportSelection ? onSelectionChange : undefined,
    onCellSave: update ? onCellSave : undefined,
    onFieldSave: update ? onFieldSave : undefined,
    onFieldDelete: unset ? onFieldDelete : undefined,
    onNavigateFk: fk?.navigateFk,
    onPasteBlock: paste ? onPasteBlock : undefined,
    onDeleteRow: del ? onDeleteRow : undefined,
    onBulkDelete: del ? onDeleteRows : undefined,
    onInsertRow: insert ? onInsertRow : undefined,
    insertBlocked: reasonOf(source.insert),
    onDuplicateRow: duplicate ? onDuplicateRow : undefined,
    draftRow: draft?.row ?? null,
    onDraftCellChange,
    onDraftCommit,
    onDraftCancel,
  };

  const dialogs = useMemo(
    () => (
      <>
        {pendingPaste && paste && (
          <PasteCellsDialog
            plan={pendingPaste}
            table={paste.relationLabel}
            documentMode={source.documentMode}
            onApply={() => applyPaste(pendingPaste)}
            onClose={() => setPendingPaste(null)}
          />
        )}
        {pendingDelete && del && (
          <DeleteRowsDialog
            connectionId={del.target.connectionId}
            schema={del.target.schema}
            table={del.target.table}
            pkColumns={del.target.pkColumns}
            pkValueRows={pendingDelete}
            onDelete={() => runDelete(pendingDelete)}
            onClose={() => setPendingDelete(null)}
          />
        )}
      </>
    ),
    [
      pendingPaste,
      pendingDelete,
      paste,
      del,
      source.documentMode,
      applyPaste,
      runDelete,
    ],
  );

  return { gridProps, dialogs };
}
