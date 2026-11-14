/**
 * The query tab's results area (ADR #137): the strip of the run's tabs and
 * the body of the one on screen — the shared result grid, a write card, an
 * error card or the batch Summary.
 *
 * It **shows** what `useQueryRun` decided; the only state it owns is the
 * grid's client-side filter, which it clears on a tab switch — a filter typed
 * against one result's columns reads as an empty result on another.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { cutBy } from "@/lib/query/resultCap";
import { QueryResultGrid } from "@/components/query/QueryResultGrid";
import { ResultTabs } from "@/components/query/results/ResultTabs";
import { ErrorCard, WriteCard } from "@/components/query/results/StatementCards";
import { SummaryView } from "@/components/query/results/SummaryView";
import type { LineRange, StatementTab } from "@/lib/query/statementTabs";
import type { QueryRun } from "@/lib/query/useQueryRun";
import type { Driver } from "@/types";

type Props = Pick<QueryRun, "tabs" | "active" | "resultsOn" | "selectTab" | "refreshActive"> & {
  tabId: string;
  driver: Driver | undefined;
  /** Select a statement's lines in the editor. */
  onGoTo: (lines: LineRange) => void;
};

export function QueryResultsArea({
  tabs,
  active,
  resultsOn,
  selectTab,
  refreshActive,
  tabId,
  driver,
  onGoTo,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const select = useCallback(
    (key: string) => {
      selectTab(key);
      setFilter("");
    },
    [selectTab],
  );

  return (
    <div className="flex h-full flex-col">
      {tabs.length > 1 && (
        <ResultTabs tabs={tabs} activeKey={active?.key ?? null} onSelect={select} />
      )}
      {active === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {t("query.noResults")}
        </div>
      ) : active.kind === "summary" ? (
        <SummaryView tab={active} onSelect={select} />
      ) : active.kind === "error" ? (
        <ErrorCard tab={active} onGoTo={onGoTo} />
      ) : active.kind === "write" ? (
        <WriteCard tab={active} onGoTo={onGoTo} />
      ) : (
        <>
          <CutStrip tab={active} />
          {/* `QueryResultGrid`'s root is the `flex-1 overflow-hidden` box the
              grid needs to get a definite height from this flex column.

              Keyed, so switching tabs remounts the grid rather than feeding a
              new result into one holding the previous one's sort, selection and
              column widths. One of several sets gets no statement: it is not a
              single-table SELECT, so the grid stays read-only. */}
          <QueryResultGrid
            key={active.key}
            result={active.result}
            sql={active.refreshable ? active.sql : undefined}
            connectionId={resultsOn}
            driver={driver}
            tabId={tabId}
            globalFilter={filter}
            onGlobalFilterChange={setFilter}
            onRefresh={refreshActive}
          />
        </>
      )}
    </div>
  );
}

/**
 * The strip over a cut result (ADR #137): "First 50 000 rows; the query
 * returns more", or the batch-budget wording when the budget shed it. The
 * grid toolbar's "truncated" badge stays; this says it where the rows are,
 * in words, and the export menu says it again.
 */
function CutStrip({ tab }: { tab: Extract<StatementTab, { kind: "rows" }> }) {
  const { t } = useTranslation();
  const cut = cutBy(tab.result);
  if (cut === null) return null;
  const rows = tab.result.rows.length.toLocaleString();
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 text-2xs text-warning"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span>
        {cut === "statement"
          ? t("query.cutStrip", { rows })
          : t("query.cutStripBudget", { rows })}
      </span>
    </div>
  );
}
