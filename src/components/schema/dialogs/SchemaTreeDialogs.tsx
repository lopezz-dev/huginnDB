/**
 * The one place the schema tree's dialogs are mounted — see
 * `useSchemaTreeDialogs` for why they left the explorers.
 *
 * The `onDone` aftermath of each is unchanged from where it used to live:
 * refresh the slice the relation was on, except a table rename, which
 * refreshes the whole tree under the connection because a MongoDB rename can
 * move the collection into a sibling database's slice.
 */

import { useTranslation } from "react-i18next";

import { CreateDatabaseDialog } from "@/components/schema/dialogs/CreateDatabaseDialog";
import { DatabaseVisibilityDialog } from "@/components/schema/dialogs/DatabaseVisibilityDialog";
import { DropObjectDialog } from "@/components/schema/dialogs/DropObjectDialog";
import { EmptyTableDialog } from "@/components/schema/dialogs/EmptyTableDialog";
import { RenameObjectDialog } from "@/components/schema/dialogs/RenameObjectDialog";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { notify } from "@/lib/notify";
import { useSchemaTreeDialogs } from "@/stores/dialogs/schemaTreeDialogs";
import { useSchema } from "@/stores/session/schema";

export function SchemaTreeDialogs() {
  const { t } = useTranslation();
  const open = useSchemaTreeDialogs((s) => s.open);
  const close = useSchemaTreeDialogs((s) => s.close);
  const connectionId =
    open === null
      ? ""
      : "connectionId" in open
        ? open.connectionId
        : open.parentId;
  const driver = useConnectionDriver(connectionId);
  // The whole slice's database list is only read by the rename dialog's
  // MongoDB move picker and the visibility picker. Read as the existing array
  // reference (gotcha #1).
  const databases = useSchema((s) => s.byConnection[connectionId]?.databases);

  if (!open) return null;
  const refresh = (id: string) => void useSchema.getState().refresh(id);

  switch (open.kind) {
    case "rename":
      return (
        <RenameObjectDialog
          kind="table"
          connectionId={open.connectionId}
          target={open.target}
          driver={driver}
          databases={(databases ?? []).map((d) => d.name)}
          onClose={close}
          onDone={() => {
            close();
            // `refreshTree`: a MongoDB rename can move the collection into
            // another database, whose slice is a sibling of this one.
            void useSchema.getState().refreshTree(open.connectionId);
          }}
        />
      );
    case "drop":
    case "dropView":
      return (
        <DropObjectDialog
          kind={open.kind === "drop" ? "table" : "view"}
          connectionId={open.connectionId}
          target={open.target}
          onClose={close}
          onDone={() => {
            close();
            refresh(open.connectionId);
          }}
        />
      );
    case "empty":
      return (
        <EmptyTableDialog
          connectionId={open.connectionId}
          target={open.target}
          onClose={close}
          onDone={() => {
            close();
            refresh(open.connectionId);
          }}
        />
      );
    case "renameView":
      return (
        <RenameObjectDialog
          kind="view"
          connectionId={open.connectionId}
          target={open.target}
          onClose={close}
          onDone={() => {
            close();
            refresh(open.connectionId);
          }}
        />
      );
    case "createDatabase":
      return (
        <CreateDatabaseDialog
          connectionId={open.parentId}
          onClose={close}
          onDone={(name) => {
            close();
            // The new row appearing in the tree is the confirmation here — the
            // subtree is by definition expanded, since the user is looking at
            // its empty state — so this refreshes and stays quiet.
            refresh(open.parentId);
            notify.success(t("schema.createDatabase.created", { name }));
          }}
        />
      );
    case "databaseVisibility":
      return (
        <DatabaseVisibilityDialog
          profileId={open.parentId}
          databases={(databases ?? []).map((d) => d.name)}
          onClose={close}
        />
      );
  }
}
