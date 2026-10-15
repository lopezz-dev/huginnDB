---
id: 52
type: convention
status: active
date: 2026-08-25
tags: [testing, state-files]
related: [49]
supersedes: []
superseded_by: null
amends: []
---

# Convention #52: cargo test writes to the real state directory unless a seam prevents it

`state_file::path` has no test override, so a test reaching `save_profiles`/`state_file::save_atomic` overwrites the developer's real `profiles.json`. The fix is extracting a testable seam (a pure `merge_into` taking `&mut Vec` plus live-pool ids) rather than mocking.



## Detail

**`cargo test` writes to the REAL state directory. A test must never reach a function that ends in `save_profiles` / `state_file::save_atomic`.** `state_file::path` resolves through `dirs::config_dir()` + `APP_DIR` with no test override, so under `cargo test` that is the developer's own `%APPDATA%/HuginnDB/`. Three tests written against `commands::origins::merge_profiles_bundle` — whose last statement inside the lock is `store::save_profiles` — therefore overwrote a real 31-connection `profiles.json` with a one-profile fixture, and the *first* symptom was not that: it was two of them failing only in a full run and passing in isolation, because they were racing each other for the same file. Recovery was luck, not design: the app happened to still be running, and since `save_profiles` writes the whole in-memory vector, the next save from the GUI restored everything. The keychain was untouched (the tests never got that far), so the passwords survived; had the app been closed, the metadata was gone. Two rules come out of it:
    - **The fix is a seam, not a mock.** `merge_into` now holds the merge rules and takes `&mut Vec<ConnectionProfile>` plus the live-pool ids, with `save_profiles` left to its caller — the same shape `plan_bulk_delete` / `sweep_tab_state_for_profiles` (convention #49's neighbourhood) and `already_landed` / `spec_is_view` already have. Notice what the old shape cost: rules this fiddly (which fields a refresh may overwrite, whether one origin may claim another's profile, what a live pool defers) had **no** coverage at all, precisely because the only entry point insisted on writing to disk first. An untestable function is not a neutral fact about the code; it is an absence of tests.
    - **Before writing a test, follow the call to its last statement.** `AppState::new()` also *reads* the real `tab_state.json` and `profiles.json`, and one branch of `new_with_args` writes them (the origin-id remap). It is read-only in practice, which is not the same as safe by construction — treat a test that constructs it as touching live state.
