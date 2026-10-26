/**
 * User-tunable preferences store, backed by `prefs.json` in the platform
 * config dir via the Rust commands `get_preferences` / `update_preferences`.
 *
 * Unlike the theme / history / saved-queries stores we deliberately do NOT
 * use the Zustand `persist` middleware — disk (via Rust) is the source of
 * truth here, not localStorage. The flow is:
 *
 *   1. `hydrate()` is awaited once at app boot, before the UI renders.
 *   2. Every setter mutates the in-memory snapshot and schedules a
 *      debounced `api.updatePreferences()` (400 ms) so slider drags don't
 *      hammer the disk.
 *   3. Each section is updated as a single shallow-merged object so React
 *      selectors that subscribe to a slice (e.g. `state.editor`) keep
 *      reference stability when an unrelated section changes — required to
 *      avoid the infinite-re-render trap documented in `CLAUDE.md`.
 *
 * The one-time migration from the previous `localStorage["huginndb.viewPrefs.v1"]`
 * blob runs inside `hydrate()` so the user's schema-tree metric choice
 * survives the move to disk-backed storage.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { debounce } from "@/lib/schedule";
import { STORAGE_KEYS } from "@/lib/constants";
import { withDefaults } from "@/lib/prefDefaults";
import type { PrefId } from "@/lib/prefId";
import type {
  AiPrefs,
  ConnectionPrefs,
  EditorPrefs,
  GridPrefs,
  NotificationPrefs,
  Preferences,
  PulsePrefs,
  SchemaTableMetric,
  TerminalPrefs,
  LockPrefs,
  ThemePrefs,
  UpdatePrefs,
  UiPrefs,
} from "@/types";

export const DEFAULT_PREFS: Preferences = {
  version: 1,
  editor: {
    fontFamily: "JetBrains Mono",
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    formatOnPaste: false,
    theme: "huginn-dark",
    jsonSchemaValidation: true,
    jsonSchemaCompletion: true,
    jsonSchemaHover: true,
    autoFormatJson: true,
    autoFormatXml: true,
    autoFormatSql: false,
  },
  grid: {
    rowHeight: 26,
    nullDisplay: "NULL",
    truncateLongTextAt: 200,
    zebraStripes: true,
    stickyHeader: true,
    defaultPageSize: 100,
    cellPreview: true,
    bitDisplay: "true_false",
    columnWidths: {},
    pinnedColumns: {},
    documentViewMode: "table",
    listExpandNested: false,
    listShowTypes: true,
    listLineNumbers: true,
  },
  ui: {
    confirmDestructive: true,
    confirmEmptyTable: true,
    queryHistoryLimit: 50,
    restoreTabsOnOpen: true,
    reconnectOnLaunch: true,
    // `"size"`, not `"none"`. Every driver populates `TableInfo.size_bytes`
    // whatever this says — SQLite even pays N `dbstat` queries for it, since
    // the backend never sees the preference — so `"none"` bought nothing and
    // only hid a number the app had already computed. Only new installs move:
    // `save_preferences` writes the whole struct, so anyone who has ever
    // touched a single preference already has an explicit value on disk.
    schemaTableMetric: "size",
    language: "en",
    cellEditorMode: "modal",
    defaultDriver: null,
    cliConnectDefault: "ask",
    collapsedConnectionGroups: [],
    tabAccentStyle: "cap",
    connectionGroupExpandMode: "remember",
    // Mirrors `UiPrefs::default` — on, for the reason argued there.
    jumpListRecent: true,
  },
  // Mirrors `NotificationPrefs::default()` in `src-tauri/src/prefs.rs`. The
  // 6000 ms is deliberate: the toast library's own default is 4000, which is
  // what made a file path or a driver error unreadable before it vanished.
  notifications: {
    position: "bottom-right",
    // Deliberately not the card corner: bottom-centre is the canonical spot for
    // ephemeral state, and it leaves the bottom-right corner (where the bell
    // and the status bar already are) to the cards.
    pillPosition: "bottom-center",
    durationMs: 6000,
    errorsPersist: true,
    maxVisible: 3,
    expandOnHover: true,
    density: "comfortable",
    historyLimit: 50,
    showBell: true,
  },
  // Mirrors `ConnectionPrefs::default()` in `src-tauri/src/prefs.rs`. Only
  // used before `hydrate()` lands — the backend is the source of truth and
  // re-applies its own defaults for any field an older `prefs.json` omits.
  connections: {
    maxConnections: 10,
    childMaxConnections: 2,
    childIdleTtlSecs: 300,
    maxChildPools: 8,
    mcpBridge: false,
    bridgeIdleTtlSecs: 300,
    keepaliveSecs: 180,
    operationTimeoutSecs: 20,
  },
  // Mirrors `PulsePrefs::default()` in `src-tauri/src/prefs.rs`.
  pulse: {
    enabled: true,
    liveIntervalSecs: 5,
    historyIntervalSecs: 60,
    retentionDays: 30,
    sampleWhenMinimized: true,
    maxDiskMb: 20,
  },
  // Mirrors `AiPrefs::default()` in `src-tauri/src/prefs.rs`. Two of these are
  // load-bearing rather than cosmetic: `enabled: false` means an install that
  // upgrades into this version never talks to a model, and
  // `endpointTrust: "untrusted"` means that even once it does, the coupling
  // rule starts at metadata-only. `baseUrl` is pre-filled with Ollama's
  // default because it is the endpoint most users will have first and it costs
  // nothing to guess for the rest; `model` is not, because it depends entirely
  // on what their endpoint serves.
  ai: {
    enabled: false,
    baseUrl: "http://localhost:11434/v1",
    model: "",
    endpointTrust: "untrusted",
    mode: "assisted",
    maxContextRows: 50,
    requestTimeoutSecs: 120,
    // Omitted from the request unless the user picks a value: OpenAI rejects
    // `reasoning_effort` on a non-reasoning model, so "auto" is the only
    // setting guaranteed to work against every endpoint.
    reasoningEffort: "auto",
  },
  themes: {
    // On by default, against the usual "a new flag starts off" rule — see the
    // reasoning on `ThemePrefs`. Nothing of the user's leaves the machine.
    registryEnabled: true,
    registryUrl: "https://open-vsx.org",
  },
  updates: {
    // On by default, like `ThemePrefs.registryEnabled` and for a stronger
    // reason: see `UpdatePrefs`.
    autoInstall: true,
  },
  // Mirrors `TerminalPrefs::default()` in `src-tauri/src/prefs.rs`. On by
  // default, unlike `ai`: see the reasoning on `TerminalPrefs`.
  terminal: {
    enabled: true,
    mongoshPath: "",
    shellPath: "",
  },
  // Mirrors `LockPrefs::default()`: fifteen minutes, see its reasoning.
  lock: {
    idleMinutes: 15,
    withSession: true,
  },
  keybindings: {},
};

interface PreferencesState {
  prefs: Preferences;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  updateEditor: (patch: Partial<EditorPrefs>) => void;
  updateGrid: (patch: Partial<GridPrefs>) => void;
  updateUi: (patch: Partial<UiPrefs>) => void;
  updateNotifications: (patch: Partial<NotificationPrefs>) => void;
  updateConnections: (patch: Partial<ConnectionPrefs>) => void;
  updatePulse: (patch: Partial<PulsePrefs>) => void;
  updateAi: (patch: Partial<AiPrefs>) => void;
  updateThemes: (patch: Partial<ThemePrefs>) => void;
  updateUpdates: (patch: Partial<UpdatePrefs>) => void;
  updateTerminal: (patch: Partial<TerminalPrefs>) => void;
  updateLock: (patch: Partial<LockPrefs>) => void;
  /**
   * Merge shortcut overrides. A key mapped to `undefined` is **deleted**,
   * which is how "reset this row to its default" is expressed — writing the
   * default back explicitly would leave the overrides map full of things that
   * aren't overrides, and `isDefault` would then be a value comparison rather
   * than a key lookup.
   */
  updateKeybindings: (patch: Record<string, string[] | undefined>) => void;
  /** Drop every override at once, so all actions fall back to `ACTIONS`. */
  resetKeybindings: () => void;
  /**
   * Put the listed settings back to their defaults — the Preferences dialog's
   * per-row and per-section reset. Ids that have no reset (`lib/prefDefaults.ts`
   * decides which) or are already at their default are skipped, and nothing is
   * written when that leaves nothing to do.
   */
  resetPrefs: (ids: readonly PrefId[]) => void;
  resetAll: () => void;
  /**
   * Adopt a snapshot that's already persisted elsewhere — the cross-window
   * `prefs-changed` broadcast (`prefs-sync-bridge.ts`) after another window
   * saved. Deliberately does NOT call `scheduleSave`: the payload came from
   * a save that already completed, so re-saving it here would be a
   * redundant disk write at best and, at worst, a race against a newer
   * local edit made in the moment between the event firing and this
   * running.
   */
  applyExternal: (prefs: Preferences) => void;
}

const SAVE_DEBOUNCE_MS = 400;

const save = debounce(SAVE_DEBOUNCE_MS, (prefs: Preferences) => {
  api.updatePreferences(prefs).catch((err) => {
    // Disk writes shouldn't fail in normal operation, and the user can keep
    // working with the in-memory copy either way — but *only* until the app
    // closes. Reporting it is the difference between "my settings didn't
    // stick" being a mystery next launch and being something they were told
    // about while they could still act on it (a read-only config directory,
    // a full disk). Console too, since the message is worth having in a log.
    console.error("[preferences] failed to persist:", err);
    notify.error(i18n.t("settings.persistFailed"), { description: String(err) });
  });
});


/**
 * Read the legacy `localStorage["huginndb.viewPrefs.v1"]` blob and return
 * the schema-tree metric it stored, if any. Returns `null` when the key is
 * absent, parseable but empty, or contains an unknown value.
 */
function readLegacyViewPrefs(): SchemaTableMetric | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.viewPrefs);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { schemaTableMetric?: SchemaTableMetric };
    };
    const value = parsed?.state?.schemaTableMetric;
    if (value === "none" || value === "row-count" || value === "size") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export const usePreferences = create<PreferencesState>()((set, get) => ({
  prefs: DEFAULT_PREFS,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    let loaded: Preferences;
    try {
      loaded = await api.getPreferences();
    } catch (err) {
      // Starting on defaults silently is how a user concludes the app "forgot
      // everything": their editor, grid and notification settings are all
      // suddenly stock, with nothing saying the file could not be read.
      console.error("[preferences] hydrate failed; using defaults:", err);
      notify.warning(i18n.t("settings.hydrateFailed"), {
        description: String(err),
      });
      loaded = DEFAULT_PREFS;
    }

    // One-time migration: seed schemaTableMetric from the legacy
    // localStorage blob and then clear the key. We only seed when the disk
    // file is still at the default value — once the user has touched the
    // setting in the dialog, the disk value wins.
    //
    // Both comparisons read `DEFAULT_PREFS` rather than the literal `"none"`
    // they were written as. That literal *was* the default, so the two said
    // the same thing; once the default became `"size"` they stopped agreeing,
    // and the guard would have quietly stopped firing for exactly the users it
    // exists for — someone with `"row-count"` in the legacy blob and a
    // still-default `prefs.json`. The second clause matters for the same
    // reason in reverse: a legacy `"none"` used to be a no-op against a
    // `"none"` default and is now a real choice to preserve, since it means
    // the user had deliberately hidden the badge.
    const legacy = readLegacyViewPrefs();
    const metricDefault = DEFAULT_PREFS.ui.schemaTableMetric;
    let seeded = false;
    if (
      legacy &&
      loaded.ui.schemaTableMetric === metricDefault &&
      legacy !== metricDefault
    ) {
      loaded = {
        ...loaded,
        ui: { ...loaded.ui, schemaTableMetric: legacy },
      };
      seeded = true;
    }
    if (legacy !== null) {
      // Whether we seeded or not, the localStorage copy is now stale; drop
      // it so we never run this migration twice.
      try {
        localStorage.removeItem(STORAGE_KEYS.viewPrefs);
      } catch {
        // Storage may be unavailable in some webview configs; ignore.
      }
    }

    set({ prefs: loaded, hydrated: true });
    if (seeded) save.schedule(loaded);
  },

  updateEditor(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        editor: { ...s.prefs.editor, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateGrid(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        grid: { ...s.prefs.grid, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateUi(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        ui: { ...s.prefs.ui, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateNotifications(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        notifications: { ...s.prefs.notifications, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateConnections(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        connections: { ...s.prefs.connections, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updatePulse(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        pulse: { ...s.prefs.pulse, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateAi(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        ai: { ...s.prefs.ai, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateThemes(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        themes: { ...s.prefs.themes, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateUpdates(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        updates: { ...s.prefs.updates, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateTerminal(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        terminal: { ...s.prefs.terminal, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateLock(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        lock: { ...s.prefs.lock, ...patch },
      };
      save.schedule(next);
      return { prefs: next };
    });
  },

  updateKeybindings(patch) {
    set((s) => {
      const keybindings: Record<string, string[]> = { ...s.prefs.keybindings };
      for (const [id, bindings] of Object.entries(patch)) {
        if (bindings === undefined) delete keybindings[id];
        else keybindings[id] = bindings;
      }
      const next: Preferences = { ...s.prefs, keybindings };
      save.schedule(next);
      return { prefs: next };
    });
  },

  resetKeybindings() {
    set((s) => {
      const next: Preferences = { ...s.prefs, keybindings: {} };
      save.schedule(next);
      return { prefs: next };
    });
  },

  resetPrefs(ids) {
    set((s) => {
      const next = withDefaults(s.prefs, DEFAULT_PREFS, ids);
      if (next === s.prefs) return {};
      save.schedule(next);
      return { prefs: next };
    });
  },

  resetAll() {
    set({ prefs: DEFAULT_PREFS });
    save.schedule(DEFAULT_PREFS);
  },

  applyExternal(prefs) {
    set({ prefs });
  },
}));

// Slice selectors — exported so components subscribe to the smallest stable
// reference possible. Calling `usePreferences(s => s.editor)` directly works
// too; these are sugar that document the intended boundary.
export const selectEditorPrefs = (s: PreferencesState) => s.prefs.editor;
export const selectGridPrefs = (s: PreferencesState) => s.prefs.grid;
export const selectUiPrefs = (s: PreferencesState) => s.prefs.ui;
export const selectNotificationPrefs = (s: PreferencesState) => s.prefs.notifications;
export const selectConnectionPrefs = (s: PreferencesState) => s.prefs.connections;
export const selectPulsePrefs = (s: PreferencesState) => s.prefs.pulse;
export const selectAiPrefs = (s: PreferencesState) => s.prefs.ai;
export const selectTerminalPrefs = (s: PreferencesState) => s.prefs.terminal;
export const selectLockPrefs = (s: PreferencesState) => s.prefs.lock;
export const selectKeybindings = (s: PreferencesState) => s.prefs.keybindings;
