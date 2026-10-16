/**
 * Shared empty-state frame.
 *
 * Empty screens were a single grey line of text wherever they appeared — the
 * one place in the app where nothing is happening and therefore, per the brand
 * visual brief, one of the few places allowed to show personality: a halftone
 * halo, the mark, a title and an optional hint. They share one frame so "no
 * connections", "no rows", "nothing logged yet" and "no match" read as the same
 * family instead of four ad-hoc paragraphs.
 *
 * Halftone lives here and NOT behind a grid, a tree or an editor (the brief is
 * explicit, and a repeating pattern under data fights it for attention) — which
 * is exactly why it's attached to this component rather than left as a utility
 * for any surface to sprinkle on. And even here it stays behind the *mark*, not
 * behind the copy: it used to fill the whole surface, which in a short, wide
 * dock panel stretched into a flat band of dots and ran under the title and
 * hint at full strength. `halftone-spot` is a fixed-size circle centred on the
 * mark that has faded to almost nothing by the time it reaches the text.
 *
 * The illustration is the sticker mark itself (the 3D "H" over the database
 * cylinder), which is what makes the family a family — every empty screen shows
 * the same character. The per-state Lucide glyph rides along as a small badge
 * on its corner, so "nothing logged yet" and "no match for that filter" stay
 * distinguishable at a glance without each inventing its own artwork.
 */

import type { ReactNode } from "react";
import { Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /**
   * Per-state glyph, shown as a badge on the mark's corner. Optional: with no
   * icon the mark stands alone (the right call when the title already says
   * everything, e.g. a first-run screen).
   */
  icon?: LucideIcon;
  /** The message. Short sentence; wraps at a readable measure. */
  title: string;
  /** Optional second line — what to do about it. */
  hint?: ReactNode;
  /**
   * Optional boxed note under the copy, for something that is not a hint but a
   * reason — "mongosh was not found…", "this connection is not MongoDB". It
   * gets its own surface because it is usually long and the user has to read
   * it, which muted 12px text floating over the backdrop did not invite.
   */
  notice?: ReactNode;
  /** `warning` for a fault the user has to fix; `info` (default) otherwise. */
  noticeTone?: "info" | "warning";
  /** Optional call to action (a `Button`, usually). */
  action?: ReactNode;
  /**
   * `error` recolours the glyph badge to the destructive accent. Same geometry
   * and border weight as the neutral tone — per the brief, the colour is the
   * only thing that changes between states.
   */
  tone?: "neutral" | "error";
  /** `sm` for narrow side panels (saved queries, console); `md` elsewhere. */
  size?: "sm" | "md";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  notice,
  noticeTone = "info",
  action,
  tone = "neutral",
  size = "md",
  className,
}: EmptyStateProps) {
  const compact = size === "sm";
  const NoticeIcon = noticeTone === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center overflow-hidden text-center",
        compact ? "gap-2.5 px-4 py-5" : "gap-4 px-6 py-10",
        className,
      )}
    >
      <div className="relative flex items-center justify-center">
        {/* The halo: square box, so the utility's `closest-side` circle is a
            circle whatever the panel's aspect ratio. Sized to fade out about
            where the title begins. */}
        <span
          aria-hidden
          className={cn(
            "halftone-spot pointer-events-none absolute",
            compact ? "h-32 w-32" : "h-48 w-48",
          )}
        />
        {/* Brand bloom under the mark: the light source the flat dot field
            lacks, and the same device the splash uses. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute rounded-full bg-brand/20 blur-2xl",
            compact ? "h-16 w-16" : "h-24 w-24",
          )}
        />
        <span
          className={cn(
            "relative block drop-shadow-[0_4px_16px_color-mix(in_srgb,var(--brand)_35%,transparent)]",
            compact ? "h-11 w-11" : "h-16 w-16",
          )}
        >
          {/* The mark carries its own sticker outline, so it needs no
              medallion frame around it — that would be a second border. */}
          <img
            src="/image/huginn-mark-256.png"
            alt=""
            width={256}
            height={256}
            className="h-full w-full select-none"
            draggable={false}
          />
          {Icon && (
            <span
              className={cn(
                "absolute -bottom-1 -right-1 flex items-center justify-center rounded-full border-2 bg-card shadow-elevation-1",
                compact ? "h-5 w-5" : "h-6 w-6",
                tone === "error"
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-brand",
              )}
            >
              <Icon
                className={compact ? "h-2.5 w-2.5" : "h-3 w-3"}
                aria-hidden
              />
            </span>
          )}
        </span>
      </div>
      {/* `relative` on everything below is load-bearing, not decoration: the
          halo and the bloom are absolutely positioned, and CSS paints
          positioned elements above static ones regardless of source order —
          without it whatever of the halo reaches the copy would sit on top. */}
      <div className="relative flex flex-col items-center gap-1">
        <p
          className={cn(
            "max-w-[42ch] font-medium text-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {title}
        </p>
        {hint && (
          <p className="max-w-[56ch] text-xs text-muted-foreground">{hint}</p>
        )}
      </div>
      {notice && (
        <div
          className={cn(
            "relative flex max-w-[56ch] items-start gap-2 rounded-md border px-3 py-2 text-left text-xs leading-relaxed text-foreground/90",
            noticeTone === "warning"
              ? "border-warning/30 bg-warning/10"
              : "border-border bg-card/80",
          )}
        >
          <NoticeIcon
            aria-hidden
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              noticeTone === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          />
          <div className="min-w-0 break-words">{notice}</div>
        </div>
      )}
      {action && <div className="relative">{action}</div>}
    </div>
  );
}
