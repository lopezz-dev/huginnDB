/**
 * @vitest-environment jsdom
 *
 * `IconButton` exists to replace ~65 hand-rolled icon buttons and the ~120
 * native `title=` tooltips attached to them, so what these cover is the two
 * contracts that make that replacement safe: the button always has an
 * accessible name, and the escape hatch for in-menu titles still emits a real
 * `title` attribute.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Trash2 } from "lucide-react";
import { TooltipProvider } from "./tooltip";
import { BadgeDot, IconButton } from "./icon-button";

afterEach(() => {
  cleanup();
});

/** The themed tooltip is Radix's, which needs a provider above it. All three
 *  window roots have one; a test has to supply its own. */
const mount = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

describe("IconButton", () => {
  it("names itself from label, so an icon-only control is never anonymous", () => {
    mount(<IconButton icon={Trash2} label="Delete row" />);
    expect(screen.getByRole("button", { name: "Delete row" })).not.toBeNull();
  });

  it("uses the themed tooltip by default, emitting no native title", () => {
    mount(<IconButton icon={Trash2} label="Delete row" />);
    expect(screen.getByRole("button").getAttribute("title")).toBeNull();
  });

  it("falls back to a native title where Radix can't be used", () => {
    // Inside open menu content the Radix tooltip fights the menu's own portal
    // and hover handling, so those spots keep the OS tooltip. See tooltip.tsx.
    mount(<IconButton icon={Trash2} label="Delete row" nativeTitle />);
    expect(screen.getByRole("button").getAttribute("title")).toBe("Delete row");
  });

  it("is a square at both densities, which is what ends the p-0.5/p-1/p-1.5 spread", () => {
    mount(<IconButton icon={Trash2} label="a" />);
    expect(screen.getByRole("button").className).toContain("h-7");
    cleanup();
    mount(<IconButton icon={Trash2} label="a" size="xs" />);
    expect(screen.getByRole("button").className).toContain("h-6");
  });

  it("paints a badge over the glyph, anchored to the button", () => {
    mount(<IconButton icon={Trash2} label="a" badge={<BadgeDot />} />);
    const button = screen.getByRole("button");
    // `relative` is what anchors the badge's `absolute` to this button and
    // not to whatever positioned ancestor the toolbar happens to have.
    expect(button.className).toContain("relative");
    const dot = button.querySelector("span[aria-hidden]");
    expect(dot?.className).toContain("absolute");
    // The badge is decoration: the name is still the label alone.
    expect(screen.getByRole("button", { name: "a" })).not.toBeNull();
  });

  it("is not positioned when there is no badge to anchor", () => {
    mount(<IconButton icon={Trash2} label="a" badge={false} />);
    expect(screen.getByRole("button").className).not.toContain("relative");
  });

  it("spins and disables while loading", () => {
    mount(<IconButton icon={Trash2} label="a" loading />);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
  });

  it("carries the hairline edge by default", () => {
    mount(<IconButton icon={Trash2} label="a" />);
    expect(screen.getByRole("button").className).toContain("border-foreground/15");
  });

  it("goes flat on its own when it reveals on hover — a row action is dense chrome", () => {
    mount(<IconButton icon={Trash2} label="a" revealOnHover="row" />);
    expect(screen.getByRole("button").className).toContain("border-transparent");
    cleanup();
    // …unless the call site asks for the edge back.
    mount(<IconButton icon={Trash2} label="a" revealOnHover="row" flat={false} />);
    expect(screen.getByRole("button").className).toContain("border-foreground/15");
  });

  it("does not grow a tone edge back on a flat button", () => {
    // TONE is merged through className, which wins over the variant — so the
    // destructive edge colour has to be withheld, not merely overridden.
    mount(<IconButton icon={Trash2} label="a" tone="destructive" flat />);
    expect(screen.getByRole("button").className).not.toContain("hover:border-destructive");
    cleanup();
    mount(<IconButton icon={Trash2} label="a" tone="destructive" />);
    expect(screen.getByRole("button").className).toContain("hover:border-destructive/40");
  });

  it("hides behind its row's hover when asked, but stays reachable by keyboard", () => {
    mount(<IconButton icon={Trash2} label="a" revealOnHover="row" />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover/row:opacity-100");
    expect(cls).toContain("focus-visible:opacity-100");
  });

  it("keeps the resting colour muted in every tone, and only differs on hover", () => {
    for (const tone of ["quiet", "destructive", "brand"] as const) {
      cleanup();
      mount(<IconButton icon={Trash2} label="a" tone={tone} />);
      expect(screen.getByRole("button").className).toContain(
        "text-muted-foreground",
      );
    }
  });
});

describe("the tooltip provider fallback", () => {
  it("renders with no TooltipProvider above it", () => {
    // Radix throws when a Tooltip has no provider in scope, and offers no way
    // to ask. Before the sentinel in `tooltip.tsx`, putting an IconButton in a
    // component made that component unrenderable in any tree without a
    // provider — every test touching one had to know to wrap it, and one that
    // didn't failed with a stack trace pointing at Radix rather than at this.
    render(<IconButton icon={Trash2} label="Delete row" />);
    expect(screen.getByRole("button", { name: "Delete row" })).not.toBeNull();
  });
});
