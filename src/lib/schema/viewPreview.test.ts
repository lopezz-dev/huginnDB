import { describe, expect, it } from "vitest";

import { viewPreviewSql } from "./viewPreview";

describe("viewPreviewSql", () => {
  it("caps SQL Server with TOP, never LIMIT", () => {
    const sql = viewPreviewSql("SELECT a FROM dbo.t;", "sqlserver");
    expect(sql).toBe("SELECT TOP 100 * FROM (SELECT a FROM dbo.t) AS __huginn_view_preview");
    expect(sql).not.toMatch(/LIMIT/i);
  });

  it("caps the other SQL engines with LIMIT", () => {
    for (const driver of ["postgres", "mysql", "sqlite"] as const) {
      expect(viewPreviewSql("  SELECT 1  ", driver)).toBe(
        "SELECT * FROM (SELECT 1) AS __huginn_view_preview LIMIT 100",
      );
    }
  });
});
