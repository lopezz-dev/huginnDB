# Privacy policy

*Last updated: 2026-09-10. Applies to HuginnDB and to the `huginndb-mcp`
connector distributed with it, including the MCP Bundle (`.mcpb`) build.*

HuginnDB is a desktop database client. It runs entirely on your computer,
connects directly to the database servers you configure, and has **no backend
service of its own**. There is no HuginnDB account, no sign-in, and no server
we operate that your data passes through.

## What we collect

**Nothing.** HuginnDB sends no usage data, no analytics, no crash reports and
no telemetry of any kind. There is no opt-out because there is nothing to opt
out of.

## What stays on your machine

Everything. Specifically:

| Data | Where it lives | Notes |
| --- | --- | --- |
| Connection metadata (host, port, database, username, driver, TLS/SSH settings) | `profiles.json` in your platform's configuration directory | Never leaves the machine. |
| Passwords and SSH secrets | Your operating system's keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux) | Never written to disk in plaintext by HuginnDB, never logged, never transmitted anywhere except to the database server you are connecting to. |
| Preferences, tab and window state, saved queries, JSON Schemas | JSON files in the same configuration directory | Local only. |
| Pulse history (server metrics you opted into sampling) | `pulse.db`, a local SQLite file | Local only, pruned on a retention schedule you control. |
| MCP write audit log | `mcp-audit.log`, in the same configuration directory | Records write statements issued through the connector and the rows affected. Never credentials. Kept until you delete it. |
| AI panel conversations | Nowhere — memory only | **Deliberately never written to disk.** A transcript holds schema names, proposed SQL and row snippets; closing the app forgets it. The only thing persisted is whether tool cards start expanded. |
| AI provider API key | Your operating system's keychain, keyed to that endpoint's host | Only if you use a cloud provider. Never in `prefs.json`, never returned to the app's own interface, never logged. |

## Network connections HuginnDB makes

1. **To your database servers**, directly, using the credentials you supplied —
   the point of the product.
2. **To GitHub**, to check for application updates and download them. This is a
   request for a release file; it carries no identifying information beyond
   what any HTTPS request necessarily reveals (your IP address, to GitHub).
   Automatic checking can be turned off in Settings.
3. **To a shared-origin file location you configure**, if you use shared
   origins — a path you chose, typically on your own network share.
4. **To the inference endpoint you configure**, if you switch on the AI panel —
   and to no other. See the section below.

That is the complete list. HuginnDB contacts no other host.

## The MCP connector specifically

`huginndb-mcp` is a local process that an AI client (Claude Desktop, Claude
Code, Cursor, and others) starts on your machine over stdio. It is **not** a
remote service and does not authenticate against one.

- It reads the connection profiles above and their keychain passwords in order
  to open database connections from your computer.
- It can reach **only** the connections you explicitly expose in
  **Settings → MCP**. Nothing is exposed by default, and un-exposing one takes
  effect immediately.
- Writes are refused unless that connection's write policy permits them, and
  every write is recorded in the local audit log.
- Query results are returned to the AI client that requested them. **What that
  application does with them — including sending them to a model provider — is
  governed by that application's own privacy policy, not this one.** If your
  database holds data you are not willing to send to your AI provider, do not
  expose that connection.

## The AI panel specifically

The AI panel is **off** until you switch it on, and while it is off HuginnDB
makes no request to any inference endpoint. Once on, every connection is
unreachable by it until you tick that connection in **Settings → AI**.

**There is no HuginnDB service in the middle.** The panel talks to exactly one
endpoint: the base URL you configured. Nothing is proxied through us, and there
is no configuration in which your data passes through infrastructure we operate.
Requests go to that host and to no other — redirects are refused rather than
followed, and every scheme except `http` and `https` is rejected.

**Where that endpoint runs is your choice, and it is the whole decision.** A
model on your own machine (`http://localhost:11434/v1`) or on your own network
means nothing leaves your infrastructure. A cloud provider with your own API key
means your prompts — and whatever they contain — reach that provider, under
*their* privacy policy and not this one. HuginnDB does not decide this for you
and does not guess: you declare the endpoint's trust level yourself, because a
hostname resolves wherever DNS says it does.

**What reaches the model is bounded by two switches**, described in full in
[AI.md](AI.md):

- An endpoint you have **not** declared as your own infrastructure receives
  metadata only — table and column names, types, indexes, view definitions,
  `EXPLAIN` output — unless you additionally allow rows for a specific
  connection. Under metadata-only the row-reading tools are not offered to the
  model at all.
- An endpoint you **have** declared as your own receives rows from any
  connection you have made reachable.

Two things are worth stating plainly. **Anything you type or paste into the chat
is sent**, whatever the switches say — they govern what the assistant reads on
its own initiative, not what you hand it. And **the assistant's every read is
recorded in the app's Console**, under its own filter, with each result's row
count and size but never its content: that is there so the guarantee above is
something you can check rather than something you have to take on trust.

The assistant cannot write. No write operation is available to it, and a
statement it proposes is one you run yourself.

## Data sharing and retention

We share nothing, because we receive nothing. Data written by HuginnDB is
retained on your disk until you delete it, either through the app or by
removing the files in the configuration directory.

## Children

HuginnDB is a developer tool and is not directed at children.

## Changes

Material changes to this policy will be noted in `CHANGELOG.md` and this file's
"last updated" date.

## Contact

Security and privacy: <contact@shion.es>. Anything else:
[open an issue](https://github.com/lopezz-dev/huginnDB/issues).
