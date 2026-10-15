/**
 * Run what the visible schema tree needs: first reads, per-database views,
 * database sizes.
 *
 * Each of these used to be an effect inside the explorer component that
 * showed the node — `useEnsureSchemaLoaded` in both explorers, the open-view
 * effect in `DatabaseRoot`, the size requests in `DatabaseRoot` and
 * `SingleDbExplorer`. They ran because the component was mounted. In the
 * virtualised tree (ADR #108) a row is mounted only near the viewport, which
 * is the wrong condition: an expanded database far down the list still needs
 * its pool open — that is also how a saved split whose tabs belong to a
 * database view gets them back after a restart (`lib/dockview.ts`).
 *
 * So `buildFlatTree` reports the needs of the whole *expanded* structure and
 * this one effect runs them. Every action here is idempotent and guarded at
 * the source (`refresh` and `ensure` join an in-flight call, `loadDatabaseSizes`
 * runs once per slice), and each one changes the state that asked for it, so
 * the next flatten no longer asks.
 */

import { useEffect } from "react";
import type { TreeNeeds } from "@/lib/schema/flatTree";
import { useDatabaseViews } from "@/stores/session/databaseViews";
import { useSchema } from "@/stores/session/schema";

export function useSchemaTreeNeeds(needs: TreeNeeds): void {
  useEffect(() => {
    const schema = useSchema.getState();
    for (const id of needs.load) void schema.refresh(id);
    const views = useDatabaseViews.getState();
    for (const { parentId, database } of needs.openViews) {
      void views.ensure(parentId, database);
    }
    for (const id of needs.sizes) void schema.loadDatabaseSizes(id);
    // A failure stays on screen with a Retry until its node is collapsed;
    // collapsing forgets it so the next expand tries afresh rather than
    // showing a stale error over a subtree that might work now.
    for (const [id, status] of Object.entries(views.byId)) {
      if (status.state === "error" && !needs.expandedViews.has(id)) {
        views.clearError(id);
      }
    }
  }, [needs]);
}
