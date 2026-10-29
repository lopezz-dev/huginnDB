import { cn } from "@/lib/utils";

/**
 * The hairline that divides neighbours on one line: two groups of controls in
 * a toolbar, or two runs of text in a tab title.
 *
 * Twelve of these were written by hand across the app in four heights
 * (`h-3`, `h-3.5`, `h-4`, `h-5`), three margins and two elements, all of them
 * the same `w-px bg-border` rule. The heights were not four decisions, they
 * were four guesses, and they reconcile to two:
 *
 * - `default` (`h-4`) between groups of controls. Toolbar controls here are
 *   24–28px tall and a rule two-thirds of that reads as a divider rather than
 *   a border; the console's old `h-5` and the chip row's `h-3.5` were the
 *   outliers, not a second size.
 * - `sm` (`h-3`) between runs of `text-2xs` text, where a 16px rule would
 *   stand taller than the letters it separates.
 *
 * **Spacing belongs to the row, not to this.** A separator sits in a flex row
 * whose `gap` already spaces every child, so it carries no margin of its own.
 * Rows that use `gap-1` pass `className="mx-1"` to reach the same 8px either
 * side the `gap-2` toolbars get; `className` is for that and nothing else.
 *
 * Decorative (`aria-hidden`), not `role="separator"`: every call site divides
 * groups a screen reader already announces one by one, and the ARIA role on a
 * non-focusable element adds a "separator" stop that says nothing.
 */
const SIZE = {
  default: "h-4",
  sm: "h-3",
} as const;

export function Separator({
  size = "default",
  className,
}: {
  size?: keyof typeof SIZE;
  /** Margin only — the height comes from `size`, the spacing from the row. */
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("w-px shrink-0 bg-border", SIZE[size], className)}
    />
  );
}
