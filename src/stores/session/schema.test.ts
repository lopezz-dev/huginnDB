/**
 * The schema store's failure reporting.
 *
 * Until 1.21.x every failure here was written to slice state and left there,
 * which meant a failure was only ever as visible as some component happening to
 * render that field: the connection-level one is a bare red line that is not
 * mounted unless the row is expanded *and* active, and `indexErrors` was
 * rendered by nothing at all. What made that more than a polish problem is that
 * `refresh` does not rethrow — so `connectAndWarm` reported "Connected" for a
 * server that had never answered. See ADR #68.
 *
 * These pin the reporting contract and the two things it must *not* do: report
 * a stale failure, and report at all when the caller said it would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, DatabaseInfo, IndexInfo, TableInfo } from "@/types";

const listDatabases = vi.fn<() => Promise<DatabaseInfo[]>>();
const listTables = vi.fn<() => Promise<TableInfo[]>>();
const listColumns = vi.fn<() => Promise<ColumnInfo[]>>();
const listIndexes = vi.fn<() => Promise<IndexInfo[]>>();
const getDatabaseSizes = vi.fn().mockResolvedValue({});
const getTableStats = vi.fn<() => Promise<TableInfo[]>>();

vi.mock("@/lib/tauri", () => ({
  api: {
    listDatabases: (...a: unknown[]) => listDatabases(...(a as [])),
    listTables: (...a: unknown[]) => listTables(...(a as [])),
    listColumns: (...a: unknown[]) => listColumns(...(a as [])),
    listIndexes: (...a: unknown[]) => listIndexes(...(a as [])),
    getDatabaseSizes: (...a: unknown[]) => getDatabaseSizes(...a),
    getTableStats: (...a: unknown[]) => getTableStats(...(a as [])),
  },
}));

// Same reasoning as `environments.test.ts`: a real notification would drag the
// preferences store in for a flag nothing here asserts. `notify.test.tsx` owns
// the anatomy and duration behaviour.
const error = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: { error, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

const { useSchema, tableKey, needsTableStats, mergeTableStats } = await import(
  "@/stores/session/schema"
);
import type { ConnectionSchema } from "@/stores/session/schema";

function table(name: string): TableInfo {
  // MySQL and MongoDB have no schema layer, so the backend sends `""` — which
  // is what `tableKey` folds to the same key as `undefined`.
  return { name, schema: "", kind: "table" };
}

/**
 * A slice for `id`, as the tree would have left it.
 *
 * The per-table loaders bail without reporting when there is no slice — the
 * connection was dropped and the failure describes a pool that is gone — so a
 * test for their reporting has to start from a connection that exists. That
 * is the state the main window calls them in; a detached tab window opens its
 * slice with `ensure` first (see the `ensure` tests).
 */
function seed(id: string, over: Partial<ConnectionSchema> = {}) {
  useSchema.setState({
    byConnection: {
      [id]: {
        databases: [],
        tables: [],
        columns: {},
        indexes: {},
        columnErrors: {},
        indexErrors: {},
        databaseSizes: {},
        databaseSizesLoading: false,
        databaseSizesLoaded: false,
        expanded: new Set<string>(),
        loading: false,
        error: null,
        initialized: true,
        ...over,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSchema.setState({ byConnection: {} });
  listDatabases.mockResolvedValue([]);
  listTables.mockResolvedValue([]);
  listColumns.mockResolvedValue([]);
  listIndexes.mockResolvedValue([]);
  getTableStats.mockResolvedValue([]);
});

describe("calls in flight", () => {
  it("a second refresh joins the first instead of asking again", async () => {
    let answer!: (rows: TableInfo[]) => void;
    listTables.mockReturnValueOnce(new Promise((r) => (answer = r)));

    // The connect path: the explorer's mount effect and `connectAndWarm`
    // both ask, a moment apart.
    const first = useSchema.getState().refresh("c1");
    const second = useSchema.getState().refresh("c1", { quiet: true });
    answer([table("users")]);
    await Promise.all([first, second]);

    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(useSchema.getState().byConnection.c1.tables).toEqual([table("users")]);
  });

  it("asks again once the first call has settled", async () => {
    await useSchema.getState().refresh("c1");
    await useSchema.getState().refresh("c1");
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("a dropped connection's call is not joined by the next connection", async () => {
    // The pool behind this call is closed by the disconnect; joining it would
    // hand the reconnected slice its "not connected".
    listTables.mockReturnValueOnce(new Promise(() => {}));
    void useSchema.getState().refresh("c1");
    useSchema.getState().drop("c1");

    listTables.mockResolvedValueOnce([table("fresh")]);
    await useSchema.getState().refresh("c1");

    expect(listTables).toHaveBeenCalledTimes(2);
    expect(useSchema.getState().byConnection.c1.tables).toEqual([table("fresh")]);
  });

  it("re-opening a table before its columns arrive does not ask twice", async () => {
    seed("c1");
    let answer!: (cols: ColumnInfo[]) => void;
    listColumns.mockReturnValueOnce(new Promise((r) => (answer = r)));

    const a = useSchema.getState().loadColumns("c1", "", "users");
    const b = useSchema.getState().loadColumns("c1", "", "users");
    // A different table is a different question.
    const c = useSchema.getState().loadColumns("c1", "", "orders");
    answer([]);
    await Promise.all([a, b, c]);

    expect(listColumns).toHaveBeenCalledTimes(2);
  });
});

describe("per-database views", () => {
  it("borrow the server's database list from their parent", async () => {
    seed("p", { databases: [{ name: "a" }, { name: "b" }] });

    await useSchema.getState().refresh("p::db::a");

    expect(listDatabases).not.toHaveBeenCalled();
    expect(useSchema.getState().byConnection["p::db::a"].databases).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("still ask when the parent never listed them", async () => {
    await useSchema.getState().refresh("p::db::a");
    expect(listDatabases).toHaveBeenCalledTimes(1);
  });
});

describe("deferred table stats", () => {
  const bare = (name: string): TableInfo => ({ name, schema: "db", kind: "table" });

  it("asks only when no relation came back with a figure", () => {
    expect(needsTableStats([bare("a"), bare("b")])).toBe(true);
    // A listing that already carries a figure needs no second call.
    expect(needsTableStats([{ ...bare("a"), row_count: 0 }, bare("b")])).toBe(false);
    // A multi-database parent lists nothing; there is nothing to fill in.
    expect(needsTableStats([])).toBe(false);
  });

  it("merges by schema and name, and ignores rows the listing no longer has", () => {
    const merged = mergeTableStats(
      [bare("pallet"), bare("job")],
      [
        { ...bare("pallet"), row_count: 185600, size_bytes: 58978304 },
        { ...bare("dropped_since"), row_count: 1 },
      ],
    );
    expect(merged).toEqual([
      { ...bare("pallet"), row_count: 185600, size_bytes: 58978304 },
      bare("job"),
    ]);
  });

  it("hands back the same array when there is nothing to merge", () => {
    const tables = [bare("a")];
    expect(mergeTableStats(tables, [])).toBe(tables);
    expect(mergeTableStats(tables, [bare("a")])).toBe(tables);
  });

  it("draws the names without waiting for the figures, then fills them in", async () => {
    listTables.mockResolvedValue([bare("pallet")]);
    let answer!: (rows: TableInfo[]) => void;
    getTableStats.mockReturnValue(new Promise((r) => (answer = r)));

    // Resolves while the stats call is still pending.
    await useSchema.getState().refresh("m1");
    expect(useSchema.getState().byConnection.m1.tables).toEqual([bare("pallet")]);
    expect(getTableStats).toHaveBeenCalledTimes(1);

    answer([{ ...bare("pallet"), row_count: 3 }]);
    await vi.waitFor(() =>
      expect(useSchema.getState().byConnection.m1.tables[0].row_count).toBe(3),
    );
  });

  it("does not ask when the listing already carried its figures", async () => {
    listTables.mockResolvedValue([{ ...bare("t"), row_count: 10 }]);
    await useSchema.getState().refresh("s1");
    expect(getTableStats).not.toHaveBeenCalled();
  });

  it("a failed stats call costs the badges and nothing else", async () => {
    listTables.mockResolvedValue([bare("pallet")]);
    getTableStats.mockRejectedValue(new Error("not authorized"));
    await useSchema.getState().refresh("m2");
    await Promise.resolve();
    expect(useSchema.getState().byConnection.m2.error).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("reports the failure and hands it back to the caller", async () => {
    listTables.mockRejectedValue(new Error("no reachable servers"));

    const failure = await useSchema.getState().refresh("c1");

    expect(failure).toContain("no reachable servers");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("schema.loadFailed");
    expect(error.mock.calls[0][1]).toMatchObject({
      description: failure,
      // Per connection, so a fan-out folds into one card instead of one each.
      group: "schema-load:c1",
    });
    expect(useSchema.getState().byConnection.c1.error).toBe(failure);
  });

  it("answers null and reports nothing when it worked", async () => {
    expect(await useSchema.getState().refresh("c1")).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("stays quiet when the caller says it will report", async () => {
    listTables.mockRejectedValue(new Error("no reachable servers"));

    const failure = await useSchema.getState().refresh("c1", { quiet: true });

    // Still recorded, still returned — only the card is suppressed, so
    // `connectAndWarm` can name the profile and add the driver hint itself.
    expect(failure).toContain("no reachable servers");
    expect(useSchema.getState().byConnection.c1.error).toBe(failure);
    expect(error).not.toHaveBeenCalled();
  });

  it("still marks the slice initialized on failure", async () => {
    listTables.mockRejectedValue(new Error("boom"));
    await useSchema.getState().refresh("c1");
    // The `!initialized && !loading` guard in `useEnsureSchemaLoaded` would
    // otherwise re-fire forever; the retry is the explicit refresh action.
    expect(useSchema.getState().byConnection.c1).toMatchObject({
      initialized: true,
      loading: false,
    });
  });

  it("reports nothing when the connection was dropped mid-flight", async () => {
    listTables.mockImplementation(async () => {
      // The disconnect lands while the request is in flight, so the error
      // describes a pool that no longer exists.
      useSchema.getState().drop("c1");
      throw new Error("not connected: c1");
    });

    expect(await useSchema.getState().refresh("c1")).toBeNull();
    expect(error).not.toHaveBeenCalled();
    // And the slice must not be resurrected — a poisoned slice with
    // `initialized: true` is what no automatic path would ever refresh again.
    expect(useSchema.getState().byConnection.c1).toBeUndefined();
  });
});

describe("ensure", () => {
  it("lets a window that never connected keep its column loads", async () => {
    // A detached tab window: no `refresh` ever ran here, so without `ensure`
    // the answer is dropped as stale and the query panel waits forever.
    const cols: ColumnInfo[] = [
      { name: "id", data_type: "int", nullable: false } as ColumnInfo,
    ];
    listColumns.mockResolvedValue(cols);

    await useSchema.getState().loadColumns("c1", undefined, "users");
    expect(useSchema.getState().byConnection.c1).toBeUndefined();

    useSchema.getState().ensure("c1");
    await useSchema.getState().loadColumns("c1", undefined, "users");
    expect(
      useSchema.getState().byConnection.c1.columns[tableKey("", "users")],
    ).toBe(cols);
  });

  it("leaves an existing slice alone", () => {
    seed("c1", { tables: [table("users")] });
    const before = useSchema.getState().byConnection.c1;
    useSchema.getState().ensure("c1");
    expect(useSchema.getState().byConnection.c1).toBe(before);
  });
});

describe("per-table loads", () => {
  it("reports a failed column read under the connection's group", async () => {
    seed("c1");
    listColumns.mockRejectedValue(new Error("connection closed"));

    await useSchema.getState().loadColumns("c1", undefined, "users");

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("schema.columnsLoadFailed");
    expect(error.mock.calls[0][1]).toMatchObject({ group: "schema-load:c1" });
    expect(
      useSchema.getState().byConnection.c1.columnErrors[tableKey("", "users")],
    ).toContain("connection closed");
  });

  it("reports a failed index read, which nothing else surfaces", async () => {
    seed("c1");
    listIndexes.mockRejectedValue(new Error("connection closed"));

    await useSchema.getState().loadIndexes("c1", undefined, "users");

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe("schema.indexesLoadFailed");
    expect(
      useSchema.getState().byConnection.c1.indexErrors[tableKey("", "users")],
    ).toContain("connection closed");
  });

  it("shares one group across a burst so it folds into a single card", async () => {
    seed("c1");
    listColumns.mockRejectedValue(new Error("connection closed"));

    await Promise.all(
      ["a", "b", "c"].map((t) =>
        useSchema.getState().loadColumns("c1", undefined, t),
      ),
    );

    // Three raises, one group: `notify` folds them into one card counting to
    // three. Expanding a forty-table database against a dead server must not
    // be forty cards.
    expect(error).toHaveBeenCalledTimes(3);
    const groups = new Set(
      error.mock.calls.map((c) => (c[1] as { group: string }).group),
    );
    expect(groups).toEqual(new Set(["schema-load:c1"]));
  });

  it("does not report a per-table failure the caller owns", async () => {
    seed("c1");
    listColumns.mockRejectedValue(new Error("connection closed"));
    await useSchema
      .getState()
      .loadColumns("c1", undefined, "users", { quiet: true });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("refresh's post-load repopulation", () => {
  it("inherits the caller's quiet flag", async () => {
    // A refresh re-loads the per-table metadata of nodes the user has open. A
    // quiet refresh whose children reported loudly would defeat the opt-out
    // one table at a time.
    const key = tableKey("", "users");
    seed("c1", {
      tables: [table("users")],
      columns: { [key]: [] },
      expanded: new Set([`table:${key}`]),
    });
    listTables.mockResolvedValue([table("users")]);
    listColumns.mockRejectedValue(new Error("connection closed"));

    await useSchema.getState().refresh("c1", { quiet: true });

    expect(error).not.toHaveBeenCalled();
    expect(
      useSchema.getState().byConnection.c1.columnErrors[tableKey("", "users")],
    ).toContain("connection closed");
  });
});
