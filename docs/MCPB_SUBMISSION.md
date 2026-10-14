# MCP Bundle submission dossier

Everything Anthropic's connector-directory review asks for about
`huginndb-mcp`, kept in the repo so it stays in step with the code instead of
living in a form somebody filled in once. The bundle itself is built by
[`scripts/build-mcpb.sh`](../scripts/build-mcpb.sh) from
[`mcpb/manifest.json`](../mcpb/manifest.json).

**Check the current form before submitting.** The requirements below were
gathered in September 2026 from
<https://claude.com/docs/connectors/building/submission>; local MCPB
submissions go through their own form rather than the remote portal, and the
detail moves.

## Server basics

| Field | Value |
| --- | --- |
| Name | HuginnDB |
| Connector type | Desktop extension (MCP Bundle, `.mcpb`) — local stdio, not a remote server |
| Tagline | Let Claude read and query the databases you already have saved. |
| Homepage | <https://github.com/lopezz-dev/huginnDB> |
| Documentation | <https://github.com/lopezz-dev/huginnDB/blob/main/docs/MCP.md> |
| Support | <https://github.com/lopezz-dev/huginnDB/issues> |
| Privacy policy | <https://github.com/lopezz-dev/huginnDB/blob/main/docs/PRIVACY.md> |
| License | MIT |
| Platforms | `win32`, `linux` (one bundle each; no macOS build — see *Limitations*) |

**Primary use cases (2–3 sentences).** HuginnDB's connector exposes the
database connections already saved in the HuginnDB desktop app — PostgreSQL,
MySQL, SQLite, MongoDB and SQL Server — so an assistant works against real
schema and real rows instead of guessing at them. It answers questions about
structure, data and server health, and can write only where the user has
explicitly raised that connection's policy above read-only. Everything runs on
the user's machine: there is no service, no account and no telemetry.

## Setting up a review environment

No account to hand over — the extension has no service behind it. A reviewer
needs the desktop app and any database. The quickest reproducible one, which
the repo already documents:

1. Install HuginnDB from the
   [latest release](https://github.com/lopezz-dev/huginnDB/releases).
2. Download the Chinook sample database (~1 MB):
   ```bash
   curl -L -o chinook.db \
     https://github.com/lerocha/chinook-database/raw/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite
   ```
3. In HuginnDB: **+ connection → SQLite →** point it at `chinook.db`, name it
   `Chinook`, save.
4. **Settings → MCP →** tick `Chinook`. That is what makes it reachable; the
   extension has no settings of its own.
5. Install the `.mcpb` from the release in **Claude Desktop → Settings →
   Extensions**.

To review the write tools, raise `Chinook` to **data** in the same panel
(step 4). Leave it at `read-only` to see the refusals instead. Both take
effect without restarting Claude Desktop.

## Example prompts

Verified against a Chinook-schema SQLite database through a real MCP
handshake. The first three are the read path; the rest demonstrate the gates.

1. **"With huginndb, list the tables in Chinook and describe the Album table."**
   → `list_tables` returns Album, Artist, Customer, Invoice, Track;
   `describe_table` returns Album's columns, its primary key and its foreign
   key to Artist.

2. **"Which three artists have the most tracks in Chinook?"**
   → one `run_query` call joining Artist → Album → Track with a `GROUP BY`, and
   three rows back. This is the case no structured tool can express, and why a
   statement runner exists at all.

3. **"Show me 5 rows of Customer in Chinook."**
   → `browse_table` with a limit, no SQL written by the model.

4. **"Update track 1's price to 1.29 in Chinook."** — with the connection left
   at `read-only`
   → refused: *"connection … has MCP write policy 'read-only', which does not
   permit this operation (needs at least 'data'). Raise the connection's level
   in HuginnDB → Settings → MCP."* Raise it to `data` and the same prompt
   succeeds, and the write is appended to `mcp-audit.log`.

5. **"Delete every track in Chinook."**
   → refused even at `data`: a whole-relation `DELETE` with no predicate is
   rejected before it reaches the database, and the message says how to opt in
   deliberately (`WHERE 1=1`).

Note that the connection is addressed by **name** throughout. Every tool
accepts the name shown in the app or the profile id; `list_connections`
reports both.

## How the stated requirements are met

| Requirement | Where |
| --- | --- |
| Every tool has a title | All 25; asserted by `every_tool_declares_a_title_and_a_read_only_hint` in `src-tauri/src/mcp/mod.rs`. |
| `readOnlyHint` / `destructiveHint` as applicable | 17 reads carry `readOnlyHint`; 8 writes carry `destructiveHint`/`idempotentHint`, with `insert_row` and `create_index` explicitly additive. Asserted by `the_write_tools_are_annotated_as_writes`. |
| Tool names ≤ 64 characters | Longest is `pulse_index_usage` (17). |
| Descriptions state what the tool does and when to call it | `mcpb/manifest.json` mirrors the router's own descriptions; `the_mcpb_manifest_lists_exactly_the_tools_we_serve` keeps the two from drifting. |
| Privacy policy, HTTPS, covering collection/use/storage/sharing/retention/contact | [`docs/PRIVACY.md`](PRIVACY.md), linked from `privacy_policies` in the manifest and repeated as a *Privacy Policy* section in the bundle's own README. |
| Manifest version ≥ 0.2 | `0.3`. |
| Setup and usage documentation | [`docs/MCP.md`](MCP.md) (English) and [`docs/MCP.es.md`](MCP.es.md). |
| Ownership of the resources it touches | The connector touches only the reviewer's own machine: local config files, the OS keychain, and database servers the reviewer configured. It reaches no service the publisher operates, because there isn't one. |
| No OAuth | Not applicable to a local stdio server: there is no remote service to authenticate against. Access is bounded by the OS user's own session, the keychain, and the per-connection write policy. |

## Limitations worth declaring

- **Not standalone.** The extension requires the HuginnDB desktop app on the
  same machine — that is where connection profiles and keychain entries live.
  Stated in the manifest's `long_description` and in the bundle README, so a
  user cannot install it expecting a self-contained tool.
- **Windows and Linux only.** macOS is not a build target for the project
  (documented in `CLAUDE.md`), so no `darwin` bundle is produced and
  `compatibility.platforms` says so rather than claiming support that has
  never been tested.
- **Results leave for the AI client.** Rows the assistant asks for are returned
  to the client application, and what it does with them is governed by *its*
  policy. `docs/PRIVACY.md` says this outright rather than burying it.
