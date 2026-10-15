---
id: 23
type: gotcha
status: active
date: 2026-07-15
tags: [updater, windows, mcp]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #23: A running huginndb-mcp.exe blocks the self-updater's overwrite

Tauri's generated NSIS template only closes the main exe before updating, so a live MCP sidecar causes `ERROR_SHARING_VIOLATION` that surfaces as a generic permissions failure. An `NSIS_HOOK_PREINSTALL` installer hook force-kills the sidecar before any files are copied.

**Trap:** Tauri's NSIS template only closes the main huginndb.exe, so a running huginndb-mcp.exe makes the update overwrite fail with ERROR_SHARING_VIOLATION, surfaced as a generic access-denied error.

## Detail

**A running `huginndb-mcp.exe` blocks the in-app self-updater from overwriting the sidecar, and the failure looks like a permissions error.** `installMode` for the NSIS bundle is left at Tauri's default (`currentUser`, writing under `%LOCALAPPDATA%`) — no admin prompt is expected, and none is needed for a plain per-user install/update. But Tauri's generated NSIS template only knows how to close a running instance of the *main* `huginndb.exe` before overwriting it; it has no idea `huginndb-mcp.exe` exists, since that process is spawned independently by whatever external MCP client has it configured (Claude Desktop, Claude Code, ...), never by HuginnDB itself. If a client still has the sidecar running when `useUpdateStore.installAndRelaunch` (`src/stores/update.ts`) downloads and silently runs the new installer, Windows holds a lock on `huginndb-mcp.exe` and the overwrite fails with `ERROR_SHARING_VIOLATION` — surfaced to the user as a generic access-denied/permissions failure, even though no elevation is actually missing. Fixed via a `NSIS_HOOK_PREINSTALL` installer hook (`src-tauri/windows/hooks.nsi`, wired through `bundle.windows.nsis.installerHooks` in `tauri.conf.json`) that force-kills `huginndb-mcp.exe` before any files are copied; the MCP client simply respawns it next time it needs the connector. Don't remove the hook, and if the sidecar's binary name ever changes, update the `taskkill /IM` target to match.
