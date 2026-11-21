/**
 * Toolbar search input with an optional history dropdown.
 *
 * Submitting is explicit: typing only updates the input value, and the
 * search is applied to the backend on Enter, on picking a history
 * entry, or on clicking the clear (×) button. This stops every
 * keystroke from creating a history entry and avoids spurious refetches
 * while the user is still composing the query.
 */

import { useTranslation } from "react-i18next";
import { ChevronDown, Search, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { IconButton } from "@/components/ui/icon-button";

export function GridSearchInput({
  value,
  onChange,
  onSubmit,
  history,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
  history: string[];
}) {
  const { t } = useTranslation();
  const hasHistory = history.length > 0;
  const hasValue = value.length > 0;
  return (
    <div className="flex h-7 min-w-[12rem] max-w-xl flex-1 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      <span
        className="flex shrink-0 items-center pl-2 text-muted-foreground/70"
        aria-hidden
      >
        <Search className="h-3.5 w-3.5" />
      </span>
      <input
        // The find key's target (`focusTableSearch`): found under the active
        // table tab's `data-table-tab`, so no ref has to be threaded through
        // DataGrid and GridToolbar to reach it.
        data-grid-search
        className="w-full min-w-0 flex-1 bg-transparent px-2 text-xs focus:outline-none"
        placeholder={t("dataGrid.filterRowsPlaceholder")}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.(value);
          }
        }}
      />
      {hasValue && (
        <IconButton
          flat
          size="xs"
          icon={X}
          label={t("dataGrid.clearFilter")}
          className="self-center"
          onClick={() => {
            // Clear immediately + apply, so the grid actually refetches
            // and the user sees the unfiltered rows.
            onChange?.("");
            onSubmit?.("");
          }}
        />
      )}
      {hasHistory && (
        // The divider lives on a wrapper rather than on the trigger: a `flat`
        // button's own border is transparent by design, and `DropdownMenu`
        // renders no element of its own to carry it.
        <div className="flex items-center border-l border-input">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                flat
                size="xs"
                icon={ChevronDown}
                label={t("dataGrid.recentSearches")}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 overflow-y-auto"
            >
              {history.map((q) => (
                <DropdownMenuItem
                  key={q}
                  onSelect={() => {
                    onChange?.(q);
                    onSubmit?.(q);
                  }}
                  className="font-mono"
                >
                  <span className="truncate max-w-[20rem]">{q}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

/**
 * Editable row pinned at the top of the grid for inline INSERT.
 *
 * Each cell is a plain text input. The empty initial state ("NULL"
 * placeholder) means the column is omitted from the INSERT so the
 * database picks the default; clicking "∅" explicitly forces NULL.
 *
 * Commit fires when focus leaves the row entirely (the user clicks
 * outside). We detect this with a `setTimeout(0)` after `onBlur` and
 * check whether `document.activeElement` is still inside the row.
 * `Esc` cancels; `Enter` commits explicitly.
 */
