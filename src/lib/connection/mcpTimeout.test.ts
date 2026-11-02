import { describe, expect, it } from "vitest";

import { MAX_MCP_TIMEOUT_SECS, parseMcpTimeoutSecs } from "./mcpTimeout";

describe("parseMcpTimeoutSecs", () => {
  it("reads blank as 'follow the default'", () => {
    expect(parseMcpTimeoutSecs("")).toBeNull();
    expect(parseMcpTimeoutSecs("   ")).toBeNull();
  });

  it("accepts whole seconds up to a day", () => {
    expect(parseMcpTimeoutSecs("7200")).toBe(7200);
    expect(parseMcpTimeoutSecs(" 1 ")).toBe(1);
    expect(parseMcpTimeoutSecs(String(MAX_MCP_TIMEOUT_SECS))).toBe(
      MAX_MCP_TIMEOUT_SECS,
    );
  });

  it("refuses what is not a ceiling", () => {
    expect(parseMcpTimeoutSecs("0")).toBeUndefined();
    expect(parseMcpTimeoutSecs("-5")).toBeUndefined();
    expect(parseMcpTimeoutSecs("1.5")).toBeUndefined();
    expect(parseMcpTimeoutSecs("1h")).toBeUndefined();
    expect(
      parseMcpTimeoutSecs(String(MAX_MCP_TIMEOUT_SECS + 1)),
    ).toBeUndefined();
  });
});
