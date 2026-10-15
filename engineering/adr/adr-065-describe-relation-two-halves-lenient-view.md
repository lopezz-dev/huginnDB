---
id: 65
type: adr
status: accepted
date: 2026-09-07
tags: [mongodb, mcp]
triggered_by_external_trap: true
related: []
supersedes: []
superseded_by: null
amends: []
---

# ADR #65: A describe has two halves, and the best-effort half must never decide whether the authoritative one runs

`commands::structure::describe_relation_inner` reads a relation's structure and then its view body. The structure half is *inferred* on MongoDB and the view half is read from the catalog, so the inferred half failing must degrade — not abort the call. On a MongoDB view both of its sub-reads fail by construction, which made `describe_table` unable to describe the one relation whose description is the only way to read it.

**External trap behind it:** On a MongoDB view, listIndexes fails with CommandNotSupportedOnView (166) and $sample cannot use its random-cursor fast path because the view's pipeline runs first, so inference times out.

**Decision:** describe_relation_inner reads a RelationKind (Collection/View/Timeseries) once and uses two separate predicates (sample_can_be_fast, has_own_indexes) so a view's inferred structure half degrades to empty instead of aborting the catalog-read view half.

**Alternatives rejected:**

- One boolean for both predicates: rejected because it would either resurrect error 166 or drop a time-series collection's real indexes.
- Leniency for ordinary collections too: rejected because there a sample failure is real and 'no fields' would corrupt the structure editor round trip.
- Reading view definitions from system.views: rejected because application users cannot read it and listCollections carries the same options.

## Detail

A MongoDB view has no `SELECT` body — it is a stored aggregation pipeline (`viewOn` + `pipeline`), reachable only through `listCollections`' `options`. `mongosh` has no DDL vocabulary, so over MCP there is no hand-written query that can substitute: `describe_table`'s `view` object is the *only* way to read a view's definition. That is what made the ordering bug fatal rather than cosmetic.

- **Two sub-reads of the structure half fail on every view, for two different reasons.** `listIndexes` returns `CommandNotSupportedOnView` (code 166) — a view has no indexes of its own, so this is a guaranteed error rather than a cheap "probably nothing". And `$sample` cannot take its fast path: the server rewrites an aggregation against a view to run the view's own pipeline first, so our `$sample` is no longer the first stage and never gets the random cursor. It degrades to reading everything the view produces and sorting by a random key, which on a view over millions of documents does not finish inside `INFER_TIMEOUT_MS`. Whichever fired first, `?` propagated and the view half never ran.
- **The reasoning already existed and was scoped one case too narrowly.** `is_timeseries` avoided exactly this `$sample` collapse — because a time-series collection *is* a view over its `system.buckets.*` backing collection. Same mechanism, same fix, and the catalog lookup was already there; it just only asked "is this time-series". It is now `relation_kind` → `RelationKind::{Collection, View, Timeseries}`, read once per describe and consumed by both halves. **When a workaround names a special case, check whether the general case is the one you are in** — the general case here was "is this a view", and time-series was its exotic instance.
- **The two predicates are deliberately not one.** `sample_can_be_fast()` is false for both view kinds; `has_own_indexes()` is false only for a user-defined view, because a time-series collection *does* answer `listIndexes`. Collapsing them into one boolean would either resurrect the 166 or silently drop a time-series collection's real indexes.
- **Leniency is scoped to the view, and to the half that was best-effort anyway.** A view whose fields cannot be sampled in time is described with an empty `columns`; a *collection* whose sample fails still errors, because there the failure is real (unreachable server, lost privilege) and reporting "no fields" would corrupt what the structure editor round-trips. Field inference is best-effort by construction (module doc); a pipeline read from the catalog is not.
- **The MCP tool description says which half is reliable.** `describe_table`'s text now states that on a Mongo view `columns` may be empty and `indexes` always is. A tool description that promises more than the reply carries is the reason this took three dead ends to diagnose — including one detour through `system.views`, which no application user can read and which was never the right path: `listCollections` carries the same `options`, needs no special privilege, and is what `list_tables` already uses to label a view as a view.
- **`list_indexes` is lenient on its own too**, not just inside `table_structure`, so the app's index panel on a view shows "none" instead of a driver error. It pays one catalog round trip to know; `table_structure` skips that second lookup via `list_indexes_of_collection` because it has already classified the relation.

## Test

`relation_kind_from_spec` and the two predicates are pure over a `listCollections` spec document and unit-tested (`db/mongo/schema.rs`), following `spec_is_view`'s rule that a spec with no recognisable `type` is an ordinary collection — the answer every server old enough not to report one needs.
