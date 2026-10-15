---
id: 102
type: adr
status: accepted
date: 2026-09-28
tags: [mcp, updater, windows]
triggered_by_external_trap: false
related: [23, 26, 94]
supersedes: []
superseded_by: null
amends: []
---

# ADR #102: The `.mcpb` hands the session to the connector installed with the app

The `.mcpb` bundle's copy of `huginndb-mcp` launches the copy installed next to `huginndb.exe` and waits on it, so updating the app updates what Claude Desktop runs. It decides before the tokio runtime, the state, the policy or a byte on stdout, always delegates when an installed copy exists (no version comparison), and never delegates twice.

**Decision:** mcp::delegate::run_installed_if_any runs first in main, launching the installed huginndb-mcp (HUGINNDB_MCP_PATH, then the NSIS uninstall key's InstallLocation, then %LOCALAPPDATA%\HuginnDB) with inherited stdio, always when one exists, never twice, Windows only.

**Alternatives rejected:**

- Shipping and running the bundled sidecar as-is — rejected because Claude Desktop would run the install-time version forever, ignoring later policy support.
- Delegating only to a newer installed copy — rejected because the connector must match the app that writes the files, not be the newest binary.
- Keying the product name off canary — rejected; the bundled connector is always stable.
- A job object to tie child lifetime — not used; EOF and the installer's taskkill already end both.
- Delegating on Linux — not done because .deb/.rpm are not updated in place.

## Detail

**The bundle carried the real sidecar, so Claude Desktop ran the version it was installed with forever.** `scripts/build-mcpb.sh` zipped the release's `huginndb-mcp.exe` into the bundle, and Claude Desktop unpacks it into its own extensions folder. The app's updater replaces the copy in `%LOCALAPPDATA%\HuginnDB\`, never that one. That was more than staleness: a bundle from before 1.29 does not know the managed policy exists (ADR #94), so a workstation whose app enforced a policy still gave the AI a connector that ignored it, and nothing on screen said so. For an organisation deploying to many machines it also meant every release needed someone to reinstall the extension on each one.

**`mcp::delegate::run_installed_if_any` is the first thing `main` does.** `main` stopped being `#[tokio::main]` so the decision is made before a runtime exists: no state loaded, no policy read, no banner, and above all nothing on stdout, which the child inherits as the JSON-RPC channel. The child is started with the same `argv[1..]`, inherited stdin/stdout/stderr and `HUGINNDB_MCP_DELEGATED=1`, and the parent exits with its code. There is no job object: when the client closes the pipes the child reads EOF and ends, and when the installer's `taskkill /IM huginndb-mcp.exe /T` runs (gotcha #23) both copies share the image name and both go. If the installed copy exists but will not start (AppLocker, a half-written install), the bundle serves the session itself rather than failing the client.

**The lookup, most authoritative first.** `HUGINNDB_MCP_PATH`, when set, is the only candidate: a path that is missing or is this binary means "serve yourself", and an empty value turns delegation off (the documented escape hatch). Otherwise the uninstall key's `InstallLocation` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\HuginnDB` (stored *quoted* by NSIS, so the quotes are trimmed), then NSIS's per-user default `%LOCALAPPDATA%\HuginnDB\`. The first that exists wins unless it is this very binary (compared canonicalised), which is how the installed copy, launched directly or by a client configured with its path, serves itself. Reading HKCU is fine here even though the policy refuses it (ADR #94): only locating a binary is at stake, and whoever can write that key can also edit the client's own server config. Windows only; on Linux `.deb`/`.rpm` are not updated in place, so delegating would buy nothing.

**The product name is stable, not keyed off `canary`.** `PRODUCT_NAME` is `"HuginnDB"` because the bundled connector is always a stable build (ADR #26) and a canary install is not what it should hand over to. A test reads `tauri.conf.json`'s `productName` so a rename cannot leave the lookup pointing at a folder that no longer exists.

**Why no version comparison.** The tempting rule is "delegate only to a newer copy". It is the wrong question: the connector has to match the app that writes `profiles.json`, `prefs.json` and reads the policy, not be the newest binary on disk. An installed copy older than the bundle is still the one that understands that app's files. An installed copy from before this change has no delegation code, so the chain always stops after one hop; `HUGINNDB_MCP_DELEGATED` makes that true for later versions too, whatever their own lookup finds.

**What it does not do.** It does not update the app. A workstation where nobody opens HuginnDB still needs the updater to run somewhere; that is the headless updater's job, not this one's.
