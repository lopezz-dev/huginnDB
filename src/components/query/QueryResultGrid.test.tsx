/**
 * @vitest-environment jsdom
 *
 * Characterization tests for the query tab's result grid, written before
 * ADR #135 moves it onto a `useQuerySource` producer and the shared grid
 * controller. They pin what 1.39.1 shipped — edit and delete rows of a
 * single-table `SELECT` — as the grid sees it and as the backend receives it,
 * so the migration can be checked against behaviour rather than a reading:
 *
 * - anything that is not one table with its whole key in the result is the
 *   plain read-only grid: no edit, no delete, no selection;
 * - a save writes the **table** column an alias stands for, with the catalog
 *   type, keyed by the key read off the row, then runs the statement again;
 * - a computed column is locked with its own reason, a policy column limit
 *   is judged on the table column;
 * - a delete confirms (or not, per `ui.confirmDestructive`), deletes by key
 *   and runs the statement again;
 * - each policy verb lock removes its own gesture.
 *
 * `DataGrid` and `DeleteRowsDialog` are stubs that record their props.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, QueryResult } from "@/types";

const h = vi.hoisted(() => ({
  api: {
    listColumns: vi.fn(),
    updateCell: vi.fn(),
    deleteRows: vi.fn(),
    updatePreferences: vi.fn(),
  },
  notify: { error: vi.fn(), success: vi.fn() },
  props: {} as Record<string, Record<string, unknown> | undefined>,
  locks: {} as Record<string, string | null>,
  relations: [] as unknown[],
  columns: {
    insert: null as string[] | null,
    update: null as string[] | null,
    lock: (_verb: string, _column: string): string | null => null,
  },
}));

vi.mock("@/lib/tauri", () => ({ api: h.api }));
vi.mock("@/lib/notify", () => ({ notify: h.notify }));
const t = (key: string, opts?: Record<string, unknown>) =>
  opts?.table ? `${key}:${String(opts.table)}` : key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));
vi.mock("@/lib/policy/access", () => ({
  usePolicyLocker: (_c: string, relation: unknown) => {
    h.relations.push(relation);
    return (need: string) => (relation ? (h.locks[need] ?? null) : null);
  },
  usePolicyColumns: () => h.columns,
}));
vi.mock("@/components/grid/DataGrid", () => ({
  DataGrid: (p: Record<string, unknown>) => {
    h.props.grid = p;
    return null;
  },
}));
vi.mock("@/components/grid/dialogs/DeleteRowsDialog", () => ({
  DeleteRowsDialog: (p: Record<string, unknown>) => {
    h.props.deleteDialog = p;
    return null;
  },
}));

import { QueryResultGrid } from "./QueryResultGrid";
import { usePreferences } from "@/stores/preferences/preferences";
import { useGridSelection } from "@/stores/grid/gridSelection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseProps = Record<string, any>;
function grid(): LooseProps {
  const p = h.props.grid;
  if (!p) throw new Error("DataGrid was not rendered");
  return p;
}

const col = (
  name: string,
  data_type: string,
  extra: Partial<ColumnInfo> = {},
): ColumnInfo => ({ name, data_type, nullable: true, is_primary_key: false, ...extra });

/** shop.items: composite key (shop_id, id), a BIT and a price. */
const ITEMS: ColumnInfo[] = [
  col("shop_id", "int", { is_primary_key: true }),
  col("id", "int", { is_primary_key: true }),
  col("price", "numeric"),
  col("active", "bit(1)"),
];

const result = (names: string[], rows: unknown[][]): QueryResult => ({
  columns: names.map((name) => ({ name, data_type: "TEXT" })),
  rows: rows as QueryResult["rows"],
  rows_affected: 0,
  elapsed_ms: 0,
  total: null,
});

/** `SELECT id, price AS p, price * 2 AS doubled, shop_id FROM shop.items` */
const SQL = "SELECT id, price AS p, price * 2 AS doubled, shop_id FROM shop.items";
const RESULT = result(
  ["id", "p", "doubled", "shop_id"],
  [
    [7, "9.50", "19.00", 1],
    [8, "3.00", "6.00", 1],
  ],
);

const onRefresh = vi.fn(() => Promise.resolve());

/** `null` mounts a result with no statement behind it. */
async function mount(sql: string | null = SQL, res: QueryResult = RESULT) {
  render(
    <QueryResultGrid
      tabId="q1"
      connectionId="c1"
      driver="postgres"
      result={res}
      sql={sql ?? undefined}
      globalFilter=""
      onGlobalFilterChange={() => {}}
      onRefresh={onRefresh}
    />,
  );
  // The catalog columns arrive from `listColumns`.
  await act(async () => {});
}

beforeEach(() => {
  h.props = {};
  h.locks = {};
  h.relations = [];
  h.columns = { insert: null, update: null, lock: () => null };
  for (const fn of Object.values(h.api)) fn.mockReset();
  h.api.listColumns.mockResolvedValue(ITEMS);
  h.api.updateCell.mockResolvedValue(undefined);
  h.api.deleteRows.mockResolvedValue(undefined);
  h.notify.error.mockClear();
  onRefresh.mockClear();
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ui: { ...s.prefs.ui, confirmDestructive: true } },
  }));
});
afterEach(() => cleanup());

function expectReadOnly() {
  const g = grid();
  expect(g.editable).toBe(false);
  expect(g.onCellSave).toBeUndefined();
  expect(g.onDeleteRow).toBeUndefined();
  expect(g.onBulkDelete).toBeUndefined();
  expect(g.getRowKey).toBeUndefined();
  expect(g.onSelectionChange).toBeUndefined();
  expect(g.pkColumnNames).toBeUndefined();
  // Never offered from a result set, writable or not.
  expect(g.onInsertRow).toBeUndefined();
  expect(g.onDuplicateRow).toBeUndefined();
  expect(g.onPasteBlock).toBeUndefined();
  expect(g.onNavigateFk).toBeUndefined();
}

describe("QueryResultGrid — read-only results", () => {
  it("a statement over more than one table is the plain grid", async () => {
    await mount("SELECT i.id FROM shop.items i JOIN shop.shops s ON s.id = i.shop_id");
    expectReadOnly();
    expect(h.api.listColumns).not.toHaveBeenCalled();
  });

  it("a result with no statement behind it is the plain grid", async () => {
    await mount(null);
    expectReadOnly();
  });

  it("a result missing part of the key is the plain grid", async () => {
    await mount(
      "SELECT id, price FROM shop.items",
      result(["id", "price"], [[7, "9.50"]]),
    );
    expectReadOnly();
  });

  it("a table whose columns cannot be read is the plain grid", async () => {
    h.api.listColumns.mockRejectedValue(new Error("gone"));
    await mount();
    expectReadOnly();
  });
});

describe("QueryResultGrid — a single-table SELECT", () => {
  it("reads the catalog of the table the statement names", async () => {
    await mount();
    expect(h.api.listColumns).toHaveBeenCalledWith("c1", "shop", "items");
  });

  it("is editable, keys rows by the table's key and reports the selection", async () => {
    await mount();
    const g = grid();
    expect(g.editable).toBe(true);
    expect(g.pkColumnNames).toEqual(["shop_id", "id"]);
    expect(g.getRowKey([7, "9.50", "19.00", 1])).toBe("[1,7]");
    act(() => g.onSelectionChange(1, 2));
    expect(useGridSelection.getState().byTab.q1).toEqual({ count: 1, total: 2 });
  });

  it("saves through the alias to the table column, with its catalog type, then runs the statement again", async () => {
    await mount();
    await act(() => grid().onCellSave([7, "9.50", "19.00", 1], "p", "10"));
    expect(h.api.updateCell).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: "shop",
      table: "items",
      pkColumns: ["shop_id", "id"],
      pkValues: [1, 7],
      column: "price",
      value: "10",
      columnType: "numeric",
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("locks a computed column with its own reason, and leaves real columns open", async () => {
    await mount();
    expect(grid().columnLock("doubled")).toBe("query.notWritable:shop.items");
    expect(grid().columnLock("p")).toBeNull();
  });

  it("judges a policy column limit on the table column, not the alias", async () => {
    h.columns = {
      insert: null,
      update: ["id"],
      lock: (verb, column) => `${verb}:${column}`,
    };
    await mount();
    expect(grid().columnLock("p")).toBe("update:price");
  });

  it("asks the policy about the relation the statement reads", async () => {
    await mount();
    expect(h.relations).toContainEqual({ schema: "shop", name: "items" });
  });
});

describe("QueryResultGrid — deletes", () => {
  it("confirms, deletes by key and runs the statement again", async () => {
    await mount();
    act(() => grid().onBulkDelete(RESULT.rows));
    const dialog = h.props.deleteDialog!;
    expect(dialog).toMatchObject({
      connectionId: "c1",
      schema: "shop",
      table: "items",
      pkColumns: ["shop_id", "id"],
      pkValueRows: [
        [1, 7],
        [1, 8],
      ],
    });
    await act(() => (dialog.onDelete as () => Promise<void>)());
    expect(h.api.deleteRows).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: "shop",
      table: "items",
      pkColumns: ["shop_id", "id"],
      pkValueRows: [
        [1, 7],
        [1, 8],
      ],
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("deletes straight away with ui.confirmDestructive off, and toasts a refusal", async () => {
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ui: { ...s.prefs.ui, confirmDestructive: false } },
    }));
    h.api.deleteRows.mockRejectedValueOnce("fk violation");
    await mount();
    act(() => grid().onDeleteRow([7, "9.50", "19.00", 1]));
    await act(async () => {});
    expect(h.props.deleteDialog).toBeUndefined();
    expect(h.notify.error).toHaveBeenCalledWith("tableData.deleteFailedTitle", {
      description: "fk violation",
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("QueryResultGrid — managed policy locks", () => {
  it("an update lock makes it read-only for edits but keeps delete", async () => {
    h.locks = { update: "no update" };
    await mount();
    expect(grid().editable).toBe(false);
    expect(grid().onCellSave).toBeUndefined();
    expect(grid().columnLock).toBeUndefined();
    expect(grid().onDeleteRow).toBeTypeOf("function");
    expect(grid().getRowKey).toBeTypeOf("function");
  });

  it("a delete lock removes delete and keeps edits", async () => {
    h.locks = { delete: "no delete" };
    await mount();
    expect(grid().onDeleteRow).toBeUndefined();
    expect(grid().onBulkDelete).toBeUndefined();
    expect(grid().editable).toBe(true);
  });
});
