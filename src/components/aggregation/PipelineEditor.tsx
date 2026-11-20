/**
 * The Monaco editor used by both aggregation modes — one stage's body in the
 * stage editor, the whole array literal in the text editor.
 *
 * It exists as its own component because the wiring around a Monaco instance in
 * this app is never just "render an editor": the language has to be registered
 * on the instance (`ensureMongoLanguage`), `Ctrl+Enter` has to be bound through
 * Monaco's own command system because a `window` listener never sees it inside
 * the editor's focus area (gotcha #9), and the user-rebindable global shortcuts
 * have to be re-dispatched out of it (`registerEditorActionRedispatch`) for the
 * same reason. Getting that wrong in N stage cards would be N times as wrong.
 *
 * The optional `completion` prop registers this model's live collection/field
 * data with the shared Mongo completion provider (`registerMongoEditor` —
 * same per-model registry pattern as `monacoSql.ts`, gotcha #9). It's read
 * through a ref for the same reason `onRun` is: the registered entry's
 * closures live as long as the model does and must never freeze on the first
 * render's data.
 *
 * The right-click menu (`EditorContextMenu`) is wired here too, for the same
 * reason: each of the three callers (a stage card, the text mode, the insert
 * document dialog) only says what the editor holds (`menuHeader`) and, where
 * there is one, how to format it (`onFormat`).
 */

import { useCallback, useEffect, useRef } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import {
  ensureMongoLanguage,
  MONGO_PIPELINE_LANGUAGE,
  registerMongoEditor,
  type MongoCompletionEntry,
} from "@/lib/monaco/monacoMongo";
import { registerEditorActionRedispatch } from "@/lib/monaco/monacoKeybindings";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences/preferences";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { EditorContextMenu, useMenuEditor } from "@/components/menus/EditorContextMenu";
import type { MenuHeader } from "@/lib/menu/menuSpec";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter — force an immediate preview, bypassing the debounce. */
  onRun?: () => void;
  height: string | number;
  readOnly?: boolean;
  /** Line numbers are noise on a six-line stage body and useful on a
   *  200-line pipeline, so the caller decides. */
  lineNumbers?: boolean;
  /** Live collection/field data for this model's completion suggestions.
   *  Omitted entirely, the editor still works — it just falls back to the
   *  static operator/constructor suggestions `monacoMongo.ts` always offers. */
  completion?: MongoCompletionEntry;
  /** What the right-click menu says it is about: the stage, the pipeline. */
  menuHeader: MenuHeader;
  /** The menu's Format, where the caller has a formatter for this text. */
  onFormat?: () => void;
}

export function PipelineEditor({
  value,
  onChange,
  onRun,
  height,
  readOnly,
  lineNumbers = false,
  completion,
  menuHeader,
  onFormat,
}: Props) {
  const [menuEditor, attachMenuEditor] = useMenuEditor();
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);

  // `addCommand` keeps its handler for the editor's lifetime, so it reads the
  // latest callback through a ref rather than closing over the first render's
  // (the same reason `QueryEditorTab` has `runQueryRef`).
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  // Same reasoning, for the completion entry registered with Monaco: the
  // provider calls these closures for as long as the model lives, well past
  // this render.
  const completionRef = useRef(completion);
  useEffect(() => {
    completionRef.current = completion;
  }, [completion]);

  const shortcutsDisposeRef = useRef<(() => void) | null>(null);
  const completionDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      shortcutsDisposeRef.current?.();
      shortcutsDisposeRef.current = null;
      completionDisposeRef.current?.();
      completionDisposeRef.current = null;
    };
  }, []);

  function handleMount(rawEditor: unknown, monaco: Monaco) {
    attachMenuEditor(rawEditor);
    const editor = rawEditor as {
      addCommand: (keybinding: number, handler: () => void) => string | null;
      onKeyDown: (
        fn: (e: { browserEvent: KeyboardEvent }) => void,
      ) => { dispose: () => void };
      getModel: () => { uri: { toString: () => string } } | null;
    };
    ensureMongoLanguage(monaco);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current?.();
    });
    shortcutsDisposeRef.current?.();
    shortcutsDisposeRef.current = registerEditorActionRedispatch(editor, [
      {
        id: "toggleCommandPalette",
        run: () => useCommandPalette.getState().toggle(),
      },
      {
        id: "openCommandActions",
        run: () => useCommandPalette.getState().openWith(">"),
      },
      { id: "toggleTabSwitcher", run: () => useTabSwitcher.getState().toggle() },
    ]);

    const model = editor.getModel();
    if (model) {
      completionDisposeRef.current?.();
      completionDisposeRef.current = registerMongoEditor(model.uri.toString(), {
        getCollections: () => completionRef.current?.getCollections() ?? [],
        sourceCollection: () => completionRef.current?.sourceCollection() ?? "",
        getFields: (collection) => completionRef.current?.getFields(collection),
        requestFields: (collection) => completionRef.current?.requestFields(collection),
      });
    }
  }

  const handleEditorChange = useCallback(
    (v: string | undefined) => onChange(v ?? ""),
    [onChange],
  );
  const editorOptions = useEditorOptions(
    () => ({
      readOnly,
      ...editorOptionsFromPrefs(editorPrefs),
      // A stage body is small and hand-written: no minimap, two-space indent
      // regardless of the global tab size, and line numbers only when the
      // caller wants them (the text-mode editor, not the per-stage cards).
      minimap: { enabled: false },
      tabSize: 2,
      lineNumbers: (lineNumbers ? "on" : "off") as "on" | "off",
      lineDecorationsWidth: lineNumbers ? undefined : 8,
      lineNumbersMinChars: lineNumbers ? 3 : 0,
      folding: true,
      glyphMargin: false,
      renderLineHighlight: "none" as const,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8, bottom: 8 },
      scrollbar: { alwaysConsumeMouseWheel: false },
      // Monaco's default leaves `strings` off, so the suggest widget only
      // ever opens on the `"` / `$` trigger characters (`monacoMongo.ts`'s
      // `triggerCharacters`) and never again while the user keeps typing
      // inside that same string — exactly the flow of overwriting a stage
      // snippet's own placeholder (`$group`'s `_id: "$field"`, say): neither
      // character retyped there is a trigger, so the field-name safety net
      // never appeared. With it on, every keystroke inside a `"$…"` field
      // reference re-offers the live field list.
      quickSuggestions: { other: true, comments: false, strings: true },
      // A stage card sits inside `AggregationTab`'s scrollable stage list
      // (`overflow-auto`), which clips the suggest widget's default
      // absolutely-positioned popup the moment it would overflow the card —
      // exactly what happens with a long $lookup collection/field list. This
      // makes Monaco render the widget in a fixed-position overlay instead,
      // so it floats above the card and the list below it rather than being
      // cut off by either.
      fixedOverflowWidgets: true,
    }),
    [readOnly, editorPrefs, lineNumbers],
  );

  return (
    <EditorContextMenu
      // The caller's height goes on the wrapper, and the editor fills it.
      style={{ height }}
      editor={menuEditor}
      header={menuHeader}
      width="sm"
      format={onFormat && { run: onFormat }}
    >
      <Editor
        height="100%"
        language={MONGO_PIPELINE_LANGUAGE}
        // See the note in `ViewEditorTab`: this marks Monaco's focus area for
        // the window-level dispatcher.
        wrapperProps={{ "data-kb-scope": "editor" }}
        theme={monacoTheme}
        value={value}
        onChange={handleEditorChange}
        onMount={handleMount}
        options={editorOptions}
      />
    </EditorContextMenu>
  );
}
