/**
 * A statement the assistant proposed, in a read-only Monaco with a per-statement
 * lens that opens it in a query tab.
 *
 * # Why the lens opens the editor instead of running here
 *
 * Roadmap decision D4, read literally: *"any mutation is emitted as SQL in a
 * Monaco block the user runs themselves with the existing per-statement ▶ Run
 * CodeLens"* — the *editor's* lens. So this block's lens hands the statement to
 * `openQueryTab` and stops there. Three reasons it is the right seam and not a
 * shortcut:
 *
 * - **The result needs somewhere to go.** This panel is 360px wide and has no
 *   grid, no pager and no export. Running in place would mean building a second
 *   result surface nobody asked for.
 * - **Every guard already lives in the editor.** The destructive-statement
 *   confirmation, the unfiltered-write refusal, the Console entry, the history
 *   record, the ability to edit and rerun.
 * - **A write should be seen before it runs.** Landing the user in the editor
 *   with the statement in front of them is the whole posture D4 exists to keep.
 *
 * # Why Monaco and not a `<pre>`
 *
 * Decision D5: Monaco is already self-hosted here, and it gives SQL colouring,
 * selection and the lens gutter for free. The providers it needs are **global
 * to the language** and installed once (`ensureSqlProviders`); this component
 * registers only its own model's data in the shared registry, which is the
 * pattern gotcha #9 and ADR #57 both exist to enforce — a
 * `registerCodeLensProvider` per block would put one duplicate lens on every
 * statement for every block on screen.
 */

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type Monaco } from "@monaco-editor/react";

import { readOnlyEditorOptions } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import {
  ensureSqlProviders,
  registerSqlEditor,
  fireSqlLensChange,
  type SqlLens,
} from "@/lib/monaco/monacoSql";
import { splitSql } from "@/lib/sql/sqlSplit";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import {
  selectEditorPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";

/**
 * Rows the block shows before it scrolls. Ten fits the statements an assistant
 * actually proposes; past that the query tab is the right place to read it, and
 * an unbounded block would push the composer off the panel.
 */
const MAX_ROWS = 10;
/** Matches Monaco's default line-height ratio closely enough to avoid a
 *  measurement pass, which for a block this small would cost a second layout
 *  for a pixel or two. */
const LINE_HEIGHT_RATIO = 1.5;

export function SqlBlock({
  code,
  language,
  connectionId,
  /** An unterminated fence: still streaming, so the lens is withheld. */
  runnable,
}: {
  code: string;
  /** A Monaco language id — `"sql"` or `"javascript"` (mongosh). */
  language: string;
  /** Where "open in editor" sends the statement. `null` disables the lens. */
  connectionId: string | null;
  runnable: boolean;
}) {
  const { t } = useTranslation();
  const prefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(prefs.theme);
  const editorOptions = useEditorOptions(
    () => ({
      ...readOnlyEditorOptions(prefs),
      // The gutter is the lens's home, and folding a five-line statement is
      // noise.
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 0,
      overviewRulerLanes: 0,
      scrollbar: { vertical: "auto" as const, horizontal: "auto" as const },
      // A chat block is read, not scrubbed; a highlighted "current line" in a
      // message reads as an editable field.
      renderLineHighlight: "none" as const,
      contextmenu: false,
    }),
    [prefs],
  );

  const disposeRef = useRef<(() => void) | null>(null);
  const codeRef = useRef(code);
  codeRef.current = code;
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  const runnableRef = useRef(runnable);
  runnableRef.current = runnable;

  useEffect(() => () => disposeRef.current?.(), []);

  // The lens set has to be recomputed when the body changes, which during a
  // stream is every delta — `fireSqlLensChange` refreshes every SQL gutter, so
  // it is called once per change rather than per block.
  useEffect(() => {
    fireSqlLensChange();
  }, [code]);

  const handleMount = useCallback(
    (
      editor: Parameters<NonNullable<React.ComponentProps<typeof Editor>["onMount"]>>[0],
      monaco: Monaco,
    ) => {
      ensureSqlProviders(monaco);
      const uri = editor.getModel()?.uri.toString();
      if (!uri) return;
      disposeRef.current?.();
      disposeRef.current = registerSqlEditor(uri, {
        // No completions in a transcript: the block is read-only, so a
        // suggestion widget could only ever appear and do nothing.
        getCompletions: () => [],
        getLenses: (): SqlLens[] =>
          runnableRef.current
            ? splitSql(codeRef.current).map((s) => ({
                startLine: s.startLine,
                text: s.text,
              }))
            : [],
        runStatement: (text) => {
          const target = connectionRef.current;
          if (!target) return;
          openQueryTab(target, { sql: text });
        },
        lensLabel: () => ({
          title: `▸ ${t("ai.openInEditor")}`,
          tooltip: t("ai.openInEditorHint"),
        }),
      });
    },
    [t],
  );

  const lines = Math.max(1, code.split("\n").length);
  const height =
    Math.min(lines, MAX_ROWS) * Math.round(prefs.fontSize * LINE_HEIGHT_RATIO) +
    // Room for the lens line Monaco inserts above the first statement, plus
    // the block's own breathing space.
    (lines > 0 && runnable ? 26 : 8);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <Editor
        height={height}
        value={code}
        language={language}
        theme={monacoTheme}
        options={editorOptions}
        onMount={handleMount}
      />
    </div>
  );
}
