/**
 * The terminal panel's tabs, for this window.
 *
 * Descriptors only: what each tab runs and whether it is still running. The
 * xterm.js instance and the backend session live in `TerminalView`, mounted
 * once per tab and kept mounted (hidden) while another tab shows — closing a
 * tab is what unmounts it, and unmounting is what ends the session. So this
 * store never holds a session id it would have to keep in step with the
 * backend; the component that owns the session also owns its lifetime.
 *
 * Not persisted: a session does not survive a restart, and restoring a tab
 * that silently starts a fresh shell (or signs in to a server again) is not
 * what reopening the app should do.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import type { TerminalKind } from "@/lib/terminal/types";

export interface TerminalTab {
  /** Local key — not the backend session id. */
  key: string;
  kind: TerminalKind;
  /** The connection a `mongosh` tab signs in as. */
  connectionId: string | null;
  /** The database it switches to after connecting, when one was chosen. */
  database: string | null;
  /** What the tab strip shows: the shell's name, or the connection's. */
  title: string;
  /** `true` once the process ended (or never started). The tab stays, with
   *  its scrollback, until the user closes it. */
  exited: boolean;
}

export type NewTerminalTab = Pick<TerminalTab, "kind" | "connectionId" | "database" | "title">;

interface TerminalsState {
  tabs: TerminalTab[];
  activeKey: string | null;
  /** Add a tab and show it. Returns its key. */
  open: (tab: NewTerminalTab) => string;
  close: (key: string) => void;
  select: (key: string) => void;
  markExited: (key: string) => void;
  /** Close every tab — the module was switched off. Each `TerminalView`
   *  unmounts and ends its session. */
  closeAll: () => void;
}

let counter = 0;
const nextKey = () => `term-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const useTerminals = create<TerminalsState>()((set) => ({
  tabs: [],
  activeKey: null,
  open: (tab) => {
    const key = nextKey();
    set((s) => ({ tabs: [...s.tabs, { ...tab, key, exited: false }], activeKey: key }));
    return key;
  },
  close: (key) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.key === key);
      if (index < 0) return {};
      const tabs = s.tabs.filter((t) => t.key !== key);
      // Closing the active tab shows its neighbour — the one that slides into
      // its place, else the one before — like every tab strip.
      const activeKey =
        s.activeKey !== key
          ? s.activeKey
          : (tabs[index] ?? tabs[index - 1] ?? null)?.key ?? null;
      return { tabs, activeKey };
    }),
  select: (key) => set({ activeKey: key }),
  markExited: (key) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.key === key && !t.exited ? { ...t, exited: true } : t)),
    })),
  closeAll: () => set({ tabs: [], activeKey: null }),
}));

let sweep: Promise<unknown> | null = null;

/**
 * End whatever sessions this window had before this page loaded — once per
 * page, and before this page opens one of its own.
 *
 * A webview reload keeps the window, so the backend's window hook never
 * fires, but every channel the previous page held died with it: its shells
 * would keep running with nobody to show them to. Every `TerminalView` awaits
 * this before opening, which is what orders the sweep ahead of the first new
 * session rather than racing it.
 */
export function sweepOrphanedSessions(): Promise<unknown> {
  sweep ??= api.terminalCloseWindowSessions().catch(() => 0);
  return sweep;
}
