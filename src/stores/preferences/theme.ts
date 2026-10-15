/**
 * Theme store — drives the look of the entire app.
 *
 * Conceptually there is exactly one "active" theme FAMILY at any moment,
 * plus a global light/dark MODE independent of it — the family is which
 * palette (HuginnDB, Claude, …), the mode is which of its two variants
 * `light-dark()` resolves to (see `applyTheme`/`applyColorScheme` in
 * `lib/themes.ts`). Built-in families are referenced by id and never
 * mutated; editing one auto-forks into a new custom family so the presets
 * stay pristine.
 *
 * CSS variable updates are flushed eagerly inside each action so the
 * UI re-paints synchronously — the persisted localStorage write
 * happens asynchronously via the `persist` middleware.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type * as monaco from "monaco-editor";
import { STORAGE_KEYS } from "@/lib/constants";
import { customThemeId } from "@/lib/utils";
import {
  registerImportedMonacoThemes,
  unregisterImportedMonacoThemes,
} from "@/lib/monaco/monaco-themes";
import { monacoThemeId, type ThemeImportResult } from "@/lib/vscodeTheme";
import type { InstalledThemeSource } from "@/lib/vscodeTheme/types";
import { api } from "@/lib/tauri";
// One-way: preferences knows nothing about themes, so this cannot cycle.
import { usePreferences } from "./preferences";
import {
  BUILT_IN_THEMES,
  applyTheme,
  applyColorScheme,
  resolveLegacyThemeId,
  LEGACY_THEME_MODE_MAP,
  type ThemeFamily,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/themes";

/** The two Monaco themes an imported VS Code theme brings with it, kept
 *  beside the family they came from. */
export interface ImportedEditorThemes {
  /** Family name at import time — what the Preferences editor picker shows. */
  label: string;
  /**
   * Where this family came from, when it came from a registry.
   *
   * Carried in memory purely so the Extensions panel can mark a search result
   * as already installed. That used to be matched on the family *name*, which
   * is wrong for the obvious reason — a theme renamed after import, or an
   * extension whose registry display name differs from its manifest's, stops
   * matching itself — and the join key was sitting on disk the whole time.
   */
  source?: InstalledThemeSource | null;
  /** The extension's `publisher.name`. Present for a local `.vsix` import too,
   *  which is what lets the browser recognise one. */
  identifier?: string | null;
  /** Package version at install time, for the update check. */
  version?: string | null;
  light: monaco.editor.IStandaloneThemeData;
  dark: monaco.editor.IStandaloneThemeData;
}

interface ThemeState {
  themeId: string;
  mode: ThemeMode;
  customThemes: ThemeFamily[];
  /**
   * Editor themes that arrived with an imported VS Code theme, keyed by the
   * custom family's id.
   *
   * **In memory only — the file on disk is the source of truth.** This field
   * is deliberately absent from `partialize`: `installed_themes.json` owns
   * these (see `themes::store` in Rust) and [`hydrateInstalledThemes`] fills
   * the map at startup. What it is still needed *here* for is the Preferences
   * editor-theme picker, which has to re-render when a theme is installed or
   * deleted — a value React can subscribe to, which a file is not.
   *
   * The split from the palettes is by shape rather than size. A palette is 30
   * hex values read synchronously before first paint to avoid a FOUC, so it
   * belongs in localStorage; a Monaco theme is ~20 KB (One Dark Pro's 275
   * token rules), is exactly what localStorage should not accumulate once a
   * registry can install a dozen, and tolerates arriving late because
   * `registerImportedMonacoThemes` defines whatever it is handed whenever it
   * is handed it.
   */
  importedEditorThemes: Record<string, ImportedEditorThemes>;
  /**
   * Theme id the *active environment* wants applied instead of `themeId`, or
   * `null` for "no override — use the default". Only ever fixes the FAMILY,
   * never the mode — the mode stays a personal preference independent of
   * which environment is active (see ADR #27: an environment describes
   * session/visual identity, not user ergonomics). Set by
   * `useEnvironments.restoreSession`/`switchTo`/`update`, never persisted
   * here: it describes the current environment, not a user preference, and
   * environments already persist their own `themeId` on the backend
   * (`Environment.themeId`, tab_state.json). Kept transient so a fresh
   * install or a rehydrate before environments load never shows a stale
   * override.
   */
  environmentOverrideId: string | null;
  setThemeId: (id: string) => void;
  upsertCustom: (family: ThemeFamily) => void;
  /** Store an imported VS Code theme: its palette becomes a custom family,
   *  its editor themes are registered with Monaco and written to disk, and
   *  the family is made active — the same ending as importing a
   *  `.huginndb-theme.json`. `source` is present when it came from a
   *  registry, and is what a later update check reads. */
  addImportedTheme: (result: ThemeImportResult, source?: InstalledThemeSource) => void;
  /** Replace an installed theme's editor themes, and its palette too unless
   *  the user has edited it. Used by the update flow; see the note on
   *  `paletteEdited` in `themes::store`. */
  applyThemeUpdate: (
    result: ThemeImportResult,
    source: InstalledThemeSource,
    keepPalette: boolean,
  ) => void;
  deleteCustom: (id: string) => void;
  duplicateAsCustom: (sourceId: string, name: string) => string;
  /** `variant` edits that specific light/dark half of the family; omitted,
   *  it defaults to the currently active global mode. */
  updateActiveColor: (key: keyof ThemeColors, value: string, variant?: ThemeMode) => void;
  setActiveMode: (mode: ThemeMode) => void;
  resetActive: () => void;
  /** Apply (or clear) the active environment's theme override. Re-resolves
   *  and re-paints immediately; a `themeId` that no longer matches any theme
   *  (a deleted custom theme) falls back to the default, same as `themeId`
   *  going stale would. */
  setEnvironmentOverride: (themeId: string | null) => void;
}

interface LegacyPersistedTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
  builtin?: boolean;
}
interface LegacyPersistedState {
  themeId?: string;
  customThemes?: LegacyPersistedTheme[];
}

function allThemes(state: ThemeState): ThemeFamily[] {
  return [...BUILT_IN_THEMES, ...state.customThemes];
}

/** Pull the light/dark pair out of a build result, or `null` when one side is
 *  missing — which would mean an id in the picker that nothing defines. */
function pairEditorThemes(
  label: string,
  monacoThemes: ThemeImportResult["monacoThemes"],
  source: InstalledThemeSource | undefined,
  identifier: string,
  packageVersion: string,
): ImportedEditorThemes | null {
  const light = monacoThemes.find((m) => m.side === "light");
  const dark = monacoThemes.find((m) => m.side === "dark");
  return light && dark
    ? {
        label,
        source: source ?? null,
        identifier: identifier || null,
        version: packageVersion || null,
        light: light.data,
        dark: dark.data,
      }
    : null;
}

/**
 * Keep the Monaco editor pointed at the app theme's own editor colours.
 *
 * Installing a VS Code theme is one act, not two: the chrome takes the
 * palette and the editor takes the tokenisation, both out of the same
 * extension. Leaving `editor.theme` untouched is what produced the reported
 * state — the app repainted as the imported theme while every SQL editor sat
 * on HuginnDB Dark, with no hint in the UI that the two were separate knobs.
 *
 * The editor preference stays a preference: this only fires on the moves
 * where the user's intent is unambiguous.
 *
 *   - installing or updating a theme, which is an explicit "use this";
 *   - flipping light/dark while the editor is on this family's other side;
 *   - switching families while the editor is following the one being left,
 *     including onto a built-in, where "its editor theme" is the brand pair.
 *
 * An editor parked on a curated theme (Monokai, GitHub Dark, a VS built-in)
 * is a choice made independently of the chrome and is never overwritten.
 *
 * The decision is pure and exported so it can be tested without a store: it
 * returns the id to write, or `null` for "leave the editor alone".
 */
export function nextEditorTheme(
  current: string,
  familyId: string,
  mode: ThemeMode,
  importedFamilyIds: string[],
  force = false,
): string | null {
  const next = importedFamilyIds.includes(familyId)
    ? monacoThemeId(familyId, mode)
    : mode === "light"
      ? "huginn-light"
      : "huginn-dark";
  if (current === next) return null;
  // Was the editor following *some* imported family? Only then does an
  // implicit move carry the user's intent with it — an editor parked on a
  // curated theme was chosen independently of the chrome.
  const following =
    force ||
    importedFamilyIds.some(
      (id) =>
        current === monacoThemeId(id, "light") ||
        current === monacoThemeId(id, "dark"),
    );
  return following ? next : null;
}

/** The store-facing half: reads the live editor pref, writes it back when
 *  {@link nextEditorTheme} says the editor should move. */
function syncEditorTheme(
  state: ThemeState,
  familyId: string,
  mode: ThemeMode,
  opts: { force?: boolean } = {},
) {
  const prefs = usePreferences.getState();
  // Before `hydrate()` the in-memory prefs are defaults, not the user's —
  // writing here would persist a theme they never chose.
  if (!prefs.hydrated) return;
  const next = nextEditorTheme(
    prefs.prefs.editor.theme,
    familyId,
    mode,
    Object.keys(state.importedEditorThemes),
    opts.force,
  );
  if (next) prefs.updateEditor({ theme: next });
}

/**
 * Write one theme's record to `installed_themes.json`, fire-and-forget.
 *
 * Not awaited because every caller is a synchronous zustand action and the
 * UI must repaint on the new theme immediately — the file is a durability
 * concern, not a correctness one for this frame. A failure is reported and
 * dropped: the theme still works for the session, and blocking the paint on
 * a disk write would trade a visible feature for an invisible guarantee.
 */
function persistInstalled(
  familyId: string,
  name: string,
  editorThemes: ImportedEditorThemes,
  source: InstalledThemeSource | undefined,
  paletteEdited: boolean,
) {
  void api
    .saveInstalledTheme({
      familyId,
      name,
      source: source ?? null,
      identifier: editorThemes.identifier ?? null,
      version: editorThemes.version ?? null,
      installedAt: new Date().toISOString(),
      paletteEdited,
      editorThemes: { light: editorThemes.light, dark: editorThemes.dark },
    })
    .catch((e) => console.error("[theme] could not record installed theme:", e));
}

/**
 * Load `installed_themes.json` and arm Monaco with what it holds.
 *
 * Called once at startup, after the store has rehydrated. Ordering against
 * Monaco's own load does not matter: `registerImportedMonacoThemes` remembers
 * definitions it is given before Monaco exists and `registerMonacoThemes`
 * replays them, so whichever finishes first is fine.
 *
 * It also migrates: a build before the library moved to disk kept these in
 * localStorage, so anything still there is written out and dropped from the
 * persisted blob. Cheap, runs once, and the alternative is one person's
 * imported themes silently disappearing.
 */
export async function hydrateInstalledThemes(): Promise<void> {
  const state = useThemeStore.getState();
  const stranded = Object.entries(state.importedEditorThemes ?? {});

  let fromDisk: Record<string, ImportedEditorThemes> = {};
  try {
    const library = await api.listInstalledThemes();
    fromDisk = Object.fromEntries(
      library.themes.map((t) => [
        t.familyId,
        {
          label: t.name,
          source: t.source ?? null,
          identifier: t.identifier ?? null,
          version: t.version ?? null,
          light: t.editorThemes.light as monaco.editor.IStandaloneThemeData,
          dark: t.editorThemes.dark as monaco.editor.IStandaloneThemeData,
        },
      ]),
    );
  } catch (e) {
    // An unreadable library costs imported editor themes for this session and
    // nothing else — the palettes are elsewhere and the built-ins are intact.
    console.error("[theme] could not read the installed theme library:", e);
  }

  for (const [familyId, themes] of stranded) {
    if (fromDisk[familyId]) continue;
    fromDisk[familyId] = themes;
    persistInstalled(familyId, themes.label, themes, undefined, false);
  }

  useThemeStore.setState({ importedEditorThemes: fromDisk });
  registerImportedMonacoThemes(
    Object.entries(fromDisk).flatMap(([familyId, themes]) => [
      { id: monacoThemeId(familyId, "light"), data: themes.light },
      { id: monacoThemeId(familyId, "dark"), data: themes.dark },
    ]),
  );
}

/** The zustand/persist `migrate` logic, extracted so it's testable without
 *  touching localStorage — the persist config below just wraps it. */
export function migrateThemeState(persisted: unknown, version: number): ThemeState {
  // A v1 blob predates imported editor themes, so the field is absent rather
  // than empty. Defaulting it here (not at each read site) is what keeps
  // `deleteCustom`'s spread from being handed `undefined`.
  if (version === 1) {
    const state = persisted as ThemeState;
    return { ...state, importedEditorThemes: state.importedEditorThemes ?? {} };
  }

  const old = (persisted ?? {}) as LegacyPersistedState;
  const oldThemeId = old.themeId ?? "dark";

  // Duplicate each pre-refactor custom theme's single palette into both
  // variants — best-effort, the user edits the missing one later.
  const customThemes: ThemeFamily[] = (old.customThemes ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    builtin: false,
    light: { ...t.colors },
    dark: { ...t.colors },
  }));

  const legacyCustom = (old.customThemes ?? []).find((t) => t.id === oldThemeId);
  const mode: ThemeMode =
    legacyCustom?.mode ?? LEGACY_THEME_MODE_MAP[oldThemeId] ?? "dark";

  return {
    themeId: resolveLegacyThemeId(oldThemeId),
    mode,
    customThemes,
    // No pre-v1 blob can hold these — imports did not exist yet.
    importedEditorThemes: {},
    environmentOverrideId: null,
  } as ThemeState;
}

function resolveActiveFamily(state: ThemeState): ThemeFamily {
  // The environment override wins over the persisted default whenever it
  // resolves to a real theme — this is what makes assigning a theme to an
  // environment stick even if the user later changes their default theme
  // elsewhere (Settings > Appearance) while that environment stays active.
  if (state.environmentOverrideId) {
    const overridden = allThemes(state).find(
      (f) => f.id === state.environmentOverrideId,
    );
    if (overridden) return overridden;
  }
  return (
    allThemes(state).find((f) => f.id === state.themeId) ?? BUILT_IN_THEMES[0]
  );
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: "dark",
      mode: "dark",
      customThemes: [],
      importedEditorThemes: {},
      environmentOverrideId: null,
      setEnvironmentOverride: (themeId) => {
        set({
          environmentOverrideId: themeId ? resolveLegacyThemeId(themeId) : null,
        });
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      setThemeId: (id) => {
        set({ themeId: resolveLegacyThemeId(id) });
        applyTheme(resolveActiveFamily(get()), get().mode);
        syncEditorTheme(get(), resolveActiveFamily(get()).id, get().mode);
      },
      upsertCustom: (family) => {
        set((s) => {
          const customThemes = s.customThemes.some((f) => f.id === family.id)
            ? s.customThemes.map((f) => (f.id === family.id ? family : f))
            : [...s.customThemes, family];
          return { customThemes };
        });
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      addImportedTheme: (result, source) => {
        const { family, monacoThemes } = result;
        const editorThemes = pairEditorThemes(
          family.name,
          monacoThemes,
          source,
          result.identifier,
          result.packageVersion,
        );
        set((s) => ({
          customThemes: [...s.customThemes.filter((f) => f.id !== family.id), family],
          themeId: family.id,
          importedEditorThemes: editorThemes
            ? { ...s.importedEditorThemes, [family.id]: editorThemes }
            : s.importedEditorThemes,
        }));
        registerImportedMonacoThemes(monacoThemes.map((m) => ({ id: m.id, data: m.data })));
        applyTheme(family, get().mode);
        if (editorThemes) {
          // `force`: installing is the explicit "use this theme", so the
          // editor follows even when it was on a curated theme until now.
          syncEditorTheme(get(), family.id, get().mode, { force: true });
          persistInstalled(family.id, family.name, editorThemes, source, false);
        }
      },
      applyThemeUpdate: (result, source, keepPalette) => {
        const { family, monacoThemes } = result;
        const editorThemes = pairEditorThemes(
          family.name,
          monacoThemes,
          source,
          result.identifier,
          result.packageVersion,
        );
        set((s) => ({
          // The editor half is always replaced; the palette is only replaced
          // when the user has not edited it. See `paletteEdited` in
          // `themes::store` — an update must never be a silent overwrite of
          // someone's colour work.
          customThemes: keepPalette
            ? s.customThemes
            : s.customThemes.map((f) => (f.id === family.id ? family : f)),
          importedEditorThemes: editorThemes
            ? { ...s.importedEditorThemes, [family.id]: editorThemes }
            : s.importedEditorThemes,
        }));
        registerImportedMonacoThemes(monacoThemes.map((m) => ({ id: m.id, data: m.data })));
        applyTheme(resolveActiveFamily(get()), get().mode);
        syncEditorTheme(get(), resolveActiveFamily(get()).id, get().mode);
        if (editorThemes) {
          persistInstalled(family.id, family.name, editorThemes, source, keepPalette);
        }
      },
      deleteCustom: (id) => {
        set((s) => {
          // The editor themes go with the palette they arrived with:
          // leaving them behind would keep an id in the Preferences picker
          // whose family no longer exists.
          const { [id]: _removed, ...importedEditorThemes } = s.importedEditorThemes;
          return {
            customThemes: s.customThemes.filter((f) => f.id !== id),
            themeId: s.themeId === id ? "dark" : s.themeId,
            importedEditorThemes,
          };
        });
        unregisterImportedMonacoThemes([monacoThemeId(id, "light"), monacoThemeId(id, "dark")]);
        // The family is already out of `importedEditorThemes` by now, so the
        // editor is no longer "following" anything a plain call would
        // recognise — `force` is what moves a pref that still names an id
        // nothing defines. `resolveMonacoTheme` would cover the render, but
        // the Preferences picker would show a blank row for a deleted theme.
        const editorThemeWas = usePreferences.getState().prefs.editor.theme;
        syncEditorTheme(get(), resolveActiveFamily(get()).id, get().mode, {
          force:
            editorThemeWas === monacoThemeId(id, "light") ||
            editorThemeWas === monacoThemeId(id, "dark"),
        });
        void api
          .forgetInstalledTheme(id)
          .catch((e) => console.error("[theme] could not forget installed theme:", e));
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      duplicateAsCustom: (sourceId, name) => {
        const source =
          allThemes(get()).find((f) => f.id === sourceId) ?? BUILT_IN_THEMES[0];
        const id = customThemeId();
        const cloned: ThemeFamily = {
          id,
          name,
          builtin: false,
          light: { ...source.light },
          dark: { ...source.dark },
        };
        set((s) => ({
          customThemes: [...s.customThemes, cloned],
          themeId: id,
        }));
        applyTheme(cloned, get().mode);
        return id;
      },
      updateActiveColor: (key, value, variant) => {
        const family = resolveActiveFamily(get());
        const targetVariant = variant ?? get().mode;
        if (family.builtin) {
          // Auto-fork into a custom theme so built-ins stay pristine — both
          // variants are cloned as-is, only the target one receives the edit.
          const id = customThemeId();
          const cloned: ThemeFamily = {
            id,
            name: `${family.name} (custom)`,
            builtin: false,
            light: { ...family.light },
            dark: { ...family.dark },
          };
          cloned[targetVariant] = { ...cloned[targetVariant], [key]: value };
          set((s) => ({
            customThemes: [...s.customThemes, cloned],
            themeId: id,
          }));
          applyTheme(cloned, get().mode);
          return;
        }
        const updated: ThemeFamily = {
          ...family,
          [targetVariant]: { ...family[targetVariant], [key]: value },
        };
        set((s) => ({
          customThemes: s.customThemes.map((f) =>
            f.id === family.id ? updated : f,
          ),
        }));
        applyTheme(updated, get().mode);
        // Tell the backend this palette is now the user's, so a later update
        // refreshes only the editor half. Fire-and-forget and idempotent on
        // the Rust side, so calling it on every keystroke of a colour picker
        // is a no-op after the first — and the flag being set one edit late
        // is harmless, while being set never is not.
        if (get().importedEditorThemes[family.id]) {
          void api
            .markThemePaletteEdited(family.id)
            .catch((e) => console.error("[theme] could not flag palette edit:", e));
        }
      },
      setActiveMode: (mode) => {
        // O(1): the active family's `light-dark()` variables already contain
        // both variants — only which one the browser paints needs to change.
        if (get().mode === mode) return;
        set({ mode });
        applyColorScheme(mode);
        syncEditorTheme(get(), resolveActiveFamily(get()).id, mode);
      },
      resetActive: () => {
        const family = resolveActiveFamily(get());
        if (family.builtin) return;
        const baseline = BUILT_IN_THEMES[0];
        const reset: ThemeFamily = {
          ...family,
          light: { ...baseline.light },
          dark: { ...baseline.dark },
        };
        set((s) => ({
          customThemes: s.customThemes.map((f) =>
            f.id === family.id ? reset : f,
          ),
        }));
        applyTheme(reset, get().mode);
      },
    }),
    {
      name: STORAGE_KEYS.theme,
      version: 1, // no `version` was configured before this refactor — zustand treats an unversioned blob as 0
      migrate: migrateThemeState,
      // `importedEditorThemes` is absent on purpose: the file on disk owns
      // them, and `hydrateInstalledThemes` fills the in-memory map at
      // startup. Persisting them here as well would give two sources of
      // truth for the same ~20 KB per theme, in the one store that is read
      // synchronously before first paint.
      partialize: (state) => ({
        themeId: state.themeId,
        mode: state.mode,
        customThemes: state.customThemes,
      }),
      // Paint immediately from what localStorage holds; the editor themes
      // arrive later, from disk, via `hydrateInstalledThemes`. Splitting the
      // two is what keeps first paint synchronous.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const s = state as ThemeState;
        applyTheme(resolveActiveFamily(s), s.mode);
      },
    },
  ),
);

// Returns a reference-stable ThemeFamily object (an element of BUILT_IN_THEMES
// or state.customThemes). Safe to use as a zustand selector.
export function selectActiveTheme(state: ThemeState): ThemeFamily {
  return resolveActiveFamily(state);
}
// The global mode — a primitive, already reference-stable via Object.is.
export function selectActiveMode(state: ThemeState): ThemeMode {
  return state.mode;
}
// Note: do NOT add a selector that returns the concatenation of built-ins
// + customThemes, nor one that wraps family+mode in a fresh object — either
// would return a new reference every render and trigger an infinite
// re-render loop. Concatenate at the component level inside a useMemo over
// state.customThemes; read family and mode as two separate selectors.
