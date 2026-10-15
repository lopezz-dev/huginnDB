/**
 * Which per-database views (`<parent>::db::<db>`) the schema tree has opened,
 * is opening, or failed to open.
 *
 * This was `DatabaseRoot`'s local state (`childId`, `opening`, `error`) for as
 * long as every database node of a multi-DB connection was a mounted
 * component. The tree is a virtualised list now, so a database row exists in
 * React only while it is near the viewport — and "has this database's pool
 * been opened" is not a fact about the viewport. Kept here, it survives the
 * row scrolling away, and the tree's one effect (`useSchemaTreeNeeds`) can
 * open a view an expanded node needs whether or not its row is on screen,
 * which is also what restores a saved split whose tabs belong to a database
 * view (see `hydrateWorkspaceLayout`'s comment in `lib/dockview.ts`).
 *
 * Deliberately not part of `useSchema`: a slice there is created by
 * `refresh`, after the view is open, and `drop` must be able to forget a
 * slice without also claiming the backend pool is gone.
 */

import { create } from "zustand";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { databaseViewId, isDatabaseViewOf } from "@/lib/connectionLabel";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";

export type DatabaseViewStatus =
  | { state: "opening" }
  | { state: "open" }
  | { state: "error"; message: string };

interface DatabaseViewsState {
  /** Keyed by the synthetic child id. Absent means "never asked". */
  byId: Record<string, DatabaseViewStatus>;
  /**
   * Resolve this database's child id, opening the pool the first time anything
   * needs it — every per-database action (the expand, "New query here",
   * "Refresh" on a collapsed node, export…) goes through here.
   *
   * One open at a time per database: a second caller while the first is still
   * running joins it rather than opening a second pool that would replace the
   * first. Resolves `null` after recording *and reporting* the failure — the
   * report matters because the line that shows `error` only renders under an
   * expanded node, and a context-menu action on a collapsed one used to fail
   * without a word (ADR #68).
   */
  ensure: (parentId: string, database: string) => Promise<string | null>;
  /** Forget a failure, so the next expand tries afresh (the Retry button, or
   *  collapsing the node). */
  clearError: (childId: string) => void;
  /** Forget one view — its database was dropped. */
  forget: (childId: string) => void;
  /** Forget every view under `parentId` — its pool is gone. */
  forgetParent: (parentId: string) => void;
}

const inFlight = new Map<string, Promise<string | null>>();

export const useDatabaseViews = create<DatabaseViewsState>((set, get) => ({
  byId: {},
  ensure: (parentId, database) => {
    const id = databaseViewId(parentId, database);
    if (get().byId[id]?.state === "open") return Promise.resolve(id);
    const running = inFlight.get(id);
    if (running) return running;
    set((s) => ({ byId: { ...s.byId, [id]: { state: "opening" } } }));
    const promise = (async () => {
      try {
        // `openTrackedDatabaseView`, not the bare `api` wrapper: it is what
        // hydrates the child's persisted tabs and schema expansion and attaches
        // its save subscription on the first open (ADR #27).
        const opened = await openTrackedDatabaseView(parentId, database);
        set((s) => ({ byId: { ...s.byId, [opened]: { state: "open" } } }));
        return opened;
      } catch (e) {
        const message = String(e);
        set((s) => ({
          byId: { ...s.byId, [id]: { state: "error", message } },
        }));
        notify.error(i18n.t("schema.openDatabaseFailed", { name: database }), {
          description: message,
        });
        return null;
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, promise);
    return promise;
  },
  clearError: (childId) =>
    set((s) => {
      if (s.byId[childId]?.state !== "error") return s;
      const byId = { ...s.byId };
      delete byId[childId];
      return { byId };
    }),
  forget: (childId) =>
    set((s) => {
      if (!(childId in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[childId];
      inFlight.delete(childId);
      return { byId };
    }),
  forgetParent: (parentId) =>
    set((s) => {
      const ids = Object.keys(s.byId).filter((id) =>
        isDatabaseViewOf(id, parentId),
      );
      if (ids.length === 0) return s;
      const byId = { ...s.byId };
      for (const id of ids) {
        delete byId[id];
        inFlight.delete(id);
      }
      return { byId };
    }),
}));
