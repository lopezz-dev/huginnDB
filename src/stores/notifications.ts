/**
 * In-memory history of the notifications this window has raised.
 *
 * Why a history exists at all: the toasts are deliberately short-lived, and the
 * only thing that makes short-lived acceptable is that nothing is lost by
 * missing one. A notification that named a file, an error worth copying or a
 * count worth checking stays reachable from the bell in the status bar
 * (`NotificationCenter`) for the rest of the session.
 *
 * Three properties are load-bearing:
 *
 * * **In memory, never on disk.** This is session ephemera, not user content:
 *   it does not deserve a state file (see the on-disk state map in CLAUDE.md),
 *   and it must not ride in `prefs.json`, which is rewritten on every
 *   `Ctrl`+wheel of the grid. `historyLimit` is the only part that persists.
 * * **Per window.** Every store instance belongs to one webview, which is
 *   already how notifications work — a command's log entries are emitted to the
 *   window that ran it (gotcha #25). No `emit`/`listen` here: a second window
 *   inheriting the main window's history would be claiming it did work it never
 *   did.
 * * **Grouped like the toast.** A burst of identical notifications is one
 *   entry with a count, exactly as it appeared on screen, because that is what
 *   the user is trying to recognise when they open the panel.
 *
 * `entries` is a plain array on the state; derive anything else (the unread
 * count, per-day sections) with `useMemo` in the component — a selector that
 * filtered or grouped here would return a fresh array on every call and trip
 * the infinite-re-render trap in gotcha #1.
 */

import { create } from "zustand";
import { usePreferences } from "@/stores/preferences/preferences";

/** What a notification is *about*, which decides its colour and its icon. */
export type NotificationKind = "success" | "error" | "warning" | "info" | "file";

/** The file a `file` notification points at. */
export interface NotificationFile {
  /** Absolute path, as returned by the save dialog. */
  path: string;
  /** Basename, precomputed so the card and the history row agree. */
  name: string;
  /** Human-readable size, when the caller knows it. */
  size?: string;
}

export interface NotificationEntry {
  /** History id. Unrelated to the toast id — one entry can outlive several. */
  id: string;
  kind: NotificationKind;
  title: string;
  description?: string;
  /** Render the description monospaced (driver errors, identifiers, paths). */
  mono?: boolean;
  file?: NotificationFile;
  /** Unix ms of the most recent occurrence. */
  at: number;
  /** Occurrences folded into this entry; `1` for the common case. */
  count: number;
  read: boolean;
  /**
   * Set once a reveal has failed because the file is no longer where it was
   * written. The row stays (the path is still worth copying) but stops
   * pretending it can be opened.
   */
  missing?: boolean;
}

/** New entries carry no identity or bookkeeping; the store adds both. */
export type NewNotification = Omit<NotificationEntry, "id" | "at" | "count" | "read">;

/** What a repeat updates on the entry it folded into. */
export interface NotificationBump {
  count: number;
  title: string;
  description?: string;
  file?: NotificationFile;
}

interface NotificationsState {
  entries: NotificationEntry[];
  /**
   * Record a notification and return its id.
   *
   * Always a new entry: whether an occurrence is a *repeat* is decided one
   * layer up, in `lib/notify.tsx`, which then calls {@link bump}. Keeping that
   * policy in one place is what stops the card on screen and the row in the
   * panel from disagreeing about what happened.
   */
  push: (entry: NewNotification) => string;
  /**
   * Fold a repeat into the entry `push` returned earlier: raise the count,
   * refresh the timestamp and take the latest wording.
   *
   * Returns `false` when that entry is gone — evicted by `historyLimit`, or
   * dropped when the user cleared the panel — so the caller can record the
   * occurrence afresh instead of losing it.
   */
  bump: (id: string, patch: NotificationBump) => boolean;
  markAllRead: () => void;
  markMissing: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** Monotonic within a session; the entry id never leaves the window. */
let seq = 0;
const nextId = () => `n${++seq}`;

/**
 * Newest-first, capped at the user's `historyLimit`. A limit of `0` turns the
 * history off entirely, which is why `push` still runs (the toast is unaffected)
 * but keeps nothing.
 */
function capped(entries: NotificationEntry[]): NotificationEntry[] {
  const limit = usePreferences.getState().prefs.notifications.historyLimit;
  return limit > 0 ? entries.slice(0, limit) : [];
}

export const useNotifications = create<NotificationsState>()((set) => ({
  entries: [],

  push(entry) {
    const id = nextId();
    set((s) => ({
      entries: capped([
        { ...entry, id, at: Date.now(), count: 1, read: false },
        ...s.entries,
      ]),
    }));
    return id;
  },

  bump(id, patch) {
    let applied = false;
    set((s) => {
      if (!s.entries.some((e) => e.id === id)) return s;
      applied = true;
      return {
        entries: s.entries.map((e) =>
          e.id === id
            ? {
                ...e,
                ...patch,
                at: Date.now(),
                read: false,
                // The new occurrence wrote a file of its own; whatever we knew
                // about the previous one being gone no longer applies.
                missing: undefined,
              }
            : e,
        ),
      };
    });
    return applied;
  },

  markAllRead() {
    set((s) =>
      // Rebuild only when something actually changes, so opening the panel
      // twice doesn't hand every subscriber a new array for nothing.
      s.entries.some((e) => !e.read)
        ? { entries: s.entries.map((e) => (e.read ? e : { ...e, read: true })) }
        : s,
    );
  },

  markMissing(id) {
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, missing: true } : e)),
    }));
  },

  remove(id) {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  clear() {
    set({ entries: [] });
  },
}));
