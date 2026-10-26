/**
 * One editable control for a draft (INSERT) cell.
 *
 * Extracted because the grid now has **two** insert surfaces that must build
 * the same INSERT: the table view's pinned draft row (`DraftRowView`) and the
 * list view's draft document card (`DraftDocumentCard`). The choice of control
 * is entirely column-driven and carries real correctness baggage — an
 * auto-generated PK offers nothing to type, a single-column FK must pick an
 * existing referenced value, and a BIT column has to emit the numeric string
 * the backend's `CAST(? AS UNSIGNED)` expects (gotcha #15) — so duplicating
 * the branch per surface would have been a silent-drift hazard, not a
 * cosmetic one.
 *
 * Commit / cancel are deliberately NOT wired here: both call sites own those
 * at the row / card level (Enter commits the whole draft, Esc discards it), so
 * `CellInput` is mounted unwired and the container's `onKeyDown` / `onBlur` do
 * the work.
 */

import type { MutableRefObject } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PolicyLockHint } from "@/components/common/PolicyLock";
import { BitInput } from "@/components/grid/BitInput";
import { CellInput } from "@/components/grid/CellInput";
import { FkCombobox } from "@/components/grid/FkCombobox";
import { isBitType } from "@/lib/grid/columnKinds";
import type { ColumnInfo, ColumnMeta, DraftCell } from "@/types";

/**
 * Whether the database generates this column's value on insert, so the draft
 * shows an "auto" placeholder instead of a control.
 *
 * Deliberately conservative: only an integer-ish primary key. A `uuid` or
 * `varchar` PK may well have no default, and hiding its input would make the
 * row impossible to insert.
 */
export function isAutoPkColumn(info?: ColumnInfo): boolean {
  return !!info?.is_primary_key && /int|serial|rowid/i.test(info.data_type);
}

/**
 * Index of the first column a draft can actually focus — the first one that
 * isn't database-generated. Shared with the same intent as the control itself:
 * both insert surfaces autofocus "the first cell you can type into", and an
 * `id` column would otherwise swallow the focus.
 */
export function firstEditableColumn(
  columns: ColumnMeta[],
  infoByName: Map<string, ColumnInfo>,
  columnLock?: (column: string) => string | null,
): number {
  for (let i = 0; i < columns.length; i++) {
    // A column the policy will not let this person fill is not focusable.
    if (columnLock?.(columns[i].name)) continue;
    const info = infoByName.get(columns[i].name);
    // No catalog info → a plain input, which is focusable.
    if (!info) return i;
    if (!isAutoPkColumn(info)) return i;
  }
  return 0;
}

interface DraftCellControlProps {
  /** Catalog info for the column, when the tab managed to describe the table.
   *  Absent → a plain text input (the safe fallback). */
  info?: ColumnInfo;
  cell: DraftCell;
  /** The draft is being sent; every control locks. */
  saving: boolean;
  /** This is the draft's first editable cell — claims the autofocus slot. */
  autoFocus?: boolean;
  /** Receives the focusable element for whichever control was rendered, so the
   *  caller can focus it once the draft mounts. */
  focusRef?: MutableRefObject<HTMLElement | null>;
  /** Connection + schema, required for an FK combobox to query its options. */
  connectionId?: string;
  tableSchema?: string;
  /** Grid preference for BIT option labels. */
  bitDisplay: "true_false" | "zero_one";
  /**
   * Why the managed policy will not let the person give this column a value
   * (ADR #113). The cell then shows a lock instead of a control and is left
   * out of the INSERT, so the database fills it.
   */
  locked?: string | null;
  onChange: (cell: DraftCell) => void;
}

export function DraftCellControl({
  info,
  cell,
  saving,
  autoFocus,
  focusRef,
  connectionId,
  tableSchema,
  bitDisplay,
  locked,
  onChange,
}: DraftCellControlProps) {
  const { t } = useTranslation();
  if (locked && !isAutoPkColumn(info)) {
    return (
      <PolicyLockHint reason={`${locked} ${t("dataGrid.draftLocked")}`}>
        <span className="flex items-center gap-1 px-1 font-mono text-2xs text-muted-foreground/60">
          <Lock aria-hidden className="h-2.5 w-2.5 shrink-0" />—
        </span>
      </PolicyLockHint>
    );
  }
  if (isAutoPkColumn(info)) {
    return (
      <span
        className="block px-1 font-mono text-2xs italic text-muted-foreground/60"
        title={t("dataGrid.autoValueHint")}
      >
        {t("dataGrid.autoValue")}
      </span>
    );
  }

  // Single-column FK: pick a valid referenced value instead of typing one. The
  // combobox owns its own NULL handling when the column is nullable — a
  // deliberate pick from the dropdown's own NULL option, not a stray button.
  if (info?.referenced_table && connectionId) {
    return (
      <FkCombobox
        ref={focusRef as MutableRefObject<HTMLButtonElement | null> | undefined}
        connectionId={connectionId}
        refSchema={info.referenced_schema ?? tableSchema ?? undefined}
        refTable={info.referenced_table}
        refColumn={info.referenced_column ?? "id"}
        value={cell.value}
        nullable={info.nullable}
        disabled={saving}
        onChange={(v) => onChange({ ...cell, value: v, touched: true })}
      />
    );
  }

  // BIT column: dedicated 0/1 control instead of a text field. Emits the
  // numeric string the backend's CAST expects and seeds a non-null column to 0
  // (gotcha #15).
  if (info && isBitType(info.data_type)) {
    return (
      <BitInput
        autoFocus={autoFocus}
        value={cell.value}
        bitDisplay={bitDisplay}
        nullable={info.nullable}
        disabled={saving}
        seedDefault={!info.nullable}
        onSelect={(v) => onChange({ ...cell, value: v, touched: true })}
      />
    );
  }

  return (
    <CellInput
      ref={focusRef as MutableRefObject<HTMLInputElement | null> | undefined}
      value={cell.value}
      disabled={saving}
      onChange={(v) => onChange({ ...cell, value: v, touched: true })}
    />
  );
}
