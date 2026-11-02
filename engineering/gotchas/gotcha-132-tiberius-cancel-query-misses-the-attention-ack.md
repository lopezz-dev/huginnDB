---
id: 132
type: gotcha
status: active
date: 2026-11-02
tags: [tiberius, mssql, mcp]
related: [128, 130]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #132: tiberius 0.13's `cancel_query` gives up before SQL Server acknowledges, and leaves the acknowledgement on the wire

`Client::cancel_query` sends the TDS Attention correctly, and SQL Server does stop the batch. But tiberius only reads the first response message that comes back. SQL Server sends its `DONE_ATTN` acknowledgement in a later message. So the call fails with "Never got a DONE token acknowledging the Attention signal", and the acknowledgement is still waiting to be read. If the session is used again, the next query reads that acknowledgement as its own (empty) result, and every reply after it arrives one query late.

**Trap:** cancelling a running batch with tiberius 0.13 against a real SQL Server returns `Error::Protocol` and leaves the session's replies out of step with its queries.

## Detail

- **Symptom:** `cancel_query()` returns `Protocol("Never got a DONE token acknowledging the Attention signal.")` immediately after an Attention sent during a `WAITFOR DELAY`. On the same session, `SELECT 42` then returns no rows, and the next `SELECT @@TRANCOUNT` returns `42`. This was observed against SQL Server 2016 (NAVDEMO) on 2026-11-02 by the `mssql_live_*` test that is now in `commands::mssql_live_tests`.
- **Cause:** `TokenStream::flush_done_attention` reads tokens through `try_unfold`. That stream ends at the end of the current message (`Connection::is_eof`), and nothing reads on into the next one. MS-TDS allows the server to finish the cancelled request's response before it sends the acknowledgement. tiberius's unit test builds the acknowledgement into a single message, so it passes.
- **What to do:** never reuse a session after `cancel_query` fails. `PooledClient::cancel` drops the client, which closes the socket. SQL Server then kills the request of the client that disconnected: it undoes the statement that was running and rolls back any open transaction. The same live test confirmed this with a ten-million-row `INSERT … SELECT` that was cut off with no transaction around it: none of its rows survived. `Cancelled::Disconnected` is the verdict this path reports (ADR #130).
- **Retire when:** tiberius reads past message boundaries in `flush_done_attention`. That change can be made upstream, or here through the `[patch.crates-io]` fork that `Cargo.toml` already names as the escape hatch. Once it lands, `cancel` gets its acknowledgement, the session survives, and the rollback is confirmed with `@@TRANCOUNT = 0` instead of being left to the server.
