/**
 * Shared single-line cell input used both by the inline INSERT draft row
 * and by inline cell editing (double-click on an existing cell).
 *
 * It renders a monospace text field plus one optional affordance: an "expand"
 * button that escalates to the full Monaco editor (shown when `onExpand` is
 * provided). There used to be a second, a "∅" button that forced the cell to
 * NULL directly from the inline field — removed as too easy to hit by
 * accident for what it does; clearing a value to NULL is still reachable from
 * the expand editor, which asks for it deliberately rather than as a
 * one-click slip.
 *
 * Commit / cancel wiring is opt-in: when `onCommit` / `onCancel` are given the
 * field commits on Enter and on blur, and cancels on Esc. The draft row leaves
 * them undefined because it owns keyboard / blur handling at the row level.
 *
 * The expand button calls `preventDefault` on mousedown so clicking it never
 * blurs the input first — which would otherwise trigger a premature commit in
 * inline-edit mode.
 *
 * **The affordance lives inside the field's box, not beside it.** It used to
 * be a flex sibling of a bordered `<input>`, painting its own opaque
 * `bg-background` so that `sticky` had something to sit on. Against a tinted
 * row — hover, selection, the draft row's own wash — that is a hard-edged pale
 * rectangle butted up against a rounded, focus-haloed field, which is the seam
 * this component was reported for. Now the wrapper carries the border and the
 * focus treatment (`fieldFocus("focus-within")`, the variant `styles.ts`
 * documents for exactly this shape), the input is transparent inside it, and
 * the button shares the field's own surface so there is nothing to seam
 * against. It stays `sticky` so a very wide column doesn't scroll it away.
 *
 * **The expand button is hand-rolled, not `IconButton`, and that is
 * deliberate.** `IconButton`'s smallest shape is a fixed 24px square —
 * exactly this field's own total height (`h-6`), so nesting one inside
 * leaves it no room to breathe: it touches the field's top and bottom edges
 * with nothing left for the rounded border to show around it. Same wall
 * `DocumentListView`'s inline field actions hit (see its own note on the
 * primitive layer's density floor) — this field is that same class of
 * control, just a row taller. What it keeps from the primitive is the themed
 * tooltip (`SimpleTooltip`, not a native `title=`), sized by its own padding
 * instead of a fixed box.
 */

import { forwardRef } from "react";
import { Braces, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldFocus } from "@/components/ui/styles";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface CellInputProps {
  /** Current value; `null` renders a "NULL" placeholder. */
  value: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string | null) => void;
  /** Commit on Enter / blur (inline single-cell mode only). */
  onCommit?: () => void;
  /** Cancel on Esc (inline single-cell mode only). */
  onCancel?: () => void;
  /** Render an expand button that escalates to the modal editor. */
  onExpand?: () => void;
  /** Tooltip for the expand button. */
  expandTitle?: string;
  /**
   * The column has a JSON Schema attached, so the expand button says so.
   *
   * This is the discoverability path for anyone who never opens the heavy
   * editor: a one-line `<input>` cannot offer completion or validation, so the
   * only hint that the schema exists is that escalating is worth it. Double-click
   * behaviour is unchanged (ADR #12) — this swaps an icon, nothing more.
   */
  schemaBound?: boolean;
}

export const CellInput = forwardRef<HTMLInputElement, CellInputProps>(
  function CellInput(
    {
      value,
      disabled,
      autoFocus,
      onChange,
      onCommit,
      onCancel,
      onExpand,
      expandTitle,
      schemaBound,
    },
    ref,
  ) {
    const wired = Boolean(onCommit || onCancel);
    return (
      <div
        className={cn(
          "flex h-6 items-center rounded-sm border border-input bg-background pl-1.5 transition-colors",
          fieldFocus("focus-within"),
          disabled && "opacity-60",
        )}
      >
        <input
          ref={ref}
          autoFocus={autoFocus}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          placeholder={value === null ? "NULL" : ""}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            wired
              ? (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommit?.();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel?.();
                  }
                }
              : undefined
          }
          onBlur={onCommit ? () => onCommit() : undefined}
        />
        {onExpand && (
          // `sticky`, not just flow position, so a wide column doesn't push
          // this off the right edge of the scroll container — the field
          // stretches to the cell's full (possibly very wide) width, and
          // without this it was only reachable by scrolling that specific
          // cell all the way over. The wrapper is opaque for the same reason
          // it always was (sticky content scrolls over what's beneath it),
          // painting the *field's* own surface from inside its border rather
          // than a rectangle of its own over the row.
          <span className="sticky right-0 z-[1] flex shrink-0 items-center bg-background pl-0.5 pr-1">
            <SimpleTooltip label={expandTitle}>
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                className={cn(
                  "rounded-sm p-1 transition-colors",
                  schemaBound
                    ? "text-brand hover:text-brand/80"
                    : "text-muted-foreground/80 hover:text-foreground",
                )}
                // Keep focus on the input so blur-commit doesn't fire before we
                // hand the current value off to the modal editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={onExpand}
              >
                {schemaBound ? (
                  <Braces className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </button>
            </SimpleTooltip>
          </span>
        )}
      </div>
    );
  },
);
