---
id: 57
type: adr
status: accepted
date: 2026-08-31
tags: [monaco, mongodb]
triggered_by_external_trap: false
related: [9, 33]
supersedes: []
superseded_by: null
amends: []
---

# ADR #57: The Mongo completion provider uses a cursor scanner, not a parser

`monacoMongo.ts` follows `monacoSql.ts`'s per-model registry pattern to avoid duplicate providers, and `completionContext.ts`'s forward scan answers "what key/stage is the cursor in" without validating or building an AST, staying consistent with ADR #33's one-parser rule.

**Decision:** Keep one language-global completion provider with a Map<modelUri, entry> registry, and compute cursor context with a single forward scan in completionContext.ts that is explicitly not a parser.

**Alternatives rejected:**

- Registering a completion provider per PipelineEditor instance: rejected because it reproduces gotcha #9's N-duplicate-providers bug.
- Parsing the pipeline into an AST in the frontend: rejected under gotcha #33's one-parser rule.
- Adding the scanner to pipeline.ts next to firstKeySpan: rejected because that file claims to be the one place a body is read.
- Nested/dotted field paths and per-stage output fields: deliberately left out of scope for the first version to limit wrong-but-confident suggestions.

## Detail

**The Mongo pipeline completion provider adopted `monacoSql.ts`'s per-model registry (gotcha #9), and its live suggestions are computed from a cursor-position scanner that is deliberately not a parser.** `src/lib/monaco/monacoMongo.ts` used to offer only three *static* suggestion families (stage operators, expression operators, BSON constructors) — no field or collection name ever appeared, because nothing connected the provider to `useSchema`. Two things had to be true before that data could be wired in without repeating past mistakes:
    - **The provider stays global to the language; a `Map<modelUri, MongoCompletionEntry>` (`registerMongoEditor`) carries the per-editor data**, exactly like `monacoSql.ts`'s `registry`/`registerSqlEditor`. Registering a second `registerCompletionItemProvider` per `PipelineEditor` instance would have reproduced gotcha #9's "N duplicate providers with N tabs open" bug for this language too — the whole reason that gotcha exists is that this is easy to get wrong a second time in a sibling file.
    - **Knowing "is the cursor inside `$lookup.from`?" needs *some* structural awareness of the stage body, but ADR #33 still holds: the frontend never parses a pipeline.** `src/lib/mongo/completionContext.ts`'s `completionPositionAt` is a single forward scan that tracks brace/bracket depth and which key precedes each value — enough to answer "what key is this value the value of, and is that key's own value itself the value of `$lookup`?" — and nothing more: no validation, no AST, and it degrades to `"unknown"` rather than guessing on anything it doesn't recognise, same philosophy as `pipeline.ts`'s `firstKeySpan`/`operatorOf` it sits next to in spirit (different file, because pipeline.ts's own doc comment calls `firstKeySpan` "the one place" it reads a body — a second, differently-shaped scanner earned its own module rather than muddying that claim). It never looks past the cursor either: an auto-closed quote sitting after the cursor is not "closed" from the scanner's point of view, which is what keeps `$lookup.from: "|"` (cursor between the two auto-inserted quotes) reporting the right key instead of reading ahead into unwritten territory.
    - **Every suggestion source is either already in memory or fetched at most once per collection per session.** `AggregationTab` reads `useSchema.byConnection[connectionId].tables`/`.columns` — the same eager table list and lazy, session-cached `loadColumns` (`infer_columns`, top-level fields only) the schema tree already uses — and adds one `pendingFieldsRef` set on top, so a burst of completion requests for a collection whose fields haven't loaded yet (one per keystroke, since the provider can't await anything) fires `loadColumns` at most once, not once per keystroke. A `$lookup`'s `from` collection is only ever sampled once the user actually references it; the pipeline's own source collection is preloaded eagerly since it's needed almost everywhere. No backend changes were needed — `list_tables`/`list_columns` already covered both cases.
    - **Nested/dotted field paths (`customData.format`) and "fields after this stage" are out of scope on purpose.** `infer_columns` only returns top-level fields, and the live per-stage output (`AggregationTab.stagePreviews`) that *would* let a later stage suggest fields the previous stage actually produced was left unconnected — both are natural follow-ups (the latter via `lib/grid/documentTree.ts`'s `flattenDocument`, which already turns a sampled `QueryResult` row into dotted paths for the list view), not implemented here, to keep the first version's surface area — and its risk of a wrong-but-confident suggestion — small.
