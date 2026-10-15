---
id: 22
type: adr
status: accepted
date: 2026-07-14
tags: [mcp, ci, build]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #22: huginndb-mcp ships as a Tauri externalBin sidecar staged by CI

The release workflow builds the `mcp-server` crate and copies it to the exact `externalBin` naming convention before `tauri-action` runs. `tauri-build` hard-fails any compile of `huginndb_lib` without a placeholder sidecar file already on disk, which the workflow touches before building the real binary.

**External trap behind it:** tauri-build hard-fails any compile of huginndb_lib if the externalBin file for the current target triple is not already on disk, creating a circular dependency with building the sidecar itself.

**Decision:** The release workflow builds the mcp-server crate and stages it at src-tauri/binaries/huginndb-mcp-<target-triple>[.exe] for bundle.externalBin before tauri-action, touching placeholders first and replacing them with rm + cp.

**Alternatives rejected:**

- Leaving the connector reachable only by cloning and running cargo build -p huginndb-mcp: no packaged install contained it, defeating the point for non-contributors.
- Overwriting the placeholder in place with cp: keeps the placeholder's non-executable mode and silently ships a broken sidecar.

## Detail

**`huginndb-mcp` ships as a Tauri sidecar (`bundle.externalBin`), staged by the release workflow, not built by `pnpm tauri:build` itself.** Before 1.7.0 shipped, the connector was reachable only by cloning the repo and running `cargo build -p huginndb-mcp` yourself — no packaged install ever contained the binary, which defeated the point for anyone who wasn't already a contributor. The release workflow has a step (`Build and stage the huginndb-mcp sidecar`) that builds the `mcp-server` crate and copies it to `src-tauri/binaries/huginndb-mcp-<target-triple>[.exe]` — the exact naming Tauri's `externalBin` convention requires — *before* the `tauri-action` build step, so `tauri-bundler` finds it and ships it next to the main executable. `src-tauri/binaries/` is gitignored (build output, not source). **`tauri-build` (`huginndb`'s `build.rs`) hard-fails *any* compile of `huginndb_lib` — even a bare `cargo check`, even just as a dependency of `huginndb-mcp` itself — if the externalBin resource for the current target triple isn't already on disk** (existence only; content doesn't matter at compile time). That's a real circular dependency once `externalBin` is configured: building `huginndb-mcp` requires compiling `huginndb_lib` (with the `mcp` feature) first, and that compile now refuses to proceed without a sidecar file that only building `huginndb-mcp` produces. The workflow step works around it by `touch`-ing empty placeholders at both possible sidecar paths (with/without `.exe`) *before* `cargo build -p huginndb-mcp`, then `rm -f`-ing and `cp`-ing the real binary over — not overwriting the placeholder in place, since `cp` onto an existing file keeps that file's (non-executable) mode, which would silently ship a broken sidecar. If you touch this step, keep both halves. `commands::mcp::get_mcp_connector_info` resolves the *installed* sidecar's path via `std::env::current_exe()`'s parent directory — confirmed by inspecting a real `.deb` build (`dpkg-deb -c`), which places both `huginndb` and `huginndb-mcp` in the same `usr/bin/`; this is why the command doesn't need `tauri-plugin-shell` (that's for *spawning* a sidecar from within the app, which we don't do — an external AI client spawns it, we just need to tell the user where it is). Settings → MCP (`McpSection.tsx`) is the UI: it shows this path, lets the user pick which saved profiles to expose, and generates the `claude mcp add` / JSON snippet — see `docs/MCP.md`.
