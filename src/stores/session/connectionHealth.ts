/**
 * Tracks connections the backend's keepalive heartbeat has flagged as
 * lost (see `src-tauri/src/keepalive.rs`). Populated by
 * `lib/connection-health-bridge.ts`; cleared whenever the connection is
 * (re)connected or explicitly disconnected — see `stores/connections.ts`.
 *
 * Only top-level profile connections get a heartbeat (not the synthetic
 * `<id>::db::<name>` multi-DB children), so keys here are always plain
 * profile ids.
 *
 * Also tracks connections that are open but were **edited** since — pointed
 * at another database, host or user. Saving a profile leaves its open pool
 * alone (closing it would cut a running query and drop unsaved grid edits),
 * so the rows offer the same one-click reconnect a lost connection gets.
 * That set is the backend's answer (`edited_connections`), never inferred
 * here: it is re-asked after every `profiles-changed` and every connect or
 * disconnect, because reusing a pool another window opened does not make it
 * any less stale.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";

interface ConnectionHealthState {
  /** Profile id -> the ping error that flagged it lost. */
  lost: Record<string, string>;
  /** Profile ids open with settings their profile no longer has. */
  edited: Record<string, true>;
  markLost: (id: string, error: string) => void;
  clear: (id: string) => void;
  /** Re-ask the backend which open connections were edited. Best effort: a
   *  failure keeps whatever was known. */
  refreshEdited: () => Promise<void>;
}

export const useConnectionHealth = create<ConnectionHealthState>((set) => ({
  lost: {},
  edited: {},
  markLost: (id, error) =>
    set((s) => ({ lost: { ...s.lost, [id]: error } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.lost)) return s;
      const next = { ...s.lost };
      delete next[id];
      return { lost: next };
    }),
  refreshEdited: async () => {
    try {
      const ids = await api.editedConnections();
      set({ edited: Object.fromEntries(ids.map((id) => [id, true as const])) });
    } catch {
      // Keep the last answer; the next event asks again.
    }
  },
}));
