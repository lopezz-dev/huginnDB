/**
 * Background sync of the (global, #108) registered shared origins, and the
 * per-connection notices it produces.
 *
 * Two halves, deliberately kept apart from the connection stores:
 *
 * * **The pull.** `syncAll()` walks the registered origins and calls
 *   `syncOrigin` for each. Runs at launch, on a long interval, and on demand.
 * * **The notices.** A connection that vanished from its origin's file is
 *   surfaced as a persistent, non-blocking entry in `vanished` — the same shape
 *   as `connectionHealth`'s lost-connection flag, and for the same reason: a
 *   background task must never open a modal. There is nobody guaranteed to be
 *   watching, and a `window.confirm` fired mid-query steals the keystroke.
 *
 * Nothing here deletes on its own. The backend only ever reports a
 * disappearance; `adopt` and `retire` are the user acting on it.
 *
 * Selector note (gotcha #1): components read `vanished` / `syncing` raw and
 * derive with `useMemo`.
 */

import { create } from "zustand";
import { repeating } from "@/lib/schedule";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { isMainWindow } from "@/lib/window";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import type { Origin } from "@/types";

/**
 * How often to re-check the shared files. Deliberately the updater's tier
 * (hours), not the keepalive's (minutes): a shared config file doesn't change by
 * the minute, and twenty workstations polling an SMB share continuously is felt
 * on the file server. Launch + this + a manual "Sync now" covers it.
 */
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** One connection that is no longer published by the origin it came from. */
export interface VanishedConnection {
  profileId: string;
  originId: string;
  originName: string;
  /** RFC 3339; when the sync that noticed it ran. */
  noticedAt: string;
}

/** One environment mirror (#108) whose origin stopped publishing its bundle. */
export interface VanishedEnvironment {
  environmentId: string;
  originId: string;
  originName: string;
  /** RFC 3339; when the sync that noticed it ran. */
  noticedAt: string;
}

interface OriginSyncState {
  /** Keyed by profile id so a component can look one up while rendering a row. */
  vanished: Record<string, VanishedConnection>;
  /** Keyed by environment id, same shape/purpose as `vanished` one level up. */
  vanishedEnvironments: Record<string, VanishedEnvironment>;
  /**
   * Profile ids the user has already decided about. Filtered out of every later
   * sync so a connection that stays absent from the file — which it will, that
   * being the point — cannot re-raise its notice on the next poll.
   */
  decided: string[];
  /** Same as `decided`, for environment ids. Kept as a separate list: the two
   *  id spaces never overlap, but conflating them would make either lookup
   *  ambiguous to read. */
  decidedEnvironments: string[];
  /** Ids whose metadata update is waiting for the connection to close. */
  deferred: string[];
  syncing: boolean;
  /** Per-origin failure text (unreachable share, unparseable file, missing
   *  passphrase), keyed by origin id so it can be shown next to that origin. */
  errors: Record<string, string>;

  syncAll: () => Promise<void>;
  /** Keep the connection, as the user's own: clears its `origin_id`. */
  adopt: (profileId: string) => Promise<void>;
  /** Drop the connection and its stored credentials. */
  retire: (profileId: string) => Promise<void>;
  /** `adopt` every currently vanished connection. Not destructive — same
   *  reason the per-row "Keep as mine" button needs no confirmation — so the
   *  caller doesn't need one either. */
  adoptAllVanished: () => Promise<void>;
  /** `retire` every currently vanished connection. Irreversible (each one's
   *  keychain entry goes with it), so the caller MUST confirm first — this
   *  does not prompt itself, same contract as `retire`. Best-effort per
   *  profile: one failure doesn't stop the rest, mirroring
   *  `ConnectionDialog.performBulkDelete`. */
  retireAllVanished: () => Promise<void>;
  /** Keep the environment, as the user's own: clears its `originId`/
   *  `originSourceId` via `adopt_environment`. */
  adoptEnvironment: (environmentId: string) => Promise<void>;
  /** Drop the environment and the session state it remembered. */
  retireEnvironment: (environmentId: string) => Promise<void>;
  /**
   * Raise a vanished-notice for every connection and environment the given
   * origin owns, *before* it's actually removed from the registry.
   *
   * This is the immediate, well-named path: it runs synchronously from
   * `OriginsSection`'s remove flow, while the origin's name is still known, and
   * reuses the exact same decide-later flow a real sync produces instead of
   * inventing a second one. `syncAll()`'s reconciliation sweep (`reconcileOrphans`)
   * is the durable fallback for the one thing this can't cover: the notice is
   * in-memory only, so it's gone the moment the app closes before the user acts
   * on it. Without either path, the profile/environment keeps its `origin_id`
   * (removing an origin deliberately leaves what it imported in place — see
   * `remove_origin`'s doc comment) forever, which makes
   * `ConnectionDialog.isFromOrigin` (and the equivalent environment gating)
   * block editing/deleting it, with no `adopt`/`retire` ever offered again.
   */
  noticeOriginRemoved: (origin: Origin) => void;
}

export const useOriginSync = create<OriginSyncState>((set, get) => ({
  vanished: {},
  vanishedEnvironments: {},
  decided: [],
  decidedEnvironments: [],
  deferred: [],
  syncing: false,
  errors: {},

  syncAll: async () => {
    // Origins are global, but `tab_state.json` (where they live) is still
    // main-window-owned (ADR #8), and this sweep writes `profiles.json`
    // too. A secondary window syncing would race the main one's own writes.
    if (!isMainWindow()) return;
    if (get().syncing) return;
    set({ syncing: true });

    let origins: Origin[] = [];
    try {
      origins = await api.listOrigins();
    } catch (e) {
      console.error("[originSync] could not list origins", e);
      set({ syncing: false });
      return;
    }

    const errors: Record<string, string> = {};
    const found: Record<string, VanishedConnection> = {};
    const foundEnvironments: Record<string, VanishedEnvironment> = {};
    const held: string[] = [];
    let touchedProfiles = false;
    let touchedEnvironments = false;
    // Local password overrides this sweep expired — the only sync outcome
    // still worth a notification, since a credential swapping underneath
    // somebody without a word can break their next connection.
    let supersededSecrets = 0;

    for (const origin of origins) {
      try {
        const report = await api.syncOrigin(origin.id);
        if (report.added.length > 0 || report.updated.length > 0) {
          touchedProfiles = true;
        }
        if (report.environmentsAdded.length > 0 || report.environmentsUpdated.length > 0) {
          touchedEnvironments = true;
        }
        held.push(...report.deferred);
        if (report.superseded && report.superseded.length > 0) {
          // The backend wrote `profiles.json` to clear the flags, so the
          // profile list this window holds is behind by a field the banner
          // renders from.
          touchedProfiles = true;
          supersededSecrets += report.superseded.length;
        }
        // `suspicious` already means the backend cleared `vanished`, so this
        // loop simply finds nothing — no special case needed here, but the
        // invariant is worth knowing when reading the report shape.
        for (const profileId of report.vanished) {
          if (get().decided.includes(profileId)) continue;
          found[profileId] = {
            profileId,
            originId: origin.id,
            originName: origin.name,
            noticedAt: report.syncedAt,
          };
        }
        // Same reasoning as above, one level up: `environmentsSuspicious`
        // already means the backend cleared `environmentsVanished`.
        for (const environmentId of report.environmentsVanished) {
          if (get().decidedEnvironments.includes(environmentId)) continue;
          foundEnvironments[environmentId] = {
            environmentId,
            originId: origin.id,
            originName: origin.name,
            noticedAt: report.syncedAt,
          };
        }
      } catch (e) {
        // A failed read is not evidence of anything: the backend touched
        // nothing, so neither do we. Record it against the origin and move on to
        // the next one rather than aborting the whole sweep.
        errors[origin.id] = String(e);
      }
    }

    // Safety net for anything the loop above could never have found: it only
    // ever iterates origins that still exist. See `reconcileOrphans`.
    reconcileOrphans(
      found,
      foundEnvironments,
      get().decided,
      get().decidedEnvironments,
      new Set(origins.map((o) => o.id)),
    );

    // Replace rather than merge: an entry that reappeared in the file (the
    // publisher restored it, or the earlier read was simply wrong) must stop
    // being flagged without anyone having to dismiss it. `deferred` is replaced
    // for the same reason and one more — it used to be unioned, so an id that
    // had since been applied stayed in the list forever and kept arming a
    // pointless re-sync. Each sweep recomputes it from what the backend actually
    // held back this time. An origin that failed to read contributes nothing, so
    // its held-back ids drop out until the next successful sweep re-reports
    // them; the trigger below and the poll both re-check, so this self-heals.
    set({
      vanished: found,
      vanishedEnvironments: foundEnvironments,
      deferred: held,
      errors,
      syncing: false,
    });
    if (touchedProfiles) await useConnections.getState().refreshProfiles();
    if (touchedEnvironments) await useEnvironments.getState().load();

    // Its own notification, and a warning rather than an info: the password
    // this machine was deliberately using has just been replaced by the
    // published one. That is the correct outcome — the publisher republished,
    // so the override had done its job — but a credential changing underneath
    // somebody without a word is exactly the surprise the vanished notices
    // exist to prevent, one level down.
    if (supersededSecrets > 0) {
      notify.warning(
        i18n.t("origins.secretOverridesSuperseded", { count: supersededSecrets }),
      );
    }
  },

  adopt: async (profileId) => {
    const profile = useConnections
      .getState()
      .profiles.find((p) => p.id === profileId);
    if (!profile) return;
    // Clearing `origin_id` is what makes it locally editable again — and stops
    // any future origin from claiming it.
    await useConnections.getState().save({ ...profile, origin_id: null });
    set((s) => ({
      decided: [...s.decided, profileId],
      vanished: withoutKey(s.vanished, profileId),
    }));
  },

  retire: async (profileId) => {
    // `remove` deletes the profile and its keychain entries. The caller is
    // responsible for confirming first (a real confirm dialog) — this is the
    // deletion the user chose, not one the shared file imposed.
    await useConnections.getState().remove(profileId);
    set((s) => ({
      decided: [...s.decided, profileId],
      vanished: withoutKey(s.vanished, profileId),
    }));
  },

  adoptAllVanished: async () => {
    // Sequential, not `Promise.all`: each call ends in `useConnections.save`,
    // which writes `profiles.json` whole — parallel writes would race and the
    // loser's `origin_id: null` could be clobbered by an in-flight save that
    // started from a stale snapshot.
    for (const profileId of Object.keys(get().vanished)) {
      await get().adopt(profileId);
    }
  },

  retireAllVanished: async () => {
    for (const profileId of Object.keys(get().vanished)) {
      try {
        await get().retire(profileId);
      } catch {
        // Best-effort, same reasoning as `ConnectionDialog.performBulkDelete`:
        // one keychain/disk failure shouldn't strand the rest of the batch.
      }
    }
  },

  adoptEnvironment: async (environmentId) => {
    await api.adoptEnvironment(environmentId);
    await useEnvironments.getState().load();
    set((s) => ({
      decidedEnvironments: [...s.decidedEnvironments, environmentId],
      vanishedEnvironments: withoutKey(s.vanishedEnvironments, environmentId),
    }));
  },

  retireEnvironment: async (environmentId) => {
    // `remove` deletes the environment and the session state it remembered.
    // The caller is responsible for confirming first (a real confirm dialog).
    await useEnvironments.getState().remove(environmentId);
    set((s) => ({
      decidedEnvironments: [...s.decidedEnvironments, environmentId],
      vanishedEnvironments: withoutKey(s.vanishedEnvironments, environmentId),
    }));
  },

  noticeOriginRemoved: (origin) => {
    const noticedAt = new Date().toISOString();
    const ownedProfiles = useConnections
      .getState()
      .profiles.filter((p) => p.origin_id === origin.id);
    const ownedEnvironments = useEnvironments
      .getState()
      .environments.filter((e) => e.originId === origin.id);
    if (ownedProfiles.length === 0 && ownedEnvironments.length === 0) return;
    set((s) => {
      const found = { ...s.vanished };
      for (const profile of ownedProfiles) {
        // A connection already decided about (adopted/retired earlier, e.g.
        // via a genuine sync) shouldn't be re-raised just because the origin
        // itself is now gone.
        if (s.decided.includes(profile.id)) continue;
        found[profile.id] = {
          profileId: profile.id,
          originId: origin.id,
          originName: origin.name,
          noticedAt,
        };
      }
      const foundEnvironments = { ...s.vanishedEnvironments };
      for (const env of ownedEnvironments) {
        if (s.decidedEnvironments.includes(env.id)) continue;
        foundEnvironments[env.id] = {
          environmentId: env.id,
          originId: origin.id,
          originName: origin.name,
          noticedAt,
        };
      }
      return { vanished: found, vanishedEnvironments: foundEnvironments };
    });
  },
}));

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * Catch a profile or environment whose owning origin is gone without this
 * store ever having been told: an app restart between removing the origin and
 * deciding on the notice loses it (in-memory only, see `noticeOriginRemoved`).
 * Run on every `syncAll()` pass, after the per-origin loop, so it only ever
 * adds entries the file-based sync couldn't have found (that sync can only
 * ever report on origins that still exist). `knownIds` is exactly the ids
 * `syncAll()` just fetched via `listOrigins()` — origins are a global
 * registry (#108, tab_state.json v5), so that one list is authoritative
 * regardless of which environment is active.
 *
 * The origin's name is unrecoverable by the time this runs — it's why the
 * proactive `noticeOriginRemoved` path exists and should stay — so these
 * entries carry an empty `originName`; the notice components fall back to a
 * generic label when it's blank.
 */
function reconcileOrphans(
  found: Record<string, VanishedConnection>,
  foundEnvironments: Record<string, VanishedEnvironment>,
  decided: string[],
  decidedEnvironments: string[],
  knownIds: Set<string>,
): void {
  const noticedAt = new Date().toISOString();

  for (const profile of useConnections.getState().profiles) {
    if (!profile.origin_id || found[profile.id]) continue;
    if (decided.includes(profile.id)) continue;
    if (knownIds.has(profile.origin_id)) continue;
    found[profile.id] = {
      profileId: profile.id,
      originId: profile.origin_id,
      originName: "",
      noticedAt,
    };
  }

  for (const env of useEnvironments.getState().environments) {
    if (!env.originId || foundEnvironments[env.id]) continue;
    if (decidedEnvironments.includes(env.id)) continue;
    if (knownIds.has(env.originId)) continue;
    foundEnvironments[env.id] = {
      environmentId: env.id,
      originId: env.originId,
      originName: "",
      noticedAt,
    };
  }
}

const sweep = repeating(SYNC_INTERVAL_MS, () => {
  void useOriginSync.getState().syncAll();
});
let watching = false;

/**
 * Start the periodic sweep. Idempotent: the timer is module-level and guarded,
 * so a StrictMode double-effect can't stack two of them (the same trap
 * `useUpdateStore.startPeriodicChecks` documents) — and the immediate first
 * sweep rides on `running` for the same reason, so it fires once per app run
 * rather than once per effect.
 */
export function startPeriodicOriginSync(): void {
  if (!isMainWindow()) return;
  watchDeferred();
  if (sweep.running) return;
  void useOriginSync.getState().syncAll();
  sweep.start();
}

/**
 * Apply a held-back metadata update once its pool closes.
 *
 * `sync_origin` refuses to rewrite a profile that has a live connection — moving
 * host/port under a running query would point the user at a different server
 * mid-statement — and reports the id in `deferred` instead. Something has to
 * notice the pool closing, or the update waits for the next four-hourly poll.
 *
 * Re-running the whole sweep is deliberate, rather than caching the pending
 * profile and writing it here: the file is the truth, it may have changed again
 * in the meantime, and a cached copy would be a second source of truth that can
 * go stale. With the pool gone the same code path simply stops deferring.
 */
function watchDeferred(): void {
  if (watching) return;
  watching = true;
  useConnections.subscribe((s, prev) => {
    // `active` is replaced (never mutated) on connect/disconnect, so identity
    // is a sound "did the set change" test.
    if (s.active === prev.active) return;
    const { deferred, syncing } = useOriginSync.getState();
    if (deferred.length === 0 || syncing) return;
    // Only a *closure* can unblock anything; a new connection can't.
    if (deferred.every((id) => s.active.has(id))) return;
    void useOriginSync.getState().syncAll();
  });
}
