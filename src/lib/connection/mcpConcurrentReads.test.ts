import { describe, expect, it } from "vitest";

import {
  MAX_MCP_CONCURRENT_READS,
  parseMcpConcurrentReads,
} from "./mcpConcurrentReads";
import { parseMcpLimit } from "./mcpLimit";

describe("parseMcpConcurrentReads", () => {
  it("reads blank as 'follow the default'", () => {
    expect(parseMcpConcurrentReads("")).toBeNull();
    expect(parseMcpConcurrentReads("  ")).toBeNull();
  });

  it("accepts one up to the maximum", () => {
    expect(parseMcpConcurrentReads("1")).toBe(1);
    expect(parseMcpConcurrentReads(" 4 ")).toBe(4);
    expect(parseMcpConcurrentReads(String(MAX_MCP_CONCURRENT_READS))).toBe(
      MAX_MCP_CONCURRENT_READS,
    );
  });

  it("refuses zero, fractions and too many", () => {
    expect(parseMcpConcurrentReads("0")).toBeUndefined();
    expect(parseMcpConcurrentReads("1.5")).toBeUndefined();
    expect(parseMcpConcurrentReads("two")).toBeUndefined();
    expect(
      parseMcpConcurrentReads(String(MAX_MCP_CONCURRENT_READS + 1)),
    ).toBeUndefined();
  });
});

describe("parseMcpLimit", () => {
  it("holds a value to its own bounds", () => {
    expect(parseMcpLimit("10", 1, 10)).toBe(10);
    expect(parseMcpLimit("11", 1, 10)).toBeUndefined();
    expect(parseMcpLimit("-1", 1, 10)).toBeUndefined();
  });
});
