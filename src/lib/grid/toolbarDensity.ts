/**
 * Responsive density for the data grid's toolbar.
 *
 * The toolbar lives inside a dockview panel the user can drag to any width,
 * so this cannot be a CSS media query: the viewport can be 2560 px wide while
 * the grid's own pane is 400 px. Width is therefore observed on the toolbar
 * element itself.
 *
 * Only a *level* is exposed, never the raw width. Two reasons: the layout has
 * three discrete states, so a re-render per observed pixel during a splitter
 * drag would be waste; and the level is what the toolbar's JSX actually
 * branches on, which keeps the thresholds in one documented place instead of
 * scattered inline comparisons.
 */

import { useEffect, useState } from "react";

/**
 * - `wide` — every control inline, the historical layout.
 * - `compact` — the labelled data actions (insert / import / export / bulk
 *   update) move into the toolbar's overflow menu; icon-only controls stay.
 * - `narrow` — everything but the search box moves into the overflow menu.
 *
 * The filter and sort chips are not governed by this: they live on a row of
 * their own under the toolbar, which wraps.
 */
export type ToolbarDensity = "wide" | "compact" | "narrow";

/**
 * Widths (px of the toolbar's own content box) at which the level changes.
 *
 * Derived from what the widest realistic table tab actually needs: ~24 px of
 * padding, two leading icon buttons, the search box at its 12 rem minimum,
 * then insert + import + export + bulk update + row count + fit + view toggle
 * + elapsed time and the gaps between them add up to a little over 900 px.
 * Below `compact` only the search box, a couple of icons and the overflow
 * trigger remain, which needs ~350 px — the 560 px threshold keeps a
 * comfortable margin so the row never wraps just before collapsing.
 */
export const TOOLBAR_DENSITY_BREAKPOINTS = { wide: 940, compact: 560 } as const;

/** Where a toolbar changes level; each consumer states its own widths. */
export interface DensityBreakpoints {
  wide: number;
  compact: number;
}

export function densityForWidth(
  width: number,
  breakpoints: DensityBreakpoints = TOOLBAR_DENSITY_BREAKPOINTS,
): ToolbarDensity {
  if (width >= breakpoints.wide) return "wide";
  if (width >= breakpoints.compact) return "compact";
  return "narrow";
}

/**
 * Observe an element's width and report which density it falls into.
 *
 * Safe against a ResizeObserver feedback loop: collapsing controls changes
 * only the toolbar's *content*, never the width the observed element takes
 * from its parent (it's a full-width block), so a level change can't resize
 * the thing being measured. Returning the level rather than the width also
 * means `setState` bails out on every observation that doesn't cross a
 * threshold — a splitter drag across 300 px re-renders at most twice.
 *
 * @param ref - The toolbar element. May be null before mount.
 * @param breakpoints - The grid toolbar's widths by default. The query
 *   editor's toolbar (ADR #137) is the second consumer and passes its own;
 *   read once per mount, so pass a module constant.
 */
export function useToolbarDensity(
  ref: React.RefObject<HTMLElement | null>,
  breakpoints: DensityBreakpoints = TOOLBAR_DENSITY_BREAKPOINTS,
): ToolbarDensity {
  // Optimistic default: assume there's room. A first paint that briefly shows
  // the full bar and then collapses is far less jarring than one that starts
  // collapsed and pops open, and the observer fires on the same frame anyway.
  const [density, setDensity] = useState<ToolbarDensity>("wide");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No ResizeObserver (never in our WebViews, but jsdom/tests exist): stay
    // on the historical layout rather than guessing.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      const next = densityForWidth(width, breakpoints);
      setDensity((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    setDensity(densityForWidth(el.clientWidth, breakpoints));
    return () => observer.disconnect();
    // `breakpoints` is a module constant at every call site (see @param).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return density;
}
