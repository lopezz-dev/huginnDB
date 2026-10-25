/**
 * Confirm a block pasted into the grid (ADR #114): what it will change, what
 * it will add, and — cell by cell, per column — what it leaves out and why,
 * before anything is written. One click applies the writable part; nothing is
 * applied half-way, because the backend writes it in one transaction.
 *
 * Mount it only while a paste is pending, like `DeleteRowsDialog`:
 * `useAsyncSubmit` leaves `submitting` set after a success on the assumption
 * that the dialog goes away.
 */

import { useTranslation } from "react-i18next";
import { Info, Lock, TriangleAlert } from "lucide-react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import type { PastePlan, SkipReason } from "@/lib/grid/pastePlan";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { cn } from "@/lib/utils";

export function PasteCellsDialog({
  plan,
  table,
  documentMode,
  onApply,
  onClose,
}: {
  plan: PastePlan;
  /** `schema.table`, for the description. */
  table: string;
  /** MongoDB: the write is one transaction only where the server runs them. */
  documentMode: boolean;
  /** Sends the plan's writes and refreshes; rejects on failure. */
  onApply: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { submitting, error, run } = useAsyncSubmit();
  const cells = plan.updates.length;
  const rows = plan.inserts.length;
  const nothing = cells === 0 && rows === 0;
  const blocked = plan.skipped.reduce((n, s) => n + s.count, 0);

  const reasonText = (reason: SkipReason) => t(`dataGrid.paste.reason.${reason}`);

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent tier="prompt">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("dataGrid.paste.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <DialogDescription className="text-xs">
            {nothing ? (
              t("dataGrid.paste.nothing")
            ) : (
              <>
                {t("dataGrid.paste.in")} <span className="font-mono">{table}</span>:{" "}
                {[
                  cells > 0 &&
                    t("dataGrid.paste.cells", { count: cells, rows: plan.rowsChanged }),
                  rows > 0 && t("dataGrid.paste.rows", { count: rows }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                .
              </>
            )}
          </DialogDescription>

          {plan.preview.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-2xs">
                <thead className="bg-muted/40 text-3xs text-muted-foreground">
                  <tr>
                    {plan.previewColumns.map((c) => (
                      <th key={c} className="px-2 py-1 text-left font-mono font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plan.preview.map((row, r) => (
                    <tr key={r} className="border-t border-border">
                      {row.map((cell, c) => (
                        <td
                          key={c}
                          className={cn(
                            "max-w-[12rem] truncate px-2 py-1 font-mono",
                            cell.state === "skip" && "text-muted-foreground line-through",
                            cell.state === "same" && "text-muted-foreground",
                            cell.state === "new" && "text-success",
                          )}
                        >
                          {cell.text === "" ? "∅" : cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.blockRows > plan.preview.length && (
                <p className="border-t border-border px-2 py-1 text-3xs text-muted-foreground">
                  {t("dataGrid.paste.moreRows", { count: plan.blockRows - plan.preview.length })}
                </p>
              )}
            </div>
          )}

          {blocked > 0 && (
            <div className="space-y-1 rounded-md border border-border px-3 py-2 text-2xs">
              <p className="flex items-center gap-1.5 font-medium">
                <Lock aria-hidden className="h-3 w-3 shrink-0" />
                {t("dataGrid.paste.skipped", { count: blocked })}
              </p>
              <ul className="space-y-0.5 pl-4 text-muted-foreground">
                {plan.skipped.map((s) => (
                  <li key={`${s.column}:${s.reason}`}>
                    <span className="font-mono text-foreground">{s.column}</span>{" "}
                    {t("dataGrid.paste.skippedCount", { count: s.count })} —{" "}
                    {reasonText(s.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(plan.unchanged > 0 || plan.droppedColumns > 0) && (
            <p className="text-3xs text-muted-foreground">
              {[
                plan.unchanged > 0 && t("dataGrid.paste.unchanged", { count: plan.unchanged }),
                plan.droppedColumns > 0 &&
                  t("dataGrid.paste.dropped", { count: plan.droppedColumns }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}

          {plan.missingOnInsert.length > 0 && (
            <p className="flex items-start gap-1.5 text-2xs text-warning">
              <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
              {t("dataGrid.paste.missing", {
                columns: plan.missingOnInsert.join(", "),
                count: plan.missingOnInsert.length,
              })}
            </p>
          )}

          {!nothing && (
            <p className="flex items-start gap-1.5 text-3xs text-muted-foreground">
              <Info aria-hidden className="mt-px h-3 w-3 shrink-0" />
              {documentMode ? t("dataGrid.paste.atomicMongo") : t("dataGrid.paste.atomic")}
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive">
              {t("dataGrid.paste.failed", { message: error })}
            </p>
          )}
        </DialogBody>
        <DialogActions
          onCancel={onClose}
          cancelLabel={nothing ? t("common.close") : t("common.cancel")}
          confirmLabel={
            blocked > 0 ? t("dataGrid.paste.applyAllowed") : t("dataGrid.paste.apply")
          }
          confirmingLabel={t("dataGrid.paste.applying")}
          confirming={submitting}
          confirmDisabled={nothing}
          onConfirm={() => run(onApply)}
        />
      </DialogContent>
    </Dialog>
  );
}
