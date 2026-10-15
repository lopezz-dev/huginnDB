/**
 * Open state for the shared-origin document editor (#155).
 *
 * Same shape and the same reason as `connectionDialog.ts`: the overlay has more
 * than one entry point — Settings → Origins, the read-only banner in
 * `ConnectionDialog` for a connection an origin publishes, and the republish
 * prompt's conflict hand-off — and a local `useState` in any of them would make
 * it unreachable from the others.
 *
 * Only the *identity* of the document lives here. The draft itself is local
 * state inside `OriginEditorOverlay`: it is a document being composed, not
 * application state, and putting it in a store would invite exactly the thing
 * `origin_doc`'s first invariant forbids — a draft that leaks into (or reads
 * from) this machine's own `profiles.json` / `tab_state.json`.
 *
 * `open` puts aside the workbench it was opened from (`suspend`), because the
 * overlay is a full-screen sibling of it, not a dialog stacked on one, and
 * `close` gives that same surface back (`resume`), saved or not (ADR #101).
 * The surface is remembered by name rather than by asking every one to resume:
 * which one to reopen is a fact about how the editor was entered, and keeping
 * it here is what makes "only the one that was set aside" hold by construction.
 */

import { create } from "zustand";

import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";

/**
 * The workbench surfaces the editor can be opened from. Each is a workbench
 * itself, so at most one is open at a time, and the first to step aside is
 * the one to give back.
 */
const surfaces = {
  settings: () => useSettingsDialog.getState(),
  connections: () => useConnectionDialog.getState(),
} satisfies Record<string, () => { suspend: () => boolean; resume: () => void }>;

export type OriginEditorReturn = keyof typeof surfaces;

interface OriginEditorState {
  /** The origin whose document is open, or `null` when nothing is. */
  originId: string | null;
  /** The surface `open` put aside and `close` gives back, or `null` when the
   *  editor was opened with neither Settings nor the connection manager up. */
  returnTo: OriginEditorReturn | null;
  /** Open the editor on an origin's document. */
  open: (originId: string) => void;
  close: () => void;
}

export const useOriginEditor = create<OriginEditorState>((set, get) => ({
  originId: null,
  returnTo: null,
  open: (originId) => {
    // Never a dialog on top of a dialog: this is a full-screen surface, and
    // Radix would trap focus in whichever mounted last. Reopening on another
    // origin keeps the surface the first open set aside.
    const returnTo =
      get().returnTo ??
      (Object.keys(surfaces) as OriginEditorReturn[]).find((key) =>
        surfaces[key]().suspend(),
      ) ??
      null;
    set({ originId, returnTo });
  },
  close: () => {
    const { returnTo } = get();
    set({ originId: null, returnTo: null });
    if (returnTo) surfaces[returnTo]().resume();
  },
}));
