/**
 * @vitest-environment jsdom
 *
 * The grid controller against a hand-built `GridSource` (ADR #135) — the
 * contract as any source sees it, apart from the table that first produced
 * one (`TableDataTab.test.tsx` pins the table's own rules):
 *
 * - a gesture is wired only when its capability is available, and performed
 *   only through the operations that capability carries;
 * - a blocked Insert shows its reason, a pending one shows nothing;
 * - a draft commits through the operations of the gesture that started it, so
 *   a duplicate commits where Insert itself is blocked;
 * - a save reloads the page, a delete / paste / insert reloads everything;
 * - a row whose key cannot be read goes to `onError`, not to the server;
 * - the selection is reported, and cleared on unmount, unless told not to.
 */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVAILABLE,
  available,
  blocked,
  pending,
  unsupported,
  type GridSource,
} from "@/lib/grid/gridSource";
import type { PastePlan } from "@/lib/grid/pastePlan";
import type { DraftRow } from "@/types";

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
const DRAFT: DraftRow = {
  cells: {
    id: { value: null, touched: false },
    name: { value: null, touched: false },
  },
  error: null,
  saving: false,
};

/** Every operation as a spy, so a test can say which one ran. */
function spies() {
  return {
    saveField: vi.fn(() => Promise.resolve()),
    deleteRows: vi.fn(() => Promise.resolve()),
    insertRow: vi.fn(() => Promise.resolve()),
    dupInsertRow: vi.fn(() => Promise.resolve()),
    planPaste: vi.fn(() => PLAN),
    applyPaste: vi.fn(() => Promise.resolve({ updated: 2, inserted: 1 })),
    unsetField: vi.fn(() => Promise.resolve()),
    navigateFk: vi.fn(),
    refreshPage: vi.fn(() => Promise.resolve()),
    refreshAll: vi.fn(() => Promise.resolve()),
  };
}
type Spies = ReturnType<typeof spies>;

function fakeSource(s: Spies, over: Partial<GridSource> = {}): GridSource {
  return {
    addressable: true,
    pkResultNames: ["id"],
    documentMode: false,
    keyOf: (row) => [row[0]],
    getRowKey: (row) => JSON.stringify([row[0]]),
    hydrate: (row) => Promise.resolve(row),
    refreshPage: s.refreshPage,
    refreshAll: s.refreshAll,
    update: available({ saveField: s.saveField }),
    delete: available({
      target: { connectionId: "c1", schema: "shop", table: "items", pkColumns: ["id"] },
      deleteRows: s.deleteRows,
    }),
    insert: available({
      newDraft: () => DRAFT,
      columnType: (c: string) => (c === "name" ? "text" : undefined),
      insertRow: s.insertRow,
    }),
    duplicate: available({
      duplicateDraft: () => DRAFT,
      columnType: () => "dup-type",
      insertRow: s.dupInsertRow,
    }),
    paste: available({
      relationLabel: "shop.items",
      planPaste: s.planPaste,
      applyPaste: s.applyPaste,
    }),
    fieldUnset: available({ unsetField: s.unsetField }),
    fkNavigate: available({ navigateFk: s.navigateFk }),
    bulkUpdate: AVAILABLE,
    export: AVAILABLE,
    ...over,
  };
}

function setup(source: GridSource, opts: { reportSelection?: boolean } = {}) {
  const onError = vi.fn();
  const hook = renderHook(
    ({ src }) => useGridController(src, { tabId: "t1", onError, ...opts }),
    { initialProps: { src: source } },
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
  usePreferences.setState((st) => ({
    prefs: { ...st.prefs, ui: { ...st.prefs.ui, confirmDestructive: true } },
  }));
});
afterEach(() => cleanup());

describe("useGridController — capabilities", () => {
  it("wires every gesture when everything is available", () => {
    const { props } = setup(fakeSource(spies()));
    const p = props();
    expect(p.editable).toBe(true);
    for (const k of [
      "onCellSave",
      "onFieldSave",
      "onFieldDelete",
      "onNavigateFk",
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

  it("withholds every gesture whose capability is blocked, and says why for Insert", () => {
    const no = blocked("no");
    const { props } = setup(
      fakeSource(spies(), {
        update: no,
        delete: no,
        insert: blocked("Inserts are off"),
        duplicate: no,
        paste: no,
        fieldUnset: no,
        fkNavigate: no,
      }),
    );
    const p = props();
    expect(p.editable).toBe(false);
    for (const k of [
      "onCellSave",
      "onFieldSave",
      "onFieldDelete",
      "onNavigateFk",
      "onPasteBlock",
      "onDeleteRow",
      "onBulkDelete",
      "onInsertRow",
      "onDuplicateRow",
    ] as const) {
      expect(p[k], k).toBeUndefined();
    }
    expect(p.insertBlocked).toBe("Inserts are off");
  });

  it("an unsupported Insert or Duplicate is neither offered nor explained", () => {
    const { props } = setup(
      fakeSource(spies(), { insert: unsupported, duplicate: unsupported }),
    );
    expect(props().onInsertRow).toBeUndefined();
    expect(props().onDuplicateRow).toBeUndefined();
    expect(props().insertBlocked).toBeNull();
  });

  it("a pending Insert is neither offered nor explained", () => {
    const { props } = setup(fakeSource(spies(), { insert: pending }));
    expect(props().onInsertRow).toBeUndefined();
    expect(props().insertBlocked).toBeNull();
  });

  it("hands the grid the update and insert column locks", () => {
    const upd = (c: string) => (c === "a" ? "locked" : null);
    const ins = (c: string) => (c === "b" ? "no fill" : null);
    const s = spies();
    const base = fakeSource(s);
    const { props } = setup({
      ...base,
      update: available({ saveField: s.saveField, columnLock: upd }),
      insert: available({
        newDraft: () => DRAFT,
        columnType: () => undefined,
        insertRow: s.insertRow,
        columnLock: ins,
      }),
    });
    expect(props().columnLock).toBe(upd);
    expect(props().draftColumnLock).toBe(ins);
  });

  it("reports the selection under the tab's id and clears it on unmount", () => {
    const { hook, props } = setup(fakeSource(spies()));
    act(() => props().onSelectionChange!(2, 10));
    expect(useGridSelection.getState().byTab.t1).toEqual({ count: 2, total: 10 });
    hook.unmount();
    expect(useGridSelection.getState().byTab.t1).toBeUndefined();
  });

  it("does not report the selection when told not to", () => {
    const { props } = setup(fakeSource(spies()), { reportSelection: false });
    expect(props().onSelectionChange).toBeUndefined();
  });
});

describe("useGridController — what each write does and reloads", () => {
  it("a cell save goes through update's saveField and reloads the page only", async () => {
    const s = spies();
    const { props } = setup(fakeSource(s));
    await act(() => props().onCellSave!([1, "a"], "name", "b"));
    expect(s.saveField).toHaveBeenCalledWith([1, "a"], ["name"], "b", undefined);
    expect(s.refreshPage).toHaveBeenCalledTimes(1);
    expect(s.refreshAll).not.toHaveBeenCalled();
  });

  it("a field removal reloads the page only", async () => {
    const s = spies();
    const { props } = setup(fakeSource(s));
    await act(() => props().onFieldDelete!([1], ["tags", "0"]));
    expect(s.unsetField).toHaveBeenCalledWith([1], ["tags", "0"]);
    expect(s.refreshPage).toHaveBeenCalledTimes(1);
  });

  it("a confirmed delete sends one key tuple per row and reloads everything", async () => {
    const s = spies();
    const { hook, props } = setup(fakeSource(s));
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
    const s = spies();
    const { hook, props } = setup(fakeSource(s));
    const block = { text: "x", rows: [[1, "a"]], columns: [] };
    await act(() => props().onPasteBlock!(block));
    expect(s.planPaste).toHaveBeenCalledWith(block, [[1, "a"]]);
    renderDialogs(hook.result.current.dialogs);
    expect(h.dialogs.paste).toMatchObject({ plan: PLAN, table: "shop.items" });
    await act(() => (h.dialogs.paste!.onApply as () => Promise<void>)());
    expect(s.applyPaste).toHaveBeenCalledWith(PLAN);
    expect(h.notify.success).toHaveBeenCalledWith("dataGrid.paste.done");
    expect(s.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("an insert sends the touched cells with the insert's types and reloads everything", async () => {
    const s = spies();
    const { props } = setup(fakeSource(s));
    act(() => props().onInsertRow!());
    act(() => props().onDraftCellChange("name", { value: "n", touched: true }));
    await act(() => props().onDraftCommit());
    expect(s.insertRow).toHaveBeenCalledWith([
      { column: "name", value: "n", columnType: "text" },
    ]);
    expect(s.refreshAll).toHaveBeenCalledTimes(1);
    expect(props().draftRow).toBeNull();
  });

  it("a duplicate commits through its own operations, even where Insert is blocked", async () => {
    const s = spies();
    const { props } = setup(fakeSource(s, { insert: blocked("view") }));
    await act(() => props().onDuplicateRow!([1, "a"]));
    act(() => props().onDraftCellChange("name", { value: "n", touched: true }));
    await act(() => props().onDraftCommit());
    expect(s.insertRow).not.toHaveBeenCalled();
    expect(s.dupInsertRow).toHaveBeenCalledWith([
      { column: "name", value: "n", columnType: "dup-type" },
    ]);
  });
});

describe("useGridController — the draft keeps the operations that started it", () => {
  it("a duplicate commits through duplicate's operations even when Insert is available", async () => {
    const s = spies();
    const { props } = setup(fakeSource(s));
    await act(() => props().onDuplicateRow!([1, "a"]));
    act(() => props().onDraftCellChange("name", { value: "n", touched: true }));
    await act(() => props().onDraftCommit());
    expect(s.insertRow).not.toHaveBeenCalled();
    expect(s.dupInsertRow).toHaveBeenCalledTimes(1);
  });
});

describe("useGridController — failures", () => {
  it("a row whose key cannot be read goes to onError, not to the server", () => {
    const s = spies();
    const { props, onError } = setup(
      fakeSource(s, {
        keyOf: () => {
          throw new Error("Primary-key columns missing from the result set");
        },
      }),
    );
    act(() => props().onDeleteRow!([1]));
    expect(onError).toHaveBeenCalledWith(
      "Error: Primary-key columns missing from the result set",
    );
    expect(s.deleteRows).not.toHaveBeenCalled();
  });

  it("an unconfirmed delete the server refuses is toasted and reloads nothing", async () => {
    usePreferences.setState((st) => ({
      prefs: { ...st.prefs, ui: { ...st.prefs.ui, confirmDestructive: false } },
    }));
    const s = spies();
    s.deleteRows.mockImplementation(() => Promise.reject("in use"));
    const { props } = setup(fakeSource(s));
    act(() => props().onDeleteRow!([1]));
    await act(async () => {});
    expect(h.notify.error).toHaveBeenCalledWith("tableData.deleteFailedTitle", {
      description: "in use",
    });
    expect(s.refreshAll).not.toHaveBeenCalled();
  });

  it("a refused insert keeps the draft with the server's error", async () => {
    const s = spies();
    s.insertRow.mockImplementation(() => Promise.reject("not null: id"));
    const { props } = setup(fakeSource(s));
    act(() => props().onInsertRow!());
    act(() => props().onDraftCellChange("name", { value: "n", touched: true }));
    await act(() => props().onDraftCommit());
    expect(props().draftRow).toMatchObject({
      saving: false,
      error: "not null: id",
      cells: { name: { value: "n", touched: true } },
    });
  });
});
