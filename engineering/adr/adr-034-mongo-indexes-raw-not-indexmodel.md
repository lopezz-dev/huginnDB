---
id: 34
type: adr
status: accepted
date: 2026-08-17
tags: [mongodb]
triggered_by_external_trap: true
related: [29, 33]
supersedes: []
superseded_by: null
amends: []
---

# ADR #34: MongoDB indexes are read from raw listIndexes, never mongodb::IndexModel

The typed `IndexModel` discards key direction, index type, and most options, so there are deliberately two index readers — a lossy one feeding the SQL-shaped explorer DTO and a full-fidelity one feeding the index manager, which also refuses editing the `_id_` index and treats "edit" as parse-validate-then-drop-and-create.

**External trap behind it:** mongodb::IndexModel drops per-key direction/type, sparse, expireAfterSeconds, partialFilterExpression, collation, weights and hidden, so rebuilding from it silently recreates indexes differently.

**Decision:** MongoDB indexes are read from raw listIndexes documents and written via createIndexes/dropIndexes/collMod run-commands, with a deliberately lossy reader for the SQL-shaped explorer DTO and a full-fidelity one for the index manager.

**Alternatives rejected:**

- Using mongodb::IndexModel: discards key direction, index type and most options.
- Collection::create_index: lossy in the outbound direction.
- Deduplicating the two readers: the explorer one cannot grow without breaking SQL drivers.
- Guarding the _id_ index only in the UI: refused in the backend too.
- Collapsing a blank optional document to {}: {} is a meaningful partial filter.
- Rendering missing size/usage stats as zeros: would read as 'unused'.

## Detail

**MongoDB indexes are read from the RAW `listIndexes` documents, never from `mongodb::IndexModel` — and there are now TWO index readers on purpose.** `db/mongo/schema.rs::list_indexes` feeds the SQL-shaped explorer DTO (`commands::schema::IndexInfo`: name + column *names* + `unique`) and is deliberately lossy; `db/mongo/indexes.rs::list_indexes` feeds the index manager and is not. Don't "deduplicate" them — the whole point is that the second one exists because the first can't grow without breaking the SQL drivers it also serves. The invariants:
    - **The typed `IndexModel` throws away everything an editor needs**: the per-key direction (`1`/`-1`) and type (`text`, `2dsphere`, `hashed`), `sparse`, `expireAfterSeconds`, `partialFilterExpression`, `collation`, `weights`, `hidden`. Rebuilding `{ createdAt: -1 }` from a field-name list recreates it *ascending* — invisible in testing, permanent in the data, ADR #29's exact failure mode. The raw reply document preserves key order, key values and every option, and whatever `MongoIndexInfo` doesn't model explicitly survives in `extra_options` as source text (with `NOISE_OPTIONS` — `v`, `ns`, the `*IndexVersion`s — filtered out because the server owns them). Writes use `createIndexes`/`dropIndexes`/`collMod` run-commands, not `Collection::create_index`, which is lossy in the outbound direction for the same reason.
    - **Same one-grammar rule as #33**: key documents, partial filters, collations and weights cross the IPC boundary as source text and are parsed by `shell::parse_relaxed_value`, rendered by `values::bson_to_shell_text`. `lib/mongo/indexKeys.ts` recognises the six pickable key values and assembles source text — it is not a parser, and an index whose keys it can't express opens in the dialog's **raw** mode from `keysSource` rather than being flattened into something the picker can show. That is why `keysSource` crosses alongside the parsed `keys`.
    - **`_id_` is refused in the backend** (`reject_id_index`), not only greyed out in the UI. **A blank optional document is `None`, never `{}`** — `{}` is a *meaningful* partial filter (matches everything), so collapsing the two would build a different index than the one asked for.
    - **"Edit" is drop + create** — `collMod` reaches `hidden` and nothing else — so `recreate_index` parses and validates the new spec *before* dropping, and its post-drop failure message names the now-missing index. **Hide is the reversible rehearsal for drop** and is why it sits next to it in the row menu.
    - Sizes (`$collStats` → `indexSizes`) and usage (`$indexStats` → `accesses`) are **best-effort**, like `schema.rs::collection_sizes`: a role without the privilege leaves them `None` and the UI drops the column entirely rather than rendering a column of zeros that reads as "unused". Index tabs are ephemeral and deduped on (connection, schema, table). Not exposed over MCP — these are writes, and that's a write-policy decision, not a UI side effect.
