/**
 * The schema tree's dialogs: which one is open, and on what.
 *
 * Each explorer used to own these as component state — five `useState`
 * targets in `SingleDbExplorer`, two booleans in `MultiDbExplorer` — and
 * render the dialogs under its own subtree. The tree is a virtualised list
 * now, so the row that asked for a dialog may be unmounted a scroll later, and
 * the explorer components that held the state are gone. One store, one host
 * (`SchemaTreeDialogs`, mounted once by `ConnectionsTree`), the same shape as
 * the other dialog stores in this folder.
 *
 * Only one can be open at a time, which is also how the old components
 * behaved in practice: every one of them is modal.
 */

import { create } from "zustand";
import type { TableInfo } from "@/types";

export type SchemaTreeDialog =
  | {
      kind: "rename" | "drop" | "empty" | "renameView" | "dropView";
      /** The (possibly per-database) connection the relation lives on. */
      connectionId: string;
      target: TableInfo;
    }
  | { kind: "createDatabase"; parentId: string }
  | { kind: "databaseVisibility"; parentId: string };

interface SchemaTreeDialogsState {
  open: SchemaTreeDialog | null;
  show: (dialog: SchemaTreeDialog) => void;
  close: () => void;
}

export const useSchemaTreeDialogs = create<SchemaTreeDialogsState>((set) => ({
  open: null,
  show: (dialog) => set({ open: dialog }),
  close: () => set({ open: null }),
}));
