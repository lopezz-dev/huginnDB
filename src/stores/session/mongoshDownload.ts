/**
 * The `mongosh` download, shared by the two places that offer it: the Terminal
 * panel's empty state and Settings → Terminal.
 *
 * One store rather than state in each component because the download outlives
 * both — closing Settings, or switching the dock to the Console, must not look
 * like cancelling it — and because either surface finishing it has to refresh
 * the other. `revision` is that: it goes up every time an install lands, and
 * whatever detects `mongosh` (`terminal_environment`) depends on it.
 *
 * The backend decides what is fetched and from where (ADR #109); this store
 * can only start it, stop it and show what it reports.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import type { MongoshInstallEvent } from "@/lib/terminal/types";

export type MongoshDownloadStatus =
  | { phase: "idle" }
  | {
      phase: "running";
      step: MongoshInstallEvent["kind"];
      version: string | null;
      received: number;
      total: number | null;
      /** Cancel was clicked; the backend is stopping. */
      cancelling: boolean;
    }
  | { phase: "failed"; error: string };

interface MongoshDownloadState {
  status: MongoshDownloadStatus;
  /** Bumped when an install lands; environment detection re-runs on it. */
  revision: number;
  start: () => Promise<void>;
  cancel: () => void;
  /** Forget a failure, so the button is offered afresh. */
  dismiss: () => void;
}

export const useMongoshDownload = create<MongoshDownloadState>()((set, get) => ({
  status: { phase: "idle" },
  revision: 0,
  start: async () => {
    if (get().status.phase === "running") return;
    set({
      status: {
        phase: "running",
        step: "checking",
        version: null,
        received: 0,
        total: null,
        cancelling: false,
      },
    });
    try {
      const installed = await api.terminalMongoshDownload((event) => {
        set((s) => {
          if (s.status.phase !== "running") return s;
          return {
            status: {
              ...s.status,
              step: event.kind,
              ...(event.kind === "downloading"
                ? { version: event.version, received: event.received, total: event.total }
                : {}),
            },
          };
        });
      });
      // `null` is a cancel: nothing was installed and nothing is wrong.
      set((s) => ({
        status: { phase: "idle" },
        revision: installed ? s.revision + 1 : s.revision,
      }));
    } catch (e) {
      set({ status: { phase: "failed", error: String(e) } });
    }
  },
  cancel: () => {
    set((s) =>
      s.status.phase === "running" ? { status: { ...s.status, cancelling: true } } : s,
    );
    void api.terminalMongoshCancelDownload().catch(() => {});
  },
  dismiss: () => set({ status: { phase: "idle" } }),
}));
