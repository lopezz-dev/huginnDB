---
id: 112
type: adr
status: accepted
date: 2026-10-20
tags: [mcp, security]
triggered_by_external_trap: false
related: [54, 59, 76, 93, 94]
supersedes: []
superseded_by: null
amends: []
---

# ADR #112: a write batch is one transaction of single row writes, and its verify reads run after the commit as ordinary reads

The MCP connector gained `run_queries` (several reads in one call) and `run_writes` (several row writes in one call) so that an agent stops paying a model turn per statement. `run_writes` promises all-or-nothing, and three rules keep that promise true on every SQL engine: the batch is its own `BridgeRequest` executed on one session, each entry is one data write (no DDL, no transaction control, no second statement), and the reads that check the result run after the commit through the same `RunStatement` path `run_query` uses. MongoDB cannot keep the promise and says so (`atomic: false`).

**Decision:** `BridgeRequest::RunWriteBatch { connection_id, policy_id, writes }` is executed by `commands::write_batch::execute_write_batch_inner` inside one transaction (`sqlx::Transaction` on PostgreSQL/MySQL/SQLite, `BEGIN`/`COMMIT TRANSACTION` on one held SQL Server session); `check_writes` refuses empty or oversize lists, multi-statement entries, `db::sql::is_session_statement`, reads, DDL and unfiltered writes, and runs in the sidecar *and* in the executor; `expect_rows` per write rolls the batch back on a different count; `verify` is sent afterwards as plain `RunStatement` reads and a failed one never fails the call.

**Alternatives rejected:**

- A loop of `RunStatement`s in the sidecar — rejected because every `RunStatement` takes its own pooled connection, so no transaction could span the writes; only one request can hold one session.
- Running `verify` inside the transaction, before the commit — rejected because it would run reads an AI wrote inside a *write* transaction, where a statement the text classifier wrongly calls a read would execute; ADR #93's second barrier (the read-only transaction) only exists on the `RunStatement` read path. Reading after the commit also answers the question the agent actually has: what the database holds now.
- Allowing DDL in the batch — rejected because MySQL commits implicitly around every DDL statement, so a list carrying one cannot be atomic there; the tool would make a promise one of its engines breaks silently. Schema changes stay one at a time on `run_write`.
- Reporting a rolled-back batch as a successful reply with `committed: false` — rejected because the bridged path writes `mcp-audit.log` from whether the call failed, and a rolled-back batch recorded as `ok` would be false in the one file whose job is to be true about writes.
- An `atomic: bool` argument letting the model choose sequential execution — rejected as one more decision for the model to get wrong, with no use case the transaction does not cover.
- A MongoDB multi-document transaction — rejected for now because it needs a replica set and the shell grammar (`db::mongo::query::execute`) runs each statement on its own; the fallback is sequential, stops at the first failure, and the error names which writes were already applied.

## Context

An agent driving UI tests through the connector read a configuration row, wrote it, re-read it to confirm, and repeated that for every setting. Each step was one tool call, and each call is a model turn that re-sends the conversation so far, so the cost of the session grew with the number of statements rather than with what they returned. The same review found that every reply was pretty-printed JSON (made compact separately, PR #251) and that `--max-rows` truncation never set `truncated`, so a model could not tell a cut page from a whole table.

## Consequences

- `BridgeRequest` has a new variant, so `PROTOCOL_VERSION` is 4 (a new request method is not additive for an old app — see the constant's docs). Every exhaustive match learnt it: `is_mutating` (true), `label` (`run_writes`), `bridge::server::connection_id_of`, `policy::enforce::needs_of` (`FreeSql` over the union of its writes' verbs), and `ai::tools::exposure` (`Never` — the AI panel has no write tool, decision D4). The `_ => None` matches had to be extended by hand: `bridge::server::policy_id_of` / `verbs_of_request` and `mcp::bridged_connection_id`; `a_write_batch_is_policy_checked_as_its_strictest_write` pins the first two.
- `commands::write_batch::verbs_of_writes` is the one place a batch's verbs are computed (policy, server re-check, sidecar check); an empty list answers `Verbs::WRITES`, never the permissive empty set.
- `db::sql::is_session_statement` moved out of `ai::exec` so both surfaces refuse the same list; it now also knows `RELEASE`, `SAVE TRAN`, `XA`, and PostgreSQL's bare `END`/`ABORT`.
- `mcp::truncate_rows` sets `truncated` and trims MongoDB's row-aligned `row_types` with the rows. `run_queries` and `verify` share one `--max-rows` budget across the list.
- Reads in a list run one after another, not concurrently — concurrent reads would each take a connection, the burst ADRs #104 and #105 exist to avoid.
- The sink sees one entry per write and then a closing `COMMIT` or `ROLLBACK` entry, so the audit log never shows a row count without whether it stayed.
- Raising `commands::write_batch::MAX_WRITES` (50) lengthens how long a model-written transaction can hold locks on the user's server; it bounds that, not the request size.
