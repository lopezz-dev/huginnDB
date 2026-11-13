/**
 * @vitest-environment jsdom
 *
 * `useRelationPolicy` reads the policy once for one relation and hands every
 * consumer the same answer (ADR #135). Pinned: each verb's lock comes through
 * as its sentence, the column locks exist only when a verb is limited by
 * column (so the grid's per-cell path stays untouched for everyone else), and
 * the answer keeps its identity across renders while the policy's does — the
 * grid derives its header locks from it in a memo.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  locks: {} as Record<string, string | null>,
  columns: {
    insert: null as string[] | null,
    update: null as string[] | null,
    lock: (verb: string, column: string): string | null =>
      `${verb}:${column}`,
  },
  calls: [] as unknown[][],
}));

vi.mock("@/lib/policy/access", () => ({
  usePolicyLocker: (...args: unknown[]) => {
    h.calls.push(args);
    return (need: string) => h.locks[need] ?? null;
  },
  usePolicyColumns: () => h.columns,
}));

import { useRelationPolicy } from "./useRelationPolicy";

const REL = { schema: "shop", name: "items" };

beforeEach(() => {
  h.locks = {};
  h.columns = { ...h.columns, insert: null, update: null };
  h.calls = [];
});

describe("useRelationPolicy", () => {
  it("passes each verb's lock through as its sentence", () => {
    h.locks = { update: "no update", export: "no export", freeSql: "no sql" };
    const { result } = renderHook(() => useRelationPolicy("c1", REL, false));
    expect(result.current).toMatchObject({
      insert: null,
      update: "no update",
      delete: null,
      export: "no export",
      freeSql: "no sql",
    });
    expect(h.calls[0]).toEqual(["c1", REL]);
  });

  it("has no column locks when no verb is limited by column", () => {
    const { result } = renderHook(() => useRelationPolicy("c1", REL, false));
    expect(result.current.updateColumnLock).toBeUndefined();
    expect(result.current.insertColumnLock).toBeUndefined();
  });

  it("builds a column lock per limited verb", () => {
    h.columns = { ...h.columns, update: ["qty"] };
    const { result } = renderHook(() => useRelationPolicy("c1", REL, false));
    expect(result.current.updateColumnLock?.("price")).toBe("update:price");
    expect(result.current.insertColumnLock).toBeUndefined();
    expect(result.current.columns).toEqual({ insert: null, update: ["qty"] });
  });

  it("keeps its identity across renders while the policy's answer does", () => {
    h.columns = { ...h.columns, update: ["qty"] };
    const { result, rerender } = renderHook(() =>
      useRelationPolicy("c1", REL, false),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
