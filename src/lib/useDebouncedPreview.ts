/**
 * Re-run a preview a beat after its input last changed.
 *
 * The structure and view editors both preview by round-tripping to the backend
 * — `preview_structure_change` builds the DDL in Rust (ADR #16), the view
 * editor also runs a `LIMIT`ed query — so every keystroke would otherwise be an
 * IPC call and, for the view editor, a real query against the server.
 *
 * `AggregationTab` deliberately keeps its own, longer delay: each of its
 * previews runs the pipeline *prefix* for every stage, so the work per fire is
 * not comparable and the two numbers are not one number.
 */

import { useEffect } from "react";

/** Long enough to swallow typing, short enough to feel live. */
export const PREVIEW_DEBOUNCE_MS = 400;

export function useDebouncedPreview(
  /** Whatever changing should re-arm the preview. */
  input: unknown,
  run: () => void,
  delayMs: number = PREVIEW_DEBOUNCE_MS,
): void {
  useEffect(() => {
    const id = setTimeout(run, delayMs);
    return () => clearTimeout(id);
  }, [input, run, delayMs]);
}
