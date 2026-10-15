/**
 * The value control for an `IN` / `NOT IN` filter row: a one-value-per-line
 * textarea plus a separate "include NULL" toggle.
 *
 * **A textarea, not a pill editor.** These lists come from pasting a column
 * out of a spreadsheet or a previous result set, so the input has to accept a
 * multi-line paste as-is; a pill editor would need a split rule that a pasted
 * blob has no way to declare (a comma is a legal character inside a value),
 * and rendering a thousand pills inside a scrolling modal is a real render
 * cost rather than a hypothetical one.
 *
 * **NULL is a checkbox, never a token.** Typing `NULL` into the list has to
 * mean the four-character string, because in a text column that is a legal
 * value and the user has no other way to search for it. The backend agrees:
 * it lifts the null member out of `values` and gives it a dedicated `IS NULL`
 * branch before binding the rest, so this control mirrors the real model.
 *
 * Lives here rather than in `components/ui/` because it needs `react-i18next`
 * for its placeholder and labels, which convention #60 puts outside that
 * directory's dependency rule. Fully controlled — it holds no state of its own.
 */

import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { MAX_FILTER_LIST_VALUES } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function FilterValueListEditor({
  text,
  hasNull,
  count,
  onTextChange,
  onHasNullChange,
}: {
  text: string;
  hasNull: boolean;
  /** Values the row currently stands for, `NULL` included. */
  count: number;
  onTextChange: (text: string) => void;
  onHasNullChange: (hasNull: boolean) => void;
}) {
  const { t } = useTranslation();
  const over = count > MAX_FILTER_LIST_VALUES;

  return (
    <div className="space-y-1">
      <Textarea
        rows={4}
        className="resize-y px-2 py-1.5 font-mono text-xs"
        value={text}
        placeholder={t("tableData.filter.listPlaceholder")}
        onChange={(e) => onTextChange(e.target.value)}
      />
      <div className="flex items-center gap-3 text-2xs">
        <Checkbox
          size="xs"
          checked={hasNull}
          label={t("tableData.filter.includeNull")}
          onChange={(e) => onHasNullChange(e.target.checked)}
        />
        <span
          className={cn(
            "ml-auto tabular-nums",
            over ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {over
            ? t("tableData.filter.listTooLong", {
                count,
                max: MAX_FILTER_LIST_VALUES,
              })
            : t("tableData.filter.listCount", { count })}
        </span>
      </div>
    </div>
  );
}
