/**
 * Persisted ring-buffer of the queries the user has run, ordered
 * newest-first. Capped at the user's `ui.queryHistoryLimit` preference
 * (falling back to `QUERY_HISTORY_LIMIT`) to keep localStorage bounded.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { QUERY_HISTORY_LIMIT, STORAGE_KEYS } from "@/lib/constants";
import { usePreferences } from "@/stores/preferences/preferences";
import type { QueryHistoryEntry } from "@/types";
import { shortId } from "@/lib/utils";

interface HistoryState {
  entries: QueryHistoryEntry[];
  /** Push a new entry at the front. Older entries beyond the limit are dropped. */
  add: (
    entry: Omit<QueryHistoryEntry, "id" | "ranAt"> & {
      id?: string;
      ranAt?: number;
    },
  ) => void;
  clear: () => void;
  /** Drop one connection's entries (the history panel's Clear, ADR #137). */
  clearFor: (connectionId: string) => void;
  /** Drop exactly these entries — what a filtered list shows. */
  removeMany: (ids: ReadonlySet<string>) => void;
}

export const useQueryHistory = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      add: (entry) =>
        set((s) => {
          const e: QueryHistoryEntry = {
            id: entry.id ?? shortId(),
            ranAt: entry.ranAt ?? Date.now(),
            sql: entry.sql,
            connectionId: entry.connectionId,
            elapsedMs: entry.elapsedMs,
            rowsAffected: entry.rowsAffected,
            error: entry.error,
          };
          const limit =
            usePreferences.getState().prefs.ui.queryHistoryLimit ||
            QUERY_HISTORY_LIMIT;
          return {
            entries: [e, ...s.entries].slice(0, limit),
          };
        }),
      clear: () => set({ entries: [] }),
      clearFor: (connectionId) =>
        set((s) => ({
          entries: s.entries.filter((e) => e.connectionId !== connectionId),
        })),
      removeMany: (ids) =>
        set((s) => ({ entries: s.entries.filter((e) => !ids.has(e.id)) })),
    }),
    { name: STORAGE_KEYS.queryHistory },
  ),
);
