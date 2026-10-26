---
id: 113
type: adr
status: accepted
date: 2026-10-25
tags: [policy, security]
triggered_by_external_trap: false
related: [94, 95, 96, 97, 98]
supersedes: []
superseded_by: null
amends: []
---

# ADR #113: a policy rule limits columns per verb, judged as a union beside the relation's verb, and free-form writes close under a limited verb

A managed policy could say which relations a role reaches and which verbs it may use there, but not "you may read this table and change only its status". A rule now carries `columns: { insert?: [globs], update?: [globs] }`, read as a narrowing of the verbs the rule already grants on every relation it reaches. It is checked as its own `Need::Columns` beside the unchanged `Need::Relation`, folded across rules as a union like every other grant, and enforced at the same two choke points as the rest of the policy: `bridge::exec::execute` for the AI, the command wrappers for people.

**Decision:** `policy::model::Rule::columns` (`Columns { insert, update }`, `None` = every column, `[]` = none) is judged by `Ctx::decide(Need::Columns { schema, name, verb, columns })`. Every column must be covered by some rule that reaches the relation and grants the verb, where a rule without a limit for that verb covers every column. On MongoDB a column is a field path judged by its top-level field (`top_level_field`), and `_id` is never limited on insert. `Need::FreeSql(verbs)` additionally needs a rule that does not limit the columns of an `INSERT`/`UPDATE` in `verbs`, so free-form writes close while free-form reads stay open. People are checked by `commands::guard::columns` in `update_cell`, `unset_field`, `apply_bulk_update`, `insert_row`, `insert_rows`, `insert_documents` and `import_collection`, and the AI by `enforce::needs_of` for `UpdateCell`/`InsertRow`. `grants::build` writes `UPDATE (cols)` everywhere and `INSERT (cols)` everywhere but SQL Server and MongoDB, where it grants the whole object and says why.

**Alternatives rejected:**

- **Columns inside `relations`, keyed by table** (`{"pedidos": {"update": [...]}}`) — rejected because a rule is already "these relations, these verbs", and a per-table map inside it would be a second, nested way to name relations, with its own patterns and its own interplay with `deny`. A rule for one table is how a table gets its own columns.
- **One list for every write verb** — rejected because insert and update want different lists in the case that asked for this (a sales role fills `customer`, `amount`, `status` when adding an order and only changes `status` afterwards). An insert limit that had to equal the update limit would make every NOT NULL column without a default impossible to add.
- **Limiting `delete` too** — rejected: a delete writes no column, so there is no list it could be checked against. The trap it opens (delete a row and add it back with other values) is shown by the editor as a warning with a "remove delete" fix instead of being made impossible by the format.
- **An existential check, one rule covering every column** (as `Need::Relation` treats verbs) — rejected because it would make two rules over the same table *narrower* than either alone for a multi-column insert, and disagree with `relation_columns`, which the interface reads to lock cells. Union is what the rest of the policy means by two rules.
- **Folding the columns into `Need::Relation`** — rejected because every constructor of that variant (reads, DDL, exports) would have to say "no columns", and a forgotten one would read as "no columns written" rather than "not a column question". A separate need is evaluated only where something writes columns.
- **Keeping free SQL open under a column limit** — rejected because the classifier knows a statement's verbs, not the columns a trigger, a view or dynamic SQL writes. Reads stay open because a read writes no column; a rule that also names relations still closes them, as before (D3).
- **Hiding columns from reads in the same change** — deferred. It touches every surface that shows a row (browse, export, copy-as, the AI's browse tools), and on SQL Server a `SELECT *` over a column denied to the user fails outright, so the browse would have to project explicitly. Nothing here prevents it later.

## Context

A customer on SQL Server wanted some of their users to see a table and change one field of it. The policy ended at relation + verb: `update_cell` knew its column but `guard::relation` only asked about the table and `UPDATE`. SQL Server itself can do half of it — `GRANT UPDATE (col)` exists, `GRANT INSERT (col)` does not (column permissions are `SELECT`, `UPDATE` and `REFERENCES`) — which is why the insert half is a HuginnDB guardrail on that engine and the generated script says so.

## Consequences

- **A new field breaks older builds.** `Rule` denies unknown fields, so a policy with `columns` is `Broken` for any HuginnDB that predates it, exactly as `dbUser` was (ADR #97). The editor's save confirmation says so (`summarizeChanges().columnsIntroduced`) and `docs/POLICY.md` asks to update everywhere first.
- **Every command that writes row data must call `guard::columns`** after `guard::relation`, with the columns it will write. The two coverage tests in `commands/guard.rs` only prove that *a* guard is called; a new row-writing command is reviewed for this. Wrappers parse what they must to know the columns (`insert_rows` parses its JSON twice for this; the core stays policy-free, ADR #95).
- **The AI's `InsertRow` columns are read the way the executor reads them** (`Vec<RowValue>` from the untyped `values`): a value the executor would refuse yields no column need, because nothing would be written.
- **The interface reads `RelationAccess.columns`** (`ColumnScope`, from `Ctx::relation_columns`) through `usePolicyColumns`. The grid locks a column's inline edit, side and modal editors, Ctrl+V, Set NULL, list-view field edits and the bulk update's set picker; the draft row leaves a locked column untouched. Advisory like every lock (ADR #96): the backend refuses regardless.
- **Matching is shared.** `src/lib/policy/glob.ts` mirrors `policy::resolve::glob_matches` (`*`, case-insensitive), and its tests pin the cases the two must agree on.
- **The grant script reads columns only where a rule limits them** (`grants::wants_columns`), and a rule with a column limit is always expanded to relations, so the script describes the columns that exist when it is generated. A limit matching no column of a table takes that verb away there instead of granting the whole table.
