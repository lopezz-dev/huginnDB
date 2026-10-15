/**
 * Outer shell layout — activity-bar-driven docked panels (Schema, the right
 * dock, Console) plus the cell editor split inside the workspace island.
 *
 * Replaces the old outer `DockviewReact` (5 equal-rank panels) with fixed
 * roles: two side panels toggled from an activity bar, a bottom console
 * dock, and a cell-editor split owned by the island itself. Dockview gave
 * sash-resize and `toJSON` persistence for free, but its panel API has no
 * `setVisible` (see `DockviewPanelApi` vs `GridviewPanelApi` in
 * `dockview-core`) — there's no way to collapse a panel to 0px without
 * removing it, and removing/re-adding reflows siblings proportionally
 * (the same effect `trackSchemaWidthAroundSideEditor` used to patch around
 * for the old side-editor panel). Plain state + hand-rolled sashes (see
 * `Sash.tsx`) sidestep that entirely: a closed panel is just `width: 0` in
 * CSS, no dockview involved.
 *
 * **The right dock holds more than one thing, so it is a selection, not a
 * boolean.** It used to be `savedOpen: boolean` because Saved Queries was
 * its only occupant. With Pulse joining it, the right activity bar became a
 * selector — clicking the active entry closes the dock, clicking the other
 * switches to it — which a per-panel boolean cannot express without letting
 * both be "open" at once against a single slot. Hence `rightPanel:
 * RightPanelId | null`. Each occupant keeps its **own** width (Saved reads
 * fine at 260px, Pulse wants 320 for its two-up metric tiles), and
 * `lastRightPanel` remembers which one the edge toggle in `LayoutToggles`
 * should bring back — that button toggles the *dock*, not any one panel.
 *
 * Every consumer reads primitive fields (booleans/numbers/a string union) as
 * selectors — reference-stable by construction, per the Zustand rule in
 * CLAUDE.md.
 */

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";

const SCHEMA_WIDTH_DEFAULT = 280;
const SAVED_WIDTH_DEFAULT = 260;
const PULSE_WIDTH_DEFAULT = 320;
/** Wider than Pulse's 320: a chat needs a measure. Prose wrapping every six
 *  words reads as broken, and the SQL blocks are Monaco editors whose lines
 *  should not wrap at all if it can be helped. */
const AI_WIDTH_DEFAULT = 360;
/** Wider than Saved: each row carries a name, a publisher/version line, a
 *  two-line description and an install button, and below ~300px the button
 *  wraps under the text and the list stops scanning as a list. */
const EXTENSIONS_WIDTH_DEFAULT = 340;
const CONSOLE_HEIGHT_DEFAULT = 190;
const SIDE_EDITOR_WIDTH_DEFAULT = 420;

/** The panels that can occupy the right dock. One at a time. */
export type RightPanelId = "saved" | "pulse" | "ai" | "extensions";

/** The tabs of the bottom dock. One shows at a time; the dock's height is
 *  shared, since both want "as many lines as you can spare". */
export type BottomTabId = "console" | "terminal";

export const PANEL_CLAMPS = {
  schemaWidth: { min: 200, max: 600 },
  savedWidth: { min: 200, max: 600 },
  pulseWidth: { min: 260, max: 640 },
  // A higher floor than the others: below ~300px the composer, the model name
  // and the send button stop fitting on one line, and a Monaco block becomes
  // a horizontal scrollbar with three characters above it.
  aiWidth: { min: 300, max: 720 },
  extensionsWidth: { min: 300, max: 720 },
  consoleHeight: { min: 120, max: 600 },
  sideEditorWidth: { min: 280, max: 720 },
} as const;

/** Which `PANEL_CLAMPS` key holds a given right-dock panel's width. Exported
 *  so the shell can hand the right `nudgePanel` key to its sash without
 *  spelling the mapping a second time. */
export function rightPanelSizeKey(
  id: RightPanelId,
): "savedWidth" | "pulseWidth" | "aiWidth" | "extensionsWidth" {
  // A total map rather than a chain of ternaries: adding an occupant to
  // `RightPanelId` without giving it a width is then a compile error here,
  // which is the one place the mapping is spelled.
  const KEYS: Record<
    RightPanelId,
    "savedWidth" | "pulseWidth" | "aiWidth" | "extensionsWidth"
  > = {
    saved: "savedWidth",
    pulse: "pulseWidth",
    ai: "aiWidth",
    extensions: "extensionsWidth",
  };
  return KEYS[id];
}

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `localStorage.setItem` on every write, trailing-edge throttled to
 * `delayMs`. A live sash drag calls the store's persisted `set()` on every
 * animation frame (see `nudgePanel`'s doc comment), and `persist`'s default
 * storage `JSON.stringify`s the whole state and writes it synchronously on
 * every one of those — a drag was writing to disk roughly 60 times a
 * second. `flush` forces the last pending write out immediately; the four
 * `Sash` call sites use it on `onDraggingChange(false)` so the on-disk value
 * never lags behind by up to `delayMs` after the user actually lets go.
 */
function createThrottledStorage(delayMs: number): {
  storage: StateStorage;
  flush: () => void;
} {
  let pendingKey: string | null = null;
  let pendingValue: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingKey !== null && pendingValue !== null) {
      localStorage.setItem(pendingKey, pendingValue);
      pendingKey = null;
      pendingValue = null;
    }
  }

  return {
    flush,
    storage: {
      getItem: (name) => localStorage.getItem(name),
      setItem: (name, value) => {
        pendingKey = name;
        pendingValue = value;
        if (timer === null) timer = setTimeout(flush, delayMs);
      },
      // A removal (e.g. clearing persisted state) is rare and should never
      // be delayed behind a pending write.
      removeItem: (name) => {
        flush();
        localStorage.removeItem(name);
      },
    },
  };
}

const { storage: throttledStorage, flush: flushPanelLayoutStorage } =
  createThrottledStorage(250);

/** Force any pending (throttled) panel-layout write to disk immediately.
 *  Called on `Sash`'s `onDraggingChange(false)` — see
 *  `createThrottledStorage`'s doc comment. */
export { flushPanelLayoutStorage };

/** The keys `nudgePanel` may adjust — exactly `PANEL_CLAMPS`'s keys. */
export type PanelSizeKey = keyof typeof PANEL_CLAMPS;

interface PanelLayoutState {
  schemaOpen: boolean;
  schemaWidth: number;
  /** `null` = the right dock is collapsed. */
  rightPanel: RightPanelId | null;
  /** What `toggleRightDock` reopens. Survives a collapse, unlike `rightPanel`. */
  lastRightPanel: RightPanelId;
  savedWidth: number;
  pulseWidth: number;
  aiWidth: number;
  extensionsWidth: number;
  /** Whether the bottom dock is open — whichever tab it shows. Kept under
   *  its pre-terminal name so a persisted layout reads unchanged. */
  consoleOpen: boolean;
  consoleHeight: number;
  /** Which tab the bottom dock shows. */
  bottomTab: BottomTabId;
  sideEditorOpen: boolean;
  sideEditorWidth: number;

  toggleSchema: () => void;
  openSchema: () => void;
  /** Activity-bar behaviour: the active entry collapses the dock, any other
   *  switches to it. */
  selectRightPanel: (id: RightPanelId) => void;
  /** Edge-toggle behaviour (`LayoutToggles`): collapse, or reopen whichever
   *  panel was last shown. */
  toggleRightDock: () => void;
  /** Status bar / Mod+Backquote: show the Console tab, or close the dock when it
   *  already is showing. */
  toggleConsole: () => void;
  /** The rail's terminal button: same, for the Terminal tab. */
  toggleTerminal: () => void;
  /** Open the dock on `tab` whatever it showed — a tab header click, or "open
   *  a new terminal" from somewhere that must not toggle it shut. */
  showBottomTab: (tab: BottomTabId) => void;
  /** A module was switched off in Settings: take its panel off screen (and out
   *  of what the edge toggle would bring back) without touching the others. */
  retirePanel: (id: RightPanelId | BottomTabId) => void;
  /** Adjust one panel's size by a delta, reading the CURRENT value from
   *  inside the store update rather than from whatever the caller's render
   *  closed over. `Sash`'s `onResize` fires many times per drag — a caller
   *  reading its own `useSessionPanelLayout` selector and computing
   *  `current + delta` in its own render scope is reading a value that may
   *  already be stale by the time this runs, which is what let the panel
   *  edge escape the cursor at the clamp boundary (the delta kept adding to
   *  a value the store had already clamped past). */
  nudgePanel: (key: PanelSizeKey, delta: number) => void;
  openSideEditor: () => void;
  closeSideEditor: () => void;
  resetLayout: () => void;
}

type PanelLayoutData = Omit<
  PanelLayoutState,
  | "toggleSchema"
  | "openSchema"
  | "selectRightPanel"
  | "toggleRightDock"
  | "toggleConsole"
  | "toggleTerminal"
  | "showBottomTab"
  | "retirePanel"
  | "nudgePanel"
  | "openSideEditor"
  | "closeSideEditor"
  | "resetLayout"
>;

const DEFAULTS: PanelLayoutData = {
  schemaOpen: true,
  schemaWidth: SCHEMA_WIDTH_DEFAULT,
  rightPanel: null,
  lastRightPanel: "saved",
  savedWidth: SAVED_WIDTH_DEFAULT,
  pulseWidth: PULSE_WIDTH_DEFAULT,
  aiWidth: AI_WIDTH_DEFAULT,
  extensionsWidth: EXTENSIONS_WIDTH_DEFAULT,
  consoleOpen: false,
  consoleHeight: CONSOLE_HEIGHT_DEFAULT,
  bottomTab: "console",
  sideEditorOpen: false,
  sideEditorWidth: SIDE_EDITOR_WIDTH_DEFAULT,
};

/** The v1 shape, kept only so `migrate` can read one. */
interface PanelLayoutV1 {
  schemaOpen?: boolean;
  schemaWidth?: number;
  savedOpen?: boolean;
  savedWidth?: number;
  consoleOpen?: boolean;
  consoleHeight?: number;
  sideEditorOpen?: boolean;
  sideEditorWidth?: number;
}

/**
 * v1 → v2: the right dock's boolean becomes a selection.
 *
 * Written out field by field rather than spread wholesale because the point
 * of the migration is that a v1 blob has no `rightPanel` and *does* have a
 * `savedOpen` that no longer means anything — a spread would carry the dead
 * key across and leave the dock collapsed for everyone who had Saved open.
 */
function migrateV1(v1: PanelLayoutV1): PanelLayoutData {
  return {
    ...DEFAULTS,
    schemaOpen: v1.schemaOpen ?? DEFAULTS.schemaOpen,
    schemaWidth: v1.schemaWidth ?? DEFAULTS.schemaWidth,
    savedWidth: v1.savedWidth ?? DEFAULTS.savedWidth,
    consoleOpen: v1.consoleOpen ?? DEFAULTS.consoleOpen,
    consoleHeight: v1.consoleHeight ?? DEFAULTS.consoleHeight,
    sideEditorOpen: v1.sideEditorOpen ?? DEFAULTS.sideEditorOpen,
    sideEditorWidth: v1.sideEditorWidth ?? DEFAULTS.sideEditorWidth,
    rightPanel: v1.savedOpen ? "saved" : null,
    lastRightPanel: "saved",
  };
}

/**
 * A bottom-dock toggle for one tab: the tab that is showing closes the dock;
 * any other state — closed, or open on the other tab — shows this one. So the
 * status bar's console button never closes a terminal the user was looking at
 * to "toggle the console", it switches to the console instead.
 */
export function toggleBottom(
  s: Pick<PanelLayoutData, "consoleOpen" | "bottomTab">,
  tab: BottomTabId,
): Pick<PanelLayoutData, "consoleOpen" | "bottomTab"> {
  return s.consoleOpen && s.bottomTab === tab
    ? { consoleOpen: false, bottomTab: tab }
    : { consoleOpen: true, bottomTab: tab };
}

/**
 * Take a switched-off module's panel off screen. A right-dock occupant closes
 * the dock if it was showing and stops being what the edge toggle reopens
 * (Saved is always there to fall back on); the terminal hands the bottom dock
 * back to the console, closing it if the terminal was what showed.
 */
export function retire(
  s: Pick<PanelLayoutData, "rightPanel" | "lastRightPanel" | "consoleOpen" | "bottomTab">,
  id: RightPanelId | BottomTabId,
): Partial<PanelLayoutData> {
  if (id === "terminal") {
    if (s.bottomTab !== "terminal") return {};
    return { bottomTab: "console", consoleOpen: false };
  }
  if (id === "console") return {};
  const patch: Partial<PanelLayoutData> = {};
  if (s.rightPanel === id) patch.rightPanel = null;
  if (s.lastRightPanel === id) patch.lastRightPanel = "saved";
  return patch;
}

export const useSessionPanelLayout = create<PanelLayoutState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      toggleSchema: () => set((s) => ({ schemaOpen: !s.schemaOpen })),
      openSchema: () => set({ schemaOpen: true }),
      selectRightPanel: (id) =>
        set((s) =>
          s.rightPanel === id
            ? { rightPanel: null }
            : { rightPanel: id, lastRightPanel: id },
        ),
      toggleRightDock: () =>
        set((s) =>
          s.rightPanel === null
            ? { rightPanel: s.lastRightPanel }
            : { rightPanel: null },
        ),
      toggleConsole: () => set((s) => toggleBottom(s, "console")),
      toggleTerminal: () => set((s) => toggleBottom(s, "terminal")),
      showBottomTab: (tab) => set({ consoleOpen: true, bottomTab: tab }),
      retirePanel: (id) => set((s) => retire(s, id)),
      nudgePanel: (key, delta) =>
        set((s) => ({ [key]: clamp(s[key] + delta, PANEL_CLAMPS[key]) })),
      openSideEditor: () => set({ sideEditorOpen: true }),
      closeSideEditor: () => set({ sideEditorOpen: false }),
      resetLayout: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEYS.panelLayout,
      version: 2,
      storage: createJSONStorage(() => throttledStorage),
      migrate: (persisted, version) => {
        if (version === 2) return persisted as PanelLayoutState;
        if (version === 1) return migrateV1((persisted ?? {}) as PanelLayoutV1);
        return { ...DEFAULTS };
      },
    },
  ),
);

/** Read-only accessor for the side-editor's open state, for call sites
 *  (`DataGrid`, `CellEditor`) that only need to check/open it imperatively
 *  outside of a React render. */
export function isSideEditorOpen(): boolean {
  return useSessionPanelLayout.getState().sideEditorOpen;
}
