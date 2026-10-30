import { describe, expect, it } from "vitest";

import { splitGoBatches } from "./tsqlBatches";

describe("splitGoBatches", () => {
  it("returns null when there is no GO line, so the caller uses splitSql", () => {
    expect(splitGoBatches("SELECT 1; SELECT 2;")).toBeNull();
    expect(splitGoBatches("SELECT 'GO'")).toBeNull();
  });

  it("splits on GO lines, case-insensitively and with CRLF", () => {
    expect(
      splitGoBatches("CREATE TABLE t (a int);\r\ngo\r\nINSERT INTO t VALUES (1);\r\nGO\r\n"),
    ).toEqual(["CREATE TABLE t (a int);", "INSERT INTO t VALUES (1);"]);
  });

  it("keeps a procedure body with semicolons in one batch", () => {
    const proc =
      "CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND";
    expect(splitGoBatches(`${proc}\nGO\nEXEC p\nGO`)).toEqual([proc, "EXEC p"]);
  });

  it("keeps an IDENTITY_INSERT wrapper together", () => {
    const batch =
      "SET IDENTITY_INSERT [dbo].[t] ON\nINSERT INTO [dbo].[t] ([id]) VALUES\n  (1)\nSET IDENTITY_INSERT [dbo].[t] OFF;";
    expect(splitGoBatches(`${batch}\nGO\n`)).toEqual([batch]);
  });

  it("does not split on GO inside a string, a bracket name or a comment", () => {
    const text =
      "INSERT INTO t VALUES (N'line one\nGO\nline three');\nGO\n" +
      "SELECT [weird\nGO\nname] FROM t\nGO\n" +
      "/* note\nGO\n*/ SELECT 1\nGO";
    expect(splitGoBatches(text)).toEqual([
      "INSERT INTO t VALUES (N'line one\nGO\nline three');",
      "SELECT [weird\nGO\nname] FROM t",
      "/* note\nGO\n*/ SELECT 1",
    ]);
  });

  it("accepts a trailing comment on the GO line and indentation", () => {
    expect(splitGoBatches("SELECT 1\n  GO -- end of batch\nSELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("leaves GO <n> in the batch for the server to refuse", () => {
    expect(splitGoBatches("SELECT 1\nGO 5\nSELECT 2\nGO")).toEqual([
      "SELECT 1\nGO 5\nSELECT 2",
    ]);
  });
});
