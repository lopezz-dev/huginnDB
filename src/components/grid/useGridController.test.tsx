/**
 * @vitest-environment jsdom
 *
 * The grid controller against a hand-built `GridSource` (ADR #135) — the
 * contract as any source sees it, apart from the table that first produced
 * one (`TableDataTab.test.tsx` pins the table's own rules):
 *
 * - each capability gates exactly its gesture: `null` wires it, a reason
 *   withholds it, and the empty reason withholds Insert without a sentence;
 * - a save reloads the page, a delete / paste / insert reloads everything;
 * - a row whose key cannot be read goes to `onError`, not to the server;
 * - the selection is reported unless the caller says not to.
 */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridSource } from "@/lib/grid/gridSource";
import type { PastePlan } from "@/lib/grid/pastePlan";

const h = vi.hoisted(() => ({
  notify: { error: vi.fn(), success: vi.fn() },
  dialogs: {} as Record<string, Record<string, unknown> | undefined>,
}));

vi.mock("@/lib/notify", () => ({ notify: h.notify }));
const t = (key: string) => key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));
vi.mock("@/components/grid/dialogs/DeleteRowsDialog", () => ({
  DeleteRowsDialog: (p: Record<string, unknown>) => {
    h.dialogs.delete = p;
    return null;
  },
}));
vi.mock("@/components/grid/dialogs/PasteCellsDialog", () => ({
  PasteCellsDialog: (p: Record<string, unknown>) => {
    h.dialogs.paste = p;
    return null;
  },
}));

import { useGridController } from "./useGridController";
import { usePreferences } from "@/stores/preferences/preferences";
import { useGridSelection } from "@/stores/grid/gridSelection";

const PLAN = { updates: [], inserts: [] } as unknown as PastePlan;

function fakeSource(over: Partial<GridSource> = {}): GridSource {
  return {
    identity: {
      connectionId: "c1",
      schema: "shop",
      table: "items",
      pkColumns: ["id"],
    },
    can: {
      update: null,
      delete: null,
      insert: null,
      duplicate: null,
      paste: null,
      bulkUpdate: null,
      export: null,
      fieldUnset: null,
      updateColumnLock: undefined,
      insertColumnLock: undefined,
    },
    pkResultNames: ["id"],
    documentMode: false,
    keyOf: (row) => [row[0]],
    getRowKey: (row) => JSON.stringify([row[0]]),
    hydrate: vi.fn((row) => Promise.resolve(row)),
    saveField: vi.fn(() => Promise.resolve()),
    unsetField: vi.fn(() => Promise.resolve()),
    deleteRows: vi.fn(() => Promise.resolve()),
    planPaste: vi.fn(() => PLAN),
    applyPaste: vi.fn(() => Promise.resolve({ updated: 2, inserted: 1 })),
    newDraft: () => ({
      cells: { id: { value: null, touched: false }, name: { value: null, touched: false } },
      error: null,
      saving: false,
    }),
    duplicateDraft: () => null,
    columnType: (c) => (c === "name" ? "text" : undefined),
    insertRow: vi.fn(() => Promise.resolve()),
    refreshPage: vi.fn(() => Promise.resolve()),
    refreshAll: vi.fn(() => Promise.resolve()),
    navigateFk: vi.fn(),
    ...over,
  };
}

function setup(source: GridSource, opts: { reportSelection?: boolean } = {}) {
  const onError = vi.fn();
  const hook = renderHook(
    ({ s }) => useGridController(s, { tabId: "t1", onError, ...opts }),
    { initialProps: { s: source } },
  );
  return { hook, onError, props: () => hook.result.current.gridProps };
}

/** Render the hook's dialogs so the stubs record their props. */
function renderDialogs(node: React.ReactNode) {
  render(<>{node}</>);
}

beforeEach(() => {
  h.dialogs = {};
  h.notify.error.mockClear();
  h.notify.success.mockClear();
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ui: { ...s.prefs.ui, confirmDestructive: true } },
  }));
});
afterEach(() => cleanup());

describe("useGridController — capabilities", () => {
  it("wires every gesture when everything is available", () => {
    const { props } = setup(fakeSource());
    const p = props();
    expect(p.editable).toBe(true);
    for (const k of [
      "onFieldDelete",
      "onPasteBlock",
      "onDeleteRow",
      "onBulkDelete",
      "onInsertRow",
      "onDuplicateRow",
      "onSelectionChange",
    ] as const) {
      expect(p[k], k).toBeTypeOf("function");
    }
    expect(p.insertBlocked).toBeNull();
  });

  it("withholds each gesture whose capability carries a reason", () => {
    const { props } = setup(
      fakeSource({
        can: {
          update: "no",
          delete: "no",
          insert: "Inserts are off",
          duplicate: "no",
          paste: "no",
          bulkUpdate: "no",
          export: "no",
          fieldUnset: "no",
          updateColumnLock: undefined,
          insertColumnLock: undefined,
        },
      }),
    );
    const p = props();
    expect(p.editable).toBe(false);
    expect(p.onFieldDelete).toBeUndefined();
    expect(p.onPasteBlock).toBeUndefined();
    expect(p.onDeleteRow).toBeUndefined();
    expect(p.onBulkDelete).toBeUndefined();
    expect(p.onInsertRow).toBeUndefined();
    expect(p.onDuplicateRow).toBeUndefined();
    expect(p.insertBlocked).toBe("Inserts are off");
  });

  it("the empty reason withholds Insert without a sentence", () => {
    const base = fakeSource();
    const { props } = setup({ ...base, can: { ...base.can, insert: "" } });
    expect(props().onInsertRow).toBeUndefined();
    expect(props().insertBlocked).toBeNull();
  });

  it("does not report the selection when told not to", () => {
    const { props } = setup(fakeSource(), { reportSelection: false });
    expect(props().onSelectionChange).toBeUndefined();
  });

  it("reports the selection under the tab's id and clears it on unmount", () => {
    const { hook, props } = setup(fakeSource());
    act(() => props().onSelectionChange!(2, 10));
    expect(useGridSelection.getState().byTab.t1).toEqual({ count: 2, total: 10 });
    hook.unmount();
    expect(useGridSelection.getState().byTab.t1).toBeUndefined();
  });
});

describe("useGridController — what reloads after a write", () => {
  it("a cell save reloads the page only", async () => {
    const s = fakeSource();
    const { props } = setup(s);
    await act(() => props().onCellSave([1, "a"], "name", "b"));
    expect(s.saveField).toHaveBeenCalledWith([1, "a"], ["name"], "b", undefined);
    expect(s.refreshPage).toHaveBeenCalledTimes(1);
    expect(s.refreshAll).not.toHaveBeenCalled();
  });

  it("a field removal reloads the page only", async () => {
    const s = fakeSource();
    const { props } = setup(s);
    await act(() => props().onFieldDelete!([1], ["tags", "0"]));
    expect(s.unsetField).toHaveBeenCalledWith([1], ["tags", "0"]);
    expect(s.refreshPage).toHaveBeenCalledTimes(1);
  });

  it("a confirmed delete reloads everything", async () => {
    const s = fakeSource();
    const { hook, props } = setup(s);
    act(() => props().onBulkDelete!([[1], [2]]));
    renderDialogs(hook.result.current.dialogs);
    expect(h.dialogs.delete).toMatchObject({
      connectionId: "c1",
      schema: "shop",
      table: "items",
      pkColumns: ["id"],
      pkValueRows: [[1], [2]],
    });
    await act(() => (h.dialogs.delete!.onDelete as () => Promise<void>)());
    expect(s.deleteRows).toHaveBeenCalledWith([[1], [2]]);
    expect(s.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("a confirmed paste reports its counts and reloads everything", async () => {
    const s = fakeSource();
    const { hook, props } = setup(s);
    const paste = { text: "x", rows: [[1, "a"]], columns: [] };
    await act(() => props().onPasteBlock!(paste));
    expect(s.planPaste).toHaveBeenCalledWith(paste, [[1, "a"]]);
    renderDialogs(hook.result.current.dialogs);
    expect(h.dialogs.paste).toMatchObject({ plan: PLAN, table: "shop.items" });
    await act(() => (h.dialogs.paste!.onApply as () => Promise<void>)());
    expect(s.applyPaste).toHaveBeenCalledWith(PLAN);
    expect(h.notify.success).toHaveBeenCalledWith("dataGrid.paste.done");
    expect(s.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("an insert sends the touched cells with the source's types and reloads everything", async () => {
    const s = fakeSource();
    const { props } = setup(s);
    act(() => props().onInsertRow!());
    act(() => props().onDraftCellChange("name", { value: "n", touched: true }));
    await act(() => props().onDraftCommit());
    expect(s.insertRow).toHaveBeenCalledWith([
      { column: "name", value: "n", columnType: "text" },
    ]);
    expect(s.refreshAll).toHaveBeenCalledTimes(1);
    expect(props().draftRow).toBeNull();
  });
});

describe("useGridController — failures", () => {
  it("a row whose key cannot be read goes to onError, not to the server", () => {
    const s = fakeSource({
      keyOf: () => {
        throw new Error("Primary-key columns missing from the result set");
      },
    });
    const { props, onError } = setup(s);
    act(() => props().onDeleteRow!([1]));
    expect(onError).toHaveBeenCalledWith(
      "Error: Primary-key columns missing from the result set",
    );
    expect(s.deleteRows).not.toHaveBeenCalled();
  });

  it("an unconfirmed delete the server refuses is toasted", async () => {
    usePreferences.setState((st) => ({
      prefs: { ...st.prefs, ui: { ...st.prefs.ui, confirmDestructive: false } },
    }));
    const s = fakeSource({ deleteRows: vi.fn(() => Promise.reject("in use")) });
    const { props } = setup(s);
    act(() => props().onDeleteRow!([1]));
    await act(async () => {});
    expect(h.notify.error).toHaveBeenCalledWith("tableData.deleteFailedTitle", {
      description: "in use",
    });
    expect(s.refreshAll).not.toHaveBeenCalled();
  });
});
