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
 *
 * A download is the backend's, not a window's: another window, or this one
 * after a reload, may find one already running. It cannot see that download's
 * progress (the channel it reports on belongs to the window that started it),
 * so it `attach`es: shows "in progress" and asks the backend until it ends.
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
      /** The download belongs to another window (or a previous page): no
       *  progress to show, only that it is running. */
      attached: boolean;
    }
  | { phase: "failed"; error: string };

interface MongoshDownloadState {
  status: MongoshDownloadStatus;
  /** Bumped when an install lands; environment detection re-runs on it. */
  revision: number;
  start: () => Promise<void>;
  /** Pick up a download this window did not start, if one is running. */
  attach: () => Promise<void>;
  cancel: () => void;
  /** Forget a failure, so the button is offered afresh. */
  dismiss: () => void;
}

/** What the backend says when another download holds the installer. */
const ALREADY_RUNNING = "already being downloaded";
const POLL_MS = 1500;

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
        attached: false,
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
      // Someone else got there first — another window, or this one before a
      // reload. That is "in progress", not a failure to report.
      if (String(e).includes(ALREADY_RUNNING)) {
        set({ status: { phase: "idle" } });
        await get().attach();
        return;
      }
      set({ status: { phase: "failed", error: String(e) } });
    }
  },
  attach: async () => {
    if (get().status.phase === "running") return;
    let running = false;
    try {
      running = await api.terminalMongoshDownloadRunning();
    } catch {
      return;
    }
    if (!running) return;
    set({
      status: {
        phase: "running",
        step: "downloading",
        version: null,
        received: 0,
        total: null,
        cancelling: false,
        attached: true,
      },
    });
    // Ask until it ends; when it does, whatever it installed is detected.
    const poll = async () => {
      let still = false;
      try {
        still = await api.terminalMongoshDownloadRunning();
      } catch {
        still = false;
      }
      if (still) {
        setTimeout(() => void poll(), POLL_MS);
        return;
      }
      set((s) => ({ status: { phase: "idle" }, revision: s.revision + 1 }));
    };
    setTimeout(() => void poll(), POLL_MS);
  },
  cancel: () => {
    set((s) =>
      s.status.phase === "running" ? { status: { ...s.status, cancelling: true } } : s,
    );
    void api.terminalMongoshCancelDownload().catch(() => {});
  },
  dismiss: () => set({ status: { phase: "idle" } }),
}));
