---
id: 58
type: adr
status: accepted
date: 2026-09-01
tags: [mcp, security]
triggered_by_external_trap: false
related: [39, 52]
supersedes: []
superseded_by: null
amends: []
---

# ADR #58: MCP exposure lives on the profile; --connections has three distinct states

`ConnectionProfile::mcp_exposed` replaces a client-config-only allowlist and is re-read per call rather than cached from the handshake, so it can change mid-session; `Config.pinned`'s `None`/`Some(set)`/`Some(empty)` states are all load-bearing.

**Decision:** MCP exposure lives on ConnectionProfile::mcp_exposed (default false) and is re-read per call; --connections maps to Option<HashSet> where None defers to profiles, Some(set) pins, and Some(empty) means expose nothing.

**Alternatives rejected:**

- Keeping the allowlist only in the MCP client's --connections config: rejected because the app owned the decision but could not make it.
- Caching the allowlist from the Hello handshake: rejected because clients hold a sidecar for days, reproducing the staleness the change removes.
- Collapsing --connections "" into None: rejected because it would turn a deliberate lockdown into wide-open exposure.
- resolve_connection as a method reading the real profiles.json: rejected because tests would answer differently per machine.
- Guessing an ambiguous connection name: rejected; the candidates are listed instead.

## Detail

**The MCP connector's exposed set lives on the profile, its `--connections` flag has THREE states, and the name resolver had to be pure to be testable at all.** Which connections the sidecar may reach used to live only in the MCP client's own config (`--connections <uuid>,<uuid>`), which is the same misplacement ADR #39 argues about JSON-Schema bindings, one level out: the app owned the decision and could not make it. The tell was the asymmetry — `mcp_write`, the *more* security-relevant half, was already on `ConnectionProfile` and already re-read from disk per write attempt, so the coarser knob was the nailed-down one. It is now `ConnectionProfile::mcp_exposed`, and the pieces that will bite:
    - **`Config.pinned` is `Option<HashSet<String>>`, and all three states are load-bearing.** `None` (no flag) defers to `mcp_exposed`; `Some(set)` pins that set for the life of the process, because an argument the user typed outranks a checkbox — in *both* directions, so ticking a box must not widen a pinned client and unticking must not narrow it; `Some(empty)` (`--connections ""`) is an explicit "expose nothing" and must never collapse into `None`, which would turn a deliberate lockdown into a wide-open one on upgrade. Opt-in survives the migration for free: `mcp_exposed` defaults to `false`, so a client launched bare after the upgrade reaches nothing until the user ticks something.
    - **Exposure is re-read per call, which is the whole point, and that broke the bridge's model.** The app cached the allowlist from the `Hello` frame for the session; a handshake happens once and an MCP client holds its sidecar for days, so a snapshot reproduced exactly the staleness the change removes. `bridge::server::Exposure` now has two variants — `Declared(set)` for a pinned client, `FromProfiles` for a deferring one, which re-asks `state.profiles` (in memory, and the app owns the file) per request. The `Hello` flag is additive with **no `PROTOCOL_VERSION` bump**, and the sidecar still sends its startup snapshot in `allowed` even when deferring: an old app then enforces the snapshot, which is the *old behaviour* rather than a refusal — and a refusal is the one outcome the sidecar cannot degrade from, since it arrives as an error reply mid-tool-call instead of `Unreachable` (see that constant's own doc).
    - **`resolve_connection` is a free function taking `(&Config, &str, &[ConnectionProfile])`, not a method.** It began as a method reading `self.all_profiles()`, which reads the real `profiles.json` — so every test of it would have answered differently on the maintainer's machine (31 profiles) than in CI (none), which is convention #52's lesson arriving one function early: a seam, not a mock. Note `write_policy` gets away with the disk read only because its fallback is per-*lookup* (`.find().or_else(in-memory)`), which a whole-list read cannot copy.
    - **An id always wins over a colliding name**, resolution is scoped to exposed profiles only (a name must not reach what the user did not expose), an ambiguous name is refused with its candidates listed rather than guessed at — profile names are not unique, and two clients' "Producción" is the ordinary case — and a real-but-unexposed reference gets its own message naming the fix that applies (a checkbox, or the command line). Every tool canonicalises in its first line via `Parameters(mut a)`; `ensure_connected` re-checks anyway, because that convention is exactly what a new tool forgets.
    - **Strictly local in both directions.** `merge_into` preserves it across a shared-origin sync (a publisher cannot expose a database here; a refresh cannot revoke access mid-session) and `apply_profile_imports` **clears** it — `ExportedProfile` flattens the whole `ConnectionProfile`, so a bundle from a machine that had it set would otherwise expose those servers the moment someone imported it to look at. `mcp_write` is deliberately left alone on import: a policy on a connection nothing can reach grants nothing.
