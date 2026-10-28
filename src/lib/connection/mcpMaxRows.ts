/**
 * The MCP row cap's bounds and the one parse of a typed value, shared by the
 * per-connection field and the global default in Settings → MCP.
 *
 * Mirrors `MAX_MCP_MAX_ROWS` / `DEFAULT_MCP_MAX_ROWS` in `src-tauri/src/state.rs`.
 * The backend clamps regardless; these exist so the field refuses what it
 * would otherwise silently change.
 */

export const MIN_MCP_MAX_ROWS = 1;
export const MAX_MCP_MAX_ROWS = 10_000;

/**
 * What a typed row cap means.
 *
 * - `null` — the field is blank: the connection has no limit of its own and
 *   follows the global default. Only meaningful per connection.
 * - a number — a valid limit.
 * - `undefined` — not a limit (garbage, zero, out of range): leave the saved
 *   value alone.
 */
export function parseMcpMaxRows(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return n >= MIN_MCP_MAX_ROWS && n <= MAX_MCP_MAX_ROWS ? n : undefined;
}
