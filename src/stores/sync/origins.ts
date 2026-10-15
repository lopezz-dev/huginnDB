/**
 * The registered shared origins (#108), cached for lookup by id.
 *
 * Deliberately separate from `originSync.ts`, which is the *pull* and the
 * notices it produces: that store is guarded by `isMainWindow()` (ADR #8),
 * holds in-memory decisions the user made, and writes `profiles.json` as it
 * goes. This one only ever reads, so it must also work in a secondary window —
 * the connection manager there needs to name the origin behind a row just as
 * much as the main window does.
 *
 * Why a store and not a hook per consumer: the connection rail and the MCP
 * settings panel both need `origin_id → name`, and a per-consumer fetch is N
 * `list_origins` calls and N versions of the truth. Renaming an origin in
 * Settings has to reach a manager dialog that is already open, which one hook's
 * mount-time fetch can never do.
 *
 * Invalidation is the `huginndb://origins-changed` event, via
 * `lib/bridges/origins-bridge.ts`. `load()` is also called once at startup, for
 * the window that opens before anything has changed.
 *
 * Selector note (gotcha #1): `byId` is built inside `set`, never derived in a
 * selector, so `useOrigins((s) => s.byId)` is reference-stable and
 * `useOriginName` returns a plain string.
 */

import { create } from "zustand";

import { api } from "@/lib/tauri";
import type { Origin } from "@/types";

interface OriginsState {
  /** The global registry, in `list_origins` order (insertion). */
  origins: Origin[];
  /** The same entries by id, for the row-level name lookup. */
  byId: Record<string, Origin>;
  /** False until the first `load()` resolves, so a caller can tell "no origins
   *  registered" from "not asked yet" — the rail hides its provenance filter in
   *  the first case and must not flicker it in the second. */
  loaded: boolean;
  /** Re-read the registry. Never throws: an unreachable backend leaves the
   *  cache as it was, and a row falls back to an unnamed "shared" badge, which
   *  is strictly better than a manager dialog that failed to open. */
  load: () => Promise<void>;
}

export const useOrigins = create<OriginsState>((set) => ({
  origins: [],
  byId: {},
  loaded: false,

  load: async () => {
    let origins: Origin[];
    try {
      origins = await api.listOrigins();
    } catch (e) {
      console.error("[origins] could not list origins", e);
      set({ loaded: true });
      return;
    }
    const byId: Record<string, Origin> = {};
    for (const o of origins) byId[o.id] = o;
    set({ origins, byId, loaded: true });
  },
}));

/**
 * Name of the origin that owns a profile, or `null` when it is local or the
 * origin has been unregistered (a dangling `origin_id`, which is what
 * `useOriginSync.reconcileOrphans` reports on). Callers render their own copy
 * for that second case — the name is genuinely unrecoverable by then.
 */
export function useOriginName(originId: string | null | undefined): string | null {
  return useOrigins((s) => (originId ? s.byId[originId]?.name ?? null : null));
}
