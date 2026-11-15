import { useTranslation } from "react-i18next";
import { Segmented } from "@/components/ui/segmented";
import type { ResultPanel } from "@/lib/query/resultPanels";
import { cutBy } from "@/lib/query/resultCap";

/** The tab's tooltip: what it holds, and why it was cut when it was — its
 *  own row cap or the batch's shared budget, which used to be blamed for
 *  both. */
function tabTitle(
  p: ResultPanel,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (cutBy(p.result)) {
    case "statement":
      return t("query.resultTabTruncatedTitle", { rows: p.result.rows.length });
    case "budget":
      return t("query.resultTabBudgetTitle", { rows: p.result.rows.length });
    case null:
      return t("query.resultTabTitle", { index: p.statement });
  }
}

/**
 * The strip that picks which result set the grid below shows.
 *
 * Only the selected panel's `DataGrid` is mounted, and that is a deliberate
 * trade rather than an optimisation left for later. N grids in one tab would
 * mean N times the DOM for a payload already bounded by a shared 50 000-row
 * budget — and, less visibly, a collision: `stores/grid/gridSelection.ts` is
 * keyed by tab id and `CellEditor` takes `ownerId={tabId}`, so two live grids
 * in one tab would overwrite each other's "N selected" and fight over the
 * docked editor. With one mounted grid the tab id stays the honest key it was.
 *
 * Built on `Segmented` rather than hand-rolled buttons: a single-choice strip
 * with roving tabindex and arrow-key movement is exactly what that primitive
 * is, and `uiAdoption.test.ts` counts every raw `<button>` that re-decides it.
 */
export function ResultTabs({
  panels,
  activeKey,
  onSelect,
}: {
  panels: ResultPanel[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const options = panels.map((p) => ({
    value: p.key,
    label: t("query.resultTab", {
      label: p.set === null ? `#${p.statement}` : `#${p.statement}.${p.set}`,
      rows: p.result.rows.length,
    }),
    // The OS tooltip is `Segmented`'s own affordance for a narrow segment;
    // it says what the panel holds when the label has room only for a count.
    title: tabTitle(p, t),
  }));
  return (
    <Segmented
      variant="underline"
      size="sm"
      className="shrink-0 overflow-x-auto"
      aria-label={t("query.resultTabs")}
      value={activeKey ?? panels[0]?.key ?? ""}
      onValueChange={onSelect}
      options={options}
    />
  );
}
