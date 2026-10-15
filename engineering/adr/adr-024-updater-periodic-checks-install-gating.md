---
id: 24
type: adr
status: accepted
date: 2026-07-15
tags: [updater, tauri]
triggered_by_external_trap: false
related: [23, 82, 103]
supersedes: []
superseded_by: null
amends: []
---

# ADR #24: The updater polls periodically but only installs on an explicit click

`startPeriodicChecks` re-runs the launch check every 4h and auto-downloads in the background, but `install()` — which overwrites files, force-kills the MCP sidecar, and can prompt elevation — only ever runs from an explicit user click, and must be called on the exact `Update` instance `download()` ran on.

**Decision:** The interface updater polls every 4h and downloads in the background, but install() + relaunch() run only on an explicit user click, on the same Update instance download() ran on.

**Alternatives rejected:**

- Checking only on launch: useless for an instance left open for days.
- Running install() unattended: it overwrites files, force-kills the MCP sidecar and can prompt elevation, so it must never run without a click.
- Replacing _update with a fresh instance from a later poll of the same version: install() must run on the exact instance download() ran on.
- Gating the sidecar-running confirmation behind the confirmDestructive preference: interrupting a live AI session is a different safety tier.

## Detail

**The updater only ever checked on launch, so an instance that's never closed never sees a published release.** `useUpdateStore.checkOnLaunch` used to be the sole trigger — fine for a normal restart cadence, useless for a machine that leaves HuginnDB open for days. `startPeriodicChecks` (called once from `App.tsx` alongside `checkOnLaunch`) re-runs the same check on a `setInterval` (4h, module-level timer guarded against double-start so a StrictMode double-effect can't stack two). The important constraint this introduced: `install()` (the step that overwrites files, force-kills the MCP sidecar per gotcha #23, and can prompt for Windows elevation) must **never** run unattended — only `download()` is safe to run silently in the background. So `runCheck`, on finding an update, immediately kicks off `startBackgroundDownload` (a *download-only* call), which lands the store in a new `readyToRestart` status once the bytes are in; `installAndRelaunch` only calls `install()` + `relaunch()` when the user explicitly clicks (whether that's a fresh "Install" click that also happens to start the download, or a "Restart now" click against an already-downloaded update — same code path, gated on `_downloadPromise`/status so neither `download()` nor `install()` ever double-fires against the same `Update` instance). One more wrinkle worth knowing: `install()` must be called on the *exact* `Update` object that `download()` ran on — the plugin tracks the downloaded bytes on that instance internally — so `runCheck` deliberately does **not** replace `_update` with a fresh instance from a later poll when it's still the same version already mid-download or sitting at `readyToRestart`; it only replaces `_update` when a genuinely newer version appears. Because `install()` force-kills the MCP sidecar, `installAndRelaunch` also calls the new `is_mcp_sidecar_running` command (`commands::mcp`, a `tasklist`/`pgrep` shell-out — no new crate) first and, if positive, confirms with the user via `window.confirm` before proceeding (this one is intentionally *not* gated behind the `confirmDestructive` preference, same reasoning as the DROP TABLE dialog in `lib/confirmDestructive.ts` — interrupting someone else's live AI session is a different safety tier than a local data-loss confirmation).

**Scope, since 2026-09-28.** This rule governs the interface. The headless updater (`huginndb.exe --update`, ADR #103) installs without a click on purpose, for the workstation where nobody opens the app, under its own rule (`updater::decide`): it never installs while the interface is open.

## Addendum (2026-10-15): the sidecar confirmation is `confirmIrreversible`, not `window.confirm`

The Detail above says `installAndRelaunch` confirms with `window.confirm`. That stopped being true in two steps, and the rule it describes still stands:

- **2026-08-21 (`22b68dc`):** the inline confirm became `confirmIrreversible` (`lib/confirmDestructive.ts`). That helper is the shared form of the "always ask, whatever `confirmDestructive` says" rule this entry gives for the sidecar, so the reasoning about the preference now lives there rather than at this call site.
- **2026-09-11 (`fdaf2f8`, released in 1.23.0):** `confirmIrreversible` stopped calling the native prompt and now resolves through the in-app `ConfirmHost` (`useConfirmRequest`, an `irreversible`-tone `prompt`-tier dialog; convention #82). The message is `update.mcpSidecarWarning`. Declining puts the store back to `readyToRestart`, so the user can retry from the banner without downloading again.

Do not reintroduce `window.confirm` here. 1.23.0 retired it app-wide.

