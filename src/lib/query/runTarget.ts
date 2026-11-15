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
 * back is text and the editor line it starts on (what *Go to statement*
 * offsets from). Whether that text is one statement or several is the run's
 * call (`useQueryRun.run` splits it), so a selection spanning three statements
 * still runs as a batch.
 */

import { statementAt, type SqlDialect } from "@/lib/sql/sqlSplit";

/** What the editor says at the moment of the gesture. */
export interface EditorSnapshot {
  /** The whole buffer. */
  source: string;
  /** The selected text and the line it starts on, or `null` when the
   *  selection is empty. */
  selection: { text: string; startLine: number } | null;
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

/** Text to run, and the 1-based editor line it starts on. */
export interface RunText {
  text: string;
  firstLine: number;
}

/** What `scope` names, or `null` when it names nothing (an empty selection,
 *  a caret between two statements, a blank buffer). */
export function runTarget(snap: EditorSnapshot, scope: RunScope): RunText | null {
  const selection = (): RunText | null =>
    snap.selection?.text.trim()
      ? { text: snap.selection.text, firstLine: snap.selection.startLine }
      : null;
  const statement = (): RunText | null => {
    const hit = statementAt(snap.source, snap.line, snap.dialect);
    return hit?.text.trim() ? { text: hit.text, firstLine: hit.startLine } : null;
  };
  switch (scope) {
    case "all":
      return snap.source.trim() ? { text: snap.source, firstLine: 1 } : null;
    case "selection":
      return selection();
    case "statement":
      return statement();
    case "cursor":
      return selection() ?? statement();
  }
}
