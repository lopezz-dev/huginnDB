import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { DetachedTabWindow } from "./components/shell/DetachedTabWindow";
import { PulseWindow } from "./components/pulse/PulseWindow";
import { LockGate } from "./components/lock/LockGate";
import "./lib/monaco/monaco-setup";
import "./lib/i18n";
import "./index.css";

// The WebView's native context menu (Reload, View source, Inspect…) has no
// Tauri config flag to disable it — every custom right-click menu in the app
// is a Radix `ContextMenu` that already calls its own `preventDefault` on its
// trigger, so this only ever suppresses the native one on the areas that
// don't have a custom menu of their own (blank tree space, the row-number
// column, …). Left enabled in dev so `pnpm tauri:dev` still gets the
// WebView2 inspector via right-click.
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

// Swallow file drops that miss an explicit drop target. `dragDropEnabled` is
// `false` in `tauri.conf.json` (so HTML drag-and-drop reaches the page at all —
// the environment-avatar picker relies on it), which also means the webview
// keeps its *default* action for a dropped file: navigate to `file:///…`,
// replacing the entire app with the dropped document and no chrome to go back
// with. Anything that genuinely accepts a file already calls `preventDefault`
// in its own handler, so this only ever catches a near miss.
//
// Deliberately gated on the drag carrying files: every internal drag (dockview
// tabs, the environment rail's `@dnd-kit` sortable, text into Monaco) must keep
// its default behaviour, and none of those set the `Files` type.
for (const type of ["dragover", "drop"] as const) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

// Two window kinds render something other than the full app shell, both
// identified by their Tauri label's prefix (the label is fixed at creation and
// is the only thing a fresh JS runtime knows about why it was opened):
//
//   tabwin-*    a "sacar como ventana flotante" window (see `open_tab_window`
//               / `TabbedArea`'s floatPanel action) — one bare workspace tab.
//   pulsewin-*  Pulse's expanded view (see `open_pulse_window`) — measuring
//               one connection. Deliberately not a detached tab: Pulse has no
//               `TabKind` and never appears in the workspace.
const label = getCurrentWindow().label;
const Root = label.startsWith("tabwin-")
  ? DetachedTabWindow
  : label.startsWith("pulsewin-")
    ? PulseWindow
    : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Every window kind answers to the app lock before anything in it
        mounts — see `LockGate` and ADR #118. */}
    <LockGate>
      <Root />
    </LockGate>
  </React.StrictMode>,
);
