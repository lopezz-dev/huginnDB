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
import type { GridSource } from "@/lib/grid/gridSource";
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
  columnLock: ((column: string) => string | null) | undefined;
  draftColumnLock: ((column: string) => string | null) | undefined;
  pkColumnNames: string[] | undefined;
  getRowKey: (row: CellValue[]) => string | null;
  onSelectionChange: ((count: number, total: number) => void) | undefined;
  onCellSave: (row: CellValue[], column: string, value: string | null) => Promise<void>;
  onFieldSave: (
    row: CellValue[],
    path: string[],
    value: string | null,
    typeHint?: string,
  ) => Promise<void>;
  onFieldDelete: ((row: CellValue[], path: string[]) => Promise<void>) | undefined;
  onNavigateFk: (column: string, value: CellValue) => void;
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

export function useGridController(
  source: GridSource,
  { tabId, reportSelection = true, onError }: GridControllerOptions,
): GridController {
  const { t } = useTranslation();
  const { can, identity } = source;

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
   * A list-view field save, and the base of the cell save below. Its identity
   * follows the source's `saveField`, which only moves when what it closes
   * over does.
   */
  const onFieldSave = useCallback(
    async (
      row: CellValue[],
      path: string[],
      value: string | null,
      typeHint?: string,
    ) => {
      await source.saveField(row, path, value, typeHint);
      await source.refreshPage();
    },
    // `source` itself is rebuilt whenever any of its parts move; depending on
    // the two parts used keeps this as stable as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.saveField, source.refreshPage],
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

  const onFieldDelete = useCallback(
    async (row: CellValue[], path: string[]) => {
      await source.unsetField(row, path);
      await source.refreshPage();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.unsetField, source.refreshPage],
  );

  // --- delete -----------------------------------------------------------------
  /** One tuple per row to delete, each parallel to `identity.pkColumns`. A
   *  single-row delete is a one-element list: one path for one and many. */
  const [pendingDelete, setPendingDelete] = useState<CellValue[][] | null>(null);

  /** Perform the delete and reload. Rejects when the server refuses: the
   *  dialog says why in place, and without a dialog the caller toasts. */
  const runDelete = useCallback(
    async (pkValueRows: CellValue[][]) => {
      if (!identity) return;
      await source.deleteRows(pkValueRows);
      setPendingDelete(null);
      await source.refreshAll();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, source.deleteRows, source.refreshAll],
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
        requestDelete(rows.map((r) => source.keyOf(r)));
      } catch (e) {
        onError(String(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestDelete, source.keyOf, onError],
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
  const onPasteBlock = useCallback(
    async (paste: GridPaste) => {
      const rows = await Promise.all(paste.rows.map(source.hydrate)).catch(
        () => null,
      );
      if (!rows) return;
      setPendingPaste(source.planPaste(paste, rows));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.hydrate, source.planPaste],
  );

  const applyPaste = useCallback(
    async (plan: PastePlan) => {
      const summary = await source.applyPaste(plan);
      setPendingPaste(null);
      notify.success(
        t("dataGrid.paste.done", {
          cells: summary.updated,
          count: summary.inserted,
        }),
      );
      await source.refreshAll();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.applyPaste, source.refreshAll, t],
  );

  // --- insert / duplicate: the inline draft row -------------------------------
  /**
   * Rather than a dialog, the grid renders a draft row pinned to the top: Tab
   * moves between fields, Esc cancels, leaving the row (or Enter) commits. A
   * refused insert keeps the draft with the server's error, so nothing typed
   * is lost.
   */
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const onInsertRow = useCallback(() => {
    if (draft) return;
    const next = source.newDraft();
    if (next) setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, source.newDraft]);

  const onDuplicateRow = useCallback(
    async (original: CellValue[]) => {
      if (draft) return;
      // A copy of a cut cell would insert the `null` that stands in for it.
      const row = await source.hydrate(original).catch(() => null);
      if (!row) return;
      const next = source.duplicateDraft(row);
      if (next) setDraft(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, source.hydrate, source.duplicateDraft],
  );

  const onDraftCellChange = useCallback((column: string, cell: DraftCell) => {
    setDraft((prev) =>
      prev
        ? { ...prev, cells: { ...prev.cells, [column]: cell }, error: null }
        : prev,
    );
  }, []);

  const onDraftCancel = useCallback(() => setDraft(null), []);

  const onDraftCommit = useCallback(async () => {
    if (!draft || draft.saving) return;
    const values: RowValue[] = Object.entries(draft.cells)
      .filter(([column, c]) => c.touched && !can.insertColumnLock?.(column))
      .map(([column, c]) => ({
        column,
        value: c.value,
        // A per-cell type wins: the list view's draft card lets a MongoDB
        // field be written as a chosen BSON type, and only the cell knows it.
        columnType: c.type ?? source.columnType(column),
      }));
    // Nothing typed → cancel rather than send an `INSERT () VALUES ()` the
    // backend would reject.
    if (values.length === 0) {
      setDraft(null);
      return;
    }
    setDraft((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    try {
      await source.insertRow(values);
      setDraft(null);
      await source.refreshAll();
    } catch (e) {
      setDraft((prev) =>
        prev ? { ...prev, saving: false, error: String(e) } : prev,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, can.insertColumnLock, source.columnType, source.insertRow, source.refreshAll]);

  // --- wiring -----------------------------------------------------------------
  const gridProps: GridControllerProps = {
    editable: can.update === null,
    columnLock: can.updateColumnLock,
    draftColumnLock: can.insertColumnLock,
    pkColumnNames: source.pkResultNames,
    getRowKey: source.getRowKey,
    onSelectionChange: reportSelection ? onSelectionChange : undefined,
    onCellSave,
    onFieldSave,
    onFieldDelete: can.fieldUnset === null ? onFieldDelete : undefined,
    onNavigateFk: source.navigateFk,
    onPasteBlock: can.paste === null ? onPasteBlock : undefined,
    onDeleteRow: can.delete === null ? onDeleteRow : undefined,
    onBulkDelete: can.delete === null ? onDeleteRows : undefined,
    onInsertRow: can.insert === null ? onInsertRow : undefined,
    // The empty reason is "not decided yet": nothing to show.
    insertBlocked: can.insert || null,
    onDuplicateRow: can.duplicate === null ? onDuplicateRow : undefined,
    draftRow: draft,
    onDraftCellChange,
    onDraftCommit,
    onDraftCancel,
  };

  const qualified = identity
    ? `${identity.schema ? `${identity.schema}.` : ""}${identity.table}`
    : "";

  const dialogs = useMemo(
    () => (
      <>
        {pendingPaste && (
          <PasteCellsDialog
            plan={pendingPaste}
            table={qualified}
            documentMode={source.documentMode}
            onApply={() => applyPaste(pendingPaste)}
            onClose={() => setPendingPaste(null)}
          />
        )}
        {pendingDelete && identity && (
          <DeleteRowsDialog
            connectionId={identity.connectionId}
            schema={identity.schema}
            table={identity.table}
            pkColumns={identity.pkColumns}
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
      qualified,
      source.documentMode,
      identity,
      applyPaste,
      runDelete,
    ],
  );

  return { gridProps, dialogs };
}
