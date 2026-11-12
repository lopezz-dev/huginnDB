// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  sameTabsIgnoringQuery,
  useTabs,
  useTabsIgnoringQuery,
} from "@/stores/session/tabs";
import type { AppTab } from "@/types";

function tab(id: string, query = ""): AppTab {
  return { id, kind: "query", title: id, connectionId: "c1", query };
}

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null });
});

describe("sameTabsIgnoringQuery", () => {
  it("treats a change to a tab's query as no change", () => {
    const a = [tab("t1", "select 1"), tab("t2")];
    const b = [{ ...a[0], query: "select 12" }, a[1]];
    expect(sameTabsIgnoringQuery(a, b)).toBe(true);
  });

  it("sees any other field change", () => {
    const a = [tab("t1")];
    expect(sameTabsIgnoringQuery(a, [{ ...a[0], title: "renamed" }])).toBe(false);
    expect(sameTabsIgnoringQuery(a, [{ ...a[0], pinned: true }])).toBe(false);
  });

  it("sees tabs opening, closing and moving", () => {
    const [x, y] = [tab("t1"), tab("t2")];
    expect(sameTabsIgnoringQuery([x], [x, y])).toBe(false);
    expect(sameTabsIgnoringQuery([x, y], [y, x])).toBe(false);
  });
});

describe("useTabsIgnoringQuery", () => {
  it("keeps the same array while SQL is typed, and follows real changes", () => {
    act(() => {
      useTabs.getState().replaceAll([tab("t1")], "t1");
    });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useTabsIgnoringQuery();
    });
    const first = result.current;
    const rendersBefore = renders;

    act(() => {
      useTabs.getState().updateQuery("t1", "select");
      useTabs.getState().updateQuery("t1", "select *");
    });
    expect(result.current).toBe(first);
    expect(renders).toBe(rendersBefore);

    act(() => {
      useTabs.getState().setPinned("t1", true);
    });
    expect(result.current).not.toBe(first);
    expect(result.current[0].pinned).toBe(true);
  });
});
