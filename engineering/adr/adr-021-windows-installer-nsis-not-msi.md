---
id: 21
type: adr
status: accepted
date: 2026-07-14
tags: [windows, ci, build]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #21: Windows installer target is NSIS, not MSI/WiX

WiX v3's `light.exe` reliably failed to launch on GitHub's Windows runners (an archived, unmaintained toolchain, likely flagged by AV heuristics); NSIS is Tauri's officially supported upgrade path from a prior MSI install, not the reverse.

**External trap behind it:** WiX v3's light.exe fails to launch on GitHub's Windows runners (likely AV heuristics flagging that binary), while candle.exe runs fine.

**Decision:** tauri.conf.json bundle.targets is ["nsis", "deb", "appimage"]; the Windows installer is NSIS, relying on Tauri's supported MSI-to-NSIS upgrade path.

**Alternatives rejected:**

- MSI via WiX v3: light.exe reliably failed to launch on GitHub Windows runners and WiX v3 is archived and will not be fixed.
- Adding a Windows Defender exclusion or the VBSCRIPT optional feature to keep MSI: both ran clean and neither changed the outcome.

## Detail

**Windows installer target is NSIS, not MSI/WiX — don't switch it back without a real reason.** 1.7.0's release build reliably failed bundling the `.msi`: WiX v3 (what `tauri-action` shells out to for MSI) has been archived/unmaintained since February 2025, and its `light.exe` reliably failed to even launch on GitHub's Windows runners — a bare `failed to run ...light.exe`, no WiX diagnostic — regardless of runner OS generation (reproduced identically on both `windows-2022` and the newer `windows-latest`/Server 2025 image GitHub migrated to in June 2026) and regardless of a Windows Defender exclusion or installing the VBSCRIPT optional feature (both ran clean, neither changed the outcome). `candle.exe` always ran fine against the same freshly-downloaded WiX binaries; only `light.exe` failed, matching the historically-known pattern of Defender/AV heuristics flagging that specific binary across the Actions fleet (tauri-apps/tauri#2486, #2640, #10649) — a signature-side issue outside the repo's control, and one WiX v3 will never receive a fix for. `tauri.conf.json`'s `bundle.targets` is `["nsis", "deb", "appimage"]`. Tauri officially supports MSI → NSIS as an update path (not the reverse): the auto-updater's `latest.json` doesn't care about installer format, and NSIS detects a prior WiX MSI install and handles it (a `tauri-bundler` v1.3.0+ capability; the pinned `@tauri-apps/cli` here is 2.11.1, well past it).
