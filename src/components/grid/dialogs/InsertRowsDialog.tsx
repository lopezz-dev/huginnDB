/**
 * Paste JSON rows into a SQL table.
 *
 * The SQL sibling of `InsertDocumentDialog`, closing a different gap. That one
 * exists because a MongoDB collection is schemaless and the grid's column set
 * is only a sample of it, so a field the sample missed could not be typed at
 * all. A SQL table has no such problem — the server enforces its columns, and
 * the draft row can already reach every one of them.
 *
 * What SQL was missing is **bulk**. The draft row commits one row per
 * `insert_row` call, so "here are forty rows from a spreadsheet" had no path
 * short of hand-writing an `INSERT` in the query editor. Paste an array here
 * and it becomes one multi-row statement inside one transaction.
 *
 * **The frontend does not parse what is typed here**, the same rule the Mongo
 * dialog follows (ADR #33): the text crosses IPC as source and Rust decides
 * what it means. That is not merely symmetry — the backend is where the
 * catalogue is, and the catalogue is what turns a pasted key into a column name
 * safely (convention #4) and what decides whether a JSON `true` is `1` or the word.
 * A `JSON.parse` here could report a syntax error slightly sooner and would
 * still have to defer every question that matters.
 *
 * Monaco in `json` mode rather than the Mongo dialog's `PipelineEditor`: here
 * the grammar really is strict JSON, there is no `ObjectId(…)` to keep from
 * being red-squiggled, and the bundled JSON worker gives syntax validation for
 * free.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type Monaco } from "@monaco-editor/react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { api } from "@/lib/tauri";
import {
  selectEditorPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";

/** What a fresh dialog starts with: one empty row, caret between the braces.
 *  Not a skeleton of the table's columns — that is the draft row's job, done
 *  worse, and it would put a wrong primary key in front of someone who only
 *  wanted to paste. */
const INITIAL_SOURCE = "{\n  \n}";

export function InsertRowsDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  table,
  onInserted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema?: string;
  /** Table to insert into. Shown in the title — a dialog that writes to a
   *  database says which table. */
  table: string;
  /** Refresh the grid. Called only after the insert resolves. */
  onInserted: () => void;
}) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);
  const [source, setSource] = useState(INITIAL_SOURCE);
  const { submitting, error, run, clearError } = useAsyncSubmit();

  // Reset on *open* rather than on close, so a rejected paste keeps the text on
  // screen while its error is read — and so reopening never shows the last
  // attempt's leftovers.
  useEffect(() => {
    if (open) {
      setSource(INITIAL_SOURCE);
      clearError();
    }
  }, [open, clearError]);

  const submit = useCallback(() => {
    if (!source.trim()) return;
    run(async () => {
      await api.insertRows({ connectionId, schema, table, source });
      onInserted();
      onOpenChange(false);
    });
  }, [source, run, connectionId, schema, table, onInserted, onOpenChange]);

  // `addCommand` keeps its handler for the editor's lifetime, so it reads the
  // latest callback through a ref rather than closing over the first render's
  // — the same reason `PipelineEditor` and `QueryEditorTab` both do this.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  const handleMount = useCallback((rawEditor: unknown, monaco: Monaco) => {
    const editor = rawEditor as {
      addCommand: (keybinding: number, handler: () => void) => string | null;
    };
    // Ctrl+Enter commits, matching every other editor in the app.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      submitRef.current();
    });
  }, []);

  const editorOptions = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      // A pasted payload is read top to bottom, and the box is too short for a
      // minimap to be anything but noise.
      minimap: { enabled: false },
      folding: true,
      lineNumbers: "on" as const,
    }),
    [editorPrefs],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tier="panel" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dataGrid.insertRows.title", { table })}</DialogTitle>
          <DialogDescription>{t("dataGrid.insertRows.hint")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* `height={280}` is explicit, not `flex-1`: Monaco sizes itself in
              pixels, and a flex-stretched box inside the `panel` tier's
              scrolling body would hand it a height that isn't settled until
              layout, which Monaco does not react to on its own. */}
          <div className="overflow-hidden rounded-md border border-border">
            <Editor
              height={280}
              language="json"
              theme={monacoTheme}
              value={source}
              onChange={(v) => setSource(v ?? "")}
              onMount={handleMount}
              options={editorOptions}
            />
          </div>

          {/* Above the footer, not in a toast: a rejected paste names a row, a
              column or a parse position, and it has to be readable next to the
              text it is about. The dialog stays open with the source intact so
              it can be fixed in place. */}
          {error && (
            <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">
              {t("dataGrid.insertRows.failed", { message: error })}
            </div>
          )}
        </DialogBody>
        <DialogActions
          onCancel={() => onOpenChange(false)}
          cancelLabel={t("common.cancel")}
          onConfirm={submit}
          confirmLabel={
            submitting
              ? t("dataGrid.insertRows.inserting")
              : t("dataGrid.insertRows.confirm")
          }
          confirmDisabled={submitting || !source.trim()}
        />
      </DialogContent>
    </Dialog>
  );
}
