/**
 * Rename a table/collection or a view.
 *
 * One component for both, because the difference is two i18n prefixes and one
 * API call — the previous split ("kept separate rather than parametrizing, since
 * the table one is tightly coupled to the table API call") cost a full second
 * copy of the dialog to avoid passing a `kind`.
 *
 * The MongoDB-only "move to another database" affordance rides along on
 * `kind: "table"`: `renameCollection` qualifies both sides with a database, so
 * moving between them *is* the rename call (ADR #38). No other driver gets
 * it — a cross-schema move is a separate statement there, and doesn't exist at
 * all on SQLite.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";

import { NamePromptDialog } from "@/components/schema/dialogs/NamePromptDialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import {
  closeTabsForTable,
  retitleTabsForTableRename,
} from "@/stores/session/tabs";
import type { Driver, TableInfo } from "@/types";

export function RenameObjectDialog({
  connectionId,
  target,
  kind,
  driver,
  databases = [],
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  kind: "table" | "view";
  /** Drives the MongoDB-only "move to another database" affordance. */
  driver?: Driver;
  /** Databases offered as a move destination. MongoDB-only, and already the
   *  whole cluster's list — `list_databases` is not scoped to the handle's
   *  own database there. */
  databases?: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const canMove = kind === "table" && driver === "mongodb" && databases.length > 0;
  const [newDb, setNewDb] = useState(target.schema ?? "");
  const moving = canMove && newDb !== (target.schema ?? "");

  const prefix = kind === "table" ? "schema.rename" : "schema.renameView";

  return (
    <NamePromptDialog
      title={t(`${prefix}.title`)}
      description={t(`${prefix}.description`, { name: target.name })}
      placeholder={t("schema.rename.newName")}
      initialValue={target.name}
      submitLabel={t("schema.rename.submit")}
      submittingLabel={t("schema.rename.renaming")}
      formatError={(message) => t(`${prefix}.failed`, { message })}
      // A rename to the same name is a no-op — unless the database changed,
      // which for MongoDB is the move.
      canSubmit={(trimmed) => trimmed !== target.name || moving}
      onClose={onClose}
      onSubmit={async (trimmed) => {
        if (kind === "table") {
          await api.renameTable(
            connectionId,
            target.schema,
            target.name,
            trimmed,
            moving ? newDb : undefined,
          );
        } else {
          await api.renameView(connectionId, target.schema, target.name, trimmed);
        }
        notify.success(
          t(moving ? `${prefix}.moved` : `${prefix}.renamed`, {
            from: target.name,
            to: trimmed,
          }),
        );
        if (moving) {
          // The collection now lives behind a different connection id (the
          // destination database's own child pool), so a retitled tab would
          // keep querying the database it just left.
          closeTabsForTable(connectionId, target.schema, target.name);
        } else {
          retitleTabsForTableRename(
            useConnections.getState().profiles,
            connectionId,
            target.schema,
            target.name,
            trimmed,
            t("tabs.structureSuffix"),
          );
        }
        onDone();
      }}
    >
      {canMove && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {t("schema.rename.targetDatabase")}
          </Label>
          <Select value={newDb} onValueChange={setNewDb}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {databases.map((db) => (
                <SelectItem key={db} value={db}>
                  {db}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {moving && (
            <p className="text-xs text-muted-foreground">
              {t("schema.rename.moveHint")}
            </p>
          )}
        </div>
      )}
    </NamePromptDialog>
  );
}
