/**
 * @vitest-environment jsdom
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Separator } from "./separator";

afterEach(() => {
  cleanup();
});

function cls(el: Element | null): string {
  return el?.getAttribute("class") ?? "";
}

describe("Separator", () => {
  it("is a decorative hairline that never shrinks out of a crowded row", () => {
    const { container } = render(<Separator />);
    const el = container.firstElementChild;
    expect(el?.getAttribute("aria-hidden")).toBe("true");
    expect(el?.getAttribute("role")).toBeNull();
    for (const c of ["w-px", "shrink-0", "bg-border"]) expect(cls(el)).toContain(c);
  });

  it("offers the two heights the twelve hand-rolled ones reconcile to", () => {
    for (const [size, h] of [
      ["default", "h-4"],
      ["sm", "h-3"],
    ] as const) {
      cleanup();
      const { container } = render(<Separator size={size} />);
      expect(cls(container.firstElementChild).split(" ")).toContain(h);
    }
  });

  it("takes a margin from the caller without losing its own classes", () => {
    const { container } = render(<Separator className="mx-1" />);
    const c = cls(container.firstElementChild);
    expect(c).toContain("mx-1");
    expect(c).toContain("h-4");
  });
});
