/**
 * Tab body for ad-hoc queries: the toolbar and a Monaco editor on top, the
 * results below, separated by a vertical resize handle (defaults to a 75/25
 * split, remembered via `autoSaveId` once dragged).
 *
 * ADR #137 splits what used to be one ~1 235-line component. This file keeps
 * the editor — its language, completion, CodeLens and shortcut wiring — and
 * composes the rest:
 *
 *  - `useQueryRun` (`lib/query/`) owns the run lifecycle: which backend path a
 *    text takes, the result panels, the history record, the timer;
 *  - `useDatabaseSelector` (`lib/query/`) owns which database the tab targets;
 *  - `QueryEditorToolbar` and `QueryHistorySidebar` are its chrome;
 *  - `results/QueryResultsArea` shows one panel per result set (see
 *    `results/ResultTabs` for why only one grid is ever mounted).
 *
 * Editor features:
 *  - `Ctrl+Enter` runs the entire buffer. Bound through Monaco's `onKeyDown`
 *    (not a `window` listener) because Monaco swallows the keypress inside
 *    the editor focus area — see gotcha #9.
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
 * the run shortcut, the database, line/character counts and the language.
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
import { splitSql, statementAt, type SqlDialect } from "@/lib/sql/sqlSplit";
import i18n from "@/lib/i18n";
import { SaveQueryDialog } from "@/components/query/dialogs/SaveQueryDialog";
import { QueryEditorToolbar } from "@/components/query/QueryEditorToolbar";
import { QueryHistorySidebar } from "@/components/query/QueryHistorySidebar";
import { QueryResultsArea } from "@/components/query/results/QueryResultsArea";
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
  /** `handleMount` registers its editor actions once, in a closure that
   *  outlives every re-render — same long-lived-closure reason as
   *  `runQueryRef` below. */
  const dialectRef = useRef(dialect);
  useEffect(() => {
    dialectRef.current = dialect;
  }, [dialect]);

  /**
   * Wall-clock run timer, isolated behind a ref on purpose: `QueryTimer`
   * owns its ticking state, and `useQueryRun` drives it through this handle
   * without re-rendering the tab (Monaco included) every 50 ms.
   */
  const queryTimerRef = useRef<QueryTimerHandle>(null);

  // `useDatabaseSelector` reports a failed switch into the results area, and
  // that area belongs to the run; the ref breaks the hook-order cycle.
  const reportErrorRef = useRef<(message: string) => void>(() => {});
  const onSelectorError = useCallback(
    (message: string) => reportErrorRef.current(message),
    [],
  );
  const { parentId, effectiveId, selectedDb, databases, switchDatabase } =
    useDatabaseSelector(connectionId, driver, onSelectorError);

  const run = useQueryRun({
    connectionId: effectiveId,
    historyConnectionId: parentId,
    dialect,
    timer: queryTimerRef,
  });
  reportErrorRef.current = run.reportError;

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
  const [showHistory, setShowHistory] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  /** Line and character counts updated live by Monaco. */
  const [editorStats, setEditorStats] = useState({ lines: 1, chars: 0 });

  // Typed loosely to avoid importing the heavy monaco-editor types at compile
  // time. The subset we need is stable across Monaco versions.
  const editorRef = useRef<{
    getModel: () => {
      getLineCount: () => number;
      getValueLength: () => number;
      getValue: () => string;
      uri: { toString: () => string };
    } | null;
    onDidChangeModelContent: (fn: () => void) => { dispose: () => void };
    addCommand: (keybinding: number, handler: () => void) => string | null;
    onKeyDown: (fn: (e: { browserEvent: KeyboardEvent }) => void) => {
      dispose: () => void;
    };
    /** Editor-scoped, unlike the language providers — see `handleMount`. */
    addAction: (action: {
      id: string;
      label: string;
      contextMenuGroupId?: string;
      contextMenuOrder?: number;
      run: (editor: {
        getModel: () => { getValue: () => string; getValueInRange: (range: unknown) => string } | null;
        getSelection: () => { isEmpty: () => boolean } | null;
        getPosition: () => { lineNumber: number } | null;
      }) => void;
    }) => { dispose: () => void };
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
  const runDefaultRef = useRef<() => void>(() => {});
  useEffect(() => {
    runDefaultRef.current = () => void run.run(sql);
  }, [run.run, sql]);

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

    // Seed initial stats.
    const model = editor?.getModel();
    if (model) {
      setEditorStats({
        lines: model.getLineCount(),
        chars: model.getValueLength(),
      });
    }

    // Keep stats in sync as the user types.
    editor?.onDidChangeModelContent(() => {
      const m = editor.getModel();
      if (m)
        setEditorStats({ lines: m.getLineCount(), chars: m.getValueLength() });
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
          { id: "runQuery", run: () => runDefaultRef.current() },
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
    // Two assisted-mode entries in the editor's own right-click menu. Added
    // per *editor instance*, which looks like gotcha #9's shape and is not:
    // `addAction` is scoped to this editor, unlike the language providers
    // below, so N tabs give N menus rather than one menu with N duplicates.
    //
    // The label is resolved once at mount. A language switch mid-session
    // leaves it stale until the tab is reopened — the same limitation every
    // Monaco action has, and not worth a re-mount to fix.
    for (const entry of [
      { task: "explainQuery" as const, key: "ai.task.explainQuery", order: 1.5 },
      { task: "explainSlow" as const, key: "ai.task.explainSlow", order: 1.6 },
    ]) {
      editor?.addAction({
        id: `huginndb.ai.${entry.task}`,
        label: i18n.t(entry.key),
        contextMenuGroupId: "huginndb",
        contextMenuOrder: entry.order,
        run: (ed) => {
          const current = ed.getModel();
          if (!current) return;
          // The selection when there is one, else the statement the caret is
          // in: highlighting three lines of a long query and asking about them
          // is a real gesture, and honouring it costs one branch.
          const selection = ed.getSelection();
          const selected =
            selection && !selection.isEmpty()
              ? current.getValueInRange(selection)
              : null;
          const statement =
            selected ??
            statementAt(
              current.getValue(),
              ed.getPosition()?.lineNumber ?? 1,
              dialectRef.current,
            )?.text;
          if (!statement?.trim()) return;
          void runAiTask({
            task: entry.task,
            connection: connectionId,
            statement,
          });
        },
      });
    }

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
        runStatement: (text) => void runQueryRef.current(text),
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

  const handleEditorChange = useCallback(
    (v: string | undefined) => updateQuery(tabId, v ?? ""),
    [tabId, updateQuery],
  );
  const editorOptions = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      formatOnPaste: editorPrefs.formatOnPaste,
    }),
    [editorPrefs],
  );

  return (
    <PanelGroup
      direction="vertical"
      className="h-full"
      autoSaveId="query-editor-split"
    >
      {/* Editor panel. Defaults to a 75/25 editor:results split — writing SQL
          is the bulk of the work here, results are a glance — but the handle
          below is fully draggable and `autoSaveId` remembers wherever the
          user leaves it, across every query tab. */}
      <Panel defaultSize={75} minSize={20}>
        <div className="flex h-full flex-col">
          <QueryEditorToolbar
            ref={queryTimerRef}
            statementCount={statements.length}
            empty={!sql.trim()}
            running={run.running}
            runShortcut={runShortcut}
            onRun={() => void run.run(sql)}
            onSave={() => setSaveDialogOpen(true)}
            historyOpen={showHistory}
            onToggleHistory={() => setShowHistory((v) => !v)}
            databases={
              supportsMultipleDatabases(driver)
                ? { databases, selectedDb, switchDatabase }
                : null
            }
          />

          {/* Monaco + optional history sidebar */}
          <div className="flex flex-1 overflow-hidden">
            {/* Monaco redispatches `editor`-scoped bindings itself (gotcha #9);
                the attribute is what tells the window listener that focus in
                here is *not* in the grid or the tree. */}
            <div className="flex-1" data-kb-scope="editor">
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
            </div>
            {showHistory && (
              <QueryHistorySidebar
                connectionId={parentId}
                onLoad={(text) => updateQuery(tabId, text)}
                onRun={(text) => void run.runSingle(text)}
              />
            )}
          </div>

          {/* Editor info bar: run shortcut · db name · line/char count · language.
              The shortcut is the user's binding for `runQuery`, read from the
              catalogue — it used to say Ctrl + Enter whatever it was bound
              to — and the hint is left out when the action is unbound. */}
          <div className="flex items-center gap-0 border-t border-border bg-card px-3 py-1 text-2xs text-muted-foreground">
            {runShortcut && (
              <>
                <span className="flex items-center gap-1">
                  <kbd className="rounded-sm bg-muted px-1 font-mono text-3xs">
                    {runShortcut}
                  </kbd>
                  <span className="ml-1 text-muted-foreground/70">
                    {t("query.run")}
                  </span>
                </span>
                <span className="mx-3 text-muted-foreground/30">|</span>
              </>
            )}
            <span className="truncate">{dbName}</span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>
              {t("query.lines", { count: editorStats.lines })}
              {" · "}
              {t("query.chars", { count: editorStats.chars })}
            </span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>{driver === "mongodb" ? "mongodb" : "sql"} · utf-8</span>
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />

      <Panel defaultSize={25} minSize={10}>
        <QueryResultsArea
          panels={run.panels}
          active={run.active}
          resultsOn={run.resultsOn}
          batchSummary={run.batchSummary}
          error={run.error}
          selectPanel={run.selectPanel}
          refreshActive={run.refreshActive}
          tabId={tabId}
          driver={driver}
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
