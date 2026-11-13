/**
 * @vitest-environment jsdom
 *
 * Characterization tests for `TableDataTab`'s write paths, written before
 * ADR #135 moves them behind `GridSource` / `useTableSource` and one shared
 * controller. They pin what the table tab hands `DataGrid` and what reaches
 * the backend, so the extraction can be checked against the behaviour it
 * replaces rather than against a reading of it:
 *
 * - a cell save sends the full key from the row's own values (ADR #7), the
 *   catalog type on SQL (gotcha #15) and the cell's own BSON type on MongoDB
 *   (ADR #29), then refetches the page;
 * - a delete goes through the confirmation dialog while
 *   `ui.confirmDestructive` is on and straight to the server while it is off;
 * - a pasted block is planned against hydrated rows (ADR #133) and applied by
 *   key only after the dialog (ADR #114);
 * - a duplicate skips an auto key and a column the policy will not let the
 *   person fill (ADR #113), and the draft commits with the catalog types;
 * - every write gesture disappears together when the key is not usable — no
 *   key, a projection that hid it, a view for inserts — and the row key falls
 *   back to the whole row for read-only selection;
 * - each managed-policy lock removes exactly its own gesture and nothing else.
 *
 * `DataGrid` and the dialogs are stubs that record their props: what is being
 * pinned is the contract between the tab and the grid, not the grid itself,
 * which has its own tests.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, CellValue, QueryResult } from "@/types";

const h = vi.hoisted(() => {
  const api = {
    updateCell: vi.fn(),
    deleteRows: vi.fn(),
    applyPaste: vi.fn(),
    insertRow: vi.fn(),
    unsetField: vi.fn(),
    listIndexes: vi.fn(),
    exportTable: vi.fn(),
    exportTableRows: vi.fn(),
    exportCollection: vi.fn(),
    importCollection: vi.fn(),
    updatePreferences: vi.fn(),
  };
  return {
    api,
    notify: {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      file: vi.fn(),
      progress: vi.fn(() => ({ dismiss: vi.fn(), error: vi.fn() })),
    },
    /** Last props each stub was rendered with. */
    props: {} as Record<string, Record<string, unknown> | undefined>,
    driver: "postgres" as string | undefined,
    locks: {} as Record<string, string | null>,
    policyColumns: {
      insert: undefined as string[] | undefined,
      update: undefined as string[] | undefined,
      lock: (_verb: string, _column: string): string | null => null,
    },
    browse: {
      result: null as unknown,
      fetchData: vi.fn(() => Promise.resolve()),
      reloadAll: vi.fn(() => Promise.resolve()),
      hydrate: vi.fn((row: unknown[]) => Promise.resolve(row)),
      query: undefined as Record<string, unknown> | undefined,
    },
  };
});

vi.mock("@/lib/tauri", () => ({ api: h.api }));
vi.mock("@/lib/notify", () => ({ notify: h.notify }));

// A stable `t` that returns the key, so assertions name the message.
const t = (key: string) => key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));

vi.mock("@/lib/connection/useConnectionDriver", () => ({
  useConnectionDriver: () => h.driver,
}));

vi.mock("@/lib/policy/access", () => ({
  usePolicyLocker: () => (need: string) => h.locks[need] ?? null,
  usePolicyColumns: () => h.policyColumns,
}));

vi.mock("@/components/common/PolicyLock", () => ({
  PolicyLockHint: ({ children }: { children: React.ReactNode }) => children,
  PolicyVerbNotice: (p: Record<string, unknown>) => {
    h.props.notice = p;
    return null;
  },
}));

vi.mock("@/lib/grid/useTableBrowse", () => ({
  useTableBrowse: (query: Record<string, unknown>) => {
    h.browse.query = query;
    return {
      result: h.browse.result,
      loading: false,
      error: null,
      setError: vi.fn(),
      resultOffset: 0,
      total: null,
      totalEstimated: false,
      countStatus: "idle",
      exactCounting: false,
      fetchData: h.browse.fetchData,
      trimmedRows: {
        of: () => undefined,
        hydrate: h.browse.hydrate,
        explainUnloadable: () => false,
      },
      countExactly: vi.fn(),
      reloadAll: h.browse.reloadAll,
    };
  },
}));

function stub(name: string) {
  return (p: Record<string, unknown>) => {
    h.props[name] = p;
    return null;
  };
}
vi.mock("@/components/grid/DataGrid", () => ({ DataGrid: stub("grid") }));
vi.mock("@/components/grid/QueryPanel", () => ({ QueryPanel: stub("query") }));
vi.mock("@/components/grid/dialogs/DeleteRowsDialog", () => ({
  DeleteRowsDialog: stub("deleteDialog"),
}));
vi.mock("@/components/grid/dialogs/PasteCellsDialog", () => ({
  PasteCellsDialog: stub("pasteDialog"),
}));
vi.mock("@/components/grid/dialogs/BulkUpdateDialog", () => ({
  BulkUpdateDialog: stub("bulkDialog"),
}));
vi.mock("@/components/grid/dialogs/InsertDocumentDialog", () => ({
  InsertDocumentDialog: () => null,
}));
vi.mock("@/components/grid/dialogs/InsertRowsDialog", () => ({
  InsertRowsDialog: () => null,
}));

import { TableDataTab } from "./TableDataTab";
import { useSchema, type ConnectionSchema } from "@/stores/session/schema";
import { usePreferences } from "@/stores/preferences/preferences";
import { useTabs } from "@/stores/session/tabs";

const originalOpen = useTabs.getState().open;

// ---------------------------------------------------------------------------
// Fixtures

const col = (
  name: string,
  data_type: string,
  extra: Partial<ColumnInfo> = {},
): ColumnInfo => ({
  name,
  data_type,
  nullable: true,
  is_primary_key: false,
  ...extra,
});

/** `order_lines`: a composite key whose catalog order (order_id, line) is NOT
 *  the order the result set returns it in, plus a MySQL-style BIT and an FK. */
const LINE_COLS: ColumnInfo[] = [
  col("order_id", "int", { is_primary_key: true, nullable: false }),
  col("line", "int", { is_primary_key: true, nullable: false }),
  col("qty", "int"),
  col("shipped", "bit(1)"),
  col("product_id", "int", {
    referenced_schema: "shop",
    referenced_table: "products",
    referenced_column: "id",
  }),
];

const page = (
  columns: [string, string][],
  rows: CellValue[][],
  extra: Partial<QueryResult> = {},
): QueryResult => ({
  columns: columns.map(([name, data_type]) => ({ name, data_type })),
  rows,
  rows_affected: 0,
  elapsed_ms: 0,
  total: null,
  ...extra,
});

/** Result order: line, qty, order_id, shipped, product_id. */
const LINE_PAGE = page(
  [
    ["line", "INT"],
    ["qty", "INT"],
    ["order_id", "INT"],
    ["shipped", "BIT"],
    ["product_id", "INT"],
  ],
  [
    [1, 5, 100, 0, 7],
    [2, 3, 100, 1, 8],
  ],
);

function seedSchema(
  table: string,
  columns: ColumnInfo[],
  opts: { schema?: string; view?: boolean } = {},
) {
  const key = `${opts.schema ?? ""}.${table}`;
  useSchema.setState({
    byConnection: {
      c1: {
        tables: [
          {
            schema: opts.schema ?? "",
            name: table,
            kind: opts.view ? "view" : "table",
          },
        ],
        columns: { [key]: columns },
        columnErrors: {},
      } as unknown as ConnectionSchema,
    },
  });
}

function mount(table = "order_lines", schema?: string) {
  render(
    <TableDataTab tabId="tab1" connectionId="c1" schema={schema} table={table} />,
  );
}

/** The props `DataGrid` was last rendered with — loosely typed on purpose:
 *  the tests call the callbacks the way the grid would. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseProps = Record<string, any>;
function grid(): LooseProps {
  const p = h.props.grid;
  if (!p) throw new Error("DataGrid was not rendered");
  return p;
}

const flush = () => act(async () => {});

beforeEach(() => {
  h.props = {};
  h.driver = "postgres";
  h.locks = {};
  h.policyColumns = {
    insert: undefined,
    update: undefined,
    lock: () => null,
  };
  h.browse.result = LINE_PAGE;
  h.browse.query = undefined;
  for (const fn of Object.values(h.api)) fn.mockReset();
  for (const fn of Object.values(h.notify)) fn.mockClear();
  h.api.updateCell.mockResolvedValue(undefined);
  h.api.deleteRows.mockResolvedValue(undefined);
  h.api.insertRow.mockResolvedValue(undefined);
  h.api.unsetField.mockResolvedValue(undefined);
  h.api.listIndexes.mockResolvedValue([]);
  h.api.applyPaste.mockResolvedValue({ updated: 1, inserted: 0 });
  h.browse.fetchData.mockClear();
  h.browse.reloadAll.mockClear();
  h.browse.hydrate.mockReset();
  h.browse.hydrate.mockImplementation((row: unknown[]) => Promise.resolve(row));
  usePreferences.setState((s) => ({
    prefs: { ...s.prefs, ui: { ...s.prefs.ui, confirmDestructive: true } },
  }));
  useTabs.setState({ tabs: [], open: originalOpen });
  seedSchema("order_lines", LINE_COLS);
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------

describe("TableDataTab — cell saves", () => {
  it("sends the full composite key, in catalog order, read off the row's own values", async () => {
    mount();
    await act(() => grid().onCellSave([2, 3, 100, 1, 8], "qty", "9"));

    expect(h.api.updateCell).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: undefined,
      table: "order_lines",
      pkColumns: ["order_id", "line"],
      pkValues: [100, 2],
      column: "qty",
      value: "9",
      columnType: "int",
    });
    expect(h.browse.fetchData).toHaveBeenCalledTimes(1);
  });

  it("on SQL sends the catalog type and ignores the field's own type hint", async () => {
    mount();
    await act(() =>
      grid().onFieldSave([1, 5, 100, 0, 7], ["shipped"], "1", "string"),
    );
    expect(h.api.updateCell).toHaveBeenCalledWith(
      expect.objectContaining({ column: "shipped", columnType: "bit(1)" }),
    );
  });

  it("falls back to the result set's type for a column the catalog does not list", async () => {
    h.browse.result = page(
      [
        ["order_id", "INT"],
        ["line", "INT"],
        ["note", "TEXT"],
      ],
      [[100, 1, "x"]],
    );
    mount();
    await act(() => grid().onCellSave([100, 1, "x"], "note", "y"));
    expect(h.api.updateCell).toHaveBeenCalledWith(
      expect.objectContaining({ column: "note", columnType: "TEXT" }),
    );
  });

  it("on MongoDB sends the field's own BSON type and joins a nested path with dots", async () => {
    h.driver = "mongodb";
    seedSchema("events", [
      col("_id", "objectId", { is_primary_key: true }),
      col("count", "int"),
    ]);
    h.browse.result = page(
      [
        ["_id", "bson"],
        ["count", "bson"],
      ],
      [["65a1", 3]],
    );
    mount("events");

    await act(() =>
      grid().onFieldSave(["65a1", 3], ["customData", "format"], "2", "long"),
    );
    expect(h.api.updateCell).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "events",
        pkColumns: ["_id"],
        pkValues: ["65a1"],
        column: "customData.format",
        columnType: "long",
      }),
    );

    // Without a hint it is the catalog's inferred type, not the generic "bson".
    await act(() => grid().onCellSave(["65a1", 3], "count", "4"));
    expect(h.api.updateCell).toHaveBeenLastCalledWith(
      expect.objectContaining({ column: "count", columnType: "int" }),
    );
  });

  it("removes a MongoDB field with $unset on the document's _id, and only on MongoDB", async () => {
    mount();
    expect(grid().onFieldDelete).toBeUndefined();
    cleanup();

    h.driver = "mongodb";
    seedSchema("events", [col("_id", "objectId", { is_primary_key: true })]);
    h.browse.result = page([["_id", "bson"]], [["65a1"]]);
    mount("events");
    await act(() => grid().onFieldDelete(["65a1"], ["tags", "2"]));
    expect(h.api.unsetField).toHaveBeenCalledWith({
      connectionId: "c1",
      collection: "events",
      idValue: "65a1",
      field: "tags.2",
    });
    expect(h.browse.fetchData).toHaveBeenCalled();
  });
});

describe("TableDataTab — deletes", () => {
  it("asks first while ui.confirmDestructive is on, then deletes by key and reloads", async () => {
    mount();
    act(() => grid().onDeleteRow([2, 3, 100, 1, 8]));

    const dialog = h.props.deleteDialog!;
    expect(dialog).toMatchObject({
      connectionId: "c1",
      table: "order_lines",
      pkColumns: ["order_id", "line"],
      pkValueRows: [[100, 2]],
    });
    expect(h.api.deleteRows).not.toHaveBeenCalled();

    await act(() => (dialog.onDelete as () => Promise<void>)());
    expect(h.api.deleteRows).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: undefined,
      table: "order_lines",
      pkColumns: ["order_id", "line"],
      pkValueRows: [[100, 2]],
    });
    expect(h.browse.reloadAll).toHaveBeenCalledTimes(1);
  });

  it("routes a multi-row selection through the same dialog, one key tuple per row", () => {
    mount();
    act(() => grid().onBulkDelete(LINE_PAGE.rows));
    expect(h.props.deleteDialog?.pkValueRows).toEqual([
      [100, 1],
      [100, 2],
    ]);
  });

  it("deletes straight away with ui.confirmDestructive off, and toasts a refusal", async () => {
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ui: { ...s.prefs.ui, confirmDestructive: false } },
    }));
    mount();
    act(() => grid().onDeleteRow([1, 5, 100, 0, 7]));
    await flush();
    expect(h.props.deleteDialog).toBeUndefined();
    expect(h.api.deleteRows).toHaveBeenCalledWith(
      expect.objectContaining({ pkValueRows: [[100, 1]] }),
    );

    h.api.deleteRows.mockRejectedValueOnce("fk violation");
    act(() => grid().onDeleteRow([2, 3, 100, 1, 8]));
    await flush();
    expect(h.notify.error).toHaveBeenCalledWith("tableData.deleteFailedTitle", {
      description: "fk violation",
    });
  });
});

describe("TableDataTab — paste (ADR #114)", () => {
  it("plans against hydrated rows, shows the plan, and applies it by key on confirm", async () => {
    mount();
    const rows = [[1, 5, 100, 0, 7]];
    await act(() =>
      grid().onPasteBlock({
        text: "42",
        rows,
        columns: [{ name: "qty", data_type: "INT" }],
      }),
    );
    expect(h.browse.hydrate).toHaveBeenCalledWith(rows[0], 0, rows);

    const dialog = h.props.pasteDialog!;
    expect(dialog.table).toBe("order_lines");
    expect(dialog.documentMode).toBe(false);
    const plan = dialog.plan as { updates: unknown[]; inserts: unknown[] };
    expect(plan.updates).toEqual([
      expect.objectContaining({ pkValues: [100, 1], column: "qty", value: "42" }),
    ]);

    await act(() => (dialog.onApply as () => Promise<void>)());
    expect(h.api.applyPaste).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: undefined,
      table: "order_lines",
      pkColumns: ["order_id", "line"],
      updates: plan.updates,
      inserts: plan.inserts,
    });
    expect(h.notify.success).toHaveBeenCalledWith("dataGrid.paste.done");
    expect(h.browse.reloadAll).toHaveBeenCalled();
  });

  it("opens nothing when a trimmed row cannot be loaded back (ADR #133)", async () => {
    h.browse.hydrate.mockRejectedValue(new Error("gone"));
    mount();
    await act(() =>
      grid().onPasteBlock({
        text: "42",
        rows: [[1, 5, 100, 0, 7]],
        columns: [{ name: "qty", data_type: "INT" }],
      }),
    );
    expect(h.props.pasteDialog).toBeUndefined();
  });

  it("plans inserts and updates as locked when the policy refuses those verbs", async () => {
    h.locks = { update: "no update", insert: "no insert" };
    mount();
    await act(() =>
      grid().onPasteBlock({
        text: "42\n43\n44",
        rows: [[1, 5, 100, 0, 7]],
        columns: [{ name: "qty", data_type: "INT" }],
      }),
    );
    const plan = h.props.pasteDialog!.plan as {
      updates: unknown[];
      inserts: unknown[];
    };
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });
});

describe("TableDataTab — insert and duplicate", () => {
  it("duplicates a hydrated row, leaving an auto key and a policy-locked column untouched", async () => {
    seedSchema("items", [
      col("id", "integer", { is_primary_key: true, nullable: false }),
      col("name", "text"),
      col("secret", "text"),
      col("meta", "jsonb"),
    ]);
    h.browse.result = page(
      [
        ["id", "INT4"],
        ["name", "TEXT"],
        ["secret", "TEXT"],
        ["meta", "JSONB"],
      ],
      [[1, "a", "s", { k: 1 }]],
    );
    h.policyColumns = {
      insert: ["id", "name", "meta"],
      update: undefined,
      lock: (verb, column) =>
        verb === "insert" && column === "secret" ? "locked" : null,
    };
    mount("items");

    await act(() => grid().onDuplicateRow([1, "a", "s", { k: 1 }]));
    expect(h.browse.hydrate).toHaveBeenCalledWith([1, "a", "s", { k: 1 }]);
    expect(grid().draftRow).toEqual({
      cells: {
        id: { value: null, touched: false },
        name: { value: "a", touched: true },
        secret: { value: null, touched: false },
        meta: { value: '{"k":1}', touched: true },
      },
      error: null,
      saving: false,
    });

    await act(() => grid().onDraftCommit());
    expect(h.api.insertRow).toHaveBeenCalledWith({
      connectionId: "c1",
      schema: undefined,
      table: "items",
      pkColumn: "id",
      values: [
        { column: "name", value: "a", columnType: "text" },
        { column: "meta", value: '{"k":1}', columnType: "jsonb" },
      ],
    });
    expect(h.browse.reloadAll).toHaveBeenCalled();
    expect(grid().draftRow).toBeNull();
  });

  it("keeps the draft with the server's error when the insert is refused", async () => {
    mount();
    act(() => grid().onInsertRow());
    act(() => grid().onDraftCellChange("qty", { value: "3", touched: true }));
    h.api.insertRow.mockRejectedValueOnce("not null: order_id");
    await act(() => grid().onDraftCommit());
    expect(grid().draftRow).toMatchObject({
      saving: false,
      error: "not null: order_id",
      cells: { qty: { value: "3", touched: true } },
    });
  });

  it("drops an untouched draft instead of sending an empty INSERT", async () => {
    mount();
    act(() => grid().onInsertRow());
    expect(grid().draftRow).not.toBeNull();
    await act(() => grid().onDraftCommit());
    expect(h.api.insertRow).not.toHaveBeenCalled();
    expect(grid().draftRow).toBeNull();
  });

  it("does not start a duplicate when the trimmed row cannot be loaded back", async () => {
    h.browse.hydrate.mockRejectedValue(new Error("gone"));
    mount();
    await act(() => grid().onDuplicateRow([1, 5, 100, 0, 7]));
    expect(grid().draftRow).toBeNull();
  });
});

describe("TableDataTab — when the rows are not writable", () => {
  function expectReadOnly() {
    const g = grid();
    expect(g.editable).toBe(false);
    expect(g.onDeleteRow).toBeUndefined();
    expect(g.onBulkDelete).toBeUndefined();
    expect(g.onDuplicateRow).toBeUndefined();
    expect(g.onPasteBlock).toBeUndefined();
    expect(g.onInsertRow).toBeUndefined();
  }

  it("a table with no primary key is read-only and keys rows by their whole value", () => {
    seedSchema("logs", [col("msg", "text"), col("at", "timestamp")]);
    h.browse.result = page(
      [
        ["msg", "TEXT"],
        ["at", "TIMESTAMP"],
      ],
      [["hi", "2026-01-01"]],
    );
    mount("logs");
    expectReadOnly();
    expect(grid().insertBlocked).toBe("dataGrid.insertBlocked.noPk");
    expect(grid().getRowKey(["hi", "2026-01-01"])).toBe('["hi","2026-01-01"]');
    expect(h.props.notice).toBeUndefined();
  });

  it("a result that lost a key column (projection) is read-only, and says why for insert", () => {
    h.browse.result = page(
      [
        ["line", "INT"],
        ["qty", "INT"],
      ],
      [[1, 5]],
    );
    mount();
    expectReadOnly();
    expect(grid().insertBlocked).toBe("dataGrid.insertBlocked.pkHidden");
    expect(grid().getRowKey([1, 5])).toBe("[1,5]");
  });

  it("with the key present, rows are keyed by the key tuple in catalog order", () => {
    mount();
    expect(grid().editable).toBe(true);
    expect(grid().pkColumnNames).toEqual(["order_id", "line"]);
    expect(grid().getRowKey([2, 3, 100, 1, 8])).toBe("[100,2]");
  });

  // ADR #136: a view never takes rows from the grid, so neither Insert nor
  // Duplicate is offered — not disabled with a reason, absent. (Until 1.40
  // Insert was disabled with "A view can't take new rows here", and Duplicate
  // was offered and failed on the server.)
  it("a view offers neither insert nor duplicate, and keeps its other writes", () => {
    seedSchema("order_lines", LINE_COLS, { view: true });
    mount();
    expect(grid().onInsertRow).toBeUndefined();
    expect(grid().insertBlocked).toBeNull();
    expect(grid().onDuplicateRow).toBeUndefined();
    expect(grid().editable).toBe(true);
    expect(grid().onDeleteRow).toBeTypeOf("function");
    expect(grid().onPasteBlock).toBeTypeOf("function");
  });

  it("a paste into a view leaves its overflow rows out, saying it is a view", async () => {
    seedSchema("order_lines", LINE_COLS, { view: true });
    mount();
    await act(() =>
      grid().onPasteBlock({
        text: "42\n43",
        rows: [[1, 5, 100, 0, 7]],
        columns: [{ name: "qty", data_type: "INT" }],
      }),
    );
    const plan = h.props.pasteDialog!.plan as {
      updates: unknown[];
      inserts: unknown[];
      skipped: { column: string; reason: string }[];
    };
    expect(plan.updates).toHaveLength(1);
    expect(plan.inserts).toEqual([]);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({ column: "qty", reason: "view" }),
    );
  });

  it("no insert is offered or blocked until the columns have loaded", () => {
    useSchema.setState({
      byConnection: {
        c1: {
          tables: [],
          columns: {},
          columnErrors: {},
        } as unknown as ConnectionSchema,
      },
    });
    mount();
    expect(grid().onInsertRow).toBeUndefined();
    expect(grid().insertBlocked).toBeNull();
  });

  it("a projection adds the key to the wire and withholds duplicate", () => {
    useTabs.setState({
      tabs: [
        {
          id: "tab1",
          kind: "table",
          title: "order_lines",
          connectionId: "c1",
          table: "order_lines",
          viewState: { projection: { fields: ["qty"] } },
        } as never,
      ],
    });
    mount();
    expect(h.browse.query?.wire).toEqual({
      fields: ["order_id", "line", "qty"],
      exclude: false,
    });
    expect(grid().onDuplicateRow).toBeUndefined();
    expect(grid().editable).toBe(true);
    expect(grid().onDeleteRow).toBeTypeOf("function");
  });
});

describe("TableDataTab — managed policy locks", () => {
  it("an update lock makes cells read-only and hides bulk update, nothing else", () => {
    h.locks = { update: "no update" };
    mount();
    const g = grid();
    expect(g.editable).toBe(false);
    expect(g.onDeleteRow).toBeTypeOf("function");
    expect(g.onInsertRow).toBeTypeOf("function");
    expect(g.onPasteBlock).toBeTypeOf("function");
    const ids = (g.insertExtra as { id: string }[]).map((i) => i.id);
    expect(ids).toEqual(["export-data"]);
    expect(h.props.notice).toMatchObject({
      locked: { insert: false, update: true, delete: false },
    });
  });

  it("without locks the bulk update entry is offered", () => {
    mount();
    const ids = (grid().insertExtra as { id: string }[]).map((i) => i.id);
    expect(ids).toEqual(["export-data", "bulk-update"]);
  });

  it("a delete lock removes single and bulk delete only", () => {
    h.locks = { delete: "no delete" };
    mount();
    expect(grid().onDeleteRow).toBeUndefined();
    expect(grid().onBulkDelete).toBeUndefined();
    expect(grid().editable).toBe(true);
  });

  it("an insert lock blocks insert with the policy's own reason and removes duplicate", () => {
    h.locks = { insert: "Inserts are off for analysts" };
    mount();
    expect(grid().onInsertRow).toBeUndefined();
    expect(grid().insertBlocked).toBe("Inserts are off for analysts");
    expect(grid().onDuplicateRow).toBeUndefined();
  });

  it("column limits reach the grid as per-column locks for update and insert", () => {
    h.policyColumns = {
      insert: ["qty"],
      update: ["qty"],
      lock: (verb, column) =>
        column === "qty" ? null : `${verb} locked: ${column}`,
    };
    mount();
    const g = grid();
    expect(g.columnLock("qty")).toBeNull();
    expect(g.columnLock("shipped")).toBe("update locked: shipped");
    expect(g.draftColumnLock("shipped")).toBe("insert locked: shipped");
    expect(h.props.notice).toMatchObject({
      columns: { insert: ["qty"], update: ["qty"] },
    });
  });

  it("without column limits the grid gets no column lock at all", () => {
    mount();
    expect(grid().columnLock).toBeUndefined();
    expect(grid().draftColumnLock).toBeUndefined();
  });
});

describe("TableDataTab — foreign keys", () => {
  it("opens the referenced table filtered to the clicked value", () => {
    const open = vi.fn();
    useTabs.setState({ open } as never);
    mount();
    // Copy as SQL addresses the table by its own names.
    expect(grid().sqlTarget).toMatchObject({
      table: "order_lines",
      pkColumns: ["order_id", "line"],
    });
    expect(grid().sqlTarget.columnOf("qty")).toBe("qty");
    // The header's key icon and the cell gesture read one list.
    expect(grid().fkColumnNames).toEqual(["product_id"]);
    grid().onNavigateFk("product_id", 7);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "table",
        connectionId: "c1",
        schema: "shop",
        table: "products",
        initialFilters: [{ column: "id", op: "eq", value: 7 }],
      }),
    );
    open.mockClear();
    grid().onNavigateFk("qty", 5);
    expect(open).not.toHaveBeenCalled();
  });
});
