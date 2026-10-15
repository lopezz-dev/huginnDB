---
id: 1
type: gotcha
status: active
date: 2026-05-13
tags: [zustand, react]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #1: Zustand selectors must be reference-stable

Selectors like `s => s.entries.filter(...)` return a fresh array or object on every call, so `Object.is` always sees a difference and React re-renders forever. Subscribe to raw state and derive arrays/objects with `useMemo` in the component instead.

**Trap:** A selector like s => s.entries.filter(...) returns a fresh reference every call, so Object.is always differs and React hits its update-depth cap from infinite re-renders.

## Detail

**Zustand selectors must return reference-stable values.**
   Anything like `s => s.entries.filter(...)`, `s => [...a, ...b]`, or `s => allThemes(s)` returns a fresh array each call → `Object.is` always differs → infinite re-render → React caps update depth.
   **Rule**: subscribe to the raw state, derive arrays/objects with `useMemo` in the component. The store has a banner comment in `src/stores/preferences/theme.ts` reinforcing this — don't undo it. CONTRIBUTING.md also documents the rule under "Coding standards → TypeScript / React".
