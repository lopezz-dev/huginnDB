import { describe, expect, it } from "vitest";
import { databaseViewId } from "@/lib/connectionLabel";
import { ALL_SCOPE } from "./filterScope";
import { parsePatterns } from "./matchesFilter";
import { summarizeMatches } from "./treeMatches";
import {
  buildFlatTree,
  DATABASE_NODE_KEY,
  groupTables,
  type FlatRow,
  type FlatTreeInput,
} from "./flatTree";
import type { ConnectionSchema } from "@/stores/session/schema";
import type { ColumnInfo, ConnectionProfile, Driver, TableInfo } from "@/types";

function profile(
  id: string,
  driver: Driver,
  database: string,
  extra: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    id,
    name: id,
    driver,
    host: "localhost",
    port: 0,
    database,
    username: "u",
    ssl: false,
    ...extra,
  } as ConnectionProfile;
}

function slice(part: Partial<ConnectionSchema> = {}): ConnectionSchema {
  return {
    databases: [],
    tables: [],
    columns: {},
    indexes: {},
    columnErrors: {},
    indexErrors: {},
    databaseSizes: {},
    databaseSizesLoading: false,
    databaseSizesLoaded: false,
    expanded: new Set(),
    loading: false,
    error: null,
    initialized: true,
    ...part,
  };
}

const table = (
  schema: string,
  name: string,
  kind: TableInfo["kind"] = "table",
): TableInfo => ({
  schema,
  name,
  kind,
});

const column = (name: string): ColumnInfo =>
  ({ name, data_type: "int", nullable: false, is_primary_key: false }) as ColumnInfo;

function input(
  profiles: ConnectionProfile[],
  byConnection: Record<string, ConnectionSchema>,
  part: Partial<FlatTreeInput> = {},
): FlatTreeInput {
  return {
    buckets: { ungrouped: profiles, groups: [] },
    allHidden: false,
    isGroupCollapsed: () => false,
    isConnectionExpanded: () => true,
    active: new Set(profiles.map((p) => p.id)),
    vanished: new Set(),
    byConnection,
    patterns: [],
    scope: ALL_SCOPE,
    matchCounts: new Map(),
    visibleDatabases: () => null,
    subsetIsLocal: () => false,
    activeDatabaseByConnection: {},
    views: {},
    ...part,
  };
}

/** A compact, readable picture of the rows: `kind[:label]@guides`. */
function shape(rows: FlatRow[]): string[] {
  return rows.map((r) => {
    const label =
      r.kind === "connection"
        ? r.profile.id
        : r.kind === "database" || r.kind === "bound-database"
          ? r.dbName
          : r.kind === "schema"
            ? r.schema
            : r.kind === "section"
              ? r.section
              : r.kind === "table"
                ? r.table.name
                : r.kind === "column"
                  ? r.column.name
                  : r.kind === "group"
                    ? r.name
                    : "";
    return `${r.kind}${label ? `:${label}` : ""}@${r.guides}`;
  });
}

describe("buildFlatTree — single-database connections", () => {
  it("grows a database node above the schemas when they are not the database (Postgres)", () => {
    const pg = profile("pg", "postgres", "shop");
    const { rows } = buildFlatTree(
      input([pg], {
        pg: slice({
          tables: [table("public", "orders"), table("public", "v_orders", "view")],
          expanded: new Set([
            "schema:public",
            "schema:public:tables",
            "schema:public:views",
          ]),
        }),
      }),
    );
    expect(shape(rows)).toEqual([
      "connection:pg@0",
      "bound-database:shop@1",
      "schema:public@2",
      "section:tables@2",
      "table:orders@2",
      "section:views@2",
      "table:v_orders@2",
      "indexes@2",
    ]);
  });

  it("merges the schema into the database when they are the same (MySQL, any case)", () => {
    const my = profile("my", "mysql", "Shop");
    const { rows } = buildFlatTree(
      input([my], { my: slice({ tables: [table("shop", "orders")] }) }),
    );
    expect(shape(rows)).toEqual(["connection:my@0", "schema:shop@1"]);
    const schemaRow = rows[1] as Extract<FlatRow, { kind: "schema" }>;
    expect(schemaRow.asDatabase).toBe(true);
    // Collapsed by default: no sections until the schema is opened.
    expect(schemaRow.open).toBe(false);
  });

  it("hides everything under a folded database node", () => {
    const pg = profile("pg", "postgres", "shop");
    const { rows } = buildFlatTree(
      input([pg], {
        pg: slice({
          tables: [table("public", "orders")],
          expanded: new Set([DATABASE_NODE_KEY, "schema:public"]),
        }),
      }),
    );
    expect(shape(rows)).toEqual(["connection:pg@0", "bound-database:shop@1"]);
  });

  it("lists columns, a retry or a shimmer under an expanded table", () => {
    const lite = profile("lite", "sqlite", "/tmp/x.db");
    const expanded = new Set([
      "schema:main",
      "schema:main:tables",
      "table:main.a",
      "table:main.b",
      "table:main.c",
    ]);
    const { rows } = buildFlatTree(
      input([lite], {
        lite: slice({
          tables: [table("main", "a"), table("main", "b"), table("main", "c")],
          expanded,
          columns: { "main.a": [column("id"), column("name")] },
          columnErrors: { "main.b": "timed out" },
        }),
      }),
    );
    expect(shape(rows).slice(3)).toEqual([
      "table:a@1",
      "column:id@1",
      "column:name@1",
      "table:b@1",
      "columns-error@1",
      "table:c@1",
      "skeleton@1",
      "indexes@1",
    ]);
    const a = rows[3] as Extract<FlatRow, { kind: "table" }>;
    expect(a.hasColumns).toBe(true);
  });

  it("shows a shimmer and asks for the first read of a slice that has none", () => {
    const pg = profile("pg", "postgres", "shop");
    const { rows, needs } = buildFlatTree(input([pg], {}));
    expect(shape(rows)).toEqual(["connection:pg@0", "skeleton@1"]);
    expect(needs.load).toEqual(["pg"]);
  });

  it("does not ask again while the first read is running", () => {
    const pg = profile("pg", "postgres", "shop");
    const { needs } = buildFlatTree(
      input([pg], { pg: slice({ initialized: false, loading: true }) }),
    );
    expect(needs.load).toEqual([]);
  });

  it("keeps drawing the tree under a failed refresh, with the error above it", () => {
    const my = profile("my", "mysql", "shop");
    const { rows } = buildFlatTree(
      input([my], {
        my: slice({ tables: [table("shop", "t")], error: "gone away" }),
      }),
    );
    expect(shape(rows)).toEqual([
      "connection:my@0",
      "load-error@1",
      "schema:shop@1",
    ]);
  });

  it("asks for SQLite's file size", () => {
    const lite = profile("lite", "sqlite", "/tmp/x.db");
    const { needs } = buildFlatTree(input([lite], { lite: slice() }));
    expect(needs.sizes).toEqual(["lite"]);
  });
});

describe("buildFlatTree — the filter", () => {
  it("opens every schema and section and keeps only matching relations", () => {
    const pg = profile("pg", "postgres", "shop");
    const { rows } = buildFlatTree(
      input(
        [pg],
        {
          pg: slice({
            tables: [table("public", "users"), table("public", "orders")],
            // Folded by the user; the filter opens it anyway.
            expanded: new Set([DATABASE_NODE_KEY]),
          }),
        },
        { patterns: parsePatterns("user") },
      ),
    );
    expect(shape(rows)).toEqual([
      "connection:pg@0",
      "bound-database:shop@1",
      "schema:public@2",
      "section:tables@2",
      "table:users@2",
      "indexes@2",
    ]);
  });

  it("says so when nothing matched", () => {
    const my = profile("my", "mysql", "shop");
    const { rows } = buildFlatTree(
      input(
        [my],
        { my: slice({ tables: [table("shop", "orders")] }) },
        { patterns: parsePatterns("zzz") },
      ),
    );
    expect(shape(rows)).toEqual(["connection:my@0", "no-matches@1"]);
  });
});

describe("buildFlatTree — multi-database connections", () => {
  const server = profile("srv", "postgres", "");
  const child = databaseViewId("srv", "sales");

  it("lists databases and opens the view of an expanded one", () => {
    const { rows, needs } = buildFlatTree(
      input([server], {
        srv: slice({
          databases: [{ name: "hr" }, { name: "sales" }],
          expanded: new Set(["db:sales"]),
        }),
      }),
    );
    expect(shape(rows)).toEqual([
      "connection:srv@0",
      "database:hr@1",
      "database:sales@1",
      "skeleton@2",
    ]);
    expect(needs.openViews).toEqual([{ parentId: "srv", database: "sales" }]);
    expect(needs.sizes).toEqual(["srv"]);
    expect([...needs.expandedViews]).toEqual([child]);
  });

  it("does not open a view twice while it is opening", () => {
    const { needs } = buildFlatTree(
      input(
        [server],
        {
          srv: slice({
            databases: [{ name: "sales" }],
            expanded: new Set(["db:sales"]),
          }),
        },
        { views: { [child]: { state: "opening" } } },
      ),
    );
    expect(needs.openViews).toEqual([]);
  });

  it("draws an open view's tables without a redundant single-schema header", () => {
    const { rows, needs } = buildFlatTree(
      input(
        [server],
        {
          srv: slice({
            databases: [{ name: "sales" }],
            expanded: new Set(["db:sales"]),
          }),
          [child]: slice({
            tables: [table("public", "orders")],
            expanded: new Set(["schema:public:tables"]),
          }),
        },
        { views: { [child]: { state: "open" } } },
      ),
    );
    expect(shape(rows)).toEqual([
      "connection:srv@0",
      "database:sales@1",
      "section:tables@2",
      "table:orders@2",
      "indexes@2",
    ]);
    expect(needs.openViews).toEqual([]);
  });

  it("shows a failed open with a retry, and does not retry on its own", () => {
    const { rows, needs } = buildFlatTree(
      input(
        [server],
        {
          srv: slice({
            databases: [{ name: "sales" }],
            expanded: new Set(["db:sales"]),
          }),
        },
        { views: { [child]: { state: "error", message: "refused" } } },
      ),
    );
    const err = rows[2] as Extract<FlatRow, { kind: "load-error" }>;
    expect(err.kind).toBe("load-error");
    expect(err.retry).toEqual({ kind: "reopen-view", childId: child });
    expect(needs.openViews).toEqual([]);
  });

  it("opens a database with matches and keeps a name-only match folded", () => {
    const byConnection = {
      srv: slice({ databases: [{ name: "sales" }, { name: "users_db" }] }),
      [child]: slice({ tables: [table("public", "users")] }),
      [databaseViewId("srv", "users_db")]: slice({ tables: [] }),
    };
    const patterns = parsePatterns("user");
    const summaries = summarizeMatches(
      [{ connectionId: "srv", multiDb: true, visibleDatabases: null }],
      byConnection,
      patterns,
      ALL_SCOPE,
    );
    const { rows } = buildFlatTree(
      input([server], byConnection, {
        patterns,
        matchCounts: new Map(summaries.map((s) => [s.connectionId, s])),
        views: { [child]: { state: "open" } },
      }),
    );
    const dbs = rows.filter(
      (r): r is Extract<FlatRow, { kind: "database" }> => r.kind === "database",
    );
    expect(dbs.map((d) => [d.dbName, d.expanded, d.matchCount])).toEqual([
      ["sales", true, 1],
      ["users_db", false, 0],
    ]);
    expect(shape(rows)).toContain("table:users@2");
  });

  it("names the visible-databases subset and the empty server", () => {
    const { rows } = buildFlatTree(
      input(
        [server],
        { srv: slice({ databases: [{ name: "a" }, { name: "b" }] }) },
        { visibleDatabases: () => ["zzz"] },
      ),
    );
    expect(shape(rows)).toEqual([
      "connection:srv@0",
      "subset-note@1",
      "no-databases@1",
    ]);
    const empty = rows[2] as Extract<FlatRow, { kind: "no-databases" }>;
    expect(empty.empty).toBe(false);
  });
});

describe("buildFlatTree — connections and folders", () => {
  it("draws an idle or folded connection as its row alone", () => {
    const a = profile("a", "postgres", "x");
    const b = profile("b", "postgres", "y");
    const { rows, needs } = buildFlatTree(
      input([a, b], { a: slice(), b: slice() }, {
        active: new Set(["a"]),
        isConnectionExpanded: () => false,
      }),
    );
    expect(shape(rows)).toEqual(["connection:a@0", "connection:b@0"]);
    expect(needs.load).toEqual([]);
  });

  it("indents a folder's connections one guide and hides a folded folder's", () => {
    const a = profile("a", "postgres", "x");
    const b = profile("b", "postgres", "y");
    const { rows } = buildFlatTree(
      input([], {}, {
        buckets: {
          ungrouped: [],
          groups: [
            { name: "prod", items: [a] },
            { name: "test", items: [b] },
          ],
        },
        active: new Set(),
        isGroupCollapsed: (name) => name === "test",
      }),
    );
    expect(shape(rows)).toEqual([
      "group:prod@0",
      "connection:a@1",
      "group:test@0",
    ]);
  });

  it("gives every row a unique key", () => {
    const pg = profile("pg", "postgres", "shop");
    const tables = Array.from({ length: 500 }, (_, i) => table("public", `t${i}`));
    const { rows } = buildFlatTree(
      input([pg], {
        pg: slice({
          tables,
          expanded: new Set(["schema:public", "schema:public:tables"]),
        }),
      }),
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("buildFlatTree — a schema with ten thousand tables", () => {
  it("lists them as rows and regroups nothing on a rebuild", () => {
    const ms = profile("ms", "sqlserver", "erp");
    const tables = Array.from({ length: 10_000 }, (_, i) =>
      table("dbo", `t${String(i).padStart(5, "0")}`),
    );
    const base = input([ms], {
      ms: slice({
        tables,
        expanded: new Set(["schema:dbo", "schema:dbo:tables"]),
      }),
    });
    const first = buildFlatTree(base);
    expect(first.rows.filter((r) => r.kind === "table")).toHaveLength(10_000);

    // A column load elsewhere replaces the slice but not its `tables` array,
    // and `patterns` keeps its identity between commits: the grouping is the
    // remembered one, so a rebuild only re-emits rows.
    const patterns = base.patterns;
    expect(groupTables(tables, patterns)).toBe(groupTables(tables, patterns));
    // A new needle is a new grouping.
    const narrowed = groupTables(tables, parsePatterns("t0000"));
    expect(narrowed.bySchema.dbo.tables).toHaveLength(10);
    expect(groupTables(tables, patterns).bySchema.dbo.tables).toHaveLength(10_000);
  });
});
