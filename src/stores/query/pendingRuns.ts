/**
 * Query tabs asked to run their buffer as soon as they mount (ADR #137).
 *
 * `openQueryTab(…, { run: true })` marks the new tab here, and the tab takes
 * the mark once it can run — through its own runner, so a batch from the
 * history goes down the batch path. Nothing outside a query tab calls a run
 * path.
 *
 * Session memory on purpose, not a field on the tab: tabs are persisted
 * (`tab_state.json`), and a flag that survived a restart would re-run a
 * statement — possibly a write — when the app reopened.
 */

import { create } from "zustand";

interface PendingRunsState {
  ids: ReadonlySet<string>;
  mark: (tabId: string) => void;
  /** Consume the mark: `true` exactly once per `mark`. */
  take: (tabId: string) => boolean;
}

export const usePendingRuns = create<PendingRunsState>((set, get) => ({
  ids: new Set(),
  mark: (tabId) => set((s) => ({ ids: new Set(s.ids).add(tabId) })),
  take: (tabId) => {
    if (!get().ids.has(tabId)) return false;
    set((s) => {
      const ids = new Set(s.ids);
      ids.delete(tabId);
      return { ids };
    });
    return true;
  },
}));
