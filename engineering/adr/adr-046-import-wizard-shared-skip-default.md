---
id: 46
type: adr
status: accepted
date: 2026-08-21
tags: [ui, ux]
triggered_by_external_trap: false
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #46: The three import dialogs share useImportWizard with one default conflict action

Profiles, environments and JSON Schemas all run pick → passphrase → conflicts → done over `lib/transfer/useImportWizard.ts`; the shared `"skip"` default (previously an inconsistent `"rename"` vs `"skip"`) is what stops re-importing your own export from accumulating renamed duplicates.

**Decision:** Profiles, environments and JSON Schemas imports share lib/transfer/useImportWizard.ts with a single 'skip' default conflict action.

**Alternatives rejected:**

- A 'rename' default in one dialog: re-importing your own export accumulated renamed duplicates.
- Byte-identical per-dialog doImport bodies: replaced by the shared hook and import-progress bridge.

## Detail

**The three import dialogs share `lib/transfer/useImportWizard.ts`, and the `"skip"` default lives there.** Profiles, environments and JSON Schemas all run `pick → (passphrase) → (conflicts) → done` over the same nine pieces of state, and their `doImport` bodies were byte-identical including the `listen(IMPORT_PROGRESS_EVENT)` subscription and its `finally` (now `lib/bridges/import-progress-bridge.ts`, so the event has a module like the other seven `huginndb://` events). The default conflict action being in one place is the point: it used to be `"rename"` in one dialog and `"skip"` in the others, which is how re-importing your own export accumulated `name (imported)`, `name (2)`, … on every round trip. Each dialog supplies `analyze`/`run` and an optional `reviewStep`; the conflicts UI is `ConflictResolutionStep`.
