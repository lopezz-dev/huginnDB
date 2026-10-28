/**
 * The data tab's page window: which rows this page covers, and whether either
 * arrow is live.
 *
 * Small, but the `canNext` rule is the kind of thing that quietly strands a user
 * on page 3 of a 900-row table, and while it lived inline in `TableDataTab` it
 * could not be tested at all. Everything here is pure.
 */

export interface PageWindow {
  /** 1-based index of the first row on this page. */
  from: number;
  /** 1-based index of the last row this page can hold, clamped to the total. */
  to: number;
  canPrev: boolean;
  canNext: boolean;
}

export interface PageWindowInput {
  offset: number;
  pageSize: number;
  /** Row count, or `null` while the count is in flight or after it failed. */
  total: number | null;
  /** Whether `total` came from the planner's statistics rather than a `COUNT`. */
  totalEstimated: boolean;
  /** Rows the current page actually returned. */
  rowsOnPage: number;
}

export function pageWindow({
  offset,
  pageSize,
  total,
  totalEstimated,
  rowsOnPage,
}: PageWindowInput): PageWindow {
  return {
    from: offset + 1,
    to: Math.min(offset + pageSize, total ?? offset + pageSize),
    canPrev: offset > 0,
    // With an *exact* total, stop at the last page. Otherwise — count still in
    // flight, failed, or only an *estimate*, which can undershoot the real row
    // count on stale statistics and must not strand the user before the true
    // end — fall back to "there might be more" whenever the current page came
    // back full. A short page then naturally disables Next at the real end.
    canNext:
      total !== null && !totalEstimated
        ? offset + pageSize < total
        : rowsOnPage >= pageSize,
  };
}

/** Offset of the previous page, never negative. */
export function prevOffset(offset: number, pageSize: number): number {
  return Math.max(0, offset - pageSize);
}

/** Offset of the next page. Guarding it is `canNext`'s job, not this one's. */
export function nextOffset(offset: number, pageSize: number): number {
  return offset + pageSize;
}

/**
 * The offset that puts row `row` (1-based, as the footer's range counts) at
 * the top of the page — "go to row", the grid's answer to Compass's *Skip*.
 *
 * Deliberately not page-aligned: asking for row 250 shows 250–349, which is
 * what a row number means, and prev/next step by `pageSize` from wherever the
 * page starts. Past an **exact** total it clamps to the last row; an estimate
 * can undershoot, so it is not a ceiling (the same reasoning as `canNext`).
 * `null` for anything that is not a whole number ≥ 1.
 */
export function offsetForRow(
  input: string,
  total: number | null,
  totalEstimated: boolean,
): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  let row = Number(text);
  if (!Number.isSafeInteger(row) || row < 1) return null;
  if (total !== null && !totalEstimated && total > 0) row = Math.min(row, total);
  return row - 1;
}

/**
 * Where the footer's background count stands. `failed` is distinct from
 * `loading` because both leave `total` at `null`, and only one of them is worth
 * offering a retry for.
 */
export type CountStatus = "loading" | "ready" | "failed";

/**
 * Whether the footer offers the *exact count* action.
 *
 * Offered when the total on screen cannot be trusted as a size: an engine
 * estimate (`~N`), or no total at all because the background count gave up —
 * on MongoDB a filtered count is capped at ten seconds, and the collections
 * that hit that cap are exactly the ones whose size someone wants to confirm.
 * Not while the background count is still running (it may yet answer), not
 * while an exact count is already on the wire, and not once the total is
 * exact: refresh, or a new filter, is what makes it stale again.
 */
export function offerExactCount({
  status,
  totalEstimated,
  exactRunning,
}: {
  status: CountStatus;
  totalEstimated: boolean;
  exactRunning: boolean;
}): boolean {
  if (exactRunning) return false;
  if (status === "failed") return true;
  return status === "ready" && totalEstimated;
}

/**
 * The number the grid's gutter (and the list view's card header) shows for
 * the row at position `index` of the page that starts at `offset` — absolute,
 * so page 2 of a 100-row page begins at 101, the same count the footer's range
 * and "go to row" use.
 *
 * A *display* number only. `index` is the row's position on screen, after any
 * client-side filter or sort, so it never identifies a row — identity stays
 * with the row's values (ADR #7). Surfaces that do not paginate (query and view
 * results) pass `offset` 0.
 */
export function rowNumber(offset: number, index: number): number {
  return offset + index + 1;
}
