import * as React from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { REVEAL_ON_HOVER } from "@/components/ui/styles";

/**
 * A square, dense icon control with a themed tooltip — the toolbar and row
 * button the app wrote out by hand about 65 times across 38 files, with four
 * different hover alphas and three paddings between them.
 *
 * Two decisions do the actual work:
 *
 * **`icon` is the component, not a child.** That is what takes the glyph-size
 * decision away from the call site, and that decision is where `h-3` / `h-3.5`
 * / `h-4` on visually identical buttons came from.
 *
 * **`label` is required and `title` is removed from the props type.** A bare
 * icon button with no accessible name is a bug, and a native `title=` is the
 * OS tooltip — a different delay, a different look, and 219 of them were
 * competing with the themed one. Making it a compile error is cheaper than a
 * lint rule and cannot drift.
 *
 * Needs a `TooltipProvider` above it. All three window roots have one.
 */

/** Hover treatment. The resting colour is muted in every case; only what the
 *  pointer reveals differs, so a destructive row action can read as dangerous
 *  without shouting at rest. */
const TONE = {
  quiet: "",
  destructive: "hover:bg-destructive/10 hover:text-destructive",
  brand: "hover:bg-brand/10 hover:text-brand",
} as const;

/** The edge follows the tone under the pointer. Kept apart from `TONE` because
 *  a `flat` button must not grow one back: `className` is merged last, so an
 *  edge colour here would beat the variant's `hover:border-transparent`. */
const TONE_EDGE: Record<keyof typeof TONE, string> = {
  quiet: "",
  destructive: "hover:border-destructive/40",
  brand: "hover:border-brand/40",
};

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "title"
> {
  /** Accessible name *and* tooltip text. Required on purpose. */
  label: string;
  icon: LucideIcon;
  /** `sm` is 28px (the default), `xs` is 24px for the tightest chrome. */
  size?: "sm" | "xs";
  tone?: keyof typeof TONE;
  /** Which side the tooltip opens on. */
  side?: "top" | "right" | "bottom" | "left";
  /** Hidden until its container is hovered or this button is focused. The
   *  container must carry the matching `group/<name>`. */
  revealOnHover?: keyof typeof REVEAL_ON_HOVER;
  /** Swap the icon for a spinner and disable the button. */
  loading?: boolean;
  /**
   * Drop the hairline edge. Defaults to on for `revealOnHover` — a row action
   * that only appears under the pointer is dense chrome by definition, and
   * three outlined squares per row is what turns a list into a grid of boxes.
   * Pass it for the other places a second outline would be a box inside a box:
   * inside a chip, inside an input, in a list row.
   */
  flat?: boolean;
  /**
   * Emit a native `title=` instead of the themed tooltip. The escape hatch for
   * the one place it is correct: inside open menu content (a `DropdownMenuItem`,
   * a swatch inside `DropdownMenuContent`), where the Radix tooltip fights the
   * menu's own hover and portal handling. See `tooltip.tsx`.
   */
  nativeTitle?: boolean;
  /**
   * A mark painted over the glyph's top-right corner — the slot that lets a
   * control say "something here is not at its default" on the control that
   * changes it, without a second element beside it. Usually a
   * {@link BadgeDot}. `label` still has to say in words what the mark says
   * in colour: the tooltip is the only place a screen reader and a curious
   * pointer can read it.
   */
  badge?: React.ReactNode;
}

/**
 * The standard {@link IconButton} badge: a brand dot ringed in the background
 * colour, so it reads against the glyph it overlaps. Decorative — the button's
 * `label` carries the meaning.
 */
export function BadgeDot() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-background"
    />
  );
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      icon,
      size = "sm",
      tone = "quiet",
      side,
      revealOnHover,
      loading = false,
      flat,
      nativeTitle = false,
      badge,
      className,
      ...props
    },
    ref,
  ) => {
    const isFlat = flat ?? revealOnHover !== undefined;
    const button = (
      <Button
        ref={ref}
        variant="quiet"
        size={size === "xs" ? "icon-xs" : "icon-sm"}
        flat={isFlat}
        icon={icon}
        loading={loading}
        aria-label={label}
        title={nativeTitle ? label : undefined}
        className={cn(
          TONE[tone],
          !isFlat && TONE_EDGE[tone],
          revealOnHover && REVEAL_ON_HOVER[revealOnHover],
          badge != null && badge !== false && "relative",
          className,
        )}
        {...props}
      >
        {badge}
      </Button>
    );
    if (nativeTitle) return button;
    return (
      <SimpleTooltip label={label} side={side}>
        {button}
      </SimpleTooltip>
    );
  },
);
IconButton.displayName = "IconButton";
