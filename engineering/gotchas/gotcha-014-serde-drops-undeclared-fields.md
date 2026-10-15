---
id: 14
type: gotcha
status: active
date: 2026-06-01
tags: [serde, tauri, state-files]
related: [10]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #14: An undeclared field on a typed IPC struct is silently dropped

`save_tab_state` deserializes into a strongly-typed struct with `#[serde(default)]` but no flatten catch-all, so a frontend-only field must be declared in both `src/types.ts` and the Rust struct or serde discards it before it ever reaches disk.

**Trap:** A field sent through a typed Tauri command but not declared on the Rust struct is silently dropped by serde on deserialize, e.g. never reaching disk or silently reinstating COUNT(*) when withCount is lost.

## Detail

**A field that round-trips through a typed Tauri command must be declared in the Rust struct, or serde silently drops it.** `save_tab_state` deserializes its IPC payload into the strongly-typed `ConnectionTabState` (`tab_state.rs`), which has `#[serde(default)]` but no `#[serde(flatten)]` catch-all. Unknown JSON keys are discarded on deserialize, so a "frontend-only" field survives the IPC argument shape but is gone the instant the Rust struct is rebuilt — before it's written to disk. This bit the `internalLayout` work (ADR #10): it had to be added to *both* `src/types.ts` and the Rust struct (as `Option<serde_json::Value>`, stored opaquely). Same rule for any new persisted field on a typed command boundary. The grid's browse payload (`TableQuery`/`TableScan`/`TableFilter` in `commands/query.rs`, mirrored in `src/types.ts`) is the other place this bites, and the one with no on-disk artefact to notice it by: a dropped `withCount` silently reinstates the `COUNT(*)` issue #77 moved off the render path. Four `serde_json::from_value` tests at the bottom of `commands/query.rs` pin the exact JSON the frontend sends — copy that pattern rather than trusting the two declarations to stay in step.
