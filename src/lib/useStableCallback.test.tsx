// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity while calling the latest function", () => {
    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => useStableCallback((x: number) => x + n),
      { initialProps: { n: 1 } },
    );
    const first = result.current;
    expect(first?.(1)).toBe(2);
    rerender({ n: 10 });
    expect(result.current).toBe(first);
    expect(result.current?.(1)).toBe(11);
  });

  it("follows the function's presence, which children read", () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useStableCallback(on ? () => "here" : undefined),
      { initialProps: { on: false } },
    );
    expect(result.current).toBeUndefined();
    rerender({ on: true });
    expect(result.current?.()).toBe("here");
    rerender({ on: false });
    expect(result.current).toBeUndefined();
  });
});
