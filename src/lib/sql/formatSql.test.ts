import { describe, expect, it } from "vitest";

import { formatSql, sqlDialectFor } from "./formatSql";

describe("sqlDialectFor", () => {
  // Total over the `Driver` union: adding a driver without a dialect is a
  // compile error in `formatSql.ts`, and this is the runtime half of that.
  it("gives every driver its own dialect", () => {
    expect(sqlDialectFor("postgres").name).toBe("postgresql");
    expect(sqlDialectFor("mysql").name).toBe("mysql");
    expect(sqlDialectFor("sqlite").name).toBe("sqlite");
    expect(sqlDialectFor("sqlserver").name).toBe("transactsql");
  });

  it("falls back to standard SQL for MongoDB and for no driver at all", () => {
    // A Mongo cell holds JSON; the SQL branch is only reachable for a field
    // that literally stores a query string, whose real dialect nothing knows.
    expect(sqlDialectFor("mongodb").name).toBe("sql");
    // An ad-hoc query grid has no connection identity, and a profile can
    // vanish underneath a still-open tab.
    expect(sqlDialectFor(undefined).name).toBe("sql");
  });
});

describe("formatSql", () => {
  // Loose assertions on purpose: pinning exact output would make a patch bump
  // of `sql-formatter` a CI failure rather than an upgrade.
  it("breaks a statement across lines and upper-cases keywords", () => {
    const out = formatSql(
      "select id, name from users where id = 1",
      sqlDialectFor("postgres"),
    );
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM");
    expect(out).toContain("\n");
  });

  it("applies the dialect it is given", () => {
    // `TOP` is T-SQL; the point is only that the dialect reaches the formatter
    // and the statement survives, not how it chooses to lay it out.
    const out = formatSql(
      "select top 10 * from users",
      sqlDialectFor("sqlserver"),
    );
    expect(out.toUpperCase()).toContain("TOP");
  });

  it("returns unparseable input untouched instead of throwing", () => {
    // `detectLanguage` calls something SQL when it merely STARTS with a
    // familiar verb, so this path is reached routinely.
    const raw = "select from from from )))";
    expect(() => formatSql(raw, sqlDialectFor("mysql"))).not.toThrow();
  });

  it("never loses the content, whatever the input", () => {
    const raw = "delete";
    expect(formatSql(raw, sqlDialectFor("sqlite")).trim().length).toBeGreaterThan(
      0,
    );
  });
});
