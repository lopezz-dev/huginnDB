/**
 * The insert-draft row rendered at the top of the grid.
 *
 * Commit fires when focus leaves the row entirely (the user clicks outside):
 * a `setTimeout(0)` after `onBlur` checks whether `document.activeElement` is
 * still inside the row, since blur alone cannot tell "moved to the next cell"
 * from "left the row". `Esc` cancels; `Enter` commits explicitly.
 */

import { useMemo } from "react";

import {
  DraftCellControl,
  firstEditableColumn,
} from "@/components/grid/DraftCellControl";
import type { ColumnInfo, ColumnMeta, DraftCell, DraftRow } from "@/types";

interface DraftRowViewProps {
  rowRef: React.MutableRefObject<HTMLTableRowElement | null>;
  firstInputRef: React.MutableRefObject<HTMLElement | null>;
  columns: ColumnMeta[];
  draftColumns: ColumnInfo[];
  draft: DraftRow;
  /** Connection + target table — required for FK comboboxes to query options. */
  connectionId?: string;
  tableSchema?: string;
  tableName?: string;
  /** Grid preference for BIT option labels in the dedicated control. */
  bitDisplay: "true_false" | "zero_one";
  /** Why the policy will not let the person fill a column (ADR #113). */
  columnLock?: (column: string) => string | null;
  onChange?: (column: string, cell: DraftCell) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}

export function DraftRowView({
  rowRef,
  firstInputRef,
  columns,
  draftColumns,
  draft,
  connectionId,
  tableSchema,
  tableName: _tableName,
  bitDisplay,
  columnLock,
  onChange,
  onCommit,
  onCancel,
}: DraftRowViewProps) {
  const infoByName = useMemo(() => {
    const m = new Map<string, ColumnInfo>();
    for (const c of draftColumns) m.set(c.name, c);
    return m;
  }, [draftColumns]);

  /** First non-auto-PK column index — used to bind the focus-on-mount ref. */
  const firstEditableIdx = useMemo(
    () => firstEditableColumn(columns, infoByName, columnLock),
    [columns, infoByName, columnLock],
  );

  function handleRowBlur() {
    // Wait one tick for focus to settle on the new target.
    setTimeout(() => {
      if (draft.saving) return;
      const active = document.activeElement;
      if (rowRef.current && active && rowRef.current.contains(active)) return;
      onCommit?.();
    }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onCommit?.();
    }
  }

  return (
    <>
      <tr
        ref={rowRef}
        className="border-l-2 border-l-primary bg-primary/5"
        onBlur={handleRowBlur}
        onKeyDown={handleKeyDown}
      >
        <td className="border-b border-border/50 border-r border-r-border/70 px-2 py-1 text-3xs font-medium text-primary">
          {draft.saving ? "…" : "+"}
        </td>
        {columns.map((col, idx) => {
          const cell: DraftCell = draft.cells[col.name] ?? {
            value: null,
            touched: false,
          };
          return (
            <td
              key={col.name}
              className="border-b border-border/50 border-r border-r-border/70 px-1 py-0.5"
            >
              {/* Row-level onBlur / onKeyDown drive commit & cancel, so the
                  control itself is mounted unwired. */}
              <DraftCellControl
                info={infoByName.get(col.name)}
                cell={cell}
                saving={draft.saving}
                autoFocus={idx === firstEditableIdx}
                focusRef={idx === firstEditableIdx ? firstInputRef : undefined}
                connectionId={connectionId}
                tableSchema={tableSchema}
                bitDisplay={bitDisplay}
                locked={columnLock?.(col.name)}
                onChange={(next) => onChange?.(col.name, next)}
              />
            </td>
          );
        })}
        <td className="border-b border-border/50" />
      </tr>
      {draft.error && (
        <tr>
          <td
            colSpan={columns.length + 2}
            className="border-b border-border/50 bg-destructive/10 px-3 py-1 text-2xs text-destructive"
          >
            {draft.error}
            <button
              className="ml-3 underline-offset-2 hover:underline"
              onClick={() => onCancel?.()}
            >
              discard
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
