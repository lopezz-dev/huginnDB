---
id: 20
type: adr
status: accepted
date: 2026-07-14
tags: [mcp, build, tauri]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #20: huginndb-mcp lives in its own workspace crate, never a second [[bin]]

`tauri-bundler`'s Windows bundling enumerates every `[[bin]]` in the package's own `cargo metadata` regardless of `required-features` gating and fails sizing a binary a normal build never compiles, so the MCP binary was split into a sibling `mcp-server` crate instead.

**External trap behind it:** tauri-bundler's Windows bundling enumerates every [[bin]] in the package's cargo metadata regardless of required-features and fails sizing a binary that a normal build never compiles (tauri#4807, #14176).

**Decision:** huginndb-mcp lives in its own workspace crate (src-tauri/mcp-server/), a thin shim over huginndb_lib::mcp::serve(), never as a second [[bin]] in the app's Cargo.toml.

**Alternatives rejected:**

- A second [[bin]] (src/bin/mcp.rs) gated by required-features = ["mcp"]: broke the Windows NSIS bundle because tauri-bundler tried to size an mcp.exe never built.
- Excluding the [[bin]] via tauri.conf.json: no such config exists.

## Detail

**`huginndb-mcp` lives in its own workspace crate (`src-tauri/mcp-server/`), never as a second `[[bin]]` in the app's own `Cargo.toml`.** It used to be exactly that (`src/bin/mcp.rs`, gated behind `required-features = ["mcp"]`), which built and ran fine — until the 1.7.0 release build switched Windows bundling from MSI to NSIS (see below) and immediately broke with `failed to bundle project when getting size of ...\mcp.exe: The system cannot find the file specified`. `tauri-bundler`'s Windows bundling enumerates *every* `[[bin]]` target in the package's own `cargo metadata`, regardless of `required-features` gating, and tries to size/bundle each one — including a binary a normal `pnpm tauri:build` never compiles. This is a known, still-open upstream limitation (tauri-apps/tauri#4807, #14176), not something fixable from `tauri.conf.json` (no config exists to exclude a `[[bin]]` from bundling). The fix is structural: move the extra binary to a sibling workspace package. Since `huginndb-mcp` was already a thin shim over `huginndb_lib::mcp::serve()` (the real logic lives in the lib crate's `mcp` module, still gated behind the `mcp` feature), the split was just a new `Cargo.toml` + `main.rs` in `mcp-server/`, a `[workspace] members = ["mcp-server"]` in the app's `Cargo.toml`, and deleting the old `[[bin]]` block — no logic moved. `cargo metadata` for the `huginndb` package alone now reports exactly one bin target, so tauri-bundler never sees the MCP binary at all. Build it with `cargo build -p huginndb-mcp --release` from `src-tauri/` (not `--features mcp --bin huginndb-mcp` anymore — that flag still *works* since the feature still gates the lib-crate logic, but the binary target it used to select no longer exists in this package).
