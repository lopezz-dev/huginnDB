/**
 * Class fragments shared between the primitives in this directory.
 *
 * Strings and lookups only — no `cva`, no JSX, no React. Each primitive keeps
 * its own `cva` call in its own file; a second variant system living here would
 * be exactly the kind of divergence this file exists to end.
 *
 * Admission rule, deliberately strict: a fragment belongs here only if it has
 * **two or more consumers inside `ui/`** *and* encodes a decision somebody
 * made, rather than a typographic coincidence. That is why nothing speculative
 * is exported — `MICRO_HEADING` and the row-hover reveal arrive with the
 * primitives that consume them, following the norm `segmented.tsx` records
 * (create on first adoption, never in advance).
 *
 * One thing is deliberately NOT extracted, because extracting it would erase
 * a decision rather than share one: `min-w-*` is not part of `MENU_PANEL`. A
 * context menu sizes itself by its `width` tier (`10`/`14`/`18rem`) while a
 * dropdown's floor is `8rem` and its consumer sets the rest.
 *
 * The type scale used to be on that list too — the dropdown was `text-sm` on
 * 32px rows "by design". ADR #143 retired that: every menu row is now 12px on
 * 28px, so the scale lives in `MENU_ITEM` / `MENU_SUBTRIGGER`.
 */

/** Where a field's focus treatment hangs. See `fieldFocus`. */
export type FocusTrigger = "focus-visible" | "focus" | "focus-within";

/**
 * The field focus language: the border itself turns brand blue and a soft 3px
 * halo sits directly against it. `input.tsx` documents why this is not the
 * detached `ring-2 + ring-offset-2` of a button — a floating ring reads heavy
 * on a 28px-tall field.
 *
 * Three entries rather than one interpolated template because the same visual
 * language hangs off three different pseudo-classes: `focus-visible` for a real
 * `<input>`, `focus` for Radix's `SelectTrigger` (a `<button>`, which never
 * receives `focus-visible` from a click), and `focus-within` for a wrapper div
 * around an input (`connection/TreeFilterBox.tsx`).
 *
 * DO NOT collapse these into `` `${on}:border-brand` ``. Tailwind's JIT scans
 * source files as *text*: a class assembled at runtime never appears in the
 * scan, so the CSS is never generated and the focus treatment silently vanishes
 * — no build error, no failing test, just a field that stops highlighting. Each
 * variant has to be written out literally somewhere, and here is that somewhere.
 */
const FIELD_FOCUS: Record<FocusTrigger, string> = {
  "focus-visible":
    "focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/20",
  focus:
    "focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20",
  "focus-within":
    "focus-within:outline-none focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/20",
};

/** The field focus language, hung off `on` (default `focus-visible`). */
export function fieldFocus(on: FocusTrigger = "focus-visible"): string {
  return FIELD_FOCUS[on];
}

/**
 * The control focus language: a 2px ring detached from the control by an offset
 * painted in the page background. For buttons, switches, tabs — anything with
 * room around it.
 *
 * `ring-offset-background` is not optional. Without it the offset falls back to
 * Tailwind's default ring-offset colour (white), which paints a white gap
 * around a focused control on a dark theme.
 */
export const CONTROL_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The dense-control focus language: the same ring with no offset, for chrome
 * packed tightly enough that an offset would collide with a neighbour (the
 * status bar's ~22px controls, the segmented control's inner buttons).
 *
 * This is the language the legacy `ring-1 ring-ring` was reaching for. `ring-1`
 * is a hairline the theme's `--ring` renders almost invisibly at small sizes,
 * which is why it kept getting re-typed rather than adopted from anywhere.
 */
export const CONTROL_FOCUS_TIGHT =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A portalled floating menu panel. Pass your own `min-w-*` (see the header
 * note) and, if the panel scrolls its own way, your own `max-h-*` — `cn` is
 * tailwind-merge, so the consumer wins.
 *
 * `max-h` + vertical scroll rather than a bare `overflow-hidden`: a menu taller
 * than the space below its trigger (the connections list with every group
 * expanded — issue #111) used to be silently clipped with no way to reach the
 * cut-off items. `--radix-popper-available-height` is set by Radix's `size`
 * middleware on the floating wrapper and inherits down to this element, so the
 * cap tracks the real gap to the viewport edge. Horizontal clipping is kept so
 * long labels can't escape the rounded-sm corners.
 */
export const MENU_PANEL =
  "z-50 max-h-[var(--radix-popper-available-height)] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-elevation-3 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]";

/**
 * A selectable row inside a menu panel. `text-xs` with `py-1.5` is the one
 * menu density — 12px type on a 28px row — for context menus and dropdowns
 * alike (ADR #143).
 */
export const MENU_ITEM =
  "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/**
 * A menu row that opens a submenu. Not `MENU_ITEM` plus a modifier: it stays
 * highlighted while its submenu is open (`data-[state=open]:bg-accent`) and
 * carries no disabled treatment, since Radix's SubTrigger has no disabled
 * state to style. Same density as `MENU_ITEM`.
 */
export const MENU_SUBTRIGGER =
  "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent";

/**
 * An action that appears on hover of its container. `focus-visible` is in there
 * so the action stays reachable by keyboard, where there is no hover at all.
 *
 * Two named groups rather than one bare `group`, because these genuinely nest:
 * a document row (`group/row`) holds fields (`group/field`), each with its own
 * hover actions, and an unnamed group binds to whichever ancestor is nearest.
 * The app had three spellings of this between them.
 *
 * Written out per group for the reason `fieldFocus` documents at length: a
 * Tailwind class assembled at runtime is never generated.
 */
export const REVEAL_ON_HOVER = {
  row: "opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100",
  field:
    "opacity-0 transition-opacity group-hover/field:opacity-100 focus-visible:opacity-100",
} as const;

/**
 * The small uppercase heading that titles a group inside a panel. `text-3xs`
 * rather than `text-[10px]`: same pixel size, but with the line-height pinned,
 * which is what makes two adjacent section headers align.
 */
export const MICRO_HEADING =
  "text-3xs font-semibold uppercase tracking-wider text-muted-foreground";
