/**
 * The query tab's history sidebar: this connection's past runs, a filter,
 * load-into-editor, run again and clear. Extracted from `QueryEditorTab`
 * (ADR #137, step 2) with no change of behaviour — including the two defects
 * `QueryEditorTab.test.tsx` pins, which the history dock (PR 7) removes along
 * with this component: "Run again" takes the single path even for a batch,
 * and "Clear" empties every connection's history.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Play, Trash2, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { formatDuration, formatTime } from "@/lib/utils";

interface Props {
  /** The parent connection whose entries are listed. */
  connectionId: string;
  onLoad: (sql: string) => void;
  onRun: (sql: string) => void;
}

export function QueryHistorySidebar({ connectionId, onLoad, onRun }: Props) {
  const { t } = useTranslation();
  const allHistory = useQueryHistory((s) => s.entries);
  const clearHistory = useQueryHistory((s) => s.clear);
  const [historyFilter, setHistoryFilter] = useState("");

  const history = useMemo(
    () => allHistory.filter((e) => e.connectionId === connectionId),
    [allHistory, connectionId],
  );
  const filteredHistory = useMemo(() => {
    if (!historyFilter.trim()) return history;
    const q = historyFilter.toLowerCase();
    return history.filter((h) => h.sql.toLowerCase().includes(q));
  }, [history, historyFilter]);

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-border bg-card/40">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {t("query.historyTitle")}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-3xs text-muted-foreground">{history.length}</span>
          {history.length > 0 && (
            <IconButton
              flat
              size="xs"
              icon={Trash2}
              label={t("query.clearHistory")}
              className="h-5 w-5"
              onClick={clearHistory}
            />
          )}
        </div>
      </div>
      <div className="border-b border-border px-3 pb-2">
        <SearchField
          size="xs"
          value={historyFilter}
          onValueChange={setHistoryFilter}
          placeholder={t("query.historyFilterPlaceholder")}
          inputClassName="text-xs"
        />
      </div>
      <div className="flex-1 overflow-y-auto pb-12">
        {filteredHistory.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {history.length === 0 ? t("query.noQueries") : t("saved.emptyNoMatch")}
          </div>
        )}
        {filteredHistory.map((h) => (
          <div
            key={h.id}
            className="group flex items-start gap-1.5 border-b border-border/40 px-3 py-2 hover:bg-accent"
          >
            {h.error ? (
              <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
            )}
            <button
              onClick={() => onLoad(h.sql)}
              className="min-w-0 flex-1 text-left text-xs"
              title={h.sql}
            >
              <div className="line-clamp-2 font-mono text-2xs">{h.sql}</div>
              <div className="mt-1 flex items-center gap-2 text-3xs text-muted-foreground">
                <span>{formatTime(h.ranAt)}</span>
                {h.error ? (
                  <span className="truncate text-destructive">{h.error}</span>
                ) : (
                  <span>
                    {t("query.historyEntryStats", {
                      rows: h.rowsAffected,
                      duration: formatDuration(h.elapsedMs),
                    })}
                  </span>
                )}
              </div>
            </button>
            <IconButton
              flat
              size="xs"
              icon={Play}
              label={t("query.runAgain")}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => onRun(h.sql)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
