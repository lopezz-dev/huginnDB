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
    cancelQuery: vi.fn(),
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
  editor: {
    value: "",
    selection: null as string | null,
    line: 1,
    /** The last range the tab selected (Go to statement). */
    selected: null as unknown,
    /** Edits the tab applied (Format). */
    edits: [] as { range: unknown; text: string }[],
    /** Fire Monaco's caret-moved event. */
    moveCaret: (_line: number, _column: number) => {},
  },
  aiTask: vi.fn(),
  /** Ids of the editor's own context-menu actions currently registered. */
  contextActions: new Set<string>(),
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
        getLineCount: () => h.editor.value.split("\n").length,
        getValueLength: () => 0,
        getValue: () => h.editor.value,
        getValueInRange: (range: unknown) =>
          range === "FULL" ? h.editor.value : (h.editor.selection ?? ""),
        getLineMaxColumn: () => 80,
        getFullModelRange: () => "FULL",
        uri: { toString: () => "inmemory://model/1" },
      };
      onMount(
        {
          getModel: () => model,
          getSelection: () => ({
            isEmpty: () => h.editor.selection === null,
            startLineNumber: h.editor.line,
          }),
          setSelection: (r: unknown) => {
            h.editor.selected = r;
          },
          revealLinesInCenter: () => {},
          executeEdits: (_source: string, edits: { range: unknown; text: string }[]) => {
            h.editor.edits.push(...edits);
            return true;
          },
          pushUndoStop: () => true,
          onDidChangeCursorPosition: (
            fn: (e: { position: { lineNumber: number; column: number } }) => void,
          ) => {
            h.editor.moveCaret = (lineNumber, column) => fn({ position: { lineNumber, column } });
            return { dispose: () => {} };
          },
          focus: () => {},
          getPosition: () => ({ lineNumber: h.editor.line }),
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          onKeyDown: () => ({ dispose: () => {} }),
          addCommand: () => null,
          addAction: (action: { id: string }) => {
            h.contextActions.add(action.id);
            return { dispose: () => h.contextActions.delete(action.id) };
          },
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
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { usePendingRuns } from "@/stores/query/pendingRuns";

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
  elapsed_ms: 10,
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

/** Click the result tab whose label starts with `label` ("#3", the Summary…). */
function pickTab(label: string) {
  const tab = within(resultTabs()!)
    .getAllByRole("radio")
    .find((r) => r.textContent?.includes(label));
  if (!tab) throw new Error(`no result tab ${label}`);
  act(() => fireEvent.click(tab));
}
const tabLabels = () =>
  within(resultTabs()!)
    .getAllByRole("radio")
    .map((r) => r.textContent);

const resultTabs = () =>
  screen.queryByRole("radiogroup", { name: "query.resultTabs" });

// ---------------------------------------------------------------------------

beforeEach(() => {
  h.grid = [];
  h.save = [];
  h.sqlEntry = null;
  h.shortcuts = [];
  h.editor = {
    value: "",
    selection: null,
    line: 1,
    selected: null,
    edits: [],
    moveCaret: () => {},
  };
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
  usePendingRuns.setState({ ids: new Set() });
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

    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT 1", expect.any(String));
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
    expect(h.api.executeQuery).toHaveBeenLastCalledWith(CONN, "UPDATE t SET a = 1;", expect.any(String));
    h.editor.line = 3;
    await clickRun();
    expect(h.api.executeQuery).toHaveBeenLastCalledWith(CONN, "SELECT b FROM u", expect.any(String));
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
    ], expect.any(String));
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
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT a FROM t;", expect.any(String));
  });
});

describe("Stop", () => {
  /** A run that stays in flight until `settle` is called. */
  function hold<T>() {
    let settle!: (v: T) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      settle = res;
      fail = rej;
    });
    return { promise, settle, fail };
  }

  it("Run turns into Stop while a run is in flight, and Stop cancels that run by its id", async () => {
    seed("SELECT pg_sleep(60)");
    const run = hold<QueryResult>();
    h.api.executeQuery.mockReturnValue(run.promise);
    h.api.cancelQuery.mockResolvedValue(true);
    renderTab();
    await act(async () => {
      fireEvent.click(runButton());
    });
    const stop = screen.getByText("query.stop").closest("button")!;
    const runId = h.api.executeQuery.mock.calls[0][2] as string;
    expect(runId).toEqual(expect.any(String));
    act(() => fireEvent.click(stop));
    expect(h.api.cancelQuery).toHaveBeenCalledWith(runId);

    await act(async () => {
      run.fail("query stopped (not applied): PostgreSQL cancelled it.");
    });
    await flush();
    expect(screen.queryByText("query.stop")).toBeNull();
    expect(
      screen.getByText(`query.stoppedNotApplied${JSON.stringify({ index: 1 })}`),
    ).toBeTruthy();
    expect(screen.getByText("PostgreSQL cancelled it.")).toBeTruthy();
  });

  it("a stop that may have applied says so (SQLite)", async () => {
    seed("DELETE FROM t");
    h.api.executeQuery.mockRejectedValue(
      "query stopped (may have applied): SQLite cannot interrupt a statement.",
    );
    renderTab();
    await clickRun();
    expect(
      screen.getByText(`query.stoppedMayHaveApplied${JSON.stringify({ index: 1 })}`),
    ).toBeTruthy();
  });

  it("Mod+. stops a run in flight and declines when nothing runs", async () => {
    seed("SELECT 1");
    const run = hold<QueryResult>();
    h.api.executeQuery.mockReturnValue(run.promise);
    h.api.cancelQuery.mockResolvedValue(true);
    renderTab();
    const stopKey = () => h.shortcuts.find((a) => a.id === "stopQuery")!.run();
    expect(stopKey()).toBe(false);
    await act(async () => {
      fireEvent.click(runButton());
    });
    act(() => {
      expect(stopKey()).not.toBe(false);
    });
    expect(h.api.cancelQuery).toHaveBeenCalledTimes(1);
    await act(async () => run.settle(rows(["x"], [[1]])));
  });

  it("a stopped batch lands on the stopped statement; the Summary says where it stopped", async () => {
    seed("UPDATE a SET x = 1;\nUPDATE b SET y = 2;\nSELECT 1");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "UPDATE a SET x = 1", { rows_affected: 3 }),
        stmt(1, "UPDATE b SET y = 2", {
          error:
            "query stopped (not applied): Stopped on the server. The batch's session was closed, so any transaction it had opened was rolled back by the server.",
        }),
      ],
      total_affected: 3,
      stopped: { index: 1, outcome: "not_applied" },
    } satisfies BatchResult);
    renderTab();
    await runAll();
    expect(
      screen.getByText(`query.stoppedNotApplied${JSON.stringify({ index: 2 })}`),
    ).toBeTruthy();
    expect(screen.getByText(/rolled back by the server/)).toBeTruthy();
    pickTab("query.tabSummary");
    expect(
      screen.getByText(`query.batchStopped${JSON.stringify({ index: 2, total: 2 })}`),
    ).toBeTruthy();
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
      screen.getByText(`query.rowsAffected${JSON.stringify({ count: 4, ms: 3 })}`),
    ).toBeTruthy();
    expect(useQueryHistory.getState().entries[0]).toMatchObject({
      rowsAffected: 4,
      elapsedMs: 3,
    });
    // The card shows the statement, and a single statement needs no strip.
    expect(screen.getByText("DELETE FROM t", { selector: "pre" })).toBeTruthy();
    expect(resultTabs()).toBeNull();
  });

  it("Go to statement selects the statement's lines in the editor", async () => {
    seed("SELECT 1;\n\nDELETE FROM t\n  WHERE id = 1;");
    h.api.executeQuery.mockResolvedValue(write(1));
    renderTab();
    h.editor.line = 3;
    await press("runQuery");
    act(() => fireEvent.click(screen.getByText("query.goToStatement")));
    expect(h.editor.selected).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 80,
    });
  });
});

describe("error", () => {
  it("shows an error card with the driver's message and the statement, and records it", async () => {
    seed("SELEC 1");
    h.api.executeQuery.mockRejectedValue("syntax error at or near SELEC");
    renderTab();
    await clickRun();

    expect(screen.getByText("syntax error at or near SELEC")).toBeTruthy();
    expect(
      screen.getByText(`query.statementFailed${JSON.stringify({ index: 1 })}`),
    ).toBeTruthy();
    expect(screen.getByText("SELEC 1", { selector: "pre" })).toBeTruthy();
    expect(screen.getByText("query.goToStatement")).toBeTruthy();
    expect(screen.getByText("query.copyError")).toBeTruthy();
    // No AI action on the card (ADR #137).
    expect(h.aiTask).not.toHaveBeenCalled();
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
    ], expect.any(String));
  });

  it("one tab per statement — reads, writes and the failure — with a Summary first", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();

    expect(tabLabels()).toEqual([
      "query.tabSummary",
      `query.resultTab${JSON.stringify({ label: "#1 · SELECT a FROM t", count: 2 })}`,
      `query.writeTab${JSON.stringify({ label: "#2 · UPDATE t SET a = 1", count: 5 })}`,
      `query.resultTab${JSON.stringify({ label: "#3 · SELECT b FROM u", count: 1 })}`,
    ]);
  });

  it("lands on the first set of rows when nothing failed", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    const radios = within(resultTabs()!).getAllByRole("radio");
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(lastGrid().sql).toBe("SELECT a FROM t;");
  });

  it("lands on the Summary when no statement returned rows", async () => {
    seed("UPDATE a SET x = 1;\nUPDATE b SET y = 2");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "UPDATE a SET x = 1", { rows_affected: 1 }),
        stmt(1, "UPDATE b SET y = 2", { rows_affected: 2 }),
      ],
      total_affected: 3,
      stopped: null,
    } satisfies BatchResult);
    renderTab();
    await runAll();
    expect(
      screen.getByText(`query.batchOk${JSON.stringify({ count: 2, affected: `query.affectedRows${JSON.stringify({ count: 3 })}` })}`),
    ).toBeTruthy();
    expect(screen.queryByTestId("result-grid")).toBeNull();
  });

  it("the Summary tallies the batch and lists every statement with its time", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    pickTab("query.tabSummary");

    expect(
      screen.getByText(`query.batchOk${JSON.stringify({ count: 3, affected: `query.affectedRows${JSON.stringify({ count: 5 })}` })}`),
    ).toBeTruthy();
    expect(screen.getByText("UPDATE t SET a = 1")).toBeTruthy();
    expect(
      screen.getByText(`query.summaryRows${JSON.stringify({ count: 2 })}`),
    ).toBeTruthy();
    expect(
      screen.getByText(`query.summaryAffected${JSON.stringify({ count: 5 })}`),
    ).toBeTruthy();
    // Three statements at 10 ms each.
    expect(screen.getByText("30 ms")).toBeTruthy();

    // A line opens its statement's own tab.
    act(() => fireEvent.click(screen.getByText("SELECT b FROM u")));
    expect(lastGrid().sql).toBe("SELECT b FROM u");
  });

  it("lands on the statement that failed, with its error card; the Summary says where it stopped", async () => {
    seed("SELECT a FROM t;\nUPDATE t SET a = 1");
    h.api.executeBatch.mockResolvedValue(BATCH_FAILED);
    renderTab();
    await runAll();

    expect(screen.getByText("permission denied")).toBeTruthy();
    expect(
      screen.getByText(`query.statementFailed${JSON.stringify({ index: 2 })}`),
    ).toBeTruthy();
    expect(screen.queryByTestId("result-grid")).toBeNull();
    expect(useQueryHistory.getState().entries[0].error).toBe("permission denied");

    pickTab("query.tabSummary");
    expect(
      screen.getByText(`query.batchFailed${JSON.stringify({ index: 2, total: 2 })}`),
    ).toBeTruthy();
  });

  it("a statement with several sets gets a tab per set, and its grid is read-only", async () => {
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

    expect(tabLabels()).toEqual([
      "query.tabSummary",
      `query.resultTab${JSON.stringify({ label: "#1.1 · EXEC two_sets", count: 1 })}`,
      `query.resultTab${JSON.stringify({ label: "#1.2 · EXEC two_sets", count: 2 })}`,
      `query.resultTab${JSON.stringify({ label: "#2 · SELECT 1", count: 1 })}`,
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
    const [, own, shed] = within(resultTabs()!).getAllByRole("radio");
    expect(own.title).toBe(
      `query.resultTabTruncatedTitle${JSON.stringify({ rows: 50_000 })}`,
    );
    expect(shed.title).toBe(
      `query.resultTabBudgetTitle${JSON.stringify({ rows: 1 })}`,
    );
  });

  it("a batch that throws as a whole is an error card naming no statement", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockRejectedValue("connection lost");
    renderTab();
    await runAll();
    expect(screen.getByText("connection lost")).toBeTruthy();
    expect(screen.getByText("query.runFailed")).toBeTruthy();
    // Not recorded in the history.
    expect(useQueryHistory.getState().entries).toHaveLength(0);
  });

  it("a new run replaces every tab", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    h.api.executeQuery.mockResolvedValue(rows(["z"], [[1]]));
    renderTab();
    await runAll();
    expect(resultTabs()).not.toBeNull();
    await clickRun();
    expect(resultTabs()).toBeNull();
    expect(lastGrid().sql).toBe("SELECT a FROM t;");
  });

  it("is recorded in the history as written, with the statements' total time", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    expect(useQueryHistory.getState().entries[0]).toMatchObject({
      sql: BATCH_SQL,
      elapsedMs: 30,
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
    await act(async () => h.sqlEntry!.runStatement("UPDATE t SET a = 1;"));
    await flush();
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "UPDATE t SET a = 1;", expect.any(String));
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    expect(useQueryHistory.getState().entries[0].sql).toBe("UPDATE t SET a = 1;");
    // Its lines come from the lens cache, so Go to statement can find it.
    act(() => fireEvent.click(screen.getByText("query.goToStatement")));
    expect(h.editor.selected).toMatchObject({ startLineNumber: 2, endLineNumber: 2 });
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

    pickTab("#3");
    expect(lastGrid().sql).toBe("SELECT b FROM u");
    expect(lastGrid().globalFilter).toBe("");
  });

  it("refresh after a grid write re-runs only the statement on screen, where it was read", async () => {
    seed(BATCH_SQL);
    h.api.executeBatch.mockResolvedValue(BATCH_OK);
    renderTab();
    await runAll();
    pickTab("#3");

    h.api.executeQuery.mockResolvedValue(rows(["b"], [["y"], ["z"]]));
    await act(async () => {
      await (lastGrid().onRefresh as () => Promise<void>)();
    });

    expect(h.api.executeBatch).toHaveBeenCalledTimes(1);
    expect(h.api.executeQuery).toHaveBeenCalledTimes(1);
    expect(h.api.executeQuery).toHaveBeenCalledWith(CONN, "SELECT b FROM u");
    expect((lastGrid().result as QueryResult).rows).toEqual([["y"], ["z"]]);
    // The tab label follows the fresh row count.
    expect(within(resultTabs()!).getAllByRole("radio")[3].textContent).toBe(
      `query.resultTab${JSON.stringify({ label: "#3 · SELECT b FROM u", count: 2 })}`,
    );
  });

  it("a cut result carries the amber mark on its tab and a strip over the grid", async () => {
    const full = Array.from({ length: 50_000 }, (_, i) => [i]);
    seed("SELECT * FROM big;\nSELECT 1");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "SELECT * FROM big", {
          is_select: true,
          results: [rows(["a"], full, { truncated: true })],
        }),
        stmt(1, "SELECT 1", { is_select: true, results: [rows(["x"], [[1]])] }),
      ],
      total_affected: 0,
      stopped: null,
    } satisfies BatchResult);
    renderTab();
    await runAll();
    const [, cut, whole] = within(resultTabs()!).getAllByRole("radio");
    expect(cut.querySelector("svg.text-warning")).not.toBeNull();
    expect(whole.querySelector("svg.text-warning")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      `query.cutStrip${JSON.stringify({ rows: (50_000).toLocaleString() })}`,
    );
    pickTab("#2");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a result shed by the batch budget says so in its strip", async () => {
    seed("SELECT 1;\nSELECT * FROM more");
    h.api.executeBatch.mockResolvedValue({
      statements: [
        stmt(0, "SELECT 1", { is_select: true, results: [rows(["x"], [[1]])] }),
        stmt(1, "SELECT * FROM more", {
          is_select: true,
          results: [rows(["a"], [[1], [2]], { truncated: true })],
        }),
      ],
      total_affected: 0,
      stopped: null,
    } satisfies BatchResult);
    renderTab();
    await runAll();
    pickTab("#2");
    expect(screen.getByRole("status").textContent).toBe(
      `query.cutStripBudget${JSON.stringify({ rows: "2" })}`,
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
    expect(h.api.executeQuery).toHaveBeenCalledWith(`${CONN}::db::sales`, "SELECT 1", expect.any(String));
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

  it("a failure to switch is a notification, not one of the run's tabs", async () => {
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
    expect(h.notify.error).toHaveBeenCalledWith("query.switchDatabaseFailed", {
      description: "no access to sales",
    });
    expect(screen.queryByText("no access to sales")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("history", () => {
  it("the History button shows and hides the history dock panel", () => {
    useSessionPanelLayout.setState({ rightPanel: null });
    seed("");
    renderTab();
    const button = () => screen.getByLabelText("query.history");
    expect(button().getAttribute("aria-pressed")).toBe("false");
    act(() => fireEvent.click(button()));
    expect(useSessionPanelLayout.getState().rightPanel).toBe("history");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    act(() => fireEvent.click(button()));
    expect(useSessionPanelLayout.getState().rightPanel).toBeNull();
  });

  it("a tab opened to run (the history's Run) runs a batch down the batch path", async () => {
    seed("SELECT a FROM t;\nUPDATE t SET a = 1");
    usePendingRuns.getState().mark(tabId);
    h.api.executeBatch.mockResolvedValue(BATCH_FAILED);
    renderTab();
    await flush();
    expect(h.api.executeQuery).not.toHaveBeenCalled();
    expect(h.api.executeBatch).toHaveBeenCalledWith(CONN, [
      "SELECT a FROM t;",
      "UPDATE t SET a = 1",
    ], expect.any(String));
    // Once: the mark is consumed.
    expect(usePendingRuns.getState().ids.has(tabId)).toBe(false);
  });

  it("a tab that was not asked to run does not run on mount", async () => {
    seed("DELETE FROM t");
    renderTab();
    await flush();
    expect(h.api.executeQuery).not.toHaveBeenCalled();
  });

  it("waits for the connection's driver before running, so MongoDB splits as MongoDB", async () => {
    useConnections.setState({ profiles: [] });
    seed("db.a.countDocuments()\ndb.b.countDocuments()", "m1");
    usePendingRuns.getState().mark(tabId);
    h.api.executeBatch.mockResolvedValue({ statements: [], total_affected: 0, stopped: null });
    renderTab("m1");
    await flush();
    expect(h.api.executeBatch).not.toHaveBeenCalled();
    expect(h.api.executeQuery).not.toHaveBeenCalled();
    act(() => useConnections.setState({ profiles: [profile("m1", "mongodb")] }));
    await flush();
    expect(h.api.executeBatch).toHaveBeenCalledWith("m1", [
      "db.a.countDocuments()",
      "db.b.countDocuments()",
    ], expect.any(String));
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

  it("shows the caret's Ln, Col and the statement count, live", () => {
    seed("SELECT 1;\nSELECT 2");
    renderTab();
    expect(
      screen.getByText(`query.cursorPosition${JSON.stringify({ line: 1, column: 1 })}`),
    ).toBeTruthy();
    expect(
      screen.getByText(`query.statementCount${JSON.stringify({ count: 2 })}`),
    ).toBeTruthy();
    act(() => h.editor.moveCaret(2, 5));
    expect(
      screen.getByText(`query.cursorPosition${JSON.stringify({ line: 2, column: 5 })}`),
    ).toBeTruthy();
  });

  it("shows the database and the driver, and no longer an encoding", () => {
    seed("SELECT 1");
    renderTab();
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByText("postgres")).toBeTruthy();
    expect(screen.queryByText(/utf-8/)).toBeNull();
  });
});

describe("toolbar", () => {
  it("Format rewrites the buffer (or the selection) as one edit, and Shift+Alt+F does too", async () => {
    seed("select a,b from t where x=1");
    renderTab();
    h.editor.value = "select a,b from t where x=1";
    act(() => fireEvent.click(screen.getByLabelText("query.format")));
    expect(h.editor.edits).toHaveLength(1);
    expect(h.editor.edits[0].range).toBe("FULL");
    expect(h.editor.edits[0].text).toMatch(/^SELECT\n/);

    h.editor.selection = "select 1";
    await press("formatQuery");
    expect(h.editor.edits).toHaveLength(2);
    expect(h.editor.edits[1].text).toBe("SELECT\n  1");
  });

  it("Format is not offered on MongoDB, and its shortcut declines there", () => {
    useConnections.setState({ profiles: [profile("m1", "mongodb")] });
    seed("db.a.find({})", "m1");
    renderTab("m1");
    expect(screen.queryByLabelText("query.format")).toBeNull();
    const action = h.shortcuts.find((a) => a.id === "formatQuery")!;
    expect(action.run()).toBe(false);
  });

  it("Explain is offered only where the AI is on for the connection, and asks about the statement", async () => {
    seed("SELECT 1;\nSELECT 2");
    const { unmount } = renderTab();
    expect(screen.queryByLabelText("query.explain")).toBeNull();
    unmount();

    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled: true } },
    }));
    useConnections.setState({
      profiles: [{ ...profile(CONN, "postgres"), ai_enabled: true }],
    });
    renderTab();
    h.editor.line = 2;
    act(() => fireEvent.click(screen.getByLabelText("query.explain")));
    expect(h.aiTask).toHaveBeenCalledWith({
      task: "explainQuery",
      connection: CONN,
      statement: "SELECT 2",
    });
    usePreferences.setState((s) => ({
      prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled: false } },
    }));
  });

  it("the editor's AI context-menu entries come and go with the connection's AI", () => {
    h.contextActions.clear();
    seed("SELECT 1");
    renderTab();
    expect([...h.contextActions]).toEqual([]);

    act(() => {
      usePreferences.setState((s) => ({
        prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled: true } },
      }));
      useConnections.setState({
        profiles: [{ ...profile(CONN, "postgres"), ai_enabled: true }],
      });
    });
    expect([...h.contextActions].sort()).toEqual([
      "huginndb.ai.explainQuery",
      "huginndb.ai.explainSlow",
    ]);

    act(() => {
      usePreferences.setState((s) => ({
        prefs: { ...s.prefs, ai: { ...s.prefs.ai, enabled: false } },
      }));
    });
    expect([...h.contextActions]).toEqual([]);
  });
});

describe("MongoDB", () => {
  it("Run takes the shell statement under the cursor down the single path; the bar says mongodb", async () => {
    useConnections.setState({ profiles: [profile("m1", "mongodb")] });
    seed("db.users.find({})", "m1");
    h.api.executeQuery.mockResolvedValue(rows(["_id"], [["a"]]));
    renderTab("m1");
    await clickRun();
    expect(h.api.executeQuery).toHaveBeenCalledWith("m1", "db.users.find({})", expect.any(String));
    expect(lastGrid().driver).toBe("mongodb");
    expect(screen.getByText("mongodb")).toBeTruthy();
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
    ], expect.any(String));
  });
});

describe("save dialog", () => {
  it("is closed until the Save button opens it with the buffer and the parent connection", () => {
    seed("SELECT 1", `${CONN}::db::sales`);
    renderTab(`${CONN}::db::sales`);
    expect(lastSave().open).toBe(false);
    act(() => fireEvent.click(screen.getByLabelText("query.saveQuery")));
    expect(lastSave()).toMatchObject({
      open: true,
      sql: "SELECT 1",
      connectionId: CONN,
    });
  });

  it("is not offered on an empty buffer", () => {
    seed("");
    renderTab();
    expect((screen.getByLabelText("query.saveQuery") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
