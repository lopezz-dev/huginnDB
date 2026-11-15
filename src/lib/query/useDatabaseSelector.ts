/**
 * Which database a query tab runs against, and the list it can pick from.
 * Extracted from `QueryEditorTab` (ADR #137, step 2) with no change of
 * behaviour.
 *
 * The tab's connection may already be a `parent::db::<name>` child; listing
 * and switching always work off the parent. Picking a database opens
 * (idempotently) the child pool, repoints `effectiveId` at it and warms its
 * schema so the autocomplete follows. `DEFAULT_DB` returns to the parent.
 *
 * SQLite is one file with one `main`, so it is never asked for a list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/tauri";
import { databaseOfViewId, parentConnectionId } from "@/lib/connectionLabel";
import { useSchema } from "@/stores/session/schema";
import type { DatabaseInfo, Driver } from "@/types";

/** Radix Select can't carry an empty value, so the parent / default-database
 *  option uses this sentinel. It never leaves the selector. */
export const DEFAULT_DB = "__default__";

export interface DatabaseSelector {
  /** The parent connection. */
  parentId: string;
  /** Where statements run: `parentId` or one of its `::db::` views. */
  effectiveId: string;
  /** The database `effectiveId` names, or `null` on the parent. */
  selectedDb: string | null;
  /** Databases on the parent; empty on SQLite or when listing failed. */
  databases: DatabaseInfo[];
  /** `DEFAULT_DB` or a database name. */
  switchDatabase: (name: string) => Promise<void>;
}

export function useDatabaseSelector(
  connectionId: string,
  driver: Driver | undefined,
  /** Called when opening the database's view fails. */
  onError: (message: string) => void,
): DatabaseSelector {
  const parentId = useMemo(
    () => parentConnectionId(connectionId),
    [connectionId],
  );
  const [effectiveId, setEffectiveId] = useState(connectionId);
  useEffect(() => setEffectiveId(connectionId), [connectionId]);
  const selectedDb = useMemo(
    // `databaseOfViewId` answers "" on the parent; `null` says so in the type.
    () => databaseOfViewId(effectiveId) || null,
    [effectiveId],
  );

  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  useEffect(() => {
    if (driver === "sqlite") {
      setDatabases([]);
      return;
    }
    let cancelled = false;
    void api
      .listDatabases(parentId)
      .then((dbs) => {
        if (!cancelled) setDatabases(dbs);
      })
      .catch(() => {
        if (!cancelled) setDatabases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [parentId, driver]);

  const switchDatabase = useCallback(
    async (name: string) => {
      if (name === DEFAULT_DB) {
        setEffectiveId(parentId);
        return;
      }
      try {
        const id = await api.openDatabaseView(parentId, name);
        setEffectiveId(id);
        void useSchema.getState().refresh(id);
      } catch (e) {
        onError(String(e));
      }
    },
    [parentId, onError],
  );

  return { parentId, effectiveId, selectedDb, databases, switchDatabase };
}
