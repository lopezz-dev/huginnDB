---
id: 41
type: adr
status: accepted
date: 2026-08-20
tags: [state-files]
triggered_by_external_trap: false
related: [26]
supersedes: []
superseded_by: null
amends: []
---

# ADR #41: Every JSON state file's path, load and atomic save go through state_file.rs

`load_or_default` silently degrades for preferences and known-hosts, while `tab_state` and `json_schemas` propagate parse errors for their own reasons, and `store::load_profiles` deliberately uses neither since an empty profile list is never a safe default.

**Decision:** Every JSON state file's path, load and atomic save goes through state_file.rs, with load_or_default for preferences/known-hosts, read_bytes for tab_state/json_schemas, and store::load_profiles propagating parse errors.

**Alternatives rejected:**

- Per-module copies of path/load/save: one drifted to a non-atomic fs::write on profiles.json.
- Silently defaulting profiles.json on a parse error: an empty profile list is not a safe default.

## Detail

**Every JSON state file goes through `src-tauri/src/state_file.rs` — path, load and atomic save.** Five modules own a file (`store`→`profiles.json`, `prefs`→`prefs.json`, `tab_state`→`tab_state.json`, `json_schemas`→`json_schemas.json`, `ssh_known_hosts`→`known_hosts.json`) and each used to carry its own copy of the same three steps. Two things came out of that:
    - **One copy had drifted.** `store::save_profiles` wrote with a plain `fs::write` while the other four did temp-file + rename — on the one file whose loss costs the most (every saved connection, plus the keychain entries, JSON-Schema bindings and origin links keyed on those profile ids). `save_atomic` is now the only writer.
    - **Loading comes in two flavours, and the choice is a policy decision, not a style one.** `load_or_default` is silent degradation, correct for preferences and known-hosts: a corrupt file costs a setting, never a launch. `read_bytes` stops one step earlier for the two files whose parse isn't a plain `from_slice` — `tab_state` deserialises `RawState` and returns `(state, origin remap)` after migrating v1–v4, and `json_schemas` has to *warn* about a future-version file rather than replace it. **`store::load_profiles` deliberately uses neither**: it propagates the parse error, because an empty profile list is not a safe default there (see the state-map table).
    - Adding a state file means one `state_file::save_atomic` call, not a new path helper — which is also what keeps ADR #26's canary rule enforceable in one place instead of six.
