import { describe, expect, it } from "vitest";

import { MAX_MCP_MAX_ROWS, parseMcpMaxRows } from "./mcpMaxRows";

describe("parseMcpMaxRows", () => {
  it("reads a blank field as 'follow the default'", () => {
    expect(parseMcpMaxRows("")).toBeNull();
    expect(parseMcpMaxRows("   ")).toBeNull();
  });

  it("accepts a limit inside the bounds", () => {
    expect(parseMcpMaxRows("50")).toBe(50);
    expect(parseMcpMaxRows(" 1 ")).toBe(1);
    expect(parseMcpMaxRows(String(MAX_MCP_MAX_ROWS))).toBe(MAX_MCP_MAX_ROWS);
  });

  it("refuses what is not a limit instead of guessing one", () => {
    expect(parseMcpMaxRows("0")).toBeUndefined();
    expect(parseMcpMaxRows("-5")).toBeUndefined();
    expect(parseMcpMaxRows("12.5")).toBeUndefined();
    expect(parseMcpMaxRows("lots")).toBeUndefined();
    expect(parseMcpMaxRows(String(MAX_MCP_MAX_ROWS + 1))).toBeUndefined();
  });
});
