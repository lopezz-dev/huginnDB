import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BatchResult } from "@/types";

/**
 * Compact, scrollable summary of a multi-statement batch run. One row per
 * statement with a status glyph, a monospace preview and its affected-row
 * count; a header line tallies the whole batch (or flags where it stopped).
 * Deliberately understated — the grid below holds the actual data.
 *
 * It stays a summary rather than becoming the result selector `ResultTabs`
 * is, because the two answer different questions and only one of them is
 * about the rows: this is where a write's affected count and the statement
 * that stopped the batch are reported, and neither has a panel to be selected.
 */
export function BatchSummary({ summary }: { summary: BatchResult }) {
  const { t } = useTranslation();
  const failedAt = summary.statements.findIndex((s) => s.error);
  const ok = failedAt === -1;
  return (
    <div className="shrink-0 border-b border-border bg-card/40">
      <div
        className={cn(
          "px-3 py-1 text-2xs",
          ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {ok
          ? t("query.batchOk", {
              count: summary.statements.length,
              rows: summary.total_affected,
            })
          : t("query.batchFailed", {
              index: failedAt + 1,
              total: summary.statements.length,
            })}
      </div>
      <div className="max-h-28 overflow-y-auto">
        {summary.statements.map((s) => (
          <div
            key={s.index}
            className="flex items-center gap-2 px-3 py-0.5 text-2xs"
          >
            {s.error ? (
              <X className="h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Check className="h-3 w-3 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {s.preview}
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                s.error ? "text-destructive" : "text-muted-foreground/70",
              )}
            >
              {s.error
                ? s.error
                : s.is_select
                  ? `${s.rows_affected} rows`
                  : `${s.rows_affected} affected`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
