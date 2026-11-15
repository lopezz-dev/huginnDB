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
import { QueryResultGrid } from "@/components/query/QueryResultGrid";
import { ResultTabs } from "@/components/query/results/ResultTabs";
import { ErrorCard, WriteCard } from "@/components/query/results/StatementCards";
import { SummaryView } from "@/components/query/results/SummaryView";
import type { LineRange } from "@/lib/query/statementTabs";
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
        // `QueryResultGrid`'s root is the `flex-1 overflow-hidden` box the
        // grid needs to get a definite height from this flex column.
        //
        // Keyed, so switching tabs remounts the grid rather than feeding a new
        // result into one holding the previous one's sort, selection and
        // column widths. One of several sets gets no statement: it is not a
        // single-table SELECT, so the grid stays read-only.
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
      )}
    </div>
  );
}
