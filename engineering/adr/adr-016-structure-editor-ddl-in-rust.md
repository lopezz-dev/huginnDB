---
id: 16
type: adr
status: accepted
date: 2026-06-02
tags: [security, sqlite, mysql]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #16: The structure editor builds DDL in Rust, never in the component

`preview_structure_change` and `apply_structure_change` both call the same pure `build_ddl` builder so what's previewed is exactly what runs. User-entered identifiers go through `validate_ident`/`validate_type`/`validate_default` as the one sanctioned exception to the never-let-user-input-reach-`quote_ident` rule.

**Decision:** StructureEditorTab sends the desired TableStructure to preview_structure_change/apply_structure_change, which both call the pure build_ddl in src-tauri/src/db/ddl.rs, validating user identifiers/types/defaults before quoting.

**Alternatives rejected:**

- Building DDL in the frontend component: not done; the Rust builder guarantees what is previewed is what runs.

## Detail

**The table-structure editor builds DDL in Rust, never in the component.** `StructureEditorTab.tsx` sends the desired `TableStructure` (+ the original snapshot when editing) to `preview_structure_change` / `apply_structure_change`; the pure builder in `src-tauri/src/db/ddl.rs` (`build_ddl`) diffs them and returns the ordered statements. Preview and apply call the *same* builder so what's shown is what runs. DDL can't use bound parameters for identifiers, so every user-entered name goes through `validate_ident` before quoting, and types/defaults through `validate_type`/`validate_default` (conservative allowlists) — this is the SECURITY.md "user input never reaches `quote_ident`" rule's one sanctioned exception, mediated by validation. A rename-vs-drop+add is told apart by each `ColumnDef.original_name` (the diff matches on it). SQLite changes that `ALTER TABLE` can't express (type/nullability/PK/FK) trigger the 12-step rebuild in `build_sqlite_rebuild`; `preview` flags `rebuild: true` so the UI shows a destructive confirmation. Apply runs PG in one transaction, MySQL statement-by-statement (DDL is non-transactional there), and SQLite verbatim (the rebuild manages its own `PRAGMA foreign_keys` toggles outside any tx). Structure tabs are **not** persisted (filtered out in `persistedTabs.ts`) — they're ephemeral editing sessions.
