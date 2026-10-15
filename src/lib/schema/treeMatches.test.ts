import { describe, expect, it } from "vitest";
import { databaseViewId } from "@/lib/connectionLabel";
import { parsePatterns } from "./matchesFilter";
import { ALL_SCOPE, type FilterScope } from "./filterScope";
import {
  rowMatchState,
  summarizeMatches,
  totalMatches,
  type SchemaSliceLike,
  type TreeConnectionInput,
} from "./treeMatches";

function slice(part: Partial<SchemaSliceLike> = {}): SchemaSliceLike {
  return {
    databases: [],
    tables: [],
    loading: false,
    initialized: true,
    error: null,
    ...part,
  };
}

const tables = (...names: string[]) => names.map((name) => ({ name }));

const single = (id: string): TreeConnectionInput => ({
  connectionId: id,
  multiDb: false,
  visibleDatabases: null,
});
const multi = (
  id: string,
  visibleDatabases: string[] | null = null,
): TreeConnectionInput => ({ connectionId: id, multiDb: true, visibleDatabases });

describe("summarizeMatches — single-DB connections", () => {
  it("counts matching tables in the connection's own slice", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("users", "user_roles", "orders") }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(2);
    expect(s.byDatabase.size).toBe(0);
    expect(s.coldDatabases).toEqual([]);
  });

  it("is pending while the first fetch is in flight, not zero", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ loading: true, initialized: false }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.pending).toBe(true);
    expect(rowMatchState(s)).toBe("pending");
  });

  it("is a real zero once the slice is initialized and empty", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("orders") }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(0);
    expect(rowMatchState(s)).toBe("none");
  });
});

describe("summarizeMatches — multi-DB connections", () => {
  const byConnection = {
    p: slice({ databases: [{ name: "shop" }, { name: "logs" }, { name: "cold" }] }),
    [databaseViewId("p", "shop")]: slice({ tables: tables("users", "user_roles") }),
    [databaseViewId("p", "logs")]: slice({ tables: tables("access_log") }),
    // "cold" has no slice at all — never opened.
  };

  it("sums the per-database child slices", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), ALL_SCOPE);
    expect(s.byDatabase.get("shop")).toBe(2);
    expect(s.byDatabase.get("logs")).toBe(0);
    expect(s.count).toBe(2);
  });

  it("reports databases nobody has read as cold rather than as zero", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), ALL_SCOPE);
    expect(s.coldDatabases).toEqual(["cold"]);
    expect(s.byDatabase.has("cold")).toBe(false);
    // A cold database outranks a real zero: the row must offer to look, not
    // claim there is nothing there.
    const empty = summarizeMatches([multi("p")], byConnection, parsePatterns("zzz"), ALL_SCOPE)[0];
    expect(empty.count).toBe(0);
    expect(rowMatchState(empty)).toBe("unloaded");
  });

  it("respects the visible-databases subset for BOTH counting and coldness", () => {
    // The bug this kills: the old `prefetching` flag walked every database
    // while the warm loop applied the subset, so it stayed true forever.
    const [s] = summarizeMatches(
      [multi("p", ["shop"])],
      byConnection,
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.byDatabase.has("logs")).toBe(false);
    expect(s.coldDatabases).toEqual([]);
    expect(rowMatchState(s)).toBe("matches");
  });

  it("counts a database matched by its own name", () => {
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("log"), ALL_SCOPE);
    expect(s.databaseNameMatches).toEqual(["logs"]);
    // One for the database name, one for `access_log` inside it.
    expect(s.count).toBe(2);
  });

  it("leaves sibling databases out entirely under a database scope", () => {
    const scope: FilterScope = { kind: "database", connectionId: "p", database: "shop" };
    const [s] = summarizeMatches([multi("p")], byConnection, parsePatterns("user"), scope);
    expect(s.byDatabase.has("logs")).toBe(false);
    expect(s.coldDatabases).toEqual([]);
    expect(s.count).toBe(2);
  });
});

describe("summarizeMatches — a scope pointed somewhere else", () => {
  it("does not search a connection outside the scope, and says so", () => {
    const scope: FilterScope = { kind: "connection", connectionId: "other" };
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("users") }) },
      parsePatterns("user"),
      scope,
    );
    // A `0` here would read as "nothing matched", which is a reason to try a
    // different needle. "Not searched" is not.
    expect(s.outOfScope).toBe(true);
    expect(s.count).toBe(0);
    expect(rowMatchState(s)).toBe("out-of-scope");
  });

  it("claims nothing about a connection outside the scope, not even loading", () => {
    const scope: FilterScope = { kind: "connection", connectionId: "other" };
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ loading: true, initialized: false }) },
      parsePatterns("user"),
      scope,
    );
    expect(s.pending).toBe(false);
    expect(rowMatchState(s)).toBe("out-of-scope");
  });
});

describe("totalMatches", () => {
  it("counts only connections that actually matched", () => {
    const summaries = summarizeMatches(
      [single("a"), single("b"), single("c")],
      {
        a: slice({ tables: tables("users") }),
        b: slice({ tables: tables("orders") }),
        c: slice({ tables: tables("user_roles", "user_tokens") }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(totalMatches(summaries)).toEqual({
      matches: 3,
      connections: 2,
      cold: 0,
      failed: 0,
      pending: false,
    });
  });

  it("adds up the cold databases across connections", () => {
    const summaries = summarizeMatches(
      [multi("p"), multi("q")],
      {
        p: slice({ databases: [{ name: "one" }, { name: "two" }] }),
        q: slice({ databases: [{ name: "three" }] }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(totalMatches(summaries).cold).toBe(3);
  });
});

describe("summarizeMatches — a read that failed", () => {
  // The last loose end of ADR #68. A connection whose schema read failed is
  // `initialized: true, tables: []`, which is byte-for-byte what an empty
  // connection looks like — so it landed in `none`: dimmed row, confident `0`,
  // and folded away by the filter, which unmounted the one place the error was
  // rendered.

  it("is not a real zero", () => {
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ error: "mongodb error: Server selection timeout" }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(0);
    expect(s.failed).toContain("Server selection timeout");
    expect(rowMatchState(s)).toBe("failed");
  });

  it("outranks a cold database, because the two ask for different things", () => {
    // `unloaded` asks the user to look; `failed` says looking did not work.
    const [s] = summarizeMatches(
      [multi("p")],
      {
        p: slice({
          databases: [{ name: "shop" }],
          error: "not connected: p",
        }),
      },
      parsePatterns("zzz"),
      ALL_SCOPE,
    );
    expect(s.coldDatabases).toEqual(["shop"]);
    expect(rowMatchState(s)).toBe("failed");
  });

  it("stays below matches, so a stale count is still shown", () => {
    // `refresh` does not wipe the tables it already had on the failure path, so
    // what is there is the last thing the server did say. The badge annotates
    // it with a `+` rather than replacing a number the user can act on.
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ tables: tables("users"), error: "connection closed" }) },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.count).toBe(1);
    expect(rowMatchState(s)).toBe("matches");
    expect(s.failed).toBe("connection closed");
  });

  it("names the databases that would not answer, and still counts them", () => {
    const [s] = summarizeMatches(
      [multi("p")],
      {
        p: slice({ databases: [{ name: "shop" }, { name: "logs" }] }),
        [databaseViewId("p", "shop")]: slice({ tables: tables("users") }),
        [databaseViewId("p", "logs")]: slice({ error: "connection closed" }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    expect(s.failedDatabases).toEqual(["logs"]);
    // Not cold: cold means nobody looked, and somebody did.
    expect(s.coldDatabases).toEqual([]);
    expect(s.count).toBe(1);
    expect(rowMatchState(s)).toBe("matches");
  });

  it("claims nothing about a connection the scope excluded", () => {
    // Out of scope outranks everything: this connection was not searched, so
    // neither its emptiness nor its failure is this row's story.
    const scope: FilterScope = { kind: "connection", connectionId: "other" };
    const [s] = summarizeMatches(
      [single("c1")],
      { c1: slice({ error: "not connected: c1" }) },
      parsePatterns("user"),
      scope,
    );
    expect(s.failed).toBeNull();
    expect(rowMatchState(s)).toBe("out-of-scope");
  });

  it("counts failing connections once, whichever level failed", () => {
    const summaries = summarizeMatches(
      [single("a"), multi("p"), single("c")],
      {
        a: slice({ error: "not connected: a" }),
        p: slice({ databases: [{ name: "shop" }] }),
        [databaseViewId("p", "shop")]: slice({ error: "connection closed" }),
        c: slice({ tables: tables("users") }),
      },
      parsePatterns("user"),
      ALL_SCOPE,
    );
    // Per connection, not per database: a reconnect is what fixes it, and a
    // connection is what you reconnect.
    expect(totalMatches(summaries).failed).toBe(2);
  });
});
