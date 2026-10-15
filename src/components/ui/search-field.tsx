import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input, type InputProps } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";

/**
 * A filter input with its magnifier, and optionally a clear button.
 *
 * Ten call sites composed this by hand — a `relative` wrapper, an absolutely
 * positioned `<Search>`, and an `<Input>` with a matching left padding — in
 * three combinations of glyph size and offset. The offset and the padding have
 * to agree or the caret starts under the icon, which is precisely the kind of
 * pairing a call site should not be asked to remember: both derive from `size`
 * here.
 *
 * `clearLabel` is required whenever `onClear` is given, because the clear
 * button needs an accessible name and this directory cannot reach i18n
 * (see `README.md`). Enforced in the type rather than documented.
 *
 * NOT for `connection/TreeFilterBox` or `grid/GridSearchInput`, whose docstrings
 * explain why they compose by hand: the first owns the raw needle plus its
 * debounce and key handling so a keystroke does not re-render the whole tree
 * (ADR #55), and the second has a history dropdown welded to its right edge.
 */

/** Glyph size, its offset, and the input padding that clears it. */
const GEOMETRY = {
  md: { glyph: "h-3.5 w-3.5", left: "left-2.5", pl: "pl-8", pr: "pr-8" },
  sm: { glyph: "h-3.5 w-3.5", left: "left-2", pl: "pl-7", pr: "pr-7" },
  xs: { glyph: "h-3 w-3", left: "left-2", pl: "pl-6", pr: "pr-6" },
} as const;

type Base = Omit<
  InputProps,
  "size" | "type" | "value" | "onChange" | "className"
> & {
  value: string;
  onValueChange: (value: string) => void;
  size?: keyof typeof GEOMETRY;
  /** Classes for the wrapper, which is what a flex parent needs to size. */
  className?: string;
  /** Classes for the input itself. */
  inputClassName?: string;
};

export type SearchFieldProps = Base &
  (
    | { onClear: () => void; clearLabel: string }
    | { onClear?: undefined; clearLabel?: undefined }
  );

export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  (
    {
      value,
      onValueChange,
      size = "md",
      onClear,
      clearLabel,
      className,
      inputClassName,
      ...props
    },
    ref,
  ) => {
    const g = GEOMETRY[size];
    return (
      <div className={cn("relative", className)}>
        <Search
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
            g.glyph,
            g.left,
          )}
        />
        <Input
          ref={ref}
          size={size}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(g.pl, onClear && value && g.pr, inputClassName)}
          {...props}
        />
        {onClear && value && (
          <IconButton
            flat
            size="xs"
            icon={X}
            label={clearLabel}
            className="absolute right-1 top-1/2 -translate-y-1/2"
            onClick={onClear}
          />
        )}
      </div>
    );
  },
);
SearchField.displayName = "SearchField";
