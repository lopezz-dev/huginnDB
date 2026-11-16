/**
 * The query history as a dock panel beside Saved queries (ADR #137). It used
 * to be a sidebar inside each query tab, which carried two defects: "Run
 * again" sent a batch down the single-statement path (Postgres and MySQL
 * refuse a `;`-joined text there), and "Clear" emptied every connection's
 * history behind a list that showed one.
 *
 * - **Filtered by the focused tab's connection** (`selectedConnectionId`,
 *   which `focusFollowsTab` derives), with a switch to show every
 *   connection's history.
 * - **Clear clears what the list shows**, after a confirmation: that
 *   connection's entries (`clearFor`), every entry when all are shown, or
 *   only the matches while a text filter narrows the list.
 * - **Run opens the entry in a query tab that runs it** through its own
 *   runner (`openQueryTab(…, { run: true })`), so a batch goes down the batch
 *   path; a click on the entry opens it without running. Nothing here calls
 *   a run path itself.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, History, Play, SearchX, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/common/EmptyState";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { parentConnectionId } from "@/lib/connectionLabel";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { formatDuration, formatTime } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { useQueryHistory } from "@/stores/query/queryHistory";
import type { QueryHistoryEntry } from "@/types";

export function QueryHistoryPanel({
  connectionId,
}: {
  /** The focused tab's connection, or `null` with nothing focused. */
  connectionId: string | null;
}) {
  const { t } = useTranslation();
  const entries = useQueryHistory((s) => s.entries);
  const profiles = useConnections((s) => s.profiles);
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");

  // History is filed under the parent connection.
  const parent = connectionId ? parentConnectionId(connectionId) : null;
  const scoped = useMemo(
    () => (all ? entries : entries.filter((e) => e.connectionId === parent)),
    [entries, all, parent],
  );
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? scoped.filter((e) => e.sql.toLowerCase().includes(q)) : scoped;
  }, [scoped, filter]);

  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  function clear() {
    const message = filter.trim()
      ? t("history.clearMatchesConfirm", { count: shown.length })
      : all || !parent
        ? t("history.clearAllConfirm", { count: shown.length })
        : t("history.clearConnectionConfirm", {
            count: shown.length,
            name: nameOf(parent),
          });
    void confirmIrreversible(message).then((ok) => {
      if (!ok) return;
      const store = useQueryHistory.getState();
      if (filter.trim()) store.removeMany(new Set(shown.map((e) => e.id)));
      else if (all || !parent) store.clear();
      else store.clearFor(parent);
    });
  }

  function open(entry: QueryHistoryEntry, run: boolean) {
    // The connection it ran on, not whichever database is in front of the
    // person now (see `openQueryTab`'s `resolveTarget`).
    openQueryTab(entry.connectionId, { sql: entry.sql, resolveTarget: false, run });
  }

  const hasConnection = all || parent !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("history.title")}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-3xs text-muted-foreground">{shown.length}</span>
          {shown.length > 0 && (
            <IconButton
              flat
              size="xs"
              icon={Trash2}
              label={t("history.clear")}
              onClick={clear}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2 text-2xs text-muted-foreground">
        <Switch
          checked={all}
          onCheckedChange={setAll}
          aria-label={t("history.allConnections")}
        />
        <span>{t("history.allConnections")}</span>
      </div>
      <div className="px-3 pb-2">
        <SearchField
          size="xs"
          value={filter}
          onValueChange={setFilter}
          placeholder={t("query.historyFilterPlaceholder")}
          inputClassName="text-xs"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <EmptyState
            size="sm"
            icon={scoped.length === 0 ? History : SearchX}
            title={
              !hasConnection
                ? t("history.noConnection")
                : scoped.length === 0
                  ? t("query.noQueries")
                  : t("saved.emptyNoMatch")
            }
          />
        )}
        {shown.map((h) => (
          <div
            key={h.id}
            className="group/row flex items-start gap-1.5 border-b border-border/40 px-3 py-2 hover:bg-accent"
          >
            {h.error ? (
              <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => open(h, false)}
              aria-label={t("history.open")}
              className="h-auto min-w-0 flex-1 flex-col items-start gap-0 p-0 text-left text-xs font-normal hover:bg-transparent"
            >
              <span className="line-clamp-2 w-full whitespace-pre-wrap font-mono text-2xs">
                {h.sql}
              </span>
              <span className="mt-1 flex w-full items-center gap-2 text-3xs text-muted-foreground">
                <span>{formatTime(h.ranAt)}</span>
                {all && <span className="truncate">{nameOf(h.connectionId)}</span>}
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
              </span>
            </Button>
            <IconButton
              flat
              size="xs"
              icon={Play}
              label={t("query.runAgain")}
              revealOnHover="row"
              onClick={() => open(h, true)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
