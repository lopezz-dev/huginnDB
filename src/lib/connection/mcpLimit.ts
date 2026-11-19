/**
 * The one parse behind every per-connection MCP limit in Settings → MCP —
 * rows per call, the timeout ceiling, reads at once. Each limit keeps its own
 * module for its bounds (mirrored from `src-tauri/src/state.rs`) and delegates
 * here, so the three fields cannot drift apart in what they accept.
 */

/**
 * What a typed limit means.
 *
 * - `null` — the field is blank: the connection follows the default.
 * - a number — a whole number within `min..=max`.
 * - `undefined` — not one (garbage, a fraction, out of range): leave the
 *   saved value alone.
 */
export function parseMcpLimit(
  raw: string,
  min: number,
  max: number,
): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return n >= min && n <= max ? n : undefined;
}
