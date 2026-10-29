/**
 * The grid's two column-sizing gestures — fit to content, fit to the visible
 * width — reachable from outside the grid: the keybinding dispatcher and the
 * command palette.
 *
 * A registry rather than `tableRefresh`'s tab-id map, because a data grid does
 * not belong to one kind of tab: a table tab has one, a query tab has one per
 * result set, the view editor has a preview. None of them knows a tab id, and
 * the gesture was never about a tab anyway — it is about *the grid the user is
 * looking at*. So each grid registers its root element, and the question
 * "which grid" is answered from the DOM at the moment the action fires:
 *
 * 1. the grid that holds the focus, if any — the unambiguous case, and what a
 *    shortcut pressed from inside a grid always hits;
 * 2. otherwise the visible grid the user touched last — the palette's case,
 *    since opening it moved the focus into the palette;
 * 3. otherwise the only visible grid, if there is exactly one.
 *
 * "Visible" is `getClientRects().length > 0`: false for an element that is
 * detached or under a `display: none` ancestor, which covers both ways
 * dockview takes a background panel off screen. Two visible grids nobody has
 * touched is the one case with no answer, and the action declines rather than
 * guess.
 */

export type GridSizingGesture = "fitContent" | "fitWidth";

/** Runs a gesture on one grid. Returns `false` when the grid cannot (list
 *  view, no columns) — the same "decline" contract as a keybinding handler. */
export type GridSizingRunner = (gesture: GridSizingGesture) => boolean;

interface Entry {
  run: GridSizingRunner;
  /** Monotonic, not a timestamp: only the order matters. 0 = never focused. */
  lastFocus: number;
}

const registry = new Map<HTMLElement, Entry>();
let clock = 0;

/** Register `root` (the grid's outermost element). Returns the unregister
 *  function, so an effect can hand it straight back as its cleanup. */
export function registerGridSizing(
  root: HTMLElement,
  run: GridSizingRunner,
): () => void {
  registry.set(root, { run, lastFocus: 0 });
  return () => {
    registry.delete(root);
  };
}

/** Record that the focus entered `root`. Wire to the grid's `onFocus`
 *  (React's bubbles, so a cell, the search box or a toolbar button all count). */
export function noteGridFocus(root: HTMLElement): void {
  const entry = registry.get(root);
  if (entry) entry.lastFocus = ++clock;
}

function isVisible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

function activeGrid(): Entry | null {
  const focused = document.activeElement;
  if (focused) {
    for (const [root, entry] of registry) {
      if (root.contains(focused)) return entry;
    }
  }
  const visible = Array.from(registry).filter(([root]) => isVisible(root));
  const touched = visible
    .filter(([, e]) => e.lastFocus > 0)
    .sort(([, a], [, b]) => b.lastFocus - a.lastFocus);
  if (touched.length > 0) return touched[0][1];
  return visible.length === 1 ? visible[0][1] : null;
}

/** Is there a grid a sizing gesture would land on? The palette asks before
 *  offering the commands, so it never lists one that would do nothing. */
export function hasActiveGrid(): boolean {
  return activeGrid() !== null;
}

/** Run `gesture` on the active grid. `false` when there is none or it
 *  declined, so the dispatcher lets the keystroke fall through. */
export function runGridSizing(gesture: GridSizingGesture): boolean {
  return activeGrid()?.run(gesture) ?? false;
}
