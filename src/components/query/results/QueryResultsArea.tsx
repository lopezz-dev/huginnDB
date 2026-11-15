/**
 * The query tab's results area: the batch summary, the strip of result tabs
 * and the body of the one on screen (the grid, the DML line, the error box or
 * the empty state). Extracted from `QueryEditorTab` (ADR #137, step 2) with no
 * change of behaviour.
 *
 * It **shows** what `useQueryRun` decided; the only state it owns is the
 * grid's client-side filter, which it clears on a tab switch — a filter typed
 * against one result's columns reads as an empty result on another.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueryResultGrid } from "@/components/query/QueryResultGrid";
import { BatchSummary } from "@/components/query/results/BatchSummary";
import { DmlResult } from "@/components/query/results/DmlResult";
import { ResultTabs } from "@/components/query/results/ResultTabs";
import type { QueryRun } from "@/lib/query/useQueryRun";
import type { Driver } from "@/types";

type Props = Pick<
  QueryRun,
  | "panels"
  | "active"
  | "resultsOn"
  | "batchSummary"
  | "error"
  | "selectPanel"
  | "refreshActive"
> & {
  tabId: string;
  driver: Driver | undefined;
};

export function QueryResultsArea({
  panels,
  active,
  resultsOn,
  batchSummary,
  error,
  selectPanel,
  refreshActive,
  tabId,
  driver,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const select = useCallback(
    (key: string) => {
      selectPanel(key);
      setFilter("");
    },
    [selectPanel],
  );

  return (
    <div className="flex h-full flex-col">
      {/* One line per statement — including the writes and the failure,
          which have no panel of their own. */}
      {batchSummary && <BatchSummary summary={batchSummary} />}
      {panels.length > 1 && (
        <ResultTabs
          panels={panels}
          activeKey={active?.key ?? null}
          onSelect={select}
        />
      )}
      {error ? (
        <div className="min-h-0 flex-1 overflow-auto bg-destructive/10 p-3 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : active && active.result.columns.length === 0 ? (
        <DmlResult result={active.result} />
      ) : active ? (
        // `QueryResultGrid`'s root is the `flex-1 overflow-hidden` box the
        // grid needs to get a definite height from this flex column.
        //
        // Keyed, so switching panels remounts the grid rather than feeding a
        // new result into one holding the previous one's sort, selection and
        // column widths.
        <QueryResultGrid
          key={active.key}
          result={active.result}
          sql={active.sql}
          connectionId={resultsOn}
          driver={driver}
          tabId={tabId}
          globalFilter={filter}
          onGlobalFilterChange={setFilter}
          onRefresh={refreshActive}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {batchSummary ? null : t("query.noResults")}
        </div>
      )}
    </div>
  );
}
