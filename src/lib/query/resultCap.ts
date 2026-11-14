/**
 * Why an ad-hoc result was cut, read off the result itself.
 *
 * Two caps can mark a `QueryResult` as `truncated` (ADR #127):
 *
 * - a statement's own row cap, `MAX_ADHOC_QUERY_ROWS`, which stops reading at
 *   exactly that many rows;
 * - in a batch, the shared `MAX_BATCH_RESULT_ROWS` budget, which sheds what a
 *   later statement would have kept once earlier ones spent it.
 *
 * Both are 50 000 today (`src-tauri/src/commands/query/adhoc.rs`), so a cut
 * result holding the full cap hit its own; one holding fewer was shed by the
 * budget, because a statement's own cap never stops short of the cap. The
 * tooltip used to blame the budget for both.
 */

import type { QueryResult } from "@/types";

/** Mirror of `MAX_ADHOC_QUERY_ROWS` in `commands/query/adhoc.rs`. */
export const MAX_ADHOC_QUERY_ROWS = 50_000;

export type CutBy = "statement" | "budget";

/** `null` when the result holds every row the statement returned. */
export function cutBy(result: QueryResult): CutBy | null {
  if (!result.truncated) return null;
  return result.rows.length >= MAX_ADHOC_QUERY_ROWS ? "statement" : "budget";
}
