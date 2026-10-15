/**
 * The read-only DDL preview strip under the structure and view editors.
 *
 * Both carried this identically: the `RefreshCw` header with an optional
 * warning badge, the error branch, and a read-only Monaco with the same seven
 * options. Around 35 lines each.
 *
 * The preview and the apply run the *same* Rust builder (`db::ddl::build_ddl`
 * and `db::view_ddl::build_view_ddl`), which is what makes "what is shown is
 * what runs" true — see ADR #16. This component only renders the
 * result; it never assembles SQL.
 */

import Editor from "@monaco-editor/react";

import { RefreshCw } from "lucide-react";

import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import type { EditorPrefs } from "@/types";
import { readOnlyEditorOptions } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";

interface Props {
  /** Section label, e.g. "DDL preview". */
  title: string;
  /** The statements, already joined (see `joinStatements`). */
  ddl: string;
  /** Shown instead of the editor — a build failure, not a SQL error. */
  error?: string | null;
  /**
   * Optional badge beside the title: SQLite's 12-step rebuild warning, or the
   * view editor's drop-and-recreate note.
   */
  warning?: string | null;
  prefs: EditorPrefs;
}

export function DdlPreviewPane({ title, ddl, error, warning, prefs }: Props) {
  const editorOptions = useEditorOptions(
    () => readOnlyEditorOptions(prefs),
    [prefs],
  );
  // Hoisted out of the JSX because the editor sits behind the `error`
  // branch — a hook cannot be called from one side of a ternary.
  const monacoTheme = useMonacoTheme(prefs.theme);

  return (
    <div className="flex h-48 flex-col border-t border-border">
      <div className="flex items-center gap-2 px-3 py-1 text-2xs text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        {title}
        {warning && (
          <span className="rounded-sm bg-warning/20 px-1.5 py-0.5 text-warning">
            {warning}
          </span>
        )}
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs text-destructive">{error}</div>
      ) : (
        <Editor
          height="100%"
          value={ddl}
          language="sql"
          theme={monacoTheme}
          options={editorOptions}
        />
      )}
    </div>
  );
}
