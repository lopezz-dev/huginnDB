/**
 * Tab body for ad-hoc queries: the toolbar and a Monaco editor on top, the
 * results below, separated by a vertical resize handle (defaults to a 60/40
 * split, remembered via `autoSaveId` once dragged).
 *
 * ADR #137 splits what used to be one ~1 235-line component. This file keeps
 * the editor — its language, completion, CodeLens and shortcut wiring — and
 * composes the rest:
 *
 *  - `useQueryRun` (`lib/query/`) owns the run lifecycle: which backend path a
 *    text takes, the result panels, the history record, the timer;
 *  - `useDatabaseSelector` (`lib/query/`) owns which database the tab targets;
 *  - `QueryEditorToolbar` is its chrome; the history is a dock panel
 *    (`QueryHistoryPanel`) that runs an entry by opening it in a tab;
 *  - `results/QueryResultsArea` shows one tab per statement the run executed
 *    — rows, write or error — with a Summary first in a batch (see
 *    `results/ResultTabs` for why only one grid is ever mounted).
 *
 * Editor features:
 *  - `Ctrl+Enter` (`runQuery`) runs the selection, else the statement under
 *    the cursor; `Ctrl+Shift+Enter` (`runAll`) runs the whole buffer, batched
 *    when it holds more than one statement (ADR #137, `lib/query/runTarget`).
 *    Bound through Monaco's `onKeyDown` (not a `window` listener) because
 *    Monaco swallows the keypress inside the editor focus area — gotcha #9.
 *  - A CodeLens "▶ Run" appears on the first line of every `;`-delimited
 *    statement and runs just that fragment.
 *  - Autocomplete blends tables, columns and SQL keywords (driver-aware);
 *    see `lib/sql/sqlCompletions.ts`.
 *
 * **MongoDB is not SQL here.** A Mongo connection gets its own language
 * (`lib/monaco/monacoMongoQuery.ts`), its own structural completion and its
 * own splitter dialect. Everything else on this screen — the run paths, the
 * history, the results — is shared, because none of it is dialectal.
 *
 * An info bar at the bottom of the editor panel mirrors VS Code's status bar:
 * the run shortcut, the database, the caret's Ln/Col, the statement count and
 * the driver.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useConnections } from "@/stores/session/connections";
import {
  tableKey,
  useEnsureSchemaLoaded,
  useSchema,
} from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { usePendingRuns } from "@/stores/query/pendingRuns";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { useMonacoTheme } from "@/lib/monaco/useMonacoTheme";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";
import { useShortcutLabel } from "@/lib/keybindings/useShortcutLabel";
import { registerEditorActionRedispatch } from "@/lib/monaco/monacoKeybindings";
import { runAiTask } from "@/lib/ai/runTask";
import { splitSql, type SqlDialect } from "@/lib/sql/sqlSplit";
import { notify } from "@/lib/notify";
import { formatSql, sqlDialectFor } from "@/lib/sql/formatSql";
import { useAiReachable } from "@/lib/ai/useAiReachable";
import { runTarget, type EditorSnapshot, type RunScope } from "@/lib/query/runTarget";
import type { LineRange } from "@/lib/query/statementTabs";
import { SaveQueryDialog } from "@/components/query/dialogs/SaveQueryDialog";
import { QueryEditorToolbar } from "@/components/query/QueryEditorToolbar";
import { QueryResultsArea } from "@/components/query/results/QueryResultsArea";
import { EditorContextMenu } from "@/components/menus/EditorContextMenu";
import { driverLabel } from "@/components/common/DriverBadge";
import type { CommandEditor } from "@/lib/monaco/editorCommands";
import { parentConnectionId, sqliteFileLabel } from "@/lib/connectionLabel";
import { keywordsFor } from "@/lib/sql/sqlKeywords";
import { buildCompletions } from "@/lib/sql/sqlCompletions";
import { supportsMultipleDatabases } from "@/lib/db/driver";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { useDatabaseSelector } from "@/lib/query/useDatabaseSelector";
import { useQueryRun, type QueryTimerHandle } from "@/lib/query/useQueryRun";
import {
  ensureSqlProviders,
  registerSqlEditor,
  fireSqlLensChange,
} from "@/lib/monaco/monacoSql";
import {
  MONGO_QUERY_LANGUAGE,
  ensureMongoQueryProviders,
  registerMongoQueryEditor,
  type MongoQueryEntry,
} from "@/lib/monaco/monacoMongoQuery";

interface Props {
  tabId: string;
  connectionId: string;
}

/** The editor menu's Command palette entry: the app's palette, not Monaco's. */
const toggleCommandPalette = () => useCommandPalette.getState().toggle();

export function QueryEditorTab({ tabId, connectionId }: Props) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const updateQuery = useTabs((s) => s.updateQuery);
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);
  // Stable array; filter is derived in component body with useMemo (not in the selector).
  const profiles = useConnections((s) => s.profiles);
  const sql = tab?.query ?? "";

  /** Driver for the tab's parent connection — drives the keyword overlay,
   *  the splitter dialect and whether the database selector is shown. */
  const parentIdForDriver = useMemo(
    () => parentConnectionId(connectionId),
    [connectionId],
  );
  const driver = useConnections(
    (s) => s.profiles.find((p) => p.id === parentIdForDriver)?.driver,
  );

  /** MongoDB gets its own editor language, its own completion provider and
   *  its own splitter dialect. */
  const isMongo = driver === "mongodb";
  const dialect: SqlDialect = isMongo ? "mongo" : "sql";

  /**
   * Wall-clock run timer, isolated behind a ref on purpose: `QueryTimer`
   * owns its ticking state, and `useQueryRun` drives it through this handle
   * without re-rendering the tab (Monaco included) every 50 ms.
   */
  const queryTimerRef = useRef<QueryTimerHandle>(null);

  // A failed switch is not the query's error, so it is a notification and
  // never lands among the run's tabs (ADR #137).
  const onSelectorError = useCallback(
    (message: string) =>
      notify.error(t("query.switchDatabaseFailed"), { description: message }),
    [t],
  );
  const { parentId, effectiveId, selectedDb, databases, switchDatabase } =
    useDatabaseSelector(connectionId, driver, onSelectorError);

  const run = useQueryRun({
    connectionId: effectiveId,
    historyConnectionId: parentId,
    dialect,
    timer: queryTimerRef,
  });

  // The tab's own autocomplete needs the catalogue, and this is the one
  // surface that never asked for it: suggestions used to appear only once the
  // user had expanded the connection in the explorer. It matters most on
  // MongoDB, where a freshly opened tab would otherwise know neither the
  // collections nor their fields, but SQL tabs get the same warm start.
  useEnsureSchemaLoaded(effectiveId);
  const schemaState = useSchema((s) => s.byConnection[effectiveId]);
  const loadColumns = useSchema((s) => s.loadColumns);

  /** Short display name for the connected database shown in the info bar. */
  const dbName = useMemo(() => {
    const p = profiles.find((pr) => pr.id === parentId);
    if (!p) return parentId;
    if (p.driver === "sqlite") return sqliteFileLabel(p.database);
    return selectedDb || p.database || t("query.defaultDatabase");
  }, [profiles, parentId, selectedDb, t]);

  // The user's current binding for `runQuery` (`handleMount` dispatches the
  // same combo), for the Run button's chip and the info bar; `undefined`
  // when the action is unbound.
  const runShortcut = useShortcutLabel("runQuery");
  const stopShortcut = useShortcutLabel("stopQuery");
  // The history is a dock panel beside Saved (ADR #137); the toolbar's
  // History button shows and hides it.
  const historyOpen = useSessionPanelLayout((s) => s.rightPanel === "history");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  /** The caret's position, updated live by Monaco, for the info bar. */
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  // Typed loosely to avoid importing the heavy monaco-editor types at compile
  // time. The subset we need is stable across Monaco versions.
  const editorRef = useRef<{
    getModel: () => {
      getLineCount: () => number;
      getValueLength: () => number;
      getValue: () => string;
      getValueInRange: (range: unknown) => string;
      getLineMaxColumn: (line: number) => number;
      getFullModelRange: () => unknown;
      uri: { toString: () => string };
    } | null;
    getSelection: () => { isEmpty: () => boolean; startLineNumber: number } | null;
    setSelection: (range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }) => void;
    revealLinesInCenter: (start: number, end: number) => void;
    focus: () => void;
    getPosition: () => { lineNumber: number } | null;
    onDidChangeModelContent: (fn: () => void) => { dispose: () => void };
    onDidChangeCursorSelection?: (fn: () => void) => { dispose: () => void };
    onDidChangeCursorPosition?: (
      fn: (e: { position: { lineNumber: number; column: number } }) => void,
    ) => { dispose: () => void };
    executeEdits: (
      source: string,
      edits: { range: unknown; text: string }[],
    ) => boolean;
    pushUndoStop: () => boolean;
    addCommand: (keybinding: number, handler: () => void) => string | null;
    onKeyDown: (fn: (e: { browserEvent: KeyboardEvent }) => void) => {
      dispose: () => void;
    };
  } | null>(null);

  /** Disposer returned by `registerSqlEditor`; removes this editor's entry
   *  from the shared provider registry on unmount. */
  const sqlEditorDisposeRef = useRef<(() => void) | null>(null);
  /** Same, for the MongoDB shell provider's own registry. Two registries
   *  rather than one because they answer different questions about the same
   *  model: `monacoSql`'s holds the lenses and the run handler (shared by
   *  every language that gets a "▶ Run"), this one the structural
   *  collection/field data only the Mongo provider reads. */
  const mongoEditorDisposeRef = useRef<(() => void) | null>(null);
  /** Disposer for the customizable-shortcuts redispatch registered in
   *  `handleMount` (see `registerEditorActionRedispatch`). */
  const editorShortcutsDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = null;
      mongoEditorDisposeRef.current?.();
      mongoEditorDisposeRef.current = null;
      editorShortcutsDisposeRef.current?.();
      editorShortcutsDisposeRef.current = null;
    };
  }, []);

  /** Parsed statements of the current buffer. Drives the per-statement
   *  CodeLens and the "Run all (N)" label. */
  const statements = useMemo(() => splitSql(sql, dialect), [sql, dialect]);

  /**
   * Pre-built suggestion list. Recomputes when the schema cache changes
   * for this connection or when the driver flips (keyword overlay).
   * Empty schemas still produce keyword suggestions so the autocomplete
   * is useful before the user expands the explorer.
   */
  const completionSuggestions = useMemo(() => {
    return buildCompletions({
      tables: schemaState?.tables ?? [],
      columns: schemaState?.columns ?? {},
      keywords: keywordsFor(driver),
    });
  }, [schemaState, driver]);

  // ---------------------------------------------------------------------
  // Live completion data for the MongoDB shell provider
  //
  // Nothing here is a new fetch path, and it is the same trio the aggregation
  // editor already uses: `tables` (collections) comes from the eager
  // `useEnsureSchemaLoaded` above, and `columns` (first-level field names,
  // `infer_columns`'s 100-document sample) is the same lazy, session-cached
  // slice the explorer populates on expand. A collection is sampled at most
  // once per session (ADR #57) — `useSchema` tracks no in-flight state of
  // its own, so `pendingFieldsRef` is what stops one `loadColumns` per
  // keystroke while the first is still in the air.
  // ---------------------------------------------------------------------

  const collections = useMemo(
    () => schemaState?.tables.map((tbl) => tbl.name) ?? [],
    [schemaState],
  );

  const pendingFieldsRef = useRef<Set<string>>(new Set());

  const requestFields = useCallback(
    (name: string) => {
      const key = tableKey(undefined, name);
      if (schemaState?.columns[key] || schemaState?.columnErrors[key]) return;
      if (pendingFieldsRef.current.has(name)) return;
      pendingFieldsRef.current.add(name);
      void loadColumns(effectiveId, undefined, name).finally(() => {
        pendingFieldsRef.current.delete(name);
      });
    },
    [effectiveId, loadColumns, schemaState],
  );

  const getFields = useCallback(
    (name: string): string[] | undefined =>
      schemaState?.columns[tableKey(undefined, name)]?.map((c) => c.name),
    [schemaState],
  );

  /** Live handle the (global, per-language) Mongo provider reads through —
   *  refs for the same reason `completionsRef` exists below. */
  const mongoCompletionRef = useRef<MongoQueryEntry>({
    getCollections: () => [],
    getFields: () => undefined,
    requestFields: () => {},
  });
  useEffect(() => {
    mongoCompletionRef.current = {
      getCollections: () => collections,
      getFields,
      requestFields,
    };
  }, [collections, getFields, requestFields]);

  /**
   * Refs to the live run callbacks. Monaco runs its handlers in long-lived
   * closures registered exactly once inside `handleMount`; capturing the
   * callbacks there directly would freeze them to the first render's values
   * (stale `sql`, stale target). Bouncing through refs keeps one
   * registration while still hitting the live callback.
   */
  const runQueryRef = useRef(run.runSingle);
  useEffect(() => {
    runQueryRef.current = run.runSingle;
  }, [run.runSingle]);
  /** Run what `scope` names in the editor right now (ADR #137): the
   *  selection, else the statement under the caret, for `runQuery` and the
   *  Run button; the whole buffer for `runAll`. */
  const runAt = useCallback(
    (scope: RunScope) => {
      const editor = editorRef.current;
      const snap: EditorSnapshot = editor
        ? snapshotOf(editor, dialect)
        : { source: sql, selection: null, line: 1, dialect };
      const target = runTarget(snap, scope);
      if (target === null) {
        // A caret between two statements names nothing; running the whole
        // buffer instead would be exactly the surprise this rule removes.
        if (scope === "cursor" || scope === "statement") {
          notify.info(t("query.nothingAtCursor"), {
            description: t("query.nothingAtCursorHint"),
          });
        }
        return;
      }
      void run.run(target.text, target.firstLine);
    },
    [dialect, sql, run.run, t],
  );
  const runAtRef = useRef(runAt);
  useEffect(() => {
    runAtRef.current = runAt;
  }, [runAt]);
  const [hasSelection, setHasSelection] = useState(false);
  /** The mounted editor, for the context menu (`EditorContextMenu`); `null`
   *  until `onMount`. State rather than a ref because the menu wrapper needs
   *  to know when it can open. */
  const [menuEditor, setMenuEditor] = useState<CommandEditor | null>(null);

  // A tab opened with `openQueryTab(…, { run: true })` (the history panel's
  // Run) runs its whole buffer once, through this tab's own runner — so a
  // batch goes down the batch path. It waits for the driver: the splitter's
  // dialect depends on it, and a MongoDB batch split as SQL would be one
  // statement.
  const runRef = useRef(run.run);
  useEffect(() => {
    runRef.current = run.run;
  }, [run.run]);
  /** `stopQuery`'s handler reads these at key time, like the others. */
  const stopRef = useRef({ running: run.running, stop: run.stop });
  useEffect(() => {
    stopRef.current = { running: run.running, stop: run.stop };
  }, [run.running, run.stop]);
  useEffect(() => {
    if (driver === undefined) return;
    if (!usePendingRuns.getState().take(tabId)) return;
    const text = useTabs.getState().tabs.find((x) => x.id === tabId)?.query ?? "";
    if (text.trim()) void runRef.current(text, 1);
  }, [driver, tabId]);

  /** Format the selection, else the whole buffer, as one undoable edit.
   *  SQL only (ADR #136): `undefined` on MongoDB, so neither the toolbar nor
   *  the shortcut offers it there. */
  const format = useMemo(
    () =>
      isMongo
        ? undefined
        : () => {
            const editor = editorRef.current;
            const model = editor?.getModel();
            if (!editor || !model) return;
            const selection = editor.getSelection();
            const range =
              selection && !selection.isEmpty() ? selection : model.getFullModelRange();
            const text = model.getValueInRange(range);
            const formatted = formatSql(text, sqlDialectFor(driver));
            if (formatted === text) return;
            editor.pushUndoStop();
            editor.executeEdits("huginndb.formatQuery", [{ range, text: formatted }]);
            editor.pushUndoStop();
          },
    [isMongo, driver],
  );
  const formatRef = useRef(format);
  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  /** Ask the AI about the selection, else the statement under the caret —
   *  for the toolbar's Explain and the editor menu's two questions. Offered
   *  only where the AI is on for this connection (ADR #136): `undefined`
   *  otherwise, so neither surface shows it. The menu reads it each time it
   *  opens, so its entries follow the AI with no effect to add or remove
   *  them. */
  const aiReachable = useAiReachable(connectionId);
  const askAi = useMemo(
    () =>
      aiReachable
        ? (task: "explainQuery" | "explainSlow") => {
            const editor = editorRef.current;
            if (!editor) return;
            const target = runTarget(snapshotOf(editor, dialect), "cursor");
            if (!target) {
              notify.info(t("query.nothingAtCursor"), {
                description: t("query.nothingAtCursorHint"),
              });
              return;
            }
            void runAiTask({ task, connection: connectionId, statement: target.text });
          }
        : undefined,
    [aiReachable, dialect, connectionId, t],
  );
  const explain = useMemo(() => askAi && (() => askAi("explainQuery")), [askAi]);

  /**
   * Ref to the live completion list for the same reason as `runQueryRef`:
   * `registerCompletionItemProvider` keeps the handler closure for the
   * lifetime of the editor and we want it to see the freshest
   * suggestions every time the user opens the popup.
   */
  const completionsRef = useRef(completionSuggestions);
  useEffect(() => {
    completionsRef.current = completionSuggestions;
  }, [completionSuggestions]);

  /**
   * Live CodeLens cache. We re-parse the SQL whenever the buffer changes and
   * fire the shared lens emitter so Monaco refreshes the gutter. The (single,
   * app-wide) provider reads this editor's lenses from the registry, so we
   * only have to keep the cache fresh and ping the emitter.
   */
  const lensesRef = useRef<ReturnType<typeof splitSql>>([]);

  // Keep the CodeLens cache in sync with the buffer (reusing the already-parsed
  // `statements` memo). The provider reads this ref, so we only have to
  // refresh it and ping the shared emitter on each edit.
  useEffect(() => {
    lensesRef.current = statements;
    fireSqlLensChange();
  }, [statements]);

  function handleMount(_editor: unknown, monaco: Monaco) {
    const editor = _editor as typeof editorRef.current;
    editorRef.current = editor;

    const model = editor?.getModel();

    // Ln, Col in the info bar, kept in sync with the caret.
    editor?.onDidChangeCursorPosition?.((e) =>
      setCursor({ line: e.position.lineNumber, column: e.position.column }),
    );

    // The ▾ menu's "Run the selection" is offered only with one.
    editor?.onDidChangeCursorSelection?.(() => {
      setHasSelection(editor.getSelection()?.isEmpty() === false);
    });

    // runQuery / toggleCommandPalette / toggleTabSwitcher are all
    // user-rebindable (issue #75), so they can't use Monaco's `addCommand`
    // (a fixed keybinding bitmask resolved once, with no way to re-check a
    // live combo) — `registerEditorActionRedispatch` uses `onKeyDown`
    // instead, reading the current binding from the store on every
    // keystroke. Monaco swallows all three inside its focus area otherwise,
    // which is why they need an editor-scoped listener at all (gotcha #9).
    if (editor) {
      editorShortcutsDisposeRef.current?.();
      editorShortcutsDisposeRef.current = registerEditorActionRedispatch(
        editor,
        [
          { id: "runQuery", run: () => runAtRef.current("cursor") },
          { id: "runAll", run: () => runAtRef.current("all") },
          // Declines with nothing running, so the key falls through to Monaco.
          {
            id: "stopQuery",
            run: () => {
              if (!stopRef.current.running) return false;
              stopRef.current.stop();
            },
          },
          // Declines on MongoDB, so the key falls through to Monaco.
          {
            id: "formatQuery",
            run: () => {
              if (!formatRef.current) return false;
              formatRef.current();
            },
          },
          {
            id: "toggleCommandPalette",
            run: () => useCommandPalette.getState().toggle(),
          },
          {
            id: "openCommandActions",
            run: () => useCommandPalette.getState().openWith(">"),
          },
          {
            id: "toggleTabSwitcher",
            run: () => useTabSwitcher.getState().toggle(),
          },
        ],
      );
    }

    // The SQL completion + per-statement "▶ Run" CodeLens providers are
    // GLOBAL to the language, so they're installed exactly once for the
    // Monaco instance and dispatch per model. We just register this editor's
    // live data (read through the existing refs) and keep the disposer for
    // unmount — registering the providers per editor is what produced the
    // duplicate "▶ Run" lenses when several query tabs were open.
    setMenuEditor(_editor as CommandEditor);

    // Both language families are installed unconditionally. They are global
    // per Monaco instance and idempotent, so the cost is one registration
    // apiece for the whole app — and doing it here rather than behind a
    // `driver === "mongodb"` branch sidesteps the ordering problem that
    // branch would create: `driver` is read from the profile list, which can
    // still be empty on the render that mounts the editor, and `onMount`
    // never runs a second time.
    ensureSqlProviders(monaco);
    ensureMongoQueryProviders(monaco);
    const uri = model?.uri.toString();
    if (uri) {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = registerSqlEditor(uri, {
        getCompletions: () => completionsRef.current,
        getLenses: () => lensesRef.current,
        // The lens hands over its text only; its statement is in the lens
        // cache, which is where *Go to statement* finds its line.
        runStatement: (text) =>
          void runQueryRef.current(
            text,
            lensesRef.current.find((st) => st.text === text)?.startLine ?? null,
          ),
      });
      // The Mongo provider only ever sees models whose language is
      // `mongodb-query`, so registering this for a SQL tab costs a map entry
      // and is never read.
      mongoEditorDisposeRef.current?.();
      mongoEditorDisposeRef.current = registerMongoQueryEditor(uri, {
        getCollections: () => mongoCompletionRef.current.getCollections(),
        getFields: (name) => mongoCompletionRef.current.getFields(name),
        requestFields: (name) => mongoCompletionRef.current.requestFields(name),
      });
    }
  }

  /** *Go to statement*: select its lines in the editor and bring it into
   *  view. The range is the one recorded at run time; edits since then can
   *  shift it, which is the editor's own behaviour for any stale range. */
  const goTo = useCallback((lines: LineRange) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const end = Math.min(lines.end, model.getLineCount());
    editor.setSelection({
      startLineNumber: lines.start,
      startColumn: 1,
      endLineNumber: end,
      endColumn: model.getLineMaxColumn(end),
    });
    editor.revealLinesInCenter(lines.start, end);
    editor.focus();
  }, []);

  const handleEditorChange = useCallback(
    (v: string | undefined) => updateQuery(tabId, v ?? ""),
    [tabId, updateQuery],
  );
  const editorOptions = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      formatOnPaste: editorPrefs.formatOnPaste,
      // HuginnDB's menu replaces Monaco's (`EditorContextMenu`).
      contextmenu: false,
    }),
    [editorPrefs],
  );

  return (
    <PanelGroup
      direction="vertical"
      className="h-full"
      autoSaveId="query-editor-split-v2"
    >
      {/* Editor panel. Defaults to a 60/40 editor:results split (ADR #137):
          the results now hold a tab per statement and the cards that explain
          a write or a failure, which a quarter of the height could not show.
          The handle is draggable and `autoSaveId` remembers wherever the user
          leaves it, across every query tab — under a new key, so the old 75/25
          a person never dragged does not pin the new default. */}
      <Panel defaultSize={60} minSize={20}>
        <div className="flex h-full flex-col">
          <QueryEditorToolbar
            ref={queryTimerRef}
            statementCount={statements.length}
            hasSelection={hasSelection}
            empty={!sql.trim()}
            running={run.running}
            runShortcut={runShortcut}
            onRun={runAt}
            onStop={run.stop}
            stopShortcut={stopShortcut}
            onFormat={format}
            onExplain={explain}
            onSave={() => setSaveDialogOpen(true)}
            historyOpen={historyOpen}
            onToggleHistory={() =>
              useSessionPanelLayout.getState().selectRightPanel("history")
            }
            databases={
              supportsMultipleDatabases(driver)
                ? { databases, selectedDb, switchDatabase }
                : null
            }
          />

          {/* Monaco */}
          <div className="flex flex-1 overflow-hidden">
            {/* Monaco redispatches `editor`-scoped bindings itself (gotcha #9);
                the attribute is what tells the window listener that focus in
                here is *not* in the grid or the tree. The right-click menu is
                HuginnDB's (`contextmenu: false` in the options below); it
                offers no Run entries — running is the toolbar's, the keys'
                and each statement's ▶ Run. */}
            <EditorContextMenu
              className="flex-1"
              data-kb-scope="editor"
              editor={menuEditor}
              header={{
                title: tab?.title ?? "",
                tags: [driver && driverLabel(driver)],
              }}
              width="md"
              format={format && { run: format, shortcut: { action: "formatQuery" } }}
              ai={
                askAi && {
                  explainQuery: () => askAi("explainQuery"),
                  explainSlow: () => askAi("explainSlow"),
                }
              }
              commandPalette={toggleCommandPalette}
            >
              <Editor
                height="100%"
                // `@monaco-editor/react` resolves a changed `language` with
                // `setModelLanguage` on the *same* model, so the URI — and
                // with it both registry entries above — survives the switch.
                language={isMongo ? MONGO_QUERY_LANGUAGE : "sql"}
                // `theme.mode` (app theme) used to be the only signal;
                // now Editor prefs own the Monaco theme so users can pick One
                // Dark Pro / GitHub / Monokai / Solarized — or an imported VS
                // Code theme — independently of the app chrome. See
                // `useMonacoTheme` for why the id is resolved reactively.
                theme={monacoTheme}
                value={sql}
                onChange={handleEditorChange}
                onMount={handleMount}
                options={editorOptions}
              />
            </EditorContextMenu>
          </div>

          {/* Editor info bar (ADR #137): run shortcut · database · Ln, Col ·
              statements · driver. The shortcut is the user's binding for
              `runQuery`, read from the catalogue, and left out when the
              action is unbound.

              One line at any width: in a narrow pane the readouts used to
              wrap word by word ("Ln 13, Col 5" on four lines) and the bar
              grew. Now nothing wraps, the database name is the one part that
              gives way (with an ellipsis), and whatever still does not fit
              is clipped at the right edge. */}
          <div className="flex items-center gap-0 overflow-hidden whitespace-nowrap border-t border-border bg-card px-3 py-1 text-2xs text-muted-foreground">
            {runShortcut && (
              <>
                <span className="flex shrink-0 items-center gap-1">
                  <kbd className="rounded-sm bg-muted px-1 font-mono text-3xs">
                    {runShortcut}
                  </kbd>
                  <span className="ml-1 text-muted-foreground/70">
                    {t("query.run")}
                  </span>
                </span>
                <InfoSep />
              </>
            )}
            <span className="min-w-0 truncate">{dbName}</span>
            <InfoSep />
            <span className="shrink-0 tabular-nums">
              {t("query.cursorPosition", { line: cursor.line, column: cursor.column })}
            </span>
            <InfoSep />
            <span className="shrink-0">
              {t("query.statementCount", { count: statements.length })}
            </span>
            <InfoSep />
            <span className="shrink-0">{driver ?? ""}</span>
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />

      <Panel defaultSize={40} minSize={10}>
        <QueryResultsArea
          tabs={run.tabs}
          active={run.active}
          resultsOn={run.resultsOn}
          selectTab={run.selectTab}
          refreshActive={run.refreshActive}
          tabId={tabId}
          driver={driver}
          onGoTo={goTo}
        />
      </Panel>

      <SaveQueryDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        sql={sql}
        connectionId={parentId}
      />
    </PanelGroup>
  );
}

/** What `runTarget` needs from a Monaco editor, read at the moment of the
 *  gesture. Typed structurally for the same reason `editorRef` is. */
function snapshotOf(
  editor: {
    getModel: () => {
      getValue: () => string;
      getValueInRange: (range: unknown) => string;
    } | null;
    getSelection: () => { isEmpty: () => boolean; startLineNumber: number } | null;
    getPosition: () => { lineNumber: number } | null;
  },
  dialect: SqlDialect,
): EditorSnapshot {
  const model = editor.getModel();
  const selection = editor.getSelection();
  return {
    source: model?.getValue() ?? "",
    selection:
      model && selection && !selection.isEmpty()
        ? {
            text: model.getValueInRange(selection),
            startLine: selection.startLineNumber,
          }
        : null,
    line: editor.getPosition()?.lineNumber ?? 1,
    dialect,
  };
}

/** The info bar's separator; never shrinks, so the readouts stay apart. */
function InfoSep() {
  return <span className="mx-3 shrink-0 text-muted-foreground/30">|</span>;
}
