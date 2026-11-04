/**
 * @vitest-environment jsdom
 *
 * Characterization tests for the table browser's data hook, written when it
 * was extracted from `TableDataTab` (refactor block 4). They pin the parts
 * that are easy to break by "tidying" and hard to notice when broken:
 *
 * - the page goes out first and the count waits for it to settle, so one tab
 *   holds one pooled connection at a time;
 * - the count is keyed on the predicate, so paging and sorting do not recount;
 * - an exact count whose predicate moved on while it ran is dropped;
 * - a failed count leaves the total empty and says so, a failed page says why;
 * - refresh reloads the page *and* the total, and retries a missing field list.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types";
import { useTableBrowse, type TableBrowseQuery } from "./useTableBrowse";

const fetchTableData = vi.fn();
const countTableRows = vi.fn();
const loadColumns = vi.fn();
const notifyError = vi.fn();

vi.mock("@/lib/tauri", () => ({
  api: {
    fetchTableData: (...args: unknown[]) => fetchTableData(...args),
    countTableRows: (...args: unknown[]) => countTableRows(...args),
  },
}));

vi.mock("@/stores/session/schema", () => ({
  useSchema: (select: (s: { loadColumns: typeof loadColumns }) => unknown) =>
    select({ loadColumns }),
}));

vi.mock("@/lib/notify", () => ({
  notify: {
    error: (...args: unknown[]) => notifyError(...args),
    info: vi.fn(),
    progress: vi.fn(() => ({ dismiss: vi.fn(), error: vi.fn() })),
  },
}));

// A stable `t` that returns the key, so assertions name the message.
const t = (key: string) => key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));

const page = (rows: unknown[][] = [[1]]): QueryResult =>
  ({
    columns: [{ name: "id", type_name: "int" }],
    rows,
  }) as unknown as QueryResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const base: TableBrowseQuery = {
  connectionId: "c1",
  schema: undefined,
  table: "orders",
  pageSize: 100,
  offset: 0,
  sort: [],
  serverFilters: [],
  appliedFilter: "",
  wire: undefined,
  raw: undefined,
  collation: undefined,
  hint: undefined,
  trimAbove: undefined,
  searchColumns: ["id"],
  columnsMissing: false,
};

beforeEach(() => {
  fetchTableData.mockResolvedValue(page());
  countTableRows.mockResolvedValue({ total: 42, estimated: true });
});

afterEach(() => {
  fetchTableData.mockReset();
  countTableRows.mockReset();
  loadColumns.mockReset();
  notifyError.mockReset();
});

describe("opening a table", () => {
  it("sends the page first and counts only once it has settled", async () => {
    const first = deferred<QueryResult>();
    fetchTableData.mockReturnValueOnce(first.promise);

    const { result } = renderHook(() => useTableBrowse(base));
    expect(result.current.loading).toBe(true);
    expect(fetchTableData).toHaveBeenCalledTimes(1);
    expect(fetchTableData.mock.calls[0][0]).toMatchObject({
      connectionId: "c1",
      table: "orders",
      limit: 100,
      offset: 0,
      withCount: false,
    });
    // The count is waiting for the page to give its connection back.
    await act(async () => {});
    expect(countTableRows).not.toHaveBeenCalled();
    expect(result.current.countStatus).toBe("loading");

    await act(async () => first.resolve(page([[1], [2]])));
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));
    expect(result.current.result?.rows).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(countTableRows).toHaveBeenCalledTimes(1);
    expect(result.current.total).toBe(42);
    expect(result.current.totalEstimated).toBe(true);
  });

  it("loads the field list when it is missing", async () => {
    renderHook(() => useTableBrowse({ ...base, columnsMissing: true }));
    expect(loadColumns).toHaveBeenCalledWith("c1", undefined, "orders");
  });

  it("sends the search columns only while a search is applied", async () => {
    renderHook(() => useTableBrowse({ ...base, appliedFilter: "bob" }));
    expect(fetchTableData.mock.calls[0][0]).toMatchObject({
      search: "bob",
      searchColumns: ["id"],
    });
    await waitFor(() => expect(countTableRows).toHaveBeenCalled());
    expect(countTableRows.mock.calls[0][0]).toMatchObject({
      search: "bob",
      searchColumns: ["id"],
    });
  });
});

describe("what changes re-read what", () => {
  it("pages and sorts without recounting", async () => {
    const { result, rerender } = renderHook((q) => useTableBrowse(q), {
      initialProps: base,
    });
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));

    rerender({ ...base, offset: 100 });
    await waitFor(() => expect(result.current.resultOffset).toBe(100));
    rerender({ ...base, offset: 100, sort: [{ column: "id", desc: true }] });
    await waitFor(() => expect(fetchTableData).toHaveBeenCalledTimes(3));

    expect(countTableRows).toHaveBeenCalledTimes(1);
    expect(result.current.total).toBe(42);
  });

  it("recounts when the predicate changes", async () => {
    const { result, rerender } = renderHook((q) => useTableBrowse(q), {
      initialProps: base,
    });
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));

    countTableRows.mockResolvedValue({ total: 3, estimated: false });
    rerender({
      ...base,
      serverFilters: [{ column: "id", op: "eq", value: 1 }],
    });
    await waitFor(() => expect(result.current.total).toBe(3));
    expect(countTableRows).toHaveBeenCalledTimes(2);
    expect(result.current.totalEstimated).toBe(false);
  });
});

describe("failures", () => {
  it("keeps the page when the count fails, and says the count gave up", async () => {
    countTableRows.mockRejectedValue(new Error("timeout"));
    const { result } = renderHook(() => useTableBrowse(base));
    await waitFor(() => expect(result.current.countStatus).toBe("failed"));
    expect(result.current.total).toBeNull();
    expect(result.current.result).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reports a failed page as the error", async () => {
    fetchTableData.mockRejectedValue("relation does not exist");
    const { result } = renderHook(() => useTableBrowse(base));
    await waitFor(() =>
      expect(result.current.error).toBe("relation does not exist"),
    );
    expect(result.current.loading).toBe(false);
  });
});

describe("the exact count", () => {
  it("replaces the estimate with the exact figure", async () => {
    const { result } = renderHook(() => useTableBrowse(base));
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));

    countTableRows.mockResolvedValue({ total: 40, estimated: false });
    await act(() => result.current.countExactly());
    expect(countTableRows.mock.calls[1][1]).toBe(true);
    expect(result.current.total).toBe(40);
    expect(result.current.totalEstimated).toBe(false);
    expect(result.current.exactCounting).toBe(false);
  });

  it("drops its answer when the predicate moved on while it ran", async () => {
    const { result, rerender } = renderHook((q) => useTableBrowse(q), {
      initialProps: base,
    });
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));

    const exact = deferred<{ total: number; estimated: boolean }>();
    countTableRows.mockReturnValueOnce(exact.promise);
    let running!: Promise<void>;
    act(() => {
      running = result.current.countExactly();
    });
    expect(result.current.exactCounting).toBe(true);

    // A new filter: the background count for it answers 7.
    countTableRows.mockResolvedValue({ total: 7, estimated: false });
    rerender({
      ...base,
      serverFilters: [{ column: "id", op: "gt", value: 5 }],
    });
    await waitFor(() => expect(result.current.total).toBe(7));

    // The exact count of the *old* predicate lands late and is ignored.
    await act(async () => {
      exact.resolve({ total: 999, estimated: false });
      await running;
    });
    expect(result.current.total).toBe(7);
  });

  it("notifies a failure instead of touching the total", async () => {
    const { result } = renderHook(() => useTableBrowse(base));
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));

    countTableRows.mockRejectedValue(new Error("killed"));
    await act(() => result.current.countExactly());
    expect(notifyError).toHaveBeenCalledWith("tableData.exactCountFailed", {
      description: "Error: killed",
    });
    expect(result.current.total).toBe(42);
  });
});

describe("refresh", () => {
  it("reloads the page and the total, and retries a missing field list", async () => {
    const { result } = renderHook(() =>
      useTableBrowse({ ...base, columnsMissing: true }),
    );
    await waitFor(() => expect(result.current.countStatus).toBe("ready"));
    loadColumns.mockClear();

    countTableRows.mockResolvedValue({ total: 43, estimated: true });
    await act(() => result.current.reloadAll());
    await waitFor(() => expect(result.current.total).toBe(43));

    expect(fetchTableData).toHaveBeenCalledTimes(2);
    expect(countTableRows).toHaveBeenCalledTimes(2);
    expect(loadColumns).toHaveBeenCalledTimes(1);
  });
});
