import { describe, expect, it } from "vitest";

import {
  quoteIdent,
  selectSnippet,
  sqlLiteral,
  toBulk,
  toSqlInsert,
  toSqlUpdate,
  type SqlTarget,
} from "./copyFormats";

describe("quoteIdent", () => {
  it("uses each driver's conventional delimiters", () => {
    expect(quoteIdent("mysql", "users")).toBe("`users`");
    expect(quoteIdent("sqlserver", "users")).toBe("[users]");
    expect(quoteIdent("postgres", "users")).toBe('"users"');
    expect(quoteIdent("sqlite", "users")).toBe('"users"');
    // An unknown/absent driver falls back to ANSI double quotes.
    expect(quoteIdent(undefined, "users")).toBe('"users"');
  });

  // The regression this module exists to prevent: a name that contains its own
  // delimiter has to double it, or the emitted SQL does not parse.
  it("doubles an embedded delimiter", () => {
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("sqlserver", "a]b")).toBe("[a]]b]");
  });

  it("leaves a foreign delimiter alone", () => {
    // A backtick is not special to Postgres, so it must survive untouched
    // rather than being escaped as if it were.
    expect(quoteIdent("postgres", "a`b")).toBe('"a`b"');
    expect(quoteIdent("mysql", 'a"b')).toBe('`a"b`');
  });
});

describe("selectSnippet", () => {
  // Deliberately unqualified — no schema/database prefix. The query editor's
  // connection dropdown already says which database a pasted snippet runs
  // against, so a prefix here was redundant noise on every copy-paste.
  it("stays unqualified across drivers", () => {
    expect(selectSnippet("postgres", "users")).toBe('SELECT * FROM "users";');
    expect(selectSnippet("mysql", "orders")).toBe(
      "SELECT * FROM `orders`;",
    );
    expect(selectSnippet("sqlserver", "Users")).toBe(
      "SELECT * FROM [Users];",
    );
  });

  it("escapes an embedded delimiter in the table name", () => {
    expect(selectSnippet("postgres", 'a"b')).toBe('SELECT * FROM "a""b";');
  });

  it("emits a mongosh find() for MongoDB, which has no SQL", () => {
    expect(selectSnippet("mongodb", "events")).toBe(
      "db.events.find({}).limit(100)",
    );
  });

  // The limited form is what the schema tree's "Query this table…" runs, as
  // opposed to what "Copy SELECT statement" puts on the clipboard.
  describe("with a limit", () => {
    it("appends LIMIT on the three drivers that have it", () => {
      expect(selectSnippet("postgres", "users", 100)).toBe(
        'SELECT * FROM "users" LIMIT 100;',
      );
      expect(selectSnippet("mysql", "orders", 100)).toBe(
        "SELECT * FROM `orders` LIMIT 100;",
      );
      expect(selectSnippet("sqlite", "users", 100)).toBe(
        'SELECT * FROM "users" LIMIT 100;',
      );
    });

    // T-SQL has no LIMIT, and `OFFSET … FETCH NEXT` would need an ORDER BY
    // there is none to supply.
    it("uses TOP n on SQL Server", () => {
      expect(selectSnippet("sqlserver", "Users", 100)).toBe(
        "SELECT TOP 100 * FROM [Users];",
      );
    });

    it("threads the limit into MongoDB's own find().limit()", () => {
      expect(selectSnippet("mongodb", "events", 50)).toBe(
        "db.events.find({}).limit(50)",
      );
    });

    it("leaves the unlimited form exactly as it was", () => {
      expect(selectSnippet("postgres", "users")).toBe('SELECT * FROM "users";');
    });

    it("still escapes embedded delimiters", () => {
      expect(selectSnippet("postgres", 'a"b', 10)).toBe(
        'SELECT * FROM "a""b" LIMIT 10;',
      );
    });
  });
});

describe("sqlLiteral", () => {
  it("inlines numbers and booleans, quotes strings, keeps NULL", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(true)).toBe("true");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral("hi")).toBe("'hi'");
  });

  it("doubles an embedded single quote", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("stringifies an object before quoting", () => {
    expect(sqlLiteral({ a: 1 })).toBe("'{\"a\":1}'");
  });

  // Regression: MySQL treats `\` as a string-literal escape character by
  // default, so a pasted-back snippet silently dropped it (`DOMAIN\user`
  // became `DOMAINuser`) unless the backslash is itself doubled.
  it("escapes a backslash for MySQL but not for other drivers", () => {
    expect(sqlLiteral("DOMAIN\\user", "mysql")).toBe("'DOMAIN\\\\user'");
    expect(sqlLiteral("DOMAIN\\user", "postgres")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user", "sqlserver")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user", "sqlite")).toBe("'DOMAIN\\user'");
    expect(sqlLiteral("DOMAIN\\user")).toBe("'DOMAIN\\user'");
  });
});

describe("toBulk", () => {
  const columns = [
    { name: "id", data_type: "int" },
    { name: "note", data_type: "text" },
  ];
  const rows = [
    [1, "first"],
    [2, null],
  ];

  it("yields one JSON array for the whole selection", () => {
    expect(JSON.parse(toBulk(rows, "json", { columns, driver: "postgres" }))).toEqual([
      { id: 1, note: "first" },
      { id: 2, note: null },
    ]);
  });

  it("normalises a BigInt instead of throwing", () => {
    // The old inline copy in `DataGrid` cast values straight in, so a BigInt
    // copied fine as one row and threw the moment two rows were selected.
    const withBig = [[1n as unknown as number, "x"]];
    expect(toBulk(withBig, "json", { columns, driver: "postgres" })).toContain('"1"');
  });

  it("newline-joins one statement per row", () => {
    const sql = toBulk(rows, "insert", {
      columns,
      driver: "postgres",
      target: { table: "notes", columnOf: (c) => c, pkColumns: ["id"] },
    });
    expect(sql.split("\n")).toHaveLength(2);
    expect(sql).toContain('INSERT INTO "notes"');
  });
});

describe("Copy as SQL through a target", () => {
  // A table: result names are its column names.
  const items = [
    { name: "shop_id", data_type: "int" },
    { name: "id", data_type: "int" },
    { name: "price", data_type: "numeric" },
  ];
  const table: SqlTarget = {
    table: "items",
    columnOf: (c) => c,
    pkColumns: ["shop_id", "id"],
  };
  const row = [1, 7, "9.50"];

  it("addresses a table by its full composite key", () => {
    expect(toSqlUpdate(row, items, "postgres", table)).toBe(
      'UPDATE "items" SET "price" = \'9.50\' WHERE "shop_id" = 1 AND "id" = 7;',
    );
    expect(toSqlInsert(row, items, "postgres", table)).toBe(
      'INSERT INTO "items" ("shop_id", "id", "price") VALUES (1, 7, \'9.50\');',
    );
  });

  // A query: `SELECT id, price AS p, price * 2 AS doubled, shop_id FROM items`.
  const result = [
    { name: "id", data_type: "int" },
    { name: "p", data_type: "numeric" },
    { name: "doubled", data_type: "numeric" },
    { name: "shop_id", data_type: "int" },
  ];
  const as: Record<string, string | null> = { id: "id", p: "price", doubled: null, shop_id: "shop_id" };
  const query: SqlTarget = { ...table, columnOf: (c) => as[c] ?? null };
  const qrow = [7, "9.50", "19.00", 1];

  it("names table columns for aliases and leaves expressions out", () => {
    expect(toSqlUpdate(qrow, result, "mysql", query)).toBe(
      "UPDATE `items` SET `price` = '9.50' WHERE `shop_id` = 1 AND `id` = 7;",
    );
    expect(toSqlInsert(qrow, result, "mysql", query)).toBe(
      "INSERT INTO `items` (`id`, `price`, `shop_id`) VALUES (7, '9.50', 1);",
    );
  });

  it("never writes a partial WHERE: without the whole key it leaves a placeholder", () => {
    const partial = result.slice(0, 3); // shop_id left out
    expect(toSqlUpdate(qrow.slice(0, 3), partial, "postgres", query)).toBe(
      'UPDATE "items" SET "price" = \'9.50\' WHERE <pk> = <value>;',
    );
  });

  it("without a target keeps the result's names and a table placeholder", () => {
    expect(toSqlInsert([1, "a"], [{ name: "x", data_type: "int" }, { name: "y", data_type: "text" }], "postgres", undefined)).toBe(
      'INSERT INTO <table> ("x", "y") VALUES (1, \'a\');',
    );
    expect(toSqlUpdate([1, "a"], [{ name: "x", data_type: "int" }, { name: "y", data_type: "text" }], "postgres", undefined, ["x"])).toBe(
      'UPDATE <table> SET "y" = \'a\' WHERE "x" = 1;',
    );
  });
});
