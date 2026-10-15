---
id: 3
type: gotcha
status: active
date: 2026-05-13
tags: [tauri]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #3: tauri::State does not auto-deref into &T

Call `state.inner()` to get `&AppState` at call sites. Every helper that takes `&AppState` is called with `state.inner()`, never `&state`.

**Trap:** Passing &state where a helper expects &AppState does not work because tauri::State does not auto-deref; state.inner() must be used.

## Detail

**`tauri::State<'_, T>` does NOT auto-deref into `&T` at call sites.**
   Use `state.inner()` to get `&AppState`. Every helper that takes `&AppState` (e.g. `pool_for`) is called with `state.inner()`, not `&state`.
