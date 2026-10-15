import * as React from "react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS_TIGHT } from "@/components/ui/styles";

/**
 * One entry of a workbench's left rail: icon, a label and an optional one-line
 * description, with the active entry drawn as a brand-tinted pill.
 *
 * Settings and the shared-origin editor each wrote this out by hand, and the
 * policy editor's third copy, made from `Button`, drifted. One primitive keeps
 * the three rails the same rail — which is why the pill look, when Settings
 * moved to it, moved all three at once rather than Settings alone. The rail
 * container is expected to pad its entries (`p-2`), since a rounded pill
 * running into the rail's edge reads as clipped.
 *
 * The active state is `brand`, not `primary`: `--primary` is near-white on a
 * dark theme and near-black on a light one (convention #60), which is how the old
 * 2px edge read as a grey line rather than as "you are here".
 */
export interface NavRailItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** A lucide glyph, or any icon component that takes a `className`. */
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  description?: React.ReactNode;
  active?: boolean;
  /** Drawn over the icon's corner. */
  badge?: React.ReactNode;
  /** Right-aligned after the label: a count, a status word, a dot. */
  trailing?: React.ReactNode;
}

export const NavRailItem = React.forwardRef<HTMLButtonElement, NavRailItemProps>(
  (
    { icon: Icon, label, description, active, badge, trailing, className, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        CONTROL_FOCUS_TIGHT,
        active
          ? "bg-brand/10 text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="relative shrink-0">
        <Icon
          className={cn("h-3.5 w-3.5", active ? "text-brand" : "text-muted-foreground")}
        />
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={cn("truncate text-sm", active && "font-medium")}>{label}</span>
        {description && (
          <span className="text-3xs text-muted-foreground">{description}</span>
        )}
      </span>
      {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
    </button>
  ),
);
NavRailItem.displayName = "NavRailItem";
