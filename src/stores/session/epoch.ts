/**
 * The Dates panel's input: what is being converted and where it came from.
 *
 * Deliberately **not persisted**. A cell's value is session material — it can
 * be a row of production data — and the panel has no use for yesterday's
 * timestamp on the next launch. The panel opens empty and fills from either a
 * cell's "View as date" or whatever the user pastes.
 *
 * The other zone and the inverse converter's local/UTC toggle are not here:
 * they are the panel's own UI state and live in its component.
 */

import { create } from "zustand";
import type { Driver } from "@/types";
import type { EpochUnit } from "@/lib/epoch/epoch";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";

/** Where a value was sent from, shown above the input so the user knows which
 *  cell they are looking at. Every field is optional: a value typed by hand
 *  has no source at all. */
export interface EpochSource {
  /** Table, view or collection name. */
  relation?: string;
  /** Column or document field path — also what the SQL expression names. */
  column: string;
  /** A short row identifier (`id 48211`), when the grid knows one. */
  row?: string;
  /** Picks the SQL dialect of the "In SQL" card. */
  driver?: Driver;
}

interface EpochState {
  /** The digits in the input box, exactly as typed or received. */
  input: string;
  /** `auto` follows the digit count; anything else is the user overriding it. */
  unit: EpochUnit | "auto";
  source: EpochSource | null;
  /** The value reached the frontend as a JSON number past 2^53, so its last
   *  digits were rounded before the panel ever saw it. */
  approximate: boolean;

  /** Hand a cell's value to the panel and bring the panel on screen. */
  openFromCell: (digits: string, source: EpochSource, approximate: boolean) => void;
  /** The user edited the input: it no longer comes from any cell. */
  setInput: (input: string) => void;
  setUnit: (unit: EpochUnit | "auto") => void;
}

export const useEpochPanel = create<EpochState>()((set) => ({
  input: "",
  unit: "auto",
  source: null,
  approximate: false,

  openFromCell: (digits, source, approximate) => {
    set({ input: digits, unit: "auto", source, approximate });
    useSessionPanelLayout.getState().showRightPanel("dates");
  },
  setInput: (input) => set({ input, source: null, approximate: false }),
  setUnit: (unit) => set({ unit }),
}));
