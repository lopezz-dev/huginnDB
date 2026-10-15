---
id: 39
type: adr
status: accepted
date: 2026-08-19
tags: [json-schema, monaco, state-files]
triggered_by_external_trap: false
related: [16, 25, 27, 29, 30, 32, 33, 36]
supersedes: []
superseded_by: null
amends: []
---

# ADR #39: JSON Schema bindings are global metadata resolved by a Rust-only cascade

The schema library and its column bindings live in a dedicated global `json_schemas.json`; bodies are opaque source text never parsed in Rust, resolution specificity is column > table > db_schema > connection, and validation never gates a save.

**Decision:** JSON Schema bindings are global metadata in their own json_schemas.json, bodies are opaque source text, resolution is a Rust-only cascade (column > table > db_schema > connection), and validation never gates a save.

**Alternatives rejected:**

- Storing bindings on Environment: reproduces the visible_databases bug (gotcha #27).
- Storing in tab_state.json: LRU-pruned, which a user library must never be.
- Storing in prefs.json: bodies are large and prefs.json is rewritten on every Ctrl+wheel.
- Parsing bodies as serde_json Value: BTreeMap re-alphabetises keys; enabling preserve_order globally would reorder every Value in the app.
- Mirroring the cascade in TypeScript: drift would be permanently invisible.
- Letting validation gate saves: the database is the authority.
- Putting the binding on WorkingColumn: would re-trigger the debounced DDL preview.
- Scoping the change event to a target window: a schema edit would not apply in other windows.
- Whole-blob writes: two windows would clobber each other (issue #18).
- Widening an unknown-connection binding to a wildcard or dropping it on import: changes meaning or loses intent.
- Keying schema import conflicts on id: ids never collide across machines, names do.

## Detail

**A JSON Schema binding is *local metadata* resolved by a cascade that exists only in Rust — and the library is global, not per environment.** The feature is a library of user-authored schemas (`json_schemas.json`, owned by `src-tauri/src/json_schemas/`) plus a list of bindings attaching them to columns, feeding Monaco's already-bundled JSON worker. The things a future session would get wrong:
    - **Global, and in a file of its own.** A binding is `(table, column)`, so it describes the *server*, not the Producción/Staging axis: putting it on `Environment` reproduces the `visible_databases` bug (ADR #27) a third time, and `tab_state.json` is LRU-pruned, which a user-authored library must never be. Not `prefs.json` either — a body is 50–200 KB and `prefs.json` is rewritten (debounced 400 ms) on every `Ctrl`+wheel of the grid. The precedent is `GridPrefs::column_widths`: also per-table-column, also global.
    - **`body` is source text and the backend never parses it.** `serde_json::Map` is a `BTreeMap` unless `preserve_order` is on, so a `Value` would silently re-alphabetise the user's keys on every save; enabling that feature is worse, since it is *global* to `serde_json` in this tree and would reorder every `Value` in the app (BSON conversions, Extended JSON, `internal_layout`). Keeping the body opaque also keeps ADR #33's one-parser rule true for free: the only JSON Schema parser in the product is the one inside Monaco's worker.
    - **The cascade is Rust-only. Do not mirror it in TypeScript.** `resolve_json_schemas_for_columns` answers for a whole relation in one call (once per data tab, never per cell) and the single-column variant covers MongoDB dotted paths, which are not known until the user expands a field (ADR #29). Granularity, not language, is the answer to the performance objection. A resolution bug is not an error — it is "the completion did not appear" — so drift here would be permanently invisible (ADRs #30/#33). Specificity is `column > table > db_schema > connection`, and connection being the **lightest** axis is load-bearing: a whole-connection blanket rule must lose to one naming the exact table and column, while connection breaks ties between otherwise identical rules. `column`'s glob treats `.` as a literal, so a binding on `customData` does not leak onto `customData.format`. Every resolution command folds a synthetic `<parent>::db::<db>` id through `parent_connection_id` first — forget that and bindings silently never match on a server-wide connection (ADRs #32/#36).
    - **Validation must never gate a save.** Nothing in the commit path reads markers and `schemaValidation` is pinned to `"warning"`, so a violation does not even look like it blocks. The database is the authority.
    - **Three Monaco traps, all verified against the worker source and all surfaced in the UI rather than hidden** (`src/lib/monaco/monacoJson.ts`): `setDiagnosticsOptions` is a *total replacement* that stops the JSON worker and recomputes every JSON model's markers, so the schema array is rebuilt from a map behind a signature guard and never per keystroke; an unresolvable `$ref` does not merely warn — it cancels validation of the whole document, which is why `collectExternalRefs` exists and why `enableSchemaRequest: false` is passed explicitly; and a document's own `$schema` key **takes precedence over `fileMatch`**, so a configuration blob that declares one ignores its binding entirely (the badge says so). Two things need no work: the draft-07 meta-schema already ships inside the worker, and the diagnostics adapter already debounces at 500 ms.
    - **A cell editor's model `path` must be stable *and* carry its surface.** Schemas attach by `fileMatch` against the model URI, so the default `inmemory://model/N` can never match; and `@monaco-editor/react` looks a model up by path and disposes it on unmount, so the modal and the docked panel sharing a path would have the first to unmount destroy the other's model. The nonce is `editorKey`, which makes "changed path" and "remounted" one event.
    - **In the structure editor a binding lives OUTSIDE `WorkingColumn`.** `desired` is built with `columns.map(({ _key, ...c }) => c)`, so a field on the working column rides into the `preview_structure_change` payload and re-triggers the debounced DDL preview on every pick. A separate map makes that impossible by construction, not by discipline (ADR #16). That surface is also an *addition*: `supportsDdlEditing` excludes MongoDB and SQL Server, and MongoDB benefits most — the badge is the universal path.
    - **The change event is a global `emit` and the bridge listens WITHOUT a `target`.** That looks like gotcha #25's cross-window leak and is its deliberate opposite: that bug was a per-window payload reaching every window, whereas this is one global file whose cached resolutions go stale everywhere at once. Scoping it would mean a schema edited in one window silently not applying in another. Its payload is `()` and the listener re-fetches — shipping the library would reintroduce the cost of living in `prefs.json`.
    - **Writes are per item** (`save_profile`'s shape, not `update_preferences`'s): a whole-blob save would let two windows editing different schemas clobber each other, which is issue #18 exactly.
    - **Deleting a profile sweeps its bindings; deleting a schema cascades to them.** A profile id is a uuid that is never reused, so such a binding is provably dead rather than inert-but-meaningful — a keyed payload worth reaping (ADR #27) — and the asymmetry is what makes it safe: the schema, the expensive artefact, is never touched. Related: `apply_profile_imports` mints a fresh uuid even on `Overwrite`, so it returns the overwrite subset of its id map and both callers repoint bindings through `remap_connection_ids`. Nothing depended on that id before, which is why the bug was invisible.
    - **On import, a binding whose connection is unknown locally is DISABLED, keeping its original id.** Widening it to a wildcard changes what the rule means; dropping it loses intent with no way to notice. Schema conflicts key on **name**, not id (unlike `transfer::detect_conflicts`): two machines mint independent uuids for "the same" schema, so the id can never collide and the name always will.
    - **Don't call it the MongoDB collection validator.** `docs/MONGODB_ROADMAP.md` item #2 is a *different* feature — a server-side `$jsonSchema` enforced on writes, in a BSON-flavoured dialect. Keep the nouns apart in UI copy and docs, or support answers the wrong question forever.
