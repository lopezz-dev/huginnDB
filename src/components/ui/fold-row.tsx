/**
 * The collapsible header of a group inside a picker list: chevron, optional
 * icon, label, and a muted `(count)`, filling the rest of its line.
 *
 * Settings' three connection pickers (`AiConnectionTree`, `McpConnectionTree`,
 * `PulseConnectionTree`) each wrote this out twice — once for a provenance
 * section, once for a group folder inside it — as six copies of the same
 * `<button>`. Three consumers is what convention #60 asks for before a primitive
 * exists, and six copies of a markup nobody would think to keep in sync is the
 * reason it should.
 *
 * It is the *button*, not the whole header line. What sits beside it — each
 * tree's select-all checkbox, with its own handler and its own wording — and
 * the line's chrome (the section band, the group's indent) stay at the call
 * site, the same split `tree-row.tsx` makes: the primitive owns what is
 * identical and nothing that differs.
 *
 * `open` drives both the chevron and `aria-expanded`. The hand-written copies
 * had the chevron and no `aria-expanded`, so a screen reader heard six plain
 * buttons with no hint that each one hides a list.
 */

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { CONTROL_FOCUS_TIGHT, MICRO_HEADING } from "@/components/ui/styles";

/**
 * Type per level. A section is the outer axis (provenance) and reads as a
 * sentence-case label; a group is the free-text folder inside it and takes the
 * micro heading, so the two levels are told apart by more than indentation.
 */
const LEVEL = {
  section: "text-2xs",
  group: MICRO_HEADING,
} as const;

export interface FoldRowProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  /** Expanded? Drives the chevron and `aria-expanded`. */
  open: boolean;
  label: React.ReactNode;
  /** Shown muted after the label, in parentheses. */
  count?: number;
  /** A glyph between the chevron and the label (a group's folder). */
  icon?: LucideIcon;
  level?: keyof typeof LEVEL;
}

export const FoldRow = React.forwardRef<HTMLButtonElement, FoldRowProps>(
  (
    { open, label, count, icon: Icon, level = "section", className, ...props },
    ref,
  ) => {
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground hover:text-foreground",
          CONTROL_FOCUS_TIGHT,
          LEVEL[level],
          className,
        )}
        {...props}
      >
        <Chevron className="h-3 w-3 shrink-0" />
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="truncate">{label}</span>
        {count !== undefined && (
          <span className="text-muted-foreground/60">({count})</span>
        )}
      </button>
    );
  },
);
FoldRow.displayName = "FoldRow";
