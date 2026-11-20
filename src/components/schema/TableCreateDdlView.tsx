/**
 * The structure editor's "CREATE" section: the table's `CREATE` statement as
 * the *server* stores it, read-only and one click from the clipboard.
 *
 * Not a variant of `DdlPreviewPane`, although both are a read-only Monaco of
 * SQL. The preview is the diff the editor would *run* — built from the working
 * state and re-derived on every keystroke — while this is what the table *is*
 * right now, fetched from `SHOW CREATE TABLE` / `sqlite_master`. Showing both at
 * once would put two SQL panes on screen that mean different things, so the
 * editor hides the preview while this section is open.
 *
 * The text is only ever re-fetched, never derived: `revision` is the editor's
 * last server snapshot, so a reload or a successful Apply refreshes it and a
 * pending edit does not.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor from "@monaco-editor/react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { copyToClipboard } from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import { readOnlyEditorOptions } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { EditorContextMenu, useMenuEditor } from "@/components/menus/EditorContextMenu";
import type { EditorPrefs } from "@/types";

interface Props {
  connectionId: string;
  schema: string | undefined;
  table: string;
  /** Any value that changes when the server-side table may have changed. */
  revision: unknown;
  prefs: EditorPrefs;
}

type State =
  | { status: "loading" }
  | { status: "ready"; ddl: string }
  | { status: "error"; message: string };

export function TableCreateDdlView({
  connectionId,
  schema,
  table,
  revision,
  prefs,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });

  // A full-height pane, unlike the preview strip, so line numbers earn their
  // place: they are how a pasted statement gets talked about.
  const editorOptions = useEditorOptions(
    () => ({ ...readOnlyEditorOptions(prefs), lineNumbers: "on" as const }),
    [prefs],
  );
  const monacoTheme = useMonacoTheme(prefs.theme);
  const [menuEditor, attachMenuEditor] = useMenuEditor();

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .getTableCreateDdl(connectionId, schema, table)
      .then((ddl) => !cancelled && setState({ status: "ready", ddl }))
      .catch(
        (e) =>
          !cancelled && setState({ status: "error", message: String(e) }),
      );
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, table, revision]);

  function copy() {
    if (state.status !== "ready") return;
    void copyToClipboard(state.ddl).then(() =>
      notify.success(t("structure.createDdl.copied")),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
        {t("structure.createDdl.hint")}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={copy}
          disabled={state.status !== "ready"}
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          {t("structure.createDdl.copy")}
        </Button>
      </div>
      {state.status === "loading" && (
        <div className="p-4 text-xs text-muted-foreground">
          {t("structure.createDdl.loading")}
        </div>
      )}
      {state.status === "error" && (
        <div className="p-4 text-xs text-destructive">
          {t("structure.createDdl.failed", { message: state.message })}
        </div>
      )}
      {state.status === "ready" && (
        // Read-only (`readOnlyEditorOptions`): the menu is Copy and Select all.
        <EditorContextMenu
          className="min-h-0 flex-1"
          editor={menuEditor}
          header={{ title: table }}
          width="sm"
        >
          <Editor
            height="100%"
            value={state.ddl}
            language="sql"
            theme={monacoTheme}
            onMount={attachMenuEditor}
            options={editorOptions}
          />
        </EditorContextMenu>
      )}
    </div>
  );
}
