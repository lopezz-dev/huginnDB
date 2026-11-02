/**
 * The MCP timeout ceiling's bounds and the one parse of a typed value, for the
 * per-connection field in Settings → MCP.
 *
 * Mirrors `DEFAULT_MCP_TIMEOUT_SECS` / `MAX_MCP_TIMEOUT_SECS` in
 * `src-tauri/src/state.rs`. The backend clamps regardless; these exist so the
 * field refuses what it would otherwise silently change.
 */

export const DEFAULT_MCP_TIMEOUT_SECS = 300;
export const MIN_MCP_TIMEOUT_SECS = 1;
export const MAX_MCP_TIMEOUT_SECS = 86_400;

/**
 * What a typed ceiling means.
 *
 * - `null` — the field is blank: the connection follows the default.
 * - a number — a valid ceiling, in seconds.
 * - `undefined` — not one (garbage, zero, past a day): leave the saved value
 *   alone.
 */
export function parseMcpTimeoutSecs(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return n >= MIN_MCP_TIMEOUT_SECS && n <= MAX_MCP_TIMEOUT_SECS ? n : undefined;
}
