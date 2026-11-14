/**
 * The Summary tab of a batch (ADR #137): one line per statement — status,
 * preview, rows, time — under a header that tallies the batch or says where it
 * stopped. It used to sit above the results as a second list of the same
 * statements; now it is a tab, and a line opens its statement's own tab.
 */

import { useTranslation } from "react-i18next";
import { Check, CircleStop, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDuration } from "@/lib/utils";
import type { SummaryTab } from "@/lib/query/statementTabs";

export function SummaryView({
  tab,
  onSelect,
}: {
  tab: SummaryTab;
  /** Open a statement's own tab. */
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const ok = tab.failedAt === null && tab.stoppedAt === null;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border px-3 py-1.5 text-2xs",
          ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        <span>
          {tab.stoppedAt !== null
            ? t("query.batchStopped", { index: tab.stoppedAt, total: tab.statements.length })
            : ok
              ? t("query.batchOk", { count: tab.statements.length, rows: tab.totalAffected })
              : t("query.batchFailed", { index: tab.failedAt, total: tab.statements.length })}
        </span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {formatDuration(tab.totalElapsedMs)}
        </span>
      </div>
      {tab.statements.map((s) => (
        <Button
          key={s.statement}
          variant="ghost"
          size="sm"
          onClick={() => onSelect(s.tabKey)}
          className="flex h-auto w-full items-center justify-start gap-2 rounded-none px-3 py-0.5 text-2xs font-normal"
        >
          {s.status === "stopped" ? (
            <CircleStop className="h-3 w-3 shrink-0 text-warning" />
          ) : s.status === "failed" ? (
            <X className="h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <Check className="h-3 w-3 shrink-0 text-primary" />
          )}
          <span className="w-6 shrink-0 text-left tabular-nums text-muted-foreground/70">
            #{s.statement}
          </span>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-muted-foreground">
            {s.preview}
          </span>
          <span
            className={cn(
              "shrink-0 tabular-nums",
              s.status === "failed"
                ? "text-destructive"
                : s.status === "stopped"
                  ? "text-warning"
                  : "text-muted-foreground/70",
            )}
          >
            {s.status === "stopped"
              ? t("query.summaryStopped")
              : s.error
              ? s.error
              : s.isRead
                ? t("query.summaryRows", { count: s.rows })
                : t("query.summaryAffected", { count: s.rows })}
          </span>
          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground/70">
            {formatDuration(s.elapsedMs)}
          </span>
        </Button>
      ))}
    </div>
  );
}
