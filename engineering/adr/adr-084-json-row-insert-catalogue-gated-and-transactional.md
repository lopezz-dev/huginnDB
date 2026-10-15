---
id: 84
type: adr
status: accepted
date: 2026-09-15
tags: [grid, sqlx, mssql]
triggered_by_external_trap: false
related: [4, 30, 31, 49, 77]
supersedes: []
superseded_by: null
amends: []
---

# ADR #84: Pasted JSON rows are catalogue-gated, refused when heterogeneous, and chunked inside one transaction

`commands::insert` turns pasted JSON into **one** multi-row `INSERT` per bind-ceiling chunk, all inside one transaction. Four decisions are non-obvious and each had a worse-looking alternative: a JSON key is never a column name until the catalogue says so, a row whose key set differs from row 0 is refused rather than unioned or grouped, a boolean's rendering is decided by the column's `data_type` and not by the dialect, and the command is deliberately absent from the MCP surface.

**Decision:** `commands::insert` turns pasted JSON into one multi-row INSERT per bind-ceiling chunk inside one transaction, resolving keys against the catalogue, refusing rows whose key set differs from row 0, rendering booleans by column data_type, and staying off the MCP/bridge surface.

**Alternatives rejected:**

- Union the columns and bind NULL for missing keys — rejected as incorrect because it overrides column DEFAULTs.
- Group rows by key signature — rejected because a key typo would silently become a defaulted column and it breaks the single-statement Console property (left as a possible follow-up).
- Preserving the paste's key order — not available because serde_json is built without preserve_order; catalogue order is used.
- Deciding boolean rendering by dialect — rejected because only the column type knows a JSON true bound for a text column must be stored as 'true'.
- Retrofitting catalogue-only typing onto insert_row_inner — rejected; its hint-first read is a deliberate hot-path optimisation.
- Looping over execute_params — rejected because each call acquires a separate connection and loses atomicity; in_tx_expect_at_most_one could not be reused because it rolls back on more than one affected row.
- One Console line per chunk — rejected because it would read as independently committed statements.
- Returning generated ids — rejected because the engines disagree on what a multi-row insert's ids are.
- Exposing the command over MCP/bridge — rejected: zero gain over structured insert_row against the risk of non-compiler-enforced wiring points.
- Enabling serde_json arbitrary_precision — rejected for its app-wide blast radius.

## Detail

**`insert_documents` argues that free-form text is MongoDB-only, and that argument is still true — it is just about a different want.** Its docstring says a SQL table has a column set the server enforces, so there is nothing document text can express there that `insert_row` cannot. That is correct about *shape*. What SQL was missing is **bulk**: `insert_row` is one row per call, so "here are forty rows" had no path short of hand-writing an `INSERT` in the query editor (`ROADMAP.md`'s open item #1). `insert_rows` is that, and it is a strict-JSON parser rather than the mongosh grammar precisely because the column set makes strictness possible.

**A JSON key is user input, so it is not a column name until the catalogue says so.** Convention #4 is the whole security story of this feature: `quote_ident` is documented as catalog-only, and here the *keys* are what want to become identifiers. `resolve_columns` matches each key against `list_columns_inner` case-insensitively and emits the **catalogue's** spelling, so what reaches `quote_ident` is always a catalogue string. An unmatched key is a refusal naming it and listing the real columns, never a column invented on the spot. Two consequences worth knowing: a paste from a tool that upper-cases its keys works, and the catalogue read is a **gate, not an optimisation** — unlike `apply_bulk_update`, which degrades to `unwrap_or_default()` because it only wants type hints, this path propagates the failure. An empty catalogue here would report every column in the paste as unknown.

**Column *order* comes from the catalogue, and that is not a preference.** `serde_json` is built without `preserve_order` (`Cargo.toml`), so a `Value::Object` is a `BTreeMap` and its key order is already alphabetical rather than what the user typed — "preserve the paste's order" is not an option that exists. Catalogue order also matches what the grid shows and makes the emitted SQL deterministic, which is what lets the builder be tested by string equality.

**A row whose key set differs from row 0 is refused, and both rejected alternatives are worse.** Union-the-columns-and-bind-NULL is the obvious one and it is *incorrect*: it overwrites the column's `DEFAULT`, so a `NOT NULL DEFAULT now()` column turns a valid insert into a constraint violation and a nullable-with-default column silently gets the wrong value. "Omitted column takes its default" is the semantics `insert_row` documents, and a multi-row `VALUES` list cannot express per-row omission at all. Grouping rows by key signature is defensible and was still rejected *first*, on two grounds: the overwhelmingly common cause of a differing key set is a typo in a key name (`emial`), and grouping turns that typo into a column silently taking its default; and it breaks the "one statement I can show you" property that makes the Console entry honest. It remains a clean follow-up if real pastes ask for it — the chunking machinery already emits several statements in one transaction, so the plumbing exists. Per ADR #77 the refusal names the fix, which is why the message carries the row index, both sides of the key difference, and the sentence about `null`.

**A boolean's rendering is decided by the column's `data_type`, not by the dialect.** This inverts the instinct, and the reason is the case a dialect branch could not cover. `"1"`/`"0"` is in fact accepted by all four engines' boolean inputs — Postgres's boolean parser takes it, MySQL wants digits, SQL Server's `bit` outright *rejects* `'true'` — so for the boolean-column case the dialect never needs asking. What does need asking is the opposite direction: a JSON `true` destined for a `text` column must be stored as `"true"`, not as `1`. Only the column's own type knows that, and the catalogue is already in hand. `is_boolean_column` reuses `mysql::is_bit_type` rather than repeating the `BIT` prefix test, and also covers MySQL's `tinyint(1)`, which is what its `BOOLEAN` alias expands to.

**`InsertColumn::data_type` being catalogue-sourced by construction is what makes the MySQL `BIT` and SQL Server binary paths correct for free.** `insert_row_inner` and `build_update_statement` both carry a conditional catalogue round-trip *because* their type hint comes from whatever schema cache the frontend had on hand and may be `None`. This path never has that problem, so it has no fallback branch to get wrong. Do **not** retrofit catalogue-only typing onto `insert_row_inner` in exchange: its hint-first read is a deliberate optimisation on the hot cell-commit path.

**The placeholder counter runs continuously across rows, and SQL Server's `@P` is a capital P.** Postgres's `$n` and SQL Server's `@Pn` number the whole statement's bind list, not each tuple, so restarting the counter per row produces a statement that binds the first tuple's values everywhere. The capital `P` is not an alias — `Dialect::placeholder` emits it and `PooledClient::query_rows` requires it — and it has its own test for that reason. The type wrapper is decided **per column** but applied **per cell**, so a `BIT` column is cast in every tuple and not only the first.

**`InsertClauses` is a struct because the two engines disagree about *where* the clause goes.** Postgres appends `RETURNING <pk>`; SQL Server's `OUTPUT INSERTED.<pk>` sits *between* the column list and `VALUES`. A `base_sql + suffix` builder cannot express the second, which is why folding `insert_row_inner` onto this builder needed the struct rather than a string.

**`insert_row_inner` does share the builder, and keeps one deliberate difference.** Its statement text, its MySQL `BIT` branch and its SQL Server `binary_convert` branch were three separate spellings in `query.rs`, which this would have made a fourth — the same argument `bulk.rs` makes for extracting `build_update_statement` "so the two can never diverge". What did *not* move is the tail that is genuinely about recovering one row's key: the `SCOPE_IDENTITY` fallback on error 334, Postgres's `fetch_all`-vs-`execute` split, and `last_insert_id`/`last_insert_rowid`. And its column typing stays **hint-first** (`RowValue::column_type`, falling back to the catalogue only when absent) rather than adopting this module's catalogue-only rule: that conditional round trip is a deliberate optimisation on the hot cell-commit path, and making it unconditional would pay for a catalogue read on every single-cell insert.

**Chunking exists because of the bind ceiling, and the transaction exists because chunking does.** `max_binds` is exhaustive over `Dialect` (ADR #30 — a fifth engine must choose a number rather than inheriting Postgres's through a `_ =>` arm): 65535 on Postgres and MySQL, 32766 on SQLite, and 2000 on SQL Server against a TDS hard limit of 2100. A 500×20 paste is five statements on SQL Server and one everywhere else. Those statements go through **`db::exec::execute_params_in_tx`**, which is a new function rather than a loop over `execute_params` for one reason: `execute_params` acquires a connection per call, so a loop would scatter the chunks across sessions and lose the atomicity the chunking created the need for. `in_tx_expect_at_most_one` could not be reused despite the shape — it takes one statement and *rolls back when more than one row is affected*, the exact opposite of a bulk insert. The SQL Server arm acquires **once** and issues `BEGIN`/`COMMIT`/`ROLLBACK TRANSACTION` as statements, per ADR #31; the three `sqlx` pools lean on `Transaction`'s rollback-on-drop, so a `?` mid-list unwinds with no explicit branch. One caveat the caller inherits: on MySQL the atomicity is only as real as the storage engine — InnoDB honours it, MyISAM commits per statement.

**One Console line per paste, not one per chunk.** The transaction is a single unit of work; N entries would read as N independently-committed statements, which is precisely the thing the transaction guarantees is not happening. A multi-chunk paste logs the first statement plus a trailing SQL comment naming the rest.

**No generated ids come back, deliberately.** The four engines cannot agree on what a multi-row insert's ids even are: MySQL's `last_insert_id()` reports only the *first*, SQL Server's `SCOPE_IDENTITY()` only the last, and only Postgres's `RETURNING` would hand over all of them. An honest count beats one id out of five hundred. `InsertClauses` is the hook if per-row ids are ever wanted on the two engines that can — but that asymmetry should be a decision someone makes, not a side effect.

**The command is deliberately absent from the MCP/bridge surface.** MCP already has structured `insert_row` with typed `RowValueArg` values; a text blob gives a model nothing it cannot already do, and the structured shape serves it better. Against that zero gain, convention #49 prices the cost: a new *write* variant needs six wiring points and **three are not compiler-enforced** (`bridged_connection_id`, `policy_id_of`, `class_of`, all ending in `_ => None`), and missing either of the last two lets a `read-only` connection perform a write. This is a paste-from-clipboard affordance whose user is a person in front of the grid.

**A caveat the rustdoc carries rather than works around:** `serde_json` is built without `arbitrary_precision`, so an integer past `i64`/`u64` arrives as an `f64` and renders in exponent form (`1e30`), which SQL Server's `decimal` conversion rejects. Paste such a value as a JSON *string*. Enabling the feature would change `Value::Number` semantics for every path in the app, the MongoDB ones included — far too wide a blast radius for this.
