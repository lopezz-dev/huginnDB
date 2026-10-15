/**
 * The server-filter chips under the grid toolbar: one per active
 * `ColumnFilter`.
 *
 * A chip is `column op value`, and the three pieces come from here:
 * `FILTER_LABEL` maps every `FilterOp` to its symbol (spelled out per variant,
 * so adding an operator is a compile error rather than a blank chip),
 * `filterValueLabel` renders the value half, and `filterValuesTooltip` defers an
 * `IN` list — which can hold hundreds of values — to a tooltip while the chip
 * shows only a count.
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { X } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { SimpleTooltip } from "@/components/ui/tooltip";

import { formatValue } from "@/lib/grid/formatValue";
import type { CellValue, ColumnFilter } from "@/types";

const FILTER_LABEL: Record<ColumnFilter["op"], string> = {
  eq: "=",
  ne: "<>",
  contains: "⊇",
  not_contains: "⊉",
  starts_with: "^…",
  ends_with: "…$",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "↔",
  in: "IN",
  not_in: "NOT IN",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};
/**
 * One filter value, rendered so its **BSON type is visible**.
 *
 * `typed` is on for MongoDB and off for the SQL drivers, and the distinction is
 * not cosmetic. BSON equality is exact by type, so `value <> 5682380` and
 * `value <> "5682380"` are different questions with the same answer on screen
 * — and when the chip picked the wrong one, nothing anywhere said so: the
 * filter simply returned every row it was meant to exclude. A quoted string, an
 * `ObjectId("…")`, an `ISODate("…")` are the shell's own spellings for the
 * distinction, which is also how the app's console logs the query.
 *
 * SQL keeps the bare form: there the value is a bound parameter coerced against
 * its column, so quoting it would suggest a distinction the driver does not
 * make.
 */
function valueText(v: CellValue | undefined, typed: boolean): string {
  if (v === null || v === undefined) return "NULL";
  if (!typed) return formatValue(v);
  if (typeof v === "string") return JSON.stringify(v);
  const ext = extJsonLabel(v);
  return ext ?? formatValue(v);
}

/** Extended JSON rendered as its shell constructor, or `null` if `v` is not
 *  one of the three wrappers a filter row can emit. */
function extJsonLabel(v: CellValue | undefined): string | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [key, inner] = entries[0];
  const ctor = EXT_JSON_CTOR[key];
  if (!ctor || (typeof inner !== "string" && typeof inner !== "number")) {
    return null;
  }
  return `${ctor}(${JSON.stringify(String(inner))})`;
}

const EXT_JSON_CTOR: Record<string, string | undefined> = {
  $oid: "ObjectId",
  $date: "ISODate",
  $numberLong: "NumberLong",
};

/**
 * The value half of a filter chip's label — the part after `column op`. An
 * `IN` list is summarised by count (it can hold hundreds of values, with the
 * values themselves deferred to a tooltip); `IS NULL` and friends have no
 * value at all.
 */
function filterValueLabel(
  f: ColumnFilter,
  t: TFunction,
  typed: boolean,
): string | null {
  if (f.op === "in" || f.op === "not_in") {
    return t("dataGrid.filterValueCount", { count: f.values?.length ?? 0 });
  }
  if (f.op === "eq" || f.op === "ne") {
    return valueText(f.value, typed);
  }
  return null;
}

/** Values behind an `IN` / `NOT IN` chip, for its tooltip. */
function filterValuesTooltip(f: ColumnFilter, typed: boolean): string | undefined {
  if (f.op !== "in" && f.op !== "not_in") return undefined;
  return (f.values ?? []).map((v) => valueText(v, typed)).join(", ");
}

/**
 * One active server-side filter: a chip whose body opens the query panel
 * focused on this condition, plus a ✕ that removes it.
 *
 * **The body is the button, and the ✕ is its sibling — never its child.** A
 * button inside a button is invalid HTML, and the browser's recovery is to
 * un-nest them, so the ✕ would stop being inside the chip at all.
 *
 * Editing works by *index*: the chip's position in `serverFilters` is the row
 * index in `QueryPanel`. That holds only because the panel renders every
 * filter shape, `in`/`not_in` included — see its docstring
 * before changing either side.
 */
export function ServerFilterChip({
  filter: f,
  index,
  typedValues = false,
  onEdit,
  onRemove,
}: {
  filter: ColumnFilter;
  /** Position in `serverFilters`, handed back to `onEdit`. */
  index: number;
  /** Render the value with its BSON type visible — MongoDB only, see
   *  {@link valueText}. */
  typedValues?: boolean;
  onEdit?: (index: number) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const value = filterValueLabel(f, t, typedValues);
  const values = filterValuesTooltip(f, typedValues);

  // One themed tooltip for the whole chip body, rather than the three native
  // `title=`s this used to carry. The value list, when there is one, is the
  // more useful half — an `IN` chip shows only a count.
  const tip = [
    onEdit ? t("dataGrid.editFilter") : t("dataGrid.serverSideFilter"),
    values,
  ]
    .filter(Boolean)
    .join(" — ");

  const body = (
    <>
      <span className="text-muted-foreground">{f.column}</span>
      <span className="text-muted-foreground/70">{FILTER_LABEL[f.op]}</span>
      {value !== null && <span className="max-w-[10rem] truncate">{value}</span>}
    </>
  );

  return (
    <span className="flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2 pr-1 font-mono text-2xs">
      <SimpleTooltip label={tip}>
        {onEdit ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded-sm hover:text-foreground"
            onClick={() => onEdit(index)}
          >
            {body}
          </button>
        ) : (
          <span className="flex items-center gap-1">{body}</span>
        )}
      </SimpleTooltip>
      {onRemove && (
        // `quiet`: dropping a filter destroys no data, and convention #61 says red
        // at rest is read as decoration.
        <IconButton
          flat
          size="xs"
          icon={X}
          label={t("dataGrid.removeFilter")}
          onClick={onRemove}
        />
      )}
    </span>
  );
}
