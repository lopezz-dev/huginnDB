---
id: 2
type: adr
status: accepted
date: 2026-05-13
tags: [monaco, tauri, build]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #2: Monaco is bundled, never CDN-loaded

`monaco-setup.ts` wires workers via Vite `?worker` imports and calls `loader.config({ monaco })`; without this the SQL and cell editors go blank whenever Tauri can't reach a CDN. Don't reintroduce a CDN dependency.

**External trap behind it:** Monaco loaded from cdn.jsdelivr.net renders blank editors whenever the Tauri app cannot reach the CDN.

**Decision:** Bundle Monaco and its workers locally through monaco-setup.ts instead of loading it from a CDN; new Monaco languages add their worker there.

**Alternatives rejected:**

- Loading Monaco from a CDN (cdn.jsdelivr.net): the SQL and cell editors go blank whenever Tauri cannot reach it.

## Detail

**Monaco is bundled, not CDN-loaded.**
   `src/lib/monaco/monaco-setup.ts` wires workers via Vite `?worker` imports and calls `loader.config({ monaco })`. Without this, the SQL editor and the cell editor go blank when Tauri can't reach `cdn.jsdelivr.net`. Don't reintroduce a CDN dependency; if you add a new Monaco language, add its worker here.
