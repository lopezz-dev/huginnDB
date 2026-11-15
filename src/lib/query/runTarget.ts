/**
 * What a run gesture in the query editor names (ADR #137).
 *
 * One rule for the whole editor: `Ctrl+Enter` (`runQuery`), the Run button and
 * the AI's "explain" actions all act on **the selection, else the statement
 * under the cursor**. The AI actions already worked that way and `Ctrl+Enter`
 * ran the whole buffer, so the tab had two rules for one gesture, and a
 * scratch buffer of twenty queries ran all twenty.
 *
 * Pure: the editor is read by the caller (`EditorSnapshot`), and what comes
 * back is text. Whether that text is one statement or several is the run's
 * call (`useQueryRun.run` splits it), so a selection spanning three statements
 * still runs as a batch.
 */

import { statementAt, type SqlDialect } from "@/lib/sql/sqlSplit";

/** What the editor says at the moment of the gesture. */
export interface EditorSnapshot {
  /** The whole buffer. */
  source: string;
  /** The selected text, or `null` when the selection is empty. */
  selection: string | null;
  /** The caret's 1-based line. */
  line: number;
  dialect: SqlDialect;
}

/**
 * - `cursor` — the selection, else the statement under the caret (`runQuery`).
 * - `selection` — only the selection.
 * - `statement` — only the statement under the caret, even with a selection.
 * - `all` — the whole buffer (`runAll`).
 */
export type RunScope = "cursor" | "selection" | "statement" | "all";

/** The text `scope` names, or `null` when it names nothing (an empty
 *  selection, a caret between two statements, a blank buffer). */
export function runTarget(snap: EditorSnapshot, scope: RunScope): string | null {
  const nonBlank = (s: string | null | undefined) => (s?.trim() ? s : null);
  const statement = () =>
    nonBlank(statementAt(snap.source, snap.line, snap.dialect)?.text);
  switch (scope) {
    case "all":
      return nonBlank(snap.source);
    case "selection":
      return nonBlank(snap.selection);
    case "statement":
      return statement();
    case "cursor":
      return nonBlank(snap.selection) ?? statement();
  }
}
