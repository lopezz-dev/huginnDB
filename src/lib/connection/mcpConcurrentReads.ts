/**
 * How many AI reads may run at once against one connection (ADR #141): its
 * bounds and the parse of a typed value, for the per-connection field in
 * Settings → MCP.
 *
 * Mirrors `DEFAULT_MCP_CONCURRENT_READS` / `MAX_MCP_CONCURRENT_READS` in
 * `src-tauri/src/state.rs`. The backend clamps regardless.
 */

import { parseMcpLimit } from "./mcpLimit";

export const DEFAULT_MCP_CONCURRENT_READS = 2;
export const MIN_MCP_CONCURRENT_READS = 1;
export const MAX_MCP_CONCURRENT_READS = 16;

export function parseMcpConcurrentReads(raw: string): number | null | undefined {
  return parseMcpLimit(raw, MIN_MCP_CONCURRENT_READS, MAX_MCP_CONCURRENT_READS);
}
