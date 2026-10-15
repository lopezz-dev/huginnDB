---
id: 62
type: gotcha
status: active
date: 2026-09-04
tags: [windows, build]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #62: Windows' default 1 MiB main-thread stack is too small for the structure/view introspection chain in release

Opening the structure or view editor crashed the whole process — `thread 'main' has overflowed its stack` on stderr — but only in a real `tauri:build` release on Windows, never in `pnpm tauri:dev`, and never in an unoptimized `--debug` build of the same production frontend bundle. That last comparison is what ruled out the frontend: same bundle, same data, different Rust optimization level, different outcome.

**Trap:** Release builds on Windows crash with 'thread main has overflowed its stack' because MSVC's default 1 MiB SizeOfStackReserve is too small once optimisation collapses the call chain into larger frames; fixed with /STACK:8388608 in .cargo/config.toml.

## Detail

**The linker, not the code, decides how much stack the app's main thread gets — and MSVC's default (1 MiB) is a lot less than Unix's (8 MiB).** `get_table_structure`/`get_view_definition`'s call chain (`ensure_view` → `pool_for` → the `information_schema` catalog queries) has nothing recursive in it, but release's inlining collapses it into fewer, larger stack frames than the same chain needs unoptimized — comfortably under 1 MiB in dev, just over it once optimized. Both the installed release `.exe` and a freshly built one had the identical 1 MiB `SizeOfStackReserve` in their PE header (confirmed by reading the header directly — it isn't a Cargo profile setting), so the difference was never "release has less stack," it's "release's code needs more of the same small stack."

Fixed at `src-tauri/.cargo/config.toml` with `[target.'cfg(windows)'] rustflags = ["-C", "link-args=/STACK:8388608"]` — 8 MiB, matching the Unix default — rather than restructuring the call chain to fit an arbitrarily small budget. If a future release-only crash on Windows prints `has overflowed its stack`, check the PE header's stack reserve before assuming it's a logic bug: `pnpm tauri build --debug` (debug Rust, production frontend bundle) isolates the frontend from the optimizer as the variable in one shot.
