/**
 * One terminal tab: an xterm.js instance bound to one backend PTY session.
 *
 * Owns the session's whole lifetime. Mounting opens it (a shell, or `mongosh`
 * signed in as a connection), unmounting closes it, and in between the
 * component stays mounted while hidden — the panel keeps every tab alive and
 * only shows the active one — so switching tabs never loses a session or its
 * scrollback. React's StrictMode mounts twice in development; the first
 * session is closed by the first cleanup, which is exactly what should happen
 * to a session nobody will ever show.
 *
 * **The keyboard belongs to the terminal.** Ctrl+B, Ctrl+K, Ctrl+R, Ctrl+W
 * are line-editing keys to a shell and `mongosh`, and the app's dispatcher
 * listens on `window`. So every keystroke inside is kept from reaching it,
 * except the few app shortcuts a terminal user still expects to work (the
 * palette, Settings, and the bottom dock's own toggles) — VS Code's
 * "commands to skip shell", minus the configurability.
 *
 * Copy and paste go through the native clipboard plugin (gotcha #63), on
 * Ctrl+Shift+C / Ctrl+Shift+V as in every Linux terminal — Ctrl+C has to stay
 * the interrupt it is everywhere else.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api } from "@/lib/tauri";
import { copyToClipboard, readFromClipboard } from "@/lib/clipboard";
import { allBindings, matchesBinding, type ActionId } from "@/lib/keybindings";
import type { TerminalEvent } from "@/lib/terminal/types";
import { xtermTheme } from "@/lib/terminal/xtermTheme";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import {
  selectActiveMode,
  selectActiveTheme,
  useThemeStore,
} from "@/stores/preferences/theme";
import {
  sweepOrphanedSessions,
  useTerminals,
  type TerminalTab,
} from "@/stores/session/terminals";

/** App shortcuts that still work with the focus in a terminal. */
const PASS_THROUGH: ActionId[] = [
  "toggleCommandPalette",
  "openSettings",
  "togglePanelConsole",
  "togglePanelTerminal",
];

function passesThrough(e: KeyboardEvent): boolean {
  const keybindings = usePreferences.getState().prefs.keybindings;
  return PASS_THROUGH.some((id) =>
    allBindings(keybindings, id).some((b) => matchesBinding(e, b)),
  );
}

/** The terminal-convention clipboard chords. */
const isCopy = (e: KeyboardEvent) =>
  e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC";
const isPaste = (e: KeyboardEvent) =>
  e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyV";

export function TerminalView({
  tab,
  active,
  visible,
}: {
  tab: TerminalTab;
  /** The selected tab of the strip. */
  active: boolean;
  /** The panel itself is on screen. */
  visible: boolean;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const editor = usePreferences(selectEditorPrefs);
  const family = useThemeStore(selectActiveTheme);
  const mode = useThemeStore(selectActiveMode);
  const markExited = useTerminals((s) => s.markExited);

  // The session: opened once per mount. Deliberately not keyed on the font or
  // theme — those are applied to the live instance below, and reopening a
  // shell because the user changed the editor font would be absurd.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = usePreferences.getState().prefs.editor;
    const theme = useThemeStore.getState();
    const activeFamily = selectActiveTheme(theme);
    const activeMode = selectActiveMode(theme);
    const term = new Terminal({
      fontFamily: `${initial.fontFamily}, monospace`,
      fontSize: initial.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(activeFamily[activeMode], activeMode),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // A hidden host has no size yet; the resize observer fits it later.
    }

    let disposed = false;
    let sessionId: string | null = null;
    /** Keystrokes typed before the session answered — sent once it does. */
    let queued = "";

    const onEvent = (event: TerminalEvent) => {
      if (event.kind === "output") {
        term.write(event.data);
        return;
      }
      const code = event.code === null ? "?" : String(event.code);
      term.write(`\r\n\x1b[2m${t("terminal.exited", { code })}\x1b[0m\r\n`);
      markExited(tab.key);
    };

    const opening = sweepOrphanedSessions().then(() =>
      tab.kind === "mongosh" && tab.connectionId
        ? api.terminalOpenMongosh(tab.connectionId, tab.database, term.cols, term.rows, onEvent)
        : api.terminalOpenShell(term.cols, term.rows, onEvent),
    );
    opening
      .then((id) => {
        if (disposed) {
          void api.terminalClose(id);
          return;
        }
        sessionId = id;
        if (queued) {
          void api.terminalWrite(id, queued);
          queued = "";
        }
      })
      .catch((e) => {
        if (disposed) return;
        term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
        markExited(tab.key);
      });

    const dataSub = term.onData((data) => {
      if (sessionId) void api.terminalWrite(sessionId, data).catch(() => {});
      else queued += data;
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionId) void api.terminalResize(sessionId, cols, rows).catch(() => {});
    });

    term.attachCustomKeyEventHandler((e) => {
      if (isCopy(e)) {
        const selection = term.getSelection();
        if (selection) void copyToClipboard(selection);
        return false;
      }
      if (isPaste(e)) {
        void readFromClipboard().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      // Leave the app's own shortcuts to the app: xterm must not also type
      // them into the shell.
      return !passesThrough(e);
    });
    // Bubble phase, on the host: xterm has already handled the key by now.
    const isolate = (e: KeyboardEvent) => {
      if (!passesThrough(e)) e.stopPropagation();
    };
    host.addEventListener("keydown", isolate);

    // Fit whenever the dock is resized or the tab becomes visible; a hidden
    // tab measures 0×0 and is skipped rather than shrunk to one column.
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // Mid-teardown; nothing to fit.
        }
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      host.removeEventListener("keydown", isolate);
      dataSub.dispose();
      resizeSub.dispose();
      if (sessionId) void api.terminalClose(sessionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The tab's identity is fixed for its lifetime (the store never mutates
    // kind/connection/database of an existing tab), so `tab.key` is the whole
    // dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  // Live font and theme changes, without touching the session.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = `${editor.fontFamily}, monospace`;
    term.options.fontSize = editor.fontSize;
    term.options.theme = xtermTheme(family[mode], mode);
    try {
      fitRef.current?.fit();
    } catch {
      // Hidden; refitted when shown.
    }
  }, [editor.fontFamily, editor.fontSize, family, mode]);

  // Showing a tab focuses it, so the user can type straight away — whether it
  // was just selected or the dock was just opened on it.
  const shown = active && visible;
  useEffect(() => {
    if (!shown) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet.
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [shown]);

  return (
    <div
      ref={hostRef}
      hidden={!active}
      className="h-full w-full overflow-hidden px-2 pt-1"
      data-terminal-kind={tab.kind}
    />
  );
}
