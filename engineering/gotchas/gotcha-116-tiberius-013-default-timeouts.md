---
id: 116
type: gotcha
status: active
date: 2026-10-26
tags: [tiberius, mssql, async]
related: [31, 62]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #116: tiberius 0.13 bounds every query at 30 s and the handshake at 15 s by default, and its connect future is three times larger

tiberius 0.13 (September 2026) introduced ADO.NET-style timeouts that are **on by default**: `Config::command_timeout` fails any server round-trip that takes longer than 30 s, and `Config::handshake_timeout` fails a login that takes longer than 15 s. Upgrading from 0.12, where both were unbounded, compiles without a single change and silently breaks every user query that runs longer than half a minute — and leaves the connection out of sync, so it has to be dropped. The same release made `Client::connect`'s future roughly three times larger, and since a session can be opened on any query path, that size folds into every enclosing future.

**Trap:** tiberius 0.13 compiles unchanged over 0.12 but cuts any query whose server round-trip passes 30 s (TimedOut, connection desynced) unless `command_timeout(None)` is set, and its larger connect future, left inline, overflowed a 2 MiB thread stack in a debug build.

## Detail

- **Symptom:** a SQL Server query that the server takes more than 30 s to answer fails with `the server did not send the next part of the command result within 30s ... the connection is now out of sync and must be dropped`. Separately, after the upgrade `mcp::tests::a_list_of_reads_answers_each_in_its_slot_under_one_row_budget` aborted with `has overflowed its stack`.
- **Cause:** both defaults are documented in tiberius 0.13's CHANGELOG ("BREAKING: both knobs now default to a bounded value"). Measured with `RUSTC_BOOTSTRAP=1 cargo rustc --lib --features mcp -- -Zprint-type-sizes`: the connect future (`bound_by_acquire_timeout` over `connect_uncapped`) went from ~11 KB to ~37 KB, and `mcp::Huginn::read_many`'s from ~44 KB to ~127 KB, because `MsSqlPool::acquire` can open a session on any query path. A `#[tokio::test]` runs its future through `block_on`, which pins it on the test thread's 2 MiB stack.
- **What to do:** `db::mssql::build_config` sets `command_timeout(None)` and `handshake_timeout(None)`, so a user's query stays unbounded as on every other driver and connecting stays bounded by our own `ACQUIRE_TIMEOUT` (`neither_a_query_nor_the_handshake_inherits_a_driver_timeout` pins this). `db::mssql::connect` boxes `connect_uncapped`, which brought `read_many` down to ~20 KB, smaller than before the upgrade. Boxing `mssql::open_pool` in `db::pool` does **not** help: that is not the only way in.
- **Retire when:** never for the timeouts while tiberius keeps these defaults; re-measure the future sizes on any tiberius upgrade.

Verified against a real SQL Server 2022 container: with `command_timeout(None)` a long `WAITFOR` completes; with tiberius's 30 s default it is cut at exactly 30.0 s.
