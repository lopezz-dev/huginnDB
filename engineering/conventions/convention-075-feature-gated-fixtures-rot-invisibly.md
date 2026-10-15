---
id: 75
type: convention
status: active
date: 2026-09-10
tags: [ci, testing, build]
related: [52, 54, 71]
supersedes: []
superseded_by: null
amends: []
---

# Convention #75: A feature-gated test fixture rots invisibly when CI only runs on main and pull requests

`develop` did not build under `--features mcp` and nobody knew: `mcp/mod.rs`'s `huginn_with_policy` fixture wrote `ConnectionProfile` as a full struct literal, so the `secret_override` field added by `06fae15` broke it — behind a feature flag, in a `#[cfg(test)]` module, on a branch CI does not run.



## Detail

**Two independent conditions had to hold for this to hide, and both are normal.** The `mcp` module is behind a Cargo feature, so a plain `cargo check` / `cargo test` never compiles it; and `.github/workflows/ci.yml` triggers on `main` and pull requests, so a feature branch accumulates work without ever being told. Neither is wrong on its own — the feature gate keeps the default build lean, the CI trigger keeps the runner bill sane — but together they mean the only thing between a broken feature build and a release is a developer remembering to pass `--features mcp` locally. On a branch that ran for seven feature commits, that is not a control.

- **The fix is struct-update syntax over a fixture builder, not a discipline reminder.** `huginn_with_policy` now builds on `testkit::profile` with `..`, so a new `ConnectionProfile` field lands in one place and every fixture inherits it. The general form: a test fixture that enumerates a struct's fields exhaustively is a second definition of that struct, and it will drift. Exhaustiveness earns its cost where a *decision* must be made per variant (ADRs #71, #54) and is pure cost where the fields are only data.
- **Gate every commit on the feature matrix, not just the default build.** The loop used through the AI work was `cargo fmt --check`, `cargo clippy -D warnings` **with and without** `--features mcp`, `cargo test --workspace --features mcp`, `pnpm exec tsc --noEmit`, `pnpm test`. Running clippy twice is the part that catches this class: the default build and the feature build are different programs.
- **It was fixed in its own commit, separate from the feature work.** A pre-existing break at the branch point is not part of the feature that discovered it, and folding it in would have made both harder to read and impossible to cherry-pick.
- **The same shape applies to `#[cfg(test)]` helpers that reach real state** (convention #52): code that compiles in only one configuration is code no default gate protects.
