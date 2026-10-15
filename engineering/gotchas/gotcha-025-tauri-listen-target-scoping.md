---
id: 25
type: gotcha
status: active
date: 2026-07-20
tags: [tauri]
related: []
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #25: An untargeted frontend listener receives every window's emit_to

Tauri delivers an event to any listener whose registered target is `EventTarget::Any`, so `startLogBridge` must pass `{ target: getCurrentWindow().label }` or a second window's Console duplicates the first window's SQL/connection log entries.

**Trap:** A frontend listen(event) without a target receives every window's emit_to, so a second window's Console duplicated the first window's log entries.

## Detail

**A frontend `listen(event)` with no `target` receives *every* window's `emit_to`, not just its own.** Command handlers emit Console log entries with `log_bus::emit` → `app.emit_to(window_label, …)`, targeting the window that ran the statement. But Tauri delivers an event to a listener whenever the listener's registered target is `EventTarget::Any` **or** matches the emit target (`manager::emit_filter` short-circuits on `*candidate == EventTarget::Any`), and the JS `listen(event, handler)` defaults to `{ kind: 'Any' }`. So with a second ("New window") window open, both Consoles received both windows' SQL/connection entries — the #50 duplication. Fix: `startLogBridge` (`src/lib/bridges/log-bridge.ts`) passes `{ target: getCurrentWindow().label }`, scoping the listener to `emit_to(thisLabel)` only. Global `emit` broadcasts (`log_bus::broadcast`, e.g. the keepalive connection-lost log in `keepalive.rs`) still arrive — Tauri sends an unfiltered `emit` to every listener regardless of target, which is the intended "all windows sharing the connection care" behaviour. Don't drop the `target` when adding new per-window event subscriptions; a bare `listen` re-introduces the cross-window leak.
