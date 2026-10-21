<div align="center">
  <img src="public/image/huginn-lockup-512.png" alt="HuginnDB" width="380">

  <p><strong>A fast, keyboard-first desktop database manager.</strong><br>
  PostgreSQL · MySQL · SQLite · MongoDB · SQL Server</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Status: Stable](https://img.shields.io/badge/status-stable-brightgreen.svg)](#status)
  [![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://v2.tauri.app)
  [![Made with Rust](https://img.shields.io/badge/Rust-stable-orange?logo=rust)](https://www.rust-lang.org)
  [![Frontend: React + TS](https://img.shields.io/badge/React-TypeScript-3178c6?logo=typescript)](https://www.typescriptlang.org)
</div>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="HuginnDB main window: schema explorer, data grid and SQL editor" width="820">
</p>

HuginnDB gives every cell a full Monaco editor, a real schema-aware SQL/aggregation workspace, and a free built-in [MCP connector](docs/MCP.md) so AI coding assistants can query your actual schema instead of guessing. Minimal UI, keyboard-first, dark by default. Named after [Huginn](https://en.wikipedia.org/wiki/Huginn_and_Muninn), one of Odin's ravens — the one who fetches information.

## Features

- **5 drivers, 1 app** — PostgreSQL, MySQL, SQLite, MongoDB, SQL Server — plus SSH tunnelling for remote hosts.
- **HuginnDB Pulse** — live server health (MySQL/MongoDB): vital signs, slowest statements with `EXPLAIN`, storage, sessions, index usage, and an opt-in history sampler so you can ask "was this slow yesterday too?"
- **Full Monaco editor on every cell** — JSON/XML/SQL auto-detected, live validation, `F11` fullscreen.
- **Real SQL/aggregation workspace** — schema-aware autocomplete, `Ctrl+Enter` to run, per-statement CodeLens, history that survives restarts.
- **Visual structure editor** — add/rename/drop columns, indexes, FKs — previewed as the exact DDL that will run.
- **Free MCP connector** — expose your schema to Claude Code, Claude Desktop, Cursor & co., read-only by default.
- **[Local-first AI panel](docs/AI.md)** — chat about your database against a model *you* point it at: a process on your machine, a GPU box on your LAN, or a cloud provider with your own key. No HuginnDB service in the middle. Off by default, per-connection opt-in, and an untrusted endpoint sees metadata only — never rows — unless you say otherwise.
- **Credentials in the OS keychain**, always — never on disk in plaintext.

```bash
claude mcp add huginndb -s user -- /absolute/path/to/huginndb-mcp --connections <profile-id>
```

<details>
<summary><strong>More screenshots, full feature list, architecture, and how it compares to DBeaver / TablePlus / HeidiSQL / DataGrip</strong></summary>

### More screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/cell-editor.png" alt="A cell expanded into a fullscreen Monaco editor" width="100%"><br>
      <sub>Full Monaco editor for any cell — JSON / XML / SQL auto-detected, live validation, <code>F11</code> fullscreen.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/sql-workspace.png" alt="SQL workspace with schema-aware autocomplete" width="100%"><br>
      <sub>Schema-aware SQL editor — <code>Ctrl+Enter</code> to run, per-statement CodeLens, history that survives restarts.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mcp-settings.png" alt="Settings → MCP panel generating a ready-to-paste client config" width="820"><br>
  <sub>Settings → MCP — point Claude Code, Claude Desktop, Cursor, or any MCP client at your real schema.</sub>
</p>

### Full feature list

- **Multi-driver connection manager**, each with a per-driver dialog and the right defaults.
- **Schema explorer** — tree of databases → tables/views/collections → columns (type badges, PK indicators) and indexes.
- **Data browser** — paginated, sortable, filterable grid ([TanStack Table](https://tanstack.com/table)); inline edits routed through the backend with PK-based safety.
- **View editor** — create, edit, rename, drop, with a live preview grid and read-only DDL pane.
- **Server-side security panel** — read users/roles and privileges straight from the server, for every driver.
- **[HuginnDB Pulse](docs/PULSE.md)** — dockable panel or its own window, six views (Status, Time spent, Storage, Sessions, Indexes, History), all seven metrics also reachable read-only over MCP.
- **[AI panel](docs/AI.md)** — assisted mode assembles a task's context in Rust for one model call (explain a statement, diagnose a slow one, write SQL against the real schema, document a table), so it works on a 4B; agent mode runs a read-only tool loop, gated on a capability probe rather than a preference. Every read it makes is in the Console, and it never writes — a statement it proposes opens in your editor for you to run.
- **Saved queries** — a local library with name, description, tags.
- **Multi-window** — pop a connection's workspace, or a single tab, into its own OS window.
- **Ten themes** with a light/dark pair each, plus a visual colour editor grouped by surfaces/actions/status/borders.
- **Resizable layout** — horizontal and vertical splits, restored across restarts.

### How it compares

No two of these tools are chasing the same thing, and all four below are genuinely good at what they do (DBeaver and HeidiSQL are two of the reasons HuginnDB looks the way it does — see [Acknowledgements](#acknowledgements)). Checked against each project's own docs/pricing pages as of writing (August 2026) — double-check the vendor's site for anything that's moved since.

|                          | **HuginnDB**                                                   | DBeaver (CE)                                              | TablePlus                                                       | HeidiSQL                                          | DataGrip                                                        |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ |
| **License / price**      | MIT, free                                                         | Apache-2.0 (CE) free; paid tiers from ~$110/yr for more drivers/SSO | Proprietary; free tier capped (2 tabs/windows/filters), ~$99 perpetual license | GPL-2.0, free                                       | Paid (~$99/yr); free for non-commercial use since Oct 2025           |
| **Platforms**            | Windows, Linux (macOS unverified)                                 | Windows, macOS, Linux                                        | Windows, macOS, Linux                                               | Windows-native (Linux via Wine; no native macOS)     | Windows, macOS, Linux                                                |
| **MongoDB**              | ✅ native                                                          | ❌ in Community — only paid Lite/Enterprise/Ultimate         | ✅ (Beta)                                                            | ❌                                                     | ✅                                                                    |
| **SQL Server**           | ✅                                                                  | ✅ (JDBC)                                                     | ✅                                                                    | ✅                                                     | ✅                                                                    |
| **Per-cell editor**      | Full Monaco pane — JSON/XML/SQL highlighting, live validation, `F11` fullscreen | Inline / basic value viewer                                  | Inline / basic value viewer                                          | Inline / basic value viewer                          | Inline / basic value viewer                                          |
| **Credential storage**   | OS keychain, always                                               | Local encrypted file + optional master password (not an OS keychain by default) | Keychain confirmed on macOS; Windows mechanism undocumented          | Windows Registry, obfuscated (not strong encryption) | OS-native (Keychain / Secret Service / Credential-Store-backed)      |
| **AI / MCP connector**   | Built-in, free — any MCP client (Claude Code, Claude Desktop, Cursor, …) | MCP server is a paid Team Edition feature                    | Built-in LLM chat with MCP support, not exposed to external AI clients | None                                                  | Built-in MCP server (2026.1+), consent-gated                          |
| **UI weight**            | Keyboard-first, minimal chrome                                    | Full IDE (Eclipse-based)                                     | Lightweight, native                                                  | Lightweight, native                                  | Full IDE (JetBrains)                                                  |

Sources: [DBeaver editions](https://dbeaver.com/edition/) · [DBeaver MongoDB support](https://dbeaver.com/docs/dbeaver/MongoDB/) · [DBeaver master password](https://github.com/dbeaver/dbeaver/wiki/Managing-Master-Password) · [DBeaver Team Edition MCP server](https://dbeaver.com/docs/team-edition/web/Model-Context-Protocol-Server/) · [TablePlus pricing](https://tableplus.com) · [TablePlus MongoDB](https://tableplus.com/blog/2019/08/tableplus-native-gui-client-mongodb.html) · [TablePlus MCP announcement](https://x.com/TablePlus/status/1935585135472287819) · [HeidiSQL](https://www.heidisql.com) · [HeidiSQL credential storage discussion](https://github.com/HeidiSQL/HeidiSQL/issues/1489) · [DataGrip free non-commercial tier](https://blog.jetbrains.com/datagrip/2025/10/01/datagrip-is-now-free-for-non-commercial-use/) · [DataGrip password storage](https://www.jetbrains.com/help/datagrip/reference-ide-settings-password-safe.html) · [DataGrip MCP server](https://www.jetbrains.com/help/datagrip/mcp-server.html)

### Architecture

HuginnDB is split into two cooperating processes: a Tauri webview (React + TypeScript + Zustand + TanStack Table + Monaco) that never opens a database connection itself, and a Rust backend that owns every `sqlx`/`mongodb`/`tiberius` pool and resolves passwords from the OS keychain at the moment of use. The frontend calls a thin typed wrapper around Tauri's `invoke` and renders whatever the backend returns — connection strings never reach the webview. Full map of the code layout in [CONTRIBUTING.md](CONTRIBUTING.md#project-layout).

**Tech stack**: [Tauri 2](https://v2.tauri.app), React 18 + TypeScript (strict) + Vite, Tailwind + [shadcn-style](https://ui.shadcn.com) Radix primitives, [Zustand](https://github.com/pmndrs/zustand), [TanStack Table v8](https://tanstack.com/table), self-hosted [Monaco](https://microsoft.github.io/monaco-editor/) (no CDN), Rust with [sqlx](https://github.com/launchbadge/sqlx) (Postgres/MySQL/SQLite), [`mongodb`](https://crates.io/crates/mongodb), [`tiberius`](https://crates.io/crates/tiberius) (SQL Server), [keyring](https://crates.io/crates/keyring), [tokio](https://tokio.rs).

**Security model** — single-user desktop tool; threat model is a curious local user or a hostile database operator, not a remote attacker. Full detail in [SECURITY.md](SECURITY.md).

</details>

## Status

**Stable**, SemVer since `1.0`, currently `1.16.x`. Read/write workflows are feature-complete for every supported driver. Known gaps: no automated frontend tests yet, macOS builds unverified, Windows binaries not code-signed yet. Windows and Linux (`x86_64`: `.deb`, `.AppImage`, `.rpm`) artifacts are published per release; arm64 and Flatpak/Snap/AUR are not — see [ROADMAP.md](ROADMAP.md).

## Install

**Windows** — download the `-setup.exe` from [Releases](https://github.com/lopezz-dev/huginnDB/releases). First run triggers a SmartScreen warning (binaries aren't code-signed yet, not a malware flag) — click **More info → Run anyway**. You can verify the SHA-256 against the digest published on the release.

**Linux** (`x86_64`):

```bash
sudo apt install ./HuginnDB_<version>_amd64.deb        # Debian/Ubuntu/Mint/Pop!_OS
# or, no install step:
chmod +x HuginnDB_<version>_amd64.AppImage && ./HuginnDB_<version>_amd64.AppImage
```

<details>
<summary>Building from source</summary>

### Prerequisites

| Tool                        | Why                                          | Install                                                                    |
| --------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| **Node.js ≥ 20**             | Vite, TypeScript, frontend tooling.           | [nodejs.org](https://nodejs.org) or [`fnm`](https://github.com/Schniz/fnm) |
| **pnpm ≥ 10**                | The only supported package manager.           | `npm i -g pnpm`                                                            |
| **Rust (stable)**            | Compiles the Tauri backend.                   | [rustup.rs](https://rustup.rs)                                             |
| **Platform Tauri prereqs**   | Native build deps (compiler, webview, etc.).  | See below.                                                                  |

> **Always use pnpm.** Do not invoke `npm` or `yarn` — the lockfile is pnpm-only.

**Windows** — Visual Studio Build Tools 2022 (*Desktop development with C++*):

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait"
```

WebView2 is preinstalled on Windows 11; on Windows 10 install the [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/).

**Linux**:

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev libsecret-1-dev
```

Equivalent packages exist on Fedora, Arch, and Alpine — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

**macOS** — `xcode-select --install`. Not a primary target yet; build should work, please file an issue if not.

```bash
git clone https://github.com/lopezz-dev/huginnDB.git
cd huginnDB
pnpm install
pnpm tauri:dev          # dev mode with HMR — first run takes 5-10 min (Cargo compiles all drivers from scratch)
# or
pnpm tauri:build        # release bundle in src-tauri/target/release/bundle/
```

</details>

## Try it in 60 seconds

### Connecting to a sample database

```bash
mkdir -p sample-data
curl -L -o sample-data/chinook.db \
  https://github.com/lerocha/chinook-database/raw/master/ChinookDatabase/DataSources/Chinook_Sqlite.sqlite
```

Then in HuginnDB: **+** in the Connections panel → **SQLite** → paste the path to `chinook.db` → Test → Save → Connect. Tables like `Album`, `Artist`, `Invoice` appear in the schema explorer — try a query, double-click a cell, hit `Ctrl+Enter`.

| Shortcut                       | Action                     |
| ------------------------------- | -------------------------- |
| `Ctrl+Enter`                     | Run the current query      |
| Double-click a cell              | Expand the cell editor     |
| `F11`                            | Fullscreen the cell editor |

## MCP connector

`huginndb-mcp` is a headless [Model Context Protocol](https://modelcontextprotocol.io) server so an AI coding assistant works against your *actual* schema instead of guessing. Any MCP client (Claude Code, Claude Desktop, Cursor, Antigravity, Codex, …), read-only by default with a per-connection write policy, every write audited. Ships as a sidecar — nothing to build. Full reference in [docs/MCP.md](docs/MCP.md).

Which connections it can reach is picked in **Settings → MCP** and re-read on every call, so the client config carries no ids and never needs editing again. Claude Code is one button; Claude Desktop installs the `.mcpb` bundle attached to each release in one click.

## Privacy

HuginnDB collects nothing. No analytics, no telemetry, no crash reports, no
account — there is no service of ours for your data to pass through.
Credentials live in your OS keychain and everything else in local files. The
full statement, including what the MCP connector reads and what it never sends,
is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Docs

User guides live in [`docs/`](docs/README.md), and the same files are readable
inside the app under **Help → Documentation**. Each one has a Spanish twin.

[Connections](docs/CONNECTIONS.md) · [Environments](docs/ENVIRONMENTS.md) · [MongoDB](docs/MONGODB.md) · [SQL Server](docs/SQL_SERVER.md) · [MCP connector](docs/MCP.md) · [AI panel](docs/AI.md) · [Pulse](docs/PULSE.md) · [Shortcuts](docs/SHORTCUTS.md)

[Roadmap](ROADMAP.md) · [Security](SECURITY.md) · [Privacy](docs/PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

PRs welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first. Newcomer-friendly issues are labelled `good first issue`.

## License

[MIT](LICENSE) — use it, fork it, ship products with it.

## Acknowledgements

[Tauri](https://v2.tauri.app) · [sqlx](https://github.com/launchbadge/sqlx) · [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [TanStack Table](https://tanstack.com/table) · [shadcn/ui](https://ui.shadcn.com) · [HeidiSQL](https://www.heidisql.com) and [DBeaver](https://dbeaver.io) for showing what a great database client can look like · the [Chinook](https://github.com/lerocha/chinook-database) sample database for making "try HuginnDB in 60 seconds" possible.
