/**
 * Column auto-fit measurement for the data grid — the width math behind
 * HeidiSQL's "double-click a column's edge and it grows to fit its content".
 *
 * Measurement goes through one offscreen canvas instead of the DOM on
 * purpose: `measureText` costs no layout, so a column holding thousands of
 * rows is measured in a single pass. The obvious alternative (a hidden probe
 * element read back through `offsetWidth`) forces a reflow per cell, which on
 * a full page of rows is exactly the kind of stall the grid's own resize path
 * was written to avoid (see `startColumnResize` in `DataGrid.tsx`).
 */

/** Lazily-created, module-shared 2D context. Never drawn into. */
let sharedCtx: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | null {
  if (sharedCtx === undefined) {
    sharedCtx = document.createElement("canvas").getContext("2d");
  }
  return sharedCtx;
}

/**
 * Longest prefix of a cell value we bother measuring. A cell can hold
 * megabytes (a JSON document, a base64 blob), and measuring all of it would
 * be pointless as well as slow: at the grid's smallest font a 512-character
 * string already measures wider than any width the caller's `max` clamp will
 * allow, so the slice can never change the clamped result.
 */
const MEASURE_CHAR_CAP = 512;

/**
 * Build a canvas `font` shorthand matching what a real grid element renders
 * with. The font family comes from the theme's CSS (`font-mono` for cells,
 * the app's sans stack for headers), so it can't be hardcoded here — a
 * throwaway probe element carrying the same class list is appended to `host`
 * and its computed style read back. One reflow per auto-fit, not per cell.
 *
 * @param host - Element to parent the probe to, so it inherits the grid's
 *   cascade. Falls back to `document.body`.
 * @param className - Tailwind classes that decide the family/weight.
 * @param fontSizePx - Rendered size in px (the grid's font sizes are dynamic,
 *   derived from the `rowHeight` zoom preference).
 */
export function resolveCanvasFont(
  host: HTMLElement | null,
  className: string,
  fontSizePx: number,
): string {
  const parent = host ?? document.body;
  const probe = document.createElement("span");
  probe.className = className;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.fontSize = `${fontSizePx}px`;
  parent.appendChild(probe);
  const cs = getComputedStyle(probe);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  probe.remove();
  return font;
}

/** One measurable run of text: its content, its font, and CSS letter-spacing. */
export interface FitText {
  text: string;
  font: string;
  /**
   * `letter-spacing` in px, added per character. Canvas has a `letterSpacing`
   * property but its support is uneven across the WebViews we ship on
   * (WebView2 vs WebKitGTK), so it's applied arithmetically instead.
   */
  letterSpacing?: number;
}

export interface ColumnFitInput {
  /** The column name, as rendered in the header (already upper-cased). */
  header: FitText;
  /** The dimmed data-type hint next to it. */
  type: FitText;
  /**
   * Fixed px the header cell spends on things that aren't text: key icons,
   * the sort glyph, the flex gaps between them.
   */
  headerChrome: number;
  /** Body cells in *display* form — already formatted, truncated, NULL-ified. */
  cells: readonly string[];
  /** Font the body cells render with. */
  cellFont: string;
  /** Horizontal padding + borders wrapping the text in both rows. */
  padding: number;
  min: number;
  max: number;
}

function widthOf(run: FitText): number {
  const ctx = measureCtx();
  if (!ctx || !run.text) return 0;
  ctx.font = run.font;
  return (
    ctx.measureText(run.text).width + (run.letterSpacing ?? 0) * run.text.length
  );
}

/**
 * Width (px) that shows a column's widest visible value in full, clamped to
 * `[min, max]`. Both rows are considered — a narrow column of short values
 * under a long name must still show its header, which is what makes the
 * gesture feel like "fit the column" rather than "fit the data".
 */
export function computeColumnFitWidth(input: ColumnFitInput): number {
  const ctx = measureCtx();
  // No canvas (very old WebView, or a non-DOM test env): leave the width
  // alone rather than collapsing every column to `min`.
  if (!ctx) return input.min;

  const headerWidth =
    widthOf(input.header) + widthOf(input.type) + input.headerChrome;

  ctx.font = input.cellFont;
  let bodyWidth = 0;
  for (const raw of input.cells) {
    // Cells render with `truncate` (i.e. `white-space: nowrap`), so runs of
    // whitespace — newlines in a JSON document, tabs in a pasted value —
    // collapse to a single space on screen. Measuring the raw string would
    // massively over-size a multi-line value.
    const text = raw.slice(0, MEASURE_CHAR_CAP).replace(/\s+/g, " ");
    if (!text) continue;
    const w = ctx.measureText(text).width;
    if (w > bodyWidth) bodyWidth = w;
  }

  // +2px of slack: `measureText` is fractional and the browser rounds the
  // rendered box down, which is enough to trigger an ellipsis on the very
  // value we just measured.
  const content = Math.max(headerWidth, bodyWidth) + input.padding + 2;
  return Math.round(Math.min(input.max, Math.max(input.min, content)));
}

/** Per-column inputs the caller resolves; see [`computeAutoFitWidths`]. */
export interface AutoFitInput {
  /**
   * Element the measurement probes inherit the grid's cascade from — the
   * scroll container. `null` falls back to `document.body`.
   */
  host: HTMLElement | null;
  /** Columns to fit, by name. */
  colIds: readonly string[];
  /** Every column, in backend order. */
  columns: readonly { name: string; data_type: string }[];
  /**
   * Backend index for a column name. Display order can differ from backend
   * order, and the values are indexed by the latter (ADR #7's neighbour).
   */
  columnIndexByName: ReadonlyMap<string, number>;
  /** Rows in scope — the fetched page after the client filter. */
  rows: readonly (readonly unknown[])[];
  /**
   * Exactly what the `cell` renderer paints for this value, NULL placeholder
   * and length cap included. Passed as a function rather than as the four
   * preferences behind it so the fit cannot drift from the render: a column
   * measured as `1` and painted as `true` is fitted two characters too narrow.
   */
  cellText: (value: unknown, columnIndex: number) => string;
  /**
   * Fixed px this column's header spends on things that are not text — key
   * icons, the sort glyph, the multi-sort rank badge, the flex gaps.
   */
  headerChrome: (columnName: string) => number;
  cellFontSize: number;
  headerFontSize: number;
  /** The dimmed type hint's size. Fixed (`text-3xs`), not derived from the
   *  zoom like the rest of the header. */
  typeFontSize: number;
  min: number;
  max: number;
}

/**
 * Widths for a set of columns, keyed by column name — HeidiSQL's "double-click
 * a column's edge and it grows to fit", and the toolbar's "fit every column".
 *
 * Lives here rather than in the grid because it is a pure function of the
 * strings on screen: given the same rows, fonts and clamps it returns the same
 * widths, with no React state involved. The component keeps only the wiring —
 * gathering the fonts, describing how a cell renders, committing the result as
 * one preference write.
 *
 * The three fonts are resolved **once per gesture, not once per column**: each
 * resolution appends a probe element and reads its computed style, which
 * forces a style recalc, so the "fit every column" path would otherwise pay
 * for three times the column count.
 *
 * Scope is the caller's `rows` — in practice the fetched page after the client
 * filter, matching HeidiSQL. Fitting to rows the user cannot see would need a
 * full-table scan per double-click.
 */
export function computeAutoFitWidths(
  input: AutoFitInput,
): Record<string, number> {
  const cellFont = resolveCanvasFont(
    input.host,
    "font-mono",
    input.cellFontSize,
  );
  const headerFont = resolveCanvasFont(input.host, "", input.headerFontSize);
  const typeFont = resolveCanvasFont(input.host, "", input.typeFontSize);

  const widths: Record<string, number> = {};
  for (const colId of input.colIds) {
    const idx = input.columnIndexByName.get(colId);
    if (idx === undefined) continue;
    const col = input.columns[idx];
    if (!col) continue;
    widths[colId] = computeColumnFitWidth({
      // The header renders `uppercase tracking-wider`; both change its width,
      // and neither is visible to `measureText` unless applied here.
      header: {
        text: col.name.toUpperCase(),
        font: headerFont,
        letterSpacing: input.headerFontSize * 0.05,
      },
      type: {
        text: col.data_type.toUpperCase(),
        font: typeFont,
        letterSpacing: input.typeFontSize * 0.05,
      },
      headerChrome: input.headerChrome(col.name),
      cells: input.rows.map((row) => input.cellText(row[idx], idx)),
      cellFont,
      min: input.min,
      max: input.max,
      // `px-2` on both the `<th>` and every `<td>`, plus the 1px right border.
      padding: 17,
    });
  }
  return widths;
}

/**
 * Rescale a set of content-fitted widths so their total lands exactly on the
 * width available on screen — "fit the columns to the window", the companion to
 * the per-column fit above.
 *
 * The two gestures answer different questions and both are wanted. Fitting to
 * *content* asks "how wide does this column need to be to be readable", and
 * happily overflows: with thirty columns you get a horizontal scrollbar, which
 * is correct, because the alternative is thirty unreadable columns. Fitting to
 * *width* asks "show me the whole row at once" and accepts truncation as the
 * price. Neither is a better default than the other, so neither replaces the
 * other.
 *
 * Proportional in both directions rather than equalising. The content fit is
 * what carries the table's visual hierarchy — an `id` column is narrow because
 * its values are, a `description` is wide because its values are — and dividing
 * the width equally throws that away, giving a boolean column the same room as
 * a paragraph. Scaling preserves the ratio.
 *
 * **Shrinking is water-filling, not a single multiply.** A flat
 * `w * (available / total)` drives the already-narrow columns under `min`,
 * and clamping them afterwards overshoots the target — the clamped columns
 * keep more width than their share, so the total comes out wider than the
 * viewport and the scrollbar the gesture was meant to remove stays. Each pass
 * therefore clamps whatever fell below `min`, removes it from the budget, and
 * rescales only the columns still free to move. It terminates because every
 * pass either clamps at least one column or finishes.
 *
 * When even `min` for every column exceeds what is available, the result is
 * `min` throughout and the grid still scrolls. That is honest: there is no
 * width assignment that fits, and the alternative is columns too narrow to hold
 * a single character.
 *
 * @param natural - Content-fitted widths by column name (from
 *   `computeAutoFitWidths`), which is what keeps the proportions meaningful.
 * @param available - Px the columns may occupy: the scrollport's inner width
 *   less the leading gutter. The caller owns that subtraction because only it
 *   knows which non-data columns are in play.
 * @param min - Floor per column, `MIN_COLUMN_WIDTH`. No maximum: the whole
 *   point when growing is to spend the available width, and `MAX_AUTOFIT_WIDTH`
 *   has already bounded `natural`.
 */
export function distributeToWidth(
  natural: Record<string, number>,
  available: number,
  min: number,
): Record<string, number> {
  const ids = Object.keys(natural);
  if (ids.length === 0) return {};

  // Nothing sensible to scale against: a zero or negative budget (the panel is
  // collapsed, or the gutter is wider than the scrollport) would otherwise
  // produce a division by zero and then `NaN` widths, which reach the DOM as
  // dropped `style.width` declarations rather than as an error.
  if (!Number.isFinite(available) || available <= 0) return {};

  const clamped = new Map<string, number>();
  let free = ids.slice();

  for (;;) {
    const budget = available - [...clamped.values()].reduce((a, b) => a + b, 0);
    const freeTotal = free.reduce(
      (sum, id) => sum + Math.max(natural[id], 1),
      0,
    );
    if (free.length === 0) break;

    // Every remaining column would land at or under the floor: clamp them all
    // and stop, rather than looping one column at a time to the same place.
    if (budget <= free.length * min) {
      for (const id of free) clamped.set(id, min);
      free = [];
      break;
    }

    const scale = budget / freeTotal;
    const under = free.filter((id) => Math.max(natural[id], 1) * scale < min);
    if (under.length === 0) {
      for (const id of free) {
        clamped.set(
          id,
          Math.max(min, Math.round(Math.max(natural[id], 1) * scale)),
        );
      }
      free = [];
      break;
    }
    for (const id of under) clamped.set(id, min);
    free = free.filter((id) => !under.includes(id));
  }

  // Rounding each column independently leaves the total a few px off the
  // target, which on a `table-fixed` layout is exactly the gap that leaves a
  // 3px scrollbar behind — the one symptom this whole function exists to
  // remove. Put the remainder on the widest column, where it is least visible.
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = clamped.get(id) ?? min;
  const drift = available - Object.values(out).reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    const widest = ids.reduce((a, b) => (out[a] >= out[b] ? a : b));
    if (out[widest] + drift >= min) out[widest] += drift;
  }
  return out;
}
