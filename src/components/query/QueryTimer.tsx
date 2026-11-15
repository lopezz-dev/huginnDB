import { forwardRef, useImperativeHandle } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import { useElapsed } from "@/lib/useElapsed";
import { cn, formatDuration } from "@/lib/utils";
import type { QueryTimerHandle } from "@/lib/query/useQueryRun";

/**
 * Live/frozen run-duration badge next to the Run button. Ticks in real time
 * (wall clock, not the driver's own `elapsed_ms`, so it reflects what the
 * user is actually waiting on — IPC included) while a query is in flight,
 * then freezes on the settled time, tinted by outcome. Renders nothing
 * before the first run — an idle "0 ms" badge would just be noise.
 *
 * Owns its own `elapsedMs`/`lastOk` state via `useElapsed` instead of
 * receiving them as props from the tab. That state ticks every
 * 50ms while a query runs; if it lived in the parent (as it used to), every
 * tick would re-render the entire query tab — Monaco editor included — just
 * to update this one small badge. `start`/`stop` are exposed through
 * `ref` so `useQueryRun` can drive the timer without subscribing to the value
 * that changes 20 times a second.
 */
export const QueryTimer = forwardRef<QueryTimerHandle, { running: boolean }>(
  function QueryTimer({ running }, ref) {
    const { t } = useTranslation();
    const { elapsedMs, lastOk, start, stop } = useElapsed();
    useImperativeHandle(ref, () => ({ start, stop }), [start, stop]);
    if (!running && lastOk === null) return null;
    return (
      <div
        className={cn(
          "ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs tabular-nums transition-colors",
          running
            ? "bg-brand/10 text-brand"
            : lastOk
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/10 text-destructive",
        )}
        title={t("query.elapsedTitle")}
      >
        <Clock className={cn("h-3 w-3", running && "animate-pulse")} />
        <span>{formatDuration(elapsedMs)}</span>
      </div>
    );
  },
);
