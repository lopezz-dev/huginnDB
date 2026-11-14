/**
 * The strip that picks which of a run's tabs is on screen (ADR #137): the
 * Summary first in a batch, then one tab per statement — its rows, its write
 * or its failure.
 *
 * Only the selected tab's body is mounted, and that is a deliberate trade
 * rather than an optimisation left for later. N grids in one tab would mean N
 * times the DOM for a payload already bounded by a shared 50 000-row budget —
 * and, less visibly, a collision: `stores/grid/gridSelection.ts` is keyed by
 * tab id and `CellEditor` takes `ownerId={tabId}`, so two live grids in one
 * tab would overwrite each other's "N selected" and fight over the docked
 * editor. With one mounted grid the tab id stays the honest key it was.
 *
 * Built on `Segmented` rather than hand-rolled buttons: a single-choice strip
 * with roving tabindex and arrow-key movement is exactly what that primitive
 * is, and `uiAdoption.test.ts` counts every raw `<button>` that re-decides it.
 */

import { useTranslation } from "react-i18next";
import { ListChecks, X } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import type { StatementTab } from "@/lib/query/statementTabs";
import { cutBy } from "@/lib/query/resultCap";

type T = (key: string, opts?: Record<string, unknown>) => string;

/** `#2`, or `#2.1` for one of several sets. */
function numberOf(tab: Exclude<StatementTab, { kind: "summary" }>): string {
  if (tab.statement === null) return "!";
  return tab.kind === "rows" && tab.set !== null
    ? `#${tab.statement}.${tab.set}`
    : `#${tab.statement}`;
}

function labelOf(tab: StatementTab, t: T): string {
  switch (tab.kind) {
    case "summary":
      return t("query.tabSummary");
    case "rows":
      return t("query.resultTab", { label: numberOf(tab), rows: tab.result.rows.length });
    case "write":
      return t("query.writeTab", { label: numberOf(tab), rows: tab.rowsAffected });
    case "error":
      return t("query.errorTab", { label: numberOf(tab) });
  }
}

/** The tooltip: what the tab holds, and for a cut result which cap cut it —
 *  its own row cap or the batch's shared budget. */
function titleOf(tab: StatementTab, t: T): string {
  switch (tab.kind) {
    case "summary":
      return t("query.tabSummaryTitle");
    case "rows":
      switch (cutBy(tab.result)) {
        case "statement":
          return t("query.resultTabTruncatedTitle", { rows: tab.result.rows.length });
        case "budget":
          return t("query.resultTabBudgetTitle", { rows: tab.result.rows.length });
        case null:
          return t("query.resultTabTitle", { index: tab.statement });
      }
      break;
    case "write":
    case "error":
      return tab.sql;
  }
}

export function ResultTabs({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: StatementTab[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const options = tabs.map((tab) => ({
    value: tab.key,
    label: labelOf(tab, t),
    icon:
      tab.kind === "error" ? (
        <X className="h-3 w-3 text-destructive" />
      ) : tab.kind === "summary" ? (
        <ListChecks className="h-3 w-3" />
      ) : undefined,
    // The OS tooltip is `Segmented`'s own affordance for a narrow segment.
    title: titleOf(tab, t),
  }));
  return (
    <Segmented
      variant="underline"
      size="sm"
      className="shrink-0 overflow-x-auto"
      aria-label={t("query.resultTabs")}
      value={activeKey ?? tabs[0]?.key ?? ""}
      onValueChange={onSelect}
      options={options}
    />
  );
}
