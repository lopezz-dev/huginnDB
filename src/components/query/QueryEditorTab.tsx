/**
 * Tab body for ad-hoc queries. Hosts a Monaco editor on top and the results
 * area below, separated by a vertical resize handle (defaults to a 75/25
 * split, remembered via `autoSaveId` once dragged).
 *
 * The results area holds **one panel per result set**, not one grid. A script
 * of several SELECTs used to show only the last: the backend built a full
 * `QueryResult` for each and `last_result` overwrote the previous one. Each
 * statement now carries its own, and a `Segmented` strip picks which is on
 * screen — one grid mounted at a time, which is what keeps `tabId` a usable
 * key for `gridSelection` and the docked cell editor. Statements that return
 * nothing (writes, and the one that failed) appear in the summary line above
 * rather than as empty panels.
 *
 * Editor features:
 *  - `Ctrl+Enter` runs the entire buffer. Bound through Monaco's command
 *    system (not a `window` listener) because Monaco swallows the
 *    keypress inside the editor focus area — see gotcha #9.
 *  - A CodeLens "▶ Run" appears on the first line of every `;`-delimited
 *    statement and runs just that fragment. Useful when the editor
 *    holds a scratch pad of multiple queries.
 *  - Autocomplete blends tables, columns and SQL keywords (the latter
 *    driver-aware: `RETURNING` on Postgres, `ON DUPLICATE KEY` on
 *    MySQL, etc.). Suggestions are ranked tables → columns → keywords
 *    via `sortText` prefixes; see `lib/sqlCompletions.ts`.
 *
 * **MongoDB is not SQL here.** The tab used to hand a Mongo connection the
 * `"sql"` language literally — SQL grammar, `--` comments, a flat word list
 * with no trigger characters — so `db.` offered nothing. A Mongo connection
 * now gets its own language (`lib/monaco/monacoMongoQuery.ts`), its own
 * structural completion (collections → methods → cursor modifiers → fields
 * and operators) and its own splitter dialect (`//` comments, no `$`
 * dollar-quoting). Everything else on this screen — the run paths, the
 * history, the results panel — is shared, because none of it is dialectal.
 *
 * An info bar at the bottom of the editor panel mirrors VS Code's status
 * bar style, showing the keyboard shortcut hint, connected database name,
 * current line/character count, and encoding.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import Editor, { type Monaco } from "@monaco-editor/react";
import {
  Bookmark,
  Check,
  Clock,
  Database,
  History,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/tauri";
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
import { useQueryHistory } from "@/stores/query/queryHistory";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";
import { formatComboForDisplay, getBinding } from "@/lib/keybindings";
import { registerEditorActionRedispatch } from "@/lib/monaco/monacoKeybindings";
import { runAiTask } from "@/lib/ai/runTask";
import { statementAt, type SqlDialect } from "@/lib/sql/sqlSplit";
import i18n from "@/lib/i18n";
import type { BatchResult, DatabaseInfo, QueryResult } from "@/types";
import { DataGrid } from "@/components/grid/DataGrid";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SaveQueryDialog } from "@/components/query/dialogs/SaveQueryDialog";
import { Segmented } from "@/components/ui/segmented";
import {
  panelsFromBatch,
  type ResultPanel,
} from "@/lib/query/resultPanels";
import { splitSql } from "@/lib/sql/sqlSplit";
import {
  databaseOfViewId,
  parentConnectionId,
  sqliteFileLabel,
} from "@/lib/connectionLabel";
import { keywordsFor } from "@/lib/sql/sqlKeywords";
import { buildCompletions } from "@/lib/sql/sqlCompletions";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { supportsMultipleDatabases } from "@/lib/db/driver";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";
import { useElapsed } from "@/lib/useElapsed";
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

/** Radix Select can't carry an empty value, so the parent / default-database
 *  option uses this sentinel. */
const DEFAULT_DB = "__default__";

export function QueryEditorTab({ tabId, connectionId }: Props) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const updateQuery = useTabs((s) => s.updateQuery);
  const editorPrefs = usePreferences(selectEditorPrefs);
  // Resolved through the hook, not the bare function: an imported
  // theme's definition arrives after first paint, and only a store
  // subscription repaints this editor when it does.
  const monacoTheme = useMonacoTheme(editorPrefs.theme);
  const addHistory = useQueryHistory((s) => s.add);
  const allHistory = useQueryHistory((s) => s.entries);
  const clearHistory = useQueryHistory((s) => s.clear);
  // Stable array; filter is derived in component body with useMemo (not in the selector).
  const profiles = useConnections((s) => s.profiles);

  /** Parent connection id (a query tab may be opened against a `::db::`
   *  child already). Database listing / switching always works off the parent. */
  const parentId = useMemo(
    () => parentConnectionId(connectionId),
    [connectionId],
  );

  /** The id the query actually runs against. Starts as the tab's connection
   *  and is repointed to a `parent::db::<name>` child when the user picks a
   *  database from the selector — `execute_query` / `execute_batch` and the
   *  autocomplete schema all key off this, so switching it is all it takes to
   *  scope the tab to another database without typing it into the SQL. */
  const [effectiveId, setEffectiveId] = useState(connectionId);
  useEffect(() => setEffectiveId(connectionId), [connectionId]);

  /** Database currently targeted, parsed back out of `effectiveId`. */
  const selectedDb = useMemo(
    () => databaseOfViewId(effectiveId),
    [effectiveId],
  );

  // The tab's own autocomplete needs the catalogue, and this is the one
  // surface that never asked for it: suggestions used to appear only once the
  // user had expanded the connection in the explorer. It matters most on
  // MongoDB, where a freshly opened tab would otherwise know neither the
  // collections nor their fields, but SQL tabs get the same warm start.
  useEnsureSchemaLoaded(effectiveId);
  const schemaState = useSchema((s) => s.byConnection[effectiveId]);
  const loadColumns = useSchema((s) => s.loadColumns);

  const history = useMemo(
    () => allHistory.filter((e) => e.connectionId === parentId),
    [allHistory, parentId],
  );

  /** Short display name for the connected database shown in the info bar. */
  const dbName = useMemo(() => {
    const p = profiles.find((pr) => pr.id === parentId);
    if (!p) return parentId;
    if (p.driver === "sqlite") return sqliteFileLabel(p.database);
    return selectedDb || p.database || t("query.defaultDatabase");
  }, [profiles, parentId, selectedDb, t]);

  /**
   * Every result set the last run produced, in statement order — one panel
   * each. A single-statement run yields one entry (or none, for a write with
   * nothing to show beyond its affected-row count, which `DmlResult` renders);
   * a batch yields one per statement that returned, which is the whole point:
   * the backend has always built a full `QueryResult` per SELECT and the tab
   * used to keep only the last one.
   */
  const [panels, setPanels] = useState<ResultPanel[]>([]);
  /** Key of the panel on screen. Only that one's grid is mounted — see
   *  `ResultTabs` for why rendering all of them would be the wrong trade. */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<BatchResult | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Shortcut chip on the Run button — reflects the user's current binding
  // for `runQuery` (see `handleMount`, which dispatches the same combo).
  const runQueryCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "runQuery"),
  );
  const runHint = formatComboForDisplay(runQueryCombo);
  const [showHistory, setShowHistory] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  /** Line and character counts updated live by Monaco. */
  const [editorStats, setEditorStats] = useState({ lines: 1, chars: 0 });

  /**
   * Wall-clock run timer, isolated behind a ref on purpose. `elapsedMs`
   * ticks every 50ms while a query is running — state that used to live
   * here and re-render this whole tab (Monaco included) on every tick.
   * `QueryTimer` now owns that state itself (via `useElapsed`); this ref
   * is just the imperative start/stop handle, so `runQuery`/`runBatch`
   * below can drive the badge without subscribing to its ticking value.
   */
  const queryTimerRef = useRef<QueryTimerHandle>(null);

  const filteredHistory = useMemo(() => {
    if (!historyFilter.trim()) return history;
    const q = historyFilter.toLowerCase();
    return history.filter((h) => h.sql.toLowerCase().includes(q));
  }, [history, historyFilter]);

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

  const sql = tab?.query ?? "";

  /** Driver for the active connection — drives the keyword overlay, the
   *  dollar-quote handling in [[splitSql]], and whether the database selector
   *  is shown (SQLite is single-file, so it isn't). */
  const driver = useConnections(
    (s) => s.profiles.find((p) => p.id === parentId)?.driver,
  );

  /** MongoDB gets its own editor language, its own completion provider and
   *  its own splitter dialect — the tab used to hand it `"sql"` literally,
   *  with no driver branch anywhere but the status-bar label. */
  const isMongo = driver === "mongodb";
  const dialect: SqlDialect = isMongo ? "mongo" : "sql";
  /** `handleMount` registers its editor actions once, in a closure that
   *  outlives every re-render — same long-lived-closure reason as
   *  `runQueryRef` below. */
  const dialectRef = useRef(dialect);
  useEffect(() => {
    dialectRef.current = dialect;
  }, [dialect]);

  /** Parsed statements of the current buffer. Drives both the per-statement
   *  CodeLens count and the "Run all" affordance. */
  const statements = useMemo(() => splitSql(sql, dialect), [sql, dialect]);
  const multiStatement = statements.length > 1;

  /** Databases available on the parent connection. Fetched once per parent
   *  for the selector; SQLite reports a single "main" so we skip it there. */
  useEffect(() => {
    if (driver === "sqlite") {
      setDatabases([]);
      return;
    }
    let cancelled = false;
    void api
      .listDatabases(parentId)
      .then((dbs) => {
        if (!cancelled) setDatabases(dbs);
      })
      .catch(() => {
        if (!cancelled) setDatabases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [parentId, driver]);

  /** Repoint the tab at another database. Opens (idempotently) the child pool
   *  for `name`, switches `effectiveId` to it, and warms its schema so the
   *  autocomplete reflects the new database. `DEFAULT_DB` returns to the
   *  parent (the connect-time / maintenance database). */
  const switchDatabase = useCallback(
    async (name: string) => {
      if (name === DEFAULT_DB) {
        setEffectiveId(parentId);
        return;
      }
      try {
        const id = await api.openDatabaseView(parentId, name);
        setEffectiveId(id);
        void useSchema.getState().refresh(id);
      } catch (e) {
        setError(String(e));
      }
    },
    [parentId],
  );

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
   * Run a fragment of SQL. Defaults to the entire editor buffer when no
   * text is passed in. We support the optional argument so the
   * per-statement CodeLens can execute just the statement under the
   * gutter icon without juggling editor selection state.
   */
  const runQuery = useCallback(
    async (override?: string) => {
      const toRun = (override ?? sql).trim();
      if (!toRun || running) return;
      setRunning(true);
      setError(null);
      setBatchSummary(null);
      queryTimerRef.current?.start();
      try {
        const r = await api.executeQuery(effectiveId, toRun);
        setPanels([{ key: "0", statement: 1, set: null, result: r }]);
        setActiveKey("0");
        addHistory({
          sql: toRun,
          connectionId: parentId,
          elapsedMs: r.elapsed_ms,
          rowsAffected: r.rows_affected,
        });
        queryTimerRef.current?.stop(true);
      } catch (e) {
        setError(String(e));
        addHistory({
          sql: toRun,
          connectionId: parentId,
          elapsedMs: 0,
          rowsAffected: 0,
          error: String(e),
        });
        queryTimerRef.current?.stop(false);
      } finally {
        setRunning(false);
      }
    },
    // `queryTimerRef` is a ref: reading `.current` at call time needs no
    // dependency-array entry, which is the whole point of driving the
    // timer this way instead of through `startTimer`/`stopTimer` callbacks.
    [sql, effectiveId, parentId, running, addHistory],
  );

  /**
   * Run every statement in the buffer in order, on a single connection.
   * This is the multi-statement path: a lone `executeQuery` over a
   * `;`-joined buffer hits the prepared protocol, which rejects multiple
   * commands. The summary lists each statement's outcome; the last SELECT's
   * rows land in the grid.
   */
  const runBatch = useCallback(async () => {
    if (running || statements.length === 0) return;
    setRunning(true);
    setError(null);
    queryTimerRef.current?.start();
    try {
      const r = await api.executeBatch(
        effectiveId,
        statements.map((s) => s.text),
      );
      setBatchSummary(r);
      const next = panelsFromBatch(r.statements);
      setPanels(next);
      setActiveKey(next[0]?.key ?? null);
      const failed = r.statements.find((s) => s.error);
      addHistory({
        sql: statements.map((s) => s.text).join(";\n"),
        connectionId: parentId,
        elapsedMs: 0,
        rowsAffected: r.total_affected,
        error: failed?.error ?? undefined,
      });
      queryTimerRef.current?.stop(!failed);
    } catch (e) {
      setError(String(e));
      queryTimerRef.current?.stop(false);
    } finally {
      setRunning(false);
    }
  }, [running, statements, effectiveId, parentId, addHistory]);

  /** The panel on screen. Falls back to the first one so a run that replaces
   *  the panel list never leaves the area blank while `activeKey` is stale. */
  const active = useMemo(
    () => panels.find((p) => p.key === activeKey) ?? panels[0] ?? null,
    [panels, activeKey],
  );

  /** Switching result panels clears the grid's client-side filter: it is
   *  typed against one result's columns, and carrying it over to another
   *  reads as an empty result rather than as a filter still being applied. */
  const selectPanel = useCallback((key: string) => {
    setActiveKey(key);
    setFilter("");
  }, []);

  /**
   * Ref pointing at the latest `runQuery`. Monaco's `addCommand` runs
   * its handler in a long-lived closure that we register exactly once
   * inside `handleMount`; capturing the runQuery callback there
   * directly would freeze the closure to the first render's values
   * (stale `sql`, stale `running`). Bouncing through this ref lets us
   * keep one registration while still hitting the live callback.
   */
  const runQueryRef = useRef(runQuery);
  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  /**
   * Ctrl+Enter dispatcher, kept in a ref for the same long-lived-closure
   * reason as `runQueryRef`. Routes the whole buffer to the batch runner when
   * it holds more than one statement (so a paste of N statements no longer
   * trips the prepared-protocol "cannot insert multiple commands" error), and
   * to the single-statement runner otherwise.
   */
  const runDefaultRef = useRef<() => void>(() => {});
  useEffect(() => {
    runDefaultRef.current = () => {
      if (multiStatement) void runBatch();
      else void runQuery();
    };
  }, [multiStatement, runBatch, runQuery]);

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
          {/* Compact action row: save + history (Run is Ctrl+Enter) and,
              for multi-DB servers, a database selector that scopes the tab. */}
          <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1">
            {/* Primary action. The whole point of a query editor — previously
                Run had no button at all (Ctrl+Enter / CodeLens only). Runs the
                buffer, routing to the batch runner when it holds >1 statement,
                and shows a busy state so the tab doesn't look inert mid-query. */}
            <Button
              size="sm"
              onClick={() =>
                multiStatement ? void runBatch() : void runQuery()
              }
              disabled={!sql.trim() || running}
              title={
                multiStatement ? t("query.runAllTitle") : t("query.runTitle")
              }
              className="gap-1.5"
            >
              {running ? (
                <Spinner size="sm" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {running
                ? t("query.running")
                : multiStatement
                  ? t("query.runAll", { count: statements.length })
                  : t("query.run")}
              {!running && (
                <kbd className="ml-0.5 rounded-sm border border-brand-foreground/30 bg-brand-foreground/10 px-1 py-px text-3xs font-medium leading-none">
                  {runHint}
                </kbd>
              )}
            </Button>
            <QueryTimer ref={queryTimerRef} running={running} />
            <div className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSaveDialogOpen(true)}
              disabled={!sql.trim()}
              title={t("query.saveQuery")}
            >
              <Bookmark className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant={showHistory ? "secondary" : "ghost"}
              aria-pressed={showHistory}
              onClick={() => setShowHistory((v) => !v)}
              title={t("query.history")}
            >
              <History className="h-3.5 w-3.5" />
            </Button>

            {supportsMultipleDatabases(driver) && databases.length > 0 && (
              <div className="ml-auto flex items-center gap-1">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <Select
                  value={selectedDb || DEFAULT_DB}
                  onValueChange={(v) => void switchDatabase(v)}
                >
                  <SelectTrigger
                    className="h-6 w-44 text-xs"
                    title={t("query.database")}
                  >
                    <SelectValue placeholder={t("query.defaultDatabase")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_DB} className="text-xs">
                      {t("query.defaultDatabase")}
                    </SelectItem>
                    {databases.map((db) => (
                      <SelectItem
                        key={db.name}
                        value={db.name}
                        className="text-xs"
                      >
                        {db.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

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
              <div className="flex w-72 shrink-0 flex-col border-l border-border bg-card/40">
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="text-3xs uppercase tracking-wider text-muted-foreground">
                    {t("query.historyTitle")}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-3xs text-muted-foreground">
                      {history.length}
                    </span>
                    {history.length > 0 && (
                      <IconButton
                        flat
                        size="xs"
                        icon={Trash2}
                        label={t("query.clearHistory")}
                        className="h-5 w-5"
                        onClick={clearHistory}
                      />
                    )}
                  </div>
                </div>
                <div className="border-b border-border px-3 pb-2">
                  <SearchField
                    size="xs"
                    value={historyFilter}
                    onValueChange={setHistoryFilter}
                    placeholder={t("query.historyFilterPlaceholder")}
                    inputClassName="text-xs"
                  />
                </div>
                <div className="flex-1 overflow-y-auto pb-12">
                  {filteredHistory.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {history.length === 0
                        ? t("query.noQueries")
                        : t("saved.emptyNoMatch")}
                    </div>
                  )}
                  {filteredHistory.map((h) => (
                    <div
                      key={h.id}
                      className="group flex items-start gap-1.5 border-b border-border/40 px-3 py-2 hover:bg-accent"
                    >
                      {h.error ? (
                        <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                      ) : (
                        <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                      )}
                      <button
                        onClick={() => updateQuery(tabId, h.sql)}
                        className="min-w-0 flex-1 text-left text-xs"
                        title={h.sql}
                      >
                        <div className="line-clamp-2 font-mono text-2xs">
                          {h.sql}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-3xs text-muted-foreground">
                          <span>{formatTime(h.ranAt)}</span>
                          {h.error ? (
                            <span className="truncate text-destructive">
                              {h.error}
                            </span>
                          ) : (
                            <span>
                              {t("query.historyEntryStats", {
                                rows: h.rowsAffected,
                                duration: formatDuration(h.elapsedMs),
                              })}
                            </span>
                          )}
                        </div>
                      </button>
                      <IconButton
                        flat
                        size="xs"
                        icon={Play}
                        label={t("query.runAgain")}
                        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => void runQuery(h.sql)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Editor info bar: keyboard hint · db name · line/char count · encoding */}
          <div className="flex items-center gap-0 border-t border-border bg-card px-3 py-1 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded-sm bg-muted px-1 font-mono text-3xs">
                Ctrl
              </kbd>
              <span>+</span>
              <kbd className="rounded-sm bg-muted px-1 font-mono text-3xs">
                Enter
              </kbd>
              <span className="ml-1 text-muted-foreground/70">
                {t("query.run")}
              </span>
            </span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span className="truncate">{dbName}</span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>
              {editorStats.lines} line{editorStats.lines !== 1 ? "s" : ""}
              {" · "}
              {editorStats.chars} chars
            </span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>{driver === "mongodb" ? "mongodb" : "sql"} · utf-8</span>
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />

      {/* Results panel */}
      <Panel defaultSize={25} minSize={10}>
        <div className="flex h-full flex-col">
          {/* Batch summary: one line per statement — including the writes and
              the failure, which have no panel of their own. */}
          {batchSummary && <BatchSummary summary={batchSummary} />}
          {panels.length > 1 && (
            <ResultTabs
              panels={panels}
              activeKey={active?.key ?? null}
              onSelect={selectPanel}
            />
          )}
          {error ? (
            <div className="min-h-0 flex-1 overflow-auto bg-destructive/10 p-3 font-mono text-xs text-destructive">
              {error}
            </div>
          ) : active && active.result.columns.length === 0 ? (
            <DmlResult result={active.result} />
          ) : active ? (
            // `DataGrid` sizes itself with `h-full`, so it needs a box with a
            // definite height — given one, its own inner `overflow-auto`
            // scrolls; given the raw flex line, `height: 100%` resolves
            // against the *whole* panel and the grid hangs below it by
            // however tall the summary and the tab strip are, clipping the
            // last rows with no way to scroll to them. `TableDataTab` already
            // wraps it exactly like this; this one did not, which only showed
            // once there was anything above the grid.
            <div className="min-h-0 flex-1 overflow-hidden">
              {/* Keyed, so switching panels remounts the grid rather than
                  feeding a new result into one holding the previous one's
                  sort, selection and column widths. */}
              <DataGrid
                key={active.key}
                result={active.result}
                tabId={tabId}
                globalFilter={filter}
                onGlobalFilterChange={setFilter}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              {batchSummary ? null : t("query.noResults")}
            </div>
          )}
        </div>
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

/**
 * The strip that picks which result set the grid below shows.
 *
 * Only the selected panel's `DataGrid` is mounted, and that is a deliberate
 * trade rather than an optimisation left for later. N grids in one tab would
 * mean N times the DOM for a payload already bounded by a shared 50 000-row
 * budget — and, less visibly, a collision: `stores/grid/gridSelection.ts` is
 * keyed by tab id and `CellEditor` takes `ownerId={tabId}`, so two live grids
 * in one tab would overwrite each other's "N selected" and fight over the
 * docked editor. With one mounted grid the tab id stays the honest key it was.
 *
 * Built on `Segmented` rather than hand-rolled buttons: a single-choice strip
 * with roving tabindex and arrow-key movement is exactly what that primitive
 * is, and `uiAdoption.test.ts` counts every raw `<button>` that re-decides it.
 */
function ResultTabs({
  panels,
  activeKey,
  onSelect,
}: {
  panels: ResultPanel[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const options = panels.map((p) => ({
    value: p.key,
    label: t("query.resultTab", {
      label: p.set === null ? `#${p.statement}` : `#${p.statement}.${p.set}`,
      rows: p.result.rows.length,
    }),
    // The OS tooltip is `Segmented`'s own affordance for a narrow segment;
    // it says what the panel holds when the label has room only for a count.
    title: p.result.truncated
      ? t("query.resultTabTruncatedTitle", { rows: p.result.rows.length })
      : t("query.resultTabTitle", { index: p.statement }),
  }));
  return (
    <Segmented
      variant="underline"
      size="sm"
      className="shrink-0 overflow-x-auto"
      aria-label={t("query.resultTabs")}
      value={activeKey ?? panels[0]?.key ?? ""}
      onValueChange={onSelect}
      options={options}
    />
  );
}

/** Imperative handle `QueryEditorTab` drives the timer through — see the
 *  comment on `queryTimerRef` above for why this is a ref and not props. */
export interface QueryTimerHandle {
  start: () => void;
  stop: (ok: boolean) => void;
}

/**
 * Live/frozen run-duration badge next to the Run button. Ticks in real time
 * (wall clock, not the driver's own `elapsed_ms`, so it reflects what the
 * user is actually waiting on — IPC included) while a query is in flight,
 * then freezes on the settled time, tinted by outcome. Renders nothing
 * before the first run — an idle "0 ms" badge would just be noise.
 *
 * Owns its own `elapsedMs`/`lastOk` state via `useElapsed` instead of
 * receiving them as props from `QueryEditorTab`. That state ticks every
 * 50ms while a query runs; if it lived in the parent (as it used to), every
 * tick would re-render the entire query tab — Monaco editor included — just
 * to update this one small badge. `start`/`stop` are exposed through
 * `ref` so the parent can drive the timer without subscribing to the value
 * that changes 20 times a second.
 */
const QueryTimer = forwardRef<QueryTimerHandle, { running: boolean }>(
  function QueryTimer({ running }, ref) {
    const { t } = useTranslation();
    const { elapsedMs, lastOk, start, stop } = useElapsed();
    useImperativeHandle(ref, () => ({ start, stop }), [start, stop]);
    if (!running && lastOk === null) return null;
    return (
      <div
        className={cn(
          "ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs tabular-nums transition-colors",
          running
            ? "bg-brand/10 text-brand"
            : lastOk
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/10 text-destructive",
        )}
        title={t("query.elapsedTitle")}
      >
        <Clock className={cn("h-3 w-3", running && "animate-pulse")} />
        <span>{formatDuration(elapsedMs)}</span>
      </div>
    );
  },
);

/**
 * Compact, scrollable summary of a multi-statement batch run. One row per
 * statement with a status glyph, a monospace preview and its affected-row
 * count; a header line tallies the whole batch (or flags where it stopped).
 * Deliberately understated — the grid below holds the actual data.
 *
 * It stays a summary rather than becoming the result selector `ResultTabs`
 * is, because the two answer different questions and only one of them is
 * about the rows: this is where a write's affected count and the statement
 * that stopped the batch are reported, and neither has a panel to be selected.
 */
function BatchSummary({ summary }: { summary: BatchResult }) {
  const { t } = useTranslation();
  const failedAt = summary.statements.findIndex((s) => s.error);
  const ok = failedAt === -1;
  return (
    <div className="shrink-0 border-b border-border bg-card/40">
      <div
        className={cn(
          "px-3 py-1 text-2xs",
          ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {ok
          ? t("query.batchOk", {
              count: summary.statements.length,
              rows: summary.total_affected,
            })
          : t("query.batchFailed", {
              index: failedAt + 1,
              total: summary.statements.length,
            })}
      </div>
      <div className="max-h-28 overflow-y-auto">
        {summary.statements.map((s) => (
          <div
            key={s.index}
            className="flex items-center gap-2 px-3 py-0.5 text-2xs"
          >
            {s.error ? (
              <X className="h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Check className="h-3 w-3 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {s.preview}
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                s.error ? "text-destructive" : "text-muted-foreground/70",
              )}
            >
              {s.error
                ? s.error
                : s.is_select
                  ? `${s.rows_affected} rows`
                  : `${s.rows_affected} affected`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Feedback for a single DML statement (INSERT/UPDATE/DELETE) run outside a
 * batch. `DataGrid` has nothing to show for a columns-less result, so
 * without this the results panel just looked empty after Ctrl+Enter.
 */
function DmlResult({ result }: { result: QueryResult }) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-b border-border bg-card/40">
      <div className="flex items-center gap-2 px-3 py-1 text-2xs text-muted-foreground">
        <Check className="h-3 w-3 shrink-0 text-primary" />
        <span>
          {t("query.rowsAffected", {
            rows: result.rows_affected,
            ms: result.elapsed_ms,
          })}
        </span>
      </div>
    </div>
  );
}
