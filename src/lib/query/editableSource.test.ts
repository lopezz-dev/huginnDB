import { describe, expect, it } from "vitest";
import type { ColumnInfo, ColumnMeta } from "@/types";
import {
  mapResultColumns,
  resolveResultColumns,
  parseSingleTableSelect,
  pkValuesOf,
} from "./editableSource";

const col = (name: string, pk = false): ColumnInfo => ({
  name,
  data_type: "varchar",
  nullable: !pk,
  is_primary_key: pk,
});
const meta = (...names: string[]): ColumnMeta[] =>
  names.map((name) => ({ name, data_type: "varchar" }));

const USERS = [col("id", true), col("name"), col("email")];

describe("parseSingleTableSelect — accepts", () => {
  it.each([
    ["SELECT * FROM users", "users", undefined],
    ["select * from users where id > 3 order by name limit 10;", "users", undefined],
    ["SELECT u.* FROM public.users u WHERE u.id = 1", "users", "public"],
    ["SELECT id, name AS n FROM `shop`.`users` LIMIT 5, 10", "users", "shop"],
    ["SELECT TOP (50) * FROM [dbo].[users] WITH (NOLOCK) WHERE id IN (1, 2)", "users", "dbo"],
    ["SELECT * FROM users -- JOIN orders in a comment\n WHERE name = 'a, b JOIN c'", "users", undefined],
    ["SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)", "users", undefined],
    ["SELECT * FROM users FOR UPDATE", "users", undefined],
  ])("%s", (sql, table, schema) => {
    const driver = sql.includes("[") ? "sqlserver" : sql.includes("`") ? "mysql" : "postgres";
    const r = parseSingleTableSelect(sql, driver);
    expect(r).not.toBeNull();
    expect(r!.table).toBe(table);
    expect(r!.schema).toBe(schema);
  });

  it("classifies projection items", () => {
    const r = parseSingleTableSelect(
      "SELECT id, u.name AS full_name, email mail, upper(name), 1 + 2 AS three, * FROM users u",
      "postgres",
    );
    expect(r!.items).toEqual([
      { kind: "column", column: "id", alias: null },
      { kind: "column", column: "name", alias: "full_name" },
      { kind: "column", column: "email", alias: "mail" },
      { kind: "expression" },
      { kind: "expression" },
      { kind: "star" },
    ]);
  });
});

describe("parseSingleTableSelect — refuses", () => {
  it.each([
    "SELECT * FROM users JOIN orders ON orders.user_id = users.id",
    "SELECT * FROM users u LEFT JOIN orders o ON o.user_id = u.id",
    "SELECT * FROM users, orders",
    "SELECT DISTINCT name FROM users",
    "SELECT name, count(*) FROM users GROUP BY name",
    "SELECT count(*) FROM users",
    "SELECT id, max(name) FROM users",
    "SELECT * FROM users UNION SELECT * FROM admins",
    "SELECT * FROM (SELECT * FROM users) x",
    "WITH x AS (SELECT * FROM users) SELECT * FROM x",
    "SELECT * INTO backup FROM users",
    "SELECT * FROM users; DELETE FROM users",
    "UPDATE users SET name = 'x'",
    "SELECT * FROM generate_series(1, 3)",
    "SELECT * FROM ONLY users",
    "SELECT * FROM db.dbo.users",
    "SELECT o.* FROM users u",
    "SELECT 1",
    "SELECT * FROM users WHERE name = 'unterminated",
  ])("%s", (sql) => {
    expect(parseSingleTableSelect(sql, "postgres")).toBeNull();
  });

  it("refuses MongoDB outright", () => {
    expect(parseSingleTableSelect("SELECT * FROM users", "mongodb")).toBeNull();
  });

  it("reads a MySQL double-quoted value as a string, not a column", () => {
    const r = parseSingleTableSelect('SELECT id, "name" FROM users', "mysql");
    expect(r!.items[1]).toEqual({ kind: "expression" });
  });

  it("does not let a MySQL # comment hide a JOIN", () => {
    expect(
      parseSingleTableSelect("SELECT * FROM users # it's fine\nJOIN orders", "mysql"),
    ).toBeNull();
  });
});

describe("mapResultColumns", () => {
  const parse = (sql: string) => parseSingleTableSelect(sql, "postgres")!;

  it("maps a star select and finds the key", () => {
    const r = mapResultColumns(parse("SELECT * FROM users"), USERS, meta("id", "name", "email"));
    expect(r!.pkColumns).toEqual(["id"]);
    expect(r!.pkIndices).toEqual([0]);
    expect([...r!.writable.keys()]).toEqual(["id", "name", "email"]);
    expect(pkValuesOf(r!, [7, "a", "b"])).toEqual([7]);
  });

  it("maps aliases to their table column and leaves expressions unwritable", () => {
    const r = mapResultColumns(
      parse("SELECT name AS n, upper(email) AS e, id FROM users"),
      USERS,
      meta("n", "e", "id"),
    );
    expect(r!.writable.get("n")!.name).toBe("name");
    expect(r!.writable.has("e")).toBe(false);
    expect(r!.pkIndices).toEqual([2]);
    expect(r!.pkResultNames).toEqual(["id"]);
  });

  it("matches names without case, as MySQL echoes them", () => {
    const r = mapResultColumns(parse("SELECT ID, Name FROM users"), USERS, meta("ID", "Name"));
    expect(r!.writable.get("Name")!.name).toBe("name");
    expect(r!.pkColumns).toEqual(["id"]);
  });

  it("is read-only when the key is not in the result", () => {
    expect(mapResultColumns(parse("SELECT name FROM users"), USERS, meta("name"))).toBeNull();
  });

  it("is read-only when the key is only there under an expression", () => {
    expect(
      mapResultColumns(parse("SELECT id + 0 AS id, name FROM users"), USERS, meta("id", "name")),
    ).toBeNull();
  });

  it("is read-only for a table without a primary key", () => {
    const cols = [col("a"), col("b")];
    expect(mapResultColumns(parse("SELECT * FROM t"), cols, meta("a", "b"))).toBeNull();
  });

  it("needs every column of a composite key", () => {
    const cols = [col("a", true), col("b", true), col("v")];
    expect(mapResultColumns(parse("SELECT a, v FROM t"), cols, meta("a", "v"))).toBeNull();
    const r = mapResultColumns(parse("SELECT v, b, a FROM t"), cols, meta("v", "b", "a"));
    expect(r!.pkIndices).toEqual([2, 1]);
  });

  it("refuses when the result does not line up with the projection", () => {
    // The catalog changed since (or the star expanded differently).
    expect(mapResultColumns(parse("SELECT * FROM users"), USERS, meta("id", "name"))).toBeNull();
    expect(
      mapResultColumns(parse("SELECT id, name FROM users"), USERS, meta("id", "other")),
    ).toBeNull();
  });

  it("refuses a column the table does not have", () => {
    expect(mapResultColumns(parse("SELECT id, nope FROM users"), USERS, meta("id", "nope"))).toBeNull();
  });

  it("does not write through a name two result columns share with different sources", () => {
    const r = mapResultColumns(
      parse("SELECT id, name, email AS name FROM users"),
      USERS,
      meta("id", "name", "name"),
    );
    expect(r!.writable.has("name")).toBe(false);
    expect(r!.writable.has("id")).toBe(true);
  });
});

describe("resolveResultColumns", () => {
  const parse = (sql: string) => parseSingleTableSelect(sql, "postgres")!;

  it("lines the columns up even when the key did not come back", () => {
    const r = resolveResultColumns(parse("SELECT name AS n, email FROM users"), USERS, meta("n", "email"));
    expect(r!.editable).toBeNull();
    expect(r!.columns.table).toBe("users");
    expect(r!.columns.byName.get("n")!.name).toBe("name");
    expect([...r!.columns.byName.keys()]).toEqual(["n", "email"]);
  });

  it("is writable too when the key came back", () => {
    const r = resolveResultColumns(parse("SELECT * FROM users"), USERS, meta("id", "name", "email"));
    expect(r!.editable!.pkColumns).toEqual(["id"]);
    expect(r!.editable!.writable).toBe(r!.columns.byName);
  });

  it("is nothing when the result does not line up", () => {
    expect(resolveResultColumns(parse("SELECT name FROM users"), USERS, meta("other"))).toBeNull();
  });
});
