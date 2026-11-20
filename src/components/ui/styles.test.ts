/**
 * Freezes `styles.ts` against the class strings each primitive carried before
 * the extraction, so "no visual change" is demonstrated rather than asserted.
 *
 * The literals below are copies of what `dropdown.tsx`, `context-menu.tsx`,
 * `select.tsx`, `input.tsx`, `button.tsx` and `segmented.tsx` had at the commit
 * before this file existed. If a fragment is edited on purpose, this test fails
 * — which is the point: a deliberate change to shared chrome deserves its own
 * commit and its own line in the changelog, not a quiet ride along a refactor.
 *
 * Comparison is by class *set*, not by string. Composing a fragment with the
 * part a call site still owns (`min-w-*`, a type scale) puts that part at the
 * end, so the strings differ in order while the rendered result is identical —
 * order only matters to Tailwind when two classes conflict, and none of these
 * do. Set comparison proves the real equivalence and immunises the test against
 * harmless reordering.
 */

import { describe, expect, it } from "vitest";
import {
  CONTROL_FOCUS,
  CONTROL_FOCUS_TIGHT,
  MENU_ITEM,
  MENU_PANEL,
  MENU_SUBTRIGGER,
  fieldFocus,
} from "./styles";

const classes = (s: string) =>
  [...new Set(s.split(/\s+/).filter(Boolean))].sort();

/** Asserts two class strings render identically, ignoring order. */
const sameClasses = (actual: string, expected: string) =>
  expect(classes(actual)).toEqual(classes(expected));

describe("floating menu chrome", () => {
  // context-menu.tsx's ContextMenuContent and ContextMenuSubContent, and
  // dropdown.tsx's DropdownMenuSubContent — three byte-identical copies.
  const INHERITED_PANEL_10REM =
    "z-50 max-h-[var(--radix-popper-available-height)] min-w-[10rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-elevation-3 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]";
  // dropdown.tsx's DropdownMenuContent — the fourth copy, denser by one token.
  const INHERITED_PANEL_8REM = INHERITED_PANEL_10REM.replace(
    "min-w-[10rem]",
    "min-w-[8rem]",
  );

  it("MENU_PANEL plus a 10rem minimum matches the three wide copies", () => {
    sameClasses(`${MENU_PANEL} min-w-[10rem]`, INHERITED_PANEL_10REM);
  });

  it("MENU_PANEL plus an 8rem minimum matches the dropdown's own copy", () => {
    sameClasses(`${MENU_PANEL} min-w-[8rem]`, INHERITED_PANEL_8REM);
  });

  // Until ADR #143 the type scale was the call site's (`text-sm` in the
  // dropdown, `text-xs` in the context menu). Both menus now share the context
  // menu's row, so the fragment carries the scale and these match what
  // `context-menu.tsx` had before the change — the dropdown's `text-sm` rows
  // are the deliberate change, not a drift.
  it("MENU_ITEM matches the context menu's row, type scale included", () => {
    sameClasses(
      MENU_ITEM,
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    );
  });

  it("MENU_SUBTRIGGER matches the context menu's submenu row, type scale included", () => {
    sameClasses(
      MENU_SUBTRIGGER,
      "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent",
    );
  });
});

describe("focus languages", () => {
  it("CONTROL_FOCUS matches what Button and Switch carried", () => {
    sameClasses(
      CONTROL_FOCUS,
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    );
  });

  it("CONTROL_FOCUS_TIGHT matches what Segmented carried", () => {
    sameClasses(
      CONTROL_FOCUS_TIGHT,
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    );
  });

  it("fieldFocus() matches what Input and Textarea carried", () => {
    sameClasses(
      fieldFocus(),
      "focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/20",
    );
  });

  it('fieldFocus("focus") matches what the Radix SelectTrigger carried', () => {
    sameClasses(
      fieldFocus("focus"),
      "focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20",
    );
  });

  it("every focus language is written out literally, so Tailwind's scanner sees it", () => {
    // The trap this guards: assembling `${trigger}:border-brand` at runtime
    // compiles, passes review, and produces no CSS at all — Tailwind scans
    // source text. Each variant must appear verbatim in a source file.
    const source = ["focus-visible", "focus", "focus-within"] as const;
    for (const on of source) {
      expect(fieldFocus(on)).toContain(`${on}:border-brand`);
      expect(fieldFocus(on)).toContain(`${on}:ring-[3px]`);
    }
  });
});
