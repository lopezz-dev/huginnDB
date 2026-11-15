/**
 * @vitest-environment jsdom
 *
 * Characterization tests for the query tab, written before ADR #137 splits
 * it up and redesigns it. They pin what 1.39.x ships — both run paths, the
 * result tabs, the batch summary, the DML line, the error box, refresh after
 * a grid write, the database selector, the history sidebar and the save
 * dialog — as the user sees it and as the backend receives it, so the
 * extraction (step 2 of the ADR) can be checked against behaviour rather
 * than a reading.
 *
 * Four of these pin **defects**, as current behaviour, and say so in their
 * name (`DEFECT:`). Each one is fixed by a later PR of the same plan, which
 * flips its test and says why:
 *
 * - a batch replayed from the history goes down the single path;
 * - "Clear history" clears every connection;
 * - the info bar hard-codes the shortcut;
 * - a batch is recorded with `elapsedMs: 0`.
 *
 * Monaco is a `<textarea>` that hands `onMount` a fake editor; the language
 * providers and the shortcut redispatch are mocked to capture what the tab
 * registers (the CodeLens runner, the `runQuery` handler). `QueryResultGrid`
 * and `SaveQueryDialog` are stubs that record their props. The database
 * `Select` is a plain list of buttons: Radix's portal and pointer capture
 * are not what is under test.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BatchResult,
  ConnectionProfile,
  QueryResult,
  StmtOutcome,
} from "@/types";

const h = vi.hoisted(() => ({
  api: {
    executeQuery: vi.fn(),
    executeBatch: vi.fn(),
    listDatabases: vi.fn(),
    openDatabaseView: vi.fn(),
    updatePreferences: vi.fn(),
  },
  notify: { error: vi.fn(), success: vi.fn(), file: vi.fn(), info: vi.fn() },
  grid: [] as Record<string, unknown>[],
  save: [] as Record<string, unknown>[],
  /** What the tab registered with the shared SQL provider (CodeLens runner). */
  sqlEntry: null as null | { runStatement: (text: string) => void },
  /** Shortcut handlers the tab registered with the Monaco redispatch. */
  shortcuts: [] as { id: string; run: () => void }[],
  /** What the fake editor reports: its buffer, selection and caret line. */
  editor: { value: "", selection: null as string | null, line: 1 },
  aiTask: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ api: h.api }));
vi.mock("@/lib/notify", () => ({ notify: h.notify }));
vi.mock("@/lib/ai/runTask", () => ({ runAiTask: h.aiTask }));

const t = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}${JSON.stringify(opts)}` : key;
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t }),
}));

vi.mock("@monaco-editor/react", () => ({
  default: function Editor({
    value,
    onChange,
    onMount,
  }: {
    value: string;
    onChange: (v: string) => void;
    onMount: (editor: unknown, monaco: unknown) => void;
  }) {
    h.editor.value = value;
    useEffect(() => {
      const model = {
        getLineCount: () => 1,
        getValueLength: () => 0,
        getValue: () => h.editor.value,
        getValueInRange: () => h.editor.selection ?? "",
        uri: { toString: () => "inmemory://model/1" },
      };
      onMount(
        {
          getModel: () => model,
          getSelection: () => ({ isEmpty: () => h.editor.selection === null }),
          getPosition: () => ({ lineNumber: h.editor.line }),
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          onKeyDown: () => ({ dispose: () => {} }),
          addCommand: () => null,
          addAction: () => ({ dispose: () => {} }),
        },
        {},
      );
      // Mount-once, like the real editor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <textarea
        aria-label="editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));

vi.mock("@/lib/monaco/monacoSql", () => ({
  ensureSqlProviders: () => {},
  fireSqlLensChange: () => {},
  registerSqlEditor: (_uri: string, entry: { runStatement: (t: string) => void }) => {
    h.sqlEntry = entry;
    return () => {};
  },
}));
vi.mock("@/lib/monaco/monacoMongoQuery", () => ({
  MONGO_QUERY_LANGUAGE: "mongodb-query",
  ensureMongoQueryProviders: () => {},
  registerMongoQueryEditor: () => () => {},
}));
vi.mock("@/lib/monaco/monacoKeybindings", () => ({
  registerEditorActionRedispatch: (
    _editor: unknown,
    actions: { id: string; run: () => void }[],
  ) => {
    h.shortcuts = actions;
    return () => {};
  },
}));

vi.mock("@/components/query/QueryResultGrid", () => ({
  QueryResultGrid: (p: Record<string, unknown>) => {
    h.grid.push(p);
    return <div data-testid="result-grid" />;
  },
}));
vi.mock("@/components/query/dialogs/SaveQueryDialog", () => ({
  SaveQueryDialog: (p: Record<string, unknown>) => {
    h.save.push(p);
    return null;
  },
}));

const SelectCtx = createContext<(v: string) => void>(() => {});
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: ReactNode;
  }) => (
    <SelectCtx.Provider value={onValueChange}>
      <div data-testid="db-select" data-value={value}>
        {children}
      </div>
    </SelectCtx.Provider>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
    const pick = useContext(SelectCtx);
    return (
      <button type="button" data-db-option={value} onClick={() => pick(value)}>
        {children}
      </button>
    );
  },
}));

import { QueryEditorTab } from "./QueryEditorTab";
import { useTabs } from "@/stores/session/tabs";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useQueryHistory } from "@/stores/query/queryHistory";
import { usePreferences } from "@/stores/preferences/preferences";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const profile = (
  id: string,
  driver: ConnectionProfile["driver"],
): ConnectionProfile =>
  ({
    id,
    name: id,
    driver,
    host: "localhost",
    port: 5432,
    database: "app",
    username: "u",
    ssl: false,
  }) as ConnectionProfile;

const rows = (names: string[], data: unknown[][], extra: Partial<QueryResult> = {}): QueryResult => ({
  columns: names.map((name) => ({ name, data_type: "TEXT" })),
  rows: data as QueryResult["rows"],
  rows_affected: data.length,
  elapsed_ms: 7,
  total: null,
  ...extra,
});

const write = (affected: number): QueryResult => ({
  columns: [],
  rows: [],
  rows_affected: affected,
  elapsed_ms: 3,
  total: null,
});

const stmt = (
  index: number,
  preview: string,
  extra: Partial<StmtOutcome> = {},
): StmtOutcome => ({
  index,
  preview,
  rows_affected: 0,
  is_select: false,
  error: null,
  results: [],
  ...extra,
});

/** Three statements: a read, a write, a read. */
const BATCH_SQL = "SELECT a FROM t;\nUPDATE t SET a = 1;\nSELECT b FROM u";
const BATCH_OK: BatchResult = {
  statements: [
    stmt(0, "SELECT a FROM t", {
      is_select: true,
      rows_affected: 2,
      results: [rows(["a"], [[1], [2]])],
    }),
    stmt(1, "UPDATE t SET a = 1", { rows_affected: 5 }),
    stmt(2, "SELECT b FROM u", {
      is_select: true,
      rows_affected: 1,
      results: [rows(["b"], [["x"]])],
    }),
  ],
  total_affected: 5,
  stopped: null,
};
const BATCH_FAILED: BatchResult = {
  statements: [
    stmt(0, "SELECT a FROM t", {
      is_select: true,
      rows_affected: 2,
      results: [rows(["a"], [[1], [2]])],
    }),
    stmt(1, "UPDATE t SET a = 1", { error: "permission denied" }),
  ],
  total_affected: 0,
  stopped: null,
};

const CONN = "pg1";
let tabId = "";

function seed(query: string, conn = CONN) {
  tabId = useTabs.getState().open({
    kind: "query",
    title: "query.sql",
    connectionId: conn,
    query,
  });
}

function renderTab(conn = CONN) {
  return render(<QueryEditorTab tabId={tabId} connectionId={conn} />);
}

/** Let the pending promises (the run, the database list) settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const lastGrid = () => h.grid[h.grid.length - 1] as Loose;
const lastSave = () => h.save[h.save.length - 1] as Loose;
/** The Run button's title names the binding (or just "Run" when unbound). */
const runButton = () =>
  screen.getByTitle(/^query\.runTitle/) as HTMLButtonElement;

async function clickRun() {
  await act(async () => {
    fireEvent.click(runButton());
  });
  await flush();
}

/** Press a shortcut the tab registered (Monaco's redispatch is mocked). */
async function press(id: string) {
  const action = h.shortcuts.find((s) => s.id === id);
  if (!action) throw new Error(`${id} is not registered`);
  await act(async () => action.run());
  await flush();
}
/** `runAll` (Mod+Shift+Enter): the whole buffer, batched when it is several. */
const runAll = () => press("runAll");

const resultTabs = () =>
  screen.queryByRole("radiogroup", { name: "query.resultTabs" });

// ---------------------------------------------------------------------------

beforeEach(() => {
  h.grid = [];
  h.save = [];
  h.sqlEntry = null;
  h.shortcuts = [];
  h.editor = { value: "", selection: null, line: 1 };
  for (const fn of Object.values(h.api)) fn.mockReset();
  for (const fn of Object.values(h.notify)) fn.mockReset();
  h.aiTask.mockReset();
  h.api.listDatabases.mockResolvedValue([]);
  h.api.updatePreferences.mockResolvedValue(undefined);
  useTabs.setState({ tabs: [], activeId: null } as never);
  useConnections.setState({
    profiles: [profile(CONN, "postgres"), profile("other", "postgres")],
  });
  // The catalogue fetch is not under test; keep it off the network mock.
  useSchema.setState({ refresh: vi.fn(async () => {}) } as never);
  useQueryHistory.setState({ entries: [] });
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

describe("single statement", () => {
  it("runs the buffer through execute_query and shows its rows in the grid", async () => {
    seed("SELECT 1");
    h.api.executeQuery.mockResolvedValue(rows(["x"], [[1]]));
    renderTab();

    expect(runButton().textContent).toContain("query.run");
    await clickRun();

    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT 1");
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    const g = lastGrid();
    expect(g.sql).toBe("SELECT 1");
    expect(g.connectionId).toBe(CONN);
    expect(g.tabId).toBe(tabId);
    expect(g.driver).toBe("postgres");
    // One set: no strip of result tabs.
    expect(resultTabs()).toBeNull();
  });

  it("records the run in the history with the driver's elapsed time", async () => {
    seed("SELECT 1");
    h.api.executeQuery.mockResolvedValue(rows(["x"], [[1]], { elapsed_ms: 42 }));
    renderTab();
    await clickRun();

    const [entry] = useQueryHistory.getState().entries;
    expect(entry).toMatchObject({
      sql: "SELECT 1",
      connectionId: CONN,
      elapsedMs: 42,
      rowsAffected: 1,
    });
    expect(entry.error).toBeUndefined();
  });

  it("Run (button and Mod+Enter) runs the statement under the cursor, not the whole buffer", async () => {
    seed(BATCH_SQL);
    h.api.executeQuery.mockResolvedValue(write(5));
    renderTab();
    h.editor.line = 2;
    await press("runQuery");
    expect(h.api.executeQuery).toHaveBeenLastCalledWith(CONN, "UPDATE t SET a = 1;");
    h.editor.line = 3;
    await clickRun();
    expect(h.api.executeQuery).toHaveBeenLastCalledWith(CONN, "SELECT b FROM u");
    expect(h.api.executeBatch).not.toHaveBeenCalled();
  });

  it("Run runs the selection when there is one, as a batch if it spans several statements", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    h.editor.selection = "UPDATE t SET a = 1;\nSELECT b FROM u";
    await press("runQuery");
    expect(h.api.executeBatch).toHaveBeenCalledWith(CONN, [
      "UPDATE t SET a = 1;",
      "SELECT b FROM u",
    ]);
  });

  it("a caret between two statements runs nothing and says why", async () => {
    seed("SELECT 1;\n\nSELECT 2");
    renderTab();
    h.editor.line = 2;
    await press("runQuery");
    expect(h.api.executeQuery).not.toHaveBeenCalled();
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    expect(h.notify.info).toHaveBeenCalledWith("query.nothingAtCursor", {
      description: "query.nothingAtCursorHint",
    });
  });

  it("does nothing on an empty buffer", async () => {
    seed("   ");
    renderTab();
    expect(runButton().disabled).toBe(true);
    await press("runQuery");
    await runAll();
    expect(h.api.executeQuery).not.toHaveBeenCalled();
    expect(h.api.executeBatch).not.toHaveBeenCalled();
  });
});

describe("the Run ▾ menu", () => {
  async function openMenu() {
    const trigger = screen.getByLabelText("query.runMenu");
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
  }

  it("offers the statement, the selection (only with one) and all, with its count", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "query.runStatementItem",
      "query.runSelectionItem",
      expect.stringContaining(`query.runAllItem${JSON.stringify({ count: 3 })}`),
    ]);
    expect(items[1].getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.click(items[2]));
    await flush();
    expect(h.api.executeBatch).toHaveBeenCalledTimes(1);
  });

  it("Run the statement ignores a selection", async () => {
    seed(BATCH_SQL);
    h.api.executeQuery.mockResolvedValue(rows(["a"], [[1]]));
    renderTab();
    h.editor.selection = "SELECT b FROM u";
    await openMenu();
    await act(async () => fireEvent.click(screen.getAllByRole("menuitem")[0]));
    await flush();
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT a FROM t;");
  });
});

describe("DML", () => {
  it("a write shows the affected-rows line instead of a grid", async () => {
    seed("DELETE FROM t");
    h.api.executeQuery.mockResolvedValue(write(4));
    renderTab();
    await clickRun();

    expect(screen.queryByTestId("result-grid")).toBeNull();
    expect(
      screen.getByText(`query.rowsAffected${JSON.stringify({ rows: 4, ms: 3 })}`),
    ).toBeTruthy();
    expect(useQueryHistory.getState().entries[0]).toMatchObject({
      rowsAffected: 4,
      elapsedMs: 3,
    });
  });
});

describe("error", () => {
  it("shows the driver's message in place of the results and records it", async () => {
    seed("SELEC 1");
    h.api.executeQuery.mockRejectedValue("syntax error at or near SELEC");
    renderTab();
    await clickRun();

    expect(screen.getByText("syntax error at or near SELEC")).toBeTruthy();
    expect(screen.queryByTestId("result-grid")).toBeNull();
    expect(useQueryHistory.getState().entries[0]).toMatchObject({
      sql: "SELEC 1",
      elapsedMs: 0,
      rowsAffected: 0,
      error: "syntax error at or near SELEC",
    });
  });

  it("a failed run after a good one hides the previous rows", async () => {
    seed("SELECT 1");
    h.api.executeQuery.mockResolvedValueOnce(rows(["x"], [[1]]));
    renderTab();
    await clickRun();
    expect(screen.getByTestId("result-grid")).toBeTruthy();

    h.api.executeQuery.mockRejectedValueOnce("boom");
    await clickRun();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.queryByTestId("result-grid")).toBeNull();
  });
});

describe("batch", () => {
  it("runAll on a buffer of several statements runs execute_batch, one text per statement", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();

    // The button is labelled Run whatever the buffer holds.
    expect(runButton().textContent).toContain("query.run");
    await runAll();

    expect(h.api.executeQuery).not.toHaveBeenCalled();
    // `splitSql` keeps each statement's own `;`.
    expect(h.api.executeBatch).toHaveBeenCalledWith(CONN, [
      "SELECT a FROM t;",
      "UPDATE t SET a = 1;",
      "SELECT b FROM u",
    ]);
  });

  it("the ok summary tallies the batch and lists every statement, writes included", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();

    expect(
      screen.getByText(`query.batchOk${JSON.stringify({ count: 3, rows: 5 })}`),
    ).toBeTruthy();
    expect(screen.getByText("UPDATE t SET a = 1")).toBeTruthy();
    expect(
      screen.getByText(`query.summaryRows${JSON.stringify({ count: 2 })}`),
    ).toBeTruthy();
    expect(
      screen.getByText(`query.summaryAffected${JSON.stringify({ count: 5 })}`),
    ).toBeTruthy();
  });

  it("the failed summary names the statement that stopped the batch", async () => {
    seed("SELECT a FROM t;\nUPDATE t SET a = 1");
    h.api.executeBatch.mockResolvedValue(BATCH_FAILED);
    renderTab();
    await runAll();

    expect(
      screen.getByText(`query.batchFailed${JSON.stringify({ index: 2, total: 2 })}`),
    ).toBeTruthy();
    expect(screen.getByText("permission denied")).toBeTruthy();
    // The read before it still has its rows on screen.
    expect(lastGrid().sql).toBe("SELECT a FROM t;");
    expect(useQueryHistory.getState().entries[0].error).toBe("permission denied");
  });

  it("one result tab per set; writes and failures get none, and the first is selected", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();

    const strip = resultTabs()!;
    const tabs = within(strip).getAllByRole("radio");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toBe(
      `query.resultTab${JSON.stringify({ label: "#1", rows: 2 })}`,
    );
    expect(tabs[1].textContent).toBe(
      `query.resultTab${JSON.stringify({ label: "#3", rows: 1 })}`,
    );
    expect(tabs[0].getAttribute("aria-checked")).toBe("true");
    expect(lastGrid().sql).toBe("SELECT a FROM t;");
  });

  it("a statement with several sets gets a tab per set and no statement text", async () => {
    seed("EXEC two_sets;\nSELECT 1");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "EXEC two_sets", {
          is_select: true,
          results: [rows(["a"], [[1]]), rows(["b"], [[2], [3]])],
        }),
        stmt(1, "SELECT 1", { is_select: true, results: [rows(["x"], [[1]])] }),
      ],
      total_affected: 0,
      stopped: null,
    } satisfies BatchResult);
    renderTab();
    await runAll();

    const tabs = within(resultTabs()!).getAllByRole("radio");
    expect(tabs.map((b) => b.textContent)).toEqual([
      `query.resultTab${JSON.stringify({ label: "#1.1", rows: 1 })}`,
      `query.resultTab${JSON.stringify({ label: "#1.2", rows: 2 })}`,
      `query.resultTab${JSON.stringify({ label: "#2", rows: 1 })}`,
    ]);
    // Not refreshable: re-running it could not say which set to refresh.
    expect(lastGrid().sql).toBeUndefined();
  });

  it("the tooltip of a cut tab says which cap cut it: its own, or the batch budget", async () => {
    const full = Array.from({ length: 50_000 }, (_, i) => [i]);
    seed("SELECT * FROM big;\nSELECT * FROM more");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "SELECT * FROM big", {
          is_select: true,
          results: [rows(["a"], full, { truncated: true })],
        }),
        stmt(1, "SELECT * FROM more", {
          is_select: true,
          results: [rows(["x"], [[1]], { truncated: true })],
        }),
      ],
      total_affected: 0,
      stopped: null,
    } satisfies BatchResult);
    renderTab();
    await runAll();
    const [own, shed] = within(resultTabs()!).getAllByRole("radio");
    expect(own.title).toBe(
      `query.resultTabTruncatedTitle${JSON.stringify({ rows: 50_000 })}`,
    );
    expect(shed.title).toBe(
      `query.resultTabBudgetTitle${JSON.stringify({ rows: 1 })}`,
    );
  });

  it("a batch that throws as a whole shows the error box", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockRejectedValue("connection lost");
    renderTab();
    await runAll();
    expect(screen.getByText("connection lost")).toBeTruthy();
    // Not recorded in the history.
    expect(useQueryHistory.getState().entries).toHaveLength(0);
  });

  it("DEFECT: a batch is recorded in the history with elapsedMs: 0", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    expect(useQueryHistory.getState().entries[0]).toMatchObject({
      // Joined with ";\n" over texts that already end in ";" — the doubled
      // terminator is current behaviour too.
      sql: "SELECT a FROM t;;\nUPDATE t SET a = 1;;\nSELECT b FROM u",
      elapsedMs: 0,
      rowsAffected: 5,
    });
  });
});

describe("CodeLens", () => {
  it("▶ Run on a statement runs only that text, down the single path", async () => {
    seed(BATCH_SQL);
    h.api.executeQuery.mockResolvedValue(write(5));
    renderTab();
    expect(h.sqlEntry).not.toBeNull();
    await act(async () => h.sqlEntry!.runStatement("UPDATE t SET a = 1"));
    await flush();
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "UPDATE t SET a = 1");
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    expect(useQueryHistory.getState().entries[0].sql).toBe("UPDATE t SET a = 1");
  });
});

// ---------------------------------------------------------------------------
// Result tabs
// ---------------------------------------------------------------------------

describe("result tabs", () => {
  it("switching tab mounts the other set and clears the grid's filter", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();

    act(() => (lastGrid().onGlobalFilterChange as (v: string) => void)("abc"));
    expect(lastGrid().globalFilter).toBe("abc");

    const [, second] = within(resultTabs()!).getAllByRole("radio");
    act(() => fireEvent.click(second));
    expect(lastGrid().sql).toBe("SELECT b FROM u");
    expect(lastGrid().globalFilter).toBe("");
  });

  it("refresh after a grid write re-runs only the statement on screen, where it was read", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    const [, second] = within(resultTabs()!).getAllByRole("radio");
    act(() => fireEvent.click(second));

    h.api.executeQuery.mockResolvedValue(rows(["b"], [["y"], ["z"]]));
    await act(async () => {
      await (lastGrid().onRefresh as () => Promise<void>)();
    });

    expect(h.api.executeBatch).toHaveBeenCalledTimes(1);
    expect(h.api.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT b FROM u");
    expect((lastGrid().result as QueryResult).rows).toEqual([["y"], ["z"]]);
    // The tab label follows the fresh row count.
    expect(within(resultTabs()!).getAllByRole("radio")[1].textContent).toBe(
      `query.resultTab${JSON.stringify({ label: "#3", rows: 2 })}`,
    );
  });

  it("a failed refresh is a notification, not the results' error box", async () => {
    seed("SELECT 1");
    h.api.executeQuery.mockResolvedValueOnce(rows(["x"], [[1]]));
    renderTab();
    await clickRun();

    h.api.executeQuery.mockRejectedValueOnce("gone");
    await act(async () => {
      await (lastGrid().onRefresh as () => Promise<void>)();
    });
    expect(h.notify.error).toHaveBeenCalledWith("query.refreshFailed", {
      description: "gone",
    });
    expect(screen.getByTestId("result-grid")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Database selector
// ---------------------------------------------------------------------------

describe("database selector", () => {
  it("is offered on a multi-database server and repoints the next run", async () => {
    seed("SELECT 1");
    h.api.listDatabases.mockResolvedValue([{ name: "app" }, { name: "sales" }]);
    h.api.openDatabaseView.mockResolvedValue(`${CONN}::db::sales`);
    h.api.executeQuery.mockResolvedValue(rows(["x"], [[1]]));
    renderTab();
    await flush();

    expect(h.api.listDatabases).toHaveBeenCalledWith(CONN);
    const select = screen.getByTestId("db-select");
    expect(select.dataset.value).toBe("__default__");

    await act(async () => {
      fireEvent.click(
        select.querySelector('[data-db-option="sales"]') as HTMLElement,
      );
    });
    await flush();
    expect(h.api.openDatabaseView).toHaveBeenCalledWith(CONN, "sales");
    expect(useSchema.getState().refresh).toHaveBeenCalledWith(`${CONN}::db::sales`);
    expect(screen.getByTestId("db-select").dataset.value).toBe("sales");

    await clickRun();
    expect(h.api.executeQuery).toHaveBeenCalledWith(`${CONN}::db::sales`, "SELECT 1");
    expect(lastGrid().connectionId).toBe(`${CONN}::db::sales`);
    // History is filed under the parent connection.
    expect(useQueryHistory.getState().entries[0].connectionId).toBe(CONN);
  });

  it("is not offered on SQLite, which is not asked for its databases", async () => {
    useConnections.setState({ profiles: [profile("lite", "sqlite")] });
    seed("SELECT 1", "lite");
    renderTab("lite");
    await flush();
    expect(h.api.listDatabases).not.toHaveBeenCalled();
    expect(screen.queryByTestId("db-select")).toBeNull();
  });

  it("a failure to switch lands in the results' error box", async () => {
    seed("SELECT 1");
    h.api.listDatabases.mockResolvedValue([{ name: "sales" }]);
    h.api.openDatabaseView.mockRejectedValue("no access to sales");
    renderTab();
    await flush();
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("db-select").querySelector('[data-db-option="sales"]')!,
      );
    });
    await flush();
    expect(screen.getByText("no access to sales")).toBeTruthy();
    expect(h.notify.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function openHistory() {
  act(() => fireEvent.click(screen.getByTitle("query.history")));
}

describe("history", () => {
  it("lists only this connection's entries, newest first", async () => {
    useQueryHistory.getState().add({
      sql: "SELECT other",
      connectionId: "other",
      elapsedMs: 1,
      rowsAffected: 0,
    });
    useQueryHistory.getState().add({
      sql: "SELECT mine",
      connectionId: CONN,
      elapsedMs: 1,
      rowsAffected: 0,
    });
    seed("");
    renderTab();
    openHistory();
    expect(screen.getByTitle("SELECT mine")).toBeTruthy();
    expect(screen.queryByTitle("SELECT other")).toBeNull();
  });

  it("clicking an entry loads it into the editor without running it", async () => {
    useQueryHistory.getState().add({
      sql: "SELECT mine",
      connectionId: CONN,
      elapsedMs: 1,
      rowsAffected: 0,
    });
    seed("");
    renderTab();
    openHistory();
    act(() => fireEvent.click(screen.getByTitle("SELECT mine")));
    expect(useTabs.getState().tabs.find((x) => x.id === tabId)?.query).toBe(
      "SELECT mine",
    );
    expect(h.api.executeQuery).not.toHaveBeenCalled();
  });

  it("Run again on a single entry runs it through execute_query", async () => {
    useQueryHistory.getState().add({
      sql: "SELECT mine",
      connectionId: CONN,
      elapsedMs: 1,
      rowsAffected: 0,
    });
    h.api.executeQuery.mockResolvedValue(rows(["x"], [[1]]));
    seed("");
    renderTab();
    openHistory();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("query.runAgain"));
    });
    await flush();
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT mine");
  });

  it("DEFECT: a batch replayed from the history goes down the single path", async () => {
    useQueryHistory.getState().add({
      sql: "SELECT a FROM t;\nUPDATE t SET a = 1",
      connectionId: CONN,
      elapsedMs: 0,
      rowsAffected: 0,
    });
    h.api.executeQuery.mockRejectedValue("cannot insert multiple commands");
    seed("");
    renderTab();
    openHistory();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("query.runAgain"));
    });
    await flush();
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    expect(h.api.executeQuery).toHaveBeenCalledWith(
      CONN,
      "SELECT a FROM t;\nUPDATE t SET a = 1",
    );
  });

  it("DEFECT: Clear history clears every connection's entries, not only those listed", async () => {
    useQueryHistory.getState().add({
      sql: "SELECT other",
      connectionId: "other",
      elapsedMs: 1,
      rowsAffected: 0,
    });
    useQueryHistory.getState().add({
      sql: "SELECT mine",
      connectionId: CONN,
      elapsedMs: 1,
      rowsAffected: 0,
    });
    seed("");
    renderTab();
    openHistory();
    act(() => fireEvent.click(screen.getByLabelText("query.clearHistory")));
    expect(useQueryHistory.getState().entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

describe("info bar", () => {
  it("shows the user's binding for runQuery, not a hard-coded Ctrl + Enter", async () => {
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, keybindings: { runQuery: ["F9"] } },
    }));
    seed("SELECT 1");
    const { container } = renderTab();
    const kbds = Array.from(container.querySelectorAll("kbd")).map(
      (k) => k.textContent,
    );
    // The Run button's chip and the info bar both follow the binding.
    expect(kbds).toEqual(["F9", "F9"]);
    expect(runButton().title).toBe(`query.runTitle${JSON.stringify({ shortcut: "F9" })}`);
    usePreferences.setState((s) => ({ prefs: { ...s.prefs, keybindings: {} } }));
  });

  it("leaves the shortcut out when runQuery is unbound", () => {
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, keybindings: { runQuery: [] } },
    }));
    seed("SELECT 1");
    const { container } = renderTab();
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(runButton().title).toBe("query.runTitleUnbound");
    usePreferences.setState((s) => ({ prefs: { ...s.prefs, keybindings: {} } }));
  });

  it("counts lines and characters through translations", () => {
    seed("SELECT 1");
    renderTab();
    // The fake model reports 1 line, 0 characters.
    expect(
      screen.getByText(
        `query.lines${JSON.stringify({ count: 1 })} · query.chars${JSON.stringify({ count: 0 })}`,
      ),
    ).toBeTruthy();
  });

  it("shows the database and the driver family with a hard-coded encoding", () => {
    seed("SELECT 1");
    renderTab();
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByText("sql · utf-8")).toBeTruthy();
  });
});

describe("MongoDB", () => {
  it("Run takes the shell statement under the cursor down the single path; the bar says mongodb", async () => {
    useConnections.setState({ profiles: [profile("m1", "mongodb")] });
    seed("db.users.find({})", "m1");
    h.api.executeQuery.mockResolvedValue(rows(["_id"], [["a"]]));
    renderTab("m1");
    await clickRun();
    expect(h.api.executeQuery).toHaveBeenCalledWith("m1", "db.users.find({})");
    expect(lastGrid().driver).toBe("mongodb");
    expect(screen.getByText("mongodb · utf-8")).toBeTruthy();
  });

  it("runAll splits two lines into a batch with its own dialect (no `;` needed)", async () => {
    useConnections.setState({ profiles: [profile("m1", "mongodb")] });
    seed("db.a.countDocuments()\ndb.b.countDocuments()", "m1");
    h.api.executeBatch.mockResolvedValue({ statements: [], total_affected: 0, stopped: null });
    renderTab("m1");
    await runAll();
    expect(h.api.executeBatch).toHaveBeenCalledWith("m1", [
      "db.a.countDocuments()",
      "db.b.countDocuments()",
    ]);
  });
});

describe("save dialog", () => {
  it("is closed until the Save button opens it with the buffer and the parent connection", () => {
    seed("SELECT 1", `${CONN}::db::sales`);
    renderTab(`${CONN}::db::sales`);
    expect(lastSave().open).toBe(false);
    act(() => fireEvent.click(screen.getByTitle("query.saveQuery")));
    expect(lastSave()).toMatchObject({
      open: true,
      sql: "SELECT 1",
      connectionId: CONN,
    });
  });

  it("is not offered on an empty buffer", () => {
    seed("");
    renderTab();
    expect((screen.getByTitle("query.saveQuery") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
