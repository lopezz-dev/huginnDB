/**
 * Open state for the three connection-management modals owned by the File menu
 * (`ConnectionDialog`, `ImportProfilesDialog`, `ExportProfilesDialog`).
 *
 * They used to be plain `useState` booleans inside `FileMenu`, which made them
 * unreachable from anywhere else — the command palette needs to offer "New
 * connection…" / "Manage connections…" / "Import profiles…" / "Export
 * profiles…" without reproducing the dialogs (and their onConnected wiring) at
 * a second mount point. Same pattern as `docsDialog` / `feedbackDialog`:
 * `FileMenu` stays the single place that renders them, and any surface can ask
 * for one. The empty workspace's "New connection" button (`EmptyWatermark`)
 * asks here too; it used to mount its own `ConnectionDialog`, which no store
 * could reach — so no full-screen editor could put it aside either.
 *
 * The manager carries a profile *id* rather than the profile object so the
 * caller doesn't have to look one up; `FileMenu` resolves it against the live
 * profile list at render time, which also means a profile deleted between the
 * request and the render simply falls back to a new draft.
 *
 * **A full-screen editor opened from the manager puts it aside, then gives it
 * back** — the same rule as Settings (`useSettingsDialog`, ADR #101). The
 * manager is a workbench dialog and so is the shared-origin editor its "edit
 * at origin" link opens; stacking one on the other traps focus in whichever
 * mounted last.
 * - `ConnectionDialog` reports the profile it is showing (`focus`), since the
 *   user can move off the one it was opened on.
 * - `suspend()` closes the manager and remembers that profile.
 * - `resume()` reopens it there, but only if `suspend()` was what closed it.
 *   Any explicit open or close supersedes a pending return.
 */

import { create } from "zustand";

interface ConnectionDialogState {
  open: boolean;
  /** Profile the manager opens focused on. `null` starts a new draft. */
  initialId: string | null;
  /** Profile the open manager is showing (`null` for a new draft), as
   *  reported by `ConnectionDialog`. */
  focusedId: string | null;
  /**
   * Where to reopen while a full-screen editor opened from the manager has it
   * put aside (`suspend`); `null` otherwise. Wrapped because a new draft
   * (`profileId: null`) is itself a place to return to.
   */
  suspendedAt: { profileId: string | null } | null;
  importOpen: boolean;
  exportOpen: boolean;
  /** Open the dialog on a blank "New connection" draft. */
  openNew: () => void;
  /** Open the manager, optionally focused on a specific profile. */
  openManage: (profileId?: string | null) => void;
  setOpen: (open: boolean) => void;
  /** Record which profile the open manager is showing. */
  focus: (profileId: string | null) => void;
  /** Close the manager for a full-screen surface opened from it, remembering
   *  the profile. Does nothing when it is not open; returns whether it
   *  closed it. */
  suspend: () => boolean;
  /** Reopen the manager where `suspend` left it. Does nothing if it did not. */
  resume: () => void;
  setImportOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
}

export const useConnectionDialog = create<ConnectionDialogState>(
  (set, get) => ({
    open: false,
    initialId: null,
    focusedId: null,
    suspendedAt: null,
    importOpen: false,
    exportOpen: false,
    openNew: () => set({ open: true, initialId: null, suspendedAt: null }),
    openManage: (profileId) =>
      set({ open: true, initialId: profileId ?? null, suspendedAt: null }),
    setOpen: (open) => set({ open, suspendedAt: null }),
    focus: (focusedId) => set({ focusedId }),
    suspend: () => {
      const { open, focusedId } = get();
      if (!open) return false;
      set({ open: false, suspendedAt: { profileId: focusedId } });
      return true;
    },
    resume: () => {
      const { suspendedAt } = get();
      if (!suspendedAt) return;
      set({ open: true, initialId: suspendedAt.profileId, suspendedAt: null });
    },
    setImportOpen: (importOpen) => set({ importOpen }),
    setExportOpen: (exportOpen) => set({ exportOpen }),
  }),
);
