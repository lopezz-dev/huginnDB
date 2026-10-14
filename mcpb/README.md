# HuginnDB MCP connector

Lets an AI client inspect and query the databases you have saved in the
[HuginnDB](https://github.com/lopezz-dev/huginnDB) desktop app — PostgreSQL,
MySQL, SQLite, MongoDB and Microsoft SQL Server — with a per-connection write
policy that is read-only by default.

## Requirements

The HuginnDB desktop app must be installed on the same machine. This extension
reads its saved connection profiles and the matching passwords from the OS
keychain; it has no connection settings of its own.

You install this extension once. On Windows it hands every session to the
connector installed with the app, so updating HuginnDB is what updates the
connector — there is no newer extension to download.

## Setup

1. Install this extension.
2. In HuginnDB, open **Settings → MCP** and tick the connections you want the
   assistant to reach. Nothing is reachable until you do.
3. Give each of them a write level if you want more than reads: `read-only`
   (default), `data` (INSERT/UPDATE/DELETE) or `full` (also schema changes).

Both are re-read on every call, so ticking a connection or raising its level
takes effect without restarting the AI client.

## What it can do

Read schema, browse rows, run read-only statements, and read server health
(queries/s, slowest statements, index usage, open sessions). Writing is a
separate set of tools, each refused unless the connection's policy allows it,
and every write is recorded in `mcp-audit.log` next to your profiles.

Full documentation: [docs/MCP.md](https://github.com/lopezz-dev/huginnDB/blob/main/docs/MCP.md).

## Privacy Policy

**Everything stays on your machine.** This extension has no server, no account
and no telemetry.

- **What it collects:** nothing. No usage data, no analytics, no crash reports
  are sent anywhere.
- **What it reads:** the connection profiles saved by the HuginnDB desktop app
  (host, port, database, username) and the matching passwords from your
  operating system's keychain, at the moment it opens a connection. It reads
  only the connections you have exposed in Settings → MCP.
- **What it stores:** a local audit log of write operations (`mcp-audit.log`,
  in HuginnDB's own configuration directory), holding the statement and the
  number of rows affected. Never credentials.
- **Who it shares with:** nobody. Database results are returned to the MCP
  client that asked for them — the AI application running on your machine —
  and to nothing else. What that application then does with them is governed
  by *its* privacy policy.
- **Retention:** the audit log stays on your disk until you delete it. Nothing
  else is retained.
- **Contact:** <contact@shion.es>, or
  [open an issue](https://github.com/lopezz-dev/huginnDB/issues).

The canonical version of this policy lives at
[docs/PRIVACY.md](https://github.com/lopezz-dev/huginnDB/blob/main/docs/PRIVACY.md).
